/**
 * End-to-end integration test for the analytics beacon ingest path.
 *
 * Boots a real Express + http.Server, sends real HTTP POST requests with
 * the exact `BeaconEnvelope` shape the web client emits, and asserts the
 * events land in the events table via the same `recordEventFromRequest`
 * pipeline production uses.
 *
 * The intent is to catch wire-format drift between the client beacon
 * (apps/web/src/analytics/beacon.ts) and the server route
 * (apps/server/src/routes/events.ts) — drift that the existing mocked
 * tests on either side could individually pass while the seam between
 * them silently broke.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  ANALYTICS_EVENTS,
  type BeaconEnvelope,
} from "@price-game/shared";

let testDb: DatabaseType;
let server: HttpServer;
let baseUrl: string;

vi.mock("../db", () => ({ default: null as DatabaseType | null }));

beforeEach(async () => {
  testDb = createTestDb();
  const dbMod = await import("../db");
  (dbMod as unknown as { default: DatabaseType }).default = testDb;

  // Imports must happen AFTER the module mock has been resolved so the
  // route handler closes over the test DB rather than a stale handle.
  const { createEventsRouter } = await import("../routes/events");
  const { visitorCookie } = await import("../middleware/visitorCookie");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // visitorCookie middleware mints / refreshes the visitor cookie used
  // by recordEventFromRequest. Without it the route silently no-ops
  // because visitorId would be missing.
  app.use("/api", visitorCookie);
  app.use("/api/events", createEventsRouter());

  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  if (server) server.close();
});

function makeEnvelope(
  overrides: Partial<BeaconEnvelope["events"][number]> = {},
  count: number = 1,
): BeaconEnvelope {
  const tabId = randomUUID();
  const events: BeaconEnvelope["events"] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      name: ANALYTICS_EVENTS.PAGE_VIEWED,
      category: "page",
      path: "/",
      ts: Date.now(),
      seq: i,
      clientEventId: randomUUID(),
      ...overrides,
    });
  }
  return { tabId, sentAt: Date.now(), events };
}

function extractVisitorCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return "";
  const m = setCookie.match(/visitor_id=([^;]+)/);
  return m ? `visitor_id=${m[1]}` : "";
}

describe("Real beacon → server ingest", () => {
  it("ingests a single PAGE_VIEWED event and persists it to events", async () => {
    const envelope = makeEnvelope();
    const res = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(204);

    const row = testDb
      .prepare("SELECT event_name, client_event_id FROM events")
      .get() as { event_name: string; client_event_id: string };
    expect(row.event_name).toBe(ANALYTICS_EVENTS.PAGE_VIEWED);
    expect(row.client_event_id).toBe(envelope.events[0].clientEventId);
  });

  it("dedupes a retry that re-uses the same clientEventId", async () => {
    const envelope = makeEnvelope();
    // First flush — fresh visitor cookie minted in response.
    const r1 = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(r1.status).toBe(204);
    const cookie = extractVisitorCookie(r1);
    expect(cookie).not.toBe("");

    // Second flush of the SAME envelope, replaying the cookie so the
    // (visitor_id, client_event_id) UNIQUE index can match.
    const r2 = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(envelope),
    });
    expect(r2.status).toBe(204);

    const count = (
      testDb
        .prepare("SELECT COUNT(*) AS n FROM events WHERE client_event_id = ?")
        .get(envelope.events[0].clientEventId) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("rejects events whose name is not on the client allowlist (dashboard poisoning guard)", async () => {
    // game_completed is server-emitted only — clients must not be able
    // to fabricate a completion event.
    const envelope = makeEnvelope({ name: ANALYTICS_EVENTS.GAME_COMPLETED });
    const res = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(204);
    const count = (
      testDb.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("ingests a batch of multiple events in one envelope", async () => {
    const envelope = makeEnvelope({}, 5);
    const res = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(204);
    const count = (
      testDb.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
    ).n;
    expect(count).toBe(5);
    // All events are bound to the same tabId via analytics_sessions.
    const sessionsCount = (
      testDb
        .prepare("SELECT COUNT(*) AS n FROM analytics_sessions")
        .get() as { n: number }
    ).n;
    expect(sessionsCount).toBe(1);
  });

  it("rejects malformed envelopes with 400", async () => {
    const res = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "an envelope" }),
    });
    expect(res.status).toBe(400);
  });

  it("honors DNT header — stored row has dnt=1 and scrubbed properties", async () => {
    const envelope = makeEnvelope({
      properties: { secret: "should-be-stripped" },
    });
    const res = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", DNT: "1" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(204);
    const row = testDb
      .prepare("SELECT dnt, properties, ip_hash, browser FROM events")
      .get() as { dnt: number; properties: string | null; ip_hash: string | null; browser: string | null };
    expect(row.dnt).toBe(1);
    expect(row.properties).toBeNull();
    expect(row.ip_hash).toBeNull();
    expect(row.browser).toBeNull();
  });

  it("persists DNT preference to visitor_profile so subsequent emits stay scrubbed", async () => {
    // First request with DNT=1 — sets the sticky preference on visitor_profile.
    const envelope1 = makeEnvelope();
    const r1 = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", DNT: "1" },
      body: JSON.stringify(envelope1),
    });
    const cookie = extractVisitorCookie(r1);
    // Second request from the SAME visitor cookie WITHOUT a DNT header —
    // the visitor_profile.dnt sticky should still scrub.
    const envelope2 = makeEnvelope({
      properties: { x: "y" },
    });
    const r2 = await fetch(`${baseUrl}/api/events/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(envelope2),
    });
    expect(r2.status).toBe(204);
    const rows = testDb
      .prepare(
        "SELECT dnt, properties FROM events ORDER BY ts_server",
      )
      .all() as Array<{ dnt: number; properties: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].dnt).toBe(1);
    expect(rows[1].dnt).toBe(1);
    expect(rows[1].properties).toBeNull();
  });
});
