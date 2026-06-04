/**
 * Core push notification service.
 *
 * Wraps the `web-push` library to handle VAPID authentication, subscription
 * CRUD, notification delivery to individual users or all opted-in subscribers,
 * template rendering, and automatic cleanup of expired subscriptions (410/404).
 */

import webpush from "web-push";
import type { Database as DatabaseType } from "better-sqlite3";
import type { Server } from "socket.io";
import type {
  PushSubscriptionPayload,
  NotificationType,
  NotificationPreferences,
  NotificationTemplate,
  NotificationLogEntry,
  NotificationStats,
  NotificationReceivedPayload,
} from "@price-game/shared";
import { SOCKET_EVENTS, DEFAULT_NOTIFICATION_PREFERENCES, originForNotificationType } from "@price-game/shared";
import { config } from "../config";
import { tagUrl } from "./outboundLinks";

// ── Subscription row shape from SQLite ──────────────────────────────────────

interface SubscriptionRow {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  user_agent: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  visitor_id: string | null;
}

interface PreferencesRow {
  user_id: string;
  push_enabled: number;
  daily_puzzle: number;
  streak_reminder: number;
  leaderboard_updates: number;
  leaderboard_placement: number;
  multiplayer_invites: number;
  promotional: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
  updated_at: string;
}

interface TemplateRow {
  id: number;
  name: string;
  type: string;
  title_template: string;
  body_template: string;
  icon: string;
  url_path: string;
  actions_json: string | null;
  ttl: number;
  urgency: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface LogRow {
  id: number;
  user_id: string;
  username: string | null;
  subscription_id: number | null;
  template_id: number | null;
  type: string;
  title: string | null;
  body: string | null;
  url_path: string | null;
  status: string;
  http_status: number | null;
  error_message: string | null;
  suppression_reason: string | null;
  sent_at: string | null;
  clicked_at: string | null;
  created_at: string;
}

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the web-push library with VAPID credentials.
 * Must be called once at server startup before sending any notifications.
 *
 * @returns True if VAPID keys are configured and initialization succeeded.
 */
export function initWebPush(): boolean {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    console.warn("Push notifications disabled: VAPID keys not configured");
    return false;
  }
  webpush.setVapidDetails(
    config.vapidSubject,
    config.vapidPublicKey,
    config.vapidPrivateKey,
  );
  return true;
}

// ── Subscription CRUD ───────────────────────────────────────────────────────

/**
 * Save or update a push subscription for a user.
 * Upserts on the unique `endpoint` column — handles re-subscribes from
 * the same browser gracefully.
 *
 * The visitor_id is captured so the notification scheduler can filter
 * notifications by device activity (not just account activity). A logged-in
 * user who plays the daily as a guest on this same device will still have
 * that play attributed to the device via visitor_id, which prevents bogus
 * "daily puzzle ready" reminders from firing on a device that already played.
 *
 * @param db - Database instance
 * @param userId - Authenticated user ID
 * @param subscription - Browser PushSubscription.toJSON() payload
 * @param visitorId - Persistent browser cookie identifier, or null if unknown
 * @param userAgent - Optional User-Agent string for debugging
 */
export function saveSubscription(
  db: DatabaseType,
  userId: string,
  subscription: PushSubscriptionPayload,
  visitorId?: string | null,
  userAgent?: string,
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, expiration_time, user_agent, visitor_id, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       user_agent = excluded.user_agent,
       visitor_id = excluded.visitor_id,
       is_active = 1,
       updated_at = datetime('now')`,
  ).run(
    userId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    subscription.expirationTime,
    userAgent ?? null,
    visitorId ?? null,
  );

  // Ensure the user has a preferences row (defaults)
  db.prepare(
    `INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)`,
  ).run(userId);
}

/**
 * Re-link any push subscriptions for the given visitor_id to a new user.
 *
 * Called from login and OAuth callback handlers. Handles the device-rotation
 * case where Alice subscribed on a browser and Bob later logs in on the same
 * browser — without this, the subscription stays pointed at Alice and the
 * notification scheduler (which filters on both user_id and visitor_id)
 * keeps targeting the wrong account. No-op if visitor_id is missing.
 *
 * @param db - Database instance
 * @param visitorId - Persistent browser cookie identifier (may be undefined)
 * @param newUserId - The user who just authenticated on this browser
 * @returns The number of subscription rows relinked
 */
export function relinkPushSubscriptionsForVisitor(
  db: DatabaseType,
  visitorId: string | undefined | null,
  newUserId: string,
): number {
  if (!visitorId) return 0;
  const result = db
    .prepare(
      `UPDATE push_subscriptions
          SET user_id = ?, updated_at = datetime('now')
        WHERE visitor_id = ? AND user_id IS NOT ?`,
    )
    .run(newUserId, visitorId, newUserId);
  return result.changes;
}

/**
 * Remove a push subscription by endpoint.
 *
 * @param db - Database instance
 * @param userId - Authenticated user ID (prevents cross-user deletion)
 * @param endpoint - The subscription endpoint URL
 * @returns True if a row was deleted.
 */
export function removeSubscription(
  db: DatabaseType,
  userId: string,
  endpoint: string,
): boolean {
  const result = db.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`,
  ).run(userId, endpoint);
  return result.changes > 0;
}

/**
 * Mark a subscription as inactive (called on 410 Gone / 404 Not Found from push service).
 *
 * @param db - Database instance
 * @param endpoint - The expired subscription endpoint
 */
export function deactivateSubscription(db: DatabaseType, endpoint: string): void {
  db.prepare(
    `UPDATE push_subscriptions SET is_active = 0, updated_at = datetime('now') WHERE endpoint = ?`,
  ).run(endpoint);
}

/**
 * Get all active push subscriptions for a user.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @returns Array of subscription rows
 */
export function getActiveSubscriptions(db: DatabaseType, userId: string): SubscriptionRow[] {
  return db.prepare(
    `SELECT * FROM push_subscriptions WHERE user_id = ? AND is_active = 1`,
  ).all(userId) as SubscriptionRow[];
}

/**
 * Count total and active subscribers.
 *
 * @param db - Database instance
 * @returns Object with total and active counts
 */
export function getSubscriberCounts(db: DatabaseType): { total: number; active: number } {
  const total = (db.prepare(
    `SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions`,
  ).get() as { c: number }).c;
  const active = (db.prepare(
    `SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions WHERE is_active = 1`,
  ).get() as { c: number }).c;
  return { total, active };
}

// ── Preferences ─────────────────────────────────────────────────────────────

/**
 * Get notification preferences for a user. Returns defaults if no row exists.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @returns Notification preferences
 */
export function getPreferences(db: DatabaseType, userId: string): NotificationPreferences {
  const row = db.prepare(
    `SELECT * FROM notification_preferences WHERE user_id = ?`,
  ).get(userId) as PreferencesRow | undefined;

  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };

  return {
    pushEnabled: row.push_enabled === 1,
    dailyPuzzle: row.daily_puzzle === 1,
    streakReminder: row.streak_reminder === 1,
    leaderboardUpdates: row.leaderboard_updates === 1,
    leaderboardPlacement: row.leaderboard_placement === 1,
    multiplayerInvites: row.multiplayer_invites === 1,
    promotional: row.promotional === 1,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    timezone: row.timezone,
  };
}

/**
 * Update notification preferences for a user (upsert).
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param prefs - Partial preferences to merge
 */
export function updatePreferences(
  db: DatabaseType,
  userId: string,
  prefs: Partial<NotificationPreferences>,
): void {
  // Ensure row exists
  db.prepare(`INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)`).run(userId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (prefs.pushEnabled !== undefined) { fields.push("push_enabled = ?"); values.push(prefs.pushEnabled ? 1 : 0); }
  if (prefs.dailyPuzzle !== undefined) { fields.push("daily_puzzle = ?"); values.push(prefs.dailyPuzzle ? 1 : 0); }
  if (prefs.streakReminder !== undefined) { fields.push("streak_reminder = ?"); values.push(prefs.streakReminder ? 1 : 0); }
  if (prefs.leaderboardUpdates !== undefined) { fields.push("leaderboard_updates = ?"); values.push(prefs.leaderboardUpdates ? 1 : 0); }
  if (prefs.leaderboardPlacement !== undefined) { fields.push("leaderboard_placement = ?"); values.push(prefs.leaderboardPlacement ? 1 : 0); }
  if (prefs.multiplayerInvites !== undefined) { fields.push("multiplayer_invites = ?"); values.push(prefs.multiplayerInvites ? 1 : 0); }
  if (prefs.promotional !== undefined) { fields.push("promotional = ?"); values.push(prefs.promotional ? 1 : 0); }
  if (prefs.quietHoursStart !== undefined) { fields.push("quiet_hours_start = ?"); values.push(prefs.quietHoursStart); }
  if (prefs.quietHoursEnd !== undefined) { fields.push("quiet_hours_end = ?"); values.push(prefs.quietHoursEnd); }
  if (prefs.timezone !== undefined) { fields.push("timezone = ?"); values.push(prefs.timezone); }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(userId);

  db.prepare(
    `UPDATE notification_preferences SET ${fields.join(", ")} WHERE user_id = ?`,
  ).run(...values);
}

// ── Template CRUD ───────────────────────────────────────────────────────────

/**
 * List all notification templates.
 *
 * @param db - Database instance
 * @returns Array of templates
 */
export function listTemplates(db: DatabaseType): NotificationTemplate[] {
  const rows = db.prepare(
    `SELECT * FROM notification_templates ORDER BY created_at DESC`,
  ).all() as TemplateRow[];
  return rows.map(rowToTemplate);
}

/**
 * Get a single template by ID.
 *
 * @param db - Database instance
 * @param id - Template ID
 * @returns Template or undefined
 */
export function getTemplate(db: DatabaseType, id: number): NotificationTemplate | undefined {
  const row = db.prepare(
    `SELECT * FROM notification_templates WHERE id = ?`,
  ).get(id) as TemplateRow | undefined;
  return row ? rowToTemplate(row) : undefined;
}

/**
 * Create a new notification template.
 *
 * @param db - Database instance
 * @param data - Template fields
 * @returns The created template
 */
export function createTemplate(
  db: DatabaseType,
  data: {
    name: string;
    type: NotificationType;
    titleTemplate: string;
    bodyTemplate: string;
    icon?: string;
    urlPath?: string;
    actionsJson?: string;
    ttl?: number;
    urgency?: string;
  },
): NotificationTemplate {
  const result = db.prepare(
    `INSERT INTO notification_templates (name, type, title_template, body_template, icon, url_path, actions_json, ttl, urgency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.name,
    data.type,
    data.titleTemplate,
    data.bodyTemplate,
    data.icon ?? "/logo192.png",
    data.urlPath ?? "/",
    data.actionsJson ?? null,
    data.ttl ?? 3600,
    data.urgency ?? "normal",
  );
  return getTemplate(db, result.lastInsertRowid as number)!;
}

/**
 * Update an existing notification template.
 *
 * @param db - Database instance
 * @param id - Template ID
 * @param data - Partial template fields to update
 * @returns Updated template or undefined if not found
 */
export function updateTemplate(
  db: DatabaseType,
  id: number,
  data: Partial<{
    name: string;
    type: NotificationType;
    titleTemplate: string;
    bodyTemplate: string;
    icon: string;
    urlPath: string;
    actionsJson: string | null;
    ttl: number;
    urgency: string;
    isActive: boolean;
  }>,
): NotificationTemplate | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.type !== undefined) { fields.push("type = ?"); values.push(data.type); }
  if (data.titleTemplate !== undefined) { fields.push("title_template = ?"); values.push(data.titleTemplate); }
  if (data.bodyTemplate !== undefined) { fields.push("body_template = ?"); values.push(data.bodyTemplate); }
  if (data.icon !== undefined) { fields.push("icon = ?"); values.push(data.icon); }
  if (data.urlPath !== undefined) { fields.push("url_path = ?"); values.push(data.urlPath); }
  if (data.actionsJson !== undefined) { fields.push("actions_json = ?"); values.push(data.actionsJson); }
  if (data.ttl !== undefined) { fields.push("ttl = ?"); values.push(data.ttl); }
  if (data.urgency !== undefined) { fields.push("urgency = ?"); values.push(data.urgency); }
  if (data.isActive !== undefined) { fields.push("is_active = ?"); values.push(data.isActive ? 1 : 0); }

  if (fields.length === 0) return getTemplate(db, id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(
    `UPDATE notification_templates SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  return getTemplate(db, id);
}

/**
 * Delete a notification template.
 *
 * @param db - Database instance
 * @param id - Template ID
 * @returns True if deleted
 */
export function deleteTemplate(db: DatabaseType, id: number): boolean {
  return db.prepare(`DELETE FROM notification_templates WHERE id = ?`).run(id).changes > 0;
}

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Render a template string by replacing `{{key}}` placeholders with values.
 *
 * @param template - Template string with `{{key}}` placeholders
 * @param vars - Key-value pairs for substitution
 * @returns Rendered string
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return key in vars ? String(vars[key]) : `{{${key}}}`;
  });
}

// ── Sending ─────────────────────────────────────────────────────────────────

/** Options for sendPush. */
export interface SendPushOptions {
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  topic?: string;
}

/** Payload sent to the service worker push event. */
export interface PushPayload {
  title: string;
  body: string;
  /** Small icon shown next to the title. Defaults to /logo192.png in the SW. */
  icon?: string;
  /**
   * Monochrome silhouette shown in the Android status bar. Defaults to
   * /badge-96.png in the SW. Must be pure-white-on-transparent — Android
   * strips RGB and renders the alpha channel.
   */
  badge?: string;
  /**
   * Large hero image shown in the expanded notification (Chrome/Android).
   * No SW default — omit unless the notification is specifically content-rich.
   * Always-on hero images are a known abusive-notification signal on Chrome mobile.
   */
  image?: string;
  url?: string;
  tag?: string;
  /** Replace + re-alert an existing notification with the same tag. Default: false. */
  renotify?: boolean;
  /** Short vibration pattern in ms (on/off/on…). Ignored when silent=true. */
  vibrate?: number[];
  /** Epoch millis for ordering on Android. Default: send time. */
  timestamp?: number;
  actions?: Array<{ action: string; title: string }>;
  requireInteraction?: boolean;
  silent?: boolean;
}

/**
 * Send a push notification to a single subscription.
 * Handles 410/404 by deactivating the subscription.
 *
 * @param db - Database instance
 * @param subscriptionRow - The subscription row from the database
 * @param payload - Notification payload
 * @param options - Web push options
 * @returns Object with success flag and optional HTTP status
 */
export async function sendPushToSubscription(
  db: DatabaseType,
  subscriptionRow: SubscriptionRow,
  payload: PushPayload,
  options?: SendPushOptions,
): Promise<{ success: boolean; httpStatus?: number; error?: string }> {
  const pushSubscription = {
    endpoint: subscriptionRow.endpoint,
    keys: {
      p256dh: subscriptionRow.p256dh,
      auth: subscriptionRow.auth,
    },
  };

  try {
    const response = await webpush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      {
        TTL: options?.ttl ?? 3600,
        urgency: options?.urgency ?? "normal",
        topic: options?.topic,
      },
    );
    return { success: true, httpStatus: response.statusCode };
  } catch (err: unknown) {
    const wpError = err as { statusCode?: number; body?: string };
    const status = wpError.statusCode;

    // 410 Gone or 404 Not Found = subscription expired, deactivate it
    if (status === 410 || status === 404) {
      deactivateSubscription(db, subscriptionRow.endpoint);
    }

    return {
      success: false,
      httpStatus: status,
      error: wpError.body ?? String(err),
    };
  }
}

/**
 * Send a push notification to all active subscriptions for a user.
 * Logs each delivery attempt in notification_log.
 * Also emits a real-time Socket.IO event if the user is connected.
 *
 * @param db - Database instance
 * @param userId - Target user ID
 * @param type - Notification type (for preference checking and logging)
 * @param payload - Notification payload
 * @param options - Optional web push options and template ID
 * @param io - Optional Socket.IO server for real-time delivery
 * @returns Number of successful deliveries
 */
export async function sendPushToUser(
  db: DatabaseType,
  userId: string,
  type: NotificationType,
  payload: PushPayload,
  options?: SendPushOptions & { templateId?: number; adminOverride?: boolean },
  io?: Server,
): Promise<number> {
  // Check user preferences (skip for admin-initiated sends)
  if (!options?.adminOverride) {
    const prefs = getPreferences(db, userId);
    if (!prefs.pushEnabled) return 0;

    const prefKey = type.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) as keyof NotificationPreferences;
    if (typeof prefs[prefKey] === "boolean" && !prefs[prefKey]) return 0;

    // Respect quiet hours
    if (prefs.quietHoursStart && prefs.quietHoursEnd) {
      const now = new Date();
      const tz = prefs.timezone || "UTC";
      try {
        const userTime = now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" });
        const start = prefs.quietHoursStart;
        const end = prefs.quietHoursEnd;
        // Handle overnight ranges (e.g. 22:00 - 08:00)
        const inQuiet = start <= end
          ? userTime >= start && userTime < end
          : userTime >= start || userTime < end;
        if (inQuiet) return 0;
      } catch {
        // Invalid timezone — skip quiet hours check
      }
    }
  }

  // Pre-tag the URL with UTMs for landing-page attribution capture.
  // Push URLs aren't user-visible (the SW navigates directly), so we
  // skip the /go/<code> short-link wrap that emails use — the existing
  // /api/push/click/<logId> tracker already provides per-template click
  // attribution from notification_log, and a second redirect hop adds
  // latency for no marginal benefit.
  const taggedUrl = payload.url
    ? tagUrl(payload.url, originForNotificationType(type))
    : undefined;

  const subscriptions = getActiveSubscriptions(db, userId);
  let successCount = 0;

  for (const sub of subscriptions) {
    // Insert log entry — store the tagged URL so the click tracker
    // redirects to the UTM-bearing destination.
    const logResult = db.prepare(
      `INSERT INTO notification_log (user_id, subscription_id, template_id, type, title, body, url_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(userId, sub.id, options?.templateId ?? null, type, payload.title, payload.body, taggedUrl ?? null);
    const logId = logResult.lastInsertRowid as number;

    // Rewrite URL to go through click tracker
    const trackedPayload = { ...payload };
    if (taggedUrl) {
      trackedPayload.url = `/api/push/click/${logId}?r=${encodeURIComponent(taggedUrl)}`;
    }

    const result = await sendPushToSubscription(db, sub, trackedPayload, options);

    // Update log
    if (result.success) {
      db.prepare(
        `UPDATE notification_log SET status = 'sent', http_status = ?, sent_at = datetime('now') WHERE id = ?`,
      ).run(result.httpStatus ?? null, logId);
      successCount++;
    } else {
      const status = (result.httpStatus === 410 || result.httpStatus === 404) ? "expired" : "failed";
      db.prepare(
        `UPDATE notification_log SET status = ?, http_status = ?, error_message = ?, sent_at = datetime('now') WHERE id = ?`,
      ).run(status, result.httpStatus ?? null, result.error ?? null, logId);
    }
  }

  // Emit real-time Socket.IO event for in-app toast. The URL on the
  // socket payload uses the tagged form too so an in-app click counts
  // toward the same origin as the native push tap.
  if (io) {
    const socketPayload: NotificationReceivedPayload = {
      type,
      title: payload.title,
      body: payload.body,
      url: taggedUrl,
      icon: payload.icon,
    };
    io.to(`user:${userId}`).emit(SOCKET_EVENTS.NOTIFICATION_RECEIVED, socketPayload);
  }

  return successCount;
}

/**
 * Send a notification to all opted-in users for a given type.
 * Processes in batches to avoid overwhelming the push service.
 *
 * @param db - Database instance
 * @param type - Notification type
 * @param payload - Notification payload
 * @param options - Optional web push options and template ID
 * @param io - Optional Socket.IO server
 * @returns Total successful deliveries
 */
export async function sendPushToAll(
  db: DatabaseType,
  type: NotificationType,
  payload: PushPayload,
  options?: SendPushOptions & { templateId?: number; adminOverride?: boolean },
  io?: Server,
): Promise<number> {
  let userIds: Array<{ user_id: string }>;

  if (options?.adminOverride) {
    // Admin override: send to all active subscribers regardless of preferences
    userIds = db.prepare(
      `SELECT DISTINCT user_id FROM push_subscriptions WHERE is_active = 1`,
    ).all() as Array<{ user_id: string }>;
  } else {
    // Normal: respect per-type preferences
    const typeToColumn: Record<NotificationType, string> = {
      daily_puzzle: "daily_puzzle",
      streak_reminder: "streak_reminder",
      leaderboard_updates: "leaderboard_updates",
      leaderboard_placement: "leaderboard_placement",
      multiplayer_invites: "multiplayer_invites",
      promotional: "promotional",
    };
    const column = typeToColumn[type];
    if (!column) return 0;

    userIds = db.prepare(
      `SELECT DISTINCT ps.user_id
       FROM push_subscriptions ps
       JOIN notification_preferences np ON np.user_id = ps.user_id
       WHERE ps.is_active = 1 AND np.push_enabled = 1 AND np.${column} = 1`,
    ).all() as Array<{ user_id: string }>;
  }

  let total = 0;
  for (const { user_id } of userIds) {
    total += await sendPushToUser(db, user_id, type, payload, options, io);
  }
  return total;
}

// ── Click tracking ──────────────────────────────────────────────────────────

/**
 * Record a notification click by log ID.
 *
 * @param db - Database instance
 * @param logId - Notification log entry ID
 * @returns The original URL path to redirect to, or "/" if not found
 */
export function recordClick(db: DatabaseType, logId: number): string {
  const row = db.prepare(
    `SELECT url_path FROM notification_log WHERE id = ?`,
  ).get(logId) as { url_path: string | null } | undefined;

  db.prepare(
    `UPDATE notification_log SET status = 'clicked', clicked_at = datetime('now') WHERE id = ?`,
  ).run(logId);

  return row?.url_path ?? "/";
}

// ── Analytics ───────────────────────────────────────────────────────────────

/**
 * Get aggregate notification statistics for the admin dashboard.
 *
 * @param db - Database instance
 * @param days - Number of days to look back (default 7)
 * @returns Notification stats
 */
export function getNotificationStats(db: DatabaseType, days: number = 7): NotificationStats {
  const counts = getSubscriberCounts(db);

  const totals = db.prepare(
    `SELECT
       COUNT(*) as total_sent,
       SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as total_clicked
     FROM notification_log
     WHERE created_at >= datetime('now', ?)`,
  ).get(`-${days} days`) as { total_sent: number; total_clicked: number };

  const delivered = (db.prepare(
    `SELECT COUNT(*) as c FROM notification_log
     WHERE status IN ('sent', 'clicked') AND created_at >= datetime('now', ?)`,
  ).get(`-${days} days`) as { c: number }).c;

  const byType = db.prepare(
    `SELECT
       type,
       COUNT(*) as sent,
       SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as clicked,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM notification_log
     WHERE created_at >= datetime('now', ?)
     GROUP BY type`,
  ).all(`-${days} days`) as Array<{
    type: string;
    sent: number;
    clicked: number;
    failed: number;
  }>;

  return {
    totalSubscribers: counts.total,
    activeSubscribers: counts.active,
    totalSent: totals.total_sent,
    totalClicked: totals.total_clicked,
    deliveryRate: totals.total_sent > 0 ? (delivered / totals.total_sent) * 100 : 0,
    clickThroughRate: delivered > 0 ? (totals.total_clicked / delivered) * 100 : 0,
    byType: byType.map((row) => ({
      type: row.type as NotificationType,
      sent: row.sent,
      clicked: row.clicked,
      failed: row.failed,
      ctr: (row.sent - row.failed) > 0 ? (row.clicked / (row.sent - row.failed)) * 100 : 0,
    })),
  };
}

/**
 * Get paginated notification log entries.
 *
 * @param db - Database instance
 * @param options - Pagination and filter options
 * @returns Log entries and total count
 */
export function getNotificationLog(
  db: DatabaseType,
  options: {
    page?: number;
    limit?: number;
    type?: NotificationType;
    status?: string;
    userId?: string;
  } = {},
): { entries: NotificationLogEntry[]; total: number } {
  const page = options.page ?? 1;
  const limit = options.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.type) { conditions.push("nl.type = ?"); params.push(options.type); }
  if (options.status) { conditions.push("nl.status = ?"); params.push(options.status); }
  if (options.userId) { conditions.push("nl.user_id = ?"); params.push(options.userId); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) as c FROM notification_log nl ${where}`).get(...params) as { c: number }).c;

  // LEFT JOIN so deleted users still surface in the log (with null username)
  // rather than being silently dropped from admin analytics.
  const rows = db.prepare(
    `SELECT nl.*, u.username AS username
     FROM notification_log nl
     LEFT JOIN users u ON u.id = nl.user_id
     ${where}
     ORDER BY nl.created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as LogRow[];

  return {
    entries: rows.map(rowToLogEntry),
    total,
  };
}

// ── Row mappers ─────────────────────────────────────────────────────────────

function rowToTemplate(row: TemplateRow): NotificationTemplate {
  return {
    id: row.id,
    name: row.name,
    type: row.type as NotificationType,
    titleTemplate: row.title_template,
    bodyTemplate: row.body_template,
    icon: row.icon,
    urlPath: row.url_path,
    actionsJson: row.actions_json,
    ttl: row.ttl,
    urgency: row.urgency as NotificationTemplate["urgency"],
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLogEntry(row: LogRow): NotificationLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username ?? null,
    subscriptionId: row.subscription_id,
    templateId: row.template_id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    urlPath: row.url_path,
    status: row.status as NotificationLogEntry["status"],
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    suppressionReason: row.suppression_reason,
    sentAt: row.sent_at,
    clickedAt: row.clicked_at,
    createdAt: row.created_at,
  };
}
