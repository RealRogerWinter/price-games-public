/**
 * Visitor cookie middleware.
 *
 * Issues and reads a persistent `visitor_id` cookie that identifies a single
 * browser across sessions, independent of user authentication. Used by the
 * anonymous attribution pipeline to tie UTM source and pre-signup game plays
 * to the same identity, so that "first game played" can be counted even when
 * the visitor never registers.
 *
 * The cookie is httpOnly (server-only, no JavaScript access) and sameSite=lax
 * so that ad-click landings from external origins still carry it on the
 * initial top-level navigation. Secure in production, as with the user
 * session cookie.
 *
 * Invariant: after this middleware runs, `req.visitorId` is always a valid
 * UUID. Callers on REST routes can rely on it being present.
 */

import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { config } from "../config";

declare global {
  namespace Express {
    interface Request {
      /** Persistent anonymous visitor identifier — set by visitorCookie middleware. */
      visitorId?: string;
    }
  }
}

/**
 * Accept only UUID-shaped cookie values, so an attacker can't supply an
 * arbitrary string that might collide with existing rows or inject oddness
 * into downstream queries. Any non-conforming value is ignored and a fresh
 * UUID is generated.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cookie options for the visitor_id cookie. Exported for tests and for
 * consistency when clearing the cookie elsewhere.
 *
 * @param clear - If true, sets maxAge to 0 to clear the cookie.
 * @returns Cookie options object.
 */
export function visitorCookieOptions(clear?: boolean) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: clear ? 0 : config.visitorCookieMaxAgeMs,
  };
}

/**
 * Express middleware that guarantees `req.visitorId` is a valid UUID.
 *
 * If the request already carries a valid `visitor_id` cookie, reuses it.
 * Otherwise generates a new UUID and sets the cookie on the response. In
 * either case, assigns the final id to `req.visitorId` for downstream
 * handlers. Never throws — attribution is best-effort.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware function.
 */
export function visitorCookie(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const existing = req.cookies?.[config.visitorCookieName];
  if (typeof existing === "string" && UUID_REGEX.test(existing)) {
    req.visitorId = existing;
    // Safari ITP mitigation: even though the cookie's original Max-Age is
    // 90 days, Safari caps first-party cookie retention to 7 days unless the
    // server re-sets it on every response. Rewriting the same value extends
    // the 7-day sliding window as long as the visitor keeps returning; a
    // 90-day idle still drops the cookie, which is acceptable.
    res.cookie(config.visitorCookieName, existing, visitorCookieOptions());
    next();
    return;
  }

  const fresh = randomUUID();
  req.visitorId = fresh;
  res.cookie(config.visitorCookieName, fresh, visitorCookieOptions());
  next();
}
