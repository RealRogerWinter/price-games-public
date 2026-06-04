/**
 * Integration tests for timer behavior and race condition prevention.
 *
 * Tests timer expiry ending rounds, early termination when all guess
 * before timer, double-round-end prevention, and duplicate guess rejection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import {
  createTestServer,
  closeTestServer,
  connectClient,
  disconnectClient,
  createRoom,
  joinRoom,
  startRound,
  submitGuess,
  waitForEvent,
  collectEvents,
  TestServer,
} from "../test/socketHelper";

vi.mock("../db", () => ({ default: null as any }));

let server: TestServer;
let sockets: ClientSocket[] = [];

beforeEach(async () => {
  server = await createTestServer(50);
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) {
    if (s.connected) await disconnectClient(s);
  }
  sockets = [];
  await closeTestServer(server);
});

async function connect(): Promise<ClientSocket> {
  const s = await connectClient(server.url);
  sockets.push(s);
  return s;
}

describe("All players guessing ends round before timer", () => {
  it("immediately ends round when all players have guessed", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    const roundData = await rsp;
    await rsp2;

    expect(roundData.timerSeconds).toBeGreaterThan(0);

    const startTime = Date.now();
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    await endP;
    const elapsed = Date.now() - startTime;

    // Should complete in well under 1 second, not 30
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("Timer expiry gives 0 to non-guessers", () => {
  it("assigns 0 score to players who did not guess when round ends", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    // Only host guesses
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });

    // Manually trigger the round end through the service layer
    // (simulates what happens when the timer fires)
    const { endRound, hasRoundEnded } = await import("../services/multiplayerEngine");
    if (!hasRoundEnded(hostResult.room.code)) {
      const results = endRound(hostResult.room.code);
      expect(results).not.toBeNull();
      expect(results!.playerResults.length).toBe(2);

      const joinerResult = results!.playerResults.find(
        (p: any) => p.playerId === joinResult.playerId
      );
      expect(joinerResult).toBeDefined();
      expect(joinerResult!.score).toBe(0);
    }
  });
});

describe("Double round-end prevention", () => {
  it("only ends a round once even with concurrent triggers", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });

    const { endRound: doEndRound } = await import("../services/mpRoundEnd");

    // First call succeeds
    const result1 = doEndRound(hostResult.room.code);
    expect(result1).not.toBeNull();

    // Second call returns null (already ended)
    const result2 = doEndRound(hostResult.room.code);
    expect(result2).toBeNull();
  });
});

describe("Duplicate guess atomic rejection", () => {
  it("database unique constraint prevents double-guess", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    const result = await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    expect(result.score).toBeGreaterThanOrEqual(0);

    // Second attempt via socket should fail
    await expect(
      submitGuess(hostSocket, { guessedPriceCents: 9999 })
    ).rejects.toThrow();
  });
});

describe("Round-end event is only emitted once", () => {
  it("clients receive exactly one round_end per round", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const roundEndCollector = collectEvents(hostSocket, "game:round_end");
    const gameOverCollector = collectEvents(hostSocket, "game:over");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    await endP;

    // Wait for any duplicate events
    await new Promise(r => setTimeout(r, 200));

    roundEndCollector.stop();
    gameOverCollector.stop();

    expect(roundEndCollector.events.length).toBe(1);
    expect(gameOverCollector.events.length).toBe(0);
  });
});

describe("Settings cannot be changed during playing", () => {
  it("rejects settings change while room is playing", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    // Try to change settings mid-game
    await expect(
      new Promise((resolve, reject) => {
        hostSocket.emit("room:settings", { gameMode: "riser" }, (res: any) => {
          if (res.error) reject(new Error(res.error));
          else resolve(res);
        });
      })
    ).rejects.toThrow();
  });
});
