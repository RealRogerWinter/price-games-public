/**
 * Integration tests for disconnect and reconnect flows.
 *
 * Tests host promotion, reconnection with tokens, early round
 * termination when all remaining players have guessed, and
 * original creator host revert.
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

describe("Host disconnect and promotion", () => {
  it("promotes next player to host when host disconnects in lobby", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const hostChangedP = waitForEvent(joinerSocket, "room:host_changed");
    const playerLeftP = waitForEvent(joinerSocket, "room:player_left");

    await disconnectClient(hostSocket);

    const leftEvent = await playerLeftP;
    expect(leftEvent.playerId).toBe(hostResult.playerId);

    const hostChanged = await hostChangedP;
    expect(hostChanged.newHostId).toBeDefined();
    expect(hostChanged.newHostId).not.toBe(hostResult.playerId);
  });

  it("new host can start the game after promotion", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Set up listeners BEFORE disconnecting host
    const hostChangedP = waitForEvent(joinerSocket, "room:host_changed");
    const playerLeftP = waitForEvent(joinerSocket, "room:player_left");

    await disconnectClient(hostSocket);
    await playerLeftP;
    await hostChangedP;

    // New host starts the game
    const rsp = waitForEvent(joinerSocket, "game:round_start");
    await startRound(joinerSocket);
    const roundData = await rsp;
    expect(roundData.roundNumber).toBe(1);
  });
});

describe("Reconnection with token", () => {
  it("allows a disconnected player to rejoin with their token", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Disconnect the joiner
    const leftP = waitForEvent(hostSocket, "room:player_left");
    await disconnectClient(joinerSocket);
    await leftP;

    // Reconnect with new socket using saved token
    const newSocket = await connect();
    const reconnectedP = waitForEvent(hostSocket, "room:player_reconnected");

    const rejoinResult = await new Promise<any>((resolve, reject) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: joinResult.playerToken,
      }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });

    const reconnectedEvt = await reconnectedP;
    expect(reconnectedEvt.playerId).toBe(joinResult.playerId);
    expect(rejoinResult.playerId).toBe(joinResult.playerId);
    expect(rejoinResult.room.players).toHaveLength(2);
  });

  it("provides current round data when reconnecting mid-round", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();
    const thirdSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");
    await joinRoom(thirdSocket, hostResult.room.code, "Third");

    // Start a round
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    const rsp3 = waitForEvent(thirdSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;
    await rsp3;

    // Host submits a guess (but 2 others haven't, so round stays playing)
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });

    // Disconnect the joiner during the round (third still hasn't guessed)
    const leftP = waitForEvent(hostSocket, "room:player_left");
    await disconnectClient(joinerSocket);
    await leftP;

    // Room should still be playing (third hasn't guessed)
    const roomStatus = server.db.prepare("SELECT status FROM mp_rooms WHERE code = ?")
      .get(hostResult.room.code) as any;
    expect(roomStatus.status).toBe("playing");

    // Reconnect and verify round data is received
    const newSocket = await connect();
    const rejoinResult = await new Promise<any>((resolve, reject) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: joinResult.playerToken,
      }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });

    expect(rejoinResult.currentRoundData).toBeDefined();
    expect(rejoinResult.currentRoundData.roundNumber).toBe(1);
    expect(rejoinResult.guessedPlayerIds).toContain(hostResult.playerId);
  });
});

describe("Original creator host revert", () => {
  it("reverts host to original creator on reconnect", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Creator", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Disconnect original creator (host)
    const hostChangedP = waitForEvent(joinerSocket, "room:host_changed");
    await disconnectClient(hostSocket);
    await hostChangedP;

    // Reconnect the original creator
    const newCreatorSocket = await connect();
    const hostRevertP = waitForEvent(joinerSocket, "room:host_changed");

    await new Promise<any>((resolve, reject) => {
      newCreatorSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: hostResult.playerToken,
      }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });

    const revertEvent = await hostRevertP;
    expect(revertEvent.newHostId).toBe(hostResult.playerId);
  });
});

describe("Early round end on disconnect", () => {
  it("ends round early when disconnecting player is last without a guess", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Start round
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    // Host submits guess
    await submitGuess(hostSocket, { guessedPriceCents: 5000 });

    // Joiner disconnects without guessing — all remaining connected have guessed
    const endP = waitForEvent(hostSocket, "game:round_end");
    await disconnectClient(joinerSocket);

    const roundEnd = await endP;
    expect(roundEnd.roundNumber).toBe(1);
    expect(roundEnd.playerResults.length).toBe(2);

    // Joiner should have score 0 (timed out / didn't guess)
    const joinerResult = roundEnd.playerResults.find((p: any) => p.displayName === "Joiner");
    expect(joinerResult.score).toBe(0);
  });

  it("ends round when all players disconnect", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Start round
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    // Both disconnect — round ends
    await disconnectClient(joinerSocket);
    await disconnectClient(hostSocket);

    // Wait for disconnect processing
    await new Promise(r => setTimeout(r, 200));

    // Room should be deleted since no connected players remain
    const room = server.db.prepare("SELECT status FROM mp_rooms WHERE code = ?").get(hostResult.room.code) as any;
    expect(room).toBeUndefined();
  });
});

describe("Kicked player cannot rejoin", () => {
  it("rejects reconnection with kicked player's token", async () => {
    const hostSocket = await connect();
    const joinerSocket = await connect();

    const hostResult = await createRoom(hostSocket, "Host");
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Kick the joiner
    const kickedP = waitForEvent(joinerSocket, "room:player_kicked");
    await new Promise<void>((resolve, reject) => {
      hostSocket.emit("room:kick", { playerId: joinResult.playerId }, (res: any) => {
        if (res.error) reject(new Error(res.error));
        else resolve();
      });
    });
    await kickedP;

    await disconnectClient(joinerSocket);

    // Try to rejoin with kicked token
    const newSocket = await connect();
    const response = await new Promise<any>((resolve) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: joinResult.playerToken,
      }, resolve);
    });
    expect(response.error).toBe(true);
    expect(response.code).toBe("kicked");
  });
});

describe("Disconnect grace period", () => {
  /**
   * Spin up a fresh server with a longer grace window so we can test
   * the "reconnect inside the window is invisible" path. Must also
   * tear it down at the end so the default-grace suite isn't affected.
   */
  let graceServer: TestServer;
  let graceSockets: ClientSocket[] = [];

  async function graceConnect(): Promise<ClientSocket> {
    const s = await connectClient(graceServer.url);
    graceSockets.push(s);
    return s;
  }

  beforeEach(async () => {
    graceServer = await createTestServer(50, { disconnectGraceMs: 500 });
    graceSockets = [];
  });

  afterEach(async () => {
    for (const s of graceSockets) {
      if (s.connected) await disconnectClient(s);
    }
    graceSockets = [];
    await closeTestServer(graceServer);
  });

  it("does not broadcast player_left when the player reconnects within the grace window", async () => {
    const hostSocket = await graceConnect();
    const joinerSocket = await graceConnect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const leftEvents: any[] = [];
    hostSocket.on("room:player_left", (e) => leftEvents.push(e));
    const reconEvents: any[] = [];
    hostSocket.on("room:player_reconnected", (e) => reconEvents.push(e));

    await disconnectClient(joinerSocket);

    // Reconnect well inside the 500ms grace window.
    const newSocket = await graceConnect();
    const response = await new Promise<any>((resolve) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: joinResult.playerToken,
      }, resolve);
    });
    expect(response.error).toBeUndefined();
    expect(response.playerId).toBe(joinResult.playerId);

    // Wait past the grace window to be sure no deferred leave fires.
    await new Promise((r) => setTimeout(r, 700));
    expect(leftEvents).toHaveLength(0);
    // Sub-grace reconnects skip the reconnected broadcast too — the
    // roster never appeared to change for other clients.
    expect(reconEvents).toHaveLength(0);

    // DB should show the player as still connected.
    const playerRow = graceServer.db.prepare("SELECT connected FROM mp_players WHERE id = ?")
      .get(joinResult.playerId) as { connected: number };
    expect(playerRow.connected).toBe(1);
  });

  it("broadcasts player_left after grace expires if the player has not reconnected", async () => {
    const hostSocket = await graceConnect();
    const joinerSocket = await graceConnect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const leftP = waitForEvent(hostSocket, "room:player_left", 3000);
    await disconnectClient(joinerSocket);

    const event = await leftP;
    expect(event.playerId).toBe(joinResult.playerId);
  });

  it("two rapid disconnects for the same player produce exactly one leave broadcast", async () => {
    const hostSocket = await graceConnect();
    const joinerSocket = await graceConnect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    const leftEvents: any[] = [];
    hostSocket.on("room:player_left", (e) => {
      if (e.playerId === joinResult.playerId) leftEvents.push(e);
    });

    // Joiner drops, reconnects quickly, then drops again — all inside
    // the grace window. The second drop re-arms the timer; only the
    // latest pending work should run once the timer fires.
    await disconnectClient(joinerSocket);

    const rejoin1 = await graceConnect();
    await new Promise<any>((resolve) => {
      rejoin1.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: joinResult.playerToken,
      }, resolve);
    });
    await disconnectClient(rejoin1);

    // Wait well past the 500ms grace window.
    await new Promise((r) => setTimeout(r, 800));

    // The second disconnect was never followed by a rejoin, so we
    // expect exactly one leave broadcast — not two (i.e., the first
    // pending timer must have been cancelled, not fired concurrently).
    expect(leftEvents).toHaveLength(1);
  });

  it("does not end the round early during the grace window", async () => {
    const hostSocket = await graceConnect();
    const joinerSocket = await graceConnect();

    const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
    await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

    // Start round; host guesses; joiner drops without guessing.
    const rsp = waitForEvent(hostSocket, "game:round_start");
    const rsp2 = waitForEvent(joinerSocket, "game:round_start");
    await startRound(hostSocket);
    await rsp;
    await rsp2;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });

    let roundEndFired = false;
    hostSocket.on("game:round_end", () => { roundEndFired = true; });

    await disconnectClient(joinerSocket);

    // Within the grace window, the round must not end — the joiner is
    // still considered present and might come back to guess.
    await new Promise((r) => setTimeout(r, 100));
    expect(roundEndFired).toBe(false);
  });
});

describe("Typed rejoin error codes", () => {
  it("returns invalid_token for an unknown playerToken", async () => {
    const hostSocket = await connect();
    const hostResult = await createRoom(hostSocket, "Host");

    const newSocket = await connect();
    const response = await new Promise<any>((resolve) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: "not-a-real-token",
      }, resolve);
    });
    expect(response.error).toBe(true);
    expect(response.code).toBe("invalid_token");
  });

  it("returns invalid_token when both the player and room have been cleaned up", async () => {
    const hostSocket = await connect();
    const hostResult = await createRoom(hostSocket, "Host");

    // Cascade cleanup: remove players first (FK), then the room.
    server.db.prepare("DELETE FROM mp_players WHERE room_code = ?").run(hostResult.room.code);
    server.db.prepare("DELETE FROM mp_rooms WHERE code = ?").run(hostResult.room.code);

    const newSocket = await connect();
    const response = await new Promise<any>((resolve) => {
      newSocket.emit("room:rejoin", {
        roomCode: hostResult.room.code,
        playerToken: hostResult.playerToken,
      }, resolve);
    });
    expect(response.error).toBe(true);
    // The player row is gone so the lookup fails with invalid_token
    // before the room check runs. The important guarantee is that
    // the error is TYPED rather than the old generic string.
    expect(response.code).toBe("invalid_token");
  });
});
