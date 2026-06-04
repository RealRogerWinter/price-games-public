/**
 * Streak tracking for the daily challenge mode.
 *
 * Implements the brutal Wordle rule: missing one day resets the streak to
 * zero. The streak's "best" value is preserved across resets so players
 * can see a record-to-beat instead of just losing their progress.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { DailyStreak } from "@price-game/shared";
import { addDays, getUtcDateString } from "@price-game/shared";

interface UserStreakRow {
  daily_streak_current: number;
  daily_streak_best: number;
  daily_streak_last_date: string | null;
}

/**
 * Get a user's streak snapshot. Returns zeros + null lastDate when the
 * user has never completed a daily (or doesn't exist — defensive default).
 *
 * The streak is only mutated on completion (`updateStreakOnCompletion`),
 * so the stored `daily_streak_current` goes stale as soon as the user
 * misses a day. This reader applies a time-based decay: if `lastDate` is
 * older than yesterday (UTC), `current` is reported as 0. `best` and
 * `lastDate` are always the stored values so callers can still render
 * "Best: N" and pick the correct day icon on the history strip.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param today - Optional UTC date string (YYYY-MM-DD) to evaluate the
 *   decay against. Defaults to the current UTC date. Exposed as a
 *   parameter so tests can freeze "today" without touching timers.
 * @returns The user's current streak state
 */
export function getStreakForUser(
  db: DatabaseType,
  userId: string,
  today: string = getUtcDateString(new Date()),
): DailyStreak {
  const row = db
    .prepare(
      "SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?"
    )
    .get(userId) as UserStreakRow | undefined;
  if (!row) return { current: 0, best: 0, lastDate: null };
  const lastDate = row.daily_streak_last_date;
  // A streak is "alive" only if the last completion was today or later
  // (defensive: lexicographic YYYY-MM-DD comparison also tolerates future
  // dates, which real users can't produce but test fixtures can) OR
  // exactly yesterday. Anything older means the user missed at least one
  // full UTC day, which per the brutal Wordle rule zeroes the current
  // streak. We leave the stored column alone — it will be overwritten on
  // the next completion via updateStreakOnCompletion.
  const isAlive = lastDate !== null && lastDate >= addDays(today, -1);
  return {
    current: isAlive ? row.daily_streak_current : 0,
    best: row.daily_streak_best,
    lastDate,
  };
}

/**
 * Apply a daily completion to a user's streak. Brutal Wordle rule:
 *
 *   - If `last_date` is null → start at 1 (isNewStreak = true)
 *   - If `last_date === dailyDate - 1` → increment (isNewStreak = true)
 *   - Otherwise → reset to 1 (isNewStreak = false; the streak is starting
 *     fresh, not continuing). The same-date case (defensive; should never
 *     happen because daily_plays has a unique index) also resets to 1.
 *
 * `best` is preserved on reset and only updates when `current` exceeds
 * the previous best.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param dailyDate - The completed daily's UTC date in YYYY-MM-DD
 * @returns The new streak state plus boolean flags for the result UI
 */
export function updateStreakOnCompletion(
  db: DatabaseType,
  userId: string,
  dailyDate: string,
): { current: number; best: number; isNewBest: boolean; isNewStreak: boolean } {
  const txn = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?"
      )
      .get(userId) as UserStreakRow | undefined;

    const oldBest = row?.daily_streak_best ?? 0;
    const lastDate = row?.daily_streak_last_date ?? null;

    let current: number;
    let isNewStreak: boolean;
    if (lastDate === null) {
      current = 1;
      isNewStreak = true;
    } else if (lastDate === addDays(dailyDate, -1)) {
      current = (row?.daily_streak_current ?? 0) + 1;
      isNewStreak = true;
    } else {
      // Either a missed day (gap >= 2) or same-date replay — treat as reset.
      current = 1;
      isNewStreak = false;
    }

    const best = Math.max(oldBest, current);
    const isNewBest = current > oldBest;

    db.prepare(
      `UPDATE users
         SET daily_streak_current = ?,
             daily_streak_best = ?,
             daily_streak_last_date = ?
       WHERE id = ?`
    ).run(current, best, dailyDate, userId);

    return { current, best, isNewBest, isNewStreak };
  });
  return txn();
}

/**
 * Zero out `daily_streak_current` for any user whose last completion is
 * older than yesterday (UTC). The reader (`getStreakForUser`) already
 * applies a time-based decay on read, but the stored column drives the
 * scheduler's `evaluateStreakReminders` query — and that query keys on
 * `daily_streak_current > 0`. Without this proactive sweep, a user who
 * stops playing keeps a stale `daily_streak_current` forever and
 * continues to receive "your streak is on the line" reminders for a
 * streak that has long since broken.
 *
 * Safe to run repeatedly; idempotent. Intended cadence is once per
 * scheduler tick (~60s) so the lag window between "streak breaks at
 * UTC midnight" and "scheduler stops scheduling reminders for it"
 * stays bounded.
 *
 * @param db - Database instance
 * @param today - Optional UTC date string (YYYY-MM-DD) to evaluate against.
 *   Defaults to the current UTC date. Exposed so tests can freeze the day.
 * @returns Number of user rows whose stored `daily_streak_current` was reset.
 */
export function decayStaleStreaks(
  db: DatabaseType,
  today: string = getUtcDateString(new Date()),
): number {
  // A streak breaks the moment the user misses a full UTC day, so any
  // stored last-date strictly before yesterday is by definition broken.
  const yesterday = addDays(today, -1);
  const result = db
    .prepare(
      `UPDATE users
         SET daily_streak_current = 0
       WHERE daily_streak_current > 0
         AND (daily_streak_last_date IS NULL OR daily_streak_last_date < ?)`
    )
    .run(yesterday);
  return result.changes;
}
