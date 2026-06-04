/**
 * Win/Loss/Streak cache writer.
 *
 * Updates the cached counters (`lifetime_wins`, `lifetime_losses`,
 * `current_streak`, `best_win_streak`) on either a `users` row or a
 * `visitor_attribution` row. The signed-streak math lives in
 * `nextStreak` (shared package) so the same logic drives unit tests,
 * the server cache update, and any future backfill scripts.
 *
 * MUST be called inside an active `db.transaction(...)` so the cache
 * update is atomic with the matching `user_game_history` insert (and
 * the matching `visitor_attribution.games_played` bump).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  nextStreak,
  computeIsWin,
  type IsWin,
  type GameMode,
} from "@price-game/shared";

/**
 * Classify a single-player game's outcome by reading `total_rounds` from
 * the session row. Pure helper for callers that need the W/L bit without
 * going through `recordSinglePlayerGame` (e.g. the anonymous-visitor path).
 *
 * @param db - Active database connection.
 * @param sessionId - The completed session id.
 * @param gameMode - Game mode for max-score derivation.
 * @param score - Final score.
 * @param isBotPlayer - True for bot/streamer-bot rows.
 * @returns Win / loss / skip.
 */
export function classifySinglePlayerOutcome(
  db: DatabaseType,
  sessionId: string,
  gameMode: GameMode,
  score: number,
  isBotPlayer: boolean,
): IsWin {
  const sessionRow = db
    .prepare("SELECT total_rounds FROM game_sessions WHERE id = ?")
    .get(sessionId) as { total_rounds: number | null } | undefined;
  return computeIsWin({
    gameType: "single",
    gameMode,
    score,
    totalRounds: sessionRow?.total_rounds ?? 0,
    placement: null,
    playersCount: null,
    isBotPlayer,
  });
}

interface CacheRow {
  lifetime_wins: number;
  lifetime_losses: number;
  current_streak: number;
  best_win_streak: number;
}

/**
 * Apply a single game's win/loss outcome to the cached counters on a
 * `users` row. No-op when `outcome` is `null` (skip — disconnect, solo
 * MP, bot, etc.) or when the user row no longer exists.
 *
 * @param db - Active database connection (call inside a transaction).
 * @param userId - Target `users.id`.
 * @param outcome - Win / loss / skip from `computeIsWin`.
 */
export function applyUserWinUpdate(
  db: DatabaseType,
  userId: string,
  outcome: IsWin,
): void {
  if (outcome === null) return;
  const row = db
    .prepare(
      "SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM users WHERE id = ?",
    )
    .get(userId) as CacheRow | undefined;
  if (!row) return;
  const next = computeNextCache(row, outcome);
  db.prepare(
    `UPDATE users
        SET lifetime_wins   = ?,
            lifetime_losses = ?,
            current_streak  = ?,
            best_win_streak = ?
      WHERE id = ?`,
  ).run(
    next.lifetime_wins,
    next.lifetime_losses,
    next.current_streak,
    next.best_win_streak,
    userId,
  );
}

/**
 * Apply a single game's win/loss outcome to the cached counters on a
 * `visitor_attribution` row. No-op when `outcome` is `null` or the
 * visitor row doesn't exist (some anon paths only create the row on
 * first UTM-bearing visit).
 *
 * @param db - Active database connection (call inside a transaction).
 * @param visitorId - Target `visitor_attribution.visitor_id`.
 * @param outcome - Win / loss / skip from `computeIsWin`.
 */
export function applyVisitorWinUpdate(
  db: DatabaseType,
  visitorId: string,
  outcome: IsWin,
): void {
  if (outcome === null) return;
  const row = db
    .prepare(
      "SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM visitor_attribution WHERE visitor_id = ?",
    )
    .get(visitorId) as CacheRow | undefined;
  if (!row) return;
  const next = computeNextCache(row, outcome);
  db.prepare(
    `UPDATE visitor_attribution
        SET lifetime_wins   = ?,
            lifetime_losses = ?,
            current_streak  = ?,
            best_win_streak = ?
      WHERE visitor_id = ?`,
  ).run(
    next.lifetime_wins,
    next.lifetime_losses,
    next.current_streak,
    next.best_win_streak,
    visitorId,
  );
}

/**
 * Apply a W/L outcome to a `visitor_attribution` row, creating the row
 * with `utm_source = 'direct'` if it does not yet exist. Unlike
 * `recordVisitorGamePlay`, this helper does NOT touch the cohort
 * attribution columns (`first_game_at`, `first_game_type`,
 * `first_game_mode`, `games_played`) — only the W/L cache and signed
 * streak. Use it from paths that should bump the W/L counters but stay
 * out of UTM-cohort accounting (currently: streamer-bot game completions,
 * which should drive the HUD chip without contaminating the funnel).
 *
 * @param db - Active database connection.
 * @param visitorId - Target `visitor_attribution.visitor_id`. Empty/null
 *                    visitorIds are no-ops.
 * @param outcome - Win / loss / skip from `computeIsWin`. Null is a
 *                  no-op (no row created either — there is no point in
 *                  inserting a placeholder for a skipped outcome).
 */
export function applyVisitorWinUpdateEnsureRow(
  db: DatabaseType,
  visitorId: string | null | undefined,
  outcome: IsWin,
): void {
  if (outcome === null) return;
  if (!visitorId) return;
  // INSERT-OR-IGNORE so we don't overwrite an existing UTM-tagged row's
  // utm_source. 'direct' matches the sentinel `recordVisitorGamePlay`
  // uses for organic visitors with no tracked referrer.
  db.prepare(
    `INSERT INTO visitor_attribution (visitor_id, utm_source, first_seen_at)
     VALUES (?, 'direct', ?)
     ON CONFLICT(visitor_id) DO NOTHING`,
  ).run(visitorId, new Date().toISOString());
  applyVisitorWinUpdate(db, visitorId, outcome);
}

function computeNextCache(prev: CacheRow, outcome: true | false): CacheRow {
  const newStreak = nextStreak(prev.current_streak, outcome);
  return {
    lifetime_wins: prev.lifetime_wins + (outcome ? 1 : 0),
    lifetime_losses: prev.lifetime_losses + (outcome ? 0 : 1),
    current_streak: newStreak,
    best_win_streak: Math.max(prev.best_win_streak, newStreak),
  };
}

// Note: admin exclude/restore inlines the same compensating-decrement
// SQL in `services/adminLeaderboard.ts` so the read of the stored
// `is_win` happens in the same SELECT that already pulls `score` and
// `excluded_at`. A separate helper would force a redundant read.
