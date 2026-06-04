/**
 * User authentication middleware.
 *
 * Provides the `requireUser` and `optionalUser` Express middlewares that
 * validate session cookies and attach the user to req.user.
 *
 * Uses a `setDb` injection pattern so tests can supply an in-memory database
 * without loading the production db module.
 */

import { Request, Response, NextFunction } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import type { UserAccount } from "@price-game/shared";
import { validateUserSession } from "../services/userAuth";
import { config } from "../config";

declare global {
  namespace Express {
    interface Request {
      user?: UserAccount;
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
 * Generate cookie options for setting or clearing the user session cookie.
 *
 * The returned object is handed directly to `res.cookie()` /
 * `res.clearCookie()`. The three modes:
 *
 * - `{ clear: true }` → `maxAge: 0` (used by logout and invalid-session
 *   paths to instruct the browser to drop the cookie). Takes precedence
 *   over `stayLoggedIn` so logout always wins.
 * - `{ stayLoggedIn: false }` → `maxAge` is omitted entirely so the
 *   browser treats this as a session cookie and deletes it on close.
 * - `{ stayLoggedIn: true }` / `{}` / omitted → `maxAge:
 *   userSessionDurationMs` (persistent cookie, default 30 days). Omitted
 *   and `true` behave identically for backwards compatibility with
 *   callers that predate the flag.
 *
 * @param opts - Optional settings. `clear` wipes the cookie, `stayLoggedIn`
 *               toggles persistent vs session-scoped.
 * @returns Cookie options object compatible with express's CookieOptions.
 */
export function userCookieOptions(opts?: { clear?: boolean; stayLoggedIn?: boolean }): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge?: number;
} {
  const base = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };

  if (opts?.clear) {
    return { ...base, maxAge: 0 };
  }
  if (opts?.stayLoggedIn === false) {
    // Omit maxAge entirely → browser session cookie.
    return base;
  }
  return { ...base, maxAge: config.userSessionDurationMs };
}

/**
 * Express middleware that requires a valid user session.
 *
 * Reads the session token from cookies, validates it, and attaches the
 * user to `req.user`. Returns 401 if the session is missing or invalid.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware function.
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.userCookieName];

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = validateUserSession(getDb(), token);

  if (!user) {
    res.clearCookie(config.userCookieName, userCookieOptions({ clear: true }));
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }

  req.user = user;
  next();
}

/**
 * Express middleware that optionally attaches a user if a valid session exists.
 *
 * Unlike requireUser, this always calls next() regardless of whether a
 * valid session is found. req.user is populated if valid, undefined otherwise.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware function.
 */
export function optionalUser(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[config.userCookieName];

  if (token) {
    const user = validateUserSession(getDb(), token);
    if (user) {
      req.user = user;
    }
  }

  next();
}
