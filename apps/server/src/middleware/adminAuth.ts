/**
 * Admin authentication middleware.
 *
 * Provides the `requireAdmin` Express middleware that validates session cookies,
 * and a `cookieOptions` helper for consistent cookie configuration.
 *
 * Uses a `setDb` injection pattern so tests can supply an in-memory database
 * without loading the production db module.
 */

import { Request, Response, NextFunction } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import type { AdminUser } from "@price-game/shared";
import { validateAdminSession } from "../services/adminAuth";
import { config } from "../config";

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

let _db: DatabaseType | null = null;

/**
 * Inject a database instance (used by tests).
 *
 * @param db - Database instance to use.
 */
export function setDb(db: DatabaseType): void {
  _db = db;
}

/**
 * Get the database instance, falling back to lazy-loading the production module.
 *
 * @returns Database instance.
 */
function getDb(): DatabaseType {
  if (!_db) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _db = require("../db").default;
  }
  return _db!;
}

/**
 * Generate cookie options for setting or clearing the admin session cookie.
 *
 * @param clear - If true, sets maxAge to 0 to clear the cookie.
 * @returns Cookie options object.
 */
export function cookieOptions(clear?: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/api/admin",
    maxAge: clear ? 0 : config.adminSessionDurationMs,
  };
}

/**
 * Express middleware that requires a valid admin session via the
 * httpOnly cookie. Reads the session token from cookies, validates it,
 * and attaches the admin user to `req.adminUser`. Returns 401 if the
 * session is missing or invalid.
 *
 * PR3 sec M2: this used to also accept `Authorization: Bearer <token>`
 * — the same admin-session token issued to the Chrome extension. A
 * leaked extension token therefore granted full admin web takeover
 * because the extension routes share the `admin_sessions` table with
 * the dashboard cookie session. The Bearer path is removed here and
 * lives only in `requireExtensionAdmin` below, which additionally
 * requires the `canUseExtension` permission flag — narrowing the
 * blast radius of an extension-token leak to product-import endpoints.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware function.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.adminCookieName];

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = validateAdminSession(getDb(), token);

  if (!user) {
    res.clearCookie(config.adminCookieName, cookieOptions(true));
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }

  req.adminUser = user;
  next();
}

/**
 * Express middleware that authenticates the Chrome extension. Accepts
 * only `Authorization: Bearer <token>` (no cookie) and additionally
 * requires the admin user's `canUseExtension` permission flag. Routes
 * meant to be reachable from the extension use this middleware instead
 * of `requireAdmin` + `requireExtensionPermission`, so a leaked
 * extension token cannot be replayed against any other admin endpoint.
 */
export function requireExtensionAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const token = authHeader.slice(7);
  const user = validateAdminSession(getDb(), token);
  if (!user) {
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }
  if (!user.canUseExtension) {
    res.status(403).json({ error: "Extension access not permitted" });
    return;
  }
  req.adminUser = user;
  next();
}

/**
 * Express middleware that enforces mandatory 2FA enrollment.
 *
 * Returns 403 if the authenticated admin has not enabled 2FA.
 * Must be chained after `requireAdmin`. If `req.adminUser` is not set
 * (unauthenticated request), passes through — `requireAdmin` will
 * have already rejected it.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware function.
 */
export function require2faEnrolled(req: Request, res: Response, next: NextFunction): void {
  // Allow sandbox/dev environments to bypass 2FA requirement
  if (process.env.SKIP_ADMIN_2FA === "1") {
    next();
    return;
  }

  if (req.adminUser && !req.adminUser.totpEnabled) {
    res.status(403).json({ error: "Two-factor authentication setup required" });
    return;
  }

  next();
}
