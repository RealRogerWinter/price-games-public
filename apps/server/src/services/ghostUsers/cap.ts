/**
 * Percentile-based score cap for ghost users.
 *
 * No ghost's `lifetime_score` may exceed the Nth percentile of qualified
 * real-player scores (default N=70). Real players own the podium and the
 * top quartile; ghosts populate the long tail. The cap is applied at
 * credit time inside {@link ./credit.ts} as a soft-limit (curtail rather
 * than reject) so a ghost simply plateaus instead of mysteriously
 * stopping mid-game.
 *
 * The cap value is recomputed periodically and cached in-memory with a
 * 6-hour TTL. Mutations through the admin API can call
 * {@link invalidateCapCache} to force a recompute on the next read.
 *
 * Pure SQL only — no PRNG, no Date.now() side effects beyond the TTL
 * timestamp.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { getGhostSettings } from "./settings";

/** Cache TTL (ms). 6 hours — slow enough to be cheap, fast enough that a
 *  big swing in real-player scores doesn't take a full day to propagate. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Minimum number of completed sessions a real user must have for their
 *  score to count toward the cap calculation. Filters out fresh signups
 *  whose lifetime_score isn't yet representative. */
const MIN_SESSIONS_FOR_CAP = 5;

interface CacheEntry {
  cap: number;
  computedAt: number;
}
let cached: CacheEntry | null = null;

/**
 * Force the next call to {@link getCachedCap} to recompute. Call this
 * from any admin action that changes the percentile setting (so the new
 * value takes effect immediately rather than on the next TTL tick).
 */
export function invalidateCapCache(): void {
  cached = null;
}

/**
 * Compute the cap as the Nth-percentile of qualified real users'
 * `lifetime_score`.
 *
 * Algorithm: pull all qualified scores ordered ascending, then index at
 * `floor((N/100) * (count - 1))` and round to nearest integer. With N=70
 * and 10 scores 1000..10000, this resolves to index 6 → 7000.
 *
 * Returns 0 when fewer than 1 user qualifies — a 0 cap means "no ghost
 * may earn any score" until at least one real user has built a baseline.
 *
 * @param db - Database instance.
 * @param percentile - 0-100. Caller is responsible for clamping.
 */
export function computePercentileCap(db: DatabaseType, percentile: number): number {
  const rows = db
    .prepare(
      `SELECT lifetime_score FROM users
        WHERE is_active = 1
          AND lifetime_score > 0
          AND total_sessions >= ?
        ORDER BY lifetime_score ASC`,
    )
    .all(MIN_SESSIONS_FOR_CAP) as { lifetime_score: number }[];

  if (rows.length === 0) return 0;
  const idx = Math.max(
    0,
    Math.min(rows.length - 1, Math.floor((percentile / 100) * (rows.length - 1))),
  );
  return rows[idx].lifetime_score;
}

/**
 * Read the current cap, recomputing if the cache is empty or stale.
 *
 * Reads `percentileCap` from {@link getGhostSettings} on each recompute
 * so admin updates to the percentile take effect on the next TTL boundary
 * (or immediately if the admin route also calls {@link invalidateCapCache}).
 *
 * @param db - Database instance.
 */
export function getCachedCap(db: DatabaseType): number {
  const now = Date.now();
  if (cached && now - cached.computedAt < CACHE_TTL_MS) {
    return cached.cap;
  }
  const settings = getGhostSettings(db);
  const cap = computePercentileCap(db, settings.percentileCap);
  cached = { cap, computedAt: now };
  return cap;
}
