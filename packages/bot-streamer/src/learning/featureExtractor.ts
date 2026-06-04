/**
 * Feature extractor — turns a (mode, product, optional reference) into a
 * 124-d Float32Array consumed by the trunk.
 *
 * Engineered features (50):
 *   1   log(heuristic_cents+1) / 12         (centered into ~[0, 2])
 *   2   log(title_length+1) / 6
 *   3   digit_count / 10
 *   4   log(description_length+1) / 8
 *   5   has_image       (0/1)
 *   6   has_description (0/1)
 *   7   has_reference_price (0/1)
 *   8   log(reference_price+1) / 12
 *   9   uppercase_ratio
 *   10  punctuation_count / max(1, title_length)
 *   11..37   27 token multiplier presence flags
 *   38..49   12-mode one-hot
 *   50  has_pair_role (0/1)
 *
 * Hashed bigrams (64): signed Weinberger hash of consecutive char
 * bigrams of the lowercased title. Each bigram contributes either +1 or
 * −1 to the bucket determined by `hash(bigram) % 64`. Sign comes from
 * `hash2(bigram) & 1`. The vector is L2-normalised at the end so its
 * magnitude is independent of title length.
 *
 * The output is **deterministic** — same input → same vector — so it
 * can be used both at predict time and at update time without drift.
 */

import type { GameMode, Product } from "@price-game/shared";
import { estimatePriceCents } from "../heuristics/priceEstimator";
import { buildDefaultCatalog, type PriceCatalog } from "./priceCatalog";
import {
  BRAND_TIER_BUCKETS,
  ENGINEERED_FEATURE_DIM,
  FEATURE_DIM,
  GAME_MODE_ORDER,
  HASHED_BIGRAM_DIM,
  type BrandTier,
  type ProductLite,
} from "./types";

/**
 * Catalog used by the catalog-snap features. Built once at module load —
 * the catalog itself is a static constant from `priceCatalog.ts`, so
 * sharing one instance across all `extractFeatures` calls is safe.
 */
const FEATURE_CATALOG: PriceCatalog = buildDefaultCatalog();

/** Token patterns in the same order as priceEstimator.ts, with one extra for "luxury". */
const TOKEN_PATTERNS: Array<readonly [RegExp, string]> = [
  [/\bpro\b/i, "pro"],
  [/\bpremium\b/i, "premium"],
  [/\bdeluxe\b/i, "deluxe"],
  [/\bprofessional\b/i, "professional"],
  [/\bcommercial\b/i, "commercial"],
  [/\bheavy[\s-]?duty\b/i, "heavy-duty"],
  [/\bsmart\b/i, "smart"],
  [/\bwireless\b/i, "wireless"],
  [/\b4k\b/i, "4k"],
  [/\b8k\b/i, "8k"],
  [/\bgaming\b/i, "gaming"],
  [/\borganic\b/i, "organic"],
  [/\bstainless steel\b/i, "stainless-steel"],
  [/\bleather\b/i, "leather"],
  [/\bmini\b/i, "mini"],
  [/\bbasic\b/i, "basic"],
  [/\brefurbished\b/i, "refurbished"],
  [/\brenewed\b/i, "renewed"],
  [/\bgeneric\b/i, "generic"],
  [/\bsingle\b/i, "single"],
  [/\btravel size\b/i, "travel-size"],
  [/\bsample\b/i, "sample"],
  [/\bbundle\b/i, "bundle"],
  [/\bset of \d+\b/i, "set-of-N"],
  [/\bpack of \d+\b/i, "pack-of-N"],
  [/\b\d+[\s-]?pack\b/i, "N-pack"],
  [/\bluxury\b/i, "luxury"],
];

if (TOKEN_PATTERNS.length !== 27) {
  throw new Error(`featureExtractor: expected 27 token patterns, got ${TOKEN_PATTERNS.length}`);
}

/**
 * Round-context feature names (10 dims). These are the per-round
 * statistics threaded in via `ExtractInput.roundContext` — budget
 * value, target-price stats, multi-product round shape — so the
 * trunk has more than just the single product to look at when scoring.
 * Without these the model knows the *mode* (one-hot) but not the
 * *parameters* of the current round (e.g. "what's the budget?").
 */
const ROUND_CONTEXT_NAMES: string[] = [
  "round_product_count",   // count of products in the round, /10
  "round_has_budget",      // 0/1
  "round_log_budget",      // log(budgetCents+1)/12 when set, else 0
  "round_has_pair_other",  // 0/1: another product paired with this one
  "round_log_pair_other",  // log(other heuristic+1)/12 when set, else 0
  "round_has_targets",     // 0/1: round provides target prices (price-match)
  "round_log_target_mean", // log(meanTarget+1)/12, else 0
  "round_log_target_min",  // log(minTarget+1)/12, else 0
  "round_log_target_max",  // log(maxTarget+1)/12, else 0
  "round_log_target_span", // log((max-min)+1)/8, else 0
];

/**
 * Phase 3a feature names (11 dims, appended after ROUND_CONTEXT). All
 * named so the BeliefCard / topFeatures display can show them by their
 * intent rather than `feat_60` etc.
 */
const PHASE3A_FEATURE_NAMES: string[] = [
  "catalog_snap_idx",        // catalog-snapped class index normalised to [0, 1]
  "catalog_log_distance",    // log(|heuristic - nearest catalog price| + 1) / 8
  "brand_tier_budget",       // 1 iff lookup returned 0 (BUDGET)
  "brand_tier_mid",          // 1 iff lookup returned 1 (MID)
  "brand_tier_premium",      // 1 iff lookup returned 2 (PREMIUM)
  "bound_has_product_range", // 0/1: per-product slider range present
  "bound_log_min",           // log(min+1)/12 when range present, else 0
  "bound_log_max",           // log(max+1)/12 when range present, else 0
  "bound_log_width",         // log((max-min)+1)/8 when range present, else 0
  "bound_has_cap",           // 0/1: round-level upper cap (riser) present
  "bound_log_cap",           // log(cap+1)/12 when cap present, else 0
];

/**
 * Phase 3d.2 bidding-context feature names (5 dims). Active only on
 * bidding rounds — the runner stamps `biddingTurn` into ExtractInput
 * via the predict path, and the train-time path persists the same
 * snapshot on the Sample so forward symmetry holds. Zeroed on every
 * non-bidding round.
 *
 * Tighter than the original draft (which had 9 dims):
 *   - dropped `prev_bid_min` and `num_prev_bids` — collinear with
 *     `prev_bid_median` and `turn_idx_norm`
 *   - dropped `is_first` — derivable from turn_idx==0 ∧ !has_prev_bids
 *   - replaced raw `log(prev_bid_max)` with the residual vs heuristic
 *     so we don't fight ~0.95 collinearity with `log_heuristic`
 */
const BIDDING_FEATURE_NAMES: string[] = [
  "bid_residual_max",   // log(prevBidMax+1)/12 - log_heuristic, 0 when no prev bids
  "bid_log_median",     // log(prevBidMedian+1)/12, 0 when no prev bids
  "bid_turn_idx_norm",  // turnIdx / 4
  "bid_is_last",        // 0/1: turnIdx === totalPlayers - 1
  "bid_has_prev_bids",  // 0/1
];

/** Public list of feature names (length === FEATURE_DIM) — used for visualisation. */
export const FEATURE_NAMES: string[] = (() => {
  const out: string[] = [
    "log_heuristic",
    "log_title_len",
    "digit_count",
    "log_desc_len",
    "has_image",
    "has_description",
    "has_reference_price",
    "log_reference_price",
    "uppercase_ratio",
    "punctuation_density",
  ];
  for (const [, name] of TOKEN_PATTERNS) out.push(`tok_${name}`);
  for (const m of GAME_MODE_ORDER) out.push(`mode_${m}`);
  out.push("has_pair_role");
  for (const n of ROUND_CONTEXT_NAMES) out.push(n);
  for (const n of PHASE3A_FEATURE_NAMES) out.push(n);
  for (const n of BIDDING_FEATURE_NAMES) out.push(n);
  for (let i = 0; i < HASHED_BIGRAM_DIM; i++) out.push(`bg_${i}`);
  return out;
})();

if (FEATURE_NAMES.length !== FEATURE_DIM) {
  throw new Error(`featureExtractor: FEATURE_NAMES length ${FEATURE_NAMES.length} != FEATURE_DIM ${FEATURE_DIM}`);
}

/** FNV-1a 32-bit. Stable, fast, no deps. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Second hash for the sign — different prime + xor shift. */
function fnv1a2(s: string): number {
  let h = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h ^ (h >>> 13), 0x01000193);
  }
  return h >>> 0;
}

/**
 * Round-level context the trunk also sees. All fields optional —
 * supplied only when the calling mode actually has them (e.g. budget
 * is only set for budget-builder; targetPrices is only set for
 * price-match). When absent the corresponding "has" feature is 0
 * and the log feature is 0.
 */
export interface RoundContext {
  /** Count of products in the round (rankProducts.length when present, else 1). */
  productCount?: number;
  /** Budget cap in cents (budget-builder). */
  budgetCents?: number;
  /** Heuristic price of the OTHER product in a 2-product pair (comparison / higher-lower). */
  pairOtherCents?: number;
  /** Sorted-ascending list of target prices the round provides (price-match). */
  targetPricesCents?: ReadonlyArray<number>;
}

export interface ExtractInput {
  mode: GameMode;
  product: ProductLite | Pick<Product, "id" | "title" | "category" | "description" | "imageUrl">;
  referencePrice?: number;
  /** True when the product is part of a pairwise comparison this round. */
  hasPairRole?: boolean;
  /** Per-round statistics — see {@link RoundContext}. */
  roundContext?: RoundContext;
  /**
   * Phase 3a: brand-tier classification (0=budget, 1=mid, 2=premium)
   * from the BrandTierTable lookup. Encoded as a one-hot in the trunk
   * input. Absent → all three brand-tier dims are 0 (which is the
   * "unknown brand" condition the trunk should learn to handle).
   */
  brandTier?: BrandTier;
  /**
   * Phase 3a: per-product slider bounds the player saw at predict time
   * (cents). Encoded as has-flag + log(min)/log(max)/log(width). Absent
   * → all four dims are 0.
   */
  priceRangeCents?: { readonly min: number; readonly max: number };
  /**
   * Phase 3a: round-level one-sided upper cap (riser). Encoded as
   * has-flag + log(cap). Absent → both dims are 0.
   */
  maxPriceCapCents?: number;
  /**
   * Phase 3d.2: bidding-turn snapshot. Drives the 5 bidding-context
   * dims at the tail of the engineered block. Absent → all 5 dims
   * are zero (every non-bidding round, plus single-player bidding
   * which has no turn structure).
   */
  biddingTurn?: {
    readonly turnIdx: number;
    readonly totalPlayers: number;
    readonly previousBidsCents: ReadonlyArray<number>;
  };
}

/**
 * Extract a 140-d feature vector. Pure function over its input.
 *
 * @param input ExtractInput — at least mode + product.
 * @returns Float32Array of length FEATURE_DIM.
 */
export function extractFeatures(input: ExtractInput): Float32Array {
  const out = new Float32Array(FEATURE_DIM);
  const {
    mode,
    product,
    referencePrice,
    hasPairRole,
    roundContext,
    brandTier,
    priceRangeCents,
    maxPriceCapCents,
    biddingTurn,
  } = input;

  const heuristic = estimatePriceCents({
    title: product.title,
    category: product.category,
    description: (product as { description?: string }).description ?? "",
  });
  const title = product.title ?? "";
  const desc = (product as { description?: string }).description ?? "";
  const titleLen = title.length;
  const descLen = desc.length;
  const digitCount = (title.match(/\d/g) ?? []).length;
  const upperCount = (title.match(/[A-Z]/g) ?? []).length;
  const punctCount = (title.match(/[.,;:!?\-—–"']/g) ?? []).length;

  out[0] = Math.log(Math.max(heuristic, 1)) / 12;
  out[1] = Math.log(titleLen + 1) / 6;
  out[2] = digitCount / 10;
  out[3] = Math.log(descLen + 1) / 8;
  out[4] = (product as { imageUrl?: string }).imageUrl ? 1 : 0;
  out[5] = desc.length > 0 ? 1 : 0;
  out[6] = referencePrice !== undefined && referencePrice > 0 ? 1 : 0;
  out[7] = referencePrice !== undefined && referencePrice > 0 ? Math.log(referencePrice + 1) / 12 : 0;
  out[8] = titleLen > 0 ? upperCount / titleLen : 0;
  out[9] = titleLen > 0 ? punctCount / titleLen : 0;

  // Token multipliers — presence flags (0/1) over title + description.
  const haystack = `${title} ${desc}`;
  let off = 10;
  for (const [pattern] of TOKEN_PATTERNS) {
    out[off++] = pattern.test(haystack) ? 1 : 0;
  }

  // Mode one-hot (12).
  for (let i = 0; i < GAME_MODE_ORDER.length; i++) {
    out[off++] = GAME_MODE_ORDER[i] === mode ? 1 : 0;
  }

  // Pair role flag.
  out[off++] = hasPairRole ? 1 : 0;

  // Round-context block (10 dims). When `roundContext` is undefined
  // (predict path that doesn't bother — rare) all 10 stay zero, which
  // is the same as "all has-flags off" and avoids spurious log values.
  const rc = roundContext;
  const productCount = rc?.productCount ?? 0;
  out[off++] = Math.min(productCount, 30) / 10;
  out[off++] = rc?.budgetCents !== undefined && rc.budgetCents > 0 ? 1 : 0;
  out[off++] = rc?.budgetCents !== undefined && rc.budgetCents > 0 ? Math.log(rc.budgetCents + 1) / 12 : 0;
  out[off++] = rc?.pairOtherCents !== undefined && rc.pairOtherCents > 0 ? 1 : 0;
  out[off++] = rc?.pairOtherCents !== undefined && rc.pairOtherCents > 0 ? Math.log(rc.pairOtherCents + 1) / 12 : 0;
  const targets = rc?.targetPricesCents;
  if (targets && targets.length > 0) {
    let sum = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (const t of targets) {
      sum += t;
      if (t < mn) mn = t;
      if (t > mx) mx = t;
    }
    const mean = sum / targets.length;
    out[off++] = 1; // round_has_targets
    out[off++] = Math.log(mean + 1) / 12;
    out[off++] = Math.log(mn + 1) / 12;
    out[off++] = Math.log(mx + 1) / 12;
    out[off++] = Math.log(Math.max(mx - mn, 0) + 1) / 8;
  } else {
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
  }

  // Phase 3a feature block (11 dims): catalog-snap (2) + brand-tier
  // one-hot (3) + bound (6).
  // Catalog-snap: find the catalog index nearest the heuristic price,
  // normalise to [0, 1], plus log-distance to that catalog price.
  let snapIdx = 0;
  let snapDistance = 0;
  if (FEATURE_CATALOG.prices.length > 0) {
    const targetLog = Math.log(Math.max(heuristic, 1));
    let bestIdx = 0;
    let bestDz = Math.abs(FEATURE_CATALOG.logPrices[0] - targetLog);
    for (let i = 1; i < FEATURE_CATALOG.logPrices.length; i++) {
      const dz = Math.abs(FEATURE_CATALOG.logPrices[i] - targetLog);
      if (dz < bestDz) {
        bestDz = dz;
        bestIdx = i;
      }
    }
    snapIdx = bestIdx / Math.max(1, FEATURE_CATALOG.prices.length - 1);
    snapDistance = Math.log(Math.abs(heuristic - FEATURE_CATALOG.prices[bestIdx]) + 1) / 8;
  }
  out[off++] = snapIdx;
  out[off++] = snapDistance;
  // Brand-tier one-hot (3 dims). Absent → all zeros (unknown brand).
  for (let t = 0; t < BRAND_TIER_BUCKETS; t++) {
    out[off++] = brandTier !== undefined && brandTier === t ? 1 : 0;
  }
  // Bound features (6 dims) — has-product-range + log(min) + log(max)
  // + log(width); has-cap + log(cap).
  if (priceRangeCents
    && Number.isFinite(priceRangeCents.min)
    && Number.isFinite(priceRangeCents.max)
    && priceRangeCents.max >= priceRangeCents.min
    && priceRangeCents.max > 0
  ) {
    out[off++] = 1;
    out[off++] = Math.log(Math.max(priceRangeCents.min, 0) + 1) / 12;
    out[off++] = Math.log(priceRangeCents.max + 1) / 12;
    out[off++] = Math.log(priceRangeCents.max - priceRangeCents.min + 1) / 8;
  } else {
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
  }
  if (maxPriceCapCents !== undefined && maxPriceCapCents > 0 && Number.isFinite(maxPriceCapCents)) {
    out[off++] = 1;
    out[off++] = Math.log(maxPriceCapCents + 1) / 12;
  } else {
    out[off++] = 0;
    out[off++] = 0;
  }

  // Phase 3d.2 bidding-context block (5 dims). Active only when the
  // caller supplied `biddingTurn` (set by the runner on bidding rounds
  // and persisted on the Sample for symmetric train-time forward).
  // Zero-fill on every other mode + on first-bidder bidding rounds
  // (no prior bids yet, so the residual / median dims have nothing to
  // condition on).
  const bt = biddingTurn;
  const prevBids = bt?.previousBidsCents;
  const hasPrev = !!prevBids && prevBids.length > 0;
  if (hasPrev && bt) {
    let mx = -Infinity;
    const sorted = [...prevBids!].sort((a, b) => a - b);
    for (const v of prevBids!) {
      if (v > mx) mx = v;
    }
    const median = sorted[Math.floor(sorted.length / 2)];
    out[off++] = (Math.log(Math.max(mx, 0) + 1) / 12) - (Math.log(Math.max(heuristic, 1)) / 12);
    out[off++] = Math.log(Math.max(median, 0) + 1) / 12;
    // turnIdx capped at 4 (Quick Play bidding tops out at 4 players);
    // /4 puts it in [0, ~1].
    out[off++] = Math.min(bt.turnIdx, 4) / 4;
    out[off++] = bt.turnIdx === bt.totalPlayers - 1 ? 1 : 0;
    out[off++] = 1;
  } else if (bt) {
    // First bidder — turn structure is known but no prior bids exist.
    out[off++] = 0; // residual_max
    out[off++] = 0; // log_median
    out[off++] = Math.min(bt.turnIdx, 4) / 4;
    out[off++] = bt.turnIdx === bt.totalPlayers - 1 ? 1 : 0;
    out[off++] = 0;
  } else {
    // Non-bidding modes — zero everything.
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
    out[off++] = 0;
  }

  if (off !== ENGINEERED_FEATURE_DIM) {
    throw new Error(`featureExtractor: engineered offset ${off} != ${ENGINEERED_FEATURE_DIM}`);
  }

  // Hashed bigrams of the lowercased title.
  const lower = title.toLowerCase();
  for (let i = 0; i + 1 < lower.length; i++) {
    const bg = lower.slice(i, i + 2);
    const bucket = fnv1a(bg) % HASHED_BIGRAM_DIM;
    const sign = (fnv1a2(bg) & 1) === 0 ? 1 : -1;
    out[off + bucket] += sign;
  }
  // L2-normalise the bigram block so its magnitude doesn't blow up
  // for long titles.
  let sumSq = 0;
  for (let i = off; i < FEATURE_DIM; i++) sumSq += out[i] * out[i];
  if (sumSq > 0) {
    const scale = 1 / Math.sqrt(sumSq);
    for (let i = off; i < FEATURE_DIM; i++) out[i] *= scale;
  }
  return out;
}

/**
 * Map a category string to a stable bucket id. Phase 3a: bucket 0
 * is reserved as the "unseen / fallback" slot — empty / undefined
 * categories return 0; real categories hash into [1, buckets).
 */
export function categoryIdOf(category: string, buckets: number): number {
  const s = category.toLowerCase().trim();
  if (s.length === 0) return 0;
  const usable = Math.max(1, buckets - 1);
  return 1 + (fnv1a(s) % usable);
}

export const __featureInternals = { TOKEN_PATTERNS, fnv1a, fnv1a2 };
