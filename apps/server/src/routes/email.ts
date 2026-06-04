/**
 * User-facing email preference and unsubscribe routes.
 *
 * Provides:
 *  - GET/PUT `/api/email/preferences` — the signed-in user's opt-ins.
 *  - GET/POST `/api/email/unsubscribe` — one-click unsubscribe via an
 *    HMAC-signed token; supports both a click-through landing page and
 *    the RFC 8058 `List-Unsubscribe-Post: One-Click` POST variant used
 *    by Gmail and Apple Mail.
 *  - POST `/api/email/webhook/resend` — optional Resend webhook that
 *    maps delivery / bounce / complaint events to `email_log` rows and
 *    auto-suppresses hard-bounced addresses.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { requireUser, setDb } from "../middleware/userAuth";
import {
  getEmailPreferences,
  updateEmailPreferences,
  recordUnsubscribe,
} from "../services/emailNotification";
import { verifyUnsubToken } from "../services/emailUnsubToken";
import type { EmailPreferences } from "@price-game/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/** Module-level database reference; lazily resolved from ../db when not injected. */
let _db: DatabaseType;

/** Return the active database instance. */
function getDb(): DatabaseType {
  if (!_db) {
    _db = require("../db").default;
  }
  return _db;
}

/**
 * Factory for the user-facing email router. Injecting `db` is used by
 * tests; otherwise falls back to the default export from `../db`.
 *
 * @param db - Optional database instance.
 * @returns Express Router mounted at `/api/email`.
 */
export function createEmailRouter(db?: DatabaseType): Router {
  if (db) {
    _db = db;
    setDb(db);
  }

  const router = Router();

  // GET /preferences — current user's email preferences
  router.get("/preferences", requireUser, (req: Request, res: Response) => {
    try {
      res.json(getEmailPreferences(getDb(), req.user!.id));
    } catch (err) {
      console.error("Get email preferences error:", err);
      res.status(500).json({ error: "Failed to get email preferences" });
    }
  });

  // PUT /preferences — update current user's email preferences
  router.put("/preferences", requireUser, (req: Request, res: Response) => {
    try {
      const prefs = req.body as Partial<EmailPreferences>;

      if (prefs.preferredHour !== undefined) {
        if (
          typeof prefs.preferredHour !== "number" ||
          !Number.isFinite(prefs.preferredHour) ||
          prefs.preferredHour < 0 ||
          prefs.preferredHour > 23
        ) {
          res.status(400).json({ error: "preferredHour must be an integer in [0, 23]" });
          return;
        }
      }
      if (prefs.timezone !== undefined && typeof prefs.timezone !== "string") {
        res.status(400).json({ error: "timezone must be a string" });
        return;
      }

      updateEmailPreferences(getDb(), req.user!.id, prefs);
      res.json(getEmailPreferences(getDb(), req.user!.id));
    } catch (err) {
      console.error("Update email preferences error:", err);
      res.status(500).json({ error: "Failed to update email preferences" });
    }
  });

  // GET /unsubscribe — HTML landing page for click-through unsubscribe.
  // Verifies the HMAC token, flips the matching preference, records the
  // event in email_unsubscribes, and renders a plain confirmation page.
  // Public — tokens are the authorization mechanism.
  router.get("/unsubscribe", (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const all = req.query.all === "1" || req.query.all === "true";

    const payload = verifyUnsubToken(token);
    if (!payload) {
      res.status(400).type("html").send(unsubscribeHtml({
        ok: false,
        heading: "Invalid or expired link",
        message:
          "This unsubscribe link is not valid. It may have expired, or the " +
          "URL was copied incorrectly. Visit your account settings to manage " +
          "email preferences.",
      }));
      return;
    }

    const type = all ? "all" : payload.type;
    try {
      recordUnsubscribe(getDb(), payload.userId, type, "one_click");
    } catch (err) {
      console.error("Unsubscribe error:", err);
      res.status(500).type("html").send(unsubscribeHtml({
        ok: false,
        heading: "Something went wrong",
        message: "We couldn't process your unsubscribe right now. Please try again later.",
      }));
      return;
    }

    const label =
      type === "all"
        ? "You've been unsubscribed from all Price Games emails."
        : `You've been unsubscribed from ${prettyTypeName(type)} emails.`;
    res.type("html").send(unsubscribeHtml({
      ok: true,
      heading: "Unsubscribed",
      message: label,
    }));
  });

  // POST /unsubscribe — RFC 8058 one-click variant. Gmail/Apple Mail
  // POST here when the user clicks the inline "Unsubscribe" link.
  router.post("/unsubscribe", (req: Request, res: Response) => {
    const tokenFromQuery =
      typeof req.query.token === "string" ? req.query.token : "";
    const tokenFromBody =
      typeof req.body?.token === "string" ? (req.body.token as string) : "";
    const token = tokenFromQuery || tokenFromBody;
    const all = req.query.all === "1" || req.query.all === "true";

    const payload = verifyUnsubToken(token);
    if (!payload) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }
    try {
      recordUnsubscribe(
        getDb(),
        payload.userId,
        all ? "all" : payload.type,
        "list_unsubscribe_header",
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("Unsubscribe POST error:", err);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  // POST /webhook/resend — Resend webhook receiver.
  //
  // Authentication model:
  //   - If RESEND_WEBHOOK_SECRET is unset, the endpoint is disabled
  //     entirely (503). This prevents the earlier bug where an
  //     unauthenticated caller could force-unsubscribe any user whose
  //     provider_message_id they could guess, by POSTing a synthetic
  //     `email.bounced` event.
  //   - When set, the request must carry a valid `Svix-Signature`
  //     header (the header format Resend documents for its webhooks:
  //     "v1,<b64(hmac_sha256(signing_secret, timestamp.body))>"). We
  //     compare in constant time. On mismatch we 401.
  router.post("/webhook/resend", (req: Request, res: Response) => {
    if (!config.emailResendWebhookSecret) {
      res
        .status(503)
        .json({ error: "Webhook endpoint not configured (RESEND_WEBHOOK_SECRET unset)" });
      return;
    }
    if (!verifyResendSignature(req, config.emailResendWebhookSecret)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
    try {
      handleResendWebhook(getDb(), req);
      res.json({ ok: true });
    } catch (err) {
      console.error("Resend webhook error:", err);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify a Resend webhook signature. Resend uses Svix, which signs
 * requests with `<b64(hmac_sha256(secret, svix_id.svix_timestamp.body))>`
 * and places the result in the `svix-signature` header prefixed with a
 * version tag (e.g. `v1,<sig>`). We accept any version in a
 * comma-separated list and compare in constant time.
 *
 * Returns true if the request is authentic.
 */
function verifyResendSignature(req: Request, secret: string): boolean {
  const svixId = req.header("svix-id");
  const svixTimestamp = req.header("svix-timestamp");
  const svixSignature = req.header("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject very old timestamps (±5 min) to block replay attacks.
  const tsNum = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 5 * 60) return false;

  // Resend / Svix sign the canonical body; re-stringify req.body since
  // express.json() has already consumed the raw bytes. This matches
  // webhook providers that JSON-normalize server-side.
  const body =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const toSign = `${svixId}.${svixTimestamp}.${body}`;

  // Secret comes in as `whsec_<base64>` (Svix convention); strip the
  // prefix and base64-decode to get the signing key.
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return false;
  }

  const expected = createHmac("sha256", key).update(toSign).digest("base64");

  // Header is a space-separated list of "vN,<sig>" pairs. Accept any.
  for (const pair of svixSignature.split(" ")) {
    const parts = pair.split(",");
    if (parts.length !== 2) continue;
    const provided = Buffer.from(parts[1], "base64");
    const expectedBuf = Buffer.from(expected, "base64");
    if (provided.length !== expectedBuf.length) continue;
    if (timingSafeEqual(provided, expectedBuf)) return true;
  }
  return false;
}

function prettyTypeName(type: string): string {
  switch (type) {
    case "streak_risk": return "streak-at-risk";
    case "streak_save": return "streak-save";
    case "inactivity_reminder": return "come-back";
    case "weekly_digest": return "weekly digest";
    case "promotional": return "promotional";
    case "giveaway_loss": return "giveaway results";
    default: return type.replace(/_/g, " ");
  }
}

function unsubscribeHtml(opts: {
  ok: boolean;
  heading: string;
  message: string;
}): string {
  const accent = opts.ok ? "#18181b" : "#991b1b";
  // Escape heading + message so a future code path that feeds user- or
  // type-controlled strings through here can't inject HTML. The
  // current callers pass safe literals but we defend at the edge.
  const heading = escapeHtmlText(opts.heading);
  const message = escapeHtmlText(opts.message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${heading} — Price Games</title>
  <style>
    body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
           background:#f4f4f5;color:#18181b;margin:0;padding:60px 20px;line-height:1.55; }
    .card { max-width:520px;margin:0 auto;background:#fff;border-radius:12px;
            padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.06); }
    h1 { margin:0 0 12px;font-size:22px;color:${accent}; }
    p { margin:0 0 12px;color:#3f3f46;font-size:15px; }
    a { color:#18181b;font-weight:600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    <p style="margin-top:24px"><a href="/settings">Go to email preferences</a></p>
  </div>
</body>
</html>`;
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

interface ResendWebhookEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
  };
}

/**
 * Handle a Resend webhook payload. We recognize:
 *   - `email.delivered`   → no status change (already 'sent')
 *   - `email.opened`      → flip to 'opened' + set opened_at
 *   - `email.clicked`     → flip to 'clicked' + set clicked_at
 *   - `email.bounced`     → flip to 'bounced', record unsubscribe-all
 *   - `email.complained`  → flip to 'complained', record unsubscribe-all
 *
 * Silent no-op for other event types. Relies on
 * `provider_message_id` to locate the log row.
 */
function handleResendWebhook(db: DatabaseType, req: Request): void {
  const body = req.body as ResendWebhookEvent | undefined;
  if (!body || typeof body.type !== "string") return;
  const id = body.data?.email_id;
  if (!id) return;

  const row = db
    .prepare(
      `SELECT id, user_id FROM email_log WHERE provider_message_id = ? LIMIT 1`,
    )
    .get(id) as { id: number; user_id: string | null } | undefined;
  if (!row) return;

  switch (body.type) {
    case "email.opened":
      db.prepare(
        `UPDATE email_log
           SET status = 'opened', opened_at = COALESCE(opened_at, datetime('now'))
         WHERE id = ?`,
      ).run(row.id);
      return;
    case "email.clicked":
      db.prepare(
        `UPDATE email_log
           SET status = 'clicked', clicked_at = COALESCE(clicked_at, datetime('now'))
         WHERE id = ?`,
      ).run(row.id);
      return;
    case "email.bounced":
      db.prepare(
        `UPDATE email_log SET status = 'bounced' WHERE id = ?`,
      ).run(row.id);
      if (row.user_id) {
        recordUnsubscribe(db, row.user_id, "all", "complaint");
      }
      return;
    case "email.complained":
      db.prepare(
        `UPDATE email_log SET status = 'complained' WHERE id = ?`,
      ).run(row.id);
      if (row.user_id) {
        recordUnsubscribe(db, row.user_id, "all", "complaint");
      }
      return;
    default:
      return;
  }
}
