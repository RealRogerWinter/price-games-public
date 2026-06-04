/**
 * Tests for the shared date-bucketing utilities.
 *
 * These tests lock in timezone correctness across DST transitions and
 * exercise the zero-fill helper that every admin and per-user time-series
 * chart relies on. Lives under `apps/server/src/services/` so the existing
 * server vitest runner picks it up; the module under test lives in
 * `packages/shared/src/dateBucket.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  tzDateString,
  ADMIN_TIMEZONE,
  enumerateDaysInRange,
  padDateSeries,
} from "@price-game/shared";

describe("tzDateString", () => {
  it("returns PDT calendar date during daylight saving (summer)", () => {
    // 2026-06-15 18:00 UTC = 11:00 PDT (UTC-7), same PDT day
    expect(tzDateString("2026-06-15T18:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-06-15");
  });

  it("rolls a UTC early-morning timestamp back to the previous PT calendar day", () => {
    // 2026-06-15 04:00 UTC = 2026-06-14 21:00 PDT (UTC-7)
    expect(tzDateString("2026-06-15T04:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-06-14");
  });

  it("returns PST calendar date during standard time (winter)", () => {
    // 2026-01-15 07:00 UTC = 2026-01-14 23:00 PST (UTC-8)
    expect(tzDateString("2026-01-15T07:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-01-14");
    // 2026-01-15 08:00 UTC = 2026-01-15 00:00 PST
    expect(tzDateString("2026-01-15T08:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-01-15");
  });

  it("handles DST spring-forward transition correctly", () => {
    // 2026-03-08 is the second Sunday of March — PT jumps from PST (UTC-8) to PDT (UTC-7) at 02:00 local.
    // 2026-03-08 10:00 UTC = 02:00 PST → clocks jump → 03:00 PDT = still 2026-03-08 in PT.
    expect(tzDateString("2026-03-08T10:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-03-08");
  });

  it("handles DST fall-back transition correctly", () => {
    // 2026-11-01 is the first Sunday of November — PT falls back from PDT (UTC-7) to PST (UTC-8) at 02:00 local.
    // 2026-11-01 09:00 UTC = 02:00 PDT → clocks fall back → 01:00 PST = still 2026-11-01 in PT.
    expect(tzDateString("2026-11-01T09:00:00.000Z", ADMIN_TIMEZONE)).toBe("2026-11-01");
  });

  it("supports arbitrary IANA timezones (Europe/Berlin)", () => {
    // 2026-06-15 22:30 UTC = 2026-06-16 00:30 CEST
    expect(tzDateString("2026-06-15T22:30:00.000Z", "Europe/Berlin")).toBe("2026-06-16");
  });

  it("supports arbitrary IANA timezones (Asia/Tokyo)", () => {
    // 2026-06-15 16:00 UTC = 2026-06-16 01:00 JST
    expect(tzDateString("2026-06-15T16:00:00.000Z", "Asia/Tokyo")).toBe("2026-06-16");
  });

  it("supports UTC directly", () => {
    expect(tzDateString("2026-06-15T18:00:00.000Z", "UTC")).toBe("2026-06-15");
    expect(tzDateString("2026-06-15T23:59:59.000Z", "UTC")).toBe("2026-06-15");
    expect(tzDateString("2026-06-16T00:00:00.000Z", "UTC")).toBe("2026-06-16");
  });

  it("returns an empty string for null input", () => {
    expect(tzDateString(null, ADMIN_TIMEZONE)).toBe("");
  });

  it("returns an empty string for undefined input", () => {
    expect(tzDateString(undefined, ADMIN_TIMEZONE)).toBe("");
  });

  it("returns an empty string for an invalid ISO string", () => {
    expect(tzDateString("not-a-date", ADMIN_TIMEZONE)).toBe("");
    expect(tzDateString("", ADMIN_TIMEZONE)).toBe("");
  });
});

describe("enumerateDaysInRange", () => {
  it("returns every calendar day in an inclusive window for a given timezone", () => {
    // 3 days of PT coverage, passing ISO timestamps that fall mid-day PT
    const start = new Date("2026-06-15T19:00:00.000Z"); // 12:00 PDT on 6/15
    const end = new Date("2026-06-17T19:00:00.000Z"); // 12:00 PDT on 6/17
    expect(enumerateDaysInRange(start, end, ADMIN_TIMEZONE)).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
    ]);
  });

  it("returns a single-day range when start and end are the same PT day", () => {
    const start = new Date("2026-06-15T12:00:00.000Z"); // 05:00 PDT
    const end = new Date("2026-06-15T23:00:00.000Z"); // 16:00 PDT
    expect(enumerateDaysInRange(start, end, ADMIN_TIMEZONE)).toEqual(["2026-06-15"]);
  });

  it("handles the DST spring-forward day without losing or duplicating a bucket", () => {
    // 2026-03-07 to 2026-03-09 PT spans the DST jump (2026-03-08).
    const start = new Date("2026-03-07T20:00:00.000Z"); // 12:00 PST 3/7
    const end = new Date("2026-03-09T19:00:00.000Z"); // 12:00 PDT 3/9
    expect(enumerateDaysInRange(start, end, ADMIN_TIMEZONE)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("handles the DST fall-back day without losing or duplicating a bucket", () => {
    const start = new Date("2026-10-31T19:00:00.000Z"); // 12:00 PDT 10/31
    const end = new Date("2026-11-02T20:00:00.000Z"); // 12:00 PST 11/2
    expect(enumerateDaysInRange(start, end, ADMIN_TIMEZONE)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("works across a leap day", () => {
    const start = new Date("2024-02-28T20:00:00.000Z"); // 12:00 PST 2/28
    const end = new Date("2024-03-01T20:00:00.000Z"); // 12:00 PST 3/1
    expect(enumerateDaysInRange(start, end, ADMIN_TIMEZONE)).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("emits Berlin-calendar days for a European timezone", () => {
    const start = new Date("2026-06-15T22:30:00.000Z"); // 00:30 CEST 6/16
    const end = new Date("2026-06-17T21:30:00.000Z"); // 23:30 CEST 6/17
    expect(enumerateDaysInRange(start, end, "Europe/Berlin")).toEqual([
      "2026-06-16",
      "2026-06-17",
    ]);
  });
});

describe("padDateSeries", () => {
  const factory = (date: string) => ({ date, count: 0 });

  it("preserves existing rows and fills missing days with the factory default", () => {
    const sparse = [
      { date: "2026-06-15", count: 3 },
      { date: "2026-06-18", count: 1 },
    ];
    // End anchor at mid-day PDT on 6/19, request 5 days → 6/15..6/19.
    const padded = padDateSeries(
      sparse,
      new Date("2026-06-19T19:00:00.000Z"),
      5,
      ADMIN_TIMEZONE,
      factory,
    );
    expect(padded).toEqual([
      { date: "2026-06-15", count: 3 },
      { date: "2026-06-16", count: 0 },
      { date: "2026-06-17", count: 0 },
      { date: "2026-06-18", count: 1 },
      { date: "2026-06-19", count: 0 },
    ]);
  });

  it("returns a fully zero-filled window when the input is empty", () => {
    const padded = padDateSeries(
      [],
      new Date("2026-06-17T19:00:00.000Z"),
      3,
      ADMIN_TIMEZONE,
      factory,
    );
    expect(padded).toEqual([
      { date: "2026-06-15", count: 0 },
      { date: "2026-06-16", count: 0 },
      { date: "2026-06-17", count: 0 },
    ]);
  });

  it("ignores input rows outside the requested window", () => {
    const sparse = [
      { date: "2026-06-10", count: 9 }, // before window
      { date: "2026-06-15", count: 2 }, // in window
      { date: "2026-06-25", count: 4 }, // after window
    ];
    const padded = padDateSeries(
      sparse,
      new Date("2026-06-16T19:00:00.000Z"),
      2,
      ADMIN_TIMEZONE,
      factory,
    );
    expect(padded).toEqual([
      { date: "2026-06-15", count: 2 },
      { date: "2026-06-16", count: 0 },
    ]);
  });

  it("preserves the arbitrary payload of existing rows, not just the date", () => {
    interface Row {
      date: string;
      count: number;
      note: string;
    }
    const sparse: Row[] = [{ date: "2026-06-15", count: 3, note: "kept" }];
    const noteFactory = (date: string): Row => ({ date, count: 0, note: "filled" });
    const padded = padDateSeries(
      sparse,
      new Date("2026-06-16T19:00:00.000Z"),
      2,
      ADMIN_TIMEZONE,
      noteFactory,
    );
    expect(padded).toEqual([
      { date: "2026-06-15", count: 3, note: "kept" },
      { date: "2026-06-16", count: 0, note: "filled" },
    ]);
  });

  it("returns exactly `days` entries across DST spring-forward (invariant)", () => {
    // End at midnight PDT 2026-03-09 = 07:00 UTC, the first clock tick
    // after the spring-forward transition at 02:00 local on 2026-03-08.
    // The old raw-ms arithmetic (start = end - 29*86400000) drifts to
    // 2026-02-07 23:00 PST, which buckets into 2026-02-07 — producing 31
    // days instead of 30. Calendar-day arithmetic must return exactly 30.
    const end = new Date("2026-03-09T07:00:00.000Z");
    const padded = padDateSeries([], end, 30, ADMIN_TIMEZONE, factory);
    expect(padded).toHaveLength(30);
    expect(padded[0].date).toBe("2026-02-08");
    expect(padded[padded.length - 1].date).toBe("2026-03-09");
  });

  it("returns exactly `days` entries across DST fall-back (invariant)", () => {
    // End at 09:00 UTC on 2026-11-02 = 01:00 PST (after the fall-back at
    // 02:00 local on 2026-11-01). With raw-ms arithmetic, a 30-day
    // window around this anchor has drifted by +1h per day prior to
    // fall-back, potentially returning 29 rows. Calendar-day arithmetic
    // must still return exactly 30.
    const end = new Date("2026-11-02T09:00:00.000Z");
    const padded = padDateSeries([], end, 30, ADMIN_TIMEZONE, factory);
    expect(padded).toHaveLength(30);
    expect(padded[padded.length - 1].date).toBe("2026-11-02");
  });

  it("returns exactly 60 entries for the 2x range window used by computeDelta", () => {
    // The admin dashboard fetches `range * 2` days and expects
    // computeDelta to slice two disjoint equal-length halves. Verify
    // across a DST boundary.
    const end = new Date("2026-03-09T07:00:00.000Z");
    const padded = padDateSeries([], end, 60, ADMIN_TIMEZONE, factory);
    expect(padded).toHaveLength(60);
    // Current half = last 30, prior half = first 30, no overlap.
    expect(padded.slice(-30)[0].date).not.toBe(padded.slice(0, 30)[29].date);
  });

  it("clamps `days` to at least 1", () => {
    const end = new Date("2026-06-15T19:00:00.000Z");
    expect(padDateSeries([], end, 0, ADMIN_TIMEZONE, factory)).toHaveLength(1);
    expect(padDateSeries([], end, -5, ADMIN_TIMEZONE, factory)).toHaveLength(1);
  });

  it("works for non-PT timezones", () => {
    // 01:00 JST on 2026-06-16 = 16:00 UTC on 2026-06-15.
    const end = new Date("2026-06-15T16:00:00.000Z");
    const padded = padDateSeries([], end, 3, "Asia/Tokyo", factory);
    expect(padded).toEqual([
      { date: "2026-06-14", count: 0 },
      { date: "2026-06-15", count: 0 },
      { date: "2026-06-16", count: 0 },
    ]);
  });
});
