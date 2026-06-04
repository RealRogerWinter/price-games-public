import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { recordEvent } from "./eventLog";
import { rebuildHourlyRange } from "./analyticsHourly";
import { __resetBotVelocity } from "./botDetection";
import {
  getCohortRetention,
  getCohortSummary,
  getRetentionCurves,
  getStickiness,
  computeFunnel,
  computeAllFunnels,
  PREBUILT_FUNNELS,
  getGeoCountries,
  type FunnelDefinition,
} from "./analyticsRetention";
import { ANALYTICS_EVENTS } from "@price-game/shared";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let db: DatabaseType;
const UA = "Mozilla/5.0 Chrome/120";
const VID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

function seed(
  name: string,
  opts: { vid: string; ts: number; userId?: string; path?: string; country?: string },
): void {
  recordEvent(
    {
      eventName: name,
      visitorId: opts.vid,
      userId: opts.userId ?? null,
      userAgent: UA,
      path: opts.path ?? "/",
      country: opts.country,
      nowMs: opts.ts,
    },
    db,
  );
}

describe("getCohortRetention", () => {
  it("returns empty array when there are no sessions", () => {
    expect(getCohortRetention(db)).toEqual([]);
  });

  it("counts a visitor's cohort-week-0 retention as themselves", () => {
    const now = Date.now();
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - DAY_MS });
    const cells = getCohortRetention(db, 12, 4, now);
    // Expect at least one cell for week 0 with retained=1.
    const wk0 = cells.find((c) => c.weekOffset === 0);
    expect(wk0?.retained).toBeGreaterThanOrEqual(1);
    expect(wk0?.cohortSize).toBeGreaterThanOrEqual(1);
  });

  it("tracks week-N retention when a visitor returns next week", () => {
    const now = Date.now();
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 10 * DAY_MS });
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 2 * DAY_MS });
    const cells = getCohortRetention(db, 12, 4, now);
    const wk1 = cells.find((c) => c.weekOffset === 1);
    expect(wk1?.retained).toBeGreaterThanOrEqual(1);
  });
});

describe("getCohortSummary", () => {
  it("reports D1/D7/D30 per cohort", () => {
    const now = Date.now();
    // Visitor A: returns on D1.
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 5 * DAY_MS });
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 4 * DAY_MS });
    // Visitor B: never returns.
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, ts: now - 5 * DAY_MS });
    const rows = getCohortSummary(db, 12, now);
    expect(rows.length).toBeGreaterThan(0);
    const total = rows.reduce((s, r) => s + r.cohortSize, 0);
    expect(total).toBeGreaterThanOrEqual(2);
    const d1Total = rows.reduce((s, r) => s + r.d1, 0);
    expect(d1Total).toBeGreaterThanOrEqual(1);
  });
});

describe("getRetentionCurves", () => {
  it("returns day-offset points per cohort", () => {
    const now = Date.now();
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 3 * DAY_MS });
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 1 * DAY_MS });
    const pts = getRetentionCurves(db, 6, 14, now);
    expect(pts.length).toBeGreaterThan(0);
    const day0 = pts.find((p) => p.daysSinceStart === 0);
    expect(day0?.retained).toBeGreaterThanOrEqual(1);
  });
});

describe("getStickiness", () => {
  it("returns rangeDays + 1 points with 0 ratio on empty DB", () => {
    const pts = getStickiness(db, 7);
    expect(pts).toHaveLength(8);
    expect(pts.every((p) => p.ratio === 0)).toBe(true);
  });

  it("computes non-zero DAU/MAU when there is activity", () => {
    // Pin to noon UTC so the seeded "1 hour ago" event lands on the
    // current UTC day; with a real `Date.now()` near midnight the event
    // belongs to the previous day and the last bucket reads zero.
    const now = Math.floor(Date.now() / DAY_MS) * DAY_MS + 12 * HOUR_MS;
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - HOUR_MS });
    const pts = getStickiness(db, 7, now);
    const last = pts[pts.length - 1];
    expect(last.dau).toBeGreaterThanOrEqual(1);
    expect(last.mau).toBeGreaterThanOrEqual(1);
    expect(last.ratio).toBeGreaterThan(0);
  });
});

describe("computeFunnel", () => {
  const TEST_FUNNEL: FunnelDefinition = {
    id: "test",
    name: "Test",
    description: "",
    windowDays: 7,
    steps: [
      { label: "Landed", eventNames: "page_viewed" },
      { label: "Started", eventNames: "game_started" },
      { label: "Completed", eventNames: "game_completed" },
    ],
  };

  it("reports zero visitors on empty input", () => {
    const result = computeFunnel(db, TEST_FUNNEL);
    expect(result.steps[0].visitors).toBe(0);
    expect(result.steps.every((s) => s.visitors === 0)).toBe(true);
  });

  it("counts only visitors who completed steps in order", () => {
    const now = Date.now();
    // Visitor A completes all three in order.
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 3 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 2 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_COMPLETED, { vid: VID_A, ts: now - 1 * HOUR_MS });
    // Visitor B stops after step 2.
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, ts: now - 3 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_B, ts: now - 2 * HOUR_MS });
    // Visitor C only landed.
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_C, ts: now - 3 * HOUR_MS });

    const r = computeFunnel(db, TEST_FUNNEL, now);
    expect(r.steps[0].visitors).toBeGreaterThanOrEqual(3);
    expect(r.steps[1].visitors).toBeGreaterThanOrEqual(2);
    expect(r.steps[2].visitors).toBeGreaterThanOrEqual(1);
    expect(r.steps[0].conversionFromPrev).toBeNull();
    expect(r.steps[2].conversionFromStart).toBeGreaterThan(0);
  });

  it("rejects out-of-order events", () => {
    const now = Date.now();
    // Visitor completes the game BEFORE the page view (impossible in practice)
    seed(ANALYTICS_EVENTS.GAME_COMPLETED, { vid: VID_A, ts: now - 3 * HOUR_MS });
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 1 * HOUR_MS });
    const r = computeFunnel(db, TEST_FUNNEL, now);
    expect(r.steps[0].visitors).toBeGreaterThanOrEqual(1); // landed
    expect(r.steps[2].visitors).toBe(0); // completed was before landed
  });

  it("counts a later occurrence when the step's event also appears earlier (shared-event-name funnel)", () => {
    const now = Date.now();
    // Simulate first-taste-stickiness: "completed a game → started another".
    // The visitor started a game BEFORE completing the first one (which is
    // how real flows work — start → complete → start another). The bug the
    // earlier implementation had: taking MIN(ts_server) of game_started
    // across the visitor's history picks the FIRST start (before the
    // completion) and drops the visitor.
    const STICKINESS_FUNNEL: FunnelDefinition = {
      id: "test-stickiness",
      name: "Stickiness",
      description: "",
      windowDays: 7,
      steps: [
        { label: "Completed a game", eventNames: "game_completed" },
        { label: "Started another", eventNames: "game_started" },
      ],
    };
    // Visitor A: started game 1, completed it, started game 2 — qualifies.
    seed(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 3 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_COMPLETED, { vid: VID_A, ts: now - 2 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 1 * HOUR_MS });
    // Visitor B: started game, completed it, never started another — drops.
    seed(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_B, ts: now - 3 * HOUR_MS });
    seed(ANALYTICS_EVENTS.GAME_COMPLETED, { vid: VID_B, ts: now - 2 * HOUR_MS });

    const r = computeFunnel(db, STICKINESS_FUNNEL, now);
    expect(r.steps[0].visitors).toBeGreaterThanOrEqual(2); // both completed
    expect(r.steps[1].visitors).toBeGreaterThanOrEqual(1); // A started another
    // Without the MIN-bug fix this would be 0 because the MIN(game_started)
    // is the pre-completion start at -3h, which is < the -2h completion.
  });
});

describe("computeAllFunnels", () => {
  it("returns all 9 pre-built funnels", () => {
    const all = computeAllFunnels(db);
    expect(all).toHaveLength(PREBUILT_FUNNELS.length);
    expect(all.map((f) => f.id).sort()).toEqual(
      PREBUILT_FUNNELS.map((f) => f.id).sort(),
    );
  });
});

describe("getGeoCountries", () => {
  it("aggregates sessions by country from the hourly rollup", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000, country: "US" });
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, ts: now - 60_000, country: "DE" });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const rows = getGeoCountries(db, { rangeDays: 7 }, now);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.find((r) => r.country === "US")).toBeDefined();
    expect(rows.find((r) => r.country === "DE")).toBeDefined();
  });

  it("maps missing country to 'unknown'", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seed(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const rows = getGeoCountries(db, { rangeDays: 7 }, now);
    expect(rows.find((r) => r.country === "unknown")).toBeDefined();
  });
});
