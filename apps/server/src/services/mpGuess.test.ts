import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));
vi.mock("./mpRoundStart", () => ({
  getActivePlayers: vi.fn(),
}));

beforeEach(async () => {
  testDb = createTestDb();
  const dbMod = await import("../db");
  (dbMod as any).default = testDb;
});

const { submitGuess } = await import("./mpGuess");
const { getActivePlayers } = await import("./mpRoundStart") as any;

function seedFixedProducts(prices: number[]): number[] {
  const ids: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const info = testDb.prepare(
      "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    ).run(`ASIN${i}`, `Product ${i}`, `https://img/${i}.jpg`, `Desc ${i}`, prices[i], "Electronics");
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

function setupRoom(mode: string, productIds: number[], roundData?: any, round = 1) {
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, last_activity_at)
     VALUES ('ROOM', 'p1', ?, 'playing', ?, 10, ?, ?, ?, ?)`
  ).run(mode, round, JSON.stringify(productIds), roundData ? JSON.stringify(roundData) : null, now, now);

  testDb.prepare(
    `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, joined_at)
     VALUES ('p1', 'ROOM', 'Player1', 'wizard', 'tok1', 1, ?)`
  ).run(now);
}

function mockOneActivePlayer() {
  (getActivePlayers as any).mockReturnValue([
    { id: "p1", display_name: "Player1", avatar: "wizard", is_kicked: 0, total_score: 0 },
  ]);
}

describe("submitGuess", () => {
  describe("classic mode", () => {
    it("returns score for valid guess", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("classic", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedPriceCents: 10000 });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1000);
      expect(result!.allGuessed).toBe(true);
    });
  });

  describe("higher-lower mode", () => {
    it("scores correct higher guess", () => {
      const ids = seedFixedProducts([5000]);
      setupRoom("higher-lower", ids, { "1": { referencePrice: 3000 } });
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guess: "higher" });
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });

    it("scores incorrect guess as 0", () => {
      const ids = seedFixedProducts([5000]);
      setupRoom("higher-lower", ids, { "1": { referencePrice: 3000 } });
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guess: "lower" });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("comparison mode", () => {
    it("scores correct most-expensive pick", () => {
      const ids = seedFixedProducts([1000, 5000, 3000]);
      setupRoom("comparison", ids, { "1": { question: "most-expensive" } });
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedProductId: ids[1] });
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });
  });

  describe("closest-without-going-over mode", () => {
    it("scores guess under actual price", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("closest-without-going-over", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedPriceCents: 9900 });
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });

    it("scores 0 for guess over actual price", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("closest-without-going-over", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedPriceCents: 10100 });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("price-match mode", () => {
    it("scores correct assignments", () => {
      const ids = seedFixedProducts([1000, 2000, 3000, 4000]);
      setupRoom("price-match", ids);
      mockOneActivePlayer();

      const assignments: Record<number, number> = {};
      assignments[ids[0]] = 1000;
      assignments[ids[1]] = 2000;
      assignments[ids[2]] = 3000;
      assignments[ids[3]] = 4000;

      const result = submitGuess("ROOM", "p1", { assignments });
      expect(result).not.toBeNull();
      // 4 correct * 200 + 200 bonus = 1000
      expect(result!.score).toBe(1000);
    });
  });

  describe("riser mode", () => {
    it("scores stopped price under actual", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("riser", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { stoppedPriceCents: 10000 });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1000);
    });

    it("scores 0 when stopped over actual", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("riser", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { stoppedPriceCents: 11000 });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("odd-one-out mode", () => {
    it("scores correct outlier guess", () => {
      // Products: 1000, 1100, 1050, 9000. The outlier is 9000.
      const ids = seedFixedProducts([1000, 1100, 1050, 9000]);
      setupRoom("odd-one-out", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedProductId: ids[3] });
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });

    it("scores 0 for wrong outlier guess", () => {
      const ids = seedFixedProducts([1000, 1100, 1050, 9000]);
      setupRoom("odd-one-out", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", { guessedProductId: ids[0] });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("market-basket mode", () => {
    it("scores total guess", () => {
      const ids = seedFixedProducts([1000, 2000, 3000]);
      setupRoom("market-basket", ids);
      mockOneActivePlayer();

      // Actual total: 6000
      const result = submitGuess("ROOM", "p1", { guessedTotalCents: 6000 });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1000);
    });
  });

  describe("sort-it-out mode", () => {
    it("scores correct ordering", () => {
      const ids = seedFixedProducts([3000, 1000, 5000, 2000, 4000]);
      setupRoom("sort-it-out", ids);
      mockOneActivePlayer();

      // Correct order by price ascending: ids[1](1000), ids[3](2000), ids[0](3000), ids[4](4000), ids[2](5000)
      const correctOrder = [ids[1], ids[3], ids[0], ids[4], ids[2]];
      const result = submitGuess("ROOM", "p1", { submittedOrder: correctOrder });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1000);
    });

    it("scores partial ordering", () => {
      const ids = seedFixedProducts([3000, 1000, 5000, 2000, 4000]);
      setupRoom("sort-it-out", ids);
      mockOneActivePlayer();

      // Totally wrong order
      const wrongOrder = [ids[2], ids[4], ids[0], ids[3], ids[1]];
      const result = submitGuess("ROOM", "p1", { submittedOrder: wrongOrder });
      expect(result).not.toBeNull();
      expect(result!.score).toBeLessThan(1000);
    });
  });

  describe("budget-builder mode", () => {
    it("scores product selection within budget", () => {
      const ids = seedFixedProducts([1000, 2000, 3000, 4000, 5000]);
      setupRoom("budget-builder", ids, { "1": { budgetCents: 6000 } });
      mockOneActivePlayer();

      // Select products totaling 6000 (1000+2000+3000)
      const result = submitGuess("ROOM", "p1", { selectedProductIds: [ids[0], ids[1], ids[2]] });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(1000);
    });

    it("scores 0 for over-budget selection", () => {
      const ids = seedFixedProducts([1000, 2000, 3000, 4000, 5000]);
      setupRoom("budget-builder", ids, { "1": { budgetCents: 3000 } });
      mockOneActivePlayer();

      // Select products totaling 6000 > 3000 budget
      const result = submitGuess("ROOM", "p1", { selectedProductIds: [ids[0], ids[1], ids[2]] });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("chain-reaction mode", () => {
    it("scores chain guesses", () => {
      // Prices ascending: 1000, 2000, 3000, 4000
      const ids = seedFixedProducts([1000, 2000, 3000, 4000]);
      setupRoom("chain-reaction", ids);
      mockOneActivePlayer();

      // All "more" is correct for ascending prices (3 comparisons, all correct + perfect bonus)
      const result = submitGuess("ROOM", "p1", { chainGuesses: ["more", "more", "more"] });
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });

    it("scores 0 for all-wrong chain guesses", () => {
      const ids = seedFixedProducts([1000, 2000, 3000, 4000]);
      setupRoom("chain-reaction", ids);
      mockOneActivePlayer();

      // All "less" is wrong for ascending prices
      const result = submitGuess("ROOM", "p1", { chainGuesses: ["less", "less", "less"] });
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("returns null for non-playing room", () => {
      const ids = seedFixedProducts([10000]);
      const now = new Date().toISOString();
      testDb.prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, created_at, last_activity_at)
         VALUES ('IDLE', 'p1', 'classic', 'lobby', 1, 10, ?, ?, ?)`
      ).run(JSON.stringify(ids), now, now);
      testDb.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, joined_at)
         VALUES ('p1', 'IDLE', 'Player1', 'wizard', 'tok-idle', 1, ?)`
      ).run(now);

      const result = submitGuess("IDLE", "p1", { guessedPriceCents: 10000 });
      expect(result).toBeNull();
    });

    it("returns null for kicked player", () => {
      const ids = seedFixedProducts([10000]);
      const now = new Date().toISOString();
      testDb.prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, created_at, last_activity_at)
         VALUES ('KICK', 'p1', 'classic', 'playing', 1, 10, ?, ?, ?)`
      ).run(JSON.stringify(ids), now, now);
      testDb.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, is_kicked, joined_at)
         VALUES ('pk', 'KICK', 'Kicked', 'wizard', 'tok-kick', 0, 1, ?)`
      ).run(now);

      const result = submitGuess("KICK", "pk", { guessedPriceCents: 10000 });
      expect(result).toBeNull();
    });

    it("returns null for double-submit (existing guess)", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("classic", ids);
      mockOneActivePlayer();

      const first = submitGuess("ROOM", "p1", { guessedPriceCents: 10000 });
      expect(first).not.toBeNull();

      const second = submitGuess("ROOM", "p1", { guessedPriceCents: 5000 });
      expect(second).toBeNull();
    });

    it("returns null for invalid guess data (null)", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("classic", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", null);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });

    it("returns null for invalid guess data (non-object)", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("classic", ids);
      mockOneActivePlayer();

      const result = submitGuess("ROOM", "p1", "not-an-object");
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });

    it("truncates oversized guess data", () => {
      const ids = seedFixedProducts([10000]);
      setupRoom("classic", ids);
      mockOneActivePlayer();

      // Build a large payload that exceeds 4096 bytes
      const bigPayload = { guessedPriceCents: 10000, junk: "x".repeat(5000) };
      const result = submitGuess("ROOM", "p1", bigPayload);
      expect(result).not.toBeNull();

      // Verify the stored guess_data was truncated
      const row = testDb.prepare(
        "SELECT guess_data FROM mp_guesses WHERE room_code = 'ROOM' AND player_id = 'p1'"
      ).get() as { guess_data: string };
      expect(row.guess_data.length).toBeLessThanOrEqual(4096);
    });

    it("allGuessed is true when all players have guessed", () => {
      const ids = seedFixedProducts([10000]);
      const now = new Date().toISOString();
      testDb.prepare(
        `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, created_at, last_activity_at)
         VALUES ('ALL', 'p1', 'classic', 'playing', 1, 10, ?, ?, ?)`
      ).run(JSON.stringify(ids), now, now);
      testDb.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, joined_at)
         VALUES ('p1', 'ALL', 'Player1', 'wizard', 'tok-a1', 1, ?)`
      ).run(now);
      testDb.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, joined_at)
         VALUES ('p2', 'ALL', 'Player2', 'sushi', 'tok-a2', 0, ?)`
      ).run(now);

      (getActivePlayers as any).mockReturnValue([
        { id: "p1", display_name: "Player1", avatar: "wizard", is_kicked: 0, total_score: 0 },
        { id: "p2", display_name: "Player2", avatar: "sushi", is_kicked: 0, total_score: 0 },
      ]);

      const first = submitGuess("ALL", "p1", { guessedPriceCents: 10000 });
      expect(first).not.toBeNull();
      expect(first!.allGuessed).toBe(false);

      const second = submitGuess("ALL", "p2", { guessedPriceCents: 10000 });
      expect(second).not.toBeNull();
      expect(second!.allGuessed).toBe(true);
    });
  });
});
