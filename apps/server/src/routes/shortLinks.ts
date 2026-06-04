/**
 * Public `/go/:code` short-link redirect router.
 *
 * A very small, auth-free router that:
 *   1. Looks up the UTM tag whose `short_code` matches the path param
 *      (after lowercasing).
 *   2. Atomically increments the per-tag click counter via
 *      `recordShortCodeClick` (a single SQL `UPDATE ... RETURNING`).
 *   3. On success, 302-redirects to the long UTM URL built by
 *      `buildTagUrl`, with `Cache-Control: no-store` and
 *      `X-Robots-Tag: noindex` headers.
 *   4. On miss, returns 404 with the same `X-Robots-Tag: noindex` header
 *      so search engines do not index 404 URLs.
 *
 * Archived tags still resolve — printed or embedded URLs (QR codes on
 * flyers, social posts) would otherwise 404 after a campaign is archived.
 * Archive is a UI-level filter only.
 *
 * No IP, user agent, or referer is stored — privacy is a first-class
 * design decision for this feature.
 */

import { Router, Request, Response, RequestHandler } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { buildTagUrl, recordShortCodeClick } from "../services/utmTags";
import { config } from "../config";

/**
 * Create the short-link router.
 *
 * @param injectedDb - Optional database instance. When omitted, the router
 *   lazily resolves the default export from `../db` on the first request.
 *   Injection is used by tests so they can run against a throwaway in-memory
 *   DB.
 * @param rateLimit - Optional rate-limit middleware applied only to the
 *   `/go/:code` route (not to the router as a whole), so mounting this
 *   router does not accidentally limit every request on the host app. Tests
 *   typically omit the limiter; production wiring passes `apiLimiter`.
 * @param baseUrlOverride - Optional base URL override, used by tests to
 *   inject a known origin so the 302 Location header is deterministic.
 *   Defaults to `config.appUrl` in production.
 * @returns Configured Express router.
 */
export function createShortLinkRouter(
  injectedDb?: DatabaseType,
  rateLimit?: RequestHandler,
  baseUrlOverride?: string,
): Router {
  const router = Router();
  let _db: DatabaseType | undefined = injectedDb;

  function getDb(): DatabaseType {
    if (!_db) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _db = require("../db").default as DatabaseType;
    }
    return _db;
  }

  // Use a trusted, server-configured origin instead of `req.get("host")`. A
  // malicious `Host: evil.com` header on a tag with a root-relative
  // destination (`/giveaway`) would otherwise resolve to
  // `https://evil.com/giveaway` via `new URL(...)`, producing an open
  // redirect through this handler. `config.appUrl` is set from the APP_URL
  // env var and is never attacker-controlled.
  const baseUrl = baseUrlOverride ?? config.appUrl;

  const handler: RequestHandler = (req: Request, res: Response) => {
    // Normalize to lowercase so admins pasting a mixed-case code still land.
    const code = String(req.params.code || "").toLowerCase();
    // X-Robots-Tag is set on BOTH the 404 and 302 path: search engines should
    // never index a short link, successful or not.
    res.setHeader("X-Robots-Tag", "noindex");

    const tag = recordShortCodeClick(getDb(), code);
    if (!tag) {
      res.status(404).send("Short link not found.");
      return;
    }

    // Build the absolute long URL from the trusted base URL above.
    // Absolute HTTP(S) destinations ignore the base; only root-relative
    // destinations resolve against it — which is the point of the fix.
    const longUrl = buildTagUrl(tag, baseUrl);

    // no-store: we never want the redirect cached, since the same code
    // should re-enter the counter on every click.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, longUrl);
  };

  if (rateLimit) {
    router.get("/go/:code", rateLimit, handler);
  } else {
    router.get("/go/:code", handler);
  }

  return router;
}
