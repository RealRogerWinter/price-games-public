/**
 * Admin notification management REST API routes.
 *
 * Provides CRUD for notification templates, manual send capabilities,
 * analytics/stats endpoints, and notification log access. All routes
 * require admin authentication via the requireAdmin middleware.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import type { Server } from "socket.io";
import { requireAdmin, setDb } from "../middleware/adminAuth";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  sendPushToUser,
  sendPushToAll,
  getNotificationStats,
  getNotificationLog,
  getSubscriberCounts,
  type PushPayload,
} from "../services/pushNotification";
import type { NotificationType, PushSubscriptionPayload } from "@price-game/shared";
import { NOTIFICATION_TYPES } from "@price-game/shared";

/** Module-level database reference; lazily resolved from ../db when not injected. */
let _db: DatabaseType;

/** Module-level Socket.IO server reference for real-time delivery. */
let _io: Server | undefined;

/**
 * Return the active database instance.
 *
 * @returns The database instance.
 */
function getDb(): DatabaseType {
  if (!_db) {
    _db = require("../db").default;
  }
  return _db;
}

const VALID_TYPES = new Set(Object.values(NOTIFICATION_TYPES));
const VALID_URGENCIES = new Set(["very-low", "low", "normal", "high"]);
const VALID_STATUSES = new Set(["pending", "sent", "clicked", "failed", "expired", "suppressed"]);

/**
 * Create and return an Express Router with admin notification endpoints.
 *
 * @param db - Optional database instance (useful for testing).
 * @param io - Optional Socket.IO server for real-time delivery.
 * @returns Configured Express Router.
 */
export function createAdminNotificationRouter(db?: DatabaseType, io?: Server): Router {
  if (db) {
    _db = db;
    setDb(db);
  }
  if (io) _io = io;

  const router = Router();

  // ── Templates CRUD ──────────────────────────────────────────────────────

  // GET /templates — List all templates
  router.get("/templates", requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ templates: listTemplates(getDb()) });
    } catch (err) {
      console.error("List templates error:", err);
      res.status(500).json({ error: "Failed to list templates" });
    }
  });

  // GET /templates/:id — Get a single template
  router.get("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }
      const template = getTemplate(getDb(), id);
      if (!template) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json(template);
    } catch (err) {
      console.error("Get template error:", err);
      res.status(500).json({ error: "Failed to get template" });
    }
  });

  // POST /templates — Create a new template
  router.post("/templates", requireAdmin, (req: Request, res: Response) => {
    try {
      const { name, type, titleTemplate, bodyTemplate, icon, urlPath, actionsJson, ttl, urgency } = req.body;

      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!type || !VALID_TYPES.has(type)) {
        res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
        return;
      }
      if (!titleTemplate || typeof titleTemplate !== "string") {
        res.status(400).json({ error: "titleTemplate is required" });
        return;
      }
      if (!bodyTemplate || typeof bodyTemplate !== "string") {
        res.status(400).json({ error: "bodyTemplate is required" });
        return;
      }
      if (urgency !== undefined && !VALID_URGENCIES.has(urgency)) {
        res.status(400).json({ error: `urgency must be one of: ${[...VALID_URGENCIES].join(", ")}` });
        return;
      }
      if (urlPath !== undefined && (typeof urlPath !== "string" || !urlPath.startsWith("/"))) {
        res.status(400).json({ error: "urlPath must be a relative path starting with /" });
        return;
      }
      if (icon !== undefined && typeof icon === "string" && !icon.startsWith("/") && !icon.startsWith("https://")) {
        res.status(400).json({ error: "icon must be a relative path or https:// URL" });
        return;
      }
      if (ttl !== undefined && (typeof ttl !== "number" || ttl < 0 || !Number.isInteger(ttl))) {
        res.status(400).json({ error: "ttl must be a non-negative integer" });
        return;
      }

      const template = createTemplate(getDb(), {
        name,
        type,
        titleTemplate,
        bodyTemplate,
        icon,
        urlPath,
        actionsJson,
        ttl,
        urgency,
      });
      res.status(201).json(template);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "A template with this name already exists" });
        return;
      }
      console.error("Create template error:", err);
      res.status(500).json({ error: "Failed to create template" });
    }
  });

  // PUT /templates/:id — Update a template
  router.put("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }

      const existing = getTemplate(getDb(), id);
      if (!existing) {
        res.status(404).json({ error: "Template not found" });
        return;
      }

      const { name, type, titleTemplate, bodyTemplate, icon, urlPath, actionsJson, ttl, urgency, isActive } = req.body;
      if (type !== undefined && !VALID_TYPES.has(type)) {
        res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
        return;
      }
      if (urgency !== undefined && !VALID_URGENCIES.has(urgency)) {
        res.status(400).json({ error: `urgency must be one of: ${[...VALID_URGENCIES].join(", ")}` });
        return;
      }

      const updated = updateTemplate(getDb(), id, {
        name, type, titleTemplate, bodyTemplate, icon, urlPath, actionsJson, ttl, urgency, isActive,
      });
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("UNIQUE constraint")) {
        res.status(409).json({ error: "A template with this name already exists" });
        return;
      }
      console.error("Update template error:", err);
      res.status(500).json({ error: "Failed to update template" });
    }
  });

  // DELETE /templates/:id — Delete a template
  router.delete("/templates/:id", requireAdmin, (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid template ID" });
        return;
      }
      const deleted = deleteTemplate(getDb(), id);
      if (!deleted) {
        res.status(404).json({ error: "Template not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("Delete template error:", err);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // ── Send ────────────────────────────────────────────────────────────────

  // POST /send — Manual send: template + audience
  router.post("/send", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { templateId, userId, title, body, urlPath, type } = req.body;

      let sendTitle: string;
      let sendBody: string;
      let sendType: NotificationType;
      let sendUrl: string | undefined;
      let sendTemplateId: number | undefined;

      if (templateId) {
        // Template-based send
        const template = getTemplate(getDb(), templateId);
        if (!template) {
          res.status(404).json({ error: "Template not found" });
          return;
        }
        const vars = req.body.vars || {};
        sendTitle = renderTemplate(template.titleTemplate, vars);
        sendBody = renderTemplate(template.bodyTemplate, vars);
        sendType = template.type;
        sendUrl = template.urlPath !== "/" ? template.urlPath : undefined;
        sendTemplateId = template.id;
      } else {
        // Ad-hoc send
        if (!title || !body || !type) {
          res.status(400).json({ error: "title, body, and type are required (or provide templateId)" });
          return;
        }
        if (!VALID_TYPES.has(type)) {
          res.status(400).json({ error: `type must be one of: ${[...VALID_TYPES].join(", ")}` });
          return;
        }
        sendTitle = title;
        sendBody = body;
        sendType = type;
        sendUrl = urlPath;
      }

      // Pick a type-appropriate wide hero image so the expanded notification
      // shows meaningful imagery on Chrome/Android. Only set a hero for types
      // where we have a designed asset — unknown types go without. Always-on
      // hero images on every notification are a Chrome mobile spam signal.
      const heroByType: Record<string, string> = {
        daily_puzzle: "/notif/notif-daily.png",
        streak_reminder: "/notif/notif-streak.png",
        multiplayer_invites: "/notif/notif-multiplayer.png",
        promotional: "/notif/notif-promo.png",
      };

      const payload: PushPayload = {
        title: sendTitle,
        body: sendBody,
        icon: "/logo192.png",
        badge: "/badge-96.png",
        url: sendUrl,
        tag: `admin-${sendType}-${Date.now()}`,
      };
      if (heroByType[sendType]) {
        payload.image = heroByType[sendType];
      }

      let sent: number;
      if (userId) {
        sent = await sendPushToUser(getDb(), userId, sendType, payload, { templateId: sendTemplateId, adminOverride: true }, _io);
      } else {
        sent = await sendPushToAll(getDb(), sendType, payload, { templateId: sendTemplateId, adminOverride: true }, _io);
      }

      res.json({ ok: true, sent });
    } catch (err) {
      console.error("Manual send error:", err);
      res.status(500).json({ error: "Failed to send notification" });
    }
  });

  // POST /test — Send test notification to all subscribers (or a specific user)
  router.post("/test", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;

      const payload = {
        title: "Test Notification",
        body: "This is a test push notification from the admin panel.",
        icon: "/logo192.png",
        badge: "/badge-96.png",
        url: "/",
        tag: "admin-test",
      };

      let sent: number;
      if (userId && typeof userId === "string") {
        sent = await sendPushToUser(getDb(), userId, "promotional", payload, { adminOverride: true }, _io);
      } else {
        sent = await sendPushToAll(getDb(), "promotional", payload, { adminOverride: true }, _io);
      }
      res.json({ ok: true, sent });
    } catch (err) {
      console.error("Test send error:", err);
      res.status(500).json({ error: "Failed to send test notification" });
    }
  });

  // ── Analytics ───────────────────────────────────────────────────────────

  // GET /stats — Aggregate notification statistics
  router.get("/stats", requireAdmin, (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string, 10) || 7, 90);
      const stats = getNotificationStats(getDb(), days);
      res.json(stats);
    } catch (err) {
      console.error("Get stats error:", err);
      res.status(500).json({ error: "Failed to get notification stats" });
    }
  });

  // GET /log — Paginated notification log
  router.get("/log", requireAdmin, (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
      const type = req.query.type as NotificationType | undefined;
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

      const result = getNotificationLog(getDb(), { page, limit, type, status, userId });
      res.json({
        entries: result.entries,
        total: result.total,
        page,
        totalPages: Math.ceil(result.total / limit),
      });
    } catch (err) {
      console.error("Get log error:", err);
      res.status(500).json({ error: "Failed to get notification log" });
    }
  });

  // GET /subscribers — Subscriber counts
  router.get("/subscribers", requireAdmin, (_req: Request, res: Response) => {
    try {
      const counts = getSubscriberCounts(getDb());
      res.json(counts);
    } catch (err) {
      console.error("Get subscribers error:", err);
      res.status(500).json({ error: "Failed to get subscriber counts" });
    }
  });

  return router;
}
