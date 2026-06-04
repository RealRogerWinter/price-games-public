/**
 * Public read-only access to the site content pages (About, FAQ, Contact)
 * that are editable from the admin panel. Content is served as JSON and
 * rendered client-side.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import db from "../db";
import {
  getSiteContent,
  getEnabledPages,
  isPageEnabled,
  VALID_CONTENT_KEYS,
} from "../services/siteSettings";

/**
 * Create the public content router. Accepts an optional database accessor
 * for test injection; defaults to the process-wide DB.
 */
export function createContentRouter(getDb: () => DatabaseType = () => db): Router {
  const router = Router();

  // Visibility map for the six public SEO pages. Published as its own
  // endpoint so the client can hide footer links and 404 disabled routes
  // without having to probe each content endpoint individually.
  router.get("/pages-enabled", (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ pages: getEnabledPages(getDb()) });
    } catch {
      res.status(500).json({ error: "Failed to load page visibility" });
    }
  });

  router.get("/:key", (req: Request, res: Response) => {
    const key = typeof req.params.key === "string" ? req.params.key : "";
    if (!VALID_CONTENT_KEYS.has(key)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Gate public fetch on the admin visibility toggle — a disabled page
    // should be indistinguishable from a non-existent route so crawlers
    // and direct URLs both get a clean 404.
    if (!isPageEnabled(getDb(), key)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const content = getSiteContent(getDb(), key);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(content);
    } catch {
      res.status(500).json({ error: "Failed to load content" });
    }
  });

  return router;
}
