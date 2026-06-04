/**
 * Read paths for the W/L/Streak tracker.
 *
 * Returns a {@link WinRecord} snapshot for either an authenticated user
 * (cached on `users`) or an anonymous visitor (cached on
 * `visitor_attribution`). Supports an optional per-mode breakdown that
 * aggregates `user_game_history.is_win` on demand — there's no
 * `user_mode_stats` table; per-mode stats are derived from history each
 * read because the cardinality is bounded (≤ ~10k games/user).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { WinRecord, GameMode } from "@price-game/shared";

/**
 * Per-mode W/L breakdown row used by the My Scores page and the profile
 * card "by mode" view. `winRate` is rounded to one decimal place; null
 * when the user has no counted games in the mode.
 */
export interface WinRecordByMode {
  gameMode: GameMode;
  wins: number;
  losses: number;
  /** wins / (wins + losses), null when no counted games. */
  winRate: number | null;
}

/**
 * Empty W/L snapshot (zeros across the board). Returned to brand-new
 * players and to anonymous visitors with no attribution row.
 */
export function emptyWinRecord(): WinRecord {
  return {
    wins: 0,
    losses: 0,
    currentStreak: 0,
    bestStreak: 0,
    totalGames: 0,
  };
}

/**
 * Fetch the cached W/L snapshot for an authenticated user.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @returns A {@link WinRecord} (zeros for users with no recorded games).
 */
export function getUserWinRecord(db: DatabaseType, userId: string): WinRecord {
  const row = db
    .prepare(
      `SELECT lifetime_wins   AS wins,
              lifetime_losses AS losses,
              current_streak  AS currentStreak,
              best_win_streak AS bestStreak,
              total_games     AS totalGames
         FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        wins: number;
        losses: number;
        currentStreak: number;
        bestStreak: number;
        totalGames: number;
      }
    | undefined;
  return row ?? emptyWinRecord();
}

/**
 * Fetch the cached W/L snapshot for an anonymous visitor. Returns zeros
 * when the visitor has never played a UTM-attributed game (no row).
 *
 * @param db - Database instance.
 * @param visitorId - The visitor cookie value.
 * @returns A {@link WinRecord}.
 */
export function getVisitorWinRecord(db: DatabaseType, visitorId: string): WinRecord {
  const row = db
    .prepare(
      `SELECT lifetime_wins   AS wins,
              lifetime_losses AS losses,
              current_streak  AS currentStreak,
              best_win_streak AS bestStreak,
              games_played    AS totalGames
         FROM visitor_attribution WHERE visitor_id = ?`,
    )
    .get(visitorId) as
    | {
        wins: number;
        losses: number;
        currentStreak: number;
        bestStreak: number;
        totalGames: number;
      }
    | undefined;
  return row ?? emptyWinRecord();
}

/**
 * Compute a per-mode W/L breakdown for a logged-in user. Aggregates
 * non-excluded `user_game_history` rows. Anonymous visitors don't have
 * per-mode breakdowns (no per-mode history table).
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @returns Array of per-mode rows (modes with no counted games are omitted).
 */
export function getUserWinRecordByMode(
  db: DatabaseType,
  userId: string,
): WinRecordByMode[] {
  const rows = db
    .prepare(
      `SELECT game_mode AS gameMode,
              SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses
         FROM user_game_history
        WHERE user_id = ? AND excluded_at IS NULL AND is_win IS NOT NULL
        GROUP BY game_mode
        ORDER BY game_mode`,
    )
    .all(userId) as { gameMode: GameMode; wins: number; losses: number }[];

  return rows.map((r) => {
    const total = r.wins + r.losses;
    return {
      gameMode: r.gameMode,
      wins: r.wins,
      losses: r.losses,
      winRate: total > 0 ? Math.round((r.wins / total) * 1000) / 10 : null,
    };
  });
}
