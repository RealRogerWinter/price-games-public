import { describe, it, expect } from "vitest";
import {
  getUtcDateString,
  getDailyModeForDate,
  isValidDailyDate,
  msUntilNextUtcMidnight,
  addDays,
  getDailyNumber,
  DEFAULT_DAILY_SCHEDULE,
  DAILY_POOL,
  DAILY_TOTAL_ROUNDS,
  DAILY_LAUNCH_EPOCH,
  type GameMode,
} from "@price-game/shared";

describe("DAILY_TOTAL_ROUNDS constant", () => {
  it("is 5", () => {
    expect(DAILY_TOTAL_ROUNDS).toBe(5);
  });
});

describe("DAILY_POOL constant", () => {
  it("contains the daily-eligible modes (classic, higher-lower, comparison, bidding)", () => {
    expect([...DAILY_POOL]).toEqual(["classic", "higher-lower", "comparison", "bidding"]);
  });
});

describe("DEFAULT_DAILY_SCHEDULE constant", () => {
  it("has exactly 7 entries (one per UTC weekday)", () => {
    expect(DEFAULT_DAILY_SCHEDULE).toHaveLength(7);
  });

  it("uses only modes from DAILY_POOL", () => {
    for (const mode of DEFAULT_DAILY_SCHEDULE) {
      expect(DAILY_POOL).toContain(mode);
    }
  });

  it("matches the locked Mon/Thu=classic, Tue/Fri/Sun=higher-lower, Wed/Sat=comparison rotation", () => {
    // Index 0 = Sunday (JS Date.getUTCDay convention)
    expect(DEFAULT_DAILY_SCHEDULE[0]).toBe("higher-lower"); // Sun
    expect(DEFAULT_DAILY_SCHEDULE[1]).toBe("classic");      // Mon
    expect(DEFAULT_DAILY_SCHEDULE[2]).toBe("higher-lower"); // Tue
    expect(DEFAULT_DAILY_SCHEDULE[3]).toBe("comparison");   // Wed
    expect(DEFAULT_DAILY_SCHEDULE[4]).toBe("classic");      // Thu
    expect(DEFAULT_DAILY_SCHEDULE[5]).toBe("higher-lower"); // Fri
    expect(DEFAULT_DAILY_SCHEDULE[6]).toBe("comparison");   // Sat
  });
});

describe("getUtcDateString", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = getUtcDateString(new Date("2026-04-15T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe("2026-04-15");
  });

  it("uses UTC, not local time, near midnight UTC", () => {
    // 23:59 UTC on April 14 is still April 14 in UTC, regardless of local TZ.
    expect(getUtcDateString(new Date("2026-04-14T23:59:00Z"))).toBe("2026-04-14");
    // 00:01 UTC on April 15 is April 15.
    expect(getUtcDateString(new Date("2026-04-15T00:01:00Z"))).toBe("2026-04-15");
  });

  it("does not drift across timezone boundaries", () => {
    // A date constructed from a local-midnight string in a non-UTC TZ would
    // shift if we used local accessors. Verify we always return the UTC slice.
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)); // Jan 1 2026 00:00 UTC
    expect(getUtcDateString(d)).toBe("2026-01-01");
  });
});

describe("isValidDailyDate", () => {
  it("accepts well-formed YYYY-MM-DD strings", () => {
    expect(isValidDailyDate("2026-04-15")).toBe(true);
    expect(isValidDailyDate("2030-12-31")).toBe(true);
    expect(isValidDailyDate("2020-01-01")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidDailyDate("")).toBe(false);
    expect(isValidDailyDate("2026-4-15")).toBe(false);
    expect(isValidDailyDate("2026/04/15")).toBe(false);
    expect(isValidDailyDate("not-a-date")).toBe(false);
    expect(isValidDailyDate("20260415")).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidDailyDate("2026-13-01")).toBe(false);
    expect(isValidDailyDate("2026-02-30")).toBe(false);
    expect(isValidDailyDate("2026-00-15")).toBe(false);
  });

  it("rejects far-past and far-future dates", () => {
    expect(isValidDailyDate("1999-12-31")).toBe(false);
    expect(isValidDailyDate("2099-01-01")).toBe(false);
  });
});

describe("addDays", () => {
  it("adds positive days", () => {
    expect(addDays("2026-04-15", 1)).toBe("2026-04-16");
    expect(addDays("2026-04-15", 10)).toBe("2026-04-25");
  });

  it("subtracts when n is negative", () => {
    expect(addDays("2026-04-15", -1)).toBe("2026-04-14");
    expect(addDays("2026-04-15", -10)).toBe("2026-04-05");
  });

  it("handles month boundaries", () => {
    expect(addDays("2026-04-30", 1)).toBe("2026-05-01");
    expect(addDays("2026-05-01", -1)).toBe("2026-04-30");
  });

  it("handles year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles leap years correctly", () => {
    // 2028 is a leap year (divisible by 4, not by 100)
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    // 2027 is not a leap year
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("returns the same date when n is 0", () => {
    expect(addDays("2026-04-15", 0)).toBe("2026-04-15");
  });
});

describe("msUntilNextUtcMidnight", () => {
  it("returns a positive number for a non-midnight time", () => {
    const noon = new Date("2026-04-15T12:00:00Z");
    const ms = msUntilNextUtcMidnight(noon);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBe(12 * 60 * 60 * 1000); // exactly 12 hours
  });

  it("returns ~1 ms when called 1 ms before midnight", () => {
    const justBefore = new Date("2026-04-15T23:59:59.999Z");
    expect(msUntilNextUtcMidnight(justBefore)).toBe(1);
  });

  it("returns 24 hours when called exactly at midnight UTC", () => {
    const midnight = new Date("2026-04-15T00:00:00.000Z");
    expect(msUntilNextUtcMidnight(midnight)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("getDailyNumber", () => {
  it("returns 1 for the launch epoch itself", () => {
    expect(getDailyNumber(DAILY_LAUNCH_EPOCH)).toBe(1);
  });

  it("increments by 1 each subsequent day", () => {
    expect(getDailyNumber(addDays(DAILY_LAUNCH_EPOCH, 1))).toBe(2);
    expect(getDailyNumber(addDays(DAILY_LAUNCH_EPOCH, 6))).toBe(7);
    expect(getDailyNumber(addDays(DAILY_LAUNCH_EPOCH, 364))).toBe(365);
  });

  it("respects an explicit epoch override", () => {
    expect(getDailyNumber("2027-01-01", "2027-01-01")).toBe(1);
    expect(getDailyNumber("2027-01-31", "2027-01-01")).toBe(31);
  });

  it("returns 0 for the day before the epoch (so callers can detect pre-launch)", () => {
    // Negative or zero is acceptable; we just need it to be < 1.
    expect(getDailyNumber(addDays(DAILY_LAUNCH_EPOCH, -1))).toBeLessThan(1);
  });
});

describe("getDailyModeForDate", () => {
  // 2026-04-12 is a Sunday (UTC).  Verify by hand:
  // new Date("2026-04-12T00:00:00Z").getUTCDay() === 0
  const SUNDAY    = "2026-04-12";
  const MONDAY    = "2026-04-13";
  const TUESDAY   = "2026-04-14";
  const WEDNESDAY = "2026-04-15";
  const THURSDAY  = "2026-04-16";
  const FRIDAY    = "2026-04-17";
  const SATURDAY  = "2026-04-18";

  it("returns the scheduled mode for each weekday with no disabled modes", () => {
    expect(getDailyModeForDate(SUNDAY,    DEFAULT_DAILY_SCHEDULE)).toBe("higher-lower");
    expect(getDailyModeForDate(MONDAY,    DEFAULT_DAILY_SCHEDULE)).toBe("classic");
    expect(getDailyModeForDate(TUESDAY,   DEFAULT_DAILY_SCHEDULE)).toBe("higher-lower");
    expect(getDailyModeForDate(WEDNESDAY, DEFAULT_DAILY_SCHEDULE)).toBe("comparison");
    expect(getDailyModeForDate(THURSDAY,  DEFAULT_DAILY_SCHEDULE)).toBe("classic");
    expect(getDailyModeForDate(FRIDAY,    DEFAULT_DAILY_SCHEDULE)).toBe("higher-lower");
    expect(getDailyModeForDate(SATURDAY,  DEFAULT_DAILY_SCHEDULE)).toBe("comparison");
  });

  it("falls through DAILY_POOL when the scheduled mode is disabled", () => {
    // Wednesday's preferred is comparison; disable it → falls through to first
    // remaining pool entry that isn't disabled.
    const disabled: ReadonlySet<GameMode> = new Set(["comparison"]);
    const result = getDailyModeForDate(WEDNESDAY, DEFAULT_DAILY_SCHEDULE, disabled);
    expect(result).not.toBe("comparison");
    expect(DAILY_POOL).toContain(result as GameMode);
  });

  it("returns null when ALL pool modes are disabled", () => {
    const disabled: ReadonlySet<GameMode> = new Set(DAILY_POOL);
    expect(getDailyModeForDate(WEDNESDAY, DEFAULT_DAILY_SCHEDULE, disabled)).toBeNull();
  });

  it("returns the next available pool mode in DAILY_POOL order on fallback", () => {
    // Disable classic + comparison; only higher-lower left.
    const disabled: ReadonlySet<GameMode> = new Set(["classic", "comparison"]);
    expect(getDailyModeForDate(MONDAY,    DEFAULT_DAILY_SCHEDULE, disabled)).toBe("higher-lower");
    expect(getDailyModeForDate(WEDNESDAY, DEFAULT_DAILY_SCHEDULE, disabled)).toBe("higher-lower");
  });

  it("respects a custom schedule override", () => {
    // All-classic schedule should always return classic.
    const allClassic: GameMode[] = [
      "classic", "classic", "classic", "classic", "classic", "classic", "classic",
    ];
    expect(getDailyModeForDate(SUNDAY,    allClassic)).toBe("classic");
    expect(getDailyModeForDate(WEDNESDAY, allClassic)).toBe("classic");
  });
});
