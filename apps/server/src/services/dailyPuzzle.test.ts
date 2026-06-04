import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedDiverseProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { setDailyEnabled, setDailySchedule, setDisabledGameModes } from "./siteSettings";
import { DAILY_TOTAL_ROUNDS, type GameMode } from "@price-game/shared";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return {
    default: null as any,
  };
});

beforeEach(async () => {
  testDb = createTestDb();
  // Seed plenty of diverse products so the composer always has enough.
  seedDiverseProducts(testDb, 60);

  const mod = await import("../db");
  (mod as any).default = testDb;
});

// Must import after the mock is wired.
const {
  mulberry32,
  hashSeed,
  seededShuffle,
  getOrCreateDailyPuzzle,
  DailyUnavailableError,
} = await import("./dailyPuzzle");

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("returns values in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("hashSeed", () => {
  it("is stable across calls with the same inputs", () => {
    expect(hashSeed("salt", "2026-04-15", 1)).toBe(hashSeed("salt", "2026-04-15", 1));
  });

  it("changes when any input changes", () => {
    const base = hashSeed("salt", "2026-04-15", 1);
    expect(hashSeed("salt2", "2026-04-15", 1)).not.toBe(base);
    expect(hashSeed("salt", "2026-04-16", 1)).not.toBe(base);
    expect(hashSeed("salt", "2026-04-15", 2)).not.toBe(base);
  });

  it("returns a uint32", () => {
    const seed = hashSeed("any-salt", "2026-04-15", 1);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(seed)).toBe(true);
  });
});

describe("seededShuffle", () => {
  it("returns the same length as the input", () => {
    const rng = mulberry32(7);
    const out = seededShuffle([1, 2, 3, 4, 5], rng);
    expect(out).toHaveLength(5);
  });

  it("contains the same elements as the input", () => {
    const rng = mulberry32(7);
    const input = [1, 2, 3, 4, 5];
    const out = seededShuffle(input, rng);
    expect(new Set(out)).toEqual(new Set(input));
  });

  it("is deterministic for the same seed", () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7], mulberry32(99));
    const b = seededShuffle([1, 2, 3, 4, 5, 6, 7], mulberry32(99));
    expect(a).toEqual(b);
  });

  it("does not mutate the input array", () => {
    const input = [1, 2, 3];
    const original = [...input];
    seededShuffle(input, mulberry32(1));
    expect(input).toEqual(original);
  });
});

describe("getOrCreateDailyPuzzle", () => {
  it("returns DailyUnavailableError when all DAILY_POOL modes are disabled", () => {
    setDisabledGameModes(testDb, ["classic", "higher-lower", "comparison", "bidding"]);
    expect(() => getOrCreateDailyPuzzle(testDb, "2026-04-15")).toThrow(DailyUnavailableError);
  });

  it("creates a row on first call and returns the SAME row on subsequent calls (idempotent)", () => {
    const first = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    const second = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(second.daily_date).toBe(first.daily_date);
    expect(second.game_mode).toBe(first.game_mode);
    expect(second.product_ids).toBe(first.product_ids);
  });

  it("uses the resolved mode for the date's UTC weekday", () => {
    // 2026-04-15 is a Wednesday → comparison
    const wed = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(wed.game_mode).toBe("comparison");
    // 2026-04-13 is a Monday → classic
    const mon = getOrCreateDailyPuzzle(testDb, "2026-04-13");
    expect(mon.game_mode).toBe("classic");
  });

  it("falls through to another pool mode when the scheduled mode is disabled", () => {
    setDisabledGameModes(testDb, ["comparison"]);
    const wed = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(wed.game_mode).not.toBe("comparison");
    expect(["classic", "higher-lower"]).toContain(wed.game_mode);
  });

  it("respects an admin schedule override stored in site_settings", () => {
    const allClassic: GameMode[] = [
      "classic", "classic", "classic", "classic", "classic", "classic", "classic",
    ];
    setDailySchedule(testDb, allClassic);
    // Wednesday's default is comparison, but our override should win.
    const wed = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(wed.game_mode).toBe("classic");
  });

  it("preserves manual override rows on subsequent calls", () => {
    // Insert a manual override directly so we can verify the read path
    // returns it unchanged.
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO daily_puzzles (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
       VALUES (?, 'higher-lower', '[101,102,103,104,105]', '{}', 1, 1, ?)`
    ).run("2026-04-15", now);

    const result = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(result.is_manual_override).toBe(1);
    expect(result.game_mode).toBe("higher-lower");
    expect(JSON.parse(result.product_ids)).toEqual([101, 102, 103, 104, 105]);
  });

  it("produces deterministic product selection for the same date and salt", () => {
    // Wipe and re-create to ensure no caching.
    const a = getOrCreateDailyPuzzle(testDb, "2026-04-20");
    testDb.prepare("DELETE FROM daily_puzzles").run();
    const b = getOrCreateDailyPuzzle(testDb, "2026-04-20");
    expect(b.product_ids).toBe(a.product_ids);
    expect(b.game_mode).toBe(a.game_mode);
  });

  it("produces different product selection for different dates", () => {
    const a = getOrCreateDailyPuzzle(testDb, "2026-04-20");
    const b = getOrCreateDailyPuzzle(testDb, "2026-04-21");
    // Either the mode or the product set differs (and in practice, both).
    const aIds = JSON.parse(a.product_ids) as number[];
    const bIds = JSON.parse(b.product_ids) as number[];
    expect(aIds).not.toEqual(bIds);
  });

  it("the cached row has product_ids of the right length per mode", () => {
    // Wednesday = comparison → 2 products per round × 5 rounds = 10
    const wed = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(wed.game_mode).toBe("comparison");
    expect(JSON.parse(wed.product_ids)).toHaveLength(10);

    // Monday = classic → 1 product per round × 5 rounds = 5
    const mon = getOrCreateDailyPuzzle(testDb, "2026-04-13");
    expect(mon.game_mode).toBe("classic");
    expect(JSON.parse(mon.product_ids)).toHaveLength(5);
  });

  it("populates round_data for higher-lower (referencePrice per round)", () => {
    // Tuesday 2026-04-14 → higher-lower
    const tue = getOrCreateDailyPuzzle(testDb, "2026-04-14");
    expect(tue.game_mode).toBe("higher-lower");
    const rd = JSON.parse(tue.round_data || "{}");
    // 5 rounds, each with a referencePrice
    for (let i = 1; i <= DAILY_TOTAL_ROUNDS; i++) {
      expect(rd[String(i)]).toBeDefined();
      expect(typeof rd[String(i)].referencePrice).toBe("number");
      expect(rd[String(i)].referencePrice).toBeGreaterThan(0);
    }
  });

  it("populates round_data for comparison (question per round)", () => {
    const wed = getOrCreateDailyPuzzle(testDb, "2026-04-15");
    expect(wed.game_mode).toBe("comparison");
    const rd = JSON.parse(wed.round_data || "{}");
    for (let i = 1; i <= DAILY_TOTAL_ROUNDS; i++) {
      expect(rd[String(i)]).toBeDefined();
      expect(["most-expensive", "least-expensive"]).toContain(rd[String(i)].question);
    }
  });

  // Confirm setDailyEnabled doesn't have to be set for getOrCreateDailyPuzzle
  // to work — the gating happens at the route layer, not the puzzle layer.
  // This means admins can preview puzzles even while the feature is off.
  it("does not require daily_enabled to be true (gating is at the route layer)", () => {
    expect(() => getOrCreateDailyPuzzle(testDb, "2026-04-13")).not.toThrow();
  });
});

describe("startDailyGame", () => {
  // Import lazily to ensure mock is wired.
  let startDailyGame: typeof import("./gameSession").startDailyGame;

  beforeEach(async () => {
    const mod = await import("./gameSession");
    startDailyGame = mod.startDailyGame;
  });

  it("throws when daily_enabled is false (default)", () => {
    expect(() => startDailyGame("2026-04-15")).toThrow(/daily/);
  });

  it("creates a session row with is_daily=1, daily_date set, and game_mode=resolved mode", () => {
    setDailyEnabled(testDb, true);
    const session = startDailyGame("2026-04-15");
    expect(session.id).toBeDefined();
    expect(session.totalRounds).toBe(DAILY_TOTAL_ROUNDS);
    expect(session.gameMode).toBe("comparison"); // Wednesday

    const row = testDb.prepare("SELECT * FROM game_sessions WHERE id = ?").get(session.id) as any;
    expect(row.is_daily).toBe(1);
    expect(row.daily_date).toBe("2026-04-15");
    expect(row.game_mode).toBe("comparison");
    expect(row.current_round).toBe(1);
    expect(row.total_score).toBe(0);
  });

  it("attaches a user_id when provided", () => {
    setDailyEnabled(testDb, true);
    testDb.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at)
       VALUES ('u-daily', 'dailytester', 'dailytester', 'd@example.com', 'hash', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());

    const session = startDailyGame("2026-04-15", "u-daily");
    const row = testDb.prepare("SELECT user_id FROM game_sessions WHERE id = ?").get(session.id) as any;
    expect(row.user_id).toBe("u-daily");
  });

  it("uses the cached daily_puzzles row (idempotent products across sessions)", () => {
    setDailyEnabled(testDb, true);
    const a = startDailyGame("2026-04-15");
    const b = startDailyGame("2026-04-15");
    const aRow = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(a.id) as any;
    const bRow = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(b.id) as any;
    expect(bRow.selected_products).toBe(aRow.selected_products);
  });
});
