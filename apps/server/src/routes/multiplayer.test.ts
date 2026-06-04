import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as any };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

// Import dependencies that also use the mocked db
const { createRoom } = await import("../services/roomManager");
const { default: router } = await import("./multiplayer");

function createMockReqRes(params: Record<string, string> = {}, query: Record<string, string> = {}) {
  const req = { params, query } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) { resData.body = data; return res; },
    status(code: number) { resData.statusCode = code; return res; },
  } as any;
  return { req, res, resData };
}

function createMockReqResBody(body: Record<string, unknown> = {}) {
  const req = { body } as any;
  const resData: { statusCode?: number; body?: any } = {};
  const res = {
    json(data: any) { resData.body = data; return res; },
    status(code: number) { resData.statusCode = code; return res; },
  } as any;
  return { req, res, resData };
}

describe("GET /api/mp/room/:code", () => {
  it("returns room data for a valid code", async () => {
    const { room } = await createRoom("Host");
    const handler = (router as any).stack.find((r: any) => r.route?.path === "/room/:code")?.route?.stack[0]?.handle;
    expect(handler).toBeDefined();

    const { req, res, resData } = createMockReqRes({ code: room.code });
    handler(req, res);

    expect(resData.body).toBeDefined();
    expect(resData.body.code).toBe(room.code);
    expect(resData.body.players).toHaveLength(1);
  });

  it("returns 404 for non-existent room", () => {
    const handler = (router as any).stack.find((r: any) => r.route?.path === "/room/:code")?.route?.stack[0]?.handle;
    const { req, res, resData } = createMockReqRes({ code: "INVALID" });
    handler(req, res);

    expect(resData.statusCode).toBe(404);
    expect(resData.body.error).toBe("Room not found");
  });
});

describe("GET /api/mp/leaderboard", () => {
  it("returns empty leaderboard when no entries", () => {
    const handler = (router as any).stack.find((r: any) => r.route?.path === "/leaderboard")?.route?.stack[0]?.handle;
    const { req, res, resData } = createMockReqRes({}, {});
    handler(req, res);

    expect(resData.body).toBeDefined();
    expect(resData.body.entries).toHaveLength(0);
  });

  it("returns leaderboard entries sorted by score", () => {
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("Alice", "R1", 5000, 1, 2, "classic", now);
    testDb.prepare(
      "INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("Bob", "R1", 3000, 2, 2, "classic", now);

    const handler = (router as any).stack.find((r: any) => r.route?.path === "/leaderboard")?.route?.stack[0]?.handle;
    const { req, res, resData } = createMockReqRes({}, {});
    handler(req, res);

    expect(resData.body.entries).toHaveLength(2);
    expect(resData.body.entries[0].score).toBe(5000);
    expect(resData.body.entries[0].playerName).toBe("Alice");
  });

  it("filters by game mode", () => {
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("Alice", "R1", 5000, 1, 2, "classic", now);
    testDb.prepare(
      "INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("Bob", "R2", 8000, 1, 2, "riser", now);

    const handler = (router as any).stack.find((r: any) => r.route?.path === "/leaderboard")?.route?.stack[0]?.handle;
    const { req, res, resData } = createMockReqRes({}, { mode: "riser" });
    handler(req, res);

    expect(resData.body.entries).toHaveLength(1);
    expect(resData.body.entries[0].gameMode).toBe("riser");
  });
});

describe("POST /api/mp/quickplay", () => {
  function getHandler() {
    // The route now has `optionalUser` middleware in front of the handler,
    // so .stack may contain multiple entries — the last one is always the
    // actual request handler.
    const stack = (router as any).stack.find((r: any) => r.route?.path === "/quickplay")?.route?.stack;
    return stack?.[stack.length - 1]?.handle;
  }

  /**
   * Seed a public lobby room that's eligible to match via quickplay:
   * status=lobby, is_public=1, with at least one non-bot connected player.
   */
  function seedPublicLobby(code: string, gameMode: string, totalRounds: number) {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, is_public, total_rounds, created_at, last_activity_at)
         VALUES (?, 'host-' || ?, ?, 'lobby', 1, ?, ?, ?)`,
      )
      .run(code, code, gameMode, totalRounds, now, now);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_bot, connected, is_kicked, total_score, joined_at)
         VALUES (?, ?, 'Host', 'wizard', ?, 0, 1, 0, 0, ?)`,
      )
      .run(`host-${code}`, code, `tok-${code}`, now);
  }

  it("returns { action: 'create' } when no lobby is available", () => {
    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({ gameMode: "classic" });
    handler(req, res);

    expect(resData.body).toEqual({ action: "create" });
  });

  it("matches by game mode and returns { action: 'join', roomCode }", () => {
    seedPublicLobby("LOBBY1", "classic", 5);

    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({ gameMode: "classic" });
    handler(req, res);

    expect(resData.body).toEqual({ action: "join", roomCode: "LOBBY1" });
  });

  it("filters by totalRounds when specified", () => {
    seedPublicLobby("R3", "classic", 3);
    seedPublicLobby("R5", "classic", 5);
    seedPublicLobby("R10", "classic", 10);

    const handler = getHandler();

    for (const rounds of [3, 5, 10]) {
      const { req, res, resData } = createMockReqResBody({
        gameMode: "classic",
        totalRounds: rounds,
      });
      handler(req, res);
      expect(resData.body.action).toBe("join");
      expect(resData.body.roomCode).toBe(`R${rounds}`);
    }
  });

  it("treats invalid totalRounds (2, 7, 'abc', 10.5) as 'no preference'", () => {
    seedPublicLobby("ANY", "classic", 5);
    const handler = getHandler();

    for (const invalid of [2, 7, "abc", 10.5, null, undefined]) {
      const { req, res, resData } = createMockReqResBody({
        gameMode: "classic",
        totalRounds: invalid,
      });
      handler(req, res);
      expect(resData.body).toEqual({ action: "join", roomCode: "ANY" });
    }
  });

  it("returns { action: 'create' } when totalRounds filter matches no lobby", () => {
    seedPublicLobby("ONLY5", "classic", 5);

    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({
      gameMode: "classic",
      totalRounds: 10,
    });
    handler(req, res);

    expect(resData.body).toEqual({ action: "create" });
  });

  it("matches any mode when gameMode is omitted", () => {
    seedPublicLobby("ANY", "market-basket", 5);

    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({});
    handler(req, res);

    expect(resData.body).toEqual({ action: "join", roomCode: "ANY" });
  });

  it("rejects invalid gameMode with 400", () => {
    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({
      gameMode: "not-a-real-mode",
    });
    handler(req, res);

    expect(resData.statusCode).toBe(400);
    expect(resData.body.error).toBe("Invalid game mode");
  });

  it("does not match rooms that have only bot players", () => {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, is_public, total_rounds, created_at, last_activity_at)
         VALUES ('BOTS', 'bot-host', 'classic', 'lobby', 1, 5, ?, ?)`,
      )
      .run(now, now);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_bot, connected, is_kicked, total_score, joined_at)
         VALUES ('bot-host', 'BOTS', 'Bot', 'wizard', 'tok-bots', 1, 1, 0, 0, ?)`,
      )
      .run(now);

    const handler = getHandler();
    const { req, res, resData } = createMockReqResBody({ gameMode: "classic" });
    handler(req, res);

    expect(resData.body).toEqual({ action: "create" });
  });

  it("handles an empty request body gracefully", () => {
    const handler = getHandler();
    const req = { body: undefined } as any;
    const resData: { statusCode?: number; body?: any } = {};
    const res = {
      json(data: any) { resData.body = data; return res; },
      status(code: number) { resData.statusCode = code; return res; },
    } as any;

    handler(req, res);
    expect(resData.body).toEqual({ action: "create" });
  });

  describe("daily-challenge quickplay", () => {
    /** Seed a daily-tagged public lobby eligible to match via daily quickplay. */
    function seedDailyLobby(code: string, gameMode: string, dailyDate: string) {
      const now = new Date().toISOString();
      testDb
        .prepare(
          `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, is_public, total_rounds, created_at, last_activity_at, is_daily_game, daily_date)
           VALUES (?, 'host-' || ?, ?, 'lobby', 1, 5, ?, ?, 1, ?)`,
        )
        .run(code, code, gameMode, now, now, dailyDate);
      testDb
        .prepare(
          `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_bot, connected, is_kicked, total_score, joined_at)
           VALUES (?, ?, 'Host', 'wizard', ?, 0, 1, 0, 0, ?)`,
        )
        .run(`host-${code}`, code, `tok-${code}`, now);
    }

    function enableDaily() {
      testDb
        .prepare(
          "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES ('daily_enabled', 'true', ?)",
        )
        .run(new Date().toISOString());
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    it("404 when daily is disabled", () => {
      // daily_enabled defaults to false in a fresh test db
      const handler = getHandler();
      const { req, res, resData } = createMockReqResBody({
        gameMode: "bidding",
        isDailyGame: true,
        dailyDate: today,
      });
      handler(req, res);
      expect(resData.statusCode).toBe(404);
      expect(resData.body.error).toBe("daily_disabled");
    });

    it("400 when daily date is malformed", () => {
      enableDaily();
      const handler = getHandler();
      const { req, res, resData } = createMockReqResBody({
        gameMode: "bidding",
        isDailyGame: true,
        dailyDate: "not-a-date",
      });
      handler(req, res);
      expect(resData.statusCode).toBe(400);
      expect(resData.body.error).toBe("invalid_daily_date");
    });

    it("400 when daily date is not today's UTC date (past/future)", () => {
      enableDaily();
      const handler = getHandler();
      const { req, res, resData } = createMockReqResBody({
        gameMode: "bidding",
        isDailyGame: true,
        dailyDate: yesterday,
      });
      handler(req, res);
      expect(resData.statusCode).toBe(400);
      expect(resData.body.error).toBe("invalid_daily_date");
    });

    it("409 when the visitor has already played today's daily", () => {
      enableDaily();
      const now = new Date().toISOString();
      testDb
        .prepare(
          `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, visitor_id)
           VALUES (NULL, 'sess-prev', ?, 'bidding', 0, ?, 'visitor-42')`,
        )
        .run(today, now);

      const handler = getHandler();
      const req = {
        body: { gameMode: "bidding", isDailyGame: true, dailyDate: today },
        visitorId: "visitor-42",
      } as any;
      const resData: { statusCode?: number; body?: any } = {};
      const res = {
        json(data: any) { resData.body = data; return res; },
        status(code: number) { resData.statusCode = code; return res; },
      } as any;
      handler(req, res);
      expect(resData.statusCode).toBe(409);
      expect(resData.body.error).toBe("already_played");
      expect(resData.body.date).toBe(today);
    });

    it("matches only same-date daily rooms when isDailyGame=true", () => {
      enableDaily();
      // Non-daily bidding lobby — must be ignored
      const now = new Date().toISOString();
      testDb
        .prepare(
          `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, is_public, total_rounds, created_at, last_activity_at, is_daily_game, daily_date)
           VALUES ('REG', 'host-REG', 'bidding', 'lobby', 1, 5, ?, ?, 0, NULL)`,
        )
        .run(now, now);
      testDb
        .prepare(
          `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_bot, connected, is_kicked, total_score, joined_at)
           VALUES ('host-REG', 'REG', 'Host', 'wizard', 'tok-REG', 0, 1, 0, 0, ?)`,
        )
        .run(now);
      // Daily lobby for a different date — also must be ignored (seeded even
      // though the route no longer accepts non-today dates, as a belt-and-
      // suspenders check on the SQL filter).
      seedDailyLobby("DAILY-YESTERDAY", "bidding", yesterday);
      // The one we should actually match
      seedDailyLobby("DAILY-TODAY", "bidding", today);

      const handler = getHandler();
      const { req, res, resData } = createMockReqResBody({
        gameMode: "bidding",
        isDailyGame: true,
        dailyDate: today,
      });
      handler(req, res);
      expect(resData.body).toEqual({ action: "join", roomCode: "DAILY-TODAY" });
    });

    it("non-daily quickplay excludes daily rooms", () => {
      enableDaily();
      // Only a daily room is available
      seedDailyLobby("DAILY-ONLY", "bidding", today);

      const handler = getHandler();
      const { req, res, resData } = createMockReqResBody({ gameMode: "bidding" });
      handler(req, res);
      // Non-daily matchmaking must not pull the daily-tagged room
      expect(resData.body).toEqual({ action: "create" });
    });
  });
});

describe("GET /api/mp/lobbies", () => {
  function getHandler() {
    return (router as any).stack.find((r: any) => r.route?.path === "/lobbies")?.route?.stack[0]?.handle;
  }

  // Seat a player row directly so each test can mix real humans, labeled
  // bots, and disguised ghosts (is_bot=1, is_disguised=1) — the disguise
  // flag is the bit we're verifying against.
  function seatPlayer(
    roomCode: string,
    id: string,
    name: string,
    opts: { isBot?: 0 | 1; isDisguised?: 0 | 1; connected?: 0 | 1; isHost?: 0 | 1 } = {},
  ) {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_players
           (id, room_code, display_name, avatar, token, is_host, is_kicked,
            total_score, connected, joined_at, is_bot, is_disguised)
         VALUES (?, ?, ?, 'wizard', ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id, roomCode, name, `tok-${id}`,
        opts.isHost ?? 0, opts.connected ?? 1, now,
        opts.isBot ?? 0, opts.isDisguised ?? 0,
      );
  }

  function seedRoom(code: string, opts: { isAutoLobby?: 0 | 1; botCount?: number; hostId: string }) {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms
           (code, host_player_id, game_mode, status, is_public, total_rounds,
            created_at, last_activity_at, bot_count, is_auto_lobby)
         VALUES (?, ?, 'classic', 'lobby', 1, 5, ?, ?, ?, ?)`,
      )
      .run(code, opts.hostId, now, now, opts.botCount ?? 0, opts.isAutoLobby ?? 0);
  }

  it("counts disguised ghosts (is_bot=1, is_disguised=1) as humans, not bots", () => {
    // Auto-lobby with one labeled bot + two disguised ghosts. Wire payload
    // hides the disguise (isBot=false), so humanCount must include them or
    // the public browser leaks the disguise via "1/8 +3 🤖".
    seedRoom("AUTO1", { hostId: "ghost-host", botCount: 1, isAutoLobby: 1 });
    seatPlayer("AUTO1", "ghost-host", "ChattyKathy",
      { isBot: 1, isDisguised: 1, isHost: 1 });
    seatPlayer("AUTO1", "ghost-2", "BargainBob", { isBot: 1, isDisguised: 1 });
    seatPlayer("AUTO1", "labeled-bot", "Bot Alpha", { isBot: 1, isDisguised: 0 });

    const handler = getHandler();
    const { req, res, resData } = createMockReqRes({}, {});
    handler(req, res);

    expect(resData.body.lobbies).toHaveLength(1);
    const lobby = resData.body.lobbies[0];
    expect(lobby.code).toBe("AUTO1");
    expect(lobby.humanCount).toBe(2); // two disguised ghosts
    expect(lobby.botCount).toBe(1); // labeled bot only
    expect(lobby.playerCount).toBe(3);
  });

  it("counts real humans alongside disguised ghosts in humanCount", () => {
    // User-created public room (not auto-lobby) seeded with one real human
    // host plus a disguised ghost. Both should appear under humanCount.
    seedRoom("MIX1", { hostId: "human-host", botCount: 0, isAutoLobby: 0 });
    seatPlayer("MIX1", "human-host", "Alice", { isBot: 0, isDisguised: 0, isHost: 1 });
    seatPlayer("MIX1", "ghost-1", "BargainBob", { isBot: 1, isDisguised: 1 });

    const handler = getHandler();
    const { req, res, resData } = createMockReqRes({}, {});
    handler(req, res);

    expect(resData.body.lobbies).toHaveLength(1);
    expect(resData.body.lobbies[0].humanCount).toBe(2);
    expect(resData.body.lobbies[0].botCount).toBe(0);
  });

  it("excludes labeled bots (is_bot=1, is_disguised=0) from humanCount", () => {
    // Standard human + bots room: humanCount sees only the human, room.bot_count
    // tracks the labeled bots.
    seedRoom("BOTROOM", { hostId: "human-host", botCount: 2, isAutoLobby: 0 });
    seatPlayer("BOTROOM", "human-host", "Alice", { isBot: 0, isDisguised: 0, isHost: 1 });
    seatPlayer("BOTROOM", "bot-1", "Bot Alpha", { isBot: 1, isDisguised: 0 });
    seatPlayer("BOTROOM", "bot-2", "Bot Bravo", { isBot: 1, isDisguised: 0 });

    const handler = getHandler();
    const { req, res, resData } = createMockReqRes({}, {});
    handler(req, res);

    expect(resData.body.lobbies).toHaveLength(1);
    expect(resData.body.lobbies[0].humanCount).toBe(1);
    expect(resData.body.lobbies[0].botCount).toBe(2);
  });
});
