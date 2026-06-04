import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedDiverseProducts, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { setDailyEnabled, setDailySchedule, isDailyEnabled, getDailySchedule, setDisabledGameModes } from "./siteSettings";
import { DEFAULT_DAILY_SCHEDULE, type GameMode } from "@price-game/shared";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as any };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedDiverseProducts(testDb, 60);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const {
  getAdminDailyOverview,
  updateAdminDailyEnabled,
  updateAdminDailySchedule,
  setAdminDailyProducts,
  regenerateAdminDailyPuzzle,
  getAdminDailyStats,
  clearAdminDailyPlay,
  AdminDailyError,
} = await import("./adminDaily");

describe("getAdminDailyOverview", () => {
  it("returns enabled=false by default", () => {
    const overview = getAdminDailyOverview(testDb);
    expect(overview.enabled).toBe(false);
  });

  it("returns the default schedule when none is set", () => {
    const overview = getAdminDailyOverview(testDb);
    expect(overview.schedule).toEqual([...DEFAULT_DAILY_SCHEDULE]);
  });

  it("returns the current UTC date as currentDate", () => {
    const overview = getAdminDailyOverview(testDb);
    expect(overview.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 14 rows by default (today + next 13)", () => {
    const overview = getAdminDailyOverview(testDb);
    expect(overview.rows).toHaveLength(14);
  });

  it("respects the daysAhead parameter", () => {
    const overview = getAdminDailyOverview(testDb, 7);
    expect(overview.rows).toHaveLength(7);
  });

  it("rows include all required fields including productImageUrls and productPriceCents", () => {
    const overview = getAdminDailyOverview(testDb, 3);
    for (const row of overview.rows) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["classic", "higher-lower", "comparison"]).toContain(row.gameMode);
      expect(Array.isArray(row.productIds)).toBe(true);
      expect(Array.isArray(row.productTitles)).toBe(true);
      expect(Array.isArray(row.productImageUrls)).toBe(true);
      expect(Array.isArray(row.productPriceCents)).toBe(true);
      // Parallel arrays have the same length
      expect(row.productTitles.length).toBe(row.productIds.length);
      expect(row.productImageUrls.length).toBe(row.productIds.length);
      expect(row.productPriceCents.length).toBe(row.productIds.length);
      expect(typeof row.isManualOverride).toBe("boolean");
      expect(typeof row.playCount).toBe("number");
    }
  });

  it("respects startDate parameter for past dates", () => {
    const overview = getAdminDailyOverview(testDb, 7, "2020-01-06");
    expect(overview.rows).toHaveLength(7);
    expect(overview.rows[0].date).toBe("2020-01-06");
    expect(overview.rows[6].date).toBe("2020-01-12");
    // Past uncached dates have empty product arrays
    for (const row of overview.rows) {
      expect(row.productIds).toEqual([]);
      expect(row.productTitles).toEqual([]);
      expect(row.productImageUrls).toEqual([]);
      expect(row.productPriceCents).toEqual([]);
      expect(row.cachedAt).toBeNull();
    }
  });

  it("returns cached rows for past dates that have puzzle data", () => {
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO daily_puzzles (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
       VALUES (?, 'classic', '[1,2,3,4,5]', '{}', 1, 0, ?)`
    ).run("2020-01-07", now);

    const overview = getAdminDailyOverview(testDb, 3, "2020-01-06");
    // Row for 2020-01-07 should have the cached data
    const cachedRow = overview.rows.find((r) => r.date === "2020-01-07");
    expect(cachedRow).toBeDefined();
    expect(cachedRow!.productIds).toEqual([1, 2, 3, 4, 5]);
    expect(cachedRow!.cachedAt).toBe(now);
  });

  it("flags manual override rows correctly", () => {
    // Insert a manual override row
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO daily_puzzles (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
       VALUES (?, 'classic', '[1,2,3,4,5]', '{}', 1, 1, ?)`
    ).run("2030-01-01", now);

    // Extend daysAhead to include 2099-01-01 — easier: query for a single day
    const overview = getAdminDailyOverview(testDb, 30);
    // The overview only walks dates starting from "today", so the 2099 row
    // won't appear. Confirm a manual-override row inserted at the start of
    // the window IS flagged.
    const today = overview.currentDate;
    testDb.prepare(
      `INSERT INTO daily_puzzles (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
       VALUES (?, 'classic', '[1,2,3,4,5]', '{}', 1, 1, ?)`
    ).run(today, now);

    const overview2 = getAdminDailyOverview(testDb, 1);
    expect(overview2.rows[0].isManualOverride).toBe(true);
  });
});

describe("updateAdminDailyEnabled", () => {
  it("flips the daily_enabled site setting", () => {
    expect(isDailyEnabled(testDb)).toBe(false);
    updateAdminDailyEnabled(testDb, true);
    expect(isDailyEnabled(testDb)).toBe(true);
    updateAdminDailyEnabled(testDb, false);
    expect(isDailyEnabled(testDb)).toBe(false);
  });
});

describe("updateAdminDailySchedule", () => {
  it("persists a valid 7-element schedule", () => {
    const newSchedule: GameMode[] = [
      "comparison", "comparison", "comparison",
      "comparison", "comparison", "comparison", "comparison",
    ];
    updateAdminDailySchedule(testDb, newSchedule);
    expect(getDailySchedule(testDb)).toEqual(newSchedule);
  });

  it("throws AdminDailyError when length is wrong", () => {
    expect(() =>
      updateAdminDailySchedule(testDb, ["classic"] as GameMode[])
    ).toThrow(AdminDailyError);
  });

  it("accepts any registered GameMode (every mode is admin-selectable)", () => {
    const anyMode: GameMode[] = [
      "classic", "classic", "chain-reaction", "market-basket",
      "riser", "odd-one-out", "budget-builder",
    ];
    expect(() => updateAdminDailySchedule(testDb, anyMode)).not.toThrow();
  });

  it("throws AdminDailyError on completely unknown modes", () => {
    expect(() =>
      updateAdminDailySchedule(testDb, [
        "classic", "classic", "bogus", "classic", "classic", "classic", "classic",
      ] as unknown as GameMode[])
    ).toThrow(AdminDailyError);
  });
});

describe("setAdminDailyProducts", () => {
  function getValidProductIds(count: number, mode: GameMode = "classic"): number[] {
    void mode;
    return (testDb.prepare("SELECT id FROM products WHERE is_active = 1 LIMIT ?").all(count) as { id: number }[]).map((r) => r.id);
  }

  it("creates a manual-override row with the supplied products", () => {
    const ids = getValidProductIds(5);
    const row = setAdminDailyProducts(testDb, "2030-04-15", "classic", ids);
    expect(row.isManualOverride).toBe(true);
    expect(row.productIds).toEqual(ids);
    expect(row.gameMode).toBe("classic");
  });

  it("overwrites an existing puzzle row in place", () => {
    const ids1 = getValidProductIds(5);
    setAdminDailyProducts(testDb, "2030-04-15", "classic", ids1);
    const ids2 = (testDb.prepare("SELECT id FROM products WHERE is_active = 1 ORDER BY id DESC LIMIT 5").all() as { id: number }[]).map((r) => r.id);
    const row = setAdminDailyProducts(testDb, "2030-04-15", "classic", ids2);
    expect(row.productIds).toEqual(ids2);
  });

  it("validates product count for the mode (classic = 5)", () => {
    const ids = getValidProductIds(4); // wrong count
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "classic", ids)
    ).toThrow(AdminDailyError);
  });

  it("validates product count for comparison (must be 10 = 2x5)", () => {
    const ids = getValidProductIds(5);
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "comparison", ids)
    ).toThrow(AdminDailyError);
    const tenIds = getValidProductIds(10);
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "comparison", tenIds)
    ).not.toThrow();
  });

  it("rejects unknown product IDs", () => {
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "classic", [999991, 999992, 999993, 999994, 999995])
    ).toThrow(AdminDailyError);
  });

  it("rejects inactive products", () => {
    const ids = getValidProductIds(5);
    testDb.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(ids[0]);
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "classic", ids)
    ).toThrow(AdminDailyError);
  });

  it("accepts any registered GameMode for manual overrides (with correct product count)", () => {
    // chain-reaction needs 25 products (5 per round * 5 rounds); 5 is rejected for count, not mode.
    const fiveIds = getValidProductIds(5);
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "chain-reaction" as GameMode, fiveIds)
    ).toThrow(/requires exactly 25 products/);

    const twentyFiveIds = getValidProductIds(25);
    expect(() =>
      setAdminDailyProducts(testDb, "2030-04-15", "chain-reaction" as GameMode, twentyFiveIds)
    ).not.toThrow();
  });

  it("rejects malformed dates", () => {
    const ids = getValidProductIds(5);
    expect(() =>
      setAdminDailyProducts(testDb, "not-a-date", "classic", ids)
    ).toThrow(AdminDailyError);
  });
});

describe("regenerateAdminDailyPuzzle", () => {
  it("creates a fresh row when none exists for the date", () => {
    const row = regenerateAdminDailyPuzzle(testDb, "2030-04-15");
    expect(row.isManualOverride).toBe(false);
    expect(row.productIds.length).toBeGreaterThan(0);
  });

  it("refuses to regenerate a manual-override row without force", () => {
    const ids = (testDb.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
    setAdminDailyProducts(testDb, "2030-04-15", "classic", ids);
    expect(() =>
      regenerateAdminDailyPuzzle(testDb, "2030-04-15", false)
    ).toThrow(AdminDailyError);
  });

  it("clears the manual-override flag when force=true", () => {
    const ids = (testDb.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
    setAdminDailyProducts(testDb, "2030-04-15", "classic", ids);
    const row = regenerateAdminDailyPuzzle(testDb, "2030-04-15", true);
    expect(row.isManualOverride).toBe(false);
  });

  it("rejects regeneration for a date with NO available pool mode", () => {
    setDisabledGameModes(testDb, ["classic", "higher-lower", "comparison", "bidding"]);
    expect(() =>
      regenerateAdminDailyPuzzle(testDb, "2030-04-15")
    ).toThrow(AdminDailyError);
  });
});

describe("getAdminDailyStats", () => {
  it("returns zeros when there are no plays", () => {
    const stats = getAdminDailyStats(testDb);
    expect(stats.totalPlays).toBe(0);
    expect(stats.uniquePlayers).toBe(0);
    expect(stats.last30Days).toEqual([]);
    expect(stats.topStreaks).toEqual([]);
  });

  it("aggregates totals + 30-day breakdown + top streaks", () => {
    const u1 = seedUser(testDb, "u1", "u1@example.com");
    const u2 = seedUser(testDb, "u2", "u2@example.com");
    // Set streak columns
    testDb.prepare("UPDATE users SET daily_streak_current = ?, daily_streak_best = ? WHERE id = ?").run(7, 10, u1);
    testDb.prepare("UPDATE users SET daily_streak_current = ?, daily_streak_best = ? WHERE id = ?").run(3, 5, u2);

    // Insert plays
    const now = new Date().toISOString();
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, completed_at, started_at)
       VALUES (?, ?, ?, 'classic', ?, ?, ?)`
    );
    insert.run(u1, "s1", "2026-04-10", 5000, now, now);
    insert.run(u1, "s2", "2026-04-11", 4000, now, now);
    insert.run(u2, "s3", "2026-04-10", 3000, now, now);

    const stats = getAdminDailyStats(testDb);
    expect(stats.totalPlays).toBe(3);
    expect(stats.uniquePlayers).toBe(2);
    // Top streaks ordered by best desc
    expect(stats.topStreaks[0].username).toBe("u1");
    expect(stats.topStreaks[0].bestStreak).toBe(10);
    expect(stats.topStreaks[1].username).toBe("u2");
  });
});

describe("clearAdminDailyPlay", () => {
  it("deletes the matching row and returns deleted=1", () => {
    const u = seedUser(testDb, "support-target");
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (?, 'sess1', '2026-04-10', 'classic', 5000, ?, ?)`
    ).run(u, now, now);

    const result = clearAdminDailyPlay(testDb, u, "2026-04-10");
    expect(result.deleted).toBe(1);

    const remaining = testDb.prepare("SELECT COUNT(*) as c FROM daily_plays WHERE user_id = ?").get(u) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("returns deleted=0 when no row matches", () => {
    const u = seedUser(testDb, "no-plays");
    const result = clearAdminDailyPlay(testDb, u, "2026-04-10");
    expect(result.deleted).toBe(0);
  });

  it("does NOT mutate streak columns", () => {
    const u = seedUser(testDb, "streak-keeper");
    testDb.prepare("UPDATE users SET daily_streak_current = ?, daily_streak_best = ?, daily_streak_last_date = ? WHERE id = ?").run(7, 10, "2026-04-10", u);
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (?, 'sess', '2026-04-10', 'classic', 5000, ?, ?)`
    ).run(u, now, now);

    clearAdminDailyPlay(testDb, u, "2026-04-10");
    const user = testDb.prepare("SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?").get(u) as any;
    expect(user.daily_streak_current).toBe(7);
    expect(user.daily_streak_best).toBe(10);
    expect(user.daily_streak_last_date).toBe("2026-04-10");
  });
});
