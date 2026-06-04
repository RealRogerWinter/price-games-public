/**
 * Daily-mode round composer.
 *
 * Distinct from the main `roundComposer.ts` because the daily challenge has
 * three hard requirements that the existing composer cannot satisfy:
 *
 *   1. Determinism: every player on a given UTC date plays the EXACT same
 *      products in the same order. The standard composer uses Math.random
 *      and per-user history filters; the daily composer takes a seed and
 *      uses it to drive every random choice via mulberry32.
 *
 *   2. Stable product pool: the daily composer queries products without any
 *      per-user exclusions and treats the snapshot as canonical for the day.
 *      Once a daily_puzzles row is cached, mid-day product changes never
 *      affect in-progress games.
 *
 *   3. Admin-selectable mode surface: every registered GameMode is now
 *      eligible. The composer uses per-mode product counts matching the
 *      main composer, and generates the same flavour of medium-tier
 *      metadata (deterministically via the seeded RNG). Selection is a
 *      straight shuffle-then-slice rather than the difficulty-aware
 *      pair/group selection used by the main composer — keeping the daily
 *      composer simple and reproducible across the full mode catalog.
 *
 * For these reasons we implement the daily composer inline here rather than
 * adding a `seed?: () => number` parameter to the existing composer (which
 * would be a much larger refactor with broader test impact).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { GameMode } from "@price-game/shared";
import {
  DAILY_TOTAL_ROUNDS,
  getDailyProductsPerRound,
} from "@price-game/shared";

interface PoolProduct {
  id: number;
  price_cents: number;
  title: string;
  category: string | null;
  manufacturer: string | null;
}

export interface ComposedDailyRounds {
  productIds: number[];
  roundData: Record<string, unknown>;
}

/**
 * Compose 5 deterministic rounds for a daily puzzle. The seed governs every
 * random choice — the same seed + the same product pool yields the same
 * output forever.
 *
 * @param db - Database handle (used to snapshot the active product pool).
 * @param mode - Any GameMode from `DAILY_ADMIN_ALLOWED_MODES`. The composer
 *   picks the correct number of products per round for the mode and generates
 *   deterministic medium-tier metadata via `seed`.
 * @param seed - The seeded PRNG to drive selection and metadata.
 * @returns Product IDs (in round order) and the round_data JSON blob.
 * @throws Error if the active product pool has fewer products than the mode requires.
 */
export function composeDailyRounds(
  db: DatabaseType,
  mode: GameMode,
  seed: () => number,
): ComposedDailyRounds {
  const pool = snapshotPool(db);

  const productsPerRound = getDailyProductsPerRound(mode);
  const totalNeeded = productsPerRound * DAILY_TOTAL_ROUNDS;
  if (pool.length < totalNeeded) {
    throw new Error(
      `daily composer: not enough active products for mode "${mode}" (have ${pool.length}, need ${totalNeeded})`
    );
  }

  // Deterministic shuffle of the entire pool, then walk it round by round.
  const shuffled = seededShuffleInPlace([...pool], seed);
  const productIds: number[] = [];
  const roundData: Record<string, unknown> = {};

  let cursor = 0;
  for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
    const slice = shuffled.slice(cursor, cursor + productsPerRound);
    cursor += productsPerRound;
    const ids = slice.map((p) => p.id);
    for (const id of ids) productIds.push(id);
    roundData[String(round)] = {
      productIds: ids,
      ...generateDailyRoundMeta(mode, slice, seed),
    };
  }

  return { productIds, roundData };
}

/**
 * Snapshot the active product pool. Excludes archived and zero-priced
 * products. The query is identical to the main composer's pool query so
 * we never accidentally include data the main game would never show.
 */
function snapshotPool(db: DatabaseType): PoolProduct[] {
  return db
    .prepare(
      `SELECT id, price_cents, title, category, manufacturer
       FROM products
       WHERE is_active = 1
         AND (is_archived IS NULL OR is_archived = 0)
         AND price_cents > 0
       ORDER BY id ASC`
    )
    .all() as PoolProduct[];
}

/**
 * Fisher–Yates shuffle driven by the supplied PRNG. Mutates and returns
 * the input array — callers should clone first if they need the original.
 */
function seededShuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Generate the per-round metadata blob for a daily round. Uses the supplied
 * RNG for any random choices so the metadata is reproducible from seed.
 * Mirrors the main composer's medium-tier defaults for modes that need
 * extra metadata (higher-lower, comparison, riser, market-basket,
 * budget-builder).
 */
function generateDailyRoundMeta(
  mode: GameMode,
  products: PoolProduct[],
  rng: () => number,
): Record<string, unknown> {
  if (mode === "higher-lower") {
    const actual = products[0].price_cents;
    // Mid-difficulty offset range, mirroring the main composer's "medium" tier.
    const minPct = 0.20;
    const maxPct = 0.35;
    const pctOffset = minPct + rng() * (maxPct - minPct);
    const direction = rng() < 0.5 ? 1 : -1;
    const referencePrice = Math.max(100, Math.round(actual * (1 + direction * pctOffset)));
    return { referencePrice };
  }

  if (mode === "comparison") {
    return { question: rng() < 0.5 ? "most-expensive" : "least-expensive" };
  }

  if (mode === "riser") {
    // Medium-tier riser configuration, reproducible from seed.
    const patterns = ["linear", "accelerating", "decelerating", "wave"];
    const speedPattern = patterns[Math.floor(rng() * patterns.length)];
    const minDuration = 10000;
    const maxDuration = 14000;
    const durationMs = minDuration + Math.floor(rng() * (maxDuration - minDuration));
    const targetPosition = 0.25 + rng() * 0.60;
    const maxPriceCents = Math.round(products[0].price_cents / (0.1 + 0.9 * targetPosition));
    return { maxPriceCents, speedPattern, durationMs };
  }

  if (mode === "market-basket") {
    return { itemCount: products.length };
  }

  if (mode === "budget-builder") {
    const totalProductValue = products.reduce((s, p) => s + p.price_cents, 0);
    // Medium budget fraction — same value the main composer uses at "medium".
    const budgetCents = Math.round(totalProductValue * 0.50);
    return { budgetCents };
  }

  // classic, closest-without-going-over, price-match, odd-one-out,
  // sort-it-out, chain-reaction, bidding: no extra metadata needed.
  return {};
}
