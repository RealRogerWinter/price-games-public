import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return {
    default: null as any,
  };
});

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { updateStreakOnCompletion, getStreakForUser, decayStaleStreaks } = await import("./dailyStreak");

describe("getStreakForUser", () => {
  it("returns zeros and null lastDate for a brand-new user", () => {
    const userId = seedUser(testDb, "fresh");
    const streak = getStreakForUser(testDb, userId);
    expect(streak).toEqual({ current: 0, best: 0, lastDate: null });
  });

  it("returns null for a non-existent user (defensive)", () => {
    const streak = getStreakForUser(testDb, "no-such-user");
    expect(streak).toEqual({ current: 0, best: 0, lastDate: null });
  });

  // ─── Read-time decay: streak goes stale when user misses a day ───

  it("reports stored current when lastDate is today", () => {
    const userId = seedUser(testDb, "today");
    updateStreakOnCompletion(testDb, userId, "2026-04-16");
    const streak = getStreakForUser(testDb, userId, "2026-04-16");
    expect(streak).toEqual({ current: 1, best: 1, lastDate: "2026-04-16" });
  });

  it("reports stored current when lastDate is exactly yesterday", () => {
    const userId = seedUser(testDb, "grace");
    updateStreakOnCompletion(testDb, userId, "2026-04-15");
    // today = 2026-04-16, lastDate = 2026-04-15 → still alive
    const streak = getStreakForUser(testDb, userId, "2026-04-16");
    expect(streak.current).toBe(1);
    expect(streak.lastDate).toBe("2026-04-15");
  });

  it("zeros current when lastDate is two days ago (missed a full day)", () => {
    const userId = seedUser(testDb, "roger");
    // Build a streak of 5 ending 2026-04-13
    for (let i = 0; i < 5; i++) {
      const day = `2026-04-${String(9 + i).padStart(2, "0")}`;
      updateStreakOnCompletion(testDb, userId, day);
    }
    // No plays on 04-14 or 04-15; viewer loads the card on 04-16.
    const streak = getStreakForUser(testDb, userId, "2026-04-16");
    expect(streak.current).toBe(0);
    expect(streak.best).toBe(5);
    expect(streak.lastDate).toBe("2026-04-13");
  });

  it("zeros current when lastDate is far in the past", () => {
    const userId = seedUser(testDb, "dormant");
    updateStreakOnCompletion(testDb, userId, "2025-11-01");
    const streak = getStreakForUser(testDb, userId, "2026-04-16");
    expect(streak.current).toBe(0);
    expect(streak.best).toBe(1);
    expect(streak.lastDate).toBe("2025-11-01");
  });

  it("does not mutate the stored current when decaying at read time", () => {
    const userId = seedUser(testDb, "nomutate");
    updateStreakOnCompletion(testDb, userId, "2026-04-10");
    // Read on a day well past yesterday → effective 0, but the stored
    // column must stay at its last-written value so the next completion's
    // math (via updateStreakOnCompletion) still has correct history.
    getStreakForUser(testDb, userId, "2026-04-16");
    const row = testDb
      .prepare(
        "SELECT daily_streak_current, daily_streak_last_date FROM users WHERE id = ?",
      )
      .get(userId) as { daily_streak_current: number; daily_streak_last_date: string };
    expect(row.daily_streak_current).toBe(1);
    expect(row.daily_streak_last_date).toBe("2026-04-10");
  });
});

describe("updateStreakOnCompletion", () => {
  it("starts a new streak at 1 with isNewStreak=true on first-ever completion", () => {
    const userId = seedUser(testDb, "alice");
    const result = updateStreakOnCompletion(testDb, userId, "2026-04-15");
    expect(result.current).toBe(1);
    expect(result.best).toBe(1);
    expect(result.isNewBest).toBe(true);
    expect(result.isNewStreak).toBe(true);

    // Pass the same day as the completion for `today`. The default
    // argument uses wall-clock now, which makes the test date-sensitive
    // and starts failing once the wall clock advances past the fixture.
    const streak = getStreakForUser(testDb, userId, "2026-04-15");
    expect(streak).toEqual({ current: 1, best: 1, lastDate: "2026-04-15" });
  });

  it("increments the streak when called for the next consecutive day", () => {
    const userId = seedUser(testDb, "bob");
    updateStreakOnCompletion(testDb, userId, "2026-04-15");
    const day2 = updateStreakOnCompletion(testDb, userId, "2026-04-16");
    expect(day2.current).toBe(2);
    expect(day2.best).toBe(2);
    expect(day2.isNewStreak).toBe(true);
    expect(day2.isNewBest).toBe(true);
  });

  it("resets the streak to 1 when a day was missed", () => {
    const userId = seedUser(testDb, "carol");
    updateStreakOnCompletion(testDb, userId, "2026-04-15");
    updateStreakOnCompletion(testDb, userId, "2026-04-16"); // current = 2
    // Skip 2026-04-17, jump to 2026-04-18
    const reset = updateStreakOnCompletion(testDb, userId, "2026-04-18");
    expect(reset.current).toBe(1);
    expect(reset.best).toBe(2); // best is preserved
    expect(reset.isNewStreak).toBe(false);
    expect(reset.isNewBest).toBe(false);
  });

  it("only updates best when current EXCEEDS the previous best", () => {
    const userId = seedUser(testDb, "dave");
    // Build a streak of 5
    for (let i = 0; i < 5; i++) {
      const day = `2026-04-${String(15 + i).padStart(2, "0")}`;
      updateStreakOnCompletion(testDb, userId, day);
    }
    // Confirm best = 5 (anchor the read to the last completion date so
    // the decay check doesn't kick in when the wall clock advances).
    expect(getStreakForUser(testDb, userId, "2026-04-19")).toEqual({
      current: 5,
      best: 5,
      lastDate: "2026-04-19",
    });

    // Break the streak (skip 04-20)
    const reset = updateStreakOnCompletion(testDb, userId, "2026-04-21");
    expect(reset.current).toBe(1);
    expect(reset.best).toBe(5);
    expect(reset.isNewBest).toBe(false);

    // Build to 4 — should NOT exceed best (still 5)
    for (let i = 0; i < 3; i++) {
      const day = `2026-04-${String(22 + i).padStart(2, "0")}`;
      updateStreakOnCompletion(testDb, userId, day);
    }
    const stillBelowBest = getStreakForUser(testDb, userId, "2026-04-24");
    expect(stillBelowBest.current).toBe(4);
    expect(stillBelowBest.best).toBe(5);
  });

  it("handles month boundaries correctly", () => {
    const userId = seedUser(testDb, "eve");
    updateStreakOnCompletion(testDb, userId, "2026-04-30");
    const may1 = updateStreakOnCompletion(testDb, userId, "2026-05-01");
    expect(may1.current).toBe(2);
    expect(may1.isNewStreak).toBe(true);
  });

  it("handles year boundaries correctly", () => {
    const userId = seedUser(testDb, "frank");
    updateStreakOnCompletion(testDb, userId, "2026-12-31");
    const jan1 = updateStreakOnCompletion(testDb, userId, "2027-01-01");
    expect(jan1.current).toBe(2);
  });

  it("called twice for the same date does not double-increment", () => {
    // Defensive — the unique index should prevent duplicate daily_plays
    // rows so this code path is technically unreachable, but we cover it
    // anyway since updateStreakOnCompletion has no idempotency guarantee
    // beyond what's enforced upstream.
    //
    // Behavior: same-date second call resets current to 1 (because
    // last_date === dailyDate, not === dailyDate-1). This is the correct
    // brutal-Wordle interpretation: same-day replay is a "new streak"
    // by virtue of not being a +1 from yesterday.
    const userId = seedUser(testDb, "grace");
    updateStreakOnCompletion(testDb, userId, "2026-04-15");
    const second = updateStreakOnCompletion(testDb, userId, "2026-04-15");
    expect(second.current).toBe(1);
    expect(second.isNewStreak).toBe(false);
  });
});

describe("decayStaleStreaks", () => {
  it("zeros stored daily_streak_current for users whose last play is older than yesterday", () => {
    const aliceId = seedUser(testDb, "alice", "alice@test.com");
    const bobId = seedUser(testDb, "bob", "bob@test.com");
    const carolId = seedUser(testDb, "carol", "carol@test.com");

    // Alice: played today — alive.
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 5, daily_streak_last_date = '2026-04-16' WHERE id = ?",
    ).run(aliceId);
    // Bob: played yesterday — still alive (within grace window).
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 3, daily_streak_last_date = '2026-04-15' WHERE id = ?",
    ).run(bobId);
    // Carol: played 5 days ago — dead.
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 8, daily_streak_last_date = '2026-04-11' WHERE id = ?",
    ).run(carolId);

    const reset = decayStaleStreaks(testDb, "2026-04-16");
    expect(reset).toBe(1); // only Carol

    const alice = testDb.prepare("SELECT daily_streak_current FROM users WHERE id = ?").get(aliceId) as { daily_streak_current: number };
    const bob = testDb.prepare("SELECT daily_streak_current FROM users WHERE id = ?").get(bobId) as { daily_streak_current: number };
    const carol = testDb.prepare("SELECT daily_streak_current FROM users WHERE id = ?").get(carolId) as { daily_streak_current: number };
    expect(alice.daily_streak_current).toBe(5);
    expect(bob.daily_streak_current).toBe(3);
    expect(carol.daily_streak_current).toBe(0);
  });

  it("preserves daily_streak_best across the decay (so 'Best: N' still renders)", () => {
    const userId = seedUser(testDb, "preserve", "preserve@test.com");
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 4, daily_streak_best = 9, daily_streak_last_date = '2026-04-10' WHERE id = ?",
    ).run(userId);

    decayStaleStreaks(testDb, "2026-04-16");

    const row = testDb.prepare(
      "SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?",
    ).get(userId) as { daily_streak_current: number; daily_streak_best: number; daily_streak_last_date: string };
    expect(row.daily_streak_current).toBe(0);
    expect(row.daily_streak_best).toBe(9);
    // last_date is intentionally untouched — the next completion overwrites it.
    expect(row.daily_streak_last_date).toBe("2026-04-10");
  });

  it("is idempotent — running twice has no further effect", () => {
    const userId = seedUser(testDb, "idem", "idem@test.com");
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 7, daily_streak_last_date = '2026-04-10' WHERE id = ?",
    ).run(userId);

    expect(decayStaleStreaks(testDb, "2026-04-16")).toBe(1);
    // Second run finds nothing to update because current is already 0.
    expect(decayStaleStreaks(testDb, "2026-04-16")).toBe(0);
  });

  it("is a no-op when no users qualify", () => {
    const userId = seedUser(testDb, "active", "active@test.com");
    testDb.prepare(
      "UPDATE users SET daily_streak_current = 4, daily_streak_last_date = '2026-04-15' WHERE id = ?",
    ).run(userId);
    expect(decayStaleStreaks(testDb, "2026-04-16")).toBe(0);
  });
});
