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

/** Seed a user with a specific lifetime_score and return the id. */
function seedScoredUser(username: string, lifetimeScore: number): string {
  const id = seedUser(testDb, username, `${username}@test.com`);
  testDb.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(lifetimeScore, id);
  return id;
}

/** Insert a game history entry. */
function seedGameHistory(
  userId: string,
  gameMode: string,
  score: number,
  playedAt: string,
  options?: { gameType?: string; placement?: number; playersCount?: number },
): void {
  testDb.prepare(
    `INSERT INTO user_game_history (user_id, game_type, game_mode, score, placement, players_count, played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    options?.gameType ?? "single",
    gameMode,
    score,
    options?.placement ?? null,
    options?.playersCount ?? null,
    playedAt,
  );
}

const { default: router } = await import("./player");

function createMockReqRes(
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const req = { params, query } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) { resData.body = data; return res; },
    status(code: number) { resData.statusCode = code; return res; },
  } as any;
  return { req, res, resData };
}

function getHandler(path: string) {
  return (router as any).stack.find(
    (r: any) => r.route?.path === path,
  )?.route?.stack[0]?.handle;
}

describe("GET /api/player/:username", () => {
  const handler = getHandler("/:username");

  it("returns 404 for non-existent user", () => {
    const { req, res, resData } = createMockReqRes({ username: "nobody" });
    handler(req, res);

    expect(resData.statusCode).toBe(404);
    expect(resData.body.error).toBeDefined();
  });

  it("returns public profile for valid user", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 5000, "2026-01-01T10:00:00Z");

    const { req, res, resData } = createMockReqRes({ username: "alice" });
    handler(req, res);

    expect(resData.body.profile).toBeDefined();
    expect(resData.body.profile.username).toBe("alice");
    expect(resData.body.profile.lifetimeScore).toBe(5000);
    expect(resData.body.profile.memberSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is case-insensitive for username lookup", () => {
    seedScoredUser("Alice", 5000);

    const { req, res, resData } = createMockReqRes({ username: "ALICE" });
    handler(req, res);

    expect(resData.body.profile).toBeDefined();
    expect(resData.body.profile.username).toBe("Alice");
  });
});

describe("GET /api/player/:username/score-history", () => {
  const handler = getHandler("/:username/score-history");

  it("returns daily aggregates", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 3000, "2026-04-01T10:00:00Z");
    seedGameHistory(id, "classic", 2000, "2026-04-02T10:00:00Z");

    const { req, res, resData } = createMockReqRes({ username: "alice" }, { days: "365" });
    handler(req, res);

    expect(resData.body.history).toBeDefined();
    expect(resData.body.history.length).toBeGreaterThanOrEqual(2);
  });

  it("respects days param", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2020-01-01T10:00:00Z");
    const today = new Date().toISOString();
    seedGameHistory(id, "classic", 2000, today);

    const { req, res, resData } = createMockReqRes({ username: "alice" }, { days: "7" });
    handler(req, res);

    // Zero-fill guarantees `days` entries; only the recent game contributes.
    expect(resData.body.history).toHaveLength(7);
    const total = (resData.body.history as { totalScore: number }[])
      .reduce((s, d) => s + d.totalScore, 0);
    expect(total).toBe(2000);
  });

  it("returns empty for non-existent user", () => {
    const { req, res, resData } = createMockReqRes({ username: "nobody" });
    handler(req, res);

    expect(resData.body.history).toEqual([]);
  });
});

describe("GET /api/player/:username/history", () => {
  const handler = getHandler("/:username/history");

  it("returns paginated entries with date-only", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-04-01T10:30:45Z");

    const { req, res, resData } = createMockReqRes({ username: "alice" });
    handler(req, res);

    expect(resData.body.entries).toHaveLength(1);
    expect(resData.body.entries[0].playedDate).toBe("2026-04-01");
    expect(resData.body.total).toBe(1);
  });

  it("respects limit and offset params", () => {
    const id = seedScoredUser("alice", 5000);
    for (let i = 1; i <= 5; i++) {
      seedGameHistory(id, "classic", i * 100, `2026-04-0${i}T10:00:00Z`);
    }

    const { req, res, resData } = createMockReqRes(
      { username: "alice" },
      { limit: "2", offset: "0" },
    );
    handler(req, res);

    expect(resData.body.entries).toHaveLength(2);
    expect(resData.body.total).toBe(5);
  });

  it("returns empty for non-existent user", () => {
    const { req, res, resData } = createMockReqRes({ username: "nobody" });
    handler(req, res);

    expect(resData.body.entries).toEqual([]);
    expect(resData.body.total).toBe(0);
  });
});
