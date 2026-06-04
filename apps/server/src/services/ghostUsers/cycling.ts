/**
 * Ghost-user lifecycle: cycle out long-inactive ghosts so the roster
 * mimics real-user churn.
 *
 * Real users go inactive after a while — they signed up, played a few
 * games, drifted away. A static ghost cohort that always plays at the
 * same rate forever is statistically detectable. This module retires
 * ghosts that have been inactive past a threshold (analogous to the
 * implicit "user hasn't logged in in 30 days" signal that would mark a
 * real user as cold).
 *
 * Retirement is non-destructive: `is_active` flips to 0. The row stays
 * in the DB so historical mp_leaderboard / ghost_game_history rows still
 * reference a valid id; admin can resurrect or hard-delete as needed.
 *
 * Replacement is the admin's job (or PR-B's auto-top-up logic): once
 * the active ghost count drops below `targetCount`, the bulk-create
 * helper can fill back in.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** A ghost is "inactive" once they haven't played for this long. */
export const INACTIVE_THRESHOLD_DAYS = 30;

/** Defense against churning out brand-new ghosts before they've had a
 *  chance to play. Only retire ghosts whose synthetic account is at
 *  least this old. */
export const MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS = 90;

/**
 * Flip `is_active = 0` on every ghost that has been inactive longer than
 * {@link INACTIVE_THRESHOLD_DAYS} AND has a synthetic account age
 * older than {@link MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS}.
 *
 * `last_played_at IS NULL` (ghost never accrued a round) is treated as
 * "never played" — those ghosts retire purely on account-age, so a
 * never-played ghost can't sit on the roster forever.
 *
 * @param db - Database instance.
 * @returns Number of ghosts retired this call.
 */
export function retireInactiveGhosts(db: DatabaseType): number {
  const now = Date.now();
  const inactiveBefore = new Date(now - INACTIVE_THRESHOLD_DAYS * 24 * 3600 * 1000).toISOString();
  const minAccountAge = new Date(now - MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS * 24 * 3600 * 1000).toISOString();
  const updatedAt = new Date(now).toISOString();

  const res = db
    .prepare(
      `UPDATE ghost_users
          SET is_active = 0, updated_at = ?
        WHERE is_active = 1
          AND account_created_at < ?
          AND (
            last_played_at IS NULL
            OR last_played_at < ?
          )`,
    )
    .run(updatedAt, minAccountAge, inactiveBefore);

  return res.changes;
}

/**
 * How many active ghosts currently sit in the roster. Used by the
 * cycling/auto-top-up logic to decide whether to bulk-create more
 * after a retirement sweep.
 */
export function countActiveGhosts(db: DatabaseType): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ghost_users WHERE is_active = 1")
    .get() as { n: number };
  return row.n;
}
