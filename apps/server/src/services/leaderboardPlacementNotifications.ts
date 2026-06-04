/**
 * Leaderboard placement notifications.
 *
 * Detects when a logged-in user has landed in the top 3 of a daily / weekly /
 * monthly leaderboard and fires a push + optionally an email to them. Used by
 * both the notification scheduler (push path) and the email scheduler (email
 * path), behind separate per-user preference toggles.
 *
 * Dedupe strategy: one row per (user, period, period_key[:channel]) in
 * `leaderboard_placement_notifications`. A subsequent tick only re-notifies a
 * user if their current rank is strictly better than the already-notified
 * best_rank for the current bucket. A user who enters the board at #3 gets
 * one notification; if they climb to #1 they get a second; a drop from #1
 * back to #3 is silent. Push and email channels use different bucket keys so
 * each fires independently.
 *
 * Period-key / cutoff alignment: the SQL cutoff passed to `datetime('now',
 * ...)` matches the bucket key. Day uses UTC start-of-day, month uses UTC
 * start-of-month, week uses UTC Monday (ISO week start). Without this
 * alignment, a rolling-24h cutoff combined with a calendar-day bucket would
 * double-notify at UTC midnight (same scores still in the rolling window,
 * but the bucket key has flipped).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { Server } from "socket.io";
import { scheduleEmail, getTriggerConfig } from "./emailNotification";
import { sendPushToUser, type PushPayload } from "./pushNotification";
import { getSendOptionsForType } from "./notificationScheduler";
import { pickSendTimeForUser } from "./emailScheduler";

/** Which leaderboard period a notification is for. */
export type LeaderboardPlacementPeriod = "day" | "week" | "month";

const TOP_N = 3;

interface TopRow {
  user_id: string;
  username: string;
  score: number;
  rank: number;
}

interface TrackingRow {
  best_rank: number;
}

/**
 * Return a string identifier for the current period bucket. Shapes:
 *   day   → `YYYY-MM-DD`            (UTC calendar day)
 *   week  → `YYYY-Www`              (ISO-8601 week)
 *   month → `YYYY-MM`               (UTC calendar month)
 *
 * @param period - Leaderboard window.
 * @param now - Reference "now" in UTC. Defaults to `new Date()`.
 * @returns Stable bucket key for the given period.
 */
export function getPeriodKey(
  period: LeaderboardPlacementPeriod,
  now: Date = new Date(),
): string {
  if (period === "day") {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (period === "month") {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
  // ISO week: Thursday-anchored per ISO-8601. Copy first so we don't mutate
  // the caller's Date.
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / 86400000
      - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Return the UTC-aligned cutoff for the start of the current period, as an
 * ISO-ish string suitable for `datetime('now') >= ?` comparisons against
 * `user_game_history.played_at` (which is stored via SQLite's
 * `datetime('now')`, i.e. space-separated `YYYY-MM-DD HH:MM:SS`).
 *
 * Aligning the cutoff with the period bucket prevents double-notifications
 * at period rollover — see the file docstring for the full argument.
 *
 * @param period - Leaderboard window.
 * @param now - Reference "now" in UTC. Defaults to `new Date()`.
 * @returns Bucket-start datetime string (UTC).
 */
export function getPeriodCutoff(
  period: LeaderboardPlacementPeriod,
  now: Date = new Date(),
): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (period === "day") {
    return toSqliteDatetime(new Date(Date.UTC(y, m, d, 0, 0, 0)));
  }
  if (period === "month") {
    return toSqliteDatetime(new Date(Date.UTC(y, m, 1, 0, 0, 0)));
  }
  // ISO week — Monday at 00:00 UTC of the current ISO week.
  const dayOfWeek = new Date(Date.UTC(y, m, d)).getUTCDay(); // Sun=0..Sat=6
  const daysBackToMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(Date.UTC(y, m, d - daysBackToMonday, 0, 0, 0));
  return toSqliteDatetime(monday);
}

function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function periodLabel(period: LeaderboardPlacementPeriod): string {
  switch (period) {
    case "day": return "daily";
    case "week": return "weekly";
    case "month": return "monthly";
  }
}

/**
 * Query the current top-N users for a leaderboard period, bundling user_id
 * so we can look up preferences and subscriptions.
 *
 * @param db - Database instance.
 * @param period - Leaderboard window.
 * @param now - Reference "now" in UTC (exposed for tests).
 * @returns Up to TOP_N rows ordered rank 1..N.
 */
export function getTopUsersForPeriod(
  db: DatabaseType,
  period: LeaderboardPlacementPeriod,
  now: Date = new Date(),
): TopRow[] {
  const cutoff = getPeriodCutoff(period, now);
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.username,
              COALESCE(SUM(ugh.score), 0) AS score
         FROM users u
         JOIN user_game_history ugh
           ON ugh.user_id = u.id
          AND ugh.played_at >= ?
        WHERE u.is_active = 1
          AND u.email IS NOT NULL
        GROUP BY u.id
        HAVING score > 0
        ORDER BY score DESC, u.username ASC
        LIMIT ?`,
    )
    .all(cutoff, TOP_N) as Array<{
      user_id: string;
      username: string;
      score: number;
    }>;

  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Atomically decide whether this user should be notified for this bucket
 * and, if yes, record the notification. Wraps the read+write in a
 * better-sqlite3 transaction (`BEGIN IMMEDIATE` via `.immediate()` on the
 * caller's side is unnecessary because scheduler guards prevent same-
 * process concurrency, but the transaction still keeps the two statements
 * atomic against external writers).
 *
 * @param db - Database instance.
 * @param userId - Target user.
 * @param period - Leaderboard window.
 * @param periodKey - Bucket key (may include a `:channel` suffix).
 * @param rank - Current rank (1..N).
 * @returns true if we should send a fresh notification now.
 */
export function claimLeaderboardPlacementSlot(
  db: DatabaseType,
  userId: string,
  period: LeaderboardPlacementPeriod,
  periodKey: string,
  rank: number,
): boolean {
  const txn = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT best_rank FROM leaderboard_placement_notifications
           WHERE user_id = ? AND period = ? AND period_key = ?`,
      )
      .get(userId, period, periodKey) as TrackingRow | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO leaderboard_placement_notifications
           (user_id, period, period_key, best_rank, last_notified_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(userId, period, periodKey, rank);
      return true;
    }

    // Strictly better rank (lower number) = climbed up → notify again.
    if (rank < existing.best_rank) {
      db.prepare(
        `UPDATE leaderboard_placement_notifications
            SET best_rank = ?, last_notified_at = datetime('now')
          WHERE user_id = ? AND period = ? AND period_key = ?`,
      ).run(rank, userId, period, periodKey);
      return true;
    }

    return false;
  });
  return txn();
}

/**
 * Release a previously-claimed slot if the downstream send returned 0
 * (e.g. no active push subscriptions). Used to prevent a failed attempt
 * from suppressing future retries in the same bucket. Only touches rows
 * that still match the claim we wrote — never downgrades a row already
 * improved by another tick.
 */
function releaseLeaderboardPlacementSlot(
  db: DatabaseType,
  userId: string,
  period: LeaderboardPlacementPeriod,
  periodKey: string,
  rank: number,
): void {
  db.prepare(
    `DELETE FROM leaderboard_placement_notifications
       WHERE user_id = ? AND period = ? AND period_key = ? AND best_rank = ?`,
  ).run(userId, period, periodKey, rank);
}

function pushPayloadFor(rank: number, period: LeaderboardPlacementPeriod): PushPayload {
  const label = periodLabel(period);
  return {
    title:
      rank === 1
        ? `You're #1 on the ${label} leaderboard! 🏆`
        : `You're in the ${label} top ${rank}!`,
    body:
      rank === 1
        ? `Congrats — you're at the top of the ${label} board. Keep playing to defend your spot.`
        : `Nice — you're top ${rank} on the ${label} board. Climb higher before the period ends!`,
    icon: "/logo192.png",
    badge: "/badge-96.png",
    url: "/leaderboard",
    tag: `leaderboard-${period}`,
  };
}

/**
 * Evaluate top-3 placements and send PUSH notifications. Wired into the
 * notification scheduler tick. Email sends are handled by
 * {@link evaluateLeaderboardPlacementEmails} in the email scheduler.
 *
 * @param db - Database instance.
 * @param io - Optional Socket.IO server for real-time toasts.
 * @returns Count of users for whom at least one push was delivered.
 */
export async function evaluateLeaderboardPlacementPushes(
  db: DatabaseType,
  io?: Server,
): Promise<number> {
  const periods: LeaderboardPlacementPeriod[] = ["day", "week", "month"];
  let sent = 0;

  for (const period of periods) {
    const top = getTopUsersForPeriod(db, period);
    const periodKey = getPeriodKey(period);

    for (const row of top) {
      // Cheap prefs gate before the slot write so we don't insert a
      // tracking row for users who have the toggle off.
      const optedIn = db
        .prepare(
          `SELECT 1 FROM notification_preferences np
             JOIN push_subscriptions ps ON ps.user_id = np.user_id
            WHERE np.user_id = ?
              AND np.push_enabled = 1
              AND np.leaderboard_placement = 1
              AND ps.is_active = 1
            LIMIT 1`,
        )
        .get(row.user_id) as { 1: number } | undefined;
      if (!optedIn) continue;

      if (!claimLeaderboardPlacementSlot(db, row.user_id, period, periodKey, row.rank)) {
        continue;
      }

      const payload = pushPayloadFor(row.rank, period);
      const sendOptions = getSendOptionsForType("leaderboard_placement", row.user_id);
      const count = await sendPushToUser(
        db,
        row.user_id,
        "leaderboard_placement",
        payload,
        sendOptions,
        io,
      );
      if (count > 0) {
        sent++;
      } else {
        // Nothing delivered (e.g. quiet hours or all subs expired between
        // the prefs check and the actual send). Release the slot so a
        // future tick can retry.
        releaseLeaderboardPlacementSlot(db, row.user_id, period, periodKey, row.rank);
      }
    }
  }

  return sent;
}

/**
 * Evaluate top-3 placements and queue EMAIL notifications. Uses a separate
 * dedupe key (`${periodKey}:email`) from the push path so enabling only one
 * channel works as expected.
 *
 * @param db - Database instance.
 * @returns Count of emails queued.
 */
export function evaluateLeaderboardPlacementEmails(db: DatabaseType): number {
  const trigger = getTriggerConfig(db, "leaderboard_placement");
  // Trust the trigger config exclusively. If an admin renames the template
  // they must also point `email_trigger_config.template_id` at the new row;
  // the migration seeded both, so the default install needs no fallback.
  if (!trigger || !trigger.isEnabled || !trigger.templateId) return 0;
  const templateId = trigger.templateId;

  const periods: LeaderboardPlacementPeriod[] = ["day", "week", "month"];
  let queued = 0;

  for (const period of periods) {
    const top = getTopUsersForPeriod(db, period);
    const periodKey = getPeriodKey(period);

    for (const row of top) {
      const optedIn = db
        .prepare(
          `SELECT u.id, u.username, u.email, p.preferred_hour, p.timezone
             FROM users u
             JOIN email_preferences p ON p.user_id = u.id
            WHERE u.id = ?
              AND u.is_active = 1
              AND u.email IS NOT NULL
              AND p.email_enabled = 1
              AND p.leaderboard_placement = 1
            LIMIT 1`,
        )
        .get(row.user_id) as
          | {
              id: string;
              username: string;
              email: string;
              preferred_hour: number;
              timezone: string;
            }
          | undefined;
      if (!optedIn) continue;

      const emailKey = `${periodKey}:email`;
      if (!claimLeaderboardPlacementSlot(db, row.user_id, period, emailKey, row.rank)) {
        continue;
      }

      const scheduledAt = pickSendTimeForUser(
        optedIn.preferred_hour,
        optedIn.timezone,
      );
      scheduleEmail(
        db,
        row.user_id,
        "leaderboard_placement",
        {
          username: optedIn.username,
          rank: row.rank,
          periodLabel: periodLabel(period),
        },
        scheduledAt,
        templateId,
      );
      queued++;
    }
  }

  return queued;
}
