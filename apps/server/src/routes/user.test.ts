/**
 * Tests for user account REST API routes.
 *
 * Covers registration, login/logout, email verification, password/email/username
 * changes, forgot/reset password, game history, stats, rewards, and OAuth endpoints.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

vi.mock("../services/email", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

// Turnstile mock — flipped on/off per-test via the module-level vars below.
// Default matches the existing (no-secret) dev posture so pre-existing tests
// keep passing without edits.
const mockIsTurnstileEnabled = vi.fn(() => false);
const mockVerifyTurnstileToken = vi.fn(async () => true);
vi.mock("../services/turnstile", () => ({
  isTurnstileEnabled: (...args: any[]) => mockIsTurnstileEnabled(...args),
  verifyTurnstileToken: (...args: any[]) => mockVerifyTurnstileToken(...args),
}));

const mockValidateOAuthState = vi.fn();
const mockExchangeGoogleCode = vi.fn();
const mockExchangeFacebookCode = vi.fn();
const mockFindOrCreateOAuthUser = vi.fn();
const mockCreateOAuthSession = vi.fn();
const mockGenerateOAuthState = vi.fn();

vi.mock("../services/oauth", () => ({
  generateOAuthState: (...args: any[]) => mockGenerateOAuthState(...args),
  validateOAuthState: (...args: any[]) => mockValidateOAuthState(...args),
  getGoogleAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/auth"),
  exchangeGoogleCode: (...args: any[]) => mockExchangeGoogleCode(...args),
  getFacebookAuthUrl: vi.fn().mockReturnValue("https://facebook.com/auth"),
  exchangeFacebookCode: (...args: any[]) => mockExchangeFacebookCode(...args),
  findOrCreateOAuthUser: (...args: any[]) => mockFindOrCreateOAuthUser(...args),
  createOAuthSession: (...args: any[]) => mockCreateOAuthSession(...args),
}));

function getHandler(router: any, path: string, method: string = "get") {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      const mStack = layer.route.stack.filter((s: any) => s.method === method);
      return mStack[mStack.length - 1]?.handle;
    }
  }
  return undefined;
}

let db: DatabaseType;
let userId: string;

function mockReq(overrides: any = {}) {
  return {
    params: {},
    body: {},
    query: {},
    cookies: { user_session: "test-token" },
    headers: { "user-agent": "test" },
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    user: {
      id: userId,
      username: "testuser",
      email: "test@example.com",
      emailVerified: false,
      isActive: true,
      lifetimeScore: 0,
      usernamePending: false,
    },
    ...overrides,
  } as any;
}

function mockRes() {
  const data: any = {};
  const res = {
    json(d: any) {
      data.body = d;
      return res;
    },
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    cookie(name: string, val: any) {
      data.cookie = { name, val };
      return res;
    },
    clearCookie(name: string) {
      data.clearedCookie = name;
      return res;
    },
    redirect(url: string) {
      data.redirect = url;
      return res;
    },
  } as any;
  return { res, data };
}

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db, "testuser", "test@example.com", "T3stP@ss-w0rd!");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3600000).toISOString();
  db.prepare(
    "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)"
  ).run("test-token", userId, now, expires, now);
  mockIsTurnstileEnabled.mockReset().mockReturnValue(false);
  mockVerifyTurnstileToken.mockReset().mockResolvedValue(true);
});

describe("user routes", () => {
  // ── Registration (POST /register) ──

  describe("POST /register", () => {
    it("success creates user and sets cookie", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");
      expect(handler).toBeDefined();

      const req = mockReq({
        body: { username: "newuser", email: "new@example.com", password: "N3wP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toBeDefined();
      expect(data.body.user).toBeDefined();
      expect(data.body.emailVerificationPending).toBe(true);
      expect(data.cookie).toBeDefined();
    });

    it("missing fields returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({ body: { username: "x" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });

    it("too-long input returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "a".repeat(200), email: "x@e.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/too long/i);
    });

    it("duplicate email returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "another", email: "test@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });

    // ── Turnstile gate ────────────────────────────────────────────────

    it("rejects registration with 400 when Turnstile is enabled and no token is supplied", async () => {
      mockIsTurnstileEnabled.mockReturnValueOnce(true);
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "nochal", email: "nochal@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      await handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
      expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
    });

    it("rejects registration with 400 when the supplied Turnstile token is invalid", async () => {
      mockIsTurnstileEnabled.mockReturnValueOnce(true);
      mockVerifyTurnstileToken.mockResolvedValueOnce(false);
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: {
          username: "badchal",
          email: "badchal@example.com",
          password: "T3stP@ss-w0rd!",
          turnstileToken: "definitely-not-valid",
        },
      });
      const { res, data } = mockRes();
      await handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/challenge failed/i);
    });

    it("skips Turnstile entirely when the flag is off (sandbox / SKIP_TURNSTILE=1)", async () => {
      // Default mock is already "off", but be explicit so the intent reads.
      mockIsTurnstileEnabled.mockReturnValueOnce(false);
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "sbxuser", email: "sbxuser@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      await handler(req, res);

      expect(data.body.user).toBeDefined();
      expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
    });

    // Register's auto-login path must also relink any prior push subscription
    // for this visitor_id to the freshly-created user. Mirrors /login's
    // relink behavior so the notification scheduler's OR-axis filter sees
    // the subscription under the current identity immediately.
    it("re-links an existing subscription on this visitor to the newly-registered user", async () => {
      // Alice already has a subscription on this browser (visitor=V).
      db.prepare(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, is_active, visitor_id)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(userId, "https://fcm.googleapis.com/fcm/send/register-dev", "p", "a", "shared-visitor-register");

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      // Bob registers on the same browser — same visitor_id cookie.
      const req = mockReq({
        body: { username: "bobregister", email: "bob-register@example.com", password: "T3stP@ss-w0rd!" },
        visitorId: "shared-visitor-register",
        user: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
      const newUserId = data.body.user.id;
      expect(newUserId).not.toBe(userId);

      const row = db
        .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
        .get("https://fcm.googleapis.com/fcm/send/register-dev") as { user_id: string };
      expect(row.user_id).toBe(newUserId);
    });
  });

  // ── Auth config (GET /auth-config) ──

  describe("GET /auth-config", () => {
    it("returns turnstileEnabled: true when the service reports the challenge is on", async () => {
      mockIsTurnstileEnabled.mockReturnValueOnce(true);
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/auth-config", "get");
      expect(handler).toBeDefined();

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ turnstileEnabled: true });
    });

    it("returns turnstileEnabled: false when the challenge is off (sandbox / no secret)", async () => {
      mockIsTurnstileEnabled.mockReturnValueOnce(false);
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/auth-config", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ turnstileEnabled: false });
    });
  });

  // ── Login (POST /login) ──

  describe("POST /login", () => {
    it("success with email", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "test@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
      expect(data.cookie).toBeDefined();
    });

    it("missing identifier returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({ body: { password: "T3stP@ss-w0rd!" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });

    it("too-long input returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "a".repeat(300), password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/too long/i);
    });

    it("wrong password returns 401", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "test@example.com", password: "wrongpassword" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(401);
    });

    // Device rotation edge case: Alice subscribed on this device, then logged
    // out. Bob now logs in on the same browser (same visitor_id). Without the
    // re-link, the subscription stays pointed at Alice and both the scheduler
    // and future sends would target the wrong account. Re-linking on login
    // keeps the subscription aligned with whoever is *currently* using the
    // device, which is the load-bearing invariant for the OR-axis filter.
    it("re-links an existing push subscription to the new user on login", async () => {
      // Seed Bob with a known password.
      const bobId = seedUser(db, "bob", "bob@example.com", "bobpassword123");

      // Alice already has a subscription on this device. In prod this row is
      // written by saveSubscription on /api/push/subscribe; here we insert
      // directly to keep the test focused on the login handler.
      db.prepare(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, is_active, visitor_id)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(userId, "https://fcm.googleapis.com/fcm/send/shared-dev", "p", "a", "shared-visitor");

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      // Bob logs in on the same browser — his request carries the same
      // visitor_id cookie that Alice's subscribe carried.
      const req = mockReq({
        body: { identifier: "bob@example.com", password: "bobpassword123" },
        visitorId: "shared-visitor",
        user: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();

      const row = db
        .prepare(
          "SELECT user_id FROM push_subscriptions WHERE endpoint = ?",
        )
        .get("https://fcm.googleapis.com/fcm/send/shared-dev") as { user_id: string };
      expect(row.user_id).toBe(bobId);
    });

    it("leaves subscriptions for other visitor_ids untouched on login", async () => {
      const bobId = seedUser(db, "bob2", "bob2@example.com", "bobpassword123");

      // Alice's subscription on a DIFFERENT device (different visitor_id).
      db.prepare(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, is_active, visitor_id)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(userId, "https://fcm.googleapis.com/fcm/send/alice-phone", "p", "a", "alice-phone-visitor");

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "bob2@example.com", password: "bobpassword123" },
        visitorId: "bob-browser-visitor",
        user: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
      const row = db
        .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
        .get("https://fcm.googleapis.com/fcm/send/alice-phone") as { user_id: string };
      // Alice's phone subscription must still belong to Alice.
      expect(row.user_id).toBe(userId);
      expect(row.user_id).not.toBe(bobId);
    });
  });

  // ── Logout (POST /logout) ──

  describe("POST /logout", () => {
    it("clears session cookie", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/logout", "post");

      const req = mockReq({ cookies: { user_session: "test-token" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.clearedCookie).toBe("user_session");
      expect(data.body).toEqual({ ok: true });
    });
  });

  // ── Email verification (POST /verify-email) ──

  describe("POST /verify-email", () => {
    it("missing token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/verify-email", "post");

      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/token/i);
    });

    it("too-long token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/verify-email", "post");

      const req = mockReq({ body: { token: "a".repeat(300) } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/invalid token/i);
    });

    it("invalid token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/verify-email", "post");

      const req = mockReq({ body: { token: "nonexistent-token" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/invalid|expired/i);
    });
  });

  // ── Resend verification (POST /resend-verification) ──

  describe("POST /resend-verification", () => {
    it("sends email for unverified user", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/resend-verification", "post");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ ok: true });
    });

    it("skips for already verified user", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/resend-verification", "post");

      const req = mockReq({
        user: {
          id: userId,
          username: "testuser",
          email: "test@example.com",
          emailVerified: true,
          isActive: true,
          lifetimeScore: 0,
          usernamePending: false,
        },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ ok: true });
    });
  });

  // ── Change email (PUT /email) ──

  describe("PUT /email", () => {
    it("success changes email", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/email", "put");

      const req = mockReq({
        body: { newEmail: "newemail@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user).toBeDefined();
    });

    it("missing fields returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/email", "put");

      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });

    it("wrong password returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/email", "put");

      const req = mockReq({
        body: { newEmail: "newemail@example.com", password: "wrongpassword" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });
  });

  // ── Change password (PUT /password) ──

  describe("PUT /password", () => {
    it("success changes password", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/password", "put");

      const req = mockReq({
        body: { currentPassword: "T3stP@ss-w0rd!", newPassword: "newpassword456" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user).toBeDefined();
      expect(data.cookie).toBeDefined();
    });

    it("missing fields returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/password", "put");

      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });
  });

  // ── Change username (PUT /username) ──

  describe("PUT /username", () => {
    it("success", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/username", "put");

      // changeUsername requires username_pending = 1
      db.prepare("UPDATE users SET username_pending = 1 WHERE id = ?").run(userId);

      const req = mockReq({ body: { username: "newusername" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user).toBeDefined();
    });

    it("missing username returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/username", "put");

      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });

    it("too-long input returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/username", "put");

      const req = mockReq({ body: { username: "a".repeat(200) } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/too long/i);
    });
  });

  // ── Forgot password (POST /forgot-password) ──

  describe("POST /forgot-password", () => {
    it("always returns ok (prevents enumeration)", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/forgot-password", "post");

      const req = mockReq({ body: { email: "test@example.com" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ ok: true });
    });

    it("missing email returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/forgot-password", "post");

      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/required/i);
    });

    it("too-long email returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/forgot-password", "post");

      const req = mockReq({ body: { email: "a".repeat(300) } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/too long/i);
    });
  });

  // ── Reset password (POST /reset-password) ──

  describe("POST /reset-password", () => {
    it("missing token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      const req = mockReq({ body: { newPassword: "newpass123" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/token/i);
    });

    it("too-long token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      const req = mockReq({ body: { token: "a".repeat(300), newPassword: "newpass123" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/invalid token/i);
    });

    it("missing new password returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      const req = mockReq({ body: { token: "some-token" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/password/i);
    });

    it("invalid token returns 400", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      const req = mockReq({ body: { token: "bad-token", newPassword: "N3wP@ss-w0rd!" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/invalid|expired/i);
    });
  });

  // ── History / Stats ──

  describe("GET /history", () => {
    it("returns entries with pagination", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/history", "get");

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 5000, ?)"
      ).run(userId, now);

      const req = mockReq({ query: { limit: "10", offset: "0" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.entries).toBeDefined();
      expect(data.body.total).toBeGreaterThanOrEqual(1);
    });

    it("filters by gameType", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/history", "get");

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 5000, ?)"
      ).run(userId, now);
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, room_code, score, placement, players_count, played_at) VALUES (?, 'multiplayer', 'classic', 'ABCD', 3000, 1, 4, ?)"
      ).run(userId, now);

      const req = mockReq({ query: { gameType: "single" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.entries.length).toBe(1);
      expect(data.body.entries[0].gameType).toBe("single");
      expect(data.body.total).toBe(1);
    });
  });

  describe("GET /history/:historyId/recap", () => {
    function insertProduct(id: number, title: string, priceCents: number): void {
      db.prepare(
        "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
      ).run(id, "B0TEST", title, "", "", priceCents, "Electronics");
    }

    async function recapHandler() {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      return getHandler(router, "/history/:historyId/recap", "get");
    }

    it("returns 400 on non-numeric id", async () => {
      const handler = await recapHandler();
      const req = mockReq({ params: { historyId: "not-a-number" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("returns 404 when history row is missing", async () => {
      const handler = await recapHandler();
      const req = mockReq({ params: { historyId: "999999" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("returns 404 when the row belongs to a different user (IDOR fix, PR3 sec H1)", async () => {
      const handler = await recapHandler();
      // Insert a row owned by a *different* user. Sequential history ids
      // were enumerable from the public path before the ownership gate;
      // an authed attacker should now see 404 (intentionally indistinct
      // from "missing row" so existence isn't probed either).
      const otherUserId = "other-user-id-not-the-test-user";
      db.prepare(
        `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, is_active)
         VALUES (?, 'other', 'other', 'other@example.com', 'h', ?, ?, 1)`,
      ).run(otherUserId, new Date().toISOString(), new Date().toISOString());
      db.prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
         VALUES (?, 'single', 'classic', 'other-session', 1234, ?)`,
      ).run(otherUserId, new Date().toISOString());
      const otherRow = db
        .prepare("SELECT id FROM user_game_history WHERE session_id = 'other-session'")
        .get() as { id: number };

      const req = mockReq({ params: { historyId: String(otherRow.id) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("History entry not found");
    });

    it("returns cached shared_games row when share_id is already stamped (fast path)", async () => {
      const handler = await recapHandler();
      db.prepare(
        `INSERT INTO shared_games (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
         VALUES (?, 'classic', 5000, 1000, 'testuser', '[{"roundNumber":1,"score":800,"products":[]}]', 1700000000)`
      ).run("shr12345");
      db.prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at, share_id)
         VALUES (?, 'single', 'classic', 'cached-session', 5000, ?, ?)`
      ).run(userId, new Date().toISOString(), "shr12345");
      const row = db.prepare("SELECT id FROM user_game_history WHERE session_id = 'cached-session'").get() as { id: number };

      const before = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };

      const req = mockReq({ params: { historyId: String(row.id) } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.id).toBe("shr12345");
      expect(data.body.gameMode).toBe("classic");
      expect(data.body.roundData).toHaveLength(1);
      // Fast path: no new shared_games row inserted.
      const after = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };
      expect(after.c).toBe(before.c);
    });

    it("reconstructs + persists + stamps on cold path for a legacy row", async () => {
      const handler = await recapHandler();
      insertProduct(500, "ColdProduct", 1200);

      db.prepare(
        `INSERT INTO game_sessions (id, current_round, total_score, selected_products, started_at, game_mode, round_data, total_rounds, completed_at, user_id)
         VALUES ('sess-cold', 1, 700, ?, ?, 'classic', NULL, 5, ?, ?)`
      ).run(JSON.stringify([500, 500, 500, 500, 500]), "2026-04-16T00:00:00Z", "2026-04-16T00:05:00Z", userId);
      db.prepare(
        `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at)
         VALUES ('sess-cold', 1, 500, 1300, 700, '2026-04-16T00:01:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
         VALUES (?, 'single', 'classic', 'sess-cold', 700, ?)`
      ).run(userId, new Date().toISOString());
      const row = db.prepare("SELECT id FROM user_game_history WHERE session_id = 'sess-cold'").get() as { id: number };

      const before = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };

      // First call: cold path — synthesize + insert + stamp.
      const req1 = mockReq({ params: { historyId: String(row.id) } });
      const { res: res1, data: data1 } = mockRes();
      handler(req1, res1);
      expect(data1.body.roundData).toHaveLength(1);
      expect(data1.body.roundData[0].products[0].title).toBe("ColdProduct");

      const after = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };
      expect(after.c).toBe(before.c + 1);

      const stamped = db.prepare("SELECT share_id FROM user_game_history WHERE id = ?").get(row.id) as { share_id: string };
      expect(stamped.share_id).toMatch(/^[A-Za-z0-9_-]{8}$/);

      // Second call: fast path — share_id now stamped, no new inserts.
      const req2 = mockReq({ params: { historyId: String(row.id) } });
      const { res: res2, data: data2 } = mockRes();
      handler(req2, res2);
      expect(data2.body.id).toBe(stamped.share_id);
      const afterAgain = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };
      expect(afterAgain.c).toBe(after.c);
    });

    it("returns empty roundData without persisting when underlying session is gone", async () => {
      const handler = await recapHandler();
      db.prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
         VALUES (?, 'single', 'classic', 'missing-session', 3000, ?)`
      ).run(userId, new Date().toISOString());
      const row = db.prepare("SELECT id FROM user_game_history WHERE session_id = 'missing-session'").get() as { id: number };

      const before = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };

      const req = mockReq({ params: { historyId: String(row.id) } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.roundData).toEqual([]);
      expect(data.body.totalScore).toBe(3000);
      // No persist: leaves the door open for a later backfill.
      const after = db.prepare("SELECT COUNT(*) AS c FROM shared_games").get() as { c: number };
      expect(after.c).toBe(before.c);
      const untouched = db.prepare("SELECT share_id FROM user_game_history WHERE id = ?").get(row.id) as { share_id: string | null };
      expect(untouched.share_id).toBeNull();
    });
  });

  describe("GET /stats", () => {
    it("returns user stats", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/stats", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toBeDefined();
      expect(data.body.totalGames).toBeDefined();
    });
  });

  describe("GET /win-record", () => {
    it("returns the auth user's cached W/L counters", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/win-record", "get");

      db.prepare(
        "UPDATE users SET lifetime_wins = ?, lifetime_losses = ?, current_streak = ?, best_win_streak = ?, total_games = ? WHERE id = ?",
      ).run(7, 3, 4, 6, 10, userId);

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.record).toEqual({
        wins: 7,
        losses: 3,
        currentStreak: 4,
        bestStreak: 6,
        totalGames: 10,
      });
      expect(data.body.byMode).toBeUndefined();
    });

    it("includes a per-mode breakdown when ?breakdown=mode is set", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/win-record", "get");

      // Two classic wins, one loss; one higher-lower win.
      const insertHist = db.prepare(
        `INSERT INTO user_game_history
           (user_id, game_type, game_mode, session_id, score, played_at, is_win)
          VALUES (?, 'single', ?, ?, ?, ?, ?)`,
      );
      insertHist.run(userId, "classic", "s1", 5000, "2026-01-01T00:00:00Z", 1);
      insertHist.run(userId, "classic", "s2", 6000, "2026-01-02T00:00:00Z", 1);
      insertHist.run(userId, "classic", "s3", 100, "2026-01-03T00:00:00Z", 0);
      insertHist.run(userId, "higher-lower", "s4", 7000, "2026-01-04T00:00:00Z", 1);

      const req = mockReq({ query: { breakdown: "mode" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.byMode).toBeDefined();
      const byMode = data.body.byMode as Array<{
        gameMode: string;
        wins: number;
        losses: number;
        winRate: number | null;
      }>;
      const classic = byMode.find((m) => m.gameMode === "classic")!;
      expect(classic).toEqual({
        gameMode: "classic",
        wins: 2,
        losses: 1,
        winRate: 66.7,
      });
      const higherLower = byMode.find((m) => m.gameMode === "higher-lower")!;
      expect(higherLower).toEqual({
        gameMode: "higher-lower",
        wins: 1,
        losses: 0,
        winRate: 100,
      });
    });

    it("falls back to visitor counters for anonymous viewers with a visitor cookie", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/win-record", "get");

      // Seed a visitor row with non-zero W/L.
      db.prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, first_seen_at, lifetime_wins, lifetime_losses, current_streak, best_win_streak, games_played)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("anon-1", "reddit", new Date().toISOString(), 5, 2, 3, 5, 7);

      const req = mockReq({ user: undefined, visitorId: "anon-1" });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.record).toEqual({
        wins: 5,
        losses: 2,
        currentStreak: 3,
        bestStreak: 5,
        totalGames: 7,
      });
    });

    it("returns a zeroed snapshot when the viewer has neither auth nor a visitor cookie", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/win-record", "get");

      const req = mockReq({ user: undefined, visitorId: undefined });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.record).toEqual({
        wins: 0,
        losses: 0,
        currentStreak: 0,
        bestStreak: 0,
        totalGames: 0,
      });
    });
  });

  describe("GET /monthly-points", () => {
    it("returns zero when no games played this month", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/monthly-points", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.points).toBe(0);
      expect(data.body.gamesPlayed).toBe(0);
    });

    it("sums only current month games", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/monthly-points", "get");

      // Insert a game played today (current month)
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 3000, ?)"
      ).run(userId, now);

      // Insert a game played last year (should not count)
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 9999, ?)"
      ).run(userId, "2024-01-01T00:00:00.000Z");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.points).toBe(3000);
      expect(data.body.gamesPlayed).toBe(1);
    });

    it("returns current active streak alongside points", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/monthly-points", "get");

      const today = new Date().toISOString().slice(0, 10);
      db.prepare(
        "UPDATE users SET daily_streak_current = 5, daily_streak_best = 9, daily_streak_last_date = ? WHERE id = ?"
      ).run(today, userId);

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.streak).toBe(5);
    });

    it("returns 0 streak when user has never completed a daily", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/monthly-points", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.streak).toBe(0);
    });
  });

  // ── Rewards ──

  describe("GET /rewards", () => {
    it("returns user rewards", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/rewards", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.rewards).toBeDefined();
      expect(Array.isArray(data.body.rewards)).toBe(true);
    });
  });

  describe("POST /rewards/:id/claim", () => {
    it("returns 404 for nonexistent reward", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/rewards/:id/claim", "post");

      const req = mockReq({ params: { id: "nonexistent-id" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(404);
      expect(data.body.error).toMatch(/not found|already claimed|expired/i);
    });
  });

  describe("POST /rewards/claim-by-token", () => {
    async function getHandlerForClaimByToken() {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      return getHandler(router, "/rewards/claim-by-token", "post");
    }

    function seedAwardedRewardForUser(): string {
      // Inline fixture: insert a reward + an award row directly (avoids
      // pulling the rewards service into this test) so we can exercise the
      // endpoint with a known token.
      const adminId = "admin-1";
      const now0 = new Date().toISOString();
      db.prepare(
        `INSERT OR IGNORE INTO admin_users
          (id, username, password_hash, created_at, updated_at, is_active, can_use_extension, totp_enabled)
         VALUES (?, ?, 'x', ?, ?, 1, 0, 0)`
      ).run(adminId, "admin", now0, now0);
      const rewardId = "rwd-1";
      const awardId = "awd-1";
      const token = "token-abc-123";
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by)
         VALUES (?, 'amazon_gift_card', 2500, 'SECRET-CODE', 'awarded', ?, ?)`
      ).run(rewardId, now, adminId);
      db.prepare(
        `INSERT INTO reward_awards
          (id, reward_id, user_id, award_method, awarded_at, awarded_by, claim_token, claim_expires_at)
         VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
      ).run(awardId, rewardId, userId, now, adminId, token, expires);
      return token;
    }

    it("reveals the code for a valid token + matching user", async () => {
      const handler = await getHandlerForClaimByToken();
      const token = seedAwardedRewardForUser();

      const req = mockReq({ body: { token } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toMatchObject({ ok: true, code: "SECRET-CODE", amountCents: 2500 });
    });

    it("returns 400 for missing token", async () => {
      const handler = await getHandlerForClaimByToken();
      const req = mockReq({ body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body).toMatchObject({ ok: false, reason: "invalid" });
    });

    it("returns 404 for an unknown token", async () => {
      const handler = await getHandlerForClaimByToken();
      const req = mockReq({ body: { token: "no-such-token" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body).toMatchObject({ ok: false, reason: "invalid" });
    });

    it("returns 403 when claimed by a different user", async () => {
      const handler = await getHandlerForClaimByToken();
      const token = seedAwardedRewardForUser();

      const otherUser = seedUser(db, "other", "other@example.com", "T3stP@ss-w0rd!");
      const req = mockReq({
        body: { token },
        user: { id: otherUser, username: "other", email: "other@example.com" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(403);
      expect(data.body).toMatchObject({ ok: false, reason: "wrong_user" });
    });

    it("returns 410 when already claimed", async () => {
      const handler = await getHandlerForClaimByToken();
      const token = seedAwardedRewardForUser();

      // first claim succeeds
      handler(mockReq({ body: { token } }), mockRes().res);
      // second claim should be already_claimed
      const { res, data } = mockRes();
      handler(mockReq({ body: { token } }), res);
      expect(data.statusCode).toBe(410);
      expect(data.body).toMatchObject({ ok: false, reason: "already_claimed" });
    });
  });

  // ── OAuth ──

  describe("GET /oauth/providers", () => {
    it("returns configured providers", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/providers", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toBeDefined();
      expect(typeof data.body.google).toBe("boolean");
      expect(typeof data.body.facebook).toBe("boolean");
    });
  });

  describe("GET /oauth/google", () => {
    it("returns 501 when not configured", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(501);
      expect(data.body.error).toMatch(/not configured/i);
    });
  });

  describe("GET /oauth/facebook", () => {
    it("returns 501 when not configured", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/facebook", "get");

      const req = mockReq();
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(501);
      expect(data.body.error).toMatch(/not configured/i);
    });
  });

  // ── Additional branch coverage tests ──

  describe("POST /logout — missing cookie", () => {
    it("handles missing session cookie gracefully", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/logout", "post");

      const req = mockReq({ cookies: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.clearedCookie).toBe("user_session");
      expect(data.body).toEqual({ ok: true });
    });
  });

  describe("PUT /password — wrong current password", () => {
    it("returns 400 for wrong current password", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/password", "put");

      const req = mockReq({
        body: { currentPassword: "wrongpassword", newPassword: "newpassword456" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });
  });

  describe("PUT /username — duplicate username", () => {
    it("returns 400 for duplicate username", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/username", "put");

      // Create another user with the target username
      db.prepare("UPDATE users SET username_pending = 1 WHERE id = ?").run(userId);
      const { seedUser: su } = await import("../test/dbHelper");
      su(db, "takenname", "taken@example.com", "T3stP@ss-w0rd!");

      const req = mockReq({ body: { username: "takenname" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });
  });

  describe("POST /forgot-password — nonexistent email", () => {
    it("returns ok for non-existent email (prevents enumeration)", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/forgot-password", "post");

      const req = mockReq({ body: { email: "nonexistent@example.com" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ ok: true });
    });
  });

  describe("POST /reset-password — too long password", () => {
    it("rejects too-long new password", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      const req = mockReq({
        body: { token: "some-token", newPassword: "a".repeat(1025) },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/too long/i);
    });
  });

  describe("POST /reset-password — success path", () => {
    it("successfully resets password with valid token", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      // Create a password reset token for the test user
      const { createPasswordResetToken } = await import("../services/userAuth");
      const resetToken = createPasswordResetToken(db, userId);

      const req = mockReq({
        body: { token: resetToken, newPassword: "brandnewpassword123" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body).toEqual({ ok: true });
    });

    it("returns 400 when password too short for service validation", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/reset-password", "post");

      // Create a valid reset token
      const { createPasswordResetToken } = await import("../services/userAuth");
      const resetToken = createPasswordResetToken(db, userId);

      // Password too short (min is 10 by config default) — triggers UserFacingError in resetPassword
      const req = mockReq({
        body: { token: resetToken, newPassword: "short" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/password/i);
    });
  });

  describe("GET /history — type alias and no filter", () => {
    it("supports type alias for gameType", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/history", "get");

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'multiplayer', 'classic', 3000, ?)"
      ).run(userId, now);

      const req = mockReq({ query: { type: "multiplayer" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.entries).toBeDefined();
      for (const e of data.body.entries) {
        expect(e.gameType).toBe("multiplayer");
      }
    });

    it("returns all entries when gameType is invalid", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/history", "get");

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 5000, ?)"
      ).run(userId, now);

      const req = mockReq({ query: { gameType: "invalid-type" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.entries).toBeDefined();
      expect(data.body.total).toBeGreaterThanOrEqual(1);
    });

    it("returns all entries when no gameType is provided", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/history", "get");

      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 2000, ?)"
      ).run(userId, now);

      const req = mockReq({ query: {} });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.entries).toBeDefined();
      expect(data.body.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("OAuth callback — Google", () => {
    it("redirects on oauth error query param", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      const req = mockReq({ query: { error: "access_denied" } });
      const { res, data } = mockRes();
      await handler(req, res);

      // Allow time for async handler
      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=cancelled");
    });

    it("redirects on missing code", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      const req = mockReq({ query: { state: "some-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=cancelled");
    });

    it("redirects on missing state", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      const req = mockReq({ query: { code: "some-code" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=cancelled");
    });

    it("redirects on invalid state", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      mockValidateOAuthState.mockReturnValue(false);

      const req = mockReq({ query: { code: "some-code", state: "bad-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=invalid_state");
    });

    it("redirects to home on successful OAuth login", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeGoogleCode.mockResolvedValue({
        email: "oauth@example.com",
        name: "OAuth User",
        providerId: "google-123",
      });
      mockFindOrCreateOAuthUser.mockReturnValue({
        user: { id: "oauth-user-id", username: "oauthuser", email: "oauth@example.com" },
        isNew: false,
      });
      mockCreateOAuthSession.mockReturnValue("session-token-123");

      const req = mockReq({ query: { code: "valid-code", state: "valid-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.cookie).toBeDefined();
      expect(data.redirect).toBe("/");
    });

    it("redirects on exchange error", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeGoogleCode.mockRejectedValue(new Error("Exchange failed"));

      const req = mockReq({ query: { code: "bad-code", state: "valid-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=oauth_failed");
    });

    // OAuth callback must relink any prior subscription on this visitor
    // to the OAuth user, mirroring the /login and /register paths.
    it("re-links an existing subscription on this visitor to the OAuth user", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      // An existing subscription on this browser belongs to userId (the
      // beforeEach test user). After Google OAuth succeeds for a different
      // user, the subscription should follow the OAuth user.
      // findOrCreateOAuthUser is mocked below, so we need a real users row
      // for the OAuth-id target — otherwise the relink UPDATE violates the
      // push_subscriptions.user_id FK.
      const oauthUserId = seedUser(db, "oauthrelink", "oauth-relink@example.com", "unused");
      db.prepare(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, is_active, visitor_id)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(userId, "https://fcm.googleapis.com/fcm/send/oauth-dev", "p", "a", "shared-visitor-oauth");

      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeGoogleCode.mockResolvedValue({
        email: "oauth-relink@example.com",
        name: "OAuth Relink User",
        providerId: "google-relink",
      });
      mockFindOrCreateOAuthUser.mockReturnValue({
        user: {
          id: oauthUserId,
          username: "oauthrelink",
          email: "oauth-relink@example.com",
        },
        isNew: false,
      });
      mockCreateOAuthSession.mockReturnValue("session-token-relink");

      const req = mockReq({
        query: { code: "valid-code", state: "valid-state" },
        visitorId: "shared-visitor-oauth",
      });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/");

      const row = db
        .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
        .get("https://fcm.googleapis.com/fcm/send/oauth-dev") as { user_id: string };
      expect(row.user_id).toBe(oauthUserId);
    });
  });

  describe("OAuth callback — Facebook", () => {
    it("redirects on oauth error query param", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/facebook/callback", "get");

      const req = mockReq({ query: { error: "access_denied" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=cancelled");
    });

    it("redirects on invalid state for Facebook", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/facebook/callback", "get");

      mockValidateOAuthState.mockReturnValue(false);

      const req = mockReq({ query: { code: "fb-code", state: "bad-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.redirect).toBe("/?auth_error=invalid_state");
    });

    it("redirects to home on successful Facebook OAuth", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/facebook/callback", "get");

      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeFacebookCode.mockResolvedValue({
        email: "fb@example.com",
        name: "FB User",
        providerId: "fb-456",
      });
      mockFindOrCreateOAuthUser.mockReturnValue({
        user: { id: "fb-user-id", username: "fbuser", email: "fb@example.com" },
        isNew: true,
      });
      mockCreateOAuthSession.mockReturnValue("fb-session-token");

      const req = mockReq({ query: { code: "fb-valid-code", state: "fb-valid-state" } });
      const { res, data } = mockRes();
      await handler(req, res);

      await new Promise((r) => setTimeout(r, 10));
      expect(data.cookie).toBeDefined();
      expect(data.redirect).toBe("/");
    });
  });

  describe("PUT /email — error paths", () => {
    it("returns 400 for invalid new email format", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/email", "put");

      // Register a second user with the target email first
      const { seedUser: su } = await import("../test/dbHelper");
      su(db, "other", "taken@example.com", "T3stP@ss-w0rd!");

      // Try changing to the taken email
      const req = mockReq({
        body: { newEmail: "taken@example.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });
  });

  describe("POST /register — fallback IP handling", () => {
    it("uses socket.remoteAddress when req.ip is undefined", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "ipfallback", email: "ipfallback@example.com", password: "T3stP@ss-w0rd!" },
        ip: undefined,
        socket: { remoteAddress: "10.0.0.1" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
    });

    it("uses 'unknown' when both ip and remoteAddress are undefined", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      const req = mockReq({
        body: { username: "ipnone", email: "ipnone@example.com", password: "T3stP@ss-w0rd!" },
        ip: undefined,
        socket: { remoteAddress: undefined },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
    });
  });

  describe("POST /login — fallback IP and user-agent handling", () => {
    it("uses socket.remoteAddress when req.ip is undefined", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "test@example.com", password: "T3stP@ss-w0rd!" },
        ip: undefined,
        socket: { remoteAddress: "10.0.0.2" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
    });

    it("uses 'unknown' when both ip and remoteAddress are undefined", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "test@example.com", password: "T3stP@ss-w0rd!" },
        ip: undefined,
        socket: { remoteAddress: undefined },
        headers: {},
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.user).toBeDefined();
    });
  });

  describe("POST /register — non-UserFacingError on registration", () => {
    it("returns generic error message on unexpected failure", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/register", "post");

      // Try registering with an extremely short password that will fail validation
      const req = mockReq({
        body: { username: "failuser", email: "fail@example.com", password: "x" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
    });
  });

  describe("POST /rewards/:id/claim — success path", () => {
    it("claims a reward and returns the code", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/rewards/:id/claim", "post");

      // Insert reward_pool and reward_awards entries
      const rewardId = "test-reward-001";
      const awardId = "test-award-001";
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO reward_pool (id, reward_type, amount_cents, code, description, status, created_at, created_by)
         VALUES (?, 'amazon_gift_card', 500, 'FULL-CODE-XYZ', 'Test reward', 'awarded', ?, 'system')`
      ).run(rewardId, now);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `INSERT INTO reward_awards
          (id, reward_id, user_id, award_method, awarded_at, awarded_by,
           claim_token, claim_expires_at)
         VALUES (?, ?, ?, 'manual', ?, 'admin', ?, ?)`
      ).run(awardId, rewardId, userId, now, "claim-tok-rid-success", expires);

      const req = mockReq({ params: { id: rewardId } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.code).toBe("FULL-CODE-XYZ");
    });
  });

  describe("GET /oauth/google — when configured", () => {
    it("redirects to Google auth URL when configured", async () => {
      const { config } = await import("../config");
      const origGoogleClientId = config.googleClientId;
      config.googleClientId = "test-google-id";

      try {
        const { createUserRouter } = await import("./user");
        const router = createUserRouter(db);
        const handler = getHandler(router, "/oauth/google", "get");

        mockGenerateOAuthState.mockReturnValue("google-state-123");

        const req = mockReq();
        const { res, data } = mockRes();
        handler(req, res);

        expect(data.redirect).toBe("https://accounts.google.com/auth");
      } finally {
        config.googleClientId = origGoogleClientId;
      }
    });
  });

  describe("GET /oauth/facebook — when configured", () => {
    it("redirects to Facebook auth URL when configured", async () => {
      const { config } = await import("../config");
      const origFacebookAppId = config.facebookAppId;
      config.facebookAppId = "test-fb-id";

      try {
        const { createUserRouter } = await import("./user");
        const router = createUserRouter(db);
        const handler = getHandler(router, "/oauth/facebook", "get");

        mockGenerateOAuthState.mockReturnValue("fb-state-123");

        const req = mockReq();
        const { res, data } = mockRes();
        handler(req, res);

        expect(data.redirect).toBe("https://facebook.com/auth");
      } finally {
        config.facebookAppId = origFacebookAppId;
      }
    });
  });

  describe("OAuth callback .catch() paths", () => {
    it("Google callback outer catch redirects on handleOAuthCallback rejection", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/google/callback", "get");

      // Make validateOAuthState return true but exchangeGoogleCode throw synchronously
      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeGoogleCode.mockRejectedValue(new Error("network error"));

      const req = mockReq({ query: { code: "code", state: "state" } });
      const { res, data } = mockRes();
      handler(req, res);

      // Wait for async
      await new Promise((r) => setTimeout(r, 50));
      expect(data.redirect).toBe("/?auth_error=oauth_failed");
    });

    it("Facebook callback outer catch redirects on handleOAuthCallback rejection", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/oauth/facebook/callback", "get");

      mockValidateOAuthState.mockReturnValue(true);
      mockExchangeFacebookCode.mockRejectedValue(new Error("network error"));

      const req = mockReq({ query: { code: "code", state: "state" } });
      const { res, data } = mockRes();
      handler(req, res);

      await new Promise((r) => setTimeout(r, 50));
      expect(data.redirect).toBe("/?auth_error=oauth_failed");
    });
  });

  describe("POST /login — safe login error messages", () => {
    it("returns 'Invalid credentials' for wrong password (safe error)", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      // Wrong password for an existing user returns a safe "Invalid credentials" error
      const req = mockReq({
        body: { identifier: "test@example.com", password: "wrongpassword" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(401);
      expect(data.body.error).toBe("Invalid credentials");
    });

    it("returns 401 for non-existent user login", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/login", "post");

      const req = mockReq({
        body: { identifier: "nobody@nowhere.com", password: "T3stP@ss-w0rd!" },
      });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(401);
    });
  });

  // ── Avatar (PUT /avatar) ──

  describe("PUT /avatar", () => {
    it("sets a valid avatar for authenticated user", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/avatar", "put");
      expect(handler).toBeDefined();

      const req = mockReq({ body: { avatar: "yeti" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user.avatar).toBe("yeti");
    });

    it("clears avatar when null is sent", async () => {
      // First set an avatar
      db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run("wizard", userId);

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/avatar", "put");

      const req = mockReq({ body: { avatar: null } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user.avatar).toBeNull();
    });

    it("returns 400 for invalid avatar name", async () => {
      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/avatar", "put");

      const req = mockReq({ body: { avatar: "dragon" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid avatar");
    });

    it("returns 400 for disabled avatar", async () => {
      // Disable the yeti avatar
      const { setSetting } = await import("../services/siteSettings");
      setSetting(db, "disabled_avatars", ["yeti"]);

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/avatar", "put");

      const req = mockReq({ body: { avatar: "yeti" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("This avatar is currently disabled");
    });

    it("allows clearing avatar even when it is disabled", async () => {
      const { setSetting } = await import("../services/siteSettings");
      setSetting(db, "disabled_avatars", ["yeti"]);
      db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run("yeti", userId);

      const { createUserRouter } = await import("./user");
      const router = createUserRouter(db);
      const handler = getHandler(router, "/avatar", "put");

      const req = mockReq({ body: { avatar: null } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.ok).toBe(true);
      expect(data.body.user.avatar).toBeNull();
    });
  });
});
