import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as unknown };
});

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as { default: unknown }).default = testDb;
});

// Dynamically import after mock is set up — the route imports db at module level.
const { default: router } = await import("./share");

/** Extract a route handler by method + path from the Express router stack. */
function getHandler(method: "post" | "get", path: string): (req: unknown, res: unknown) => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any) => r.route?.path === path && r.route?.methods[method]
  );
  if (!layer) throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

/** Create a minimal Express-like req/res. */
function createMockReqRes(body: unknown = {}, params: Record<string, string> = {}) {
  const req = { body, params } as unknown;
  const resData: { statusCode?: number; body?: unknown } = {};
  const res = {
    json(data: unknown) {
      resData.body = data;
      return res;
    },
    status(code: number) {
      resData.statusCode = code;
      return res;
    },
  } as unknown;
  return { req, res, resData };
}

/** Build a valid POST body with 10 classic-mode rounds. */
function validPayload(overrides: Record<string, unknown> = {}) {
  const rounds = Array.from({ length: 10 }, (_, i) => ({
    roundNumber: i + 1,
    score: 1000,
    products: [
      {
        title: `Product ${i + 1}`,
        imageUrl: "https://example.com/p.jpg",
        priceCents: 2500,
      },
    ],
    guessedPriceCents: 2450,
  }));
  return {
    gameMode: "classic",
    totalScore: 10000,
    roundData: rounds,
    ...overrides,
  };
}

describe("POST /api/share", () => {
  it("creates a share record and returns id + url", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload());
    handler(req, res);

    expect(resData.statusCode).toBe(201);
    const body = resData.body as { id: string; url: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(body.url).toBe(`/s/${body.id}`);

    // Row should exist in the DB.
    const row = testDb.prepare("SELECT * FROM shared_games WHERE id = ?").get(body.id) as
      | { id: string; game_mode: string; total_score: number; per_round_max: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.game_mode).toBe("classic");
    expect(row!.total_score).toBe(10000);
    expect(row!.per_round_max).toBe(1000);
  });

  it("uses 1313 per_round_max for chain-reaction (server-computed, not client)", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(
      validPayload({
        gameMode: "chain-reaction",
        totalScore: 13130,
        perRoundMax: 9999, // Client lies; server must ignore.
      })
    );
    handler(req, res);
    expect(resData.statusCode).toBe(201);
    const id = (resData.body as { id: string }).id;
    const row = testDb.prepare("SELECT per_round_max FROM shared_games WHERE id = ?").get(id) as
      | { per_round_max: number }
      | undefined;
    expect(row!.per_round_max).toBe(1313);
  });

  it("sanitizes and stores playerName when provided", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(
      validPayload({ playerName: "  Alice  " })
    );
    handler(req, res);
    expect(resData.statusCode).toBe(201);
    const id = (resData.body as { id: string }).id;
    const row = testDb.prepare("SELECT player_name FROM shared_games WHERE id = ?").get(id) as
      | { player_name: string | null }
      | undefined;
    expect(row!.player_name).toBe("Alice");
  });

  it("stores null playerName when omitted", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload());
    handler(req, res);
    const id = (resData.body as { id: string }).id;
    const row = testDb.prepare("SELECT player_name FROM shared_games WHERE id = ?").get(id) as
      | { player_name: string | null }
      | undefined;
    expect(row!.player_name).toBeNull();
  });

  it("stores null playerName when empty string passed", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ playerName: "" }));
    handler(req, res);
    expect(resData.statusCode).toBe(201);
    const id = (resData.body as { id: string }).id;
    const row = testDb.prepare("SELECT player_name FROM shared_games WHERE id = ?").get(id) as
      | { player_name: string | null }
      | undefined;
    expect(row!.player_name).toBeNull();
  });

  it("rejects invalid gameMode with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ gameMode: "not-a-mode" }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
    expect((resData.body as { error: string }).error).toMatch(/gameMode/);
  });

  it("rejects missing gameMode with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ gameMode: undefined }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects negative totalScore with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ totalScore: -100 }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
    expect((resData.body as { error: string }).error).toMatch(/totalScore/);
  });

  it("rejects totalScore above the cap with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ totalScore: 1_000_000 }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects non-numeric totalScore with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ totalScore: "high" }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects missing roundData with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: undefined }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects non-array roundData with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: { foo: "bar" } }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects empty roundData with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: [] }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects roundData with >20 entries with 400", () => {
    const handler = getHandler("post", "/");
    const rounds = Array.from({ length: 21 }, (_, i) => ({
      roundNumber: i + 1,
      score: 100,
      products: [{ title: "p", imageUrl: "https://e.co/i.jpg", priceCents: 100 }],
    }));
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: rounds }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects a round missing the products array with 400", () => {
    const handler = getHandler("post", "/");
    const rounds = [
      { roundNumber: 1, score: 500 }, // no products
    ];
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: rounds }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
    expect((resData.body as { error: string }).error).toMatch(/products/);
  });

  it("rejects a round with non-numeric score with 400", () => {
    const handler = getHandler("post", "/");
    const rounds = [
      {
        roundNumber: 1,
        score: "high",
        products: [{ title: "p", imageUrl: "https://e.co/i.jpg", priceCents: 100 }],
      },
    ];
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: rounds }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects a product missing required string fields with 400", () => {
    const handler = getHandler("post", "/");
    const rounds = [
      {
        roundNumber: 1,
        score: 500,
        products: [{ title: 123, imageUrl: "https://e.co/i.jpg", priceCents: 100 }],
      },
    ];
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: rounds }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("rejects roundData exceeding the 16KB serialized cap with 400", () => {
    const handler = getHandler("post", "/");
    // Build a payload with a huge title that blows past 16KB when serialized.
    const huge = "x".repeat(2000);
    const rounds = Array.from({ length: 10 }, (_, i) => ({
      roundNumber: i + 1,
      score: 100,
      products: [
        { title: huge, imageUrl: "https://e.co/i.jpg", priceCents: 100 },
      ],
    }));
    const { req, res, resData } = createMockReqRes(validPayload({ roundData: rounds }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
    expect((resData.body as { error: string }).error).toMatch(/exceeds/);
  });

  it("rejects non-string playerName with 400", () => {
    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(validPayload({ playerName: 42 }));
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("links share to user_game_history via sessionId when authenticated", () => {
    // Seed user + history entry
    testDb.prepare(
      "INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("user-1", "alice", "alice", "a@example.com", "hash", "2026-01-01", "2026-01-01");
    testDb.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("user-1", "single", "classic", "sess-abc", 5000, new Date().toISOString());

    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(
      validPayload({ sessionId: "sess-abc" })
    );
    // Simulate authenticated user
    (req as Record<string, unknown>).user = { id: "user-1" };
    handler(req, res);

    expect(resData.statusCode).toBe(201);
    const shareId = (resData.body as { id: string }).id;

    const row = testDb.prepare(
      "SELECT share_id FROM user_game_history WHERE user_id = ? AND session_id = ?"
    ).get("user-1", "sess-abc") as { share_id: string | null } | undefined;
    expect(row?.share_id).toBe(shareId);
  });

  it("links share to the most recent user_game_history entry via roomCode", () => {
    // Seed user + two history entries for the same room (user played again)
    testDb.prepare(
      "INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("user-2", "bob", "bob", "b@example.com", "hash", "2026-01-01", "2026-01-01");
    testDb.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, room_code, score, played_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("user-2", "multiplayer", "classic", "ABCD", 3000, "2026-04-12T01:00:00Z");
    testDb.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, room_code, score, played_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("user-2", "multiplayer", "classic", "ABCD", 4000, "2026-04-12T02:00:00Z");

    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(
      validPayload({ roomCode: "ABCD" })
    );
    (req as Record<string, unknown>).user = { id: "user-2" };
    handler(req, res);

    expect(resData.statusCode).toBe(201);
    const shareId = (resData.body as { id: string }).id;

    // Only the most recent entry (score=4000) should be linked
    const rows = testDb.prepare(
      "SELECT score, share_id FROM user_game_history WHERE user_id = ? AND room_code = ? ORDER BY played_at"
    ).all("user-2", "ABCD") as Array<{ score: number; share_id: string | null }>;
    expect(rows[0].share_id).toBeNull(); // older entry untouched
    expect(rows[1].share_id).toBe(shareId); // newer entry linked
  });

  it("does not link history when unauthenticated", () => {
    testDb.prepare(
      "INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("user-3", "carol", "carol", "c@example.com", "hash", "2026-01-01", "2026-01-01");
    testDb.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("user-3", "single", "classic", "sess-xyz", 5000, new Date().toISOString());

    const handler = getHandler("post", "/");
    const { req, res, resData } = createMockReqRes(
      validPayload({ sessionId: "sess-xyz" })
    );
    // No req.user — guest
    handler(req, res);

    expect(resData.statusCode).toBe(201);
    const row = testDb.prepare(
      "SELECT share_id FROM user_game_history WHERE user_id = ? AND session_id = ?"
    ).get("user-3", "sess-xyz") as { share_id: string | null } | undefined;
    expect(row?.share_id).toBeNull();
  });
});

describe("GET /api/share/:id", () => {
  it("returns a previously-created share with parsed roundData", () => {
    const postHandler = getHandler("post", "/");
    const getHandlerFn = getHandler("get", "/:id");

    // Create a record.
    const created = createMockReqRes(validPayload({ playerName: "Alice" }));
    postHandler(created.req, created.res);
    const id = (created.resData.body as { id: string }).id;

    // Fetch it back.
    const { req, res, resData } = createMockReqRes({}, { id });
    getHandlerFn(req, res);

    expect(resData.statusCode).toBeUndefined(); // 200 default
    const body = resData.body as {
      id: string;
      gameMode: string;
      totalScore: number;
      perRoundMax: number;
      playerName: string | null;
      roundData: Array<{ roundNumber: number; score: number }>;
      createdAt: number;
    };
    expect(body.id).toBe(id);
    expect(body.gameMode).toBe("classic");
    expect(body.totalScore).toBe(10000);
    expect(body.perRoundMax).toBe(1000);
    expect(body.playerName).toBe("Alice");
    expect(Array.isArray(body.roundData)).toBe(true);
    expect(body.roundData.length).toBe(10);
    expect(body.roundData[0].roundNumber).toBe(1);
    expect(body.roundData[0].score).toBe(1000);
    expect(typeof body.createdAt).toBe("number");
  });

  it("returns 404 when the share does not exist", () => {
    const handler = getHandler("get", "/:id");
    const { req, res, resData } = createMockReqRes({}, { id: "abc12345" });
    handler(req, res);
    expect(resData.statusCode).toBe(404);
    expect((resData.body as { error: string }).error).toMatch(/not found/i);
  });

  it("returns 400 for a malformed id (wrong length)", () => {
    const handler = getHandler("get", "/:id");
    const { req, res, resData } = createMockReqRes({}, { id: "short" });
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("returns 400 for a malformed id (invalid characters)", () => {
    const handler = getHandler("get", "/:id");
    const { req, res, resData } = createMockReqRes({}, { id: "abc!@#$%" });
    handler(req, res);
    expect(resData.statusCode).toBe(400);
  });

  it("returns 500 when stored roundData is corrupt JSON", () => {
    // Insert a row with invalid JSON directly.
    testDb
      .prepare(
        `INSERT INTO shared_games (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
         VALUES (?, 'classic', 1000, 1000, NULL, 'not-valid-json', 1712000000)`
      )
      .run("corrupt1");

    const handler = getHandler("get", "/:id");
    const { req, res, resData } = createMockReqRes({}, { id: "corrupt1" });
    handler(req, res);
    expect(resData.statusCode).toBe(500);
  });
});
