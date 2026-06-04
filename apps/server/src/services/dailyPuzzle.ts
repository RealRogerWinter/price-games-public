/**
 * Daily challenge puzzle generator.
 *
 * Provides:
 *   - mulberry32: a tiny seeded PRNG (no external deps).
 *   - hashSeed: FNV-1a hash of (salt + date + saltVersion) → uint32 seed.
 *   - seededShuffle: deterministic Fisher–Yates shuffle.
 *   - getOrCreateDailyPuzzle: read-or-generate the cached puzzle for a date.
 *   - DailyUnavailableError: thrown when every DAILY_POOL mode is disabled.
 *
 * The generator is intentionally lazy: the first request for a given date
 * triggers composition + INSERT, subsequent requests return the cached row.
 * `INSERT OR IGNORE` + re-SELECT keeps the path race-safe under concurrent
 * first-requesters.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { GameMode } from "@price-game/shared";
import { getDailyModeForDate } from "@price-game/shared";
import { config } from "../config";
import { getDailySchedule, getDisabledGameModes } from "./siteSettings";
import { composeDailyRounds } from "./dailyRoundComposer";

/** Thrown when no DAILY_POOL mode is enabled (admin disabled all three). */
export class DailyUnavailableError extends Error {
  constructor(date: string) {
    super(`No daily mode is currently available for ${date}`);
    this.name = "DailyUnavailableError";
  }
}

/** Row shape for the daily_puzzles table. */
export interface DbDailyPuzzle {
  daily_date: string;
  game_mode: GameMode;
  product_ids: string;       // JSON-encoded number[]
  round_data: string | null; // JSON-encoded Record<string, unknown>
  salt_version: number;
  is_manual_override: number; // 0 | 1
  created_at: string;
  updated_at: string | null;
}

/**
 * mulberry32 — a tiny, fast, well-distributed seedable PRNG. Returns a
 * function that yields a fresh [0, 1) number on each call. Seeded by a
 * single uint32.
 *
 * Reference: https://gist.github.com/tommyettinger/46a3c5b41fdf12fbcd0e
 *
 * @param seed - The uint32 seed
 * @returns A function that returns the next pseudo-random value in [0, 1)
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash the (salt, date, saltVersion) tuple into a uint32 seed using FNV-1a.
 * Stable across processes — the only state is the inputs.
 *
 * @param salt - Operator-controlled salt (rotated to invalidate future days)
 * @param date - YYYY-MM-DD UTC date
 * @param saltVersion - Bump to invalidate cached puzzles for the same date
 * @returns A uint32 seed suitable for mulberry32
 */
export function hashSeed(salt: string, date: string, saltVersion: number): number {
  const input = `${salt}:${date}:${saltVersion}`;
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic Fisher–Yates shuffle. Returns a NEW array — does not
 * mutate the input.
 *
 * @param items - The array to shuffle
 * @param rng - A seeded PRNG (e.g. from mulberry32)
 * @returns A new array containing the same elements in shuffled order
 */
export function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Read the cached daily puzzle for the given date, or generate it on the
 * fly if missing. The generation path is gated by the resolved mode (taking
 * the admin schedule + disabled-modes list into account); if every pool
 * mode is disabled, a DailyUnavailableError is thrown.
 *
 * Manual overrides (rows with is_manual_override = 1) are returned as-is
 * and never regenerated. The admin "regenerate" action lives in the admin
 * routes (commit 5) and explicitly clears the override flag.
 *
 * Race safety: two concurrent first-requesters can race past the SELECT
 * and both attempt the INSERT. We use `INSERT OR IGNORE` and re-SELECT
 * so the loser of the race silently observes the winner's row.
 *
 * @param database - Database handle (defaults to the global `db`)
 * @param date - YYYY-MM-DD UTC date
 * @returns The DbDailyPuzzle row
 * @throws DailyUnavailableError when no pool mode is enabled
 */
export function getOrCreateDailyPuzzle(
  database: DatabaseType,
  date: string,
): DbDailyPuzzle {
  // Fast path: cache hit (including manual overrides).
  const existing = database
    .prepare("SELECT * FROM daily_puzzles WHERE daily_date = ?")
    .get(date) as DbDailyPuzzle | undefined;
  if (existing) return existing;

  // Resolve the mode using the admin-editable schedule + disabled-modes set.
  const schedule = getDailySchedule(database);
  const disabled = new Set(getDisabledGameModes(database) as GameMode[]);
  const mode = getDailyModeForDate(date, schedule, disabled);
  if (!mode) throw new DailyUnavailableError(date);

  // Compose the round data deterministically.
  const saltVersion = 1;
  const seed = hashSeed(config.dailySeedSalt, date, saltVersion);
  const rng = mulberry32(seed);
  const composed = composeDailyRounds(database, mode, rng);

  // INSERT OR IGNORE for race safety; the SELECT below picks up whichever
  // INSERT actually landed.
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO daily_puzzles
         (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      date,
      mode,
      JSON.stringify(composed.productIds),
      JSON.stringify(composed.roundData),
      saltVersion,
      now,
    );

  return database
    .prepare("SELECT * FROM daily_puzzles WHERE daily_date = ?")
    .get(date) as DbDailyPuzzle;
}
