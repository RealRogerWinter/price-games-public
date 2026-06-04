import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { recordEvent } from "../services/eventLog";
import { __resetBotVelocity } from "../services/botDetection";
import { computePulse } from "./adminAnalyticsNamespace";
import { ANALYTICS_EVENTS } from "@price-game/shared";

let db: DatabaseType;
const UA = "Mozilla/5.0 Chrome/120";

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

describe("computePulse", () => {
  it("reports zeros on an empty DB", () => {
    const p = computePulse(db, Date.now());
    expect(p.liveVisitors).toBe(0);
    expect(p.recentEvents).toEqual([]);
    expect(p.sessionsStartedLastMinute).toBe(0);
  });

  it("counts live visitors active in the last 5 min", () => {
    const now = Date.now();
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", userAgent: UA, path: "/", nowMs: now - 60_000 },
      db,
    );
    const p = computePulse(db, now);
    expect(p.liveVisitors).toBeGreaterThanOrEqual(1);
  });

  it("surfaces recent events in the last 10s bucketed by name", () => {
    const now = Date.now();
    // Two page views + one game_started, all within the 10s window.
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", userAgent: UA, path: "/", nowMs: now - 5_000 },
      db,
    );
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", userAgent: UA, path: "/", nowMs: now - 4_000 },
      db,
    );
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", userAgent: UA, path: "/classic", nowMs: now - 3_000 },
      db,
    );
    const p = computePulse(db, now);
    const pageViewed = p.recentEvents.find((e) => e.name === ANALYTICS_EVENTS.PAGE_VIEWED);
    expect(pageViewed?.count).toBeGreaterThanOrEqual(2);
    expect(p.recentEvents.find((e) => e.name === ANALYTICS_EVENTS.GAME_STARTED)).toBeDefined();
  });

  it("counts sessions started in the last 60s", () => {
    const now = Date.now();
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", userAgent: UA, path: "/", nowMs: now - 30_000 },
      db,
    );
    const p = computePulse(db, now);
    expect(p.sessionsStartedLastMinute).toBeGreaterThanOrEqual(1);
  });

  it("excludes bot traffic", () => {
    const now = Date.now();
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", userAgent: "Googlebot/2.1", path: "/", nowMs: now - 1_000 },
      db,
    );
    const p = computePulse(db, now);
    expect(p.liveVisitors).toBe(0);
    expect(p.sessionsStartedLastMinute).toBe(0);
  });
});
