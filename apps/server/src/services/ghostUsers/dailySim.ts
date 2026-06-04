/**
 * Ghost daily-challenge play simulator.
 *
 * Replaces the old purely-synthetic streak advancer (`advanceGhostStreaks`).
 * Each UTC day, every active ghost rolls against its own
 * `daily_play_probability`; if the roll says "played", we record a real
 * `ghost_game_history` row (game_type='single', game_mode='daily') with a
 * plausible score sampled from the day's real-user daily distribution
 * (falling back to a fixed band when no real-user dailies exist), bump
 * `last_played_at` + `lifetime_score` via the standard `creditGhostScore`
 * percentile-cap path, and advance the streak. Streak progression is
 * strictly clamped at the top real-user streak so ghosts can never
 * out-rank humans on the streak leaderboard.
 *
 * Idempotent within a UTC day via a process-level latch. Manual admin
 * triggers can pass `force: true` to bypass the latch (the per-ghost
 * idempotency check still prevents double-counting within the same day).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { addDays } from "@price-game/shared";
import { creditGhostScore } from "./credit";
import { getGhostSettings } from "./settings";

/** Lower bound of the score-fallback band used when no real-user dailies
 *  exist for the requested date. Chosen as a plausible "okay but not
 *  great" daily total (5 rounds × ~120 pts) so ghosts contribute to but
 *  don't dominate period leaderboards on empty days. */
export const GHOST_DAILY_SCORE_FALLBACK_MIN = 600;

/** Upper bound of the score-fallback band. Sits well below the lifetime
 *  percentile cap that `creditGhostScore` enforces, and roughly matches
 *  the 70th percentile of typical real-user daily scores. */
export const GHOST_DAILY_SCORE_FALLBACK_MAX = 2200;

/** Bottom-percentile slice we draw the ghost's score from when real-user
 *  dailies exist for the date. Mirrors the existing `creditGhostScore`
 *  policy of keeping ghost scores in the bottom 30% so the leaderboard
 *  podium stays human-led. */
const SAMPLE_BOTTOM_PERCENTILE = 0.30;

/** Fallback game mode when no `daily_puzzles` row exists for the
 *  simulator date (e.g. fresh install or admin replay of a date that
 *  pre-dates the puzzle table). "classic" is the most canonical mode
 *  and matches the home-page default. */
const DEFAULT_DAILY_MODE = "classic";

/**
 * Read the underlying game mode for the daily challenge on the given
 * UTC date from `daily_puzzles`. The daily isn't its own game mode —
 * each UTC day rotates between real modes ("classic", "higher-lower",
 * "bidding", etc.) and `daily_puzzles.game_mode` is the canonical
 * record. Real-user daily plays write that mode into
 * `user_game_history.game_mode`, so ghost daily plays must do the same
 * or their profiles look inconsistent ("Daily: 7" vs "Higher-Lower: 7").
 *
 * Falls back to {@link DEFAULT_DAILY_MODE} when no row exists for the
 * date — the simulator is allowed to run on dates that don't yet have
 * a generated puzzle.
 */
function getDailyPuzzleMode(db: DatabaseType, date: string): string {
  const row = db
    .prepare("SELECT game_mode FROM daily_puzzles WHERE daily_date = ?")
    .get(date) as { game_mode: string } | undefined;
  return row?.game_mode ?? DEFAULT_DAILY_MODE;
}

/**
 * Kept as a no-op for back-compat with the previous latch-based flow.
 * Per-ghost idempotency now lives entirely in the
 * `ghost_users.last_daily_decision_date` column, so there is no
 * process-level state to reset.
 */
export function _resetSimLatchForTesting(): void {
  // intentionally empty — see comment above.
}

/** Add one day (UTC) to a YYYY-MM-DD date string. */
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Read the bottom-30% slice of real-user daily scores for the given UTC
 * date, ascending. Returns an empty array when no real-user dailies
 * exist for that date — caller should fall back to a fixed band.
 *
 * Exposed so the simulator can fetch the slice once per pass and pass
 * it to repeated `sampleGhostDailyScore` calls instead of re-running
 * the SQL for every ghost.
 */
function readDailyScoreSlice(db: DatabaseType, date: string): number[] {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${nextDay(date)}T00:00:00Z`;
  const rows = db
    .prepare(
      `SELECT score FROM user_game_history
        WHERE game_type = 'single' AND game_mode = 'daily'
          AND played_at >= ? AND played_at < ?
        ORDER BY score ASC`,
    )
    .all(dayStart, dayEnd) as { score: number }[];

  if (rows.length === 0) return [];
  const sliceSize = Math.max(1, Math.ceil(rows.length * SAMPLE_BOTTOM_PERCENTILE));
  return rows.slice(0, sliceSize).map((r) => r.score);
}

/** Pick one score from a precomputed slice (or fall back to the fixed band). */
function pickScore(slice: number[], random: () => number): number {
  if (slice.length === 0) {
    const span = GHOST_DAILY_SCORE_FALLBACK_MAX - GHOST_DAILY_SCORE_FALLBACK_MIN;
    return Math.floor(GHOST_DAILY_SCORE_FALLBACK_MIN + random() * span);
  }
  const idx = Math.min(slice.length - 1, Math.floor(random() * slice.length));
  return slice[idx];
}

/**
 * Sample a plausible per-game daily score for a ghost on the given UTC date.
 *
 * When real users have completed daily plays for that date, draws
 * uniformly from the bottom 30% slice of those scores so the ghost stays
 * visually behind the human leaderboard. When no real-user dailies exist
 * for that date (fresh launch, sandbox, low-activity day), falls back to
 * a uniform draw across the fixed `[GHOST_DAILY_SCORE_FALLBACK_MIN,
 * GHOST_DAILY_SCORE_FALLBACK_MAX]` band.
 *
 * Convenience wrapper: re-runs the SQL on every call. The simulator
 * uses `readDailyScoreSlice` + `pickScore` directly so the SQL fires
 * once per pass instead of once per ghost.
 *
 * @param db - Database instance.
 * @param date - Target UTC date (YYYY-MM-DD).
 * @param random - Optional [0,1) source. Tests inject deterministic values.
 * @returns Integer score to credit.
 */
export function sampleGhostDailyScore(
  db: DatabaseType,
  date: string,
  random: () => number = Math.random,
): number {
  return pickScore(readDailyScoreSlice(db, date), random);
}

/**
 * Get the strict streak ceiling: the max `daily_streak_best` across
 * leaderboard-eligible real users (active, not banned, not test).
 * Returns 0 when no eligible user exists — in that case no ghost streak
 * is ever permitted to advance.
 */
export function getRealUserStreakCap(db: DatabaseType): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(daily_streak_best), 0) AS cap
         FROM users
        WHERE is_active = 1
          AND leaderboard_banned_at IS NULL
          AND is_test_account = 0`,
    )
    .get() as { cap: number };
  return row.cap;
}

/** Result summary returned by {@link simulateGhostDailyPlays}. */
export interface SimulationResult {
  /** Number of active ghosts considered (after defensive cleanup). */
  ghostsConsidered: number;
  /** Number that "played" today (game-history row written). */
  played: number;
  /** Number that didn't play (streak resets, no row written). */
  skippedNoPlay: number;
  /** Number whose streak was clamped by the real-user cap. */
  streakCapped: number;
  /** Number of never-played ghosts whose stale streak fields were zeroed. */
  cleanupZeroed: number;
}

/** Options for {@link simulateGhostDailyPlays}. */
export interface SimulationOpts {
  /** [0,1) source for per-ghost play coin-flips. Defaults to `Math.random`. */
  random?: () => number;
  /** Override `new Date()` for synthesising `played_at` timestamps. */
  now?: () => Date;
  /** When true, only ghosts currently `on_shift = 1` are eligible. Each
   *  hourly tick processes whichever on-shift ghosts haven't already
   *  decided today, which makes the population's daily plays trickle out
   *  across the UTC day in lock-step with shift rotation rather than
   *  firing in one all-at-once burst (which would otherwise cause a
   *  visible leaderboard "jump" each hour the simulator runs).
   *
   *  Defaults to true — the production hourly tick relies on this. The
   *  admin manual-trigger endpoint can opt into `false` for sandbox /
   *  demo runs where waiting for shift rotation isn't desired. */
  onShiftOnly?: boolean;
}

/**
 * Pick a random `played_at` ISO timestamp inside the given UTC date.
 *
 * Distributes ghost plays across the day so period leaderboards see a
 * realistic spread of activity rather than a synthetic 00:00 spike.
 */
function syntheticPlayedAt(
  date: string,
  random: () => number,
  now: () => Date,
): string {
  // Cap at "now" so future-dated rows can't be written when the simulator
  // runs partway through today. Past dates (admin replay) get the full
  // 24h range.
  const dayStartMs = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  const wallNow = now().getTime();
  const dayEndMs = Math.min(dayStartMs + 24 * 60 * 60 * 1000, wallNow);
  const span = Math.max(1, dayEndMs - dayStartMs);
  return new Date(dayStartMs + Math.floor(random() * span)).toISOString();
}

/**
 * Run one simulation pass for the given UTC date.
 *
 * @param db - Database instance.
 * @param today - Today's UTC date (YYYY-MM-DD). Pass past dates only via
 *   the admin manual-trigger path with `force: true`.
 * @param opts - Optional injection points and force flag.
 * @returns Counters describing what happened.
 */
export function simulateGhostDailyPlays(
  db: DatabaseType,
  today: string,
  opts: SimulationOpts = {},
): SimulationResult {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const onShiftOnly = opts.onShiftOnly !== false;

  const empty: SimulationResult = {
    ghostsConsidered: 0,
    played: 0,
    skippedNoPlay: 0,
    streakCapped: 0,
    cleanupZeroed: 0,
  };

  // Visibility gate: only run when ghosts are enabled and not killed.
  // Independent of `showOnLeaderboard` — we want activity to accrue even
  // when ghosts are dark, so flipping visibility on later starts from a
  // populated state.
  const settings = getGhostSettings(db);
  if (!settings.enabled || settings.killSwitch) return empty;

  const updatedAt = new Date().toISOString();

  // Defensive cleanup: a never-played ghost (last_played_at IS NULL,
  // i.e. zero rows in ghost_game_history) must not carry a streak. Carry-
  // over from the previous-fix invariant — any row with stale streak
  // fields gets reset before the simulator runs.
  const cleanup = db.prepare(
    `UPDATE ghost_users
        SET daily_streak_current = 0,
            daily_streak_best = 0,
            daily_streak_last_date = NULL,
            updated_at = ?
      WHERE is_active = 1
        AND last_played_at IS NULL
        AND (daily_streak_best > 0
             OR daily_streak_current > 0
             OR daily_streak_last_date IS NOT NULL)`,
  ).run(updatedAt);

  const cleanupZeroed = cleanup.changes;

  const cap = getRealUserStreakCap(db);
  const scoreSlice = readDailyScoreSlice(db, today);
  const gameMode = getDailyPuzzleMode(db, today);

  // Only ghosts that have actually played at least one game are eligible
  // for a streak. New "first-play" simulator rows will set last_played_at,
  // so a ghost cycles into eligibility on its first credited round (mp
  // OR daily).
  //
  // Trickle-out gate: when `onShiftOnly` is true (production hourly tick
  // path), we additionally require `on_shift = 1` so plays only fire for
  // ghosts who are currently active on the floor. Combined with the
  // `last_daily_decision_date != today` filter, this means each hourly
  // tick processes only the small slice of ghosts who (a) are on shift
  // right now and (b) haven't already decided today — naturally
  // spreading the day's plays across the day in lock-step with shift
  // rotation.
  const onShiftPredicate = onShiftOnly ? "AND on_shift = 1" : "";
  const ghosts = db
    .prepare(
      `SELECT id, daily_streak_current, daily_streak_best, daily_streak_last_date,
              daily_play_probability
         FROM ghost_users
        WHERE is_active = 1
          AND last_played_at IS NOT NULL
          ${onShiftPredicate}
          AND (last_daily_decision_date IS NULL OR last_daily_decision_date != ?)`,
    )
    .all(today) as Array<{
      id: string;
      daily_streak_current: number;
      daily_streak_best: number;
      daily_streak_last_date: string | null;
      daily_play_probability: number;
    }>;

  let played = 0;
  let skippedNoPlay = 0;
  let streakCapped = 0;
  const yesterday = addDays(today, -1);

  // One transaction wraps every per-ghost mutation: a single fsync
  // instead of N, and gives the loop transactional consistency so a
  // mid-loop crash leaves the population state internally consistent.
  db.transaction(() => {
    for (const g of ghosts) {
      // Defensive clamp: if a misconfigured/admin-corrupted row stores
      // NaN / negative / >1 in daily_play_probability, treat it as a
      // no-play-today signal rather than blowing up. The repository
      // never writes such values, but DB-level invariants aren't
      // enforced (REAL accepts anything).
      const prob = Number.isFinite(g.daily_play_probability)
        ? Math.min(1, Math.max(0, g.daily_play_probability))
        : 0;

      const willPlay = random() < prob;
      if (!willPlay) {
        // Streak breaks on a no-play day. Don't write a history row; only
        // touch the streak-current column and stamp the decision marker
        // so the next tick the same UTC day skips this ghost (the
        // ghost's "today's decision" is final, not re-rolled).
        db.prepare(
          `UPDATE ghost_users
              SET daily_streak_current = CASE WHEN daily_streak_current > 0 THEN 0 ELSE daily_streak_current END,
                  last_daily_decision_date = ?,
                  updated_at = ?
            WHERE id = ?`,
        ).run(today, updatedAt, g.id);
        skippedNoPlay += 1;
        continue;
      }

      // "Played": record a fake daily round, advance the streak.
      const score = pickScore(scoreSlice, random);
      const playedAt = syntheticPlayedAt(today, random, now);

      creditDailyHistoryRow(db, g.id, score, playedAt, gameMode);

      // Streak update with strict cap. If cap is 0 (no real user has any
      // streak), the streak never moves. The `min(cap, …)` clamp prevents
      // any ghost from sitting above the human leader. We only count a
      // ghost as "streakCapped" when the cap actually bit (i.e. the
      // ghost would otherwise have exceeded it) — not when cap=0 trivially
      // forces every ghost to 0, which would be misleading.
      const continuing = g.daily_streak_last_date === yesterday;
      const rawNewCurrent = continuing ? g.daily_streak_current + 1 : 1;
      const newCurrent = Math.min(cap, rawNewCurrent);
      const newBest = Math.min(cap, Math.max(g.daily_streak_best, newCurrent));
      const wasCapped = cap > 0 && rawNewCurrent > cap;

      db.prepare(
        `UPDATE ghost_users
            SET daily_streak_current = ?,
                daily_streak_best = ?,
                daily_streak_last_date = ?,
                last_daily_decision_date = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(newCurrent, newBest, today, today, updatedAt, g.id);

      played += 1;
      if (wasCapped) streakCapped += 1;
    }
  })();

  return {
    ghostsConsidered: ghosts.length,
    played,
    skippedNoPlay,
    streakCapped,
    cleanupZeroed,
  };
}

/**
 * Write a synthetic daily play row for a ghost.
 *
 * Mirrors `creditGhostScore` (atomic lifetime_score bump under the
 * percentile cap, ghost_game_history insert, last_played_at touch) but
 * also re-stamps `played_at` on the just-inserted row to a caller-
 * supplied synthetic timestamp so the simulator can distribute ghost
 * plays across the UTC day instead of a 00:00 spike.
 *
 * Wrapped in a transaction so the SELECT-MAX → creditGhostScore →
 * UPDATE sequence is atomic, eliminating the (already-narrow) race
 * window where a parallel writer could insert another row for the same
 * ghost between the SELECT and the UPDATE. The outer simulator loop
 * also runs inside a transaction; better-sqlite3 nests transactions as
 * SAVEPOINTs so this is correct.
 */
function creditDailyHistoryRow(
  db: DatabaseType,
  ghostUserId: string,
  score: number,
  playedAt: string,
  gameMode: string,
): void {
  db.transaction(() => {
    const before = db
      .prepare("SELECT MAX(id) AS lastId FROM ghost_game_history WHERE ghost_user_id = ?")
      .get(ghostUserId) as { lastId: number | null };

    creditGhostScore(db, ghostUserId, {
      addedScore: score,
      gameType: "single",
      gameMode,
    });

    // Re-stamp played_at on the row creditGhostScore just inserted.
    // Identifying it by max(id) is safe inside this transaction.
    db.prepare(
      `UPDATE ghost_game_history
          SET played_at = ?
        WHERE ghost_user_id = ?
          AND id > COALESCE(?, 0)`,
    ).run(playedAt, ghostUserId, before.lastId);
  })();
}
