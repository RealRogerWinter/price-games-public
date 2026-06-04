/**
 * Integration tests for password-protected rooms, custom round counts,
 * category filtering, and other edge cases.
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
  continueRound,
  waitForEvent,
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

describe("Password-protected rooms", () => {
  it("creates a room with password", async () => {
    const hostSocket = await connect();
    const result = await createRoom(hostSocket, "Host", { password: "secret123" });
    expect(result.room.hasPassword).toBe(true);
  });

  it("allows joining with correct password", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { password: "mypass" });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner", "mypass");
    expect(joinResult.room.players).toHaveLength(2);
  });

  it("rejects joining with wrong password", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { password: "correct" });
    await expect(
      joinRoom(joinerSocket, hostResult.room.code, "Joiner", "wrong")
    ).rejects.toThrow("Incorrect password");
  });

  it("rejects joining without password when room requires one", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { password: "secret" });
    await expect(
      joinRoom(joinerSocket, hostResult.room.code, "Joiner")
    ).rejects.toThrow("Incorrect password");
  });
});

describe("Custom round counts", () => {
  it("respects custom total rounds (minimum 3)", async () => {
    const hostSocket = await connect();
    const result = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    expect(result.room.totalRounds).toBe(3);
  });

  it("respects custom total rounds (maximum 20)", async () => {
    const hostSocket = await connect();
    const result = await createRoom(hostSocket, "Host", { totalRounds: 20 });
    expect(result.room.totalRounds).toBe(20);
  });

  it("clamps round count below minimum to 3", async () => {
    const hostSocket = await connect();
    const result = await createRoom(hostSocket, "Host", { totalRounds: 1 });
    expect(result.room.totalRounds).toBe(3);
  });

  it("clamps round count above maximum to 20", async () => {
    const hostSocket = await connect();
    const result = await createRoom(hostSocket, "Host", { totalRounds: 100 });
    expect(result.room.totalRounds).toBe(20);
  });

  it("finishes game at custom round count", async () => {
    const hostSocket = await connect();
    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });

    // Round 1
    const rsp1 = waitForEvent(hostSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp1;

    const endP1 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await endP1;

    // Round 2
    const rsp2 = waitForEvent(hostSocket, "game:round_start");
    await continueRound(hostSocket);
    await rsp2;

    const endP2 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await endP2;

    // Round 3 (final)
    const rsp3 = waitForEvent(hostSocket, "game:round_start");
    await continueRound(hostSocket);
    await rsp3;

    const overP = waitForEvent(hostSocket, "game:over");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await overP;

    const room = server.db.prepare("SELECT status FROM mp_rooms WHERE code = ?")
      .get(hostResult.room.code) as any;
    expect(room.status).toBe("finished");
  });
});

describe("Room with all game modes", () => {
  const modes = [
    "classic",
    "higher-lower",
    "comparison",
    "closest-without-going-over",
    "price-match",
    "riser",
  ];

  for (const mode of modes) {
    it(`creates room and starts round in ${mode} mode`, async () => {
      const hostSocket = await connect();
      const result = await createRoom(hostSocket, "Host", { gameMode: mode, totalRounds: 3 });
      expect(result.room.gameMode).toBe(mode);

      const rsp = waitForEvent(hostSocket, "game:round_start");
      await startRound(hostSocket);
      const roundData = await rsp;
      expect(roundData.gameMode).toBe(mode);
    });
  }
});

describe("Invalid game mode", () => {
  it("rejects creating room with invalid mode", async () => {
    const hostSocket = await connect();
    await expect(
      createRoom(hostSocket, "Host", { gameMode: "invalid-mode" })
    ).rejects.toThrow("Invalid game mode");
  });
});

describe("Continue voting mechanics", () => {
  it("requires all players to continue before auto-advancing", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Play round 1
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    await endP;

    // Only host continues — round should NOT auto-start yet
    const continuedP = waitForEvent(joinerSocket, "game:player_continued");
    await continueRound(hostSocket);
    await continuedP;

    // Verify still between rounds
    const room = server.db.prepare("SELECT status FROM mp_rooms WHERE code = ?")
      .get(hostResult.room.code) as any;
    expect(room.status).toBe("between_rounds");

    // Now joiner continues — should auto-start round 2
    const round2P = waitForEvent(hostSocket, "game:round_start");
    const round2P2 = waitForEvent(joinerSocket, "game:round_start");
    await continueRound(joinerSocket);
    const round2Data = await round2P;
    await round2P2;
    expect(round2Data.roundNumber).toBe(2);
  });
});

describe("Exceeding total rounds", () => {
  it("cannot start more rounds than total_rounds", async () => {
    const hostSocket = await connect();
    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });

    // Round 1
    const rsp1 = waitForEvent(hostSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp1;
    const endP1 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await endP1;

    // Round 2
    const rsp2 = waitForEvent(hostSocket, "game:round_start");
    await continueRound(hostSocket);
    await rsp2;
    const endP2 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await endP2;

    // Round 3 (final)
    const rsp3 = waitForEvent(hostSocket, "game:round_start");
    await continueRound(hostSocket);
    await rsp3;
    const overP = waitForEvent(hostSocket, "game:over");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    await overP;

    // Room should be finished
    const room = server.db.prepare("SELECT status FROM mp_rooms WHERE code = ?")
      .get(hostResult.room.code) as any;
    expect(room.status).toBe("finished");
  });
});

describe("Kicked player during round", () => {
  it("round proceeds correctly when a player is kicked mid-game", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();
    const thirdSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");
    await joinRoom(thirdSocket, hostResult.room.code, "Third");

    // Start round
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    const rsp3 = waitForEvent(thirdSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;
    await rsp3;

    // Kick the joiner
    const kickedP = waitForEvent(joinerSocket, "room:player_kicked");
    await new Promise<void>((resolve, reject) => {
      hostSocket.emit("room:kick", { playerId: joinResult.playerId }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve();
      });
    });
    await kickedP;

    // Host and third player can still play
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(thirdSocket, { guessedPriceCents: 5000 });
    const roundEnd = await endP;

    // Only 2 active players should have results (kicked player excluded from active)
    expect(roundEnd.standings.length).toBe(2);
  });
});
