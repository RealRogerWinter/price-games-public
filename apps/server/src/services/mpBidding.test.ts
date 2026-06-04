import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 10);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { submitBid, finalizeBiddingScores } = await import("./mpBidding");
const { initBiddingRound, cleanupBiddingState, getBiddingState } = await import("./mpBiddingState");

function createTestRoom(code: string) {
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at)
     VALUES (?, 'p1', 'p1', 'bidding', 'playing', 1, 5, ?, ?)`
  ).run(code, now, now);

  testDb.prepare(
    `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at)
     VALUES ('p1', ?, 'Alice', 'wizard', 'tok-p1', 1, 1, ?)`
  ).run(code, now);

  testDb.prepare(
    `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at)
     VALUES ('p2', ?, 'Bob', 'yeti', 'tok-p2', 0, 1, ?)`
  ).run(code, now);
}

describe("submitBid", () => {
  it("records a bid for the current bidder", () => {
    createTestRoom("R1");
    const order = initBiddingRound("R1", [
      { playerId: "p1", displayName: "Alice", avatar: "wizard" },
      { playerId: "p2", displayName: "Bob", avatar: "yeti" },
    ], 1);

    const firstBidderId = order[0].playerId;
    const result = submitBid("R1", firstBidderId, 5000);
    expect(result).toBeDefined();
    expect(result!.bid.bidCents).toBe(5000);
    expect(result!.allBidsIn).toBe(false);

    cleanupBiddingState("R1");
  });

  it("rejects out-of-turn bid", () => {
    createTestRoom("R2");
    const order = initBiddingRound("R2", [
      { playerId: "p1", displayName: "Alice", avatar: "wizard" },
      { playerId: "p2", displayName: "Bob", avatar: "yeti" },
    ], 1);

    const secondBidderId = order[1].playerId;
    const result = submitBid("R2", secondBidderId, 5000);
    expect(result).toBeNull();

    cleanupBiddingState("R2");
  });
});

describe("finalizeBiddingScores", () => {
  it("scores all bids and writes to DB", () => {
    createTestRoom("R3");
    // Get actual price of product 1
    const product = testDb.prepare("SELECT price_cents FROM products WHERE id = 1").get() as { price_cents: number };
    const actualPrice = product.price_cents;

    const order = initBiddingRound("R3", [
      { playerId: "p1", displayName: "Alice", avatar: "wizard" },
      { playerId: "p2", displayName: "Bob", avatar: "yeti" },
    ], 1);

    // Both players bid
    submitBid("R3", order[0].playerId, Math.round(actualPrice * 0.9));
    submitBid("R3", order[1].playerId, Math.round(actualPrice * 0.5));

    // Finalize scores
    finalizeBiddingScores("R3");

    // Check guesses were written to DB
    const guesses = testDb.prepare(
      "SELECT * FROM mp_guesses WHERE room_code = 'R3' AND round_number = 1 ORDER BY score DESC"
    ).all() as any[];

    expect(guesses).toHaveLength(2);
    // Closer bid (90%) should score higher
    const closerBid = guesses.find((g: any) => g.player_id === order[0].playerId);
    const fartherBid = guesses.find((g: any) => g.player_id === order[1].playerId);
    expect(closerBid.score).toBeGreaterThan(fartherBid.score);

    // Check total scores updated
    const p1 = testDb.prepare("SELECT total_score FROM mp_players WHERE id = ?").get(order[0].playerId) as { total_score: number };
    expect(p1.total_score).toBeGreaterThan(0);

    cleanupBiddingState("R3");
  });

  it("gives 0 to overbids", () => {
    createTestRoom("R4");
    const product = testDb.prepare("SELECT price_cents FROM products WHERE id = 1").get() as { price_cents: number };
    const actualPrice = product.price_cents;

    const order = initBiddingRound("R4", [
      { playerId: "p1", displayName: "Alice", avatar: "wizard" },
      { playerId: "p2", displayName: "Bob", avatar: "yeti" },
    ], 1);

    // P1 overbids, P2 underbids
    submitBid("R4", order[0].playerId, actualPrice + 1000);
    submitBid("R4", order[1].playerId, actualPrice - 100);

    finalizeBiddingScores("R4");

    const guesses = testDb.prepare(
      "SELECT * FROM mp_guesses WHERE room_code = 'R4' AND round_number = 1"
    ).all() as any[];

    const overbid = guesses.find((g: any) => {
      const data = JSON.parse(g.guess_data);
      return data.bidCents > actualPrice;
    });
    expect(overbid.score).toBe(0);

    cleanupBiddingState("R4");
  });
});
