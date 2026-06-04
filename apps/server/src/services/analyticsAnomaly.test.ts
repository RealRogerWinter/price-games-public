import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { detectAnomalies } from "./analyticsAnomaly";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Fixed at noon UTC so `hoursElapsed` is always 12 — comfortably past the
// 2-hour MIN_HOURS_FOR_VOLUME_CHECK gate, AND so seeded "today, 1am UTC"
// buckets are never in the future relative to `now`. The wall-clock-based
// `Date.now()` version made these tests fail when CI happened to run between
// 00:00 and 02:00 UTC.
const FIXED_NOW = new Date("2026-04-15T12:00:00Z").getTime();

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

/** Seed an analytics_hourly row directly. */
function seedHour(
  hour: number,
  sessions: number,
  bounced: number = 0,
): void {
  db.prepare(
    `INSERT INTO analytics_hourly
       (hour_bucket, device_type, is_logged_in, country, acquisition_source, sessions, bounced_sessions)
     VALUES (?, 'desktop', 0, 'US', 'direct', ?, ?)`,
  ).run(hour, sessions, bounced);
}

describe("detectAnomalies — engagement drop", () => {
  it("returns nothing on empty DB", () => {
    expect(detectAnomalies(db, Date.now())).toEqual([]);
  });

  it("fires a warning when engagement dropped >20% WoW", () => {
    const now = FIXED_NOW;
    const startOfDay = now - (now % DAY_MS);
    const weekAgo = startOfDay - 7 * DAY_MS;
    // Last week: 100 sessions, 20 bounced → 80% engagement
    seedHour(weekAgo + 1 * HOUR_MS, 100, 20);
    // Today: 100 sessions, 70 bounced → 30% engagement (huge drop)
    seedHour(startOfDay + 1 * HOUR_MS, 100, 70);
    const alerts = detectAnomalies(db, now);
    const drop = alerts.find((a) => a.id === "engagement-drop");
    expect(drop).toBeDefined();
    expect(drop!.severity).toBe("critical");
    expect(drop!.pctChange).toBeLessThan(-0.4);
  });

  it("skips when sessions < 20 in either window (too noisy)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const startOfDay = now - (now % DAY_MS);
    const weekAgo = startOfDay - 7 * DAY_MS;
    seedHour(weekAgo + HOUR_MS, 10, 2);   // below threshold
    seedHour(startOfDay + HOUR_MS, 10, 9);
    expect(detectAnomalies(db, now).find((a) => a.id === "engagement-drop")).toBeUndefined();
  });
});

describe("detectAnomalies — volume spike/drop", () => {
  it("fires a warning when today is >3σ below the 14-day mean", () => {
    const now = FIXED_NOW;
    const startOfDay = now - (now % DAY_MS);
    // 14 days of baseline with small variation so SD > 0.
    for (let i = 1; i <= 14; i++) {
      // Jitter ±5% around 1000 so the distribution isn't degenerate.
      const sessions = 1000 + (i % 5) * 20 - 40;
      seedHour(startOfDay - i * DAY_MS + HOUR_MS, sessions, Math.round(sessions * 0.1));
    }
    // Today: just 50 sessions — way below baseline.
    seedHour(startOfDay + HOUR_MS, 50, 5);
    const alerts = detectAnomalies(db, now);
    const drop = alerts.find((a) => a.id === "volume-drop");
    expect(drop).toBeDefined();
    expect(drop!.severity).toBe("warning");
  });

  it("fires info when today is >3σ above the 14-day mean", () => {
    const now = FIXED_NOW;
    const startOfDay = now - (now % DAY_MS);
    for (let i = 1; i <= 14; i++) {
      const sessions = 1000 + (i % 5) * 20 - 40;
      seedHour(startOfDay - i * DAY_MS + HOUR_MS, sessions, Math.round(sessions * 0.1));
    }
    // Today: 5000 sessions — huge spike.
    seedHour(startOfDay + HOUR_MS, 5000, 500);
    const alerts = detectAnomalies(db, now);
    const spike = alerts.find((a) => a.id === "volume-spike");
    expect(spike).toBeDefined();
    expect(spike!.severity).toBe("info");
  });

  it("skips when baseline has <7 days of history", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const startOfDay = now - (now % DAY_MS);
    for (let i = 1; i <= 3; i++) {
      seedHour(startOfDay - i * DAY_MS + HOUR_MS, 1000, 100);
    }
    seedHour(startOfDay + HOUR_MS, 10, 1);
    const alerts = detectAnomalies(db, now);
    expect(alerts.find((a) => a.id === "volume-drop")).toBeUndefined();
    expect(alerts.find((a) => a.id === "volume-spike")).toBeUndefined();
  });

  it("skips when hours-elapsed < minimum (too early in UTC day)", () => {
    const startOfDay = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    // 30 min past midnight — below the 2-hour gate.
    const now = startOfDay + 30 * 60 * 1000;
    for (let i = 1; i <= 14; i++) {
      seedHour(startOfDay - i * DAY_MS + HOUR_MS, 1000);
    }
    // Seed a wild spike that would otherwise fire.
    seedHour(startOfDay, 99999);
    const alerts = detectAnomalies(db, now);
    expect(alerts.find((a) => a.id === "volume-spike")).toBeUndefined();
    expect(alerts.find((a) => a.id === "volume-drop")).toBeUndefined();
  });

  it("skips when baseline SD = 0 (degenerate stable traffic)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const startOfDay = now - (now % DAY_MS);
    // Every prior day has EXACTLY 1000 sessions → SD = 0.
    for (let i = 1; i <= 14; i++) {
      seedHour(startOfDay - i * DAY_MS + HOUR_MS, 1000);
    }
    seedHour(startOfDay + HOUR_MS, 5000);
    const alerts = detectAnomalies(db, now);
    expect(alerts.find((a) => a.id === "volume-spike")).toBeUndefined();
    expect(alerts.find((a) => a.id === "volume-drop")).toBeUndefined();
  });

  it("compares same hours-elapsed today vs prior days (no midnight false alarm)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const startOfDay = now - (now % DAY_MS);
    // Each prior day had strong traffic in the first 2 hours, but
    // much more later. Today is 2 hours in with traffic comparable to
    // prior days' first 2 hours → no alert.
    for (let i = 1; i <= 14; i++) {
      const dayStart = startOfDay - i * DAY_MS;
      // Hours 0-1 of each prior day: 200 sessions (early traffic).
      seedHour(dayStart, 200);
      seedHour(dayStart + HOUR_MS, 200);
      // Hours 5-6: 2000 sessions (evening spike).
      seedHour(dayStart + 5 * HOUR_MS, 2000);
      seedHour(dayStart + 6 * HOUR_MS, 2000);
    }
    // Today, 2 hours in — similar to prior first-2-hours.
    seedHour(startOfDay, 200);
    seedHour(startOfDay + HOUR_MS, 200);
    const twoHoursIn = startOfDay + 2 * HOUR_MS;
    const alerts = detectAnomalies(db, twoHoursIn);
    // Should NOT fire, because baseline and today are both scoped to 2 hours.
    expect(alerts.find((a) => a.id === "volume-drop")).toBeUndefined();
  });
});
