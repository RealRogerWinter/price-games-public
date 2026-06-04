/**
 * Admin email management REST API routes.
 *
 * Parallel to `adminNotifications.ts`: provides CRUD for email templates,
 * an ad-hoc / template-based send endpoint, a send-test endpoint, stats
 * + log access, and endpoints to view & tune the admin-configurable
 * email trigger config (enable / disable each trigger, adjust cooldowns,
 * bind a template).
 *
 * All endpoints require an active admin session via `requireAdmin`. We
 * deliberately match the policy used by `adminNotifications.ts`
 * (`requireAdmin` alone, no 2FA enrollment gate) so the two marketing
 * channels stay consistent; flipping the policy can happen globally
 * later if the admin team decides to tighten marketing-route access.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { requireAdmin, setDb } from "../middleware/adminAuth";
import {
  listEmailTemplates,
  getEmailTemplate,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  sendMarketingEmail,
  sendMarketingEmailFromTemplate,
  sendMarketingEmailToAll,
  getEmailStats,
  getEmailLog,
  listTriggerConfigs,
  getTriggerConfig,
  updateTriggerConfig,
  getEmailPreferences,
  updateEmailPreferences,
  renderEmailTemplate,
  renderEmailHtmlTemplate,
  buildMarketingHtml,
} from "../services/emailNotification";
import { EMAIL_NOTIFICATION_TYPES } from "@price-game/shared";
import type { EmailNotificationType, EmailPreferences } from "@price-game/shared";

let _db: DatabaseType;

function getDb(): DatabaseType {
  if (!_db) {
    _db = require("../db").default;
  }
  return _db;
}

const VALID_TYPES = new Set(Object.values(EMAIL_NOTIFICATION_TYPES));
const VALID_STATUSES = new Set([
  "queued",
  "sent",
  "failed",
  "bounced",
  "complained",
  "opened",
  "clicked",
  "suppressed",
]);

/**
 * Factory for the admin email router. Returns an Express Router suitable
 * for mounting at `/api/admin/email`.
 *
 * @param db - Optional database instance for tests.
 * @returns Express Router.
 */
export function createAdminEmailRouter(db?: DatabaseType): Router {
  if (db) {
    _db = db;
    setDb(db);
  }

  const router = Router();

  // ── Templates CRUD ──────────────────────────────────────────────────────

  router.get("/templates", requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ templates: listEmailTemplates(getDb()) });
    } catch (err) {
      console.error("List email templates error:", err);
      res.status(500).json({ error: "Failed to list email templates" });
    }
  });

  router.get("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }
      const template = getEmailTemplate(getDb(), id);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    } catch (err) {
      console.error("Get email template error:", err);
      res.status(500).json({ error: "Failed to get email template" });
    }
  });

  router.post("/templates", requireAdmin, (req: Request, res: Response) => {
    try {
      const { name, type, subjectTemplate, htmlTemplate, textTemplate, isActive } = req.body;

      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!type || !VALID_TYPES.has(type)) {
        res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
        return;
      }
      if (!subjectTemplate || typeof subjectTemplate !== "string") {
        res.status(400).json({ error: "subjectTemplate is required" });
        return;
      }
      if (!htmlTemplate || typeof htmlTemplate !== "string") {
        res.status(400).json({ error: "htmlTemplate is required" });
        return;
      }
      if (
        textTemplate !== undefined &&
        textTemplate !== null &&
        typeof textTemplate !== "string"
      ) {
        res.status(400).json({ error: "textTemplate must be a string or null" });
        return;
      }

      const template = createEmailTemplate(getDb(), {
        name,
        type,
        subjectTemplate,
        htmlTemplate,
        textTemplate: textTemplate ?? null,
        isActive: isActive === false ? false : true,
      });
      res.status(201).json(template);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "A template with this name already exists" });
        return;
      }
      console.error("Create email template error:", err);
      res.status(500).json({ error: "Failed to create email template" });
    }
  });

  router.put("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }
      const existing = getEmailTemplate(getDb(), id);
      if (!existing) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const { name, type, subjectTemplate, htmlTemplate, textTemplate, isActive } = req.body;
      if (type !== undefined && !VALID_TYPES.has(type)) {
        res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
        return;
      }

      const updated = updateEmailTemplate(getDb(), id, {
        name,
        type,
        subjectTemplate,
        htmlTemplate,
        textTemplate,
        isActive,
      });
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "A template with this name already exists" });
        return;
      }
      console.error("Update email template error:", err);
      res.status(500).json({ error: "Failed to update email template" });
    }
  });

  router.delete("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }
      const deleted = deleteEmailTemplate(getDb(), id);
      if (!deleted) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("Delete email template error:", err);
      res.status(500).json({ error: "Failed to delete email template" });
    }
  });

  // ── Send ─────────────────────────────────────────────────────────────────

  // POST /send — Manual send. Two modes:
  //   - template-based: { templateId, vars?, userId? | toAllOptedIn? }
  //   - ad-hoc:         { subject, html, text?, type, userId? | toAllOptedIn? }
  // Both honor { adminOverride: boolean } to bypass cooldown / preference
  // checks. The route is intentionally permissive about audience — if
  // neither userId nor toAllOptedIn is set we default to a single-user
  // safety check rather than blasting everyone.
  router.post("/send", requireAdmin, async (req: Request, res: Response) => {
    try {
      const {
        templateId,
        userId,
        toAllOptedIn,
        subject,
        html,
        text,
        type,
        vars,
        adminOverride,
      } = req.body;

      const override = adminOverride === true;

      if (templateId) {
        if (toAllOptedIn) {
          const template = getEmailTemplate(getDb(), templateId);
          if (!template) {
            res.status(404).json({ error: "Template not found" });
            return;
          }
          const result = await sendMarketingEmailToAll(
            getDb(),
            template.type,
            (user) => {
              const merged = { username: user.username, ...(vars ?? {}) };
              return {
                subject: renderEmailTemplate(template.subjectTemplate, merged),
                html: renderEmailHtmlTemplate(template.htmlTemplate, merged),
                text: template.textTemplate
                  ? renderEmailTemplate(template.textTemplate, merged)
                  : undefined,
                templateId: template.id,
                adminOverride: override,
              };
            },
            { adminOverride: override },
          );
          res.json({ ok: true, ...result });
          return;
        }

        if (!userId || typeof userId !== "string") {
          res.status(400).json({ error: "userId or toAllOptedIn is required" });
          return;
        }
        const r = await sendMarketingEmailFromTemplate(
          getDb(),
          userId,
          templateId,
          vars ?? {},
          { adminOverride: override },
        );
        res.json({ ok: true, sent: r.sent, reason: r.reason });
        return;
      }

      // Ad-hoc send
      if (!subject || typeof subject !== "string") {
        res.status(400).json({ error: "subject is required" });
        return;
      }
      if (!html || typeof html !== "string") {
        res.status(400).json({ error: "html is required" });
        return;
      }
      if (!type || !VALID_TYPES.has(type)) {
        res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
        return;
      }
      // Wrap ad-hoc HTML in our standard marketing chrome unless the admin
      // has pasted a full document already.
      const wrappedHtml = html.trim().toLowerCase().includes("<html")
        ? html
        : buildMarketingHtml(html);

      if (toAllOptedIn) {
        const result = await sendMarketingEmailToAll(
          getDb(),
          type as EmailNotificationType,
          () => ({
            subject,
            html: wrappedHtml,
            text,
            adminOverride: override,
          }),
          { adminOverride: override },
        );
        res.json({ ok: true, ...result });
        return;
      }

      if (!userId || typeof userId !== "string") {
        res.status(400).json({ error: "userId or toAllOptedIn is required" });
        return;
      }
      const r = await sendMarketingEmail(
        getDb(),
        userId,
        type as EmailNotificationType,
        {
          subject,
          html: wrappedHtml,
          text,
          adminOverride: override,
        },
      );
      res.json({ ok: true, sent: r.sent, reason: r.reason });
    } catch (err) {
      console.error("Admin email send error:", err);
      res.status(500).json({ error: "Failed to send email" });
    }
  });

  // POST /send-test — Send a minimal test email to `to` (admin email or
  // whatever operator supplies). Does not hit preferences or the log —
  // intended purely for provider-credential sanity checks.
  router.post("/send-test", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { to, userId, adminOverride } = req.body;
      const override = adminOverride === true;

      if (userId && typeof userId === "string") {
        const r = await sendMarketingEmail(getDb(), userId, "custom", {
          subject: "Test email — Price Games",
          html: buildMarketingHtml(
            `<h2 style="margin:0 0 16px;font-size:18px;color:#18181b;">Test email</h2>
             <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.6;">
               This is a Price Games test email sent from the admin panel.
             </p>`,
          ),
          text: "This is a Price Games test email sent from the admin panel.",
          adminOverride: override,
        });
        res.json({ ok: true, sent: r.sent, reason: r.reason });
        return;
      }

      // Direct-to-address test (no userId, no preferences). Uses the raw
      // sendEmail bypass via a synthetic user-less log row.
      if (to && typeof to === "string") {
        // Lazy import to avoid circular — and we intentionally use the
        // raw sendEmail wrapper because there is no user id to check.
        const { sendEmail } = require("../services/email");
        const result = await sendEmail({
          to,
          subject: "Test email — Price Games",
          html: buildMarketingHtml(
            `<h2>Test email</h2><p>This is a Price Games test email.</p>`,
          ),
        });
        res.json({ ok: result.ok, error: result.error });
        return;
      }

      res.status(400).json({ error: "to or userId is required" });
    } catch (err) {
      console.error("Admin email test send error:", err);
      res.status(500).json({ error: "Failed to send test email" });
    }
  });

  // ── Analytics ────────────────────────────────────────────────────────────

  router.get("/stats", requireAdmin, (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string, 10) || 7, 90);
      res.json(getEmailStats(getDb(), days));
    } catch (err) {
      console.error("Get email stats error:", err);
      res.status(500).json({ error: "Failed to get email stats" });
    }
  });

  router.get("/log", requireAdmin, (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
      const type = req.query.type as EmailNotificationType | undefined;
      const status = req.query.status as string | undefined;
      const userId = req.query.userId as string | undefined;

      if (type && !VALID_TYPES.has(type)) {
        res.status(400).json({ error: "Invalid type filter" });
        return;
      }
      if (status && !VALID_STATUSES.has(status)) {
        res.status(400).json({ error: "Invalid status filter" });
        return;
      }

      const result = getEmailLog(getDb(), { page, limit, type, status, userId });
      res.json({
        entries: result.entries,
        total: result.total,
        page,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (err) {
      console.error("Get email log error:", err);
      res.status(500).json({ error: "Failed to get email log" });
    }
  });

  // ── Triggers ─────────────────────────────────────────────────────────────

  router.get("/triggers", requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ triggers: listTriggerConfigs(getDb()) });
    } catch (err) {
      console.error("List trigger configs error:", err);
      res.status(500).json({ error: "Failed to list trigger configs" });
    }
  });

  router.get("/triggers/:type", requireAdmin, (req: Request, res: Response) => {
    try {
      const type = req.params.type as EmailNotificationType;
      if (!VALID_TYPES.has(type)) {
        res.status(400).json({ error: "Invalid trigger type" });
        return;
      }
      const trigger = getTriggerConfig(getDb(), type);
      if (!trigger) {
        res.status(404).json({ error: "Trigger config not found" });
        return;
      }
      res.json(trigger);
    } catch (err) {
      console.error("Get trigger config error:", err);
      res.status(500).json({ error: "Failed to get trigger config" });
    }
  });

  router.put("/triggers/:type", requireAdmin, (req: Request, res: Response) => {
    try {
      const type = req.params.type as EmailNotificationType;
      if (!VALID_TYPES.has(type)) {
        res.status(400).json({ error: "Invalid trigger type" });
        return;
      }
      const { isEnabled, cooldownHours, thresholdJson, templateId } = req.body;

      if (cooldownHours !== undefined) {
        if (
          typeof cooldownHours !== "number" ||
          !Number.isFinite(cooldownHours) ||
          cooldownHours < 1
        ) {
          res.status(400).json({ error: "cooldownHours must be a positive number" });
          return;
        }
      }
      if (thresholdJson !== undefined && thresholdJson !== null) {
        if (typeof thresholdJson !== "string") {
          res.status(400).json({ error: "thresholdJson must be a JSON string or null" });
          return;
        }
        try {
          JSON.parse(thresholdJson);
        } catch {
          res.status(400).json({ error: "thresholdJson must be valid JSON" });
          return;
        }
      }
      if (templateId !== undefined && templateId !== null) {
        if (typeof templateId !== "number" || !Number.isInteger(templateId)) {
          res.status(400).json({ error: "templateId must be an integer or null" });
          return;
        }
      }

      const updated = updateTriggerConfig(getDb(), type, {
        isEnabled,
        cooldownHours,
        thresholdJson,
        templateId,
      });
      res.json(updated);
    } catch (err) {
      console.error("Update trigger config error:", err);
      res.status(500).json({ error: "Failed to update trigger config" });
    }
  });

  // ── Per-user preferences (admin view/edit) ───────────────────────────────

  router.get("/preferences/:userId", requireAdmin, (req: Request, res: Response) => {
    try {
      const userId = req.params.userId as string;
      res.json(getEmailPreferences(getDb(), userId));
    } catch (err) {
      console.error("Admin get user email prefs error:", err);
      res.status(500).json({ error: "Failed to get preferences" });
    }
  });

  router.put("/preferences/:userId", requireAdmin, (req: Request, res: Response) => {
    try {
      const userId = req.params.userId as string;
      const prefs = req.body as Partial<EmailPreferences>;
      updateEmailPreferences(getDb(), userId, prefs);
      res.json(getEmailPreferences(getDb(), userId));
    } catch (err) {
      console.error("Admin update user email prefs error:", err);
      res.status(500).json({ error: "Failed to update preferences" });
    }
  });

  return router;
}
