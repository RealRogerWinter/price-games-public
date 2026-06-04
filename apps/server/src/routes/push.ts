/**
 * User-facing push notification REST API routes.
 *
 * Provides subscription management, preference CRUD, VAPID key endpoint,
 * and click tracking. Uses a factory pattern so tests can inject a custom
 * database instance.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { requireUser, setDb } from "../middleware/userAuth";
import {
  saveSubscription,
  removeSubscription,
  getPreferences,
  updatePreferences,
  recordClick,
} from "../services/pushNotification";
import type { PushSubscriptionPayload, NotificationPreferences } from "@price-game/shared";
import { config } from "../config";

/** Module-level database reference; lazily resolved from ../db when not injected. */
let _db: DatabaseType;

/**
 * Return the active database instance, falling back to the default export
 * from ../db if none was injected via createPushRouter.
 *
 * @returns The database instance.
 */
function getDb(): DatabaseType {
  if (!_db) {
    _db = require("../db").default;
  }
  return _db;
}

/**
 * Create and return an Express Router with all push notification endpoints.
 *
 * @param db - Optional database instance (useful for testing).
 * @returns Configured Express Router.
 */
export function createPushRouter(db?: DatabaseType): Router {
  if (db) {
    _db = db;
    setDb(db);
  }

  const router = Router();

  // GET /vapid-key — Return the VAPID public key (no auth required)
  router.get("/vapid-key", (_req: Request, res: Response) => {
    if (!config.vapidPublicKey) {
      res.status(503).json({ error: "Push notifications not configured" });
      return;
    }
    res.json({ vapidPublicKey: config.vapidPublicKey });
  });

  // POST /subscribe — Save a push subscription
  router.post("/subscribe", requireUser, (req: Request, res: Response) => {
    try {
      const subscription = req.body as PushSubscriptionPayload;

      if (
        !subscription?.endpoint ||
        !subscription?.keys?.p256dh ||
        !subscription?.keys?.auth
      ) {
        res.status(400).json({ error: "Invalid push subscription payload" });
        return;
      }

      // Basic endpoint URL validation
      try {
        new URL(subscription.endpoint);
      } catch {
        res.status(400).json({ error: "Invalid subscription endpoint URL" });
        return;
      }

      saveSubscription(
        getDb(),
        req.user!.id,
        subscription,
        req.visitorId ?? null,
        req.headers["user-agent"],
      );

      res.json({ ok: true });
    } catch (err) {
      console.error("Push subscribe error:", err);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  // POST /unsubscribe — Remove a push subscription
  router.post("/unsubscribe", requireUser, (req: Request, res: Response) => {
    try {
      const { endpoint } = req.body;

      if (typeof endpoint !== "string" || !endpoint) {
        res.status(400).json({ error: "endpoint is required" });
        return;
      }

      const removed = removeSubscription(
        getDb(),
        req.user!.id,
        endpoint,
      );

      res.json({ ok: true, removed });
    } catch (err) {
      console.error("Push unsubscribe error:", err);
      res.status(500).json({ error: "Failed to remove subscription" });
    }
  });

  // GET /preferences — Get notification preferences
  router.get("/preferences", requireUser, (req: Request, res: Response) => {
    try {
      const prefs = getPreferences(
        getDb(),
        req.user!.id,
      );
      res.json(prefs);
    } catch (err) {
      console.error("Get preferences error:", err);
      res.status(500).json({ error: "Failed to get preferences" });
    }
  });

  // PUT /preferences — Update notification preferences
  router.put("/preferences", requireUser, (req: Request, res: Response) => {
    try {
      const prefs = req.body as Partial<NotificationPreferences>;

      // Validate timezone if provided
      if (prefs.timezone !== undefined && typeof prefs.timezone !== "string") {
        res.status(400).json({ error: "Invalid timezone" });
        return;
      }

      // Validate quiet hours format if provided (HH:MM, valid 00:00–23:59)
      const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (prefs.quietHoursStart !== undefined && prefs.quietHoursStart !== null) {
        if (!timeRegex.test(prefs.quietHoursStart)) {
          res.status(400).json({ error: "quietHoursStart must be in HH:MM format" });
          return;
        }
      }
      if (prefs.quietHoursEnd !== undefined && prefs.quietHoursEnd !== null) {
        if (!timeRegex.test(prefs.quietHoursEnd)) {
          res.status(400).json({ error: "quietHoursEnd must be in HH:MM format" });
          return;
        }
      }

      updatePreferences(
        getDb(),
        req.user!.id,
        prefs,
      );

      const updated = getPreferences(
        getDb(),
        req.user!.id,
      );
      res.json(updated);
    } catch (err) {
      console.error("Update preferences error:", err);
      res.status(500).json({ error: "Failed to update preferences" });
    }
  });

  // GET /click/:logId — Record a notification click and redirect
  // Only allows relative paths (starting with /) to prevent open redirects.
  router.get("/click/:logId", (req: Request, res: Response) => {
    try {
      const logId = parseInt(req.params.logId as string, 10);
      if (isNaN(logId)) {
        res.redirect("/");
        return;
      }

      const raw = typeof req.query.r === "string" ? req.query.r : "";
      // Reject anything that isn't a relative path (blocks //, http://, etc.)
      const redirectUrl = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
      recordClick(getDb(), logId);

      res.redirect(redirectUrl);
    } catch {
      res.redirect("/");
    }
  });

  return router;
}
