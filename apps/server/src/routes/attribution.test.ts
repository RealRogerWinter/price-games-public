/**
 * Tests for the anonymous attribution REST endpoint.
 *
 * Exercises the router in isolation (handlers called directly, no express
 * supertest — matches the style of the other route tests in this repo).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { createAttributionRouter } from "./attribution";
import { getVisitorAttribution } from "../services/visitorAttribution";

let db: DatabaseType;
let router: ReturnType<typeof createAttributionRouter>;

beforeEach(() => {
  db = createTestDb();
  router = createAttributionRouter(db);
});

/**
 * Resolve the final route handler for a given path, skipping any inline
 * middleware (e.g. `router.post("/track", optionalUser, handler)` has
 * two stack entries; we want the last one, which is the handler proper).
 */
function getHandler(path: string, method: string = "post") {
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path) {
      const stack = layer.route.stack.filter((s: any) => s.method === method);
      return stack[stack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockRes() {
  const data: { statusCode?: number; body?: any } = {};
  const res = {
    json(d: any) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
  } as any;
  return { res, data };
}

describe("POST /track", () => {
  it("records a valid attribution payload against the visitor cookie", () => {
    const handler = getHandler("/track");
    const { res, data } = mockRes();
    const req = {
      visitorId: "11111111-2222-3333-4444-555555555555",
      body: {
        attribution: {
          utm_source: "reddit",
          utm_medium: "social",
          utm_campaign: "launch",
        },
      },
    } as any;

    handler(req, res);

    expect(data.body).toEqual({ recorded: true });
    const row = getVisitorAttribution(db, req.visitorId);
    expect(row).not.toBeNull();
    expect(row!.utmSource).toBe("reddit");
    expect(row!.utmMedium).toBe("social");
    expect(row!.utmCampaign).toBe("launch");
  });

  it("is a no-op on the second call (first-touch wins)", () => {
    const handler = getHandler("/track");
    const req = {
      visitorId: "11111111-2222-3333-4444-555555555555",
      body: { attribution: { utm_source: "reddit" } },
    } as any;

    const { res: res1, data: data1 } = mockRes();
    handler(req, res1);
    expect(data1.body).toEqual({ recorded: true });

    const req2 = {
      visitorId: req.visitorId,
      body: { attribution: { utm_source: "google" } },
    } as any;
    const { res: res2, data: data2 } = mockRes();
    handler(req2, res2);
    expect(data2.body).toEqual({ recorded: false });

    const row = getVisitorAttribution(db, req.visitorId);
    expect(row!.utmSource).toBe("reddit");
  });

  it("rejects payloads missing utm_source", () => {
    const handler = getHandler("/track");
    const { res, data } = mockRes();
    const req = {
      visitorId: "11111111-2222-3333-4444-555555555555",
      body: { attribution: { utm_medium: "social" } },
    } as any;

    handler(req, res);
    expect(data.body).toEqual({ recorded: false });
  });

  it("does nothing when req.visitorId is absent", () => {
    const handler = getHandler("/track");
    const { res, data } = mockRes();
    const req = {
      body: { attribution: { utm_source: "reddit" } },
    } as any;

    handler(req, res);
    expect(data.body).toEqual({ recorded: false });
  });

  it("skips insert when the request is made by an authenticated user", () => {
    // Signed-in users already have their cohort captured on the users
    // row via `storeSignupAttribution()` at registration time. Writing a
    // new visitor_attribution row for an authenticated click would
    // double-count them across the signups AND anonymousPlays funnel
    // rows. `optionalUser` populates req.user; the handler then no-ops.
    const handler = getHandler("/track");
    const visitorId = "11111111-2222-3333-4444-555555555555";
    const { res, data } = mockRes();
    const req = {
      visitorId,
      user: { id: "user-1", username: "alice" },
      body: { attribution: { utm_source: "reddit" } },
    } as any;

    handler(req, res);

    expect(data.body).toEqual({ recorded: false });
    // No row should have been written.
    const row = getVisitorAttribution(db, visitorId);
    expect(row).toBeNull();
  });
});
