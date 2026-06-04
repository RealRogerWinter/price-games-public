import { describe, it, expect } from "vitest";
import { SOCKET_EVENTS } from "@price-game/shared";
import { attachObserver } from "../src/observer/observer";
import { createFakeSocket } from "../src/test-helpers/fakeSocket";
import { makeRoom, makeRoundStart, makeRoundResults, SAMPLE_AVATAR } from "../src/test-helpers/fixtures";

describe("observer", () => {
  it("starts in the disconnected phase with empty room/round/result", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    const s = obs.getState();
    expect(s.phase).toBe("disconnected");
    expect(s.room).toBeNull();
    expect(s.round).toBeNull();
    expect(s.bidding).toBeNull();
    expect(s.lastResult).toBeNull();
  });

  it("registers listeners for every observed socket event", () => {
    const sock = createFakeSocket();
    attachObserver(sock);
    expect(sock.handlerCount(SOCKET_EVENTS.ROOM_UPDATED)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.ROOM_PLAYER_JOINED)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_ROUND_START)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_ROUND_END)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_BIDDING_TURN)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_OVER)).toBe(1);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_PLAYER_LOCKED)).toBe(1);
  });

  it("flips to in_lobby when room:updated arrives with a lobby room", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({ status: "lobby" }));
    const s = obs.getState();
    expect(s.phase).toBe("in_lobby");
    expect(s.room?.roomCode).toBe("ABCDEF");
    expect(s.room?.gameMode).toBe("classic");
  });

  it("appends a joined player and dedupes repeats", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom());
    sock.emit(SOCKET_EVENTS.ROOM_PLAYER_JOINED, {
      playerId: "p2",
      displayName: "Eve",
      avatar: SAMPLE_AVATAR,
    });
    expect(obs.getState().room?.players).toHaveLength(1);
    sock.emit(SOCKET_EVENTS.ROOM_PLAYER_JOINED, {
      playerId: "p2",
      displayName: "Eve",
      avatar: SAMPLE_AVATAR,
    });
    // Same id — must not dupe.
    expect(obs.getState().room?.players).toHaveLength(1);
  });

  it("flips to in_round on game:round_start and clears stale lastResult", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock, { now: () => 12345 });
    sock.emit(SOCKET_EVENTS.GAME_ROUND_END, makeRoundResults());
    expect(obs.getState().lastResult).not.toBeNull();
    sock.emit(SOCKET_EVENTS.GAME_ROUND_START, makeRoundStart());
    const s = obs.getState();
    expect(s.phase).toBe("in_round");
    expect(s.round?.payload.roundNumber).toBe(1);
    expect(s.round?.receivedAt).toBe(12345);
    expect(s.round?.submitted).toBe(false);
    expect(s.lastResult).toBeNull();
  });

  it("auto-binds myPlayerId on the first ROOM_UPDATED whose players contain our personaName", () => {
    // Critical for the bidding seat-matching wait at playwrightDriver.ts:~1510 —
    // without myPlayerId bound, isOurTurn always returns false and every
    // bidding round burns a full 90s before the wait fires its timer
    // fall-through. The driver passes personaName when wiring the observer
    // so this binding happens automatically on room creation/join.
    const sock = createFakeSocket();
    const obs = attachObserver(sock, { personaName: "Pricey" });
    expect(obs.getState().myPlayerId).toBeNull();
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({
      players: [
        { id: "bot-1", displayName: "Pricey", avatar: SAMPLE_AVATAR, isHost: true, isConnected: true, totalScore: 0, isBot: false },
        { id: "npc-2", displayName: "Bot 1", avatar: SAMPLE_AVATAR, isHost: false, isConnected: true, totalScore: 0, isBot: true },
      ],
    }));
    expect(obs.getState().myPlayerId).toBe("bot-1");
  });

  it("does not auto-bind when no player matches the personaName", () => {
    // Real-MP join might land us in a room before our own player record
    // arrives (rare race). Stay null so consumers fall through to their
    // safe-default branches; the next ROOM_UPDATED fixes us.
    const sock = createFakeSocket();
    const obs = attachObserver(sock, { personaName: "Pricey" });
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({
      players: [
        { id: "human-1", displayName: "Alice", avatar: SAMPLE_AVATAR, isHost: true, isConnected: true, totalScore: 0, isBot: false },
      ],
    }));
    expect(obs.getState().myPlayerId).toBeNull();
  });

  it("auto-binding is sticky — a colliding displayName cannot rebind", () => {
    // Defends against a real-MP join where a later joiner happens to pick
    // the same display name. Once we know our id from the first match,
    // it cannot be reassigned.
    const sock = createFakeSocket();
    const obs = attachObserver(sock, { personaName: "Pricey" });
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({
      players: [{ id: "bot-1", displayName: "Pricey", avatar: SAMPLE_AVATAR, isHost: true, isConnected: true, totalScore: 0, isBot: false }],
    }));
    expect(obs.getState().myPlayerId).toBe("bot-1");
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({
      players: [
        { id: "bot-1", displayName: "Pricey", avatar: SAMPLE_AVATAR, isHost: true, isConnected: true, totalScore: 0, isBot: false },
        { id: "human-2", displayName: "Pricey", avatar: SAMPLE_AVATAR, isHost: false, isConnected: true, totalScore: 0, isBot: false },
      ],
    }));
    expect(obs.getState().myPlayerId).toBe("bot-1");
  });

  it("does not auto-bind when no personaName option is provided", () => {
    // Backwards-compatible: tests / consumers that don't pass personaName
    // get the previous (null) behaviour, so existing callers don't have
    // to be updated all at once.
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({
      players: [{ id: "bot-1", displayName: "Pricey", avatar: SAMPLE_AVATAR, isHost: true, isConnected: true, totalScore: 0, isBot: false }],
    }));
    expect(obs.getState().myPlayerId).toBeNull();
  });

  it("flips submitted=true only when the locked player matches our id", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    obs.setMyPlayerId("me");
    sock.emit(SOCKET_EVENTS.GAME_ROUND_START, makeRoundStart());
    sock.emit(SOCKET_EVENTS.GAME_PLAYER_LOCKED, { playerId: "someone-else" });
    expect(obs.getState().round?.submitted).toBe(false);
    sock.emit(SOCKET_EVENTS.GAME_PLAYER_LOCKED, { playerId: "me" });
    expect(obs.getState().round?.submitted).toBe(true);
  });

  it("captures lastResult and clears the in-flight round on game:round_end", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.GAME_ROUND_START, makeRoundStart());
    sock.emit(SOCKET_EVENTS.GAME_ROUND_END, makeRoundResults());
    const s = obs.getState();
    expect(s.phase).toBe("between_rounds");
    expect(s.round).toBeNull();
    expect(s.lastResult?.payload.roundNumber).toBe(1);
  });

  it("captures bidding turn on game:bidding_turn", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock, { now: () => 999 });
    sock.emit(SOCKET_EVENTS.GAME_BIDDING_TURN, {
      currentPlayerId: "p1",
      turnIndex: 0,
      totalPlayers: 3,
      timerSeconds: 20,
      previousBids: [],
    });
    expect(obs.getState().bidding?.turn.currentPlayerId).toBe("p1");
    expect(obs.getState().bidding?.receivedAt).toBe(999);
  });

  it("treats room status 'ending' as between_rounds, not lobby", () => {
    // Regression: the ternary chain previously fell through to "in_lobby"
    // for unhandled statuses. The server actually emits status="ending"
    // during round teardown, so any strategy gating on phase would
    // momentarily flip to lobby and reset.
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({ status: "ending" }));
    expect(obs.getState().phase).toBe("between_rounds");
  });

  it("transitions to game_over on game:over", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    sock.emit(SOCKET_EVENTS.GAME_OVER, { results: makeRoundResults(), roomCode: "ABCDEF" });
    expect(obs.getState().phase).toBe("game_over");
    expect(obs.getState().lastResult?.payload.roundNumber).toBe(1);
  });

  it("notifies onChange listeners for every mutation", () => {
    const sock = createFakeSocket();
    const seen: string[] = [];
    const obs = attachObserver(sock, {
      onChange: (s) => seen.push(s.phase),
    });
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({ status: "lobby" }));
    sock.emit(SOCKET_EVENTS.GAME_ROUND_START, makeRoundStart());
    sock.emit(SOCKET_EVENTS.GAME_ROUND_END, makeRoundResults());
    expect(seen).toEqual(["in_lobby", "in_round", "between_rounds"]);
    obs.dispose();
  });

  it("dispose() detaches every socket listener", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    obs.dispose();
    expect(sock.handlerCount(SOCKET_EVENTS.ROOM_UPDATED)).toBe(0);
    expect(sock.handlerCount(SOCKET_EVENTS.GAME_ROUND_START)).toBe(0);
  });

  it("resetGameplayState() clears round/lastResult/bidding but keeps room and myPlayerId", () => {
    const sock = createFakeSocket();
    const obs = attachObserver(sock);
    obs.setMyPlayerId("me");
    sock.emit(SOCKET_EVENTS.ROOM_UPDATED, makeRoom({ status: "lobby" }));
    sock.emit(SOCKET_EVENTS.GAME_ROUND_START, makeRoundStart());
    sock.emit(SOCKET_EVENTS.GAME_BIDDING_TURN, {
      currentPlayerId: "p1",
      timerSeconds: 10,
      currentBidCents: 0,
      minIncrementCents: 100,
    });
    sock.emit(SOCKET_EVENTS.GAME_ROUND_END, makeRoundResults());
    expect(obs.getState().lastResult).not.toBeNull();
    obs.resetGameplayState();
    const s = obs.getState();
    expect(s.round).toBeNull();
    expect(s.lastResult).toBeNull();
    expect(s.bidding).toBeNull();
    // Session-scoped fields preserved.
    expect(s.myPlayerId).toBe("me");
    expect(s.room?.roomCode).toBe("ABCDEF");
  });
});
