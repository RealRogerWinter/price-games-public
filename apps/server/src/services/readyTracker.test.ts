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

const { playerReady, clearReadyTracker } = await import("./mpTimerState");

function createRoomWithPlayers(code: string, humans: number, bots: number) {
  const now = new Date().toISOString();
  testDb.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at)
     VALUES (?, 'p1', 'p1', 'classic', 'lobby', 0, 5, ?, ?)`
  ).run(code, now, now);

  for (let i = 1; i <= humans; i++) {
    testDb.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, is_bot)
       VALUES (?, ?, ?, 'wizard', ?, ?, 1, ?, 0)`
    ).run(`p${i}`, code, `Player${i}`, `tok-p${i}`, i === 1 ? 1 : 0, now);
  }

  for (let i = 1; i <= bots; i++) {
    testDb.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, is_bot)
       VALUES (?, ?, ?, 'yeti', ?, 0, 1, ?, 1)`
    ).run(`bot-${i}`, code, `Bot${i}`, `bot-tok-${i}`, now);
  }
}

describe("playerReady", () => {
  it("returns allReady when all humans are ready (excludes bots)", () => {
    createRoomWithPlayers("R1", 2, 3);

    const r1 = playerReady("R1", "p1");
    expect(r1.allReady).toBe(false);

    const r2 = playerReady("R1", "p2");
    expect(r2.allReady).toBe(true);

    clearReadyTracker("R1");
  });

  it("returns allReady immediately for a single human with bots", () => {
    createRoomWithPlayers("R2", 1, 2);

    const result = playerReady("R2", "p1");
    expect(result.allReady).toBe(true);

    clearReadyTracker("R2");
  });

  it("excludes disconnected humans from the count", () => {
    createRoomWithPlayers("R3", 3, 0);
    // Disconnect p3
    testDb.prepare("UPDATE mp_players SET connected = 0 WHERE id = 'p3'").run();

    const r1 = playerReady("R3", "p1");
    expect(r1.allReady).toBe(false);

    const r2 = playerReady("R3", "p2");
    expect(r2.allReady).toBe(true); // only 2 connected humans

    clearReadyTracker("R3");
  });
});

describe("clearReadyTracker", () => {
  it("resets ready state so players must ready up again", () => {
    createRoomWithPlayers("R4", 2, 0);
    playerReady("R4", "p1");
    clearReadyTracker("R4");

    // After clear, p1 readying again should not be allReady (p2 hasn't readied)
    const result = playerReady("R4", "p1");
    expect(result.allReady).toBe(false);

    clearReadyTracker("R4");
  });
});
