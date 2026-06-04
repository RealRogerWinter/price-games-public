/**
 * Tests for admin email management routes (/api/admin/email/*).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedAdminUser, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

vi.mock("../db", () => ({ default: null as unknown }));

// Mock the email transport so tests never attempt real Resend calls.
const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn().mockResolvedValue({ ok: true, providerMessageId: "msg-1" }),
}));
vi.mock("../services/email", async () => {
  const actual = await vi.importActual<typeof import("../services/email")>("../services/email");
  return { ...actual, sendEmail: mockSendEmail };
});

let testDb: DatabaseType;
let adminSessionToken: string;
let userId: string;

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;

  const adminId = seedAdminUser(testDb, "admin", "adminpass123");
  adminSessionToken = `admin-session-${Date.now()}`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  testDb
    .prepare(
      `INSERT INTO admin_sessions (id, admin_user_id, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(adminSessionToken, adminId, now, expires, now);

  userId = seedUser(testDb, "bob", "bob@test.com");
  mockSendEmail.mockClear();
});

const { createAdminEmailRouter } = await import("./adminEmail");
const { updateEmailPreferences, getEmailPreferences } = await import(
  "../services/emailNotification"
);

function getHandler(method: string, path: string) {
  const router = createAdminEmailRouter(testDb);
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

// ── Templates ──────────────────────────────────────────────────────────────

describe("POST /templates", () => {
  it("creates a template and returns 201", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(
      mockReq({
        body: {
          name: "streak-v1",
          type: "streak_risk",
          subjectTemplate: "Your streak!",
          htmlTemplate: "<p>hi</p>",
        },
      }),
      res,
    );
    expect(data.statusCode).toBe(201);
    expect((data.body as any).id).toBeGreaterThan(0);
  });

  it("rejects missing fields with 400", () => {
    const handler = getHandler("post", "/templates");
    const { res, data } = mockRes();
    handler(mockReq({ body: { name: "x" } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("returns 409 on duplicate name", () => {
    const handler = getHandler("post", "/templates");
    const body = {
      name: "dup",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
    };
    handler(mockReq({ body }), mockRes().res);
    const { res, data } = mockRes();
    handler(mockReq({ body }), res);
    expect(data.statusCode).toBe(409);
  });
});

describe("GET /templates", () => {
  it("returns list", () => {
    const post = getHandler("post", "/templates");
    post(
      mockReq({
        body: {
          name: "x",
          type: "promotional",
          subjectTemplate: "s",
          htmlTemplate: "h",
        },
      }),
      mockRes().res,
    );

    const handler = getHandler("get", "/templates");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).templates).toHaveLength(1);
  });
});

describe("PUT /templates/:id", () => {
  it("updates fields", () => {
    const post = getHandler("post", "/templates");
    const created = mockRes();
    post(
      mockReq({
        body: {
          name: "edit",
          type: "promotional",
          subjectTemplate: "s",
          htmlTemplate: "h",
        },
      }),
      created.res,
    );
    const id = (created.data.body as any).id;

    const put = getHandler("put", "/templates/:id");
    const { res, data } = mockRes();
    put(mockReq({ params: { id: String(id) }, body: { isActive: false } }), res);
    expect((data.body as any).isActive).toBe(false);
  });
});

// ── Send ───────────────────────────────────────────────────────────────────

describe("POST /send", () => {
  it("sends ad-hoc to a single user (admin override bypasses opt-in)", async () => {
    const handler = getHandler("post", "/send");
    const { res, data } = mockRes();
    await handler(
      mockReq({
        body: {
          subject: "Hi",
          html: "<p>Hi</p>",
          type: "custom",
          userId,
          adminOverride: true,
        },
      }),
      res,
    );
    expect(data.body).toMatchObject({ ok: true, sent: 1 });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("reports cooldown_global when non-override and user already emailed", async () => {
    updateEmailPreferences(testDb, userId, { emailEnabled: true, promotional: true });

    const handler = getHandler("post", "/send");

    // First send goes through.
    await handler(
      mockReq({
        body: { subject: "A", html: "<p>A</p>", type: "promotional", userId },
      }),
      mockRes().res,
    );
    // Second is blocked by the global cooldown.
    const { res, data } = mockRes();
    await handler(
      mockReq({
        body: { subject: "B", html: "<p>B</p>", type: "promotional", userId },
      }),
      res,
    );
    expect((data.body as any).sent).toBe(0);
    expect((data.body as any).reason).toBe("cooldown_global");
  });

  it("rejects ad-hoc send without audience", async () => {
    const handler = getHandler("post", "/send");
    const { res, data } = mockRes();
    await handler(
      mockReq({ body: { subject: "A", html: "<p>A</p>", type: "custom" } }),
      res,
    );
    expect(data.statusCode).toBe(400);
  });

  it("ad-hoc toAllOptedIn enumerates via preferences", async () => {
    const alice = seedUser(testDb, "alice", "alice@test.com");
    updateEmailPreferences(testDb, alice, { emailEnabled: true, promotional: true });
    updateEmailPreferences(testDb, userId, { emailEnabled: true, promotional: true });

    const handler = getHandler("post", "/send");
    const { res, data } = mockRes();
    await handler(
      mockReq({
        body: {
          subject: "A",
          html: "<p>A</p>",
          type: "promotional",
          toAllOptedIn: true,
        },
      }),
      res,
    );
    expect((data.body as any).sent).toBe(2);
  });
});

// ── Triggers ───────────────────────────────────────────────────────────────

describe("GET /triggers / PUT /triggers/:type", () => {
  it("returns all trigger rows", () => {
    const handler = getHandler("get", "/triggers");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    const triggers = (data.body as any).triggers;
    expect(triggers.length).toBeGreaterThanOrEqual(5);
  });

  it("updates a single trigger", () => {
    const put = getHandler("put", "/triggers/:type");
    const { res, data } = mockRes();
    put(
      mockReq({
        params: { type: "streak_risk" },
        body: { isEnabled: true, cooldownHours: 48 },
      }),
      res,
    );
    expect((data.body as any).isEnabled).toBe(true);
    expect((data.body as any).cooldownHours).toBe(48);
  });

  it("rejects invalid cooldown", () => {
    const put = getHandler("put", "/triggers/:type");
    const { res, data } = mockRes();
    put(mockReq({ params: { type: "streak_risk" }, body: { cooldownHours: -1 } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects invalid type", () => {
    const put = getHandler("put", "/triggers/:type");
    const { res, data } = mockRes();
    put(mockReq({ params: { type: "nonsense" }, body: {} }), res);
    expect(data.statusCode).toBe(400);
  });
});

// ── Admin per-user preferences ─────────────────────────────────────────────

describe("GET/PUT /preferences/:userId", () => {
  it("reads + writes a user's prefs", () => {
    const put = getHandler("put", "/preferences/:userId");
    put(
      mockReq({
        params: { userId },
        body: { emailEnabled: true, promotional: true },
      }),
      mockRes().res,
    );
    expect(getEmailPreferences(testDb, userId).promotional).toBe(true);

    const get = getHandler("get", "/preferences/:userId");
    const { res, data } = mockRes();
    get(mockReq({ params: { userId } }), res);
    expect((data.body as any).promotional).toBe(true);
  });
});

// ── Stats + Log ─────────────────────────────────────────────────────────────

describe("GET /stats and /log", () => {
  it("returns a stats object with zero counts on a fresh DB", () => {
    const handler = getHandler("get", "/stats");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).totalSent).toBe(0);
  });

  it("rejects invalid log filter", () => {
    const handler = getHandler("get", "/log");
    const { res, data } = mockRes();
    handler(mockReq({ query: { status: "??" } }), res);
    expect(data.statusCode).toBe(400);
  });
});
