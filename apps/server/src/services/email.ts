/**
 * Email service — sends transactional emails via Resend.
 *
 * Provides a thin wrapper around the Resend SDK with pre-built templates for
 * email verification, password reset, and reward notifications. Falls back to
 * console logging when no API key is configured (development mode).
 */

import { Resend } from "resend";
import type { Database as DatabaseType } from "better-sqlite3";
import { config } from "../config";
import { tagUrl, tagAndShortenUrl } from "./outboundLinks";

// ── Client ──────────────────────────────────────────────────────────────

let resend: Resend | null = null;
let loggedInit = false;

/**
 * Get or lazily create the Resend client.
 * Returns null when no API key is configured.
 */
function getClient(): Resend | null {
  if (!loggedInit) {
    loggedInit = true;
    if (config.resendApiKey) {
      console.log(`[email] Resend configured (from: ${config.emailFrom})`);
    } else {
      console.log("[email] No RESEND_API_KEY — emails will be logged to console");
    }
  }
  if (!config.resendApiKey) return null;
  if (!resend) {
    resend = new Resend(config.resendApiKey);
  }
  return resend;
}

// ── Shared helpers ──────────────────────────────────────────────────────

/** Options accepted by the generic sendEmail wrapper. */
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback. Some clients (esp. Outlook rules) prefer this. */
  text?: string;
  /** Additional headers — used by marketing email for List-Unsubscribe. */
  headers?: Record<string, string>;
}

/** Result returned from sendEmail. Carries the provider message id so
 *  email_log rows can be correlated with Resend webhook events. */
export interface SendEmailResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * Send an email via Resend. Logs to console in dev mode when no API key
 * is configured (existing dev-loop behavior; preserves backward compat).
 *
 * @param options - Recipient, subject, HTML body, and optional text/headers.
 * @returns Result object with ok flag and optional provider message id.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const client = getClient();

  if (!client) {
    console.log(`[email:dev] To: ${options.to}`);
    console.log(`[email:dev] Subject: ${options.subject}`);
    if (options.headers) {
      console.log(`[email:dev] Headers:`, options.headers);
    }
    console.log(`[email:dev] Body preview: ${options.html.slice(0, 200)}...`);
    return { ok: true };
  }

  try {
    const payload: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text?: string;
      headers?: Record<string, string>;
    } = {
      from: config.emailFrom,
      to: options.to,
      subject: options.subject,
      html: options.html,
    };
    if (options.text) payload.text = options.text;
    if (options.headers) payload.headers = options.headers;

    const { data, error } = await client.emails.send(payload);

    if (error) {
      console.error("[email] Send failed:", error);
      return { ok: false, error: typeof error === "string" ? error : JSON.stringify(error) };
    }

    return { ok: true, providerMessageId: data?.id };
  } catch (err) {
    console.error("[email] Send error:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Legacy boolean-returning wrapper used by the transactional send helpers
 * below. Kept internal so existing callers keep their `Promise<boolean>`
 * contract while marketing email uses the richer result shape.
 */
async function send(options: SendEmailOptions): Promise<boolean> {
  const result = await sendEmail(options);
  return result.ok;
}

// ── Email layout ────────────────────────────────────────────────────────

/**
 * Wrap raw HTML in the shared Price Games email layout (header + body +
 * footer with a copyright line). Exported so marketing emails render
 * inside the same chrome as transactional emails.
 */
export function wrapInLayout(content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#18181b;padding:24px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Price Games</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background:#f4f4f5;text-align:center;">
              <p style="margin:0;font-size:12px;color:#71717a;">
                &copy; ${new Date().getFullYear()} Price Games. You received this email because you have an account at price.games.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Render a dark-on-white CTA button row. Exported so marketing emails
 * share the same button styling as transactional ones.
 */
export function buttonHtml(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td style="background:#18181b;border-radius:6px;padding:12px 24px;">
      <a href="${safeUrl}" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Send an email verification link to a user.
 *
 * @param to - Recipient email address.
 * @param username - User's display name.
 * @param token - The verification token.
 * @returns true if sent successfully.
 */
export async function sendVerificationEmail(
  to: string,
  username: string,
  token: string,
): Promise<boolean> {
  const url = buildVerifyUrl(token);

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Verify your email</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Hey ${escapeHtml(username)}, welcome to Price Games! Click the button below to verify your email address.
    </p>
    ${buttonHtml(url, "Verify Email")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      If you didn't create an account, you can safely ignore this email. This link expires in 24 hours.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;word-break:break-all;">
      Or copy this link: ${escapeHtml(url)}
    </p>
  `);

  return send({ to, subject: "Verify your email — Price Games", html });
}

/**
 * Build the verify-email URL. Exposed only to keep `sendVerificationEmail`
 * readable; the URL is per-recipient (token-bound) so we apply UTMs but
 * never short-link it.
 */
function buildVerifyUrl(token: string): string {
  return tagUrl(`${config.appUrl}/verify-email?token=${token}`, "email:verify");
}

/**
 * Send a password reset link to a user.
 *
 * @param to - Recipient email address.
 * @param username - User's display name.
 * @param token - The password reset token.
 * @returns true if sent successfully.
 */
export async function sendPasswordResetEmail(
  to: string,
  username: string,
  token: string,
): Promise<boolean> {
  const url = tagUrl(`${config.appUrl}/reset-password?token=${token}`, "email:password_reset");

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Reset your password</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Hi ${escapeHtml(username)}, we received a request to reset your password. Click the button below to choose a new one.
    </p>
    ${buttonHtml(url, "Reset Password")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      If you didn't request this, you can safely ignore this email. This link expires in 1 hour.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;word-break:break-all;">
      Or copy this link: ${escapeHtml(url)}
    </p>
  `);

  return send({ to, subject: "Reset your password — Price Games", html });
}

/**
 * Format a reward amount in cents as `$X.XX`.
 */
function formatAmount(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * Map a reward_type identifier to a human-readable label for email copy.
 */
function rewardLabel(rewardType: string): string {
  return rewardType === "amazon_gift_card" ? "Amazon Gift Card" : "Reward";
}

/**
 * Format an ISO timestamp as a long-form UTC date for deadline copy
 * (e.g. "June 2, 2026"). Email clients render in many locales — the
 * explicit date avoids ambiguity from "in 30 days" wording.
 */
function formatDeadline(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Send the winner notification when a reward is awarded. The CTA links to
 * the per-award claim URL — clicking it is the canonical claim path. The
 * body explicitly states the 30-day deadline so unclaimed-and-revoked
 * isn't a surprise.
 *
 * @param to - Recipient email address.
 * @param username - User's display name.
 * @param amountCents - Reward amount in cents.
 * @param rewardType - Type of reward (e.g. "amazon_gift_card").
 * @param claimUrl - Per-award claim URL (`/claim/:token`).
 * @param claimExpiresAt - ISO timestamp of the claim deadline.
 * @returns true if sent successfully.
 */
export async function sendRewardAwardedEmail(
  to: string,
  username: string,
  amountCents: number,
  rewardType: string,
  claimUrl: string,
  claimExpiresAt: string,
): Promise<boolean> {
  const amount = formatAmount(amountCents);
  const label = rewardLabel(rewardType);
  const deadline = formatDeadline(claimExpiresAt);

  // Per-recipient claim URL is short-link-incompatible (one short code
  // can't encode a unique-per-user token). Append UTMs directly so the
  // landing-page attribution capture sees this email as the source.
  const taggedClaimUrl = tagUrl(claimUrl, "email:reward_awarded");

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">You've won a reward!</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Congratulations ${escapeHtml(username)}! You've been awarded a <strong>${amount} ${escapeHtml(label)}</strong>.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Click the button below to claim your reward and reveal the gift card code.
      You must claim by <strong>${escapeHtml(deadline)}</strong> (within 30 days);
      after that the reward returns to the pool.
    </p>
    ${buttonHtml(taggedClaimUrl, "Claim Your Reward")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      Rewards must be claimed from your account. Don't share this email with anyone.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;word-break:break-all;">
      Or copy this link: ${escapeHtml(taggedClaimUrl)}
    </p>
  `);

  return send({ to, subject: `You won a ${amount} ${label}! — Price Games`, html });
}

/**
 * Send a claim-deadline reminder. Three cadences fire on a single award:
 * 15 / 7 / 1 days remaining. The 1-day variant uses urgency wording.
 *
 * Reminders are transactional follow-ups to the original winner email and
 * intentionally bypass per-user marketing preferences — the user already
 * received the original (transactional) award notification, and the
 * reminder is functionally part of that same transaction.
 *
 * @param to - Recipient email address.
 * @param username - User's display name.
 * @param amountCents - Reward amount in cents.
 * @param daysLeft - One of 15, 7, 1 — used to inflect copy.
 * @param claimExpiresAt - ISO timestamp of the claim deadline.
 * @param claimUrl - Per-award claim URL.
 * @returns true if sent successfully.
 */
export async function sendClaimReminderEmail(
  to: string,
  username: string,
  amountCents: number,
  daysLeft: 15 | 7 | 1,
  claimExpiresAt: string,
  claimUrl: string,
): Promise<boolean> {
  const amount = formatAmount(amountCents);
  const deadline = formatDeadline(claimExpiresAt);

  const isFinal = daysLeft === 1;
  const headline = isFinal
    ? "Last chance to claim your reward"
    : `${daysLeft} days left to claim your reward`;
  const subjectLine = isFinal
    ? `Last chance — claim your ${amount} reward today`
    : `${daysLeft} days left — claim your ${amount} reward`;
  const urgencyLine = isFinal
    ? `This is your final reminder — your reward expires <strong>tomorrow (${escapeHtml(deadline)})</strong>. After that it returns to the pool and can no longer be claimed.`
    : `Your reward will expire on <strong>${escapeHtml(deadline)}</strong>. If you don't claim it by then, it returns to the pool and can no longer be claimed.`;

  // Cadence-specific UTM content lets the funnel split engagement by
  // remaining-days bucket (15d / 7d / 1d) without us needing separate
  // template names. Keys must match outboundOrigins.ts.
  const originKey =
    daysLeft === 15
      ? "email:reward_reminder_15d"
      : daysLeft === 7
        ? "email:reward_reminder_7d"
        : "email:reward_reminder_1d";
  const taggedClaimUrl = tagUrl(claimUrl, originKey);

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">${escapeHtml(headline)}</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Hi ${escapeHtml(username)} — you still have an unclaimed <strong>${amount} reward</strong>
      waiting for you.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      ${urgencyLine}
    </p>
    ${buttonHtml(taggedClaimUrl, "Claim Your Reward")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      Don't share this link with anyone.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;word-break:break-all;">
      Or copy this link: ${escapeHtml(taggedClaimUrl)}
    </p>
  `);

  return send({ to, subject: `${subjectLine} — Price Games`, html });
}

/**
 * Send the final notification when an unclaimed reward has expired and
 * been returned to the pool. Sent exactly once per voided award by the
 * sweeper.
 *
 * @param db - Database instance, used to materialize the system-managed
 *   short-link for the dashboard CTA.
 * @param to - Recipient email address.
 * @param username - User's display name.
 * @param amountCents - Reward amount in cents.
 * @param rewardType - Type of reward (e.g. "amazon_gift_card").
 * @returns true if sent successfully.
 */
export async function sendRewardExpiredEmail(
  db: DatabaseType,
  to: string,
  username: string,
  amountCents: number,
  rewardType: string,
): Promise<boolean> {
  const amount = formatAmount(amountCents);
  const label = rewardLabel(rewardType);

  // Static dashboard CTA — route through a system short link so click
  // counts roll up under the `email:reward_expired` origin row.
  const playUrl = tagAndShortenUrl(db, config.appUrl, "email:reward_expired");

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Your reward has expired</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Hi ${escapeHtml(username)} — your <strong>${amount} ${escapeHtml(label)}</strong> went unclaimed for 30 days
      and has been returned to the reward pool.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Keep playing — every game you play counts toward future giveaways.
    </p>
    ${buttonHtml(playUrl, "Play again")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      We hope to see you back on price.games soon.
    </p>
  `);

  return send({ to, subject: `Your ${amount} ${label} reward has expired — Price Games`, html });
}

/**
 * Period descriptor for the giveaway-loss email. Mirrors the period keys
 * accepted by `executeRandomRoll` so the wording can stay accurate
 * regardless of how the admin scoped the draw.
 */
export type GiveawayPeriod =
  | "last_week"
  | "last_month"
  | "last_3_months"
  | "all_time"
  | "calendar_month";

/**
 * Build the consolation email sent to qualifying-but-not-winning players
 * after an admin runs a random-roll giveaway draw. Returns subject, html
 * and plain-text bodies — actual sending is delegated to
 * `sendMarketingEmail` so unsubscribe headers, cooldowns, and
 * `email_log` rows are guaranteed.
 *
 * @param db - Database instance, used to materialize the system-managed
 *   short-link for the "Play again" CTA.
 * @param params.username - Recipient's display name (escaped in HTML).
 * @param params.period - Qualifying period key from the draw criteria.
 * @returns Rendered subject + html + text strings.
 */
export function buildGiveawayLossEmail(
  db: DatabaseType,
  params: {
    username: string;
    period: GiveawayPeriod;
    /**
     * Optional. When `period` is `calendar_month`, supply the draw's month
     * label (e.g. "April 2026") so the body copy reads "April 2026's
     * Price Games giveaway" instead of falling through to "the latest".
     */
    monthLabel?: string;
  },
): { subject: string; html: string; text: string } {
  const { username, period, monthLabel } = params;
  // Same system short link in the HTML CTA and the plain-text body so
  // the click counter on the `email:giveaway_loss` row tracks both.
  const playUrl = tagAndShortenUrl(db, config.appUrl, "email:giveaway_loss");

  // Map the admin-facing period key onto a more natural English phrase
  // for the body copy. "calendar_month" uses the explicit month label
  // when supplied; "all_time" is uncommon and kept for completeness.
  const periodPhrase =
    period === "last_week"
      ? "this week's"
      : period === "last_month"
        ? "this month's"
        : period === "last_3_months"
          ? "this quarter's"
          : period === "calendar_month" && monthLabel
            ? `${monthLabel}'s`
            : "the latest";
  const nextPhrase =
    period === "last_week"
      ? "next week's"
      : period === "last_month"
        ? "next month's"
        : period === "last_3_months"
          ? "next quarter's"
          : period === "calendar_month"
            ? "next month's"
            : "the next";

  const subject = `Better luck next time — ${periodPhrase} Price Games giveaway`;

  const html = wrapInLayout(`
    <h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Thanks for playing!</h2>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      Hey ${escapeHtml(username)} — ${escapeHtml(periodPhrase)} Price Games giveaway has just been drawn, and unfortunately your name wasn't the one that came up this time.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#3f3f46;line-height:1.6;">
      The good news: every game you play counts you in for ${escapeHtml(nextPhrase)} draw. Drop by, guess a few prices, and we'll see you in the next pool.
    </p>
    ${buttonHtml(playUrl, "Play again")}
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      We hope to see you back on price.games soon.
    </p>
  `);

  const text = `Hey ${username},

${periodPhrase} Price Games giveaway has just been drawn, and unfortunately your name wasn't the one that came up this time.

The good news: every game you play counts you in for ${nextPhrase} draw. Drop by, guess a few prices, and we'll see you in the next pool.

Play again: ${playUrl}

We hope to see you back on price.games soon.
`;

  return { subject, html, text };
}

// ── Utilities ───────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS in email templates.
 *
 * @param str - Raw string.
 * @returns Escaped string safe for HTML insertion.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
