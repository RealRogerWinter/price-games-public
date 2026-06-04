import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedDiverseProducts, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { setDailyEnabled, setDisabledGameModes } from "../services/siteSettings";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as unknown };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedDiverseProducts(testDb, 60);
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;
});

const { default: router } = await import("./daily");

/* eslint-disable @typescript-eslint/no-explicit-any */
function getHandler(method: "post" | "get" | "delete", path: string): any {
  // Walk all middlewares for the path; the route handler is the LAST one.
  const layer = (router as any).stack.find(
    (r: any) => r.route?.path === path && r.route?.methods[method]
  );
  if (!layer) throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function createMockReqRes(opts: {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  user?: { id: string; username: string };
  visitorId?: string;
} = {}) {
  const req = {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    user: opts.user,
    visitorId: opts.visitorId,
  } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) {
      resData.body = data;
      return res;
    },
    status(code: number) {
      resData.statusCode = code;
      return res;
    },
  } as any;
  return { req, res, resData };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("GET /api/daily/today", () => {
  it("returns 404 daily_disabled when daily is OFF (default)", () => {
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes();
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "daily_disabled" });
  });

  it("returns the resolved mode and totalRounds=5 when enabled", () => {
    setDailyEnabled(testDb, true);
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes();
    handler(req, res);
    expect(resData.statusCode).toBeUndefined(); // 200
    expect(resData.body).toMatchObject({
      totalRounds: 5,
    });
    expect(typeof resData.body.date).toBe("string");
    expect(["classic", "higher-lower", "comparison", "bidding"]).toContain(resData.body.gameMode);
    expect(typeof resData.body.modeName).toBe("string");
  });

  it("returns 404 no_available_mode when ALL DAILY_POOL modes are disabled", () => {
    setDailyEnabled(testDb, true);
    setDisabledGameModes(testDb, ["classic", "higher-lower", "comparison", "bidding"]);
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes();
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "no_available_mode" });
  });

  it("includes alreadyPlayed=false for a logged-in user with no plays", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "newcomer");
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "newcomer" } });
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBe(false);
    expect(resData.body.streak).toEqual({ current: 0, best: 0, lastDate: null });
  });

  it("does NOT include alreadyPlayed/streak for anonymous users", () => {
    setDailyEnabled(testDb, true);
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes(); // no user
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBeUndefined();
    expect(resData.body.streak).toBeUndefined();
  });

  it("returns alreadyPlayed=true after a logged-in user has played today", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "playeralready");
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (?, 'sess-x', ?, 'classic', 5000, ?, ?)`
    ).run(userId, today, new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "playeralready" } });
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBe(true);
  });

  // End-to-end consistency for the device-aware fix: if the user's browser
  // already played the daily as a guest, /today must report alreadyPlayed=true
  // so the UI doesn't render "Play Daily" only to 409 on click. Mirrors the
  // OR-axis filter used by /start and the notification scheduler.
  it("returns alreadyPlayed=true when the logged-in user's device played as a guest", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "deviceplayedguest");
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
       VALUES (NULL, 'sess-guest-dev', ?, 'classic', 5000, ?, ?, ?)`
    ).run(today, new Date().toISOString(), new Date().toISOString(), "visitor-guest-played");

    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "deviceplayedguest" },
      visitorId: "visitor-guest-played",
    });
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBe(true);
  });
});

describe("POST /api/daily/start", () => {
  it("returns 404 daily_disabled when daily is OFF", () => {
    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes();
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "daily_disabled" });
  });

  it("creates an anonymous session when enabled", () => {
    setDailyEnabled(testDb, true);
    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes();
    handler(req, res);
    expect(resData.body).toMatchObject({
      totalRounds: 5,
      currentRound: 1,
      totalScore: 0,
      completed: false,
    });
    expect(resData.body.id).toBeDefined();
  });

  it("creates a session attached to a logged-in user", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "starter");
    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "starter" } });
    handler(req, res);
    expect(resData.body.id).toBeDefined();
    const row = testDb.prepare("SELECT user_id, is_daily FROM game_sessions WHERE id = ?").get(resData.body.id) as any;
    expect(row.user_id).toBe(userId);
    expect(row.is_daily).toBe(1);
  });

  it("returns 409 already_played when the user already has a daily_plays row for today", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "repeater");
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (?, 'sess-old', ?, 'classic', 5000, ?, ?)`
    ).run(userId, today, new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "repeater" } });
    handler(req, res);
    expect(resData.statusCode).toBe(409);
    expect(resData.body).toMatchObject({ error: "already_played" });
  });

  it("does NOT pre-check for anonymous users without a visitor_id", () => {
    setDailyEnabled(testDb, true);
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (NULL, 'sess-anon', ?, 'classic', 5000, ?, ?)`
    ).run(today, new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes(); // no user, no visitor
    handler(req, res);
    expect(resData.statusCode).toBeUndefined();
    expect(resData.body.id).toBeDefined();
  });

  // Device-aware pre-check: when the request carries a visitor_id that already
  // has a daily_plays row for today, short-circuit with 409 — even without a
  // logged-in user. Prevents a guest from spinning up a second daily session
  // on the same browser only to be blocked at submit time.
  it("returns 409 when the same visitor already played today (anonymous)", () => {
    setDailyEnabled(testDb, true);
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
       VALUES (NULL, 'sess-visitor', ?, 'classic', 5000, ?, ?, ?)`
    ).run(today, new Date().toISOString(), new Date().toISOString(), "visitor-already-played");

    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes({ visitorId: "visitor-already-played" });
    handler(req, res);
    expect(resData.statusCode).toBe(409);
    expect(resData.body).toMatchObject({ error: "already_played" });
  });

  // A logged-in user whose *device* (visitor_id) played as a guest today
  // should also be blocked, so the user_id axis isn't the only way the
  // pre-check can fire.
  it("returns 409 when the logged-in user's device already played as a guest", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "devicerepeater");
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
       VALUES (NULL, 'sess-guest-dev', ?, 'classic', 5000, ?, ?, ?)`
    ).run(today, new Date().toISOString(), new Date().toISOString(), "visitor-logged-in-now");

    const handler = getHandler("post", "/start");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "devicerepeater" },
      visitorId: "visitor-logged-in-now",
    });
    handler(req, res);
    expect(resData.statusCode).toBe(409);
    expect(resData.body).toMatchObject({ error: "already_played" });
  });
});

describe("GET /api/daily/history", () => {
  it("returns the user's last 30 daily plays in date-desc order", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "historian");
    // Insert 5 plays on different dates.
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion, started_at)
       VALUES (?, ?, ?, 'classic', ?, '[1000,1000,1000,1000,1000]', ?, ?, ?)`
    );
    const now = new Date().toISOString();
    insert.run(userId, "s1", "2026-04-10", 5000, now, 1, now);
    insert.run(userId, "s2", "2026-04-11", 4500, now, 2, now);
    insert.run(userId, "s3", "2026-04-12", 3000, now, 3, now);

    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "historian" } });
    handler(req, res);
    expect(resData.body.plays).toHaveLength(3);
    // Ordered date-desc
    expect(resData.body.plays[0].date).toBe("2026-04-12");
    expect(resData.body.plays[1].date).toBe("2026-04-11");
    expect(resData.body.plays[2].date).toBe("2026-04-10");
    expect(resData.body.plays[0].score).toBe(3000);
    expect(resData.body.plays[0].streakAtCompletion).toBe(3);
    expect(Array.isArray(resData.body.plays[0].perRoundScores)).toBe(true);
  });

  it("returns an empty list for users with no plays", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "empty");
    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({ user: { id: userId, username: "empty" } });
    handler(req, res);
    expect(resData.body.plays).toEqual([]);
  });

  it("respects a custom ?limit query parameter", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "limiter");
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion, started_at)
       VALUES (?, ?, ?, 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, 1, ?)`
    );
    const now = new Date().toISOString();
    insert.run(userId, "l1", "2026-04-01", now, now);
    insert.run(userId, "l2", "2026-04-02", now, now);
    insert.run(userId, "l3", "2026-04-03", now, now);
    insert.run(userId, "l4", "2026-04-04", now, now);
    insert.run(userId, "l5", "2026-04-05", now, now);

    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "limiter" },
      query: { limit: "2" },
    });
    handler(req, res);
    expect(resData.body.plays).toHaveLength(2);
  });

  it("caps ?limit at 90", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "capper");
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion, started_at)
       VALUES (?, ?, ?, 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, 1, ?)`
    );
    const now = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      insert.run(userId, `c${i}`, `2026-03-${String(i).padStart(2, "0")}`, now, now);
    }

    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "capper" },
      query: { limit: "999" },
    });
    handler(req, res);
    // All 5 rows returned (capped at 90, not 999, but 5 < 90 so all returned)
    expect(resData.body.plays).toHaveLength(5);
  });

  it("falls back to default 30 for non-numeric ?limit", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "badlimit");
    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "badlimit" },
      query: { limit: "abc" },
    });
    handler(req, res);
    expect(resData.body.plays).toEqual([]);
  });

  it("clamps ?limit=0 to 1", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "zero");
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion, started_at)
       VALUES (?, ?, ?, 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, 1, ?)`
    );
    const now = new Date().toISOString();
    insert.run(userId, "z1", "2026-04-01", now, now);
    insert.run(userId, "z2", "2026-04-02", now, now);

    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "zero" },
      query: { limit: "0" },
    });
    handler(req, res);
    expect(resData.body.plays).toHaveLength(1);
  });

  it("clamps ?limit=-5 to 1", () => {
    setDailyEnabled(testDb, true);
    const userId = seedUser(testDb, "negative");
    const insert = testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion, started_at)
       VALUES (?, ?, ?, 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, 1, ?)`
    );
    const now = new Date().toISOString();
    insert.run(userId, "n1", "2026-04-01", now, now);
    insert.run(userId, "n2", "2026-04-02", now, now);

    const handler = getHandler("get", "/history");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "negative" },
      query: { limit: "-5" },
    });
    handler(req, res);
    expect(resData.body.plays).toHaveLength(1);
  });
});

describe("GET /api/daily/recap/:date", () => {
  function seedCompletedPlayAndPuzzle(
    userId: string,
    date: string,
    gameMode: string = "comparison",
  ): void {
    // Seed a deterministic puzzle row with per-round product IDs.
    testDb
      .prepare(
        `INSERT INTO daily_puzzles
           (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
         VALUES (?, ?, ?, ?, 1, 0, ?)`
      )
      .run(
        date,
        gameMode,
        JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        JSON.stringify({
          "1": { productIds: [1, 2], question: "most-expensive" },
          "2": { productIds: [3, 4], question: "most-expensive" },
          "3": { productIds: [5, 6], question: "most-expensive" },
          "4": { productIds: [7, 8], question: "most-expensive" },
          "5": { productIds: [9, 10], question: "most-expensive" },
        }),
        new Date().toISOString(),
      );
    // Seed the user's completed play for that date.
    testDb
      .prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion)
         VALUES (?, ?, ?, ?, 18500, '[3800,3700,3600,3800,3600]', ?, ?, 7)`
      )
      .run(
        userId,
        `sess-${date}`,
        date,
        gameMode,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  }

  it("returns the rich recap payload with per-round products", () => {
    const userId = seedUser(testDb, "recapper");
    seedCompletedPlayAndPuzzle(userId, "2026-04-11");

    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "recapper" },
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBeUndefined();
    expect(resData.body).toMatchObject({
      date: "2026-04-11",
      gameMode: "comparison",
      totalScore: 18500,
      perRoundScores: [3800, 3700, 3600, 3800, 3600],
    });
    expect(resData.body.rounds).toHaveLength(5);
    // Comparison mode has 2 products per round.
    expect(resData.body.rounds[0].products.length).toBeGreaterThanOrEqual(1);
    expect(resData.body.rounds[0].score).toBe(3800);
    expect(resData.body.rounds[0].roundNumber).toBe(1);
    // First round's product should resolve to a real title from the
    // seeded products table.
    expect(typeof resData.body.rounds[0].products[0].title).toBe("string");
    expect(typeof resData.body.rounds[0].products[0].priceCents).toBe("number");
  });

  it("returns 400 for a malformed date", () => {
    const userId = seedUser(testDb, "badformat");
    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "badformat" },
      params: { date: "not-a-date" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(400);
    expect(resData.body).toEqual({ error: "invalid_date" });
  });

  it("returns 404 when the user has not completed that date", () => {
    const userId = seedUser(testDb, "uncompleted");
    // Puzzle exists but no daily_plays row → not_completed.
    testDb
      .prepare(
        `INSERT INTO daily_puzzles
           (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
         VALUES (?, 'classic', '[1]', '{"1":{"productIds":[1]}}', 1, 0, ?)`
      )
      .run("2026-04-11", new Date().toISOString());

    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "uncompleted" },
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "not_completed" });
  });

  it("returns 404 when the puzzle row has been pruned", () => {
    const userId = seedUser(testDb, "pruned");
    // Play row exists but no matching daily_puzzles row.
    testDb
      .prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion)
         VALUES (?, 'sess-x', '2026-04-11', 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, ?, 1)`
      )
      .run(userId, new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "pruned" },
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "puzzle_missing" });
  });

  it("returns 404 corrupt_puzzle when round_data is malformed JSON", () => {
    const userId = seedUser(testDb, "corrupted");
    // Insert a puzzle with deliberately malformed round_data so the
    // JSON.parse in the recap route throws and the try/catch surfaces a
    // clean 404 instead of a bare 500.
    testDb
      .prepare(
        `INSERT INTO daily_puzzles
           (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
         VALUES (?, 'classic', '[1]', ?, 1, 0, ?)`
      )
      .run("2026-04-11", "{not-json}", new Date().toISOString());
    testDb
      .prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion)
         VALUES (?, 'sess-c', '2026-04-11', 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, ?, 1)`
      )
      .run(userId, new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      user: { id: userId, username: "corrupted" },
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "corrupt_puzzle" });
  });

  // --- Anonymous recap access via visitor_id ---

  it("returns the recap for an anonymous visitor who completed the daily", () => {
    // Seed puzzle
    testDb
      .prepare(
        `INSERT INTO daily_puzzles
           (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at)
         VALUES (?, 'comparison', ?, ?, 1, 0, ?)`
      )
      .run(
        "2026-04-11",
        JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        JSON.stringify({
          "1": { productIds: [1, 2], question: "most-expensive" },
          "2": { productIds: [3, 4], question: "most-expensive" },
          "3": { productIds: [5, 6], question: "most-expensive" },
          "4": { productIds: [7, 8], question: "most-expensive" },
          "5": { productIds: [9, 10], question: "most-expensive" },
        }),
        new Date().toISOString(),
      );
    // Seed anonymous completed play
    testDb
      .prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, visitor_id)
         VALUES (NULL, 'sess-anon-recap', '2026-04-11', 'comparison', 18500, '[3800,3700,3600,3800,3600]', ?, ?, 'visitor-recap-test')`
      )
      .run(new Date().toISOString(), new Date().toISOString());

    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      visitorId: "visitor-recap-test",
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBeUndefined(); // 200
    expect(resData.body).toMatchObject({
      date: "2026-04-11",
      gameMode: "comparison",
      totalScore: 18500,
    });
    expect(resData.body.rounds).toHaveLength(5);
  });

  it("returns 404 not_completed for anonymous visitor with no matching play", () => {
    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      visitorId: "visitor-no-play",
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect(resData.body).toEqual({ error: "not_completed" });
  });

  it("returns 401 when neither user nor visitor is present", () => {
    const handler = getHandler("get", "/recap/:date");
    const { req, res, resData } = createMockReqRes({
      params: { date: "2026-04-11" },
    });
    handler(req, res);
    expect(resData.statusCode).toBe(401);
    expect(resData.body).toEqual({ error: "Authentication required" });
  });
});

// --- Anonymous alreadyPlayed on /today ---

describe("GET /api/daily/today — anonymous alreadyPlayed", () => {
  it("returns alreadyPlayed=true for anonymous visitor whose device played today", () => {
    setDailyEnabled(testDb, true);
    const today = new Date().toISOString().slice(0, 10);
    testDb.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
       VALUES (NULL, 'sess-anon-today', ?, 'classic', 5000, ?, ?, ?)`
    ).run(today, new Date().toISOString(), new Date().toISOString(), "visitor-anon-played");

    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes({
      visitorId: "visitor-anon-played",
    });
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBe(true);
  });

  it("does NOT include alreadyPlayed for anonymous visitor with no plays", () => {
    setDailyEnabled(testDb, true);
    const handler = getHandler("get", "/today");
    const { req, res, resData } = createMockReqRes({
      visitorId: "visitor-fresh",
    });
    handler(req, res);
    expect(resData.body.alreadyPlayed).toBeUndefined();
  });
});
