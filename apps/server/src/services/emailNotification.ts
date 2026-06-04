/**
 * Email notification service — marketing / re-engagement email channel.
 *
 * Parallel to `pushNotification.ts` but with deliberately different
 * defaults:
 *  - all preferences default to `false` (opt-in, not opt-out)
 *  - a hard per-user global cooldown bounds how often we can email a user
 *    even if the admin has multiple triggers enabled
 *  - per-type cooldowns are admin-configurable via `email_trigger_config`
 *  - every outbound email carries a signed unsubscribe link and a
 *    `List-Unsubscribe` / `List-Unsubscribe-Post` header pair for
 *    RFC 8058 one-click unsubscribe in Gmail and Apple Mail
 *
 * The module exposes CRUD for preferences + templates + trigger config,
 * a send function that enforces all of the above, a simple `{{var}}`
 * template renderer, and analytics helpers used by the admin panel.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type {
  EmailPreferences,
  EmailTemplate,
  EmailLogEntry,
  EmailNotificationType,
  EmailTriggerConfig,
  EmailStats,
} from "@price-game/shared";
import { DEFAULT_EMAIL_PREFERENCES, originForEmailType } from "@price-game/shared";
import { sendEmail, wrapInLayout, buttonHtml, escapeHtml } from "./email";
import { buildUnsubscribeUrl } from "./emailUnsubToken";
import { rewriteHtmlLinks, rewriteTextLinks } from "./outboundLinks";
import { config } from "../config";

// ── Row shapes ──────────────────────────────────────────────────────────────

interface EmailPreferencesRow {
  user_id: string;
  email_enabled: number;
  streak_risk: number;
  streak_save: number;
  inactivity_reminder: number;
  weekly_digest: number;
  leaderboard_placement: number;
  promotional: number;
  giveaway_loss: number;
  preferred_hour: number;
  timezone: string;
  updated_at: string;
}

interface EmailTemplateRow {
  id: number;
  name: string;
  type: string;
  subject_template: string;
  html_template: string;
  text_template: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface EmailLogRow {
  id: number;
  user_id: string | null;
  template_id: number | null;
  type: string;
  to_address: string;
  subject: string | null;
  status: string;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  created_at: string;
}

interface TriggerConfigRow {
  type: string;
  is_enabled: number;
  cooldown_hours: number;
  threshold_json: string | null;
  template_id: number | null;
  updated_at: string;
}

// ── Preferences ─────────────────────────────────────────────────────────────

/**
 * Return email preferences for a user, falling back to the opt-in defaults
 * if no row exists yet.
 *
 * @param db - Database instance
 * @param userId - User id
 * @returns Email preferences object
 */
export function getEmailPreferences(
  db: DatabaseType,
  userId: string,
): EmailPreferences {
  const row = db
    .prepare(`SELECT * FROM email_preferences WHERE user_id = ?`)
    .get(userId) as EmailPreferencesRow | undefined;

  if (!row) return { ...DEFAULT_EMAIL_PREFERENCES };

  return {
    emailEnabled: row.email_enabled === 1,
    streakRisk: row.streak_risk === 1,
    streakSave: row.streak_save === 1,
    inactivityReminder: row.inactivity_reminder === 1,
    weeklyDigest: row.weekly_digest === 1,
    leaderboardPlacement: row.leaderboard_placement === 1,
    promotional: row.promotional === 1,
    giveawayLoss: row.giveaway_loss === 1,
    preferredHour: row.preferred_hour,
    timezone: row.timezone,
  };
}

/**
 * Upsert email preferences for a user. Any field omitted from `prefs` is
 * left unchanged.
 *
 * @param db - Database instance
 * @param userId - User id
 * @param prefs - Partial preferences to merge
 */
export function updateEmailPreferences(
  db: DatabaseType,
  userId: string,
  prefs: Partial<EmailPreferences>,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO email_preferences (user_id) VALUES (?)`,
  ).run(userId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (prefs.emailEnabled !== undefined) { fields.push("email_enabled = ?"); values.push(prefs.emailEnabled ? 1 : 0); }
  if (prefs.streakRisk !== undefined) { fields.push("streak_risk = ?"); values.push(prefs.streakRisk ? 1 : 0); }
  if (prefs.streakSave !== undefined) { fields.push("streak_save = ?"); values.push(prefs.streakSave ? 1 : 0); }
  if (prefs.inactivityReminder !== undefined) { fields.push("inactivity_reminder = ?"); values.push(prefs.inactivityReminder ? 1 : 0); }
  if (prefs.weeklyDigest !== undefined) { fields.push("weekly_digest = ?"); values.push(prefs.weeklyDigest ? 1 : 0); }
  if (prefs.leaderboardPlacement !== undefined) { fields.push("leaderboard_placement = ?"); values.push(prefs.leaderboardPlacement ? 1 : 0); }
  if (prefs.promotional !== undefined) { fields.push("promotional = ?"); values.push(prefs.promotional ? 1 : 0); }
  if (prefs.giveawayLoss !== undefined) { fields.push("giveaway_loss = ?"); values.push(prefs.giveawayLoss ? 1 : 0); }
  if (prefs.preferredHour !== undefined) {
    const h = Math.max(0, Math.min(23, Math.floor(prefs.preferredHour)));
    fields.push("preferred_hour = ?"); values.push(h);
  }
  if (prefs.timezone !== undefined) { fields.push("timezone = ?"); values.push(prefs.timezone); }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(userId);

  db.prepare(
    `UPDATE email_preferences SET ${fields.join(", ")} WHERE user_id = ?`,
  ).run(...values);
}

// ── Template CRUD ───────────────────────────────────────────────────────────

/** List all email templates, newest first. */
export function listEmailTemplates(db: DatabaseType): EmailTemplate[] {
  const rows = db
    .prepare(`SELECT * FROM email_templates ORDER BY created_at DESC`)
    .all() as EmailTemplateRow[];
  return rows.map(rowToEmailTemplate);
}

/** Fetch a single template by id. */
export function getEmailTemplate(
  db: DatabaseType,
  id: number,
): EmailTemplate | undefined {
  const row = db
    .prepare(`SELECT * FROM email_templates WHERE id = ?`)
    .get(id) as EmailTemplateRow | undefined;
  return row ? rowToEmailTemplate(row) : undefined;
}

/** Fetch a single template by unique name. */
export function getEmailTemplateByName(
  db: DatabaseType,
  name: string,
): EmailTemplate | undefined {
  const row = db
    .prepare(`SELECT * FROM email_templates WHERE name = ?`)
    .get(name) as EmailTemplateRow | undefined;
  return row ? rowToEmailTemplate(row) : undefined;
}

/** Create a new email template. */
export function createEmailTemplate(
  db: DatabaseType,
  data: {
    name: string;
    type: EmailNotificationType;
    subjectTemplate: string;
    htmlTemplate: string;
    textTemplate?: string | null;
    isActive?: boolean;
  },
): EmailTemplate {
  const result = db
    .prepare(
      `INSERT INTO email_templates
         (name, type, subject_template, html_template, text_template, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      data.name,
      data.type,
      data.subjectTemplate,
      data.htmlTemplate,
      data.textTemplate ?? null,
      data.isActive === false ? 0 : 1,
    );
  return getEmailTemplate(db, result.lastInsertRowid as number)!;
}

/** Update an existing template; fields omitted stay unchanged. */
export function updateEmailTemplate(
  db: DatabaseType,
  id: number,
  data: Partial<{
    name: string;
    type: EmailNotificationType;
    subjectTemplate: string;
    htmlTemplate: string;
    textTemplate: string | null;
    isActive: boolean;
  }>,
): EmailTemplate | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
  if (data.type !== undefined) { fields.push("type = ?"); values.push(data.type); }
  if (data.subjectTemplate !== undefined) { fields.push("subject_template = ?"); values.push(data.subjectTemplate); }
  if (data.htmlTemplate !== undefined) { fields.push("html_template = ?"); values.push(data.htmlTemplate); }
  if (data.textTemplate !== undefined) { fields.push("text_template = ?"); values.push(data.textTemplate); }
  if (data.isActive !== undefined) { fields.push("is_active = ?"); values.push(data.isActive ? 1 : 0); }

  if (fields.length === 0) return getEmailTemplate(db, id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(
    `UPDATE email_templates SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  return getEmailTemplate(db, id);
}

/** Delete a template. Returns true if a row was removed. */
export function deleteEmailTemplate(db: DatabaseType, id: number): boolean {
  return db
    .prepare(`DELETE FROM email_templates WHERE id = ?`)
    .run(id).changes > 0;
}

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Replace `{{key}}` placeholders in `template` with values from `vars`.
 * Missing keys are left in place so the unrendered template is visible
 * downstream rather than silently dropped.
 *
 * Use this for subject lines and plain-text bodies, where the output is
 * not HTML. For HTML bodies call `renderEmailHtmlTemplate` instead so
 * user-controlled values like `username` are escaped before insertion.
 *
 * @param template - Template string with `{{key}}` placeholders.
 * @param vars - Key-value pairs to substitute.
 * @returns Rendered string.
 */
export function renderEmailTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return key in vars ? String(vars[key]) : `{{${key}}}`;
  });
}

/**
 * Like `renderEmailTemplate` but HTML-escapes every substituted value.
 * Must be used for HTML bodies because variable values frequently come
 * from user-controlled columns (`username`, display names). Without
 * escaping a hostile username like `<img onerror=...>` would land
 * verbatim in the recipient's mail client.
 *
 * @param template - HTML template with `{{key}}` placeholders.
 * @param vars - Key-value pairs to substitute; values are escaped.
 * @returns Rendered HTML with values safely escaped.
 */
export function renderEmailHtmlTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) return `{{${key}}}`;
    return escapeHtml(String(vars[key]));
  });
}

// ── Trigger config ──────────────────────────────────────────────────────────

/** List admin-tunable trigger config rows (one per trigger type). */
export function listTriggerConfigs(db: DatabaseType): EmailTriggerConfig[] {
  const rows = db
    .prepare(`SELECT * FROM email_trigger_config ORDER BY type ASC`)
    .all() as TriggerConfigRow[];
  return rows.map(rowToTriggerConfig);
}

/** Fetch the trigger config row for a single type. */
export function getTriggerConfig(
  db: DatabaseType,
  type: EmailNotificationType,
): EmailTriggerConfig | undefined {
  const row = db
    .prepare(`SELECT * FROM email_trigger_config WHERE type = ?`)
    .get(type) as TriggerConfigRow | undefined;
  return row ? rowToTriggerConfig(row) : undefined;
}

/** Upsert trigger config. Omitted fields stay unchanged. */
export function updateTriggerConfig(
  db: DatabaseType,
  type: EmailNotificationType,
  data: Partial<{
    isEnabled: boolean;
    cooldownHours: number;
    thresholdJson: string | null;
    templateId: number | null;
  }>,
): EmailTriggerConfig | undefined {
  db.prepare(
    `INSERT OR IGNORE INTO email_trigger_config (type, cooldown_hours) VALUES (?, 24)`,
  ).run(type);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.isEnabled !== undefined) { fields.push("is_enabled = ?"); values.push(data.isEnabled ? 1 : 0); }
  if (data.cooldownHours !== undefined) { fields.push("cooldown_hours = ?"); values.push(Math.max(1, Math.floor(data.cooldownHours))); }
  if (data.thresholdJson !== undefined) { fields.push("threshold_json = ?"); values.push(data.thresholdJson); }
  if (data.templateId !== undefined) { fields.push("template_id = ?"); values.push(data.templateId); }

  if (fields.length === 0) return getTriggerConfig(db, type);

  fields.push("updated_at = datetime('now')");
  values.push(type);

  db.prepare(
    `UPDATE email_trigger_config SET ${fields.join(", ")} WHERE type = ?`,
  ).run(...values);

  return getTriggerConfig(db, type);
}

// ── Send logic ──────────────────────────────────────────────────────────────

/** Reason a send was skipped or failed. `null` on successful send. */
export type EmailSkipReason =
  | "disabled"
  | "type_disabled"
  | "cooldown_global"
  | "cooldown_type"
  | "unsubscribed"
  | "no_email"
  | "inactive_user"
  | "send_failed";

/** Result of `sendMarketingEmail`. */
export interface SendMarketingResult {
  sent: 0 | 1;
  reason?: EmailSkipReason;
  logId?: number;
  providerMessageId?: string;
}

/** Options for `sendMarketingEmail`. */
export interface SendMarketingOptions {
  /** Templated content. Caller has already rendered subject/html/text. */
  subject: string;
  html: string;
  text?: string;
  templateId?: number;
  /**
   * Bypass every preference + cooldown check. Intended for admin
   * "send now" flows (e.g. a one-off announcement) where an operator has
   * explicitly confirmed. Never set this on scheduler-driven sends.
   */
  adminOverride?: boolean;
}

interface UserRow {
  id: string;
  email: string;
  is_active: number;
}

/**
 * Attempt to send a marketing email to a single user.
 *
 * Enforces: user exists and is active, has an email, is not globally or
 * per-type opted out, has not received mail within the global cooldown
 * window, and has not received the same type within the per-type
 * cooldown. Every attempt (including suppressions) is recorded in
 * `email_log` so the admin analytics and the Resend webhook can reconcile
 * later status updates.
 *
 * @param db - Database instance.
 * @param userId - Target user id.
 * @param type - Email notification type (drives preference + cooldown rules).
 * @param options - Rendered subject/html/text and sending options.
 * @returns `{ sent, reason?, logId?, providerMessageId? }`.
 */
export async function sendMarketingEmail(
  db: DatabaseType,
  userId: string,
  type: EmailNotificationType,
  options: SendMarketingOptions,
): Promise<SendMarketingResult> {
  const user = db
    .prepare(
      `SELECT id, email, is_active FROM users WHERE id = ?`,
    )
    .get(userId) as UserRow | undefined;

  if (!user || !user.email) {
    return { sent: 0, reason: "no_email" };
  }
  if (user.is_active !== 1) {
    return { sent: 0, reason: "inactive_user" };
  }

  const prefs = getEmailPreferences(db, userId);
  const override = options.adminOverride === true;

  if (!override) {
    if (!prefs.emailEnabled) {
      logSuppressed(db, userId, user.email, type, options, "disabled");
      return { sent: 0, reason: "disabled" };
    }
    if (!isTypeEnabledInPrefs(prefs, type)) {
      logSuppressed(db, userId, user.email, type, options, "type_disabled");
      return { sent: 0, reason: "type_disabled" };
    }
    if (isInGlobalCooldown(db, userId)) {
      logSuppressed(db, userId, user.email, type, options, "cooldown_global");
      return { sent: 0, reason: "cooldown_global" };
    }
    const trigger = getTriggerConfig(db, type);
    if (trigger && isInTypeCooldown(db, userId, type, trigger.cooldownHours)) {
      logSuppressed(db, userId, user.email, type, options, "cooldown_type");
      return { sent: 0, reason: "cooldown_type" };
    }
  }

  // Auto-tag every clickable URL in the body BEFORE the unsubscribe
  // footer is added. Done in this order so the HMAC-signed unsub link is
  // never rewritten — once rewritten, the signed token would still
  // verify (Resend doesn't strip query params on click) but the click
  // counter on the system origin tag would absorb every unsubscribe,
  // distorting per-template engagement numbers.
  const originKey = originForEmailType(type);
  const taggedHtml = rewriteHtmlLinks(options.html, originKey, db);
  const taggedText = options.text
    ? rewriteTextLinks(options.text, originKey, db)
    : undefined;

  const unsubUrl = buildUnsubscribeUrl(userId, type);
  const htmlWithFooter = appendUnsubscribeFooter(taggedHtml, unsubUrl);
  const textWithFooter = taggedText
    ? `${taggedText}\n\nUnsubscribe: ${unsubUrl}\n`
    : undefined;

  // RFC 8058 one-click unsubscribe headers. Gmail and Apple Mail render
  // the "Unsubscribe" button when both headers are present.
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const logId = insertLogRow(db, userId, user.email, type, options, "queued");

  const result = await sendEmail({
    to: user.email,
    subject: options.subject,
    html: htmlWithFooter,
    text: textWithFooter,
    headers,
  });

  if (result.ok) {
    db.prepare(
      `UPDATE email_log
         SET status = 'sent',
             sent_at = datetime('now'),
             provider_message_id = ?
       WHERE id = ?`,
    ).run(result.providerMessageId ?? null, logId);
    return { sent: 1, logId, providerMessageId: result.providerMessageId };
  }

  db.prepare(
    `UPDATE email_log
       SET status = 'failed',
           error_message = ?
     WHERE id = ?`,
  ).run(result.error ?? "unknown", logId);
  return { sent: 0, reason: "send_failed", logId };
}

/**
 * Render a template row and send it to a user.
 *
 * @param db - Database instance.
 * @param userId - Target user id.
 * @param templateId - Template to render.
 * @param vars - `{{var}}` substitutions.
 * @param opts - Send options (adminOverride).
 */
export async function sendMarketingEmailFromTemplate(
  db: DatabaseType,
  userId: string,
  templateId: number,
  vars: Record<string, string | number>,
  opts: { adminOverride?: boolean } = {},
): Promise<SendMarketingResult> {
  const template = getEmailTemplate(db, templateId);
  if (!template) {
    return { sent: 0, reason: "send_failed" };
  }
  if (!template.isActive && !opts.adminOverride) {
    return { sent: 0, reason: "send_failed" };
  }

  const subject = renderEmailTemplate(template.subjectTemplate, vars);
  // HTML body escapes vars to prevent injection via user-controlled
  // fields (e.g. `username`). Subject + text stay raw.
  const html = renderEmailHtmlTemplate(template.htmlTemplate, vars);
  const text = template.textTemplate
    ? renderEmailTemplate(template.textTemplate, vars)
    : undefined;

  return sendMarketingEmail(db, userId, template.type, {
    subject,
    html,
    text,
    templateId,
    adminOverride: opts.adminOverride,
  });
}

/**
 * Iterate all users opted into `type` and send them the rendered
 * template, subject to cooldowns. Batched at `emailMaxPerTick` to be
 * gentle on Resend's per-second rate limits.
 *
 * @param db - Database instance.
 * @param type - Email type; only users with the master + type flag set will receive.
 * @param build - Given a user, return the rendered send options. Lets
 *   callers personalize subject/html per-user (e.g. interpolating streak counts).
 * @param opts - Options (adminOverride).
 * @returns Per-reason counts across all candidates.
 */
export async function sendMarketingEmailToAll(
  db: DatabaseType,
  type: EmailNotificationType,
  build: (user: {
    id: string;
    username: string;
    email: string;
  }) => SendMarketingOptions | null,
  opts: { adminOverride?: boolean; limit?: number } = {},
): Promise<{ sent: number; skipped: number; byReason: Record<string, number> }> {
  const limit = opts.limit ?? config.emailMaxPerTick;

  // ORDER BY u.created_at ASC is deliberate: without it, SQLite's rowid
  // ordering would keep picking the same head of the users table on
  // every call, so any campaign >emailMaxPerTick users would repeatedly
  // hit the same first N recipients and starve the rest. Per-tick
  // progress is instead enforced by the cooldown check inside
  // sendMarketingEmail — users who already received in the last
  // cooldown window fall through as suppressed, and the next tick picks
  // up the next chronological slice.
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.email
         FROM users u
         JOIN email_preferences p ON p.user_id = u.id
        WHERE u.is_active = 1
          AND u.email IS NOT NULL
          AND p.email_enabled = 1
          AND ${typePrefColumn(type)} = 1
        ORDER BY u.created_at ASC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; username: string; email: string }>;

  let sent = 0;
  let skipped = 0;
  const byReason: Record<string, number> = {};

  for (const u of users) {
    const renderOpts = build(u);
    if (!renderOpts) {
      skipped++;
      byReason.no_content = (byReason.no_content ?? 0) + 1;
      continue;
    }
    const r = await sendMarketingEmail(db, u.id, type, {
      ...renderOpts,
      adminOverride: opts.adminOverride,
    });
    if (r.sent) {
      sent++;
    } else {
      skipped++;
      const reason = r.reason ?? "unknown";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }

  return { sent, skipped, byReason };
}

// ── Queue ────────────────────────────────────────────────────────────────────

/**
 * Enqueue an email for deferred delivery. The scheduler will pick it up
 * at or after `scheduledAt` (SQLite `datetime('now')`-comparable format,
 * `YYYY-MM-DD HH:MM:SS`).
 *
 * @param db - Database instance.
 * @param userId - Target user id.
 * @param type - Email type.
 * @param vars - Template vars (JSON-serialized into the row).
 * @param scheduledAt - SQLite datetime string.
 * @param templateId - Optional template id.
 */
export function scheduleEmail(
  db: DatabaseType,
  userId: string,
  type: EmailNotificationType,
  vars: Record<string, string | number>,
  scheduledAt: string,
  templateId?: number,
): number {
  const r = db
    .prepare(
      `INSERT INTO scheduled_emails
         (user_id, template_id, type, vars_json, scheduled_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      templateId ?? null,
      type,
      JSON.stringify(vars),
      scheduledAt,
    );
  return r.lastInsertRowid as number;
}

/** Cancel all pending scheduled emails of a type for a user. */
export function cancelScheduledEmails(
  db: DatabaseType,
  userId: string,
  type: EmailNotificationType,
): number {
  return db
    .prepare(
      `UPDATE scheduled_emails
         SET status = 'cancelled'
       WHERE user_id = ? AND type = ? AND status = 'pending'`,
    )
    .run(userId, type).changes;
}

interface ScheduledEmailRow {
  id: number;
  user_id: string;
  template_id: number | null;
  type: string;
  vars_json: string | null;
  scheduled_at: string;
  status: string;
  attempts: number;
}

/**
 * Drain due rows from `scheduled_emails`. Up to `emailMaxPerTick` rows
 * are processed per call. Rows that have used all retries move to
 * `failed`; others stay `pending` and are retried next tick.
 *
 * @param db - Database instance.
 * @returns Number of rows touched.
 */
export async function processScheduledEmails(db: DatabaseType): Promise<number> {
  const due = db
    .prepare(
      `SELECT * FROM scheduled_emails
         WHERE status = 'pending'
           AND scheduled_at <= datetime('now')
           AND attempts < ?
         ORDER BY scheduled_at ASC
         LIMIT ?`,
    )
    .all(config.emailMaxAttempts, config.emailMaxPerTick) as ScheduledEmailRow[];

  let processed = 0;
  for (const row of due) {
    db.prepare(
      `UPDATE scheduled_emails SET attempts = attempts + 1 WHERE id = ?`,
    ).run(row.id);

    try {
      const vars = row.vars_json ? JSON.parse(row.vars_json) : {};
      const type = row.type as EmailNotificationType;
      let r: SendMarketingResult;
      if (row.template_id) {
        r = await sendMarketingEmailFromTemplate(db, row.user_id, row.template_id, vars);
      } else {
        // Scheduled sends require a template; without one there is no
        // subject/html, so mark as failed.
        r = { sent: 0, reason: "send_failed" };
      }

      if (r.sent) {
        db.prepare(
          `UPDATE scheduled_emails
             SET status = 'sent', sent_at = datetime('now')
           WHERE id = ?`,
        ).run(row.id);
      } else if (
        r.reason === "disabled" ||
        r.reason === "type_disabled" ||
        r.reason === "cooldown_global" ||
        r.reason === "cooldown_type" ||
        r.reason === "unsubscribed" ||
        r.reason === "inactive_user" ||
        r.reason === "no_email"
      ) {
        // Non-retriable: the user has opted out or is in cooldown. Mark
        // the scheduled row done so it stops taking up queue cycles.
        db.prepare(
          `UPDATE scheduled_emails
             SET status = 'cancelled', error_message = ?
           WHERE id = ?`,
        ).run(r.reason, row.id);
      } else if (row.attempts + 1 >= config.emailMaxAttempts) {
        db.prepare(
          `UPDATE scheduled_emails
             SET status = 'failed', error_message = ?
           WHERE id = ?`,
        ).run(r.reason ?? "send_failed (max attempts)", row.id);
      } else {
        // Still retriable — record the last error so operators can see
        // *why* a row stays pending instead of only seeing the final
        // "max attempts reached" message once retries are exhausted.
        db.prepare(
          `UPDATE scheduled_emails SET error_message = ? WHERE id = ?`,
        ).run(r.reason ?? "send_failed", row.id);
      }
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (row.attempts + 1 >= config.emailMaxAttempts) {
        db.prepare(
          `UPDATE scheduled_emails
             SET status = 'failed', error_message = ?
           WHERE id = ?`,
        ).run(msg, row.id);
      } else {
        // Persist transient errors too so the cause is visible across
        // retries rather than only on the terminal attempt.
        db.prepare(
          `UPDATE scheduled_emails SET error_message = ? WHERE id = ?`,
        ).run(msg, row.id);
      }
    }
  }
  return processed;
}

// ── Analytics ───────────────────────────────────────────────────────────────

/**
 * Aggregate email stats for the admin dashboard.
 *
 * @param db - Database instance.
 * @param days - Window size in days (default 7).
 */
export function getEmailStats(db: DatabaseType, days = 7): EmailStats {
  const window = `-${days} days`;

  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('sent','opened','clicked') THEN 1 ELSE 0 END) as sent,
         SUM(CASE WHEN status IN ('sent','opened','clicked','bounced') THEN 1 ELSE 0 END) as delivered_or_bounced,
         SUM(CASE WHEN status = 'opened' OR status = 'clicked' THEN 1 ELSE 0 END) as opened,
         SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as clicked,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced,
         SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END) as complained
       FROM email_log
       WHERE created_at >= datetime('now', ?)`,
    )
    .get(window) as {
      sent: number | null;
      delivered_or_bounced: number | null;
      opened: number | null;
      clicked: number | null;
      bounced: number | null;
      complained: number | null;
    };

  const totalSent = totals.sent ?? 0;
  const totalOpened = totals.opened ?? 0;
  const totalClicked = totals.clicked ?? 0;
  const totalBounced = totals.bounced ?? 0;
  const totalComplained = totals.complained ?? 0;
  const totalDelivered = totalSent;

  const byTypeRows = db
    .prepare(
      `SELECT
         type,
         SUM(CASE WHEN status IN ('sent','opened','clicked') THEN 1 ELSE 0 END) as sent,
         SUM(CASE WHEN status = 'opened' OR status = 'clicked' THEN 1 ELSE 0 END) as opened,
         SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as clicked,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced
       FROM email_log
       WHERE created_at >= datetime('now', ?)
       GROUP BY type`,
    )
    .all(window) as Array<{
      type: string;
      sent: number;
      opened: number;
      clicked: number;
      bounced: number;
    }>;

  return {
    totalSent,
    totalDelivered,
    totalOpened,
    totalClicked,
    totalBounced,
    totalComplained,
    openRate: totalSent > 0 ? (totalOpened / totalSent) * 100 : 0,
    clickRate: totalSent > 0 ? (totalClicked / totalSent) * 100 : 0,
    bounceRate:
      (totals.delivered_or_bounced ?? 0) > 0
        ? (totalBounced / (totals.delivered_or_bounced ?? 1)) * 100
        : 0,
    byType: byTypeRows.map((r) => ({
      type: r.type as EmailNotificationType,
      sent: r.sent,
      opened: r.opened,
      clicked: r.clicked,
      bounced: r.bounced,
      openRate: r.sent > 0 ? (r.opened / r.sent) * 100 : 0,
      clickRate: r.sent > 0 ? (r.clicked / r.sent) * 100 : 0,
    })),
  };
}

/** Paginated email log with admin filters. */
export function getEmailLog(
  db: DatabaseType,
  options: {
    page?: number;
    limit?: number;
    type?: EmailNotificationType;
    status?: string;
    userId?: string;
  } = {},
): { entries: EmailLogEntry[]; total: number } {
  const page = options.page ?? 1;
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.type) { conditions.push("type = ?"); params.push(options.type); }
  if (options.status) { conditions.push("status = ?"); params.push(options.status); }
  if (options.userId) { conditions.push("user_id = ?"); params.push(options.userId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db
    .prepare(`SELECT COUNT(*) as c FROM email_log ${where}`)
    .get(...params) as { c: number }).c;

  const rows = db
    .prepare(
      `SELECT * FROM email_log ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as EmailLogRow[];

  return { entries: rows.map(rowToEmailLogEntry), total };
}

/**
 * Record a user-initiated unsubscribe event and flip the matching
 * preference. Used by the `/api/email/unsubscribe` route.
 *
 * @param db - Database instance.
 * @param userId - User unsubscribing.
 * @param type - Specific type, or "all" for the master switch.
 * @param source - Audit metadata.
 */
export function recordUnsubscribe(
  db: DatabaseType,
  userId: string,
  type: string,
  source: "one_click" | "preferences" | "list_unsubscribe_header" | "complaint",
): void {
  const partial: Partial<EmailPreferences> = {};
  if (type === "all") {
    partial.emailEnabled = false;
    partial.streakRisk = false;
    partial.streakSave = false;
    partial.inactivityReminder = false;
    partial.weeklyDigest = false;
    partial.promotional = false;
    partial.giveawayLoss = false;
  } else {
    switch (type) {
      case "streak_risk": partial.streakRisk = false; break;
      case "streak_save": partial.streakSave = false; break;
      case "inactivity_reminder": partial.inactivityReminder = false; break;
      case "weekly_digest": partial.weeklyDigest = false; break;
      case "promotional": partial.promotional = false; break;
      case "giveaway_loss": partial.giveawayLoss = false; break;
      default:
        // Unknown type — record nothing and throw so the caller can
        // surface an error instead of silently showing the user a
        // success page that did nothing.
        throw new Error(`Unsupported unsubscribe type: ${type}`);
    }
  }

  db.prepare(
    `INSERT INTO email_unsubscribes (user_id, type, source) VALUES (?, ?, ?)`,
  ).run(userId, type === "all" ? null : type, source);

  updateEmailPreferences(db, userId, partial);
}

// ── Internals ───────────────────────────────────────────────────────────────

function isTypeEnabledInPrefs(
  prefs: EmailPreferences,
  type: EmailNotificationType,
): boolean {
  switch (type) {
    case "streak_risk": return prefs.streakRisk;
    case "streak_save": return prefs.streakSave;
    case "inactivity_reminder": return prefs.inactivityReminder;
    case "weekly_digest": return prefs.weeklyDigest;
    case "leaderboard_placement": return prefs.leaderboardPlacement;
    case "promotional": return prefs.promotional;
    case "giveaway_loss": return prefs.giveawayLoss;
    case "custom":
      // Custom / ad-hoc sends require the master switch but no per-type
      // toggle. Keeps admin "send custom" from being blocked on a
      // per-type preference that doesn't exist.
      return true;
  }
  return false;
}

function typePrefColumn(type: EmailNotificationType): string {
  switch (type) {
    case "streak_risk": return "p.streak_risk";
    case "streak_save": return "p.streak_save";
    case "inactivity_reminder": return "p.inactivity_reminder";
    case "weekly_digest": return "p.weekly_digest";
    case "leaderboard_placement": return "p.leaderboard_placement";
    case "promotional": return "p.promotional";
    case "giveaway_loss": return "p.giveaway_loss";
    case "custom":
      // Custom sends don't have a per-type column — treat as always-on
      // among users with the master switch enabled. The caller is
      // responsible for intent.
      return "1";
  }
  return "1";
}

function isInGlobalCooldown(db: DatabaseType, userId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM email_log
         WHERE user_id = ?
           AND status IN ('sent','opened','clicked')
           AND created_at >= datetime('now', ?)
         LIMIT 1`,
    )
    .get(userId, `-${config.emailGlobalCooldownHours} hours`) as
    | { 1: number }
    | undefined;
  return !!row;
}

function isInTypeCooldown(
  db: DatabaseType,
  userId: string,
  type: EmailNotificationType,
  cooldownHours: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM email_log
         WHERE user_id = ? AND type = ?
           AND status IN ('sent','opened','clicked')
           AND created_at >= datetime('now', ?)
         LIMIT 1`,
    )
    .get(userId, type, `-${cooldownHours} hours`) as { 1: number } | undefined;
  return !!row;
}

function insertLogRow(
  db: DatabaseType,
  userId: string,
  toAddress: string,
  type: EmailNotificationType,
  options: SendMarketingOptions,
  status: string,
): number {
  const r = db
    .prepare(
      `INSERT INTO email_log
         (user_id, template_id, type, to_address, subject, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      options.templateId ?? null,
      type,
      toAddress,
      options.subject,
      status,
    );
  return r.lastInsertRowid as number;
}

function logSuppressed(
  db: DatabaseType,
  userId: string,
  toAddress: string,
  type: EmailNotificationType,
  options: SendMarketingOptions,
  reason: EmailSkipReason,
): void {
  db.prepare(
    `INSERT INTO email_log
       (user_id, template_id, type, to_address, subject, status, error_message)
     VALUES (?, ?, ?, ?, ?, 'suppressed', ?)`,
  ).run(
    userId,
    options.templateId ?? null,
    type,
    toAddress,
    options.subject,
    reason,
  );
}

/**
 * Append a styled unsubscribe footer to an HTML body. Called once per
 * send so every marketing email carries a visible opt-out link.
 */
function appendUnsubscribeFooter(html: string, unsubUrl: string): string {
  // If the caller has already wrapped the body in our layout we insert
  // the footer before the closing layout footer. Otherwise we wrap + add.
  const footer = `
    <p style="margin:24px 0 0;font-size:11px;color:#a1a1aa;line-height:1.5;text-align:center;">
      You are receiving this because you opted in to Price Games emails.
      <br>
      <a href="${escapeHtml(unsubUrl)}" style="color:#71717a;text-decoration:underline;">Unsubscribe from this type</a>
      &nbsp;·&nbsp;
      <a href="${escapeHtml(unsubUrl)}&amp;all=1" style="color:#71717a;text-decoration:underline;">Unsubscribe from all</a>
    </p>`;

  if (html.includes("</body>")) {
    // Insert before the closing body tag so it stays inside the layout.
    return html.replace("</body>", `${footer}</body>`);
  }
  // No layout — wrap the bare content and append the footer.
  return wrapInLayout(`${html}${footer}`);
}

// ── Helpers for building marketing content ──────────────────────────────────

/**
 * Build the standard marketing email layout (header + content + button
 * + footer). Exposed so the scheduler's default templates can reuse the
 * existing transactional chrome without duplicating HTML.
 *
 * @param content - Inner HTML (paragraphs, etc.) to place above the CTA.
 * @param cta - Optional `{ url, label }` CTA button block.
 */
export function buildMarketingHtml(
  content: string,
  cta?: { url: string; label: string },
): string {
  const ctaHtml = cta ? buttonHtml(cta.url, cta.label) : "";
  return wrapInLayout(`${content}${ctaHtml}`);
}

// ── Row mappers ─────────────────────────────────────────────────────────────

function rowToEmailTemplate(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    name: row.name,
    type: row.type as EmailNotificationType,
    subjectTemplate: row.subject_template,
    htmlTemplate: row.html_template,
    textTemplate: row.text_template,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEmailLogEntry(row: EmailLogRow): EmailLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    templateId: row.template_id,
    type: row.type as EmailNotificationType,
    toAddress: row.to_address,
    subject: row.subject,
    status: row.status as EmailLogEntry["status"],
    providerMessageId: row.provider_message_id,
    errorMessage: row.error_message,
    sentAt: row.sent_at,
    openedAt: row.opened_at,
    clickedAt: row.clicked_at,
    createdAt: row.created_at,
  };
}

function rowToTriggerConfig(row: TriggerConfigRow): EmailTriggerConfig {
  return {
    type: row.type as EmailNotificationType,
    isEnabled: row.is_enabled === 1,
    cooldownHours: row.cooldown_hours,
    thresholdJson: row.threshold_json,
    templateId: row.template_id,
    updatedAt: row.updated_at,
  };
}
