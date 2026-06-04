/**
 * Tests for push notification REST API routes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;
let userId: string;

vi.mock("../db", () => {
  return { default: null as unknown };
});

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;
  userId = seedUser(testDb, "pushuser", "push@test.com");
});

const { createPushRouter } = await import("./push");

/**
 * Extract the last route handler by method + path from the Express router stack.
 * The last handler in the route stack is the actual handler (after middleware like requireUser).
 */
function getHandler(method: string, path: string) {
  const router = createPushRouter(testDb);
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path && layer.route?.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockReq(overrides: any = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    user: { id: userId },
    ...overrides,
  };
}

function mockRes() {
  const data: { statusCode?: number; body?: unknown; redirectUrl?: string } = {};
  const res: any = {
    json(d: unknown) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
    redirect(url: string) { data.statusCode = 302; data.redirectUrl = url; return res; },
  };
  return { res, data };
}

const validSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-123",
  expirationTime: null,
  keys: {
    p256dh: "BNhJy2c7DX0KZQKY1L7Hx2aF0LnW0v2xQy",
    auth: "VqPr2F4P_12345",
  },
};

describe("POST /subscribe", () => {
  it("saves a subscription", () => {
    const handler = getHandler("post", "/subscribe");
    const req = mockReq({ body: validSubscription, headers: { "user-agent": "Test/1.0" } });
    const { res, data } = mockRes();

    handler(req, res);
    expect(data.body).toEqual({ ok: true });

    const sub = testDb.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").get(userId);
    expect(sub).toBeTruthy();
  });

  it("rejects missing endpoint", () => {
    const handler = getHandler("post", "/subscribe");
    const req = mockReq({ body: {} });
    const { res, data } = mockRes();

    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects invalid endpoint URL", () => {
    const handler = getHandler("post", "/subscribe");
    const req = mockReq({ body: { endpoint: "not-a-url", keys: { p256dh: "a", auth: "b" } } });
    const { res, data } = mockRes();

    handler(req, res);
    expect(data.statusCode).toBe(400);
  });
});

describe("POST /unsubscribe", () => {
  it("removes a subscription", () => {
    // Subscribe first
    const subHandler = getHandler("post", "/subscribe");
    subHandler(mockReq({ body: validSubscription }), mockRes().res);

    const handler = getHandler("post", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ body: { endpoint: validSubscription.endpoint } }), res);

    expect(data.body).toEqual({ ok: true, removed: true });
  });

  it("rejects missing endpoint", () => {
    const handler = getHandler("post", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ body: {} }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("GET /preferences", () => {
  it("returns default preferences", () => {
    const handler = getHandler("get", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq(), res);

    expect((data.body as any).pushEnabled).toBe(true);
    expect((data.body as any).streakReminder).toBe(true);
    expect((data.body as any).promotional).toBe(false);
  });
});

describe("PUT /preferences", () => {
  it("updates preferences", () => {
    const handler = getHandler("put", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq({ body: { promotional: true, timezone: "US/Eastern" } }), res);

    expect((data.body as any).promotional).toBe(true);
    expect((data.body as any).timezone).toBe("US/Eastern");
  });

  it("rejects invalid quiet hours format", () => {
    const handler = getHandler("put", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq({ body: { quietHoursStart: "invalid" } }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("GET /click/:logId", () => {
  it("records click and redirects", () => {
    testDb.prepare(
      `INSERT INTO notification_log (user_id, type, url_path, status) VALUES (?, ?, ?, 'sent')`,
    ).run(userId, "daily_puzzle", "/daily");
    const logId = (testDb.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const handler = getHandler("get", "/click/:logId");
    const { res, data } = mockRes();
    handler(mockReq({ params: { logId: String(logId) }, query: { r: "/daily" } }), res);

    expect(data.statusCode).toBe(302);
    expect(data.redirectUrl).toBe("/daily");

    const row = testDb.prepare("SELECT status FROM notification_log WHERE id = ?").get(logId) as { status: string };
    expect(row.status).toBe("clicked");
  });

  it("redirects to / for invalid logId", () => {
    const handler = getHandler("get", "/click/:logId");
    const { res, data } = mockRes();
    handler(mockReq({ params: { logId: "abc" } }), res);
    expect(data.redirectUrl).toBe("/");
  });

  it("blocks open redirect via absolute URL in r param", () => {
    testDb.prepare(
      `INSERT INTO notification_log (user_id, type, url_path, status) VALUES (?, ?, ?, 'sent')`,
    ).run(userId, "daily_puzzle", "/daily");
    const logId = (testDb.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const handler = getHandler("get", "/click/:logId");
    const { res, data } = mockRes();
    handler(mockReq({ params: { logId: String(logId) }, query: { r: "https://evil.com" } }), res);
    expect(data.redirectUrl).toBe("/");
  });

  it("blocks open redirect via protocol-relative URL", () => {
    testDb.prepare(
      `INSERT INTO notification_log (user_id, type, url_path, status) VALUES (?, ?, ?, 'sent')`,
    ).run(userId, "daily_puzzle", "/daily");
    const logId = (testDb.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

    const handler = getHandler("get", "/click/:logId");
    const { res, data } = mockRes();
    handler(mockReq({ params: { logId: String(logId) }, query: { r: "//evil.com" } }), res);
    expect(data.redirectUrl).toBe("/");
  });
});
