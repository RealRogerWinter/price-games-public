import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock services/adminAuth module
vi.mock("../services/adminAuth", () => ({
  validateAdminSession: vi.fn(),
}));

// Mock ../db to prevent real DB load
vi.mock("../db", () => ({
  default: {},
}));

import { requireAdmin, requireExtensionAdmin, cookieOptions, setDb } from "./adminAuth";
import { validateAdminSession } from "../services/adminAuth";
import { config } from "../config";
import type { AdminUser } from "@price-game/shared";

const mockValidate = vi.mocked(validateAdminSession);

/** Create a minimal mock Express Request with optional cookies and headers. */
function mockReq(cookies: Record<string, string> = {}, headers: Record<string, string> = {}): any {
  return { cookies, headers };
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

const fakeAdmin: AdminUser = {
  id: "admin-uuid-1",
  username: "testadmin",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
  isActive: true,
};

describe("requireAdmin middleware", () => {
  beforeEach(() => {
    mockValidate.mockReset();
    setDb({} as any);
  });

  it("returns 401 with 'Authentication required' when no cookie is present", async () => {
    const req = mockReq({});
    const { res, state } = mockRes();
    const next = vi.fn();

    await requireAdmin(req, res as any, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "Authentication required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with 'Session expired or invalid' and clears cookie when session is invalid", async () => {
    const req = mockReq({ [config.adminCookieName]: "bad-token" });
    const { res, state } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(null);

    await requireAdmin(req, res as any, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "Session expired or invalid" });
    expect(state.clearedCookies).toContain(config.adminCookieName);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and attaches adminUser on valid session", async () => {
    const req = mockReq({ [config.adminCookieName]: "good-token" });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(fakeAdmin);

    await requireAdmin(req, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser).toEqual(fakeAdmin);
  });

  it("passes the token from the cookie to validateAdminSession", async () => {
    const token = "session-token-abc";
    const req = mockReq({ [config.adminCookieName]: token });
    const { res } = mockRes();
    const next = vi.fn();

    mockValidate.mockReturnValue(fakeAdmin);

    await requireAdmin(req, res as any, next);

    expect(mockValidate).toHaveBeenCalledWith(expect.anything(), token);
  });

  it("rejects Authorization: Bearer tokens — Bearer is reserved for the extension flow (PR3 sec M2)", async () => {
    // Pre-PR3 the dashboard cookie session AND the extension's Bearer
    // token both authenticated through this middleware, so a leaked
    // extension token granted full dashboard access. Bearer must be
    // rejected here regardless of validity.
    const req = mockReq({}, { authorization: "Bearer some-valid-extension-token" });
    const { res, state } = mockRes();
    const next = vi.fn();

    // Even if validateAdminSession would accept the token, the cookie
    // path ignores the Bearer header entirely, so validate is never called.
    mockValidate.mockReturnValue(fakeAdmin);

    await requireAdmin(req, res as any, next);

    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: "Authentication required" });
    expect(next).not.toHaveBeenCalled();
    expect(mockValidate).not.toHaveBeenCalled();
  });
});

describe("requireExtensionAdmin middleware (PR3 sec M2)", () => {
  beforeEach(() => {
    mockValidate.mockReset();
    setDb({} as any);
  });

  it("returns 401 when no Authorization header is present", () => {
    const req = mockReq();
    const { res, state } = mockRes();
    const next = vi.fn();
    requireExtensionAdmin(req, res as any, next);
    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization is not Bearer-prefixed", () => {
    const req = mockReq({}, { authorization: "Basic abc" });
    const { res, state } = mockRes();
    const next = vi.fn();
    requireExtensionAdmin(req, res as any, next);
    expect(state.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the admin user lacks canUseExtension", () => {
    const req = mockReq({}, { authorization: "Bearer abc" });
    const { res, state } = mockRes();
    const next = vi.fn();
    mockValidate.mockReturnValue({ ...fakeAdmin, canUseExtension: false } as AdminUser);
    requireExtensionAdmin(req, res as any, next);
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: "Extension access not permitted" });
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores cookies — only Authorization Bearer is honored", () => {
    const req = mockReq({ [config.adminCookieName]: "cookie-token" }, {});
    const { res, state } = mockRes();
    const next = vi.fn();
    requireExtensionAdmin(req, res as any, next);
    expect(state.status).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it("calls next() and attaches adminUser when Bearer is valid AND canUseExtension is true", () => {
    const req = mockReq({}, { authorization: "Bearer ext-token" });
    const { res } = mockRes();
    const next = vi.fn();
    mockValidate.mockReturnValue({ ...fakeAdmin, canUseExtension: true } as AdminUser);
    requireExtensionAdmin(req, res as any, next);
    expect(next).toHaveBeenCalled();
    expect(req.adminUser?.canUseExtension).toBe(true);
  });
});

describe("cookieOptions", () => {
  it("returns standard options with httpOnly, sameSite strict, path /api/admin, and correct maxAge", () => {
    const opts = cookieOptions();

    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/api/admin");
    expect(opts.maxAge).toBe(config.adminSessionDurationMs);
  });

  it("returns maxAge 0 when clearing", () => {
    const opts = cookieOptions(true);

    expect(opts.maxAge).toBe(0);
  });

  it("sets secure flag based on NODE_ENV", () => {
    const original = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";
    const prodOpts = cookieOptions();
    expect(prodOpts.secure).toBe(true);

    process.env.NODE_ENV = "development";
    const devOpts = cookieOptions();
    expect(devOpts.secure).toBe(false);

    // Restore original value
    process.env.NODE_ENV = original;
  });
});
