import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));
vi.mock("./mpTimerState", () => ({
  hasRoundEnded: vi.fn().mockReturnValue(false),
  setRoundEnded: vi.fn(),
  clearRoundTimer: vi.fn(),
}));
vi.mock("./mpRoundStart", () => ({
  getActivePlayers: vi.fn(),
}));
vi.mock("./inputSanitizer", () => ({
  sanitizeName: vi.fn((name: string) => name),
}));
vi.mock("./userGameHistory", () => ({
  recordMultiplayerGame: vi.fn(),
}));

beforeEach(async () => {
  testDb = createTestDb();
  const dbMod = await import("../db");
  (dbMod as any).default = testDb;

  const timerState = (await import("./mpTimerState")) as any;
  timerState.hasRoundEnded.mockReturnValue(false);

  const mpRoundStart = (await import("./mpRoundStart")) as any;
  mpRoundStart.getActivePlayers.mockImplementation((code: string) => {
    return testDb
      .prepare(
        "SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0"
      )
      .all(code);
  });
});

const { endRound } = await import("./mpRoundEnd");

/** Product IDs seeded once per test via beforeEach (re-created DB each time). */
let productIds: number[];

beforeEach(() => {
  seedProducts(testDb, 10);
  productIds = (
    testDb.prepare("SELECT id FROM products ORDER BY id").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupGame(opts: {
  mode?: string;
  round?: number;
  totalRounds?: number;
  productIds: number[];
  roundData?: any;
  players?: {
    id: string;
    name: string;
    score?: number;
    userId?: string;
  }[];
}) {
  const now = new Date().toISOString();
  const mode = opts.mode || "classic";
  const round = opts.round || 1;
  const totalRounds = opts.totalRounds || 10;

  testDb
    .prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at)
     VALUES ('ROOM', 'p1', ?, 'playing', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      mode,
      round,
      totalRounds,
      JSON.stringify(opts.productIds),
      opts.roundData ? JSON.stringify(opts.roundData) : null,
      now,
      now
    );

  const players = opts.players || [{ id: "p1", name: "Player1" }];
  for (const p of players) {
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id)
       VALUES (?, 'ROOM', ?, 'wizard', ?, ?, ?, ?, ?)`
      )
      .run(
        p.id,
        p.name,
        `tok-${p.id}`,
        p.id === "p1" ? 1 : 0,
        p.score || 0,
        now,
        p.userId || null
      );
  }
}

function insertGuess(
  playerId: string,
  round: number,
  score: number,
  guessData: string = "{}",
  roomCode: string = "ROOM",
) {
  testDb
    .prepare(
      "INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(roomCode, playerId, round, guessData, score, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("endRound", () => {
  it("classic mode: returns reveal data with product and price, player results sorted by score", () => {
    setupGame({
      mode: "classic",
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice" },
        { id: "p2", name: "Bob" },
      ],
    });
    insertGuess("p1", 1, 800);
    insertGuess("p2", 1, 1200);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    expect(result!.gameMode).toBe("classic");
    expect(result!.revealData.mode).toBe("classic");
    const reveal = result!.revealData as { mode: "classic"; product: any };
    expect(reveal.product).toBeDefined();
    expect(reveal.product.priceCents).toBeGreaterThan(0);
    // Sorted descending by score
    expect(result!.playerResults[0].score).toBeGreaterThanOrEqual(
      result!.playerResults[1].score
    );
  });

  it("comparison mode: returns products, question, correctProductId", () => {
    const ids = productIds.slice(0, 3);
    setupGame({
      mode: "comparison",
      productIds: ids,
      roundData: { "1": { question: "most-expensive" } },
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "comparison";
      products: any[];
      question: string;
      correctProductId: number;
    };
    expect(reveal.mode).toBe("comparison");
    expect(reveal.products.length).toBe(3);
    expect(reveal.question).toBe("most-expensive");
    expect(typeof reveal.correctProductId).toBe("number");
  });

  it("higher-lower mode: returns product and referencePrice", () => {
    setupGame({
      mode: "higher-lower",
      productIds: [productIds[0]],
      roundData: { "1": { referencePrice: 999 } },
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "higher-lower";
      product: any;
      referencePrice: number;
    };
    expect(reveal.mode).toBe("higher-lower");
    expect(reveal.product).toBeDefined();
    expect(reveal.referencePrice).toBe(999);
  });

  it("price-match mode: returns products", () => {
    const ids = productIds.slice(0, 4);
    setupGame({
      mode: "price-match",
      productIds: ids,
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 300);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "price-match";
      products: any[];
    };
    expect(reveal.mode).toBe("price-match");
    expect(reveal.products.length).toBe(4);
  });

  it("odd-one-out mode: returns products and outlierProductId", () => {
    const ids = productIds.slice(0, 4);
    setupGame({
      mode: "odd-one-out",
      productIds: ids,
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 400);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "odd-one-out";
      products: any[];
      outlierProductId: number;
    };
    expect(reveal.mode).toBe("odd-one-out");
    expect(reveal.products.length).toBe(4);
    expect(typeof reveal.outlierProductId).toBe("number");
  });

  it("market-basket mode: returns products and actualTotalCents", () => {
    const ids = productIds.slice(0, 3);
    setupGame({
      mode: "market-basket",
      productIds: ids,
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 600);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "market-basket";
      products: any[];
      actualTotalCents: number;
    };
    expect(reveal.mode).toBe("market-basket");
    expect(reveal.products.length).toBe(3);
    expect(reveal.actualTotalCents).toBeGreaterThan(0);
  });

  it("sort-it-out mode: returns products and correctOrder", () => {
    const ids = productIds.slice(0, 4);
    setupGame({
      mode: "sort-it-out",
      productIds: ids,
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 700);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "sort-it-out";
      products: any[];
      correctOrder: number[];
    };
    expect(reveal.mode).toBe("sort-it-out");
    expect(reveal.products.length).toBe(4);
    expect(Array.isArray(reveal.correctOrder)).toBe(true);
    expect(reveal.correctOrder.length).toBe(4);
  });

  it("budget-builder mode: returns products and budgetCents", () => {
    const ids = productIds.slice(0, 5);
    setupGame({
      mode: "budget-builder",
      productIds: ids,
      roundData: { "1": { budgetCents: 50000 } },
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "budget-builder";
      products: any[];
      budgetCents: number;
    };
    expect(reveal.mode).toBe("budget-builder");
    expect(reveal.products.length).toBe(5);
    expect(reveal.budgetCents).toBe(50000);
  });

  it("chain-reaction mode: returns products", () => {
    const ids = productIds.slice(0, 3);
    setupGame({
      mode: "chain-reaction",
      productIds: ids,
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 400);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "chain-reaction";
      products: any[];
    };
    expect(reveal.mode).toBe("chain-reaction");
    expect(reveal.products.length).toBe(3);
  });

  it("riser mode: returns product and maxPriceCents", () => {
    setupGame({
      mode: "riser",
      productIds: [productIds[0]],
      roundData: { "1": { maxPriceCents: 75000 } },
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "riser";
      product: any;
      maxPriceCents: number;
    };
    expect(reveal.mode).toBe("riser");
    expect(reveal.product).toBeDefined();
    expect(reveal.maxPriceCents).toBe(75000);
  });

  it("closest-without-going-over mode: returns product", () => {
    setupGame({
      mode: "closest-without-going-over",
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    const reveal = result!.revealData as {
      mode: "closest-without-going-over";
      product: any;
    };
    expect(reveal.mode).toBe("closest-without-going-over");
    expect(reveal.product).toBeDefined();
    expect(reveal.product.priceCents).toBeGreaterThan(0);
  });

  it("inserts score=0 for players who did not guess", () => {
    setupGame({
      mode: "classic",
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice" },
        { id: "p2", name: "Bob" },
      ],
    });
    // Only p1 guesses; p2 does not
    insertGuess("p1", 1, 1000);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();
    // Both players should appear in results
    expect(result!.playerResults.length).toBe(2);
    const bob = result!.playerResults.find((r) => r.playerId === "p2");
    expect(bob).toBeDefined();
    expect(bob!.score).toBe(0);

    // Verify the guess row was inserted in the DB
    const dbGuess = testDb
      .prepare(
        "SELECT * FROM mp_guesses WHERE room_code = 'ROOM' AND player_id = 'p2' AND round_number = 1"
      )
      .get() as any;
    expect(dbGuess).toBeDefined();
    expect(dbGuess.score).toBe(0);
  });

  it("returns null when hasRoundEnded is true (double-end prevention)", async () => {
    setupGame({
      mode: "classic",
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 1, 500);

    const timerState = (await import("./mpTimerState")) as any;
    timerState.hasRoundEnded.mockReturnValue(true);

    const result = endRound("ROOM");
    expect(result).toBeNull();
  });

  it("returns null when room status is not 'playing'", () => {
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, created_at, last_activity_at)
       VALUES ('ROOM', 'p1', 'classic', 'lobby', 1, 10, ?, ?, ?)`
      )
      .run(JSON.stringify([productIds[0]]), now, now);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at)
       VALUES ('p1', 'ROOM', 'Alice', 'wizard', 'tok-p1', 1, 0, ?)`
      )
      .run(now);

    const result = endRound("ROOM");
    expect(result).toBeNull();
  });

  it("saves to leaderboard on final round", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 5000 },
        { id: "p2", name: "Bob", score: 3000 },
      ],
    });
    insertGuess("p1", 10, 800);
    insertGuess("p2", 10, 400);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();

    // Room should be finished
    const room = testDb
      .prepare("SELECT status FROM mp_rooms WHERE code = 'ROOM'")
      .get() as any;
    expect(room.status).toBe("finished");

    // Leaderboard entries should exist
    const entries = testDb
      .prepare(
        "SELECT * FROM mp_leaderboard WHERE room_code = 'ROOM' ORDER BY placement"
      )
      .all() as any[];
    expect(entries.length).toBe(2);
    expect(entries[0].placement).toBe(1);
    expect(entries[1].placement).toBe(2);
    expect(entries[0].game_mode).toBe("classic");
  });

  it("sets status to 'between_rounds' when not final round", () => {
    setupGame({
      mode: "classic",
      round: 3,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Alice" }],
    });
    insertGuess("p1", 3, 500);

    const result = endRound("ROOM");

    expect(result).not.toBeNull();

    const room = testDb
      .prepare("SELECT status FROM mp_rooms WHERE code = 'ROOM'")
      .get() as any;
    expect(room.status).toBe("between_rounds");
  });

  it("excludes streamer-bot seat from mp_leaderboard, recordMultiplayerGame, and placement count", async () => {
    const userId = seedUser(testDb, "alice", "alice@example.com");
    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 4000, userId },
        { id: "p_bot", name: "Pricey", score: 5500 },
      ],
    });
    // Mark p_bot as the streamer-bot seat. is_bot stays 0 — the bot drives
    // its own moves like a real client, only analytics/leaderboard skip it.
    testDb.prepare("UPDATE mp_players SET is_streamer_bot = 1 WHERE id = ?").run("p_bot");
    insertGuess("p1", 5, 1000);
    insertGuess("p_bot", 5, 1500);

    const userGameHistory = (await import("./userGameHistory")) as any;
    userGameHistory.recordMultiplayerGame.mockClear();

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    // mp_leaderboard receives only Alice — streamer-bot is dropped before the insert.
    const lbEntries = testDb
      .prepare("SELECT * FROM mp_leaderboard WHERE room_code = 'ROOM' ORDER BY placement")
      .all() as { player_name: string; placement: number; players_count: number }[];
    expect(lbEntries).toHaveLength(1);
    expect(lbEntries[0].player_name).toBe("Alice");
    // Placement reflects only the credited (non-skipped) standings.
    expect(lbEntries[0].placement).toBe(1);
    expect(lbEntries[0].players_count).toBe(1);

    // user_game_history was written exactly once, for Alice.
    expect(userGameHistory.recordMultiplayerGame).toHaveBeenCalledTimes(1);
    expect(userGameHistory.recordMultiplayerGame.mock.calls[0][1]).toBe(userId);
  });

  it("bumps streamer-bot W/L for an MP win, leaving leaderboard untouched and human in solo-anti-farm", async () => {
    // 1 human + 1 streamer-bot: bot beats the human. Cross-cuts both
    // the bot's W/L credit and the human's existing solo-room
    // anti-farm rule — `recordMultiplayerGame` should be called with
    // `playersCount = 1` (humans+ghosts only) so the human's outcome
    // resolves to `is_win = NULL`. The bot meanwhile sees
    // `playersCount = 2` (humans+ghosts+bot) and records its win.
    const userId = seedUser(testDb, "alice2", "alice2@example.com");
    const botVisitorId = "bot-visitor-mp-win";
    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 4000, userId },
        { id: "p_bot", name: "Pricey", score: 9000 },
      ],
    });
    testDb
      .prepare("UPDATE mp_players SET is_streamer_bot = 1, visitor_id = ? WHERE id = ?")
      .run(botVisitorId, "p_bot");
    insertGuess("p1", 5, 1000);
    insertGuess("p_bot", 5, 2000);

    const userGameHistory = (await import("./userGameHistory")) as any;
    userGameHistory.recordMultiplayerGame.mockClear();

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    // Leaderboard untouched by the bot — only Alice should be present.
    const lbEntries = testDb
      .prepare("SELECT player_name, players_count FROM mp_leaderboard WHERE room_code = 'ROOM'")
      .all() as { player_name: string; players_count: number }[];
    expect(lbEntries.map((r) => r.player_name)).toEqual(["Alice"]);
    // Human's `players_count = 1` so the solo-room anti-farm fires for her.
    expect(lbEntries[0].players_count).toBe(1);
    // recordMultiplayerGame was called with playersCount=1 (the human-only count)
    // — the helper resolves is_win=NULL on solo rooms, preserving PR #257 intent.
    expect(userGameHistory.recordMultiplayerGame).toHaveBeenCalledTimes(1);
    expect(userGameHistory.recordMultiplayerGame.mock.calls[0][1]).toBe(userId);
    expect(userGameHistory.recordMultiplayerGame.mock.calls[0][6]).toBe(1);

    const botRow = testDb
      .prepare(
        `SELECT utm_source, lifetime_wins, lifetime_losses, current_streak, best_win_streak,
                first_game_at, games_played
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(botVisitorId) as
      | {
          utm_source: string;
          lifetime_wins: number;
          lifetime_losses: number;
          current_streak: number;
          best_win_streak: number;
          first_game_at: string | null;
          games_played: number;
        }
      | undefined;
    expect(botRow).toBeDefined();
    // 'direct' sentinel — row was self-healed by the W/L writer.
    expect(botRow!.utm_source).toBe("direct");
    expect(botRow!.lifetime_wins).toBe(1);
    expect(botRow!.lifetime_losses).toBe(0);
    expect(botRow!.current_streak).toBe(1);
    expect(botRow!.best_win_streak).toBe(1);
    // Cohort fields stay frozen — the bot is not part of the funnel.
    expect(botRow!.first_game_at).toBeNull();
    expect(botRow!.games_played).toBe(0);
  });

  it("counts a streamer-bot tie at the top as a win", async () => {
    // Tie-at-top: bot and top human have equal totalScore. The MP
    // classification rule treats placement 1 as a win for every tied
    // player (see `multiplayerWins` semantics); the bot's W/L pass
    // promotes a tied score to placement 1 explicitly so a stable-sort
    // accident does not demote the bot to placement 2.
    seedUser(testDb, "tie-alice", "tie-alice@example.com");
    const botVisitorId = "bot-visitor-mp-tie";
    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 7000 },
        { id: "p_bot", name: "Pricey", score: 7000 },
      ],
    });
    testDb
      .prepare("UPDATE mp_players SET is_streamer_bot = 1, visitor_id = ? WHERE id = ?")
      .run(botVisitorId, "p_bot");
    insertGuess("p1", 5, 1500);
    insertGuess("p_bot", 5, 1500);

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    const botRow = testDb
      .prepare(
        `SELECT lifetime_wins, lifetime_losses, current_streak
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(botVisitorId) as {
      lifetime_wins: number;
      lifetime_losses: number;
      current_streak: number;
    };
    expect(botRow.lifetime_wins).toBe(1);
    expect(botRow.lifetime_losses).toBe(0);
    expect(botRow.current_streak).toBe(1);
  });

  it("bumps streamer-bot W/L for an MP loss when a human places higher", async () => {
    seedUser(testDb, "alice3", "alice3@example.com");
    const botVisitorId = "bot-visitor-mp-loss";
    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 9000 },
        { id: "p_bot", name: "Pricey", score: 4000 },
      ],
    });
    testDb
      .prepare("UPDATE mp_players SET is_streamer_bot = 1, visitor_id = ? WHERE id = ?")
      .run(botVisitorId, "p_bot");
    insertGuess("p1", 5, 2000);
    insertGuess("p_bot", 5, 800);

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    const botRow = testDb
      .prepare(
        `SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(botVisitorId) as {
      lifetime_wins: number;
      lifetime_losses: number;
      current_streak: number;
      best_win_streak: number;
    };
    expect(botRow.lifetime_wins).toBe(0);
    expect(botRow.lifetime_losses).toBe(1);
    expect(botRow.current_streak).toBe(-1);
    expect(botRow.best_win_streak).toBe(0);
  });

  it("does NOT bump streamer-bot W/L in a solo-with-bot lobby (no real opponents)", async () => {
    // Bot alone with no humans/ghosts means `playersCount = 1` for the
    // classifier (anti-farm), so the outcome is null and the visitor row
    // stays at zeros. Mirrors the existing solo-room rule applied to
    // human seats.
    const botVisitorId = "bot-visitor-mp-solo";
    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [{ id: "p_bot", name: "Pricey", score: 9000 }],
    });
    testDb
      .prepare("UPDATE mp_players SET is_streamer_bot = 1, visitor_id = ? WHERE id = ?")
      .run(botVisitorId, "p_bot");
    insertGuess("p_bot", 5, 2000);

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    const botRow = testDb
      .prepare(
        `SELECT lifetime_wins, lifetime_losses, current_streak
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(botVisitorId) as
      | { lifetime_wins: number; lifetime_losses: number; current_streak: number }
      | undefined;
    // No row created (helper short-circuits on null outcome before insert).
    expect(botRow).toBeUndefined();
  });

  it("records user game history for authenticated players on final round", async () => {
    const userId = seedUser(testDb, "alice", "alice@example.com");

    setupGame({
      mode: "classic",
      round: 5,
      totalRounds: 5,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 4000, userId },
        { id: "p2", name: "Bob", score: 2000 },
      ],
    });
    insertGuess("p1", 5, 1000);
    insertGuess("p2", 5, 500);

    const userGameHistory = (await import("./userGameHistory")) as any;

    const result = endRound("ROOM");
    expect(result).not.toBeNull();

    // recordMultiplayerGame should have been called for the authenticated player
    expect(userGameHistory.recordMultiplayerGame).toHaveBeenCalled();
    const calls = userGameHistory.recordMultiplayerGame.mock.calls;
    const aliceCall = calls.find((c: any[]) => c[1] === userId);
    expect(aliceCall).toBeDefined();
    // Args: db, userId, roomCode, mode, score, placement, playersCount
    expect(aliceCall[2]).toBe("ROOM");
    expect(aliceCall[3]).toBe("classic");
  });

  describe("daily-challenge completion", () => {
    /** Set up a daily MP room (2 humans) so endRound will invoke recordDailyPlaysForRoom. */
    function setupDailyRoom(opts: {
      players: { id: string; name: string; userId?: string | null; visitorId?: string | null; score: number }[];
      dailyDate: string;
      totalRounds?: number;
    }) {
      const now = new Date().toISOString();
      const totalRounds = opts.totalRounds ?? 5;
      testDb
        .prepare(
          `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at, is_daily_game, daily_date)
           VALUES ('DROOM', ?, 'bidding', 'playing', ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          opts.players[0].id,
          totalRounds,
          totalRounds,
          JSON.stringify([productIds[0]]),
          JSON.stringify({ [String(totalRounds)]: { productIds: [productIds[0]], bids: [] } }),
          now,
          now,
          opts.dailyDate,
        );
      for (const p of opts.players) {
        testDb
          .prepare(
            `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id, visitor_id, is_bot)
             VALUES (?, 'DROOM', ?, 'wizard', ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(p.id, p.name, `tok-${p.id}`, p.id === opts.players[0].id ? 1 : 0, p.score, now, p.userId ?? null, p.visitorId ?? null);
      }
    }

    it("writes one daily_plays row per human player with unique session_id", () => {
      const userId = seedUser(testDb, "alice", "alice@example.com");
      setupDailyRoom({
        dailyDate: "2026-04-18",
        players: [
          { id: "p1", name: "Alice", userId, score: 4000 },
          { id: "p2", name: "Bob", visitorId: "visitor-bob", score: 3000 },
        ],
      });
      insertGuess("p1", 5, 1000, "{}", "DROOM");
      insertGuess("p2", 5, 500, "{}", "DROOM");

      const result = endRound("DROOM");
      expect(result).not.toBeNull();

      const rows = testDb
        .prepare("SELECT user_id, visitor_id, session_id, score, daily_date, game_mode FROM daily_plays ORDER BY user_id NULLS LAST")
        .all() as {
          user_id: string | null;
          visitor_id: string | null;
          session_id: string;
          score: number;
          daily_date: string;
          game_mode: string;
        }[];

      // Regression: both human players must land rows — before the fix, the
      // UNIQUE session_id constraint silently dropped the second insert.
      expect(rows).toHaveLength(2);
      const sessionIds = rows.map((r) => r.session_id);
      expect(new Set(sessionIds).size).toBe(2);
      expect(sessionIds.every((s) => s.startsWith("DROOM:"))).toBe(true);

      const alice = rows.find((r) => r.user_id === userId);
      const bob = rows.find((r) => r.visitor_id === "visitor-bob");
      expect(alice).toBeDefined();
      expect(alice!.score).toBe(4000);
      expect(alice!.daily_date).toBe("2026-04-18");
      expect(alice!.game_mode).toBe("bidding");
      expect(bob).toBeDefined();
      expect(bob!.score).toBe(3000);
    });

    it("bumps the streak only for the player whose daily_plays row actually landed", () => {
      // Pre-populate a daily_plays row for Alice today — the MP write will
      // collide on the (user_id, daily_date) partial unique index, so her
      // streak must NOT bump. Bob has no prior row and should land + bump.
      const aliceId = seedUser(testDb, "alice", "alice@example.com");
      const bobId = seedUser(testDb, "bob", "bob@example.com");
      const dailyDate = "2026-04-18";
      testDb
        .prepare(
          `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion)
           VALUES (?, 'sp-alice-prev', ?, 'bidding', 1234, '[]', ?, ?, 1)`,
        )
        .run(aliceId, dailyDate, new Date().toISOString(), new Date().toISOString());
      // Seed a matching streak row for Alice so "unchanged" is meaningful.
      testDb.prepare("UPDATE users SET daily_streak_current = 1, daily_streak_best = 1, daily_streak_last_date = ? WHERE id = ?").run(dailyDate, aliceId);

      setupDailyRoom({
        dailyDate,
        players: [
          { id: "p1", name: "Alice", userId: aliceId, score: 2000 },
          { id: "p2", name: "Bob", userId: bobId, score: 3000 },
        ],
      });
      insertGuess("p1", 5, 500, "{}", "DROOM");
      insertGuess("p2", 5, 1000, "{}", "DROOM");

      endRound("DROOM");

      const aliceStreak = testDb.prepare("SELECT daily_streak_current FROM users WHERE id = ?").get(aliceId) as { daily_streak_current: number };
      const bobStreak = testDb.prepare("SELECT daily_streak_current FROM users WHERE id = ?").get(bobId) as { daily_streak_current: number };
      // Alice's streak must be unchanged (her MP insert collided on the
      // partial unique index); Bob's must be bumped to 1.
      expect(aliceStreak.daily_streak_current).toBe(1);
      expect(bobStreak.daily_streak_current).toBe(1);

      // And Alice still has exactly one row for today (not two).
      const aliceRowCount = testDb
        .prepare("SELECT COUNT(*) as n FROM daily_plays WHERE user_id = ? AND daily_date = ?")
        .get(aliceId, dailyDate) as { n: number };
      expect(aliceRowCount.n).toBe(1);
    });

    it("skips bot and identity-less players", () => {
      const userId = seedUser(testDb, "carol", "carol@example.com");
      const now = new Date().toISOString();
      testDb
        .prepare(
          `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at, is_daily_game, daily_date)
           VALUES ('DROOM', 'p1', 'bidding', 'playing', 5, 5, ?, ?, ?, ?, 1, '2026-04-18')`,
        )
        .run(JSON.stringify([productIds[0]]), JSON.stringify({ "5": { productIds: [productIds[0]], bids: [] } }), now, now);
      // One bot, one anonymous no-visitor human, one real user
      testDb.prepare(`INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, is_bot) VALUES ('p1','DROOM','Carol','wizard','t1',1,4000,?,0)`).run(now);
      testDb.prepare(`UPDATE mp_players SET user_id = ? WHERE id = 'p1'`).run(userId);
      testDb.prepare(`INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, is_bot) VALUES ('p2','DROOM','BotBob','wizard','t2',0,3000,?,1)`).run(now);
      testDb.prepare(`INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, is_bot) VALUES ('p3','DROOM','Ghost','wizard','t3',0,2000,?,0)`).run(now);
      insertGuess("p1", 5, 1000, "{}", "DROOM");
      insertGuess("p2", 5, 500, "{}", "DROOM");
      insertGuess("p3", 5, 250, "{}", "DROOM");

      endRound("DROOM");

      const rows = testDb.prepare("SELECT user_id FROM daily_plays").all() as { user_id: string | null }[];
      // Only Carol — bot skipped by is_bot filter, Ghost skipped because no user_id and no visitor_id.
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userId);
    });
  });
});

describe("analytics: mp_game_completed emission", () => {
  // The completion-event invariant: one event per REAL human player, none
  // for bots, none for ghosts. The bucket classifier in saveToLeaderboard
  // already filters at the DB write layer; these tests pin down the
  // analytics emit stays in lockstep with that filter.
  it("emits exactly one mp_game_completed event per real human player", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 800 },
        { id: "p2", name: "Bob", score: 1200 },
      ],
    });
    // Both players have visitor_ids so events should fire
    testDb.prepare("UPDATE mp_players SET visitor_id = ? WHERE id = 'p1'").run("vis-alice");
    testDb.prepare("UPDATE mp_players SET visitor_id = ? WHERE id = 'p2'").run("vis-bob");
    insertGuess("p1", 10, 800);
    insertGuess("p2", 10, 1200);

    endRound("ROOM");

    const events = testDb
      .prepare(
        `SELECT visitor_id, properties FROM events
          WHERE event_name = 'mp_game_completed'
          ORDER BY visitor_id`,
      )
      .all() as Array<{ visitor_id: string; properties: string | null }>;
    expect(events).toHaveLength(2);
    const visitorIds = events.map((e) => e.visitor_id).sort();
    expect(visitorIds).toEqual(["vis-alice", "vis-bob"]);
    // Players_count reflects the real-player total — there are no bots/ghosts in this room.
    const props0 = JSON.parse(events[0].properties!);
    expect(props0.players_count).toBe(2);
    expect(props0.room_code).toBe("ROOM");
    expect(props0.game_mode).toBe("classic");
    expect(typeof props0.placement).toBe("number");
  });

  it("does NOT emit for bot players or for ghost players", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Real", score: 1000 },
        { id: "p2", name: "Bot", score: 500 },
        { id: "p3", name: "Ghost", score: 750 },
      ],
    });
    testDb.prepare("UPDATE mp_players SET visitor_id = 'vis-real' WHERE id = 'p1'").run();
    testDb.prepare("UPDATE mp_players SET is_bot = 1 WHERE id = 'p2'").run();
    // Ghosts: is_bot=1 + ghost_user_id present. Seed a ghost row first to
    // satisfy the FK declared in the production schema (mp_players.ghost_user_id
    // REFERENCES ghost_users(id)). Test schema may or may not enforce it but
    // we mirror production semantics either way.
    testDb.prepare(`
      CREATE TABLE IF NOT EXISTS ghost_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        avatar TEXT NOT NULL,
        lifetime_score INTEGER NOT NULL DEFAULT 0,
        account_created_at TEXT NOT NULL,
        on_shift INTEGER NOT NULL DEFAULT 0,
        shift_started_at TEXT,
        shift_ends_at TEXT,
        on_break_until TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_played_at TEXT,
        daily_streak_current INTEGER NOT NULL DEFAULT 0,
        daily_streak_best INTEGER NOT NULL DEFAULT 0,
        daily_streak_last_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO ghost_users (id, username, username_normalized, avatar, account_created_at, created_at, updated_at)
       VALUES ('g1', 'Ghost', 'ghost', 'wizard', ?, ?, ?)`,
    ).run(now, now, now);
    testDb.prepare("UPDATE mp_players SET is_bot = 1, ghost_user_id = 'g1' WHERE id = 'p3'").run();
    insertGuess("p1", 10, 1000);
    insertGuess("p2", 10, 500);
    insertGuess("p3", 10, 750);

    endRound("ROOM");

    const events = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'mp_game_completed'")
      .all() as Array<{ visitor_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].visitor_id).toBe("vis-real");
  });

  it("does NOT emit when the player has no visitor_id", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Anon", score: 500 }],
    });
    // No visitor_id update — the player is fully anonymous.
    insertGuess("p1", 10, 500);

    endRound("ROOM");

    const count = (
      testDb
        .prepare("SELECT COUNT(*) as c FROM events WHERE event_name = 'mp_game_completed'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});

describe("analytics: daily_completed emission (MP daily)", () => {
  // recordDailyPlaysForRoom runs from saveToLeaderboard's daily branch on the
  // final round. It must emit DAILY_COMPLETED only when the daily_plays
  // INSERT actually lands — a UNIQUE-collision (player already completed
  // today via the SP path) must NOT spawn a phantom event, otherwise v2's
  // daily-completion count drifts above truth.
  it("emits one daily_completed per real player when an MP daily room finishes", () => {
    const dailyDate = "2026-04-28";
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at, is_daily_game, daily_date)
         VALUES ('DROOM', 'p1', 'classic', 'playing', 5, 5, ?, ?, ?, ?, 1, ?)`,
      )
      .run(JSON.stringify([productIds[0]]), JSON.stringify({ "5": {} }), now, now, dailyDate);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES (?, 'DROOM', ?, 'wizard', ?, ?, ?, ?, ?)`,
      )
      .run("p1", "Alice", "t1", 1, 4500, now, "vis-alice");
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES (?, 'DROOM', ?, 'wizard', ?, ?, ?, ?, ?)`,
      )
      .run("p2", "Bob", "t2", 0, 3000, now, "vis-bob");
    insertGuess("p1", 5, 4500, "{}", "DROOM");
    insertGuess("p2", 5, 3000, "{}", "DROOM");

    endRound("DROOM");

    const events = testDb
      .prepare(
        "SELECT visitor_id, properties FROM events WHERE event_name = 'daily_completed' ORDER BY visitor_id",
      )
      .all() as Array<{ visitor_id: string; properties: string }>;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.visitor_id)).toEqual(["vis-alice", "vis-bob"]);
    const props = JSON.parse(events[0].properties);
    expect(props.daily_date).toBe(dailyDate);
    expect(props.via).toBe("multiplayer");
    expect(props.game_mode).toBe("classic");
  });

  it("suppresses daily_completed when the daily_plays insert hits a UNIQUE collision", async () => {
    const dailyDate = "2026-04-28";
    const userId = (await import("../test/dbHelper")).seedUser(testDb, "alice", "alice@test.com");
    // Pre-seed a daily_plays row for this user/date so the room's INSERT
    // collides on the partial unique index (user_id, daily_date).
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
         VALUES (?, 'sp-prior', ?, 'classic', 5000, ?, ?)`,
      )
      .run(userId, dailyDate, now, now);

    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at, is_daily_game, daily_date)
         VALUES ('DROOM2', 'p1', 'classic', 'playing', 5, 5, ?, ?, ?, ?, 1, ?)`,
      )
      .run(JSON.stringify([productIds[0]]), JSON.stringify({ "5": {} }), now, now, dailyDate);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id, visitor_id)
         VALUES (?, 'DROOM2', ?, 'wizard', ?, ?, ?, ?, ?, ?)`,
      )
      .run("p1", "Alice", "t1", 1, 4500, now, userId, "vis-alice-2");
    insertGuess("p1", 5, 4500, "{}", "DROOM2");

    endRound("DROOM2");

    // The MP-path daily_plays insert collides on UNIQUE(user_id, daily_date)
    // and is silently dropped — no phantom event should land.
    const events = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'daily_completed'")
      .all() as Array<{ visitor_id: string }>;
    expect(events).toHaveLength(0);
  });
});

describe("analytics: deterministic dedup keys (PR 6a)", () => {
  // Pin the dedup-key shape for mp_game_completed and verify that a
  // double-fire of the completion path produces exactly one row per
  // real player. The C3 status='ending' claim guards the DB write
  // path; the dedup key guards the post-commit analytics emit so a
  // duplicate caller of saveToLeaderboard (test-induced or otherwise)
  // can't double-count.

  it("mp_game_completed client_event_id scopes on (gameId, visitorId)", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Alice", score: 1000 }],
    });
    testDb.prepare("UPDATE mp_players SET visitor_id = 'vis-alice' WHERE id = 'p1'").run();
    testDb.prepare("UPDATE mp_rooms SET current_game_id = 'gid-X' WHERE code = 'ROOM'").run();
    insertGuess("p1", 10, 1000);

    endRound("ROOM");

    const row = testDb
      .prepare(
        "SELECT client_event_id, properties FROM events WHERE event_name = 'mp_game_completed'",
      )
      .get() as { client_event_id: string; properties: string };
    expect(row.client_event_id).toBe("srv:mp_game_completed:gid-X:vis-alice");
    expect(JSON.parse(row.properties).game_id).toBe("gid-X");
  });

  it("falls back to a legacy key (legacy:<created_at>) when current_game_id is NULL", () => {
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [{ id: "p1", name: "Alice", score: 1000 }],
    });
    testDb.prepare("UPDATE mp_players SET visitor_id = 'vis-alice' WHERE id = 'p1'").run();
    // current_game_id stays NULL — pre-v59 row simulation.
    insertGuess("p1", 10, 1000);

    endRound("ROOM");

    const row = testDb
      .prepare("SELECT client_event_id FROM events WHERE event_name = 'mp_game_completed'")
      .get() as { client_event_id: string };
    expect(row.client_event_id).toMatch(/^srv:mp_game_completed:legacy:.+:vis-alice$/);
  });

  it("idempotent: a double-fire of endRound produces exactly one mp_game_completed per real player", async () => {
    // The whole point of the dedup keys: if `endRound` somehow fires
    // twice for the same logical game (test-induced, retry-induced, or a
    // future bug past the C3 status='ending' DB claim), the second
    // emission must be absorbed by the events table's UNIQUE index. This
    // test forces the second fire by reverting the room status before
    // the second call so the C3 claim's WHERE clause re-matches.
    setupGame({
      mode: "classic",
      round: 10,
      totalRounds: 10,
      productIds: [productIds[0]],
      players: [
        { id: "p1", name: "Alice", score: 800 },
        { id: "p2", name: "Bob", score: 1200 },
      ],
    });
    testDb.prepare("UPDATE mp_players SET visitor_id = ? WHERE id = 'p1'").run("vis-alice");
    testDb.prepare("UPDATE mp_players SET visitor_id = ? WHERE id = 'p2'").run("vis-bob");
    testDb.prepare("UPDATE mp_rooms SET current_game_id = 'gid-IDEMPOTENT' WHERE code = 'ROOM'").run();
    insertGuess("p1", 10, 800);
    insertGuess("p2", 10, 1200);

    endRound("ROOM");
    // Reset state to allow a second endRound call to make it past the
    // C3 status='ending' claim AND past the per-room hasRoundEnded
    // guard (which is in-memory, mocked at the top of the file).
    testDb.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = 'ROOM'").run();
    const timerState = (await import("./mpTimerState")) as unknown as {
      hasRoundEnded: ReturnType<typeof vi.fn>;
    };
    timerState.hasRoundEnded.mockReturnValueOnce(false);
    endRound("ROOM");

    // Exactly one mp_game_completed per real player, even after the
    // double call. Without the dedup key this would be 4 rows.
    const events = testDb
      .prepare(
        "SELECT visitor_id, client_event_id FROM events WHERE event_name = 'mp_game_completed' ORDER BY visitor_id",
      )
      .all() as Array<{ visitor_id: string; client_event_id: string }>;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.client_event_id)).toEqual([
      "srv:mp_game_completed:gid-IDEMPOTENT:vis-alice",
      "srv:mp_game_completed:gid-IDEMPOTENT:vis-bob",
    ]);
  });

  it("daily_completed (MP path) scopes on (gameId, visitorId) too", () => {
    const dailyDate = "2026-04-29";
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at, is_daily_game, daily_date, current_game_id)
         VALUES ('DKEY', 'p1', 'classic', 'playing', 5, 5, ?, ?, ?, ?, 1, ?, 'gid-D')`,
      )
      .run(JSON.stringify([productIds[0]]), JSON.stringify({ "5": {} }), now, now, dailyDate);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES ('p1', 'DKEY', 'Alice', 'wizard', 't1', 1, 4500, ?, 'vis-alice')`,
      )
      .run(now);
    insertGuess("p1", 5, 4500, "{}", "DKEY");

    endRound("DKEY");

    const row = testDb
      .prepare(
        "SELECT client_event_id FROM events WHERE event_name = 'daily_completed' AND visitor_id = ?",
      )
      .get("vis-alice") as { client_event_id: string };
    expect(row.client_event_id).toBe("srv:daily_completed:gid-D:vis-alice");
  });
});
