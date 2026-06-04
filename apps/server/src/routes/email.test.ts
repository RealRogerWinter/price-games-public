/**
 * Tests for user-facing email routes (/api/email/*).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

vi.mock("../db", () => ({ default: null as unknown }));

// Pin the unsubscribe secret + appUrl so token round-trips are deterministic.
// Also pin a webhook secret so the /webhook/resend tests can sign payloads.
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...actual,
    config: {
      ...actual.config,
      emailUnsubSecret: "test-secret",
      appUrl: "https://price.games",
      emailResendWebhookSecret: "whsec_" + Buffer.from("webhook-test-key").toString("base64"),
    },
  };
});

let testDb: DatabaseType;
let userId: string;

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;
  userId = seedUser(testDb, "alice", "alice@test.com");
});

const { createEmailRouter } = await import("./email");
const { signUnsubToken } = await import("../services/emailUnsubToken");
const { updateEmailPreferences, getEmailPreferences } = await import(
  "../services/emailNotification"
);

function getHandler(method: string, path: string) {
  const router = createEmailRouter(testDb);
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path && layer.route?.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockReq(overrides: any = {}) {
  const headers = overrides.headers ?? {};
  return {
    params: {},
    query: {},
    body: {},
    headers,
    user: { id: userId },
    // express's req.header() looks up case-insensitively in headers;
    // tests can override explicitly by passing an overrides.header fn.
    header:
      overrides.header ??
      ((name: string) => headers[name.toLowerCase()] ?? headers[name]),
    ...overrides,
  };
}

function mockRes() {
  const data: { statusCode?: number; body?: unknown; html?: string; contentType?: string } = {};
  const res: any = {
    json(d: unknown) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
    send(d: string) { data.html = d; return res; },
    type(t: string) { data.contentType = t; return res; },
  };
  return { res, data };
}

describe("GET /preferences", () => {
  it("returns defaults for a fresh user", () => {
    const handler = getHandler("get", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq(), res);
    expect((data.body as any).emailEnabled).toBe(false);
    expect((data.body as any).preferredHour).toBe(10);
  });
});

describe("PUT /preferences", () => {
  it("updates and echoes back the new prefs", () => {
    const handler = getHandler("put", "/preferences");
    const { res, data } = mockRes();
    handler(
      mockReq({
        body: { emailEnabled: true, preferredHour: 18, timezone: "America/New_York" },
      }),
      res,
    );
    expect((data.body as any).emailEnabled).toBe(true);
    expect((data.body as any).preferredHour).toBe(18);
    expect((data.body as any).timezone).toBe("America/New_York");
  });

  it("rejects invalid preferredHour", () => {
    const handler = getHandler("put", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq({ body: { preferredHour: 25 } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("rejects non-string timezone", () => {
    const handler = getHandler("put", "/preferences");
    const { res, data } = mockRes();
    handler(mockReq({ body: { timezone: 123 } }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("GET /unsubscribe", () => {
  it("flips a single preference on valid token", () => {
    updateEmailPreferences(testDb, userId, {
      emailEnabled: true,
      promotional: true,
      streakRisk: true,
    });
    const token = signUnsubToken({ userId, type: "promotional" });
    const handler = getHandler("get", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ query: { token } }), res);
    expect(data.html).toContain("Unsubscribed");
    const p = getEmailPreferences(testDb, userId);
    expect(p.promotional).toBe(false);
    expect(p.streakRisk).toBe(true);
    expect(p.emailEnabled).toBe(true);
  });

  it("rejects a tampered token with a 400", () => {
    const handler = getHandler("get", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ query: { token: "broken.token" } }), res);
    expect(data.statusCode).toBe(400);
  });

  it("all=1 unsubscribes from everything", () => {
    updateEmailPreferences(testDb, userId, {
      emailEnabled: true,
      promotional: true,
      streakRisk: true,
      weeklyDigest: true,
    });
    const token = signUnsubToken({ userId, type: "promotional" });
    const handler = getHandler("get", "/unsubscribe");
    const { res } = mockRes();
    handler(mockReq({ query: { token, all: "1" } }), res);
    const p = getEmailPreferences(testDb, userId);
    expect(p.emailEnabled).toBe(false);
    expect(p.streakRisk).toBe(false);
    expect(p.weeklyDigest).toBe(false);
  });
});

describe("POST /unsubscribe", () => {
  it("works with the body-embedded token (RFC 8058 one-click)", () => {
    updateEmailPreferences(testDb, userId, { emailEnabled: true, promotional: true });
    const token = signUnsubToken({ userId, type: "promotional" });
    const handler = getHandler("post", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ body: { token } }), res);
    expect(data.body).toEqual({ ok: true });
    expect(getEmailPreferences(testDb, userId).promotional).toBe(false);
  });

  it("rejects a missing token with a 400", () => {
    const handler = getHandler("post", "/unsubscribe");
    const { res, data } = mockRes();
    handler(mockReq({ body: {} }), res);
    expect(data.statusCode).toBe(400);
  });
});

describe("POST /webhook/resend", () => {
  // Build a signed request matching the Svix signature scheme the
  // production handler expects: svix-id + svix-timestamp + body, HMAC'd
  // with the decoded webhook secret. Without this, every request is 401.
  function signedReq(body: Record<string, unknown>) {
    const { createHmac } = require("node:crypto");
    const svixId = "msg_test_1";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const bodyStr = JSON.stringify(body);
    const rawSecret = Buffer.from("webhook-test-key").toString("base64");
    const key = Buffer.from(rawSecret, "base64");
    const sig = createHmac("sha256", key)
      .update(`${svixId}.${svixTimestamp}.${bodyStr}`)
      .digest("base64");
    return mockReq({
      body,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": `v1,${sig}`,
      },
      header: (name: string) =>
        ({
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": `v1,${sig}`,
        })[name.toLowerCase()],
    });
  }

  it("rejects requests missing a signature with 401", () => {
    const handler = getHandler("post", "/webhook/resend");
    const { res, data } = mockRes();
    handler(
      mockReq({
        body: { type: "email.bounced", data: { email_id: "x" } },
        header: () => undefined,
      }),
      res,
    );
    expect(data.statusCode).toBe(401);
  });

  it("rejects forged signatures with 401", () => {
    const handler = getHandler("post", "/webhook/resend");
    const { res, data } = mockRes();
    handler(
      mockReq({
        body: { type: "email.bounced", data: { email_id: "x" } },
        header: (n: string) =>
          ({
            "svix-id": "a",
            "svix-timestamp": String(Math.floor(Date.now() / 1000)),
            "svix-signature": "v1,AAAAAAAA",
          })[n.toLowerCase()],
      }),
      res,
    );
    expect(data.statusCode).toBe(401);
  });

  it("maps email.bounced to a status flip + unsubscribe-all (signed)", () => {
    testDb
      .prepare(
        `INSERT INTO email_log (user_id, type, to_address, subject, status, provider_message_id)
         VALUES (?, 'promotional', 'alice@test.com', 's', 'sent', 'prov-xyz')`,
      )
      .run(userId);
    updateEmailPreferences(testDb, userId, { emailEnabled: true, promotional: true });

    const handler = getHandler("post", "/webhook/resend");
    const { res, data } = mockRes();
    handler(signedReq({ type: "email.bounced", data: { email_id: "prov-xyz" } }), res);
    expect(data.body).toEqual({ ok: true });

    const log = testDb
      .prepare(`SELECT status FROM email_log WHERE provider_message_id = 'prov-xyz'`)
      .get() as { status: string };
    expect(log.status).toBe("bounced");
    expect(getEmailPreferences(testDb, userId).emailEnabled).toBe(false);
  });

  it("email.opened flips status without touching prefs (signed)", () => {
    testDb
      .prepare(
        `INSERT INTO email_log (user_id, type, to_address, subject, status, provider_message_id)
         VALUES (?, 'promotional', 'alice@test.com', 's', 'sent', 'prov-open')`,
      )
      .run(userId);

    const handler = getHandler("post", "/webhook/resend");
    handler(
      signedReq({ type: "email.opened", data: { email_id: "prov-open" } }),
      mockRes().res,
    );
    const log = testDb
      .prepare(`SELECT status, opened_at FROM email_log WHERE provider_message_id = 'prov-open'`)
      .get() as { status: string; opened_at: string | null };
    expect(log.status).toBe("opened");
    expect(log.opened_at).not.toBeNull();
  });

  it("is a no-op for unknown event types (signed)", () => {
    const handler = getHandler("post", "/webhook/resend");
    const { res, data } = mockRes();
    handler(signedReq({ type: "email.weird", data: { email_id: "whatever" } }), res);
    expect(data.body).toEqual({ ok: true });
  });
});
