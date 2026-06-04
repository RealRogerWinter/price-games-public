/**
 * Notification scheduler — background processor for queued and triggered notifications.
 *
 * Runs on a setInterval loop (default 60s) similar to the Product Universe
 * job processor. Drains the scheduled_notifications queue and evaluates
 * time-based triggers like streak reminders.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { Server } from "socket.io";
import type { NotificationType } from "@price-game/shared";
import { addDays, getUtcDateString } from "@price-game/shared";
import { sendPushToUser, type PushPayload, type SendPushOptions } from "./pushNotification";
import { evaluateLeaderboardPlacementPushes } from "./leaderboardPlacementNotifications";
import { decayStaleStreaks } from "./dailyStreak";
import { config } from "../config";

/**
 * Pick web-push delivery options per notification type.
 * Urgency drives how aggressively the push service (and Android/FCM) wakes the
 * device; topic is an RFC 8030 header used for dedupe/replacement at the push
 * service. These pair with the payload's `tag` to produce clean status-bar
 * behavior and align with Chrome's 2026 best-practice guidance.
 *
 * @param type - Notification type
 * @param userId - Target user ID (used to scope per-user topics; truncated to
 *   fit the 32-char topic limit in RFC 8030).
 * @returns Default send options for the type
 */
export function getSendOptionsForType(
  type: NotificationType,
  userId: string,
): SendPushOptions {
  // Topics must be URL-safe base64 and ≤32 chars per RFC 8030 §5.4.
  // We hash the user id to avoid leaking raw ids and to guarantee the length.
  const shortId = userId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 18);
  switch (type) {
    case "streak_reminder":
      // Time-sensitive: the user's streak is literally on the line today.
      return { urgency: "high", topic: `streak-${shortId}` };
    case "daily_puzzle":
      return { urgency: "normal", topic: "daily-puzzle" };
    case "multiplayer_invites":
      return { urgency: "high", topic: `invite-${shortId}` };
    case "leaderboard_updates":
      return { urgency: "low", topic: "leaderboard" };
    case "leaderboard_placement":
      // Low urgency — celebratory, not time-sensitive. Topic is scoped per
      // user so the next placement-climb overrides the prior banner.
      return { urgency: "low", topic: `lb-place-${shortId}` };
    case "promotional":
      return { urgency: "low", topic: "promo" };
    default:
      return { urgency: "normal" };
  }
}

interface ScheduledRow {
  id: number;
  user_id: string;
  template_id: number | null;
  type: string;
  payload_json: string;
  scheduled_at: string;
  status: string;
  attempts: number;
}

// ── Scheduling API ──────────────────────────────────────────────────────────

/**
 * Queue a notification for future delivery.
 *
 * @param db - Database instance
 * @param userId - Target user ID
 * @param type - Notification type
 * @param payload - Push payload (serialized to JSON)
 * @param scheduledAt - ISO datetime string for when to send
 * @param templateId - Optional template ID that generated this notification
 */
export function scheduleNotification(
  db: DatabaseType,
  userId: string,
  type: NotificationType,
  payload: PushPayload,
  scheduledAt: string,
  templateId?: number,
): void {
  db.prepare(
    `INSERT INTO scheduled_notifications (user_id, template_id, type, payload_json, scheduled_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, templateId ?? null, type, JSON.stringify(payload), scheduledAt);
}

/**
 * Cancel all pending scheduled notifications of a given type for a user.
 * Used when the trigger condition is no longer valid (e.g., user played
 * the daily before the streak reminder fired).
 *
 * @param db - Database instance
 * @param userId - Target user ID
 * @param type - Notification type to cancel
 * @returns Number of cancelled notifications
 */
export function cancelScheduledNotifications(
  db: DatabaseType,
  userId: string,
  type: NotificationType,
): number {
  return db.prepare(
    `DELETE FROM scheduled_notifications WHERE user_id = ? AND type = ? AND status = 'pending'`,
  ).run(userId, type).changes;
}

/**
 * Return true if the user has a completed `daily_plays` row for today's
 * UTC date. Used to suppress stale streak reminders so we never notify
 * "play today's puzzle" after the user has already played it.
 */
function hasPlayedTodaysDaily(db: DatabaseType, userId: string): boolean {
  const today = getUtcDateString(new Date());
  const row = db.prepare(
    `SELECT 1 FROM daily_plays
      WHERE user_id = ? AND daily_date = ? AND completed_at IS NOT NULL
      LIMIT 1`,
  ).get(userId, today) as { 1: number } | undefined;
  return !!row;
}

interface UserStreakSnapshot {
  daily_streak_current: number;
  daily_streak_last_date: string | null;
}

/**
 * Read the live streak snapshot for a user. Returns null if the user no
 * longer exists (defensive — FK on `scheduled_notifications` is ON DELETE
 * CASCADE so this should be unreachable in practice).
 */
function getStreakSnapshot(db: DatabaseType, userId: string): UserStreakSnapshot | null {
  const row = db.prepare(
    `SELECT daily_streak_current, daily_streak_last_date FROM users WHERE id = ?`,
  ).get(userId) as UserStreakSnapshot | undefined;
  return row ?? null;
}

/**
 * Record a suppressed notification in `notification_log`. Suppression is
 * the third terminal state alongside 'sent' and 'failed' — it means the
 * scheduler had a payload ready to dispatch and chose not to ship it.
 * Surfacing these in the admin log is the only way to debug "why didn't
 * my reminder go out?" reports.
 *
 * @param db - Database instance
 * @param userId - Target user ID
 * @param type - Notification type (e.g. 'streak_reminder')
 * @param payload - The payload that would have been dispatched
 * @param reason - Short machine-readable token (e.g. 'already_played',
 *   'streak_broken'); also surfaced as the human-readable error_message.
 * @param templateId - Optional template ID that produced the payload
 */
function logSuppressedNotification(
  db: DatabaseType,
  userId: string,
  type: NotificationType,
  payload: PushPayload,
  reason: string,
  templateId?: number | null,
): void {
  db.prepare(
    `INSERT INTO notification_log
       (user_id, template_id, type, title, body, url_path, status, suppression_reason, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'suppressed', ?, datetime('now'))`,
  ).run(
    userId,
    templateId ?? null,
    type,
    payload.title,
    payload.body,
    payload.url ?? null,
    reason,
  );
}

// ── Queue processor ─────────────────────────────────────────────────────────

/**
 * Process all due notifications in the scheduled queue.
 * Called by the scheduler loop on each tick.
 *
 * @param db - Database instance
 * @param io - Socket.IO server for real-time delivery
 * @returns Number of notifications processed
 */
export async function processScheduledNotifications(
  db: DatabaseType,
  io?: Server,
): Promise<number> {
  const due = db.prepare(
    `SELECT * FROM scheduled_notifications
     WHERE status = 'pending' AND scheduled_at <= datetime('now') AND attempts < ?
     ORDER BY scheduled_at ASC
     LIMIT 50`,
  ).all(config.notifMaxAttempts) as ScheduledRow[];

  const today = getUtcDateString(new Date());
  const yesterday = addDays(today, -1);

  let processed = 0;
  for (const row of due) {
    // Mark as processing (increment attempts)
    db.prepare(
      `UPDATE scheduled_notifications SET attempts = attempts + 1 WHERE id = ?`,
    ).run(row.id);

    // Last-mile suppression for streak_reminder. A reminder can linger in
    // the queue even after a successful play (the cancel-on-complete cleanup
    // can race with a scheduler tick) or after a streak quietly breaks
    // (the user stopped playing, but the stored `daily_streak_current`
    // hasn't been zeroed yet). In both cases the notification is
    // factually wrong: we should not tell a user "your streak is on the
    // line" when there is no streak to protect, or "play today's puzzle"
    // when they already played it. Mark the queue row as sent (not failed)
    // so it doesn't consume further attempts, AND log the suppression
    // to notification_log so the admin audit trail records what happened.
    if (row.type === "streak_reminder") {
      let suppressionReason: "already_played" | "streak_broken" | null = null;
      if (hasPlayedTodaysDaily(db, row.user_id)) {
        suppressionReason = "already_played";
      } else {
        const snap = getStreakSnapshot(db, row.user_id);
        // The reminder protects a streak that no longer exists. We treat
        // both "current === 0" and "last completion strictly older than
        // yesterday" as broken — the second handles the case where a
        // sweep hasn't yet zeroed the column but the streak is dead per
        // the brutal Wordle rule.
        if (
          snap !== null &&
          (snap.daily_streak_current <= 0 ||
            snap.daily_streak_last_date === null ||
            snap.daily_streak_last_date < yesterday)
        ) {
          suppressionReason = "streak_broken";
        }
      }

      if (suppressionReason) {
        let payload: PushPayload;
        try {
          payload = JSON.parse(row.payload_json) as PushPayload;
        } catch {
          // Defensive: a corrupted payload still gets a log row so we can
          // see the suppression, just without title/body.
          payload = { title: "", body: "" };
        }
        db.prepare(
          `UPDATE scheduled_notifications
             SET status = 'sent',
                 sent_at = datetime('now'),
                 error_message = ?
           WHERE id = ?`,
        ).run(`suppressed: ${suppressionReason}`, row.id);
        logSuppressedNotification(
          db,
          row.user_id,
          "streak_reminder",
          payload,
          suppressionReason,
          row.template_id,
        );
        continue;
      }
    }

    try {
      const payload = JSON.parse(row.payload_json) as PushPayload;
      const type = row.type as NotificationType;
      const sendOptions = {
        ...getSendOptionsForType(type, row.user_id),
        templateId: row.template_id ?? undefined,
      };
      const sent = await sendPushToUser(
        db,
        row.user_id,
        type,
        payload,
        sendOptions,
        io,
      );

      if (sent > 0) {
        db.prepare(
          `UPDATE scheduled_notifications SET status = 'sent', sent_at = datetime('now') WHERE id = ?`,
        ).run(row.id);
      } else if (row.attempts + 1 >= config.notifMaxAttempts) {
        // No active subscriptions after all retries — give up
        db.prepare(
          `UPDATE scheduled_notifications SET status = 'failed', error_message = 'No active subscriptions after max attempts' WHERE id = ?`,
        ).run(row.id);
      }
      // Otherwise leave as pending for retry on next tick
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If max attempts reached, mark as failed permanently
      if (row.attempts + 1 >= config.notifMaxAttempts) {
        db.prepare(
          `UPDATE scheduled_notifications SET status = 'failed', error_message = ? WHERE id = ?`,
        ).run(msg, row.id);
      }
      // Otherwise leave as pending for retry on next tick
    }
  }

  return processed;
}

// ── Trigger evaluators ──────────────────────────────────────────────────────

/**
 * Evaluate which users need a streak reminder and schedule notifications.
 *
 * A streak reminder is scheduled when:
 * 1. User has an active streak (daily_streak_current > 0)
 * 2. User's last daily play was yesterday (they haven't played today yet)
 * 3. No pending streak reminder already exists for this user
 * 4. User has streak_reminder preference enabled
 *
 * @param db - Database instance
 */
export function evaluateStreakReminders(db: DatabaseType): void {
  // Find users with active streaks who haven't played today and have no pending reminder
  const users = db.prepare(
    `SELECT u.id, u.username, u.daily_streak_current, u.daily_streak_last_date
     FROM users u
     JOIN notification_preferences np ON np.user_id = u.id
     JOIN push_subscriptions ps ON ps.user_id = u.id AND ps.is_active = 1
     WHERE u.daily_streak_current > 0
       AND u.daily_streak_last_date < date('now')
       AND np.push_enabled = 1
       AND np.streak_reminder = 1
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_notifications sn
         WHERE sn.user_id = u.id AND sn.type = 'streak_reminder' AND sn.status = 'pending'
       )
     GROUP BY u.id`,
  ).all() as Array<{
    id: string;
    username: string;
    daily_streak_current: number;
    daily_streak_last_date: string;
  }>;

  for (const user of users) {
    const payload: PushPayload = {
      title: "Your streak is on the line!",
      body: `You have a ${user.daily_streak_current}-day streak. Play today's puzzle to keep it alive!`,
      icon: "/logo192.png",
      // Monochrome silhouette rendered in the Android status bar.
      badge: "/badge-96.png",
      // Wide hero image shown in the expanded notification on Chrome/Android.
      // Kept separate from `icon` (which is the small square shown next to
      // the title on all platforms).
      image: "/notif/notif-streak.png",
      url: "/daily",
      tag: `streak-${user.id}`,
    };

    // Schedule for streakReminderHours from now (or from their last play,
    // whichever results in a future time)
    const scheduledAt = new Date(
      Date.now() + config.notifStreakReminderHours * 60 * 60 * 1000,
    ).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

    scheduleNotification(db, user.id, "streak_reminder", payload, scheduledAt);
  }
}

// ── Daily puzzle ready ──────────────────────────────────────────────────────

/**
 * Send a "daily puzzle ready" notification to all opted-in subscribers.
 *
 * Fires once per UTC day — on the first scheduler tick after midnight.
 * Uses the notification_log table to check if today's batch was already sent,
 * surviving server restarts. Skips users who have already completed today's
 * daily (checked via the daily_plays table).
 *
 * @param db - Database instance
 * @param io - Socket.IO server for real-time delivery
 */
export async function evaluateDailyPuzzleNotifications(
  db: DatabaseType,
  io?: Server,
): Promise<void> {
  const today = getUtcDateString(new Date());

  // Check if we already sent daily_puzzle notifications today (survives restarts).
  // SQLite's datetime('now') stores values as 'YYYY-MM-DD HH:MM:SS' (with a space
  // between date and time), so we compare with 'YYYY-MM-DD 00:00:00'. Previously
  // this used 'YYYY-MM-DDT00:00:00' (with a 'T'), which made the string comparison
  // always fall through — causing the daily puzzle notification to be resent on
  // every scheduler tick (every ~60s).
  const alreadySent = db.prepare(
    `SELECT 1 FROM notification_log
     WHERE type = 'daily_puzzle' AND created_at >= ? LIMIT 1`,
  ).get(`${today} 00:00:00`) as { 1: number } | undefined;
  if (alreadySent) return;

  // Find subscribers with daily_puzzle enabled who haven't played today.
  // A subscription is considered "already played" if EITHER the linked user
  // played under their account OR the linked device (visitor_id) played —
  // the OR is what fixes the reported bug where a logged-out account played
  // the daily as a guest and then got a reminder under its account id.
  const users = db.prepare(
    `SELECT DISTINCT ps.user_id
     FROM push_subscriptions ps
     JOIN notification_preferences np ON np.user_id = ps.user_id
     WHERE ps.is_active = 1
       AND np.push_enabled = 1
       AND np.daily_puzzle = 1
       AND NOT EXISTS (
         SELECT 1 FROM daily_plays dp
         WHERE dp.daily_date = ?
           AND (
             dp.user_id = ps.user_id
             OR (ps.visitor_id IS NOT NULL AND dp.visitor_id = ps.visitor_id)
           )
       )`,
  ).all(today) as Array<{ user_id: string }>;

  if (users.length === 0) return;

  const payload: PushPayload = {
    title: "Daily Puzzle is Live!",
    body: "Today's Daily Puzzle is ready. Can you guess all 5 prices?",
    icon: "/logo192.png",
    // Monochrome silhouette rendered in the Android status bar.
    badge: "/badge-96.png",
    // Wide hero image shown in the expanded notification on Chrome/Android.
    // Features the kawaii daily-challenge bag so the notification looks
    // distinctively Price Games even when the player hasn't opened the app.
    image: "/notif/notif-daily.png",
    url: "/daily",
    tag: "daily-puzzle",
  };

  for (const { user_id } of users) {
    await sendPushToUser(
      db,
      user_id,
      "daily_puzzle",
      payload,
      getSendOptionsForType("daily_puzzle", user_id),
      io,
    );
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove old notification log entries and completed/failed scheduled items.
 *
 * @param db - Database instance
 */
export function cleanupOldNotifications(db: DatabaseType): void {
  // Remove log entries older than 30 days
  db.prepare(
    `DELETE FROM notification_log WHERE created_at < datetime('now', '-30 days')`,
  ).run();

  // Remove completed/failed scheduled items older than 7 days
  db.prepare(
    `DELETE FROM scheduled_notifications
     WHERE status IN ('sent', 'failed') AND created_at < datetime('now', '-7 days')`,
  ).run();

  // Remove inactive subscriptions older than 30 days
  db.prepare(
    `DELETE FROM push_subscriptions
     WHERE is_active = 0 AND updated_at < datetime('now', '-30 days')`,
  ).run();
}

// ── Main scheduler loop ─────────────────────────────────────────────────────

/**
 * Start the notification scheduler background loop.
 * Runs every `notifSchedulerIntervalMs` (default 60s).
 *
 * @param db - Database instance
 * @param io - Socket.IO server for real-time delivery
 * @returns The interval handle (for cleanup on shutdown)
 */
export function startNotificationScheduler(
  db: DatabaseType,
  io: Server,
): NodeJS.Timeout {
  let running = false;

  const interval = setInterval(async () => {
    if (running) return; // Prevent overlapping ticks
    running = true;

    try {
      // 1. Sweep stored streak counters for users whose streak is dead.
      //    This is what stops `evaluateStreakReminders` from finding them
      //    in the first place. Cheap (a single indexed UPDATE) and idempotent.
      decayStaleStreaks(db);

      // 2. Process scheduled queue
      await processScheduledNotifications(db, io);

      // 3. Evaluate triggers
      evaluateStreakReminders(db);
      await evaluateDailyPuzzleNotifications(db, io);
      await evaluateLeaderboardPlacementPushes(db, io);

      // 4. Periodic cleanup (run every ~10 ticks to avoid running on every tick)
      if (Math.random() < 0.1) {
        cleanupOldNotifications(db);
      }
    } catch (err) {
      console.error("Notification scheduler error:", err);
    } finally {
      running = false;
    }
  }, config.notifSchedulerIntervalMs);

  console.log(`Notification scheduler started (interval: ${config.notifSchedulerIntervalMs}ms)`);
  return interval;
}
