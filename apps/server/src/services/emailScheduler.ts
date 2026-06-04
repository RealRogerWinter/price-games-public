/**
 * Email scheduler — background processor for the marketing / re-engagement
 * email channel.
 *
 * This is parallel to `notificationScheduler.ts`, but runs on a
 * deliberately coarser interval (default 15 min vs push's 60 s). Email
 * triggers are time-of-day aware and rate-limited per user, so there is
 * nothing useful to do between ticks and higher frequency would just
 * burn cycles.
 *
 * Triggers evaluated on each tick:
 *  1. Drain scheduled_emails (delayed sends enqueued by other evaluators
 *     or admin-scheduled broadcasts).
 *  2. streak_risk — users who had a streak but missed yesterday and
 *     haven't played today either.
 *  3. inactivity_reminder — users whose last activity falls in an
 *     admin-configured band (7 / 14 / 30 days by default).
 *  4. weekly_digest — once per week, at the configured weekday+hour.
 *  5. Random 10%-of-ticks cleanup pass for old log and scheduled rows.
 *
 * Each evaluator checks `email_log` for a recent matching row before
 * enqueueing, so the pipeline is idempotent even if the tick fires twice
 * or the server restarts mid-tick.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { EmailNotificationType } from "@price-game/shared";
import {
  scheduleEmail,
  processScheduledEmails,
  getTriggerConfig,
  listTriggerConfigs,
} from "./emailNotification";
import { evaluateLeaderboardPlacementEmails } from "./leaderboardPlacementNotifications";
import { config } from "../config";

// ── Trigger evaluators ──────────────────────────────────────────────────────

interface StreakRiskUserRow {
  id: string;
  username: string;
  daily_streak_current: number;
  daily_streak_last_date: string | null;
  preferred_hour: number;
  timezone: string;
}

/**
 * Queue `streak_risk` emails for users whose streak is at risk today.
 *
 * Criteria:
 *  - `users.daily_streak_current >= threshold.streakMin` (default 3).
 *  - `daily_streak_last_date` equals yesterday (user missed today).
 *  - master + `streak_risk` prefs both enabled.
 *  - trigger is enabled in `email_trigger_config` and has a template.
 *  - no email of this type sent within `cooldown_hours`.
 *  - no pending scheduled_emails row of this type already.
 *
 * Each matching user gets a row in `scheduled_emails` targeted at their
 * `preferred_hour` today (or now, whichever is later).
 *
 * @param db - Database instance.
 * @returns Number of users for whom an email was enqueued.
 */
export function evaluateStreakRiskEmails(db: DatabaseType): number {
  const trigger = getTriggerConfig(db, "streak_risk");
  if (!trigger || !trigger.isEnabled || !trigger.templateId) return 0;

  const threshold = safeParseThreshold(trigger.thresholdJson);
  const streakMin = typeof threshold.streakMin === "number" ? threshold.streakMin : 3;

  const users = db
    .prepare(
      `SELECT u.id, u.username,
              u.daily_streak_current, u.daily_streak_last_date,
              p.preferred_hour, p.timezone
         FROM users u
         JOIN email_preferences p ON p.user_id = u.id
        WHERE u.is_active = 1
          AND u.email IS NOT NULL
          AND u.daily_streak_current >= ?
          AND u.daily_streak_last_date = date('now','-1 day')
          AND p.email_enabled = 1
          AND p.streak_risk = 1
          AND NOT EXISTS (
            SELECT 1 FROM email_log el
             WHERE el.user_id = u.id
               AND el.type = 'streak_risk'
               AND el.status IN ('sent','opened','clicked')
               AND el.created_at >= datetime('now', ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_emails se
             WHERE se.user_id = u.id
               AND se.type = 'streak_risk'
               AND se.status = 'pending'
          )
        LIMIT ?`,
    )
    .all(
      streakMin,
      `-${trigger.cooldownHours} hours`,
      config.emailMaxPerTick,
    ) as StreakRiskUserRow[];

  let queued = 0;
  for (const u of users) {
    const scheduledAt = pickSendTimeForUser(u.preferred_hour, u.timezone);
    scheduleEmail(
      db,
      u.id,
      "streak_risk",
      {
        username: u.username,
        streakCount: u.daily_streak_current,
      },
      scheduledAt,
      trigger.templateId,
    );
    queued++;
  }
  return queued;
}

interface InactivityUserRow {
  id: string;
  username: string;
  preferred_hour: number;
  timezone: string;
}

/**
 * Queue `inactivity_reminder` emails for users who have been idle for
 * approximately the configured number of days.
 *
 * Uses `user_sessions.last_active_at` as the signal because it is updated
 * on every authenticated request; `users.last_login_at` would miss
 * active users who simply haven't re-authed recently.
 *
 * @param db - Database instance.
 * @returns Number of users for whom an email was enqueued.
 */
export function evaluateInactivityEmails(db: DatabaseType): number {
  const trigger = getTriggerConfig(db, "inactivity_reminder");
  if (!trigger || !trigger.isEnabled || !trigger.templateId) return 0;

  const threshold = safeParseThreshold(trigger.thresholdJson);
  const days = typeof threshold.days === "number" ? threshold.days : 7;

  // Match users whose most recent session activity sits in a narrow
  // window around `days` days ago. We use a ±12h window so we catch
  // users once rather than every tick for the remainder of the period.
  const users = db
    .prepare(
      `SELECT u.id, u.username, p.preferred_hour, p.timezone
         FROM users u
         JOIN email_preferences p ON p.user_id = u.id
        WHERE u.is_active = 1
          AND u.email IS NOT NULL
          AND p.email_enabled = 1
          AND p.inactivity_reminder = 1
          AND (
            -- Wrap in datetime() to normalize the ISO 'T' separator that
            -- user_sessions stores; without this the string comparison in
            -- BETWEEN is lexically inconsistent with datetime('now').
            SELECT datetime(MAX(s.last_active_at)) FROM user_sessions s WHERE s.user_id = u.id
          ) BETWEEN datetime('now', ?) AND datetime('now', ?)
          AND NOT EXISTS (
            SELECT 1 FROM email_log el
             WHERE el.user_id = u.id
               AND el.type = 'inactivity_reminder'
               AND el.status IN ('sent','opened','clicked')
               AND el.created_at >= datetime('now', ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_emails se
             WHERE se.user_id = u.id
               AND se.type = 'inactivity_reminder'
               AND se.status = 'pending'
          )
        LIMIT ?`,
    )
    .all(
      `-${days + 1} days`,
      `-${days} days`,
      `-${trigger.cooldownHours} hours`,
      config.emailMaxPerTick,
    ) as InactivityUserRow[];

  let queued = 0;
  for (const u of users) {
    const scheduledAt = pickSendTimeForUser(u.preferred_hour, u.timezone);
    scheduleEmail(
      db,
      u.id,
      "inactivity_reminder",
      { username: u.username, daysInactive: days },
      scheduledAt,
      trigger.templateId,
    );
    queued++;
  }
  return queued;
}

/**
 * Queue the weekly digest for every opted-in user. Fires only when the
 * current UTC weekday and hour match the admin-configured digest slot.
 *
 * @param db - Database instance.
 * @returns Number of users enqueued.
 */
export function evaluateWeeklyDigestEmails(db: DatabaseType): number {
  const trigger = getTriggerConfig(db, "weekly_digest");
  if (!trigger || !trigger.isEnabled || !trigger.templateId) return 0;

  const threshold = safeParseThreshold(trigger.thresholdJson);
  const weekday = typeof threshold.weekday === "number" ? threshold.weekday : 1;
  const hour = typeof threshold.hour === "number" ? threshold.hour : 10;

  const now = new Date();
  // Only fire inside the configured hour; the 15-min tick means we get
  // up to 4 chances per hour to run, but the cooldown prevents duplicate
  // sends within the same digest cycle.
  if (now.getUTCDay() !== weekday) return 0;
  if (now.getUTCHours() !== hour) return 0;

  const users = db
    .prepare(
      `SELECT u.id, u.username, p.preferred_hour, p.timezone
         FROM users u
         JOIN email_preferences p ON p.user_id = u.id
        WHERE u.is_active = 1
          AND u.email IS NOT NULL
          AND p.email_enabled = 1
          AND p.weekly_digest = 1
          AND NOT EXISTS (
            SELECT 1 FROM email_log el
             WHERE el.user_id = u.id
               AND el.type = 'weekly_digest'
               AND el.status IN ('sent','opened','clicked')
               AND el.created_at >= datetime('now', ?)
          )
        LIMIT ?`,
    )
    .all(`-${trigger.cooldownHours} hours`, config.emailMaxPerTick) as Array<{
      id: string;
      username: string;
      preferred_hour: number;
      timezone: string;
    }>;

  let queued = 0;
  for (const u of users) {
    const scheduledAt = pickSendTimeForUser(u.preferred_hour, u.timezone);
    scheduleEmail(
      db,
      u.id,
      "weekly_digest",
      { username: u.username },
      scheduledAt,
      trigger.templateId,
    );
    queued++;
  }
  return queued;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove old email log rows and settled scheduled rows. Run probabilistically
 * once every ~10 ticks to avoid hammering SQLite with DELETEs.
 */
export function cleanupOldEmailData(db: DatabaseType): void {
  db.prepare(
    `DELETE FROM email_log WHERE created_at < datetime('now', '-180 days')`,
  ).run();
  db.prepare(
    `DELETE FROM scheduled_emails
       WHERE status IN ('sent','failed','cancelled')
         AND created_at < datetime('now', '-30 days')`,
  ).run();
}

// ── Main loop ───────────────────────────────────────────────────────────────

/**
 * Start the email scheduler background loop.
 *
 * Runs every `emailSchedulerIntervalMs` (default 15 min). Uses the same
 * guard as the push scheduler to prevent overlapping ticks.
 *
 * @param db - Database instance.
 * @returns Interval handle for cleanup on shutdown.
 */
export function startEmailScheduler(db: DatabaseType): NodeJS.Timeout {
  let running = false;

  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processScheduledEmails(db);

      // Only run trigger evaluators for types whose row exists (i.e. the
      // migration seeded them). Admins toggle individual rows on via the
      // admin panel.
      const configs = listTriggerConfigs(db);
      const isConfigured = (t: EmailNotificationType) =>
        configs.some((c) => c.type === t && c.isEnabled);

      if (isConfigured("streak_risk")) evaluateStreakRiskEmails(db);
      if (isConfigured("inactivity_reminder")) evaluateInactivityEmails(db);
      if (isConfigured("weekly_digest")) evaluateWeeklyDigestEmails(db);
      if (isConfigured("leaderboard_placement")) evaluateLeaderboardPlacementEmails(db);

      if (Math.random() < 0.1) cleanupOldEmailData(db);
    } catch (err) {
      console.error("Email scheduler error:", err);
    } finally {
      running = false;
    }
  }, config.emailSchedulerIntervalMs);

  console.log(
    `Email scheduler started (interval: ${config.emailSchedulerIntervalMs}ms)`,
  );
  return interval;
}

// ── Internals ───────────────────────────────────────────────────────────────

interface Threshold {
  streakMin?: number;
  days?: number;
  weekday?: number;
  hour?: number;
}

function safeParseThreshold(raw: string | null): Threshold {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Threshold;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Compute a send time for a user. The scheduler wants to land emails in
 * the user's "preferred hour" local time; we convert that to a UTC
 * datetime string suitable for `scheduled_at`.
 *
 * Strategy: if the user's preferred hour *today* is still in the future
 * in their timezone, target it. Otherwise target tomorrow's preferred
 * hour. Falls back to "now" if the timezone string is invalid.
 *
 * @param preferredHour - 0-23 local hour.
 * @param timezone - IANA timezone string.
 * @returns SQLite-compatible datetime string in UTC.
 */
export function pickSendTimeForUser(
  preferredHour: number,
  timezone: string,
): string {
  try {
    const now = new Date();
    // What's the current hour in the user's timezone?
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const currentLocalHour = hourPart ? parseInt(hourPart.value, 10) : NaN;
    if (!Number.isFinite(currentLocalHour)) {
      return toSqliteDatetime(now);
    }

    const hoursUntil =
      currentLocalHour <= preferredHour
        ? preferredHour - currentLocalHour
        : 24 - currentLocalHour + preferredHour;

    const target = new Date(now.getTime() + hoursUntil * 60 * 60 * 1000);
    return toSqliteDatetime(target);
  } catch {
    return toSqliteDatetime(new Date());
  }
}

function toSqliteDatetime(d: Date): string {
  // Format: YYYY-MM-DD HH:MM:SS in UTC (matches datetime('now') output)
  const iso = d.toISOString(); // "2026-04-17T15:30:45.123Z"
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}
