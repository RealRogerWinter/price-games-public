import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as any };
});

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as any).default = testDb;
});

// Dynamically import after mock is set up — leaderboard route imports db at module level
const { default: router } = await import("./leaderboard");

// Simple test helper: create a minimal Express-like req/res
function createMockReqRes(query: Record<string, string> = {}) {
  const req = { query } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) { resData.body = data; return res; },
    status(code: number) { resData.statusCode = code; return res; },
  } as any;
  return { req, res, resData };
}

// ─── V2 Lifetime Leaderboard ───

/** Seed a user with a specific lifetime_score and return the id. */
function seedScoredUser(username: string, lifetimeScore: number): string {
  const id = seedUser(testDb, username, `${username}@test.com`);
  testDb.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(lifetimeScore, id);
  return id;
}

function createMockReqResWithUser(
  query: Record<string, string> = {},
  user?: { id: string; username: string },
) {
  const req = { query, user } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) { resData.body = data; return res; },
    status(code: number) { resData.statusCode = code; return res; },
  } as any;
  return { req, res, resData };
}

describe("GET /api/leaderboard/v2", () => {
  function getV2Handler() {
    return (router as any).stack.find((r: any) => r.route?.path === "/v2")?.route?.stack[0]?.handle;
  }

  function seedHistory(
    userId: string,
    score: number,
    playedAt: string,
  ): void {
    testDb
      .prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
         VALUES (?, 'single', 'classic', ?, ?)`,
      )
      .run(userId, score, playedAt);
  }

  it("returns lifetime leaderboard entries with correct fields", () => {
    const aliceId = seedScoredUser("alice", 8000);
    seedHistory(aliceId, 8000, new Date().toISOString());
    const bobId = seedScoredUser("bob", 5000);
    seedHistory(bobId, 5000, new Date().toISOString());

    const handler = getV2Handler();
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqRes();
    handler(req, res);

    expect(resData.body.leaderboard).toBeDefined();
    expect(resData.body.leaderboard).toHaveLength(2);
    expect(resData.body.leaderboard[0]).toMatchObject({
      rank: 1,
      username: "alice",
      lifetimeScore: 8000,
    });
    expect(resData.body.leaderboard[0].totalGames).toBeDefined();
    expect(resData.body.period).toBe("all");
  });

  it("respects limit query param", () => {
    const a = seedScoredUser("a", 100);
    const b = seedScoredUser("b", 200);
    const c = seedScoredUser("c", 300);
    seedHistory(a, 100, new Date().toISOString());
    seedHistory(b, 200, new Date().toISOString());
    seedHistory(c, 300, new Date().toISOString());

    const { req, res, resData } = createMockReqRes({ limit: "2" });
    getV2Handler()(req, res);

    expect(resData.body.leaderboard).toHaveLength(2);
  });

  it("returns empty array when no users exist", () => {
    const { req, res, resData } = createMockReqRes();
    getV2Handler()(req, res);

    expect(resData.body.leaderboard).toEqual([]);
  });

  it("hides rows whose user_game_history was admin-excluded", () => {
    const aliceId = seedScoredUser("alice", 8000);
    seedHistory(aliceId, 8000, new Date().toISOString());
    // Mark the row excluded — the v2 lifetime board should drop alice
    // off the list entirely (only history row, so totalGames goes to 0).
    testDb
      .prepare(
        "UPDATE user_game_history SET excluded_at = ? WHERE user_id = ?",
      )
      .run(new Date().toISOString(), aliceId);

    const { req, res, resData } = createMockReqRes();
    getV2Handler()(req, res);
    // alice's lifetime_score column is still 8000 (the moderation
    // service decrements it on exclude, but a raw UPDATE here doesn't);
    // the LEFT JOIN filters the excluded row, so totalGames should be 0
    // — the entry is still included by lifetime_score alone.
    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0].totalGames).toBe(0);
  });

  it("returns period-scoped entries when period=week", () => {
    // alice: played recently (should appear with in-period score)
    const aliceId = seedScoredUser("alice", 9999);
    seedHistory(aliceId, 300, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    // bob: only played long ago (should drop off the week board)
    const bobId = seedScoredUser("bob", 9999);
    seedHistory(bobId, 9000, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    const { req, res, resData } = createMockReqRes({ period: "week" });
    getV2Handler()(req, res);

    expect(resData.body.period).toBe("week");
    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0]).toMatchObject({
      rank: 1,
      username: "alice",
      score: 300,
      totalGames: 1,
    });
  });

  it("period=week excludes admin-excluded rows from the in-window sum", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedHistory(aliceId, 300, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    seedHistory(aliceId, 100, new Date(Date.now() - 30 * 60 * 1000).toISOString());
    // Exclude the 300-point row
    testDb
      .prepare(
        "UPDATE user_game_history SET excluded_at = ? WHERE user_id = ? AND score = 300",
      )
      .run(new Date().toISOString(), aliceId);

    const { req, res, resData } = createMockReqRes({ period: "week" });
    getV2Handler()(req, res);

    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0]).toMatchObject({
      score: 100,
      totalGames: 1,
    });
  });

  it("treats invalid period values as 'all'", () => {
    const aliceId = seedScoredUser("alice", 8000);
    seedHistory(aliceId, 8000, new Date().toISOString());

    const { req, res, resData } = createMockReqRes({ period: "forever" });
    getV2Handler()(req, res);

    expect(resData.body.period).toBe("all");
    expect(resData.body.leaderboard[0].lifetimeScore).toBe(8000);
  });

  // ─── gameType filter ───

  /** Seed both a user and an in-period game-history row of the given type. */
  function seedUserWithType(
    username: string,
    score: number,
    gameType: "single" | "multiplayer",
  ): string {
    const id = seedScoredUser(username, score);
    testDb
      .prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
         VALUES (?, ?, 'classic', ?, ?)`,
      )
      .run(id, gameType, score, new Date().toISOString());
    return id;
  }

  it("gameType='all' (default) returns the canonical board", () => {
    seedUserWithType("alice", 8000, "single");
    seedUserWithType("bob", 6000, "multiplayer");

    const { req, res, resData } = createMockReqRes();
    getV2Handler()(req, res);

    expect(resData.body.gameType).toBe("all");
    expect(resData.body.leaderboard).toHaveLength(2);
    // Lifetime board ranks by users.lifetime_score (set by seedUserWithType).
    expect(resData.body.leaderboard[0].username).toBe("alice");
  });

  it("gameType='sp' excludes MP-only players", () => {
    seedUserWithType("alice", 8000, "single");
    seedUserWithType("bob", 6000, "multiplayer");

    const { req, res, resData } = createMockReqRes({ gameType: "sp" });
    getV2Handler()(req, res);

    expect(resData.body.gameType).toBe("sp");
    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0].username).toBe("alice");
  });

  it("gameType='mp' excludes SP-only players", () => {
    seedUserWithType("alice", 8000, "single");
    seedUserWithType("bob", 6000, "multiplayer");

    const { req, res, resData } = createMockReqRes({ gameType: "mp" });
    getV2Handler()(req, res);

    expect(resData.body.gameType).toBe("mp");
    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0].username).toBe("bob");
  });

  it("gameType filter composes with period filter", () => {
    // alice has in-week SP only; bob has in-week MP only.
    seedUserWithType("alice", 1000, "single");
    seedUserWithType("bob", 1000, "multiplayer");

    const sp = createMockReqRes({ period: "week", gameType: "sp" });
    getV2Handler()(sp.req, sp.res);
    expect(sp.resData.body.leaderboard).toHaveLength(1);
    expect(sp.resData.body.leaderboard[0].username).toBe("alice");

    const mp = createMockReqRes({ period: "week", gameType: "mp" });
    getV2Handler()(mp.req, mp.res);
    expect(mp.resData.body.leaderboard).toHaveLength(1);
    expect(mp.resData.body.leaderboard[0].username).toBe("bob");
  });

  it("treats invalid gameType values as 'all'", () => {
    seedUserWithType("alice", 8000, "single");
    seedUserWithType("bob", 6000, "multiplayer");

    const { req, res, resData } = createMockReqRes({ gameType: "wat" });
    getV2Handler()(req, res);

    expect(resData.body.gameType).toBe("all");
    expect(resData.body.leaderboard).toHaveLength(2);
  });

  // ─── Numbered pagination — `total` field ───

  it("returns total=0 when no users exist", () => {
    const { req, res, resData } = createMockReqRes();
    getV2Handler()(req, res);
    expect(resData.body.total).toBe(0);
  });

  it("returns total = qualifying-row count regardless of limit", () => {
    // Three eligible users; ask for a single page of 1.
    const a = seedScoredUser("a", 100);
    const b = seedScoredUser("b", 200);
    const c = seedScoredUser("c", 300);
    seedHistory(a, 100, new Date().toISOString());
    seedHistory(b, 200, new Date().toISOString());
    seedHistory(c, 300, new Date().toISOString());

    const { req, res, resData } = createMockReqRes({ limit: "1", offset: "0" });
    getV2Handler()(req, res);

    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.total).toBe(3);
  });

  it("excludes leaderboard-banned and test accounts from total", () => {
    // Three real-eligible users — only two should count.
    const a = seedScoredUser("a", 100);
    seedHistory(a, 100, new Date().toISOString());
    const b = seedScoredUser("b", 200);
    seedHistory(b, 200, new Date().toISOString());
    const c = seedScoredUser("c", 300);
    seedHistory(c, 300, new Date().toISOString());

    testDb.prepare("UPDATE users SET leaderboard_banned_at = ? WHERE id = ?")
      .run(new Date().toISOString(), b);
    testDb.prepare("UPDATE users SET is_test_account = 1 WHERE id = ?").run(c);

    const { req, res, resData } = createMockReqRes();
    getV2Handler()(req, res);

    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.total).toBe(1);
  });

  it("scopes total to the requested period window", () => {
    // alice: in-window; bob: out-of-window. total for week=1.
    const aliceId = seedScoredUser("alice", 9999);
    seedHistory(aliceId, 300, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const bobId = seedScoredUser("bob", 9999);
    seedHistory(bobId, 9000, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    const week = createMockReqRes({ period: "week" });
    getV2Handler()(week.req, week.res);
    expect(week.resData.body.total).toBe(1);

    const all = createMockReqRes();
    getV2Handler()(all.req, all.res);
    expect(all.resData.body.total).toBe(2);
  });

  it("scopes total to the requested gameType slice", () => {
    seedUserWithType("alice", 8000, "single");
    seedUserWithType("bob", 6000, "multiplayer");

    const sp = createMockReqRes({ gameType: "sp" });
    getV2Handler()(sp.req, sp.res);
    expect(sp.resData.body.total).toBe(1);

    const mp = createMockReqRes({ gameType: "mp" });
    getV2Handler()(mp.req, mp.res);
    expect(mp.resData.body.total).toBe(1);

    const all = createMockReqRes();
    getV2Handler()(all.req, all.res);
    expect(all.resData.body.total).toBe(2);
  });
});

describe("GET /api/leaderboard/v2/availability", () => {
  function getAvailabilityHandler() {
    return (router as any).stack.find((r: any) => r.route?.path === "/v2/availability")?.route?.stack[0]?.handle;
  }

  it("returns counts for all four periods", () => {
    const handler = getAvailabilityHandler();
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqRes();
    handler(req, res);

    expect(resData.body).toMatchObject({
      day: expect.any(Number),
      week: expect.any(Number),
      month: expect.any(Number),
      all: expect.any(Number),
    });
  });

  it("excludes admin-excluded rows from bounded-period scorer counts", () => {
    // alice's only in-week row is excluded — she should drop off every
    // bounded-period count (day/week/month). Without this filter, the
    // pill-visibility logic on the leaderboard page would show a
    // non-empty "day" pill that links to an empty board.
    const aliceId = seedScoredUser("alice", 100);
    testDb
      .prepare(
        `INSERT INTO user_game_history
           (user_id, game_type, game_mode, score, played_at, excluded_at)
         VALUES (?, 'single', 'classic', 50, ?, ?)`,
      )
      .run(
        aliceId,
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
      );

    const { req, res, resData } = createMockReqRes();
    getAvailabilityHandler()(req, res);

    expect(resData.body.day).toBe(0);
    expect(resData.body.week).toBe(0);
    expect(resData.body.month).toBe(0);
  });

  it("reflects seeded recent activity in bounded-period counts", () => {
    const aliceId = seedScoredUser("alice", 100);
    testDb
      .prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
         VALUES (?, 'single', 'classic', 50, ?)`,
      )
      .run(aliceId, new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const { req, res, resData } = createMockReqRes();
    getAvailabilityHandler()(req, res);

    expect(resData.body.day).toBe(1);
    expect(resData.body.week).toBe(1);
    expect(resData.body.month).toBe(1);
    expect(resData.body.all).toBe(1);
  });
});

describe("GET /api/leaderboard/rank", () => {
  // The /rank route has optionalUser middleware + handler; grab the last handler in the stack.
  function getRankHandler() {
    const route = (router as any).stack.find((r: any) => r.route?.path === "/rank")?.route;
    return route?.stack[route.stack.length - 1]?.handle;
  }

  it("returns 401 when not authenticated", () => {
    const handler = getRankHandler();
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqResWithUser();
    handler(req, res);

    expect(resData.statusCode).toBe(401);
  });

  it("returns rank, totalPlayers, and bestRank for authenticated user", () => {
    const id = seedScoredUser("alice", 8000);
    seedScoredUser("bob", 5000);

    const handler = getRankHandler();
    const { req, res, resData } = createMockReqResWithUser({}, { id, username: "alice" });
    handler(req, res);

    expect(resData.body).toEqual({ rank: 1, totalPlayers: 2, bestRank: 1 });
  });
});

describe("GET /api/leaderboard/rank/history", () => {
  function getRankHistoryHandler() {
    const route = (router as any).stack.find((r: any) => r.route?.path === "/rank/history")?.route;
    return route?.stack[route.stack.length - 1]?.handle;
  }

  it("returns 401 when not authenticated", () => {
    const handler = getRankHistoryHandler();
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqResWithUser();
    handler(req, res);

    expect(resData.statusCode).toBe(401);
  });

  it("returns rank history for authenticated user", () => {
    const id = seedScoredUser("alice", 8000);
    // Seed rank history entries
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
    ).run(id, 2, 5, now);

    const handler = getRankHistoryHandler();
    const { req, res, resData } = createMockReqResWithUser({}, { id, username: "alice" });
    handler(req, res);

    expect(resData.body.history).toBeDefined();
    expect(resData.body.history).toHaveLength(1);
    expect(resData.body.history[0].rank).toBe(2);
    expect(resData.body.history[0].totalPlayers).toBe(5);
  });

  it("respects days query param", () => {
    const id = seedScoredUser("alice", 8000);
    // Old entry outside 7-day window
    testDb.prepare(
      "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
    ).run(id, 5, 10, "2020-01-01T10:00:00Z");
    // Recent entry
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
    ).run(id, 2, 10, now);

    const handler = getRankHistoryHandler();
    const { req, res, resData } = createMockReqResWithUser({ days: "7" }, { id, username: "alice" });
    handler(req, res);

    expect(resData.body.history).toHaveLength(1);
    expect(resData.body.history[0].rank).toBe(2);
  });
});

describe("GET /api/leaderboard/streaks", () => {
  function getStreaksHandler() {
    return (router as any).stack.find((r: any) => r.route?.path === "/streaks")?.route?.stack[0]?.handle;
  }

  function seedStreak(username: string, best: number, current: number) {
    const id = seedUser(testDb, username, `${username}@test.com`);
    testDb
      .prepare(
        "UPDATE users SET daily_streak_best = ?, daily_streak_current = ? WHERE id = ?",
      )
      .run(best, current, id);
    return id;
  }

  it("returns entries ordered by longest streak DESC", () => {
    seedStreak("alice", 5, 2);
    seedStreak("bob", 12, 1);
    seedStreak("charlie", 9, 9);

    const handler = getStreaksHandler();
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqRes();
    handler(req, res);

    expect(resData.body.leaderboard).toHaveLength(3);
    expect(resData.body.leaderboard[0]).toMatchObject({
      rank: 1,
      username: "bob",
      longestStreak: 12,
    });
    expect(resData.body.leaderboard[1].username).toBe("charlie");
    expect(resData.body.leaderboard[2].username).toBe("alice");
  });

  it("excludes users with best streak of 0", () => {
    seedStreak("alice", 3, 0);
    seedStreak("zero", 0, 0);

    const handler = getStreaksHandler();
    const { req, res, resData } = createMockReqRes();
    handler(req, res);

    expect(resData.body.leaderboard).toHaveLength(1);
    expect(resData.body.leaderboard[0].username).toBe("alice");
  });

  it("clamps the limit query param to [1, 100]", () => {
    for (let i = 1; i <= 5; i++) seedStreak(`u${i}`, i, 0);

    const handler = getStreaksHandler();

    const r1 = createMockReqRes({ limit: "2" });
    handler(r1.req, r1.res);
    expect(r1.resData.body.leaderboard).toHaveLength(2);

    const r2 = createMockReqRes({ limit: "0" });
    handler(r2.req, r2.res);
    expect(r2.resData.body.leaderboard.length).toBeGreaterThanOrEqual(1);

    const r3 = createMockReqRes({ limit: "not-a-number" });
    handler(r3.req, r3.res);
    // Default limit is 20 — we seeded 5, so we see all 5.
    expect(r3.resData.body.leaderboard.length).toBe(5);
  });

  it("returns empty array when no streaks exist", () => {
    const handler = getStreaksHandler();
    const { req, res, resData } = createMockReqRes();
    handler(req, res);

    expect(resData.body.leaderboard).toEqual([]);
  });
});
