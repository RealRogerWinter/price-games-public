/**
 * Heuristic price estimator — given a Product, returns a cents estimate
 * the bot uses to seed mode strategies. Designed to be plausible-not-
 * accurate; the realism layer + softmax sampler add the noise that
 * makes the bot look human.
 *
 * Strategy:
 *   1. Start from a category baseline (median-ish price for the bucket).
 *   2. Apply keyword multipliers from the title/description (pro / mini /
 *      bundle / refurbished etc.) that humans recognise as quality
 *      signals.
 *   3. Clamp to a sensible window so absurd inputs (titles full of
 *      premium tokens for a $5 cable) don't blow up.
 *
 * The category baselines and keyword bumps are deliberately conservative;
 * tuning them with real-world game telemetry is a follow-up. The point is
 * that the bot's guesses cluster around plausible values, not that it
 * wins every round.
 */

import type { Product } from "@price-game/shared";
import { gaussian, type RngOptions } from "../realism/timing";

// All baselines below are stored in CENTS. Helper keeps the units obvious
// at every call site — a Record literal full of `7500 * 100` magic was
// asking for a transcription bug down the line.
const usd = (dollars: number): number => Math.round(dollars * 100);

/** Category → median price (cents). Lowercased category match. */
const CATEGORY_BASELINE_CENTS: Record<string, number> = {
  electronics: usd(75),
  appliances: usd(120),
  "home & kitchen": usd(40),
  kitchen: usd(35),
  "tools & home improvement": usd(45),
  tools: usd(30),
  "toys & games": usd(25),
  toys: usd(22),
  "clothing, shoes & jewelry": usd(35),
  clothing: usd(30),
  beauty: usd(20),
  "health & household": usd(18),
  "office products": usd(25),
  office: usd(22),
  "sports & outdoors": usd(45),
  sports: usd(35),
  automotive: usd(50),
  "musical instruments": usd(120),
  "pet supplies": usd(20),
  garden: usd(30),
  "arts, crafts & sewing": usd(20),
  "grocery & gourmet food": usd(15),
  baby: usd(25),
  books: usd(15),
  "movies & tv": usd(15),
};

const DEFAULT_BASELINE_CENTS = usd(30);

/** Token → multiplier applied to baseline. */
const TOKEN_MULTIPLIERS: Array<readonly [RegExp, number]> = [
  // Premium signals
  [/\bpro\b/i, 1.4],
  [/\bpremium\b/i, 1.5],
  [/\bdeluxe\b/i, 1.4],
  [/\bprofessional\b/i, 1.6],
  [/\bcommercial\b/i, 1.7],
  [/\bheavy[\s-]?duty\b/i, 1.5],
  [/\bsmart\b/i, 1.3],
  [/\bwireless\b/i, 1.2],
  [/\b4k\b/i, 1.4],
  [/\b8k\b/i, 1.6],
  [/\bgaming\b/i, 1.4],
  [/\borganic\b/i, 1.2],
  [/\bstainless steel\b/i, 1.3],
  [/\bleather\b/i, 1.4],
  // Discount / lower-end signals
  [/\bmini\b/i, 0.7],
  [/\bbasic\b/i, 0.7],
  [/\brefurbished\b/i, 0.65],
  [/\brenewed\b/i, 0.7],
  [/\bgeneric\b/i, 0.6],
  [/\bsingle\b/i, 0.85],
  [/\btravel size\b/i, 0.6],
  [/\bsample\b/i, 0.5],
  // Quantity/bundle bumps (modest — bot doesn't know unit count)
  [/\bbundle\b/i, 1.5],
  [/\bset of \d+\b/i, 1.4],
  [/\bpack of \d+\b/i, 1.4],
  [/\b\d+[\s-]?pack\b/i, 1.3],
];

/** Hard floor / ceiling so an outlier title can't yield a $1 toaster guess. */
const MIN_CENTS = 100;       // $1
const MAX_CENTS = 500_000_00; // $500,000

interface EstimateOptions extends RngOptions {
  /**
   * Standard deviation of the multiplicative noise applied to the
   * estimate, in log-space. 0 disables noise (the deterministic
   * estimator). Default 0.0 — the strategy layer adds its own noise
   * on top via softmax sampling.
   */
  noise?: number;
}

function categoryBaseline(category: string): number {
  const key = category.toLowerCase().trim();
  if (CATEGORY_BASELINE_CENTS[key] !== undefined) return CATEGORY_BASELINE_CENTS[key];
  // Try a partial match (e.g. server returns "Electronics > Audio").
  for (const [bucket, cents] of Object.entries(CATEGORY_BASELINE_CENTS)) {
    if (key.includes(bucket)) return cents;
  }
  return DEFAULT_BASELINE_CENTS;
}

function tokenAdjustment(text: string): number {
  let mult = 1;
  for (const [pattern, factor] of TOKEN_MULTIPLIERS) {
    if (pattern.test(text)) mult *= factor;
  }
  // Clamp the cumulative multiplier so a title spamming premium tokens
  // doesn't 10x the baseline.
  return Math.min(3, Math.max(0.25, mult));
}

/**
 * Estimate the price (in cents) of `product`. Deterministic by default;
 * pass `noise > 0` for log-normal multiplicative jitter.
 *
 * @param product Product as delivered by the server (title + category +
 *                description suffice).
 * @param opts See {@link EstimateOptions}.
 * @returns Estimated price in cents, clamped to [MIN_CENTS, MAX_CENTS].
 */
export function estimatePriceCents(
  product: Pick<Product, "title" | "category" | "description">,
  opts: EstimateOptions = {},
): number {
  const baseline = categoryBaseline(product.category);
  const adjustment = tokenAdjustment(`${product.title} ${product.description ?? ""}`);
  let cents = baseline * adjustment;
  if (opts.noise && opts.noise > 0) {
    const rng = opts.rng ?? Math.random;
    cents *= Math.exp(gaussian(0, opts.noise, rng));
  }
  return Math.max(MIN_CENTS, Math.min(MAX_CENTS, Math.round(cents)));
}

export const __priceEstimatorInternals = {
  CATEGORY_BASELINE_CENTS,
  DEFAULT_BASELINE_CENTS,
  TOKEN_MULTIPLIERS,
  MIN_CENTS,
  MAX_CENTS,
};
