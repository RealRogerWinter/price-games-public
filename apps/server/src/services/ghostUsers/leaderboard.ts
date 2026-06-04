/**
 * Ghost-side leaderboard helpers.
 *
 * The public leaderboard reads in `services/publicProfile.ts` query
 * `users` for the canonical lifetime / streak boards. When the admin
 * toggles `showOnLeaderboard = true`, those reads also need to surface
 * ghost rows. This module provides the small primitives that
 * `publicProfile.ts` calls into so the SQL stays in one place per
 * concept.
 *
 * The boards we extend are deliberately limited:
 *   - **Lifetime "all"** — uses `users.lifetime_score`. Ghosts have a
 *     parallel `ghost_users.lifetime_score`; UNION ALL.
 *   - **Streak (longest-best)** — uses `users.daily_streak_*`. Ghosts
 *     have parallel synthetic fields; UNION ALL.
 *
 * Period boards (day/week/month) and SP/MP slices read
 * `user_game_history` with time/type filters. Ghosts have
 * `ghost_game_history` with the same shape, but extending those would
 * require teaching every aggregation site about a second history table.
 * That's deferred — period boards are intentionally real-users-only so
 * "current activity" still reflects real engagement.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { Avatar } from "@price-game/shared";
import { getGhostSettings } from "./settings";

/**
 * Whether ghosts should currently appear on public leaderboards. True
 * only when the master toggle is on, the kill-switch is off, AND the
 * admin has explicitly opted ghosts in via `showOnLeaderboard`.
 */
export function ghostsVisibleOnLeaderboard(db: DatabaseType): boolean {
  const s = getGhostSettings(db);
  return s.enabled && s.showOnLeaderboard && !s.killSwitch;
}

/** A ghost lifetime-leaderboard entry. */
export interface GhostLifetimeEntry {
  username: string;
  avatar: Avatar | null;
  lifetimeScore: number;
}

/**
 * Read active ghosts with lifetime_score > 0 ordered descending by
 * score. Used by `getLifetimeLeaderboard` to UNION ALL ghost rows
 * alongside real users when `showOnLeaderboard` is on.
 *
 * @param db - Database instance.
 * @param limit - Max rows to return (positive integer).
 */
export function getGhostLifetimeEntries(
  db: DatabaseType,
  limit: number,
): GhostLifetimeEntry[] {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  const rows = db
    .prepare(
      `SELECT username, avatar, lifetime_score AS lifetimeScore
         FROM ghost_users
        WHERE is_active = 1 AND lifetime_score > 0
        ORDER BY lifetime_score DESC, username ASC
        LIMIT ?`,
    )
    .all(cap) as { username: string; avatar: string | null; lifetimeScore: number }[];

  return rows.map((r) => ({
    username: r.username,
    avatar: (r.avatar as Avatar | null) ?? null,
    lifetimeScore: r.lifetimeScore,
  }));
}

/** A ghost streak-leaderboard entry. */
export interface GhostStreakEntry {
  username: string;
  avatar: Avatar | null;
  bestStreak: number;
  currentStreak: number;
}

/**
 * Read active ghosts with `daily_streak_best > 0` ordered by best then
 * current. Used by `getLongestStreakLeaderboard` to UNION ALL the streak
 * board across both real users and ghosts.
 */
export function getGhostStreakEntries(
  db: DatabaseType,
  limit: number,
): GhostStreakEntry[] {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  // `last_played_at IS NOT NULL` is the canonical "ghost has played at
  // least one game" predicate (set by creditGhostScore on every credited
  // round). Excluding never-played ghosts here is a defense-in-depth
  // backstop against stale daily_streak_best values that may have been
  // written by the pre-fix synthetic streak advancement.
  const rows = db
    .prepare(
      `SELECT username, avatar,
              daily_streak_best    AS bestStreak,
              daily_streak_current AS currentStreak
         FROM ghost_users
        WHERE is_active = 1 AND daily_streak_best > 0
          AND last_played_at IS NOT NULL
        ORDER BY daily_streak_best DESC, daily_streak_current DESC, username ASC
        LIMIT ?`,
    )
    .all(cap) as {
      username: string;
      avatar: string | null;
      bestStreak: number;
      currentStreak: number;
    }[];

  return rows.map((r) => ({
    username: r.username,
    avatar: (r.avatar as Avatar | null) ?? null,
    bestStreak: r.bestStreak,
    currentStreak: r.currentStreak,
  }));
}

/**
 * Count active ghosts with lifetime_score > 0. Used by
 * `getLeaderboardAvailability` to add ghost contributors to the "all"
 * pill count when ghosts are visible.
 */
export function countGhostScorers(db: DatabaseType): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM ghost_users WHERE is_active = 1 AND lifetime_score > 0",
    )
    .get() as { n: number };
  return row.n;
}
