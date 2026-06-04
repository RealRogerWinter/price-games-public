/**
 * Anonymous attribution tracking route.
 *
 * Exposes `POST /api/attribution/track` for the web client to report the
 * UTM tuple it captured from the landing URL. The visitorCookie middleware
 * guarantees `req.visitorId` is set by the time this handler runs, so the
 * write can be associated with a stable cookie-backed identity even when
 * the visitor has not registered.
 *
 * First-touch semantics are enforced in the service layer
 * (see `services/visitorAttribution.ts`).
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { validateAttribution } from "../services/attribution";
import { recordVisitorAttribution } from "../services/visitorAttribution";
import { optionalUser } from "../middleware/userAuth";

/**
 * Create the attribution router.
 *
 * @param db - Optional database instance (for tests). Falls back to the
 *   default export from `../db` on the first request.
 * @returns Configured Express Router.
 */
export function createAttributionRouter(db?: DatabaseType): Router {
  let _db = db;
  const getDb = (): DatabaseType => {
    if (!_db) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _db = require("../db").default as DatabaseType;
    }
    return _db;
  };

  const router = Router();

  // POST /track — record a UTM-bearing landing for the current visitor.
  // Body: { attribution: { utm_source, utm_medium, ... } }
  // Returns: { recorded: boolean }
  //
  // Uses optionalUser so that signed-in users can be detected and skipped:
  // a logged-in user clicking a tracked link must NOT create a new
  // unclaimed `visitor_attribution` row, because the admin funnel would
  // then count them as both a signup AND an anonymous play. Their
  // engagement is already attributed via the `users.utm_*` columns
  // (written at their original signup).
  router.post("/track", optionalUser, (req: Request, res: Response) => {
    try {
      const visitorId = req.visitorId;
      if (!visitorId) {
        // Should never happen — visitorCookie middleware runs before routers.
        res.json({ recorded: false });
        return;
      }

      // Skip authenticated users: their cohort is the `users.utm_*`
      // columns, and creating an unclaimed visitor row here would
      // double-count them across the signups and anonymousPlays funnel
      // rows.
      if (req.user) {
        res.json({ recorded: false });
        return;
      }

      const sanitized = validateAttribution(req.body?.attribution);
      if (!sanitized) {
        res.json({ recorded: false });
        return;
      }

      const recorded = recordVisitorAttribution(getDb(), visitorId, sanitized);
      res.json({ recorded });
    } catch (err) {
      console.error("[attribution/track] Failed:", err);
      res.status(500).json({ error: "Failed to record attribution" });
    }
  });

  return router;
}
