/**
 * Tests for the user authentication middleware.
 *
 * Covers requireUser (valid/invalid/expired/missing cookie) and
 * optionalUser (attaches when valid, proceeds without when invalid).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock services/userAuth module
vi.mock("../services/userAuth", () => ({
  validateUserSession: vi.fn(),
}));

// Mock ../db to prevent real DB load
vi.mock("../db", () => ({
  default: {},
}));

import { requireUser, optionalUser, userCookieOptions, setDb } from "./userAuth";
import { validateUserSession } from "../services/userAuth";
import { config } from "../config";
import type { UserAccount } from "@price-game/shared";

const mockValidate = vi.mocked(validateUserSession);

/** Create a minimal mock Express Request with optional cookies. */
function mockReq(cookies: Record<string, string> = {}): any {
  return { cookies };
}

/**
 * Create a minimal mock Express Response that tracks status, json, and clearCookie calls.
 *
 * @returns An object with `res` (the chainable mock) and `state` (observed side-effects).
 */
function mockRes() {
  const state = {
    status: null as number | null,
    body: null as any,
    clearedCookies: [] as string[],
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(data: any) {
      state.body = data;
      return res;
    },
    clearCookie(name: string, _opts?: any) {
      state.clearedCookies.push(name);
      return res;
    },
  };
  return { res, state };
}

const fakeUser: UserAccount = {
  id: "user-uuid-1",
  username: "testuser",
  email: "test@example.com",
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
  isActive: true,
  lifetimeScore: 0,
};

describe("requireUser middleware", () => {
  beforeEach(() => {
    mockValidate.mockReset();
    setDb({} as any);
  });

  it("returns 401 with 'Authentication required' when no cookie is present", () => {
    const req = mockReq({});
    const { res, state } = mockRes();
    const next = vi.fn();

    requireUser(req, res as any, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "Authentication required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with 'Session expired or invalid' and clears cookie when session is invalid", () => {
    const req = mockReq({ [config.userCookieName]: "bad-token" });
    const { res, state } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(null);

    requireUser(req, res as any, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "Session expired or invalid" });
    expect(state.clearedCookies).toContain(config.userCookieName);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and attaches user on valid session", () => {
    const req = mockReq({ [config.userCookieName]: "good-token" });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(fakeUser);

    requireUser(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(fakeUser);
  });

  it("passes the token from the cookie to validateUserSession", () => {
    const token = "session-token-abc";
    const req = mockReq({ [config.userCookieName]: token });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(fakeUser);

    requireUser(req, res as any, next);

    expect(mockValidate).toHaveBeenCalledWith(expect.anything(), token);
  });
});

describe("optionalUser middleware", () => {
  beforeEach(() => {
    mockValidate.mockReset();
    setDb({} as any);
  });

  it("attaches user when valid session cookie is present", () => {
    const req = mockReq({ [config.userCookieName]: "good-token" });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(fakeUser);

    optionalUser(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(fakeUser);
  });

  it("proceeds without user when no cookie is present", () => {
    const req = mockReq({});
    const { res } = mockRes();
    const next = vi.fn();

    optionalUser(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it("proceeds without user when session is invalid", () => {
    const req = mockReq({ [config.userCookieName]: "bad-token" });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(null);

    optionalUser(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});

describe("userCookieOptions", () => {
  it("returns standard options with httpOnly, sameSite strict, path '/', and correct maxAge", () => {
    const opts = userCookieOptions();

    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(config.userSessionDurationMs);
  });

  it("returns maxAge 0 when clearing", () => {
    const opts = userCookieOptions({ clear: true });
    expect(opts.maxAge).toBe(0);
  });

  it("sets secure flag based on NODE_ENV", () => {
    const original = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";
    const prodOpts = userCookieOptions();
    expect(prodOpts.secure).toBe(true);

    process.env.NODE_ENV = "development";
    const devOpts = userCookieOptions();
    expect(devOpts.secure).toBe(false);

    process.env.NODE_ENV = original;
  });

  // "Stay logged in" branch: the browser should treat the cookie as a
  // session cookie (deleted on browser close) when the user opts out of
  // persistent login. We signal this to Express by omitting maxAge
  // entirely — any numeric value would turn it into a persistent cookie.
  it("omits maxAge when stayLoggedIn is false (browser-session cookie)", () => {
    const opts = userCookieOptions({ stayLoggedIn: false });

    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBeUndefined();
  });

  it("uses the full session duration when stayLoggedIn is true", () => {
    const opts = userCookieOptions({ stayLoggedIn: true });
    expect(opts.maxAge).toBe(config.userSessionDurationMs);
  });

  it("defaults to the full session duration when stayLoggedIn is omitted (backwards compat)", () => {
    const opts = userCookieOptions({});
    expect(opts.maxAge).toBe(config.userSessionDurationMs);
  });

  it("clear:true overrides stayLoggedIn:false (cookie is cleared, not browser-session)", () => {
    const opts = userCookieOptions({ clear: true, stayLoggedIn: false });
    expect(opts.maxAge).toBe(0);
  });
});
