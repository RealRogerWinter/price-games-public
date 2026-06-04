/**
 * Integration tests for the full multiplayer game flow.
 *
 * Tests the complete lifecycle: room creation, player joining,
 * round start, guess submission, round end, continue voting,
 * game completion, and play again — all through real Socket.IO connections.
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
  playAgain,
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

describe("Room creation and joining", () => {
  it("creates a room and returns room data", async () => {
    const host = await connect();
    const result = await createRoom(host, "HostPlayer");

    expect(result.room).toBeDefined();
    expect(result.room.code).toHaveLength(7);
    expect(result.room.status).toBe("lobby");
    expect(result.room.gameMode).toBe("classic");
    expect(result.room.players).toHaveLength(1);
    expect(result.room.players[0].displayName).toBe("HostPlayer");
    expect(result.room.players[0].isHost).toBe(true);
    expect(result.playerId).toBeDefined();
    expect(result.playerToken).toBeDefined();
  });

  it("allows a second player to join the room", async () => {
    const host = await connect();
    const joiner = await connect();

    const hostResult = await createRoom(host, "Host");
    const playerJoinedPromise = waitForEvent(host, "room:player_joined");
    const joinResult = await joinRoom(joiner, hostResult.room.code, "Joiner");
    const joinEvent = await playerJoinedPromise;

    expect(joinResult.room.players).toHaveLength(2);
    expect(joinResult.playerId).toBeDefined();
    expect(joinEvent.player.displayName).toBe("Joiner");
  });

  it("enforces max player limit", async () => {
    const host = await connect();
    const hostResult = await createRoom(host, "Host");

    // MAX_PLAYERS is 6, host is already in the room, add 5 more to fill it
    for (let i = 0; i < 5; i++) {
      const s = await connect();
      await joinRoom(s, hostResult.room.code, `Player${i + 2}`);
    }

    const extra = await connect();
    await expect(joinRoom(extra, hostResult.room.code, "Extra"))
      .rejects.toThrow("Room is full");
  });

  it("rejects joining non-existent room", async () => {
    const s = await connect();
    await expect(joinRoom(s, "INVALID", "Player")).rejects.toThrow("Room not found");
  });

  it("rejects empty display name", async () => {
    const s = await connect();
    await expect(createRoom(s, "")).rejects.toThrow("Display name is required");
  });
});

describe("Full game flow — classic mode", () => {
  it("plays a complete 3-round game with 2 players", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // === Round 1 ===
    const rs1h = waitForEvent(hostSocket, "game:round_start");
    const rs1j = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    const rd1 = await rs1h;
    await rs1j;

    expect(rd1.roundNumber).toBe(1);
    expect(rd1.product).toBeDefined();

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const re1 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    const results1 = await re1;
    expect(results1.roundNumber).toBe(1);
    expect(results1.playerResults.length).toBe(2);

    // === Continue → Round 2 ===
    // Set up round_start listeners BEFORE triggering continues
    const rs2h = waitForEvent(hostSocket, "game:round_start");
    const rs2j = waitForEvent(joinerSocket, "game:round_start");
    await continueRound(hostSocket);
    await continueRound(joinerSocket);
    const rd2 = await rs2h;
    await rs2j;
    expect(rd2.roundNumber).toBe(2);

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const re2 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    const results2 = await re2;
    expect(results2.roundNumber).toBe(2);

    // === Continue → Round 3 (final) ===
    const rs3h = waitForEvent(hostSocket, "game:round_start");
    const rs3j = waitForEvent(joinerSocket, "game:round_start");
    await continueRound(hostSocket);
    await continueRound(joinerSocket);
    await rs3h;
    await rs3j;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const ov = waitForEvent(hostSocket, "game:over");
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    const overData = await ov;
    expect(overData.results.roundNumber).toBe(3);
  }, 15000);

  it("saves to leaderboard after game completion", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    for (let round = 1; round <= 3; round++) {
      const rsH = waitForEvent(hostSocket, "game:round_start");
      const rsJ = waitForEvent(joinerSocket, "game:round_start");

      if (round === 1) {
        await startRound(hostSocket);
      } else {
        await continueRound(hostSocket);
        await continueRound(joinerSocket);
      }

      await rsH;
      await rsJ;

      await submitGuess(hostSocket, { guessedPriceCents: 5000 });
      const endEvt = round < 3 ? "game:round_end" : "game:over";
      const endP = waitForEvent(hostSocket, endEvt);
      await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
      await endP;
    }

    const entries = server.db
      .prepare("SELECT * FROM mp_leaderboard WHERE room_code = ?")
      .all(hostResult.room.code) as any[];

    expect(entries.length).toBe(2);
    expect(entries[0].players_count).toBe(2);
    expect(entries[0].game_mode).toBe("classic");
  }, 15000);
});

describe("Play again flow", () => {
  it("resets room and allows a new game", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Play a full 3-round game
    for (let round = 1; round <= 3; round++) {
      const rsH = waitForEvent(hostSocket, "game:round_start");
      const rsJ = waitForEvent(joinerSocket, "game:round_start");

      if (round === 1) {
        await startRound(hostSocket);
      } else {
        await continueRound(hostSocket);
        await continueRound(joinerSocket);
      }

      await rsH;
      await rsJ;

      await submitGuess(hostSocket, { guessedPriceCents: 5000 });
      const endEvt = round < 3 ? "game:round_end" : "game:over";
      const endP = waitForEvent(hostSocket, endEvt);
      await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
      await endP;
    }

    // Play again
    const updatedPromise = waitForEvent(joinerSocket, "room:updated");
    await playAgain(hostSocket);
    const updatedRoom = await updatedPromise;

    expect(updatedRoom.status).toBe("lobby");
    expect(updatedRoom.currentRound).toBe(0);
    expect(updatedRoom.players[0].totalScore).toBe(0);
    expect(updatedRoom.players[1].totalScore).toBe(0);

    // Can start a new game
    const newRoundP1 = waitForEvent(hostSocket, "game:round_start");
    const newRoundP2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    const newRound = await newRoundP1;
    await newRoundP2;
    expect(newRound.roundNumber).toBe(1);
  }, 15000);
});

describe("Room settings", () => {
  it("host can change game mode before starting", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const settingsP = waitForEvent(joinerSocket, "room:settings_updated");
    await new Promise((resolve, reject) => {
      hostSocket.emit("room:settings", { gameMode: "higher-lower" }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });

    const settings = await settingsP;
    expect(settings.gameMode).toBe("higher-lower");
  });

  it("non-host cannot change settings", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    await expect(
      new Promise((resolve, reject) => {
        joinerSocket.emit("room:settings", { gameMode: "riser" }, (res: any) => {
          if (res.error) reject(new Error(res.error));
          else resolve(res);
        });
      })
    ).rejects.toThrow();
  });
});

describe("Kick player flow", () => {
  it("host can kick a player", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const kickedPromise = waitForEvent(joinerSocket, "room:player_kicked");
    await new Promise((resolve, reject) => {
      hostSocket.emit("room:kick", { playerId: joinResult.playerId }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });

    const kickedEvent = await kickedPromise;
    expect(kickedEvent.playerId).toBe(joinResult.playerId);

    // Kicked player cannot rejoin
    const newSocket = await connect();
    await expect(
      new Promise((resolve, reject) => {
        newSocket.emit("room:rejoin", {
          roomCode: hostResult.room.code,
          playerToken: joinResult.playerToken,
        }, (res: any) => {
          if (res.error) reject(new Error(res.error));
          else resolve(res);
        });
      })
    ).rejects.toThrow();
  });
});

describe("Solo multiplayer game", () => {
  it("allows a single player to play alone", async () => {
    const hostSocket = await connect();
    const hostResult = await createRoom(hostSocket, "SoloHost", { totalRounds: 3 });

    // Round 1
    const rsp1 = waitForEvent(hostSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp1;

    const endP1 = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const result1 = await endP1;
    expect(result1.playerResults.length).toBe(1);

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

    const entries = server.db
      .prepare("SELECT * FROM mp_leaderboard WHERE room_code = ?")
      .all(hostResult.room.code) as any[];
    expect(entries.length).toBe(1);
    expect(entries[0].placement).toBe(1);
  });
});

describe("Duplicate guess prevention", () => {
  it("rejects a second guess in the same round", async () => {
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

    await expect(
      submitGuess(hostSocket, { guessedPriceCents: 9999 })
    ).rejects.toThrow();
  });
});

describe("Non-host cannot start round", () => {
  it("rejects round start from non-host", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    await expect(startRound(joinerSocket)).rejects.toThrow();
  });
});

describe("Cannot join game in progress", () => {
  it("rejects joining a room that is playing", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    const lateSocket = await connect();
    await expect(
      joinRoom(lateSocket, hostResult.room.code, "LateJoiner")
    ).rejects.toThrow("Game is already in progress");
  });
});
