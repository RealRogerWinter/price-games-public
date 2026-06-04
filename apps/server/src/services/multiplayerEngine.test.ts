import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
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

const { createRoom, joinRoom: joinRoomFn, getRoom: getRoomFn, kickPlayer: kickPlayerFn } = await import("./roomManager");
const {
  startRound,
  submitGuess,
  endRound,
  hasRoundEnded,
  playerContinue,
  clearContinueTracker,
  clearRoundTimer,
  cleanupRoomMemory,
  getCurrentRoundPayload,
  getGuessedPlayerIds,
  getRoundGuessCount,
  checkAllConnectedPlayersGuessed,
} = await import("./multiplayerEngine");

async function createRoomWithPlayers(playerCount: number = 2) {
  const host = await createRoom("Host");
  const players = [{ id: host.playerId, token: host.playerToken }];

  for (let i = 1; i < playerCount; i++) {
    const joined = await joinRoomFn(host.room.code, `Player${i + 1}`);
    players.push({ id: joined.playerId, token: joined.playerToken });
  }

  return { roomCode: host.room.code, hostPlayerId: host.playerId, players };
}

afterEach(() => {
  // Clean up any leftover timers to avoid interference between tests
});

describe("startRound", () => {
  it("starts the first round for a room", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();

    const payload = startRound(roomCode, hostPlayerId, timerExpire);
    expect(payload).not.toBeNull();
    expect(payload!.roundNumber).toBe(1);
    expect(payload!.gameMode).toBe("classic");
    expect(payload!.timerSeconds).toBeGreaterThan(0);
    expect(payload!.product).toBeDefined();

    cleanupRoomMemory(roomCode);
  });

  it("returns null for non-host trying to start first round", async () => {
    const { roomCode, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();

    const payload = startRound(roomCode, players[1].id, timerExpire);
    expect(payload).toBeNull();
  });

  it("returns null for non-existent room", async () => {
    expect(startRound("INVALID", "player", vi.fn())).toBeNull();
  });

  it("starts higher-lower round with referencePrice", async () => {
    const host = await createRoom("Host", "higher-lower");
    const timerExpire = vi.fn();

    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();
    expect(payload!.referencePrice).toBeDefined();
    expect(typeof payload!.referencePrice).toBe("number");

    cleanupRoomMemory(host.room.code);
  });

  it("starts comparison round with products and question", async () => {
    const host = await createRoom("Host", "comparison");
    const timerExpire = vi.fn();

    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();
    expect(payload!.products).toBeDefined();
    expect(payload!.products!.length).toBe(2);
    expect(["most-expensive", "least-expensive"]).toContain(payload!.question);

    cleanupRoomMemory(host.room.code);
  });

  it("starts price-match round with products and prices", async () => {
    const host = await createRoom("Host", "price-match");
    const timerExpire = vi.fn();

    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();
    expect(payload!.products!.length).toBe(4);
    expect(payload!.prices!.length).toBe(4);

    cleanupRoomMemory(host.room.code);
  });

  it("starts riser round with maxPriceCents and speedPattern", async () => {
    const host = await createRoom("Host", "riser");
    const timerExpire = vi.fn();

    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();
    expect(payload!.maxPriceCents).toBeDefined();
    expect(payload!.speedPattern).toBeDefined();
    expect(payload!.durationMs).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });
});

describe("submitGuess", () => {
  it("scores a classic guess", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const result = submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(typeof result!.score).toBe("number");
    expect(result!.allGuessed).toBe(false);

    cleanupRoomMemory(roomCode);
  });

  it("detects when all players have guessed", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    const result = submitGuess(roomCode, players[1].id, { guessedPriceCents: 2000 });
    expect(result!.allGuessed).toBe(true);

    cleanupRoomMemory(roomCode);
  });

  it("prevents duplicate guesses", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    const duplicate = submitGuess(roomCode, players[0].id, { guessedPriceCents: 2000 });
    expect(duplicate).toBeNull();

    cleanupRoomMemory(roomCode);
  });

  it("returns null for non-existent room", async () => {
    expect(submitGuess("INVALID", "player", {})).toBeNull();
  });

  it("handles higher-lower guesses", async () => {
    const host = await createRoom("Host", "higher-lower");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { guess: "higher" });
    expect(result).not.toBeNull();
    expect(typeof result!.score).toBe("number");

    cleanupRoomMemory(host.room.code);
  });

  it("handles comparison guesses", async () => {
    const host = await createRoom("Host", "comparison");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);

    const productId = payload!.products![0].id;
    const result = submitGuess(host.room.code, host.playerId, { guessedProductId: productId });
    expect(result).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("handles closest-without-going-over guesses", async () => {
    const host = await createRoom("Host", "closest-without-going-over");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("handles price-match guesses", async () => {
    const host = await createRoom("Host", "price-match");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);

    const assignments: Record<number, number> = {};
    for (const p of payload!.products!) {
      assignments[p.id] = 1000;
    }
    const result = submitGuess(host.room.code, host.playerId, { assignments });
    expect(result).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("handles riser guesses", async () => {
    const host = await createRoom("Host", "riser");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { stoppedPriceCents: 1000 });
    expect(result).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("returns 0 for invalid guess data", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const result = submitGuess(roomCode, players[0].id, null as any);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(roomCode);
  });
});

describe("endRound", () => {
  it("ends the current round and returns results", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });

    const results = endRound(roomCode);
    expect(results).not.toBeNull();
    expect(results!.roundNumber).toBe(1);
    expect(results!.playerResults.length).toBe(2); // 1 guessed + 1 timed out
    expect(results!.standings.length).toBe(2);

    cleanupRoomMemory(roomCode);
  });

  it("prevents double-ending a round", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const first = endRound(roomCode);
    expect(first).not.toBeNull();

    const second = endRound(roomCode);
    expect(second).toBeNull();

    cleanupRoomMemory(roomCode);
  });

  it("marks game as finished after last round", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();

    for (let round = 1; round <= 3; round++) {
      startRound(host.room.code, host.playerId, timerExpire);
      endRound(host.room.code);

      if (round < 3) {
        // Room should be between_rounds after non-final round end
        const room = getRoomFn(host.room.code);
        expect(room.status).toBe("between_rounds");
      }
    }

    const room = getRoomFn(host.room.code);
    expect(room.status).toBe("finished");

    cleanupRoomMemory(host.room.code);
  });

  it("saves to leaderboard after final round", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();

    for (let round = 1; round <= 3; round++) {
      startRound(host.room.code, host.playerId, timerExpire);
      endRound(host.room.code);
    }

    const entries = testDb.prepare("SELECT * FROM mp_leaderboard WHERE room_code = ?").all(host.room.code);
    expect(entries.length).toBe(2); // Both players should be in leaderboard

    cleanupRoomMemory(host.room.code);
  });
});

describe("hasRoundEnded", () => {
  it("returns false before round ends", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    expect(hasRoundEnded(roomCode)).toBe(false);
    cleanupRoomMemory(roomCode);
  });

  it("returns true after round ends", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);
    endRound(roomCode);

    expect(hasRoundEnded(roomCode)).toBe(true);
    cleanupRoomMemory(roomCode);
  });

  it("returns false for unknown room", async () => {
    expect(hasRoundEnded("UNKNOWN")).toBe(false);
  });
});

describe("playerContinue", () => {
  it("tracks continue votes", async () => {
    const { roomCode, players } = await createRoomWithPlayers(2);

    const first = playerContinue(roomCode, players[0].id);
    expect(first.allContinued).toBe(false);

    const second = playerContinue(roomCode, players[1].id);
    expect(second.allContinued).toBe(true);

    clearContinueTracker(roomCode);
  });
});

describe("full round cycle (security regression)", () => {
  it("host can start round 2 after round 1 ends via between_rounds", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();

    // Round 1: lobby → playing → ending → between_rounds
    const r1 = startRound(host.room.code, host.playerId, timerExpire);
    expect(r1).not.toBeNull();
    expect(r1!.roundNumber).toBe(1);

    const endResult1 = endRound(host.room.code);
    expect(endResult1).not.toBeNull();

    let room = getRoomFn(host.room.code);
    expect(room!.status).toBe("between_rounds");

    // Round 2: host starts from between_rounds
    const r2 = startRound(host.room.code, host.playerId, timerExpire);
    expect(r2).not.toBeNull();
    expect(r2!.roundNumber).toBe(2);

    room = getRoomFn(host.room.code);
    expect(room!.status).toBe("playing");

    cleanupRoomMemory(host.room.code);
  });

  it("non-host cannot start round from between_rounds", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    const guest = await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();

    startRound(host.room.code, host.playerId, timerExpire);
    endRound(host.room.code);

    const room = getRoomFn(host.room.code);
    expect(room!.status).toBe("between_rounds");

    // Non-host should be rejected
    const result = startRound(host.room.code, guest.playerId, timerExpire);
    expect(result).toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("endRound is idempotent — second call returns null", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();

    startRound(roomCode, hostPlayerId, timerExpire);

    const first = endRound(roomCode);
    expect(first).not.toBeNull();

    const second = endRound(roomCode);
    expect(second).toBeNull();

    cleanupRoomMemory(roomCode);
  });

  it("duplicate guess submission returns null", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();

    startRound(roomCode, hostPlayerId, timerExpire);

    const first = submitGuess(roomCode, players[0].id, { guessedPriceCents: 500 });
    expect(first).not.toBeNull();
    expect(first!.score).toBeGreaterThanOrEqual(0);

    // Second guess from same player same round should be rejected
    const second = submitGuess(roomCode, players[0].id, { guessedPriceCents: 600 });
    expect(second).toBeNull();

    cleanupRoomMemory(roomCode);
  });
});

describe("getCurrentRoundPayload", () => {
  it("returns current round data for reconnecting player", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const payload = getCurrentRoundPayload(roomCode);
    expect(payload).not.toBeNull();
    expect(payload!.roundNumber).toBe(1);
    expect(payload!.timerSeconds).toBeGreaterThan(0);

    cleanupRoomMemory(roomCode);
  });

  it("returns null when not playing", async () => {
    const { roomCode } = await createRoomWithPlayers(2);
    expect(getCurrentRoundPayload(roomCode)).toBeNull();
  });
});

describe("getGuessedPlayerIds", () => {
  it("returns IDs of players who have guessed", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    expect(getGuessedPlayerIds(roomCode)).toHaveLength(0);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    expect(getGuessedPlayerIds(roomCode)).toContain(players[0].id);

    cleanupRoomMemory(roomCode);
  });
});

describe("getRoundGuessCount", () => {
  it("returns guess count and total players", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const initial = getRoundGuessCount(roomCode);
    expect(initial.guessed).toBe(0);
    expect(initial.total).toBe(2);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    const after = getRoundGuessCount(roomCode);
    expect(after.guessed).toBe(1);

    cleanupRoomMemory(roomCode);
  });
});

describe("checkAllConnectedPlayersGuessed", () => {
  it("returns false when not all have guessed", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    expect(checkAllConnectedPlayersGuessed(roomCode)).toBe(false);

    cleanupRoomMemory(roomCode);
  });

  it("returns true when all connected players have guessed", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    submitGuess(roomCode, players[0].id, { guessedPriceCents: 1000 });
    submitGuess(roomCode, players[1].id, { guessedPriceCents: 2000 });
    expect(checkAllConnectedPlayersGuessed(roomCode)).toBe(true);

    cleanupRoomMemory(roomCode);
  });
});

describe("edge cases", () => {
  it("submitGuess returns null for kicked player", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    // Kick P2
    kickPlayerFn(host.room.code, host.playerId, joined.playerId);

    const result = submitGuess(host.room.code, joined.playerId, { guessedPriceCents: 1000 });
    expect(result).toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("submitGuess returns null when room is not playing", async () => {
    const host = await createRoom("Host");
    // Room is in lobby status
    const result = submitGuess(host.room.code, host.playerId, { guessedPriceCents: 1000 });
    expect(result).toBeNull();
  });

  it("endRound returns null when room is not playing", async () => {
    const host = await createRoom("Host");
    const result = endRound(host.room.code);
    expect(result).toBeNull();
  });

  it("startRound returns null when exceeding total rounds", async () => {
    const host = await createRoom("Host", "classic", { totalRounds: 3 });
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();

    for (let i = 0; i < 3; i++) {
      startRound(host.room.code, host.playerId, timerExpire);
      endRound(host.room.code);
    }

    // Room is now finished; try to start another round
    const result = startRound(host.room.code, host.playerId, timerExpire);
    expect(result).toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("handles classic guess with out-of-range value (returns 0)", async () => {
    const { roomCode, hostPlayerId, players } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    const result = submitGuess(roomCode, players[0].id, { guessedPriceCents: -1 });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(roomCode);
  });

  it("handles higher-lower guess with invalid value", async () => {
    const host = await createRoom("Host", "higher-lower");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { guess: "invalid" });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(host.room.code);
  });

  it("handles comparison guess with invalid product ID", async () => {
    const host = await createRoom("Host", "comparison");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { guessedProductId: -999 });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(host.room.code);
  });

  it("handles closest guess with out-of-range value", async () => {
    const host = await createRoom("Host", "closest-without-going-over");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { guessedPriceCents: 20_000_000 });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(host.room.code);
  });

  it("handles price-match guess with invalid assignments", async () => {
    const host = await createRoom("Host", "price-match");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { assignments: null });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(host.room.code);
  });

  it("handles riser guess with out-of-range value", async () => {
    const host = await createRoom("Host", "riser");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const result = submitGuess(host.room.code, host.playerId, { stoppedPriceCents: 20_000_000 });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);

    cleanupRoomMemory(host.room.code);
  });

  it("getRoundGuessCount returns 0/0 for non-existent room", async () => {
    const result = getRoundGuessCount("NONEXISTENT");
    expect(result.guessed).toBe(0);
    expect(result.total).toBe(0);
  });

  it("getGuessedPlayerIds returns empty for non-existent room", async () => {
    expect(getGuessedPlayerIds("NONEXISTENT")).toHaveLength(0);
  });

  it("checkAllConnectedPlayersGuessed returns false for non-existent room", async () => {
    expect(checkAllConnectedPlayersGuessed("NONEXISTENT")).toBe(false);
  });

  it("getCurrentRoundPayload returns null for non-existent room", async () => {
    expect(getCurrentRoundPayload("NONEXISTENT")).toBeNull();
  });
});

describe("cleanupRoomMemory", () => {
  it("cleans up timers, flags, and trackers", async () => {
    const { roomCode, hostPlayerId } = await createRoomWithPlayers(2);
    const timerExpire = vi.fn();
    startRound(roomCode, hostPlayerId, timerExpire);

    cleanupRoomMemory(roomCode);
    expect(hasRoundEnded(roomCode)).toBe(false);
  });
});

describe("endRound with different game modes", () => {
  it("endRound with higher-lower mode returns reveal data with referencePrice", async () => {
    const host = await createRoom("Host", "higher-lower");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);
    submitGuess(host.room.code, host.playerId, { guess: "higher" });

    const results = endRound(host.room.code);
    expect(results).not.toBeNull();
    expect(results!.revealData.product).toBeDefined();
    expect(results!.revealData.referencePrice).toBeDefined();
    expect(typeof results!.revealData.referencePrice).toBe("number");

    cleanupRoomMemory(host.room.code);
  });

  it("endRound with comparison mode returns reveal data with products and correctProductId", async () => {
    const host = await createRoom("Host", "comparison");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);
    submitGuess(host.room.code, host.playerId, { guessedProductId: payload!.products![0].id });

    const results = endRound(host.room.code);
    expect(results).not.toBeNull();
    expect(results!.revealData.products).toBeDefined();
    expect(results!.revealData.correctProductId).toBeDefined();
    expect(results!.revealData.question).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("endRound with price-match mode returns reveal data with products", async () => {
    const host = await createRoom("Host", "price-match");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);

    const assignments: Record<number, number> = {};
    for (const p of payload!.products!) {
      assignments[p.id] = 1000;
    }
    submitGuess(host.room.code, host.playerId, { assignments });

    const results = endRound(host.room.code);
    expect(results).not.toBeNull();
    expect(results!.revealData.products).toBeDefined();
    expect(results!.revealData.products.length).toBeGreaterThan(0);

    cleanupRoomMemory(host.room.code);
  });

  it("endRound with riser mode returns reveal data with maxPriceCents", async () => {
    const host = await createRoom("Host", "riser");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);
    submitGuess(host.room.code, host.playerId, { stoppedPriceCents: 1000 });

    const results = endRound(host.room.code);
    expect(results).not.toBeNull();
    expect(results!.revealData.product).toBeDefined();
    expect(results!.revealData.maxPriceCents).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("endRound with closest-without-going-over mode returns reveal data with product", async () => {
    const host = await createRoom("Host", "closest-without-going-over");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);
    submitGuess(host.room.code, host.playerId, { guessedPriceCents: 1000 });

    const results = endRound(host.room.code);
    expect(results).not.toBeNull();
    expect(results!.revealData.product).toBeDefined();
    expect(results!.revealData.product.priceCents).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });
});

describe("getCurrentRoundPayload with different modes", () => {
  it("returns payload for higher-lower mode", async () => {
    const host = await createRoom("Host", "higher-lower");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const payload = getCurrentRoundPayload(host.room.code);
    expect(payload).not.toBeNull();
    expect(payload!.referencePrice).toBeDefined();
    expect(payload!.product).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("returns payload for comparison mode", async () => {
    const host = await createRoom("Host", "comparison");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const payload = getCurrentRoundPayload(host.room.code);
    expect(payload).not.toBeNull();
    expect(payload!.products).toBeDefined();
    expect(payload!.question).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("returns payload for price-match mode", async () => {
    const host = await createRoom("Host", "price-match");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const payload = getCurrentRoundPayload(host.room.code);
    expect(payload).not.toBeNull();
    expect(payload!.products).toBeDefined();
    expect(payload!.prices).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("returns payload for riser mode with adjusted timer", async () => {
    const host = await createRoom("Host", "riser");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const payload = getCurrentRoundPayload(host.room.code);
    expect(payload).not.toBeNull();
    expect(payload!.maxPriceCents).toBeDefined();
    expect(payload!.speedPattern).toBeDefined();
    expect(payload!.durationMs).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });

  it("returns payload for closest-without-going-over mode", async () => {
    const host = await createRoom("Host", "closest-without-going-over");
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    startRound(host.room.code, host.playerId, timerExpire);

    const payload = getCurrentRoundPayload(host.room.code);
    expect(payload).not.toBeNull();
    expect(payload!.product).toBeDefined();

    cleanupRoomMemory(host.room.code);
  });
});

describe("startRound with category parsing", () => {
  it("starts round with legacy single-category string", async () => {
    const host = await createRoom("Host");
    await joinRoomFn(host.room.code, "Player2");
    // Set legacy single-category string (not JSON array)
    testDb.prepare("UPDATE mp_rooms SET category = ? WHERE code = ?").run("Electronics", host.room.code);
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });

  it("starts round with JSON categories array", async () => {
    const host = await createRoom("Host", "classic", { categories: ["Electronics"] });
    await joinRoomFn(host.room.code, "Player2");
    const timerExpire = vi.fn();
    const payload = startRound(host.room.code, host.playerId, timerExpire);
    expect(payload).not.toBeNull();

    cleanupRoomMemory(host.room.code);
  });
});

describe("checkAllConnectedPlayersGuessed edge cases", () => {
  it("returns true when no connected players remain", async () => {
    const host = await createRoom("Host");
    // Disconnect everyone
    testDb.prepare("UPDATE mp_players SET connected = 0 WHERE room_code = ?").run(host.room.code);
    // Set room to playing state
    testDb.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = ?").run(host.room.code);
    expect(checkAllConnectedPlayersGuessed(host.room.code)).toBe(true);
  });
});
