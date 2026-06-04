/**
 * Integration tests for the multiplayer end-of-room leaderboard
 * (`mp_leaderboard` — distinct from the lifetime / period boards in
 * routes/leaderboard.ts). Verifies room → placement persistence and
 * placement ordering across game modes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { createRoom, joinRoom } = await import("../services/roomManager");
const {
  startRound,
  submitGuess: mpGuess,
  endRound,
  cleanupRoomMemory,
} = await import("../services/multiplayerEngine");

describe("Multiplayer leaderboard integration", () => {
  it("saves all player scores after a multiplayer game completes", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    const joiner = await joinRoom(host.room.code, "Joiner");
    const timerExpire = vi.fn();

    for (let round = 1; round <= 3; round++) {
      startRound(host.room.code, host.playerId, timerExpire);

      mpGuess(host.room.code, host.playerId, { guessedPriceCents: 5000 });
      mpGuess(host.room.code, joiner.playerId, { guessedPriceCents: 3000 });

      endRound(host.room.code);
    }

    const entries = testDb
      .prepare("SELECT * FROM mp_leaderboard WHERE room_code = ? ORDER BY placement")
      .all(host.room.code) as any[];

    expect(entries.length).toBe(2);
    expect(entries[0].placement).toBe(1);
    expect(entries[1].placement).toBe(2);
    expect(entries[0].players_count).toBe(2);
    expect(entries[0].game_mode).toBe("classic");
    expect(entries[0].score).toBeGreaterThanOrEqual(entries[1].score);

    cleanupRoomMemory(host.room.code);
  });

  it("records correct placement order by score", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    const joiner = await joinRoom(host.room.code, "Joiner");
    const timerExpire = vi.fn();

    for (let round = 1; round <= 3; round++) {
      startRound(host.room.code, host.playerId, timerExpire);

      // Get the actual product price so host can guess exactly
      const room = testDb.prepare("SELECT selected_products FROM mp_rooms WHERE code = ?").get(host.room.code) as any;
      const productIds = JSON.parse(room.selected_products);
      const product = testDb.prepare("SELECT price_cents FROM products WHERE id = ?").get(productIds[0]) as any;

      // Host guesses exact, joiner guesses way off
      mpGuess(host.room.code, host.playerId, { guessedPriceCents: product.price_cents });
      mpGuess(host.room.code, joiner.playerId, { guessedPriceCents: 1 });

      endRound(host.room.code);
    }

    const entries = testDb
      .prepare("SELECT * FROM mp_leaderboard WHERE room_code = ? ORDER BY placement")
      .all(host.room.code) as any[];

    expect(entries[0].player_name).toBe("Host");
    expect(entries[0].score).toBe(3000);
    expect(entries[0].placement).toBe(1);

    expect(entries[1].player_name).toBe("Joiner");
    expect(entries[1].score).toBe(0);
    expect(entries[1].placement).toBe(2);

    cleanupRoomMemory(host.room.code);
  });

  it("saves leaderboard entries for all game modes", async () => {
    const modes = ["classic", "higher-lower", "comparison", "closest-without-going-over", "price-match", "riser"];

    for (const mode of modes) {
      const host = await createRoom("Host", mode as any, { totalRounds: 3 });
      const joiner = await joinRoom(host.room.code, "Joiner");
      const timerExpire = vi.fn();

      for (let round = 1; round <= 3; round++) {
        startRound(host.room.code, host.playerId, timerExpire);

        const room = testDb.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(host.room.code) as any;
        const productIds = JSON.parse(room.selected_products);

        let guessData: any;
        if (mode === "classic" || mode === "closest-without-going-over") {
          guessData = { guessedPriceCents: 5000 };
        } else if (mode === "higher-lower") {
          guessData = { guess: "higher" };
        } else if (mode === "comparison") {
          guessData = { guessedProductId: productIds[0] };
        } else if (mode === "price-match") {
          // Price-match needs assignments mapping product IDs to price values
          const assignments: Record<number, number> = {};
          for (const pid of productIds) {
            const prod = testDb.prepare("SELECT price_cents FROM products WHERE id = ?").get(pid) as any;
            assignments[pid] = prod.price_cents;
          }
          guessData = { assignments };
        } else if (mode === "riser") {
          guessData = { stoppedPriceCents: 5000 };
        }

        mpGuess(host.room.code, host.playerId, guessData);
        mpGuess(host.room.code, joiner.playerId, guessData);
        endRound(host.room.code);
      }

      const entries = testDb
        .prepare("SELECT * FROM mp_leaderboard WHERE room_code = ?")
        .all(host.room.code) as any[];

      expect(entries.length).toBe(2);
      expect(entries[0].game_mode).toBe(mode);

      cleanupRoomMemory(host.room.code);
    }
  });
});
