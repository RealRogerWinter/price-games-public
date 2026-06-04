/**
 * Tests for admin notification management routes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedAdminUser, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { saveSubscription } from "../services/pushNotification";

// Mock web-push to prevent real HTTP calls
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  },
}));

vi.mock("../db", () => {
  return { default: null as unknown };
});

let testDb: DatabaseType;
let adminSessionToken: string;

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;

  // Create admin user and session
  const adminId = seedAdminUser(testDb, "admin", "adminpass123");
  adminSessionToken = `admin-session-${Date.now()}`;
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO admin_sessions (id, admin_user_id, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(adminSessionToken, adminId, now, expires, now);
});

const { createAdminNotificationRouter } = await import("./adminNotifications");

/** Extract route handler (last in stack, after middleware). */
function getHandler(method: string, path: string) {
  const router = createAdminNotificationRouter(testDb);
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
    cookies: { admin_session: adminSessionToken },
    ...overrides,
  };
}

function mockRes() {
  const data: { statusCode?: number; body?: unknown } = {};
  const res: any = {
    json(d: unknown) { data.body = d; data.statusCode = data.statusCode || 200; return res; },
    status(code: number) { data.statusCode = code; return res; },
  };
  return { res, data };
}

// ── Templates ─────────────────────────────────────────────────────────────

describe("POST /templates", () => {
  it("creates a template", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({
      body: { name: "Test", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" },
    }), res);
    expect(data.statusCode).toBe(201);
    expect((data.body as any).name).toBe("Test");
  });

  it("rejects missing name", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({ body: { type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects invalid type", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({ body: { name: "X", type: "invalid", titleTemplate: "T", bodyTemplate: "B" } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects non-relative urlPath", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({
      body: { name: "X", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B", urlPath: "javascript:alert(1)" },
    }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects invalid ttl", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({
      body: { name: "X", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B", ttl: -1 },
    }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects duplicate name", () => {
    const handler = getHandler("post", "/templates");
    handler(mockReq({ body: { name: "Dup", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" } }), mockRes().res);
    const { res, data } = mockRes();
    handler(mockReq({ body: { name: "Dup", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" } }), res);
    expect(data.statusCode).toBe(409);
  });
});

describe("GET /templates", () => {
  it("lists templates", () => {
    const postHandler = getHandler("post", "/templates");
    postHandler(mockReq({ body: { name: "T1", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" } }), mockRes().res);

    const handler = getHandler("get", "/templates");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).templates).toHaveLength(1);
  });
});

describe("DELETE /templates/:id", () => {
  it("deletes a template", () => {
    const postHandler = getHandler("post", "/templates");
    const { res: createRes, data: createData } = mockRes();
    postHandler(mockReq({ body: { name: "Del", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" } }), createRes);
    const id = (createData.body as any).id;

    const handler = getHandler("delete", "/templates/:id");
    const { res, data } = mockRes();
    handler(mockReq({ params: { id: String(id) } }), res);
    expect((data.body as any).ok).toBe(true);
  });

  it("returns 404 for nonexistent template", () => {
    const handler = getHandler("delete", "/templates/:id");
    const { res, data } = mockRes();
    handler(mockReq({ params: { id: "9999" } }), res);
    expect(data.statusCode).toBe(404);
  });
});

// ── Send ──────────────────────────────────────────────────────────────────

describe("POST /send", () => {
  it("sends ad-hoc notification to all subscribers", async () => {
    const userId = seedUser(testDb, "notifuser", "notif@test.com");
    saveSubscription(testDb, userId, {
      endpoint: "https://fcm.googleapis.com/test",
      expirationTime: null,
      keys: { p256dh: "key1", auth: "auth1" },
    });

    const handler = getHandler("post", "/send");
    const { res, data } = mockRes();
    await handler(mockReq({
      body: { title: "Hello", body: "World", type: "daily_puzzle" },
    }), res);
    expect((data.body as any).sent).toBeGreaterThanOrEqual(1);
  });

  it("rejects missing title/body for ad-hoc", async () => {
    const handler = getHandler("post", "/send");
    const { res, data } = mockRes();
    await handler(mockReq({ body: { type: "daily_puzzle" } }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("POST /test", () => {
  it("sends test to all subscribers", async () => {
    const userId = seedUser(testDb, "testuser2", "t2@test.com");
    saveSubscription(testDb, userId, {
      endpoint: "https://fcm.googleapis.com/test2",
      expirationTime: null,
      keys: { p256dh: "key2", auth: "auth2" },
    });

    const handler = getHandler("post", "/test");
    const { res, data } = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect((data.body as any).sent).toBeGreaterThanOrEqual(1);
  });
});

// ── Stats & Log ───────────────────────────────────────────────────────────

describe("GET /stats", () => {
  it("returns stats", () => {
    const handler = getHandler("get", "/stats");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).totalSubscribers).toBeDefined();
    expect((data.body as any).deliveryRate).toBeDefined();
  });

  it("caps days at 90", () => {
    const handler = getHandler("get", "/stats");
    const { res, data } = mockRes();
    handler(mockReq({ query: { days: "999" } }), res);
    // Should not error — capped internally
    expect(data.statusCode).toBe(200);
  });
});

describe("GET /log", () => {
  it("returns paginated log", () => {
    const handler = getHandler("get", "/log");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).entries).toBeDefined();
    expect((data.body as any).total).toBeDefined();
  });

  it("rejects invalid status filter", () => {
    const handler = getHandler("get", "/log");
    const { res, data } = mockRes();
    handler(mockReq({ query: { status: "bogus" } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects invalid type filter", () => {
    const handler = getHandler("get", "/log");
    const { res, data } = mockRes();
    handler(mockReq({ query: { type: "bogus" } }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("GET /subscribers", () => {
  it("returns subscriber counts", () => {
    const handler = getHandler("get", "/subscribers");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).total).toBeDefined();
    expect((data.body as any).active).toBeDefined();
  });
});
