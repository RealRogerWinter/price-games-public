/**
 * Tests for the visitor cookie middleware.
 *
 * Verifies the invariants callers rely on:
 *   - req.visitorId is always set after the middleware runs
 *   - a valid cookie is reused verbatim
 *   - an invalid cookie is replaced with a fresh UUID + Set-Cookie
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { visitorCookie, visitorCookieOptions } from "./visitorCookie";

function makeReqRes(cookies: Record<string, unknown> = {}) {
  const req = { cookies } as Partial<Request> & { cookies: Record<string, unknown> };
  const cookieSpy = vi.fn();
  const res = { cookie: cookieSpy } as Partial<Response>;
  const next = vi.fn() as unknown as NextFunction;
  return { req: req as Request, res: res as Response, next, cookieSpy };
}

describe("visitorCookie middleware", () => {
  it("reuses a valid UUID cookie and refreshes Max-Age (Safari ITP)", () => {
    const existing = "11111111-2222-3333-4444-555555555555";
    const { req, res, next, cookieSpy } = makeReqRes({ visitor_id: existing });

    visitorCookie(req, res, next);

    expect(req.visitorId).toBe(existing);
    // Cookie is rewritten with the SAME value on every response so Safari's
    // 7-day first-party cookie cap resets as long as the visitor returns.
    expect(cookieSpy).toHaveBeenCalledWith(
      "visitor_id",
      existing,
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );
    expect(next).toHaveBeenCalled();
  });

  it("issues a fresh UUID and sets the cookie when absent", () => {
    const { req, res, next, cookieSpy } = makeReqRes();

    visitorCookie(req, res, next);

    expect(req.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(cookieSpy).toHaveBeenCalledWith(
      "visitor_id",
      req.visitorId,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
    expect(next).toHaveBeenCalled();
  });

  it("replaces a non-UUID cookie value with a fresh UUID", () => {
    const { req, res, next, cookieSpy } = makeReqRes({
      visitor_id: "not-a-uuid",
    });

    visitorCookie(req, res, next);

    expect(req.visitorId).not.toBe("not-a-uuid");
    expect(cookieSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("ignores non-string cookie values", () => {
    const { req, res, next, cookieSpy } = makeReqRes({ visitor_id: 42 });

    visitorCookie(req, res, next);

    expect(typeof req.visitorId).toBe("string");
    expect(cookieSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe("visitorCookieOptions", () => {
  it("returns httpOnly + sameSite=lax by default", () => {
    const opts = visitorCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBeGreaterThan(0);
  });

  it("returns maxAge=0 when clearing", () => {
    expect(visitorCookieOptions(true).maxAge).toBe(0);
  });
});
