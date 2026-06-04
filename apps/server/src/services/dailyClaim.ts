/**
 * Claim anonymous daily challenge plays for a user account.
 *
 * When a player completes daily challenges while logged out, their plays are
 * tracked by `visitor_id` (browser cookie) with `user_id = NULL`. On
 * registration or login, this service transfers those anonymous plays to the
 * authenticated user — and bootstraps their streak from the most recent
 * completed play so the transition feels seamless.
 *
 * Mirrors the existing `mergeVisitorAttributionIntoUser` pattern used by
 * the registration flow for UTM attribution.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { getStreakForUser, updateStreakOnCompletion } from "./dailyStreak";

interface ClaimResult {
  /** Number of anonymous daily_plays rows claimed by this user. */
  claimed: number;
}

interface AnonPlayRow {
  id: number;
  daily_date: string;
  completed_at: string | null;
}

/**
 * Transfer anonymous daily_plays rows to a user account.
 *
 * Finds all `daily_plays` rows where `visitor_id` matches and `user_id IS
 * NULL`, then sets `user_id` on each — skipping any date where the user
 * already has a play (to avoid a unique-constraint violation on
 * `idx_daily_plays_user_date`).
 *
 * After claiming, bootstraps the user's streak by replaying each
 * completed claimed play in chronological order via
 * `updateStreakOnCompletion`. Skips streak updates entirely when the
 * user already has a streak whose `lastDate` is more recent than any
 * claimed play — avoids silently resetting a returning user's streak.
 *
 * @param db - Database instance.
 * @param userId - The authenticated user's ID.
 * @param visitorId - The visitor_id cookie value from the request.
 * @returns The number of rows claimed.
 */
export function claimAnonymousDailyPlays(
  db: DatabaseType,
  userId: string,
  visitorId: string | null | undefined,
): ClaimResult {
  if (!visitorId) return { claimed: 0 };

  const txn = db.transaction(() => {
    // 1. Find all anonymous plays for this visitor
    const anonPlays = db
      .prepare(
        `SELECT id, daily_date, completed_at
         FROM daily_plays
         WHERE visitor_id = ? AND user_id IS NULL
         ORDER BY daily_date ASC`,
      )
      .all(visitorId) as AnonPlayRow[];

    if (anonPlays.length === 0) return { claimed: 0 };

    // 2. Find dates where the user already has a play (to skip conflicts)
    const userDates = new Set(
      (
        db
          .prepare(
            "SELECT daily_date FROM daily_plays WHERE user_id = ?",
          )
          .all(userId) as { daily_date: string }[]
      ).map((r) => r.daily_date),
    );

    // 3. Claim non-conflicting rows and collect completed dates for streak
    const updateStmt = db.prepare(
      "UPDATE daily_plays SET user_id = ? WHERE id = ?",
    );
    let claimed = 0;
    const completedDates: string[] = [];

    for (const play of anonPlays) {
      if (userDates.has(play.daily_date)) continue;

      updateStmt.run(userId, play.id);
      claimed++;

      if (play.completed_at) {
        completedDates.push(play.daily_date);
      }
    }

    // 4. Bootstrap streak by replaying completed claimed plays in order.
    // Guard: skip if the user already has a streak whose lastDate is at
    // or after the most recent claimed play — calling updateStreakOnCompletion
    // with a historical date would reset a returning user's active streak.
    if (completedDates.length > 0) {
      const existingStreak = getStreakForUser(db, userId);
      const mostRecentClaimed = completedDates[completedDates.length - 1];

      if (!existingStreak.lastDate || mostRecentClaimed > existingStreak.lastDate) {
        // Replay each completed date in chronological order so that
        // consecutive days build up the streak correctly (e.g., 3
        // consecutive anonymous days → streak of 3, not 1).
        for (const date of completedDates) {
          if (!existingStreak.lastDate || date > existingStreak.lastDate) {
            updateStreakOnCompletion(db, userId, date);
          }
        }
      }
    }

    return { claimed };
  });

  return txn();
}
