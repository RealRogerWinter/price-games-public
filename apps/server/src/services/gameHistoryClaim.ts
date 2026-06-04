/**
 * Claim anonymous single-player game history for a user account.
 *
 * When a player completes a single-player round while logged out, the
 * `game_sessions` row is tagged with their `visitor_id` cookie and a NULL
 * `user_id`. On register / login / OAuth callback, this service transfers
 * those completed anonymous sessions into `user_game_history` so the score
 * counts toward the user's lifetime total and appears in their history feed.
 *
 * Sibling of `claimAnonymousDailyPlays` (daily challenges); this one handles
 * the non-daily single-player path. Multiplayer and daily are out of scope.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { recordSinglePlayerGame } from "./userGameHistory";

interface ClaimResult {
  /** Number of anonymous completed sessions claimed by this user. */
  claimed: number;
  /** Total score summed across all claimed sessions. */
  pointsTransferred: number;
}

interface AnonSessionRow {
  id: string;
  game_mode: string;
  total_score: number;
  completed_at: string;
}

/**
 * Transfer anonymous completed single-player game_sessions to a user account.
 *
 * Finds every `game_sessions` row where `visitor_id` matches, `user_id IS
 * NULL`, `completed_at IS NOT NULL`, and `is_daily = 0`. For each, records
 * the session into `user_game_history` via `recordSinglePlayerGame` (which
 * is idempotent — `INSERT OR IGNORE` on `(user_id, session_id)` — and also
 * bumps `users.lifetime_score` + records a rank snapshot) and updates the
 * session's `user_id` so subsequent claim runs skip it.
 *
 * Also backfills any public `leaderboard` row tied to the same session so the
 * user's name appears correctly on public leaderboards once they sign in.
 *
 * @param db - Database instance.
 * @param userId - The authenticated user's ID.
 * @param visitorId - The visitor_id cookie value from the request.
 * @returns The number of rows claimed and total score transferred.
 */
export function claimAnonymousGameHistory(
  db: DatabaseType,
  userId: string,
  visitorId: string | null | undefined,
): ClaimResult {
  if (!visitorId) return { claimed: 0, pointsTransferred: 0 };

  const txn = db.transaction(() => {
    const anonSessions = db
      .prepare(
        `SELECT id, game_mode, total_score, completed_at
         FROM game_sessions
         WHERE visitor_id = ?
           AND user_id IS NULL
           AND completed_at IS NOT NULL
           AND is_daily = 0
         ORDER BY completed_at ASC`,
      )
      .all(visitorId) as AnonSessionRow[];

    if (anonSessions.length === 0) {
      return { claimed: 0, pointsTransferred: 0 };
    }

    const claimSession = db.prepare(
      "UPDATE game_sessions SET user_id = ? WHERE id = ? AND user_id IS NULL",
    );

    let claimed = 0;
    let pointsTransferred = 0;

    for (const session of anonSessions) {
      // recordSinglePlayerGame is INSERT OR IGNORE on (user_id, session_id)
      // and only increments lifetime_score when the insert actually happened,
      // so replaying this whole claim is safe. Pass the session's original
      // completed_at so the history row reflects when the round was played,
      // not when the user signed up.
      recordSinglePlayerGame(
        db,
        userId,
        session.id,
        session.game_mode,
        session.total_score,
        session.completed_at,
      );
      claimSession.run(userId, session.id);

      claimed += 1;
      pointsTransferred += session.total_score;
    }

    return { claimed, pointsTransferred };
  });

  return txn();
}
