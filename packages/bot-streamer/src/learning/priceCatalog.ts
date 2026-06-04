/**
 * Canonical-prices catalog — the discrete output space of the
 * priceClass classification head.
 *
 * Real Amazon retail prices cluster heavily on a sparse grid of
 * "psychological" prices: $0.99, $9.99, $19.99, $24.99, $99, etc.
 * Continuous regression over log-residual was fighting the data —
 * predicting "$9.347" got penalised by the loss but is not a real
 * answer in the first place. The catalog reframes the problem as
 * classification into one of ~150 realistic prices, which:
 *
 *   1. matches the manifold the data actually lives on;
 *   2. removes the σ-runaway loss-instability surface entirely (CE is
 *      bounded below by 0, no log-sigma to oscillate);
 *   3. makes predictions look broadcast-grade ("$8.50", "$19.99")
 *      instead of "3.95e-2 cents".
 *
 * The default catalog is hand-curated to cover the typical product
 * range ($0.49 → $3000). At runtime, observations from the seeded
 * products DB can extend the default with prices that show up ≥2×
 * but aren't on the default grid — this lets us absorb category-
 * specific psychological prices without re-curating the constant.
 */

/** Cap on catalog size — sets the priceClassHead's output dim. */
export const MAX_K = 300;

/**
 * Hand-curated catalog of common retail prices, sorted ascending.
 * Tiers + endings:
 *   - Sub-$1:   .49 / .99
 *   - $1–$10:   round-dollar (.00) AND .49/.99 — covers both
 *               "$2.00 hot dog" and "$1.99 candy"
 *   - $10–$50:  $1 steps with .99 endings + round-dollar at $5 marks
 *   - $50–$200: $5 steps, .99 endings + round $100 / $200
 *   - $200+:    sparse round-dollar + .99 anchors
 *
 * Coverage spans $0.49 → $9999.99. Total: 130 entries — must match
 * `PRICE_CLASS_K` in types.ts (the priceClassHead allocates one
 * output slot per entry; mismatch throws at runtime via the
 * invariant check in WorkerCore.constructor).
 *
 * Round-dollar entries (.00) were added in PR #2 review pass after
 * the user pointed out the original ".49/.99-only" set didn't match
 * real-world prices like "$2.00" or "$10.00" they'd given as examples.
 */
const DEFAULT_CATALOG_CENTS: ReadonlyArray<number> = Object.freeze([
  // Sub-$1
  49, 99,
  // $1.00 – $9.99: round-dollar + .49/.99
  100, 149, 199, 200, 249, 299, 300, 349, 399, 400,
  449, 499, 500, 549, 599, 600, 649, 699, 700, 749,
  799, 800, 849, 899, 900, 949, 999,
  // $10 – $49: $1 steps with .99, plus round-dollar at $10/$15/$20/etc
  1000, 1099, 1199, 1299, 1399, 1499, 1500, 1599, 1699, 1799,
  1899, 1999, 2000, 2099, 2199, 2299, 2499, 2500, 2699, 2799,
  2999, 3000, 3199, 3499, 3799, 3999, 4000, 4299, 4499, 4799,
  4999,
  // $50 – $99: $5 steps with .99 + round-dollar at $50/$75/$100
  5000, 5499, 5999, 6499, 6999, 7499, 7500, 7999, 8499, 8999,
  9499, 9999,
  // $100 – $199: round-dollar + .99 anchors
  10000, 10999, 11999, 12500, 12999, 14999, 15000, 17499, 19999, 20000,
  // $200 – $999: sparse round + .99
  24999, 25000, 29999, 30000, 34999, 39999, 49999, 50000,
  59999, 69999, 74999, 79999, 99999,
  // $1000+: high-end round-dollar
  100000, 119999, 149999, 199999, 249999, 299999, 499999, 999999,
]);

export interface PriceCatalog {
  /** Cents, sorted ascending. */
  readonly prices: ReadonlyArray<number>;
  /** Number of classes (== prices.length). */
  readonly K: number;
  /** Pre-computed log(p) for each entry — used for ordinal smoothing. */
  readonly logPrices: ReadonlyArray<number>;
  /**
   * Snap an arbitrary cents value to the nearest catalog index by
   * absolute log-price distance. Non-finite inputs return 0 (rather
   * than letting NaN propagate into a softmax target).
   */
  snap(cents: number): number;
}

/**
 * Construct a catalog from a sorted, deduplicated cents list.
 *
 * @param sortedPrices Must be already sorted ascending and unique.
 */
function makeCatalog(sortedPrices: ReadonlyArray<number>): PriceCatalog {
  const prices = sortedPrices;
  const K = prices.length;
  const logPrices: number[] = new Array(K);
  for (let i = 0; i < K; i++) logPrices[i] = Math.log(prices[i]);

  return {
    prices,
    K,
    logPrices,
    snap(cents: number): number {
      if (!Number.isFinite(cents) || cents <= 0) return 0;
      const target = Math.log(cents);
      // Linear scan is fine — K ≤ MAX_K (300) and snap() is called at
      // most twice per round (per-product & golden-eval). Bisecting is
      // an optimisation to revisit only if the visit count grows.
      let bestIdx = 0;
      let bestDist = Math.abs(logPrices[0] - target);
      for (let i = 1; i < K; i++) {
        const d = Math.abs(logPrices[i] - target);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    },
  };
}

/** Build the hand-curated default catalog. Cached per module load. */
let defaultCatalogCache: PriceCatalog | null = null;
export function buildDefaultCatalog(): PriceCatalog {
  if (!defaultCatalogCache) {
    defaultCatalogCache = makeCatalog(DEFAULT_CATALOG_CENTS);
  }
  return defaultCatalogCache;
}

/**
 * Build a catalog by extending the default with observed prices that
 * appear ≥2× and aren't already in the default. Caps the output at
 * {@link MAX_K} entries — when over the cap, defaults stay and
 * observations are added in frequency-descending order until full.
 *
 * @param observations Cents values observed in training data.
 */
export function buildCatalogFromObservations(
  observations: ReadonlyArray<number>,
): PriceCatalog {
  if (observations.length === 0) return buildDefaultCatalog();

  // Frequency-bucket the observations.
  const counts = new Map<number, number>();
  for (const obs of observations) {
    if (!Number.isFinite(obs) || obs <= 0) continue;
    const cents = Math.round(obs);
    counts.set(cents, (counts.get(cents) ?? 0) + 1);
  }

  // Default entries are always in.
  const inSet = new Set<number>(DEFAULT_CATALOG_CENTS);

  // Candidates: observed ≥2× AND not already in the default.
  const candidates: Array<{ cents: number; count: number }> = [];
  for (const [cents, count] of counts) {
    if (count < 2) continue;
    if (inSet.has(cents)) continue;
    candidates.push({ cents, count });
  }
  // Higher count first; tiebreak on cents for determinism.
  candidates.sort((a, b) => b.count - a.count || a.cents - b.cents);

  const slotsLeft = MAX_K - inSet.size;
  const accepted = candidates.slice(0, Math.max(0, slotsLeft));
  for (const c of accepted) inSet.add(c.cents);

  const sorted = Array.from(inSet).sort((a, b) => a - b);
  return makeCatalog(sorted);
}
