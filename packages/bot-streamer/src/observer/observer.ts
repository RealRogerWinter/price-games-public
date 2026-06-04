/**
 * Observer — wraps a Socket.IO-like client, listens for the room +
 * gameplay events the server emits, and folds them into a typed
 * BotStateSnapshot. Strategies and the lifecycle controller consume the
 * snapshot via `getState()` or by subscribing to `onChange()`.
 *
 * The interface is deliberately decoupled from `socket.io-client`:
 * `SocketLike` is the smallest contract we need. That makes it trivial
 * to drive the observer in unit tests with `fakeSocket` and to swap the
 * transport later (e.g. for a node-side client during integration tests).
 */

import { SOCKET_EVENTS } from "@price-game/shared";
import type {
  Avatar,
  RoundStartPayload,
  RoundResultsPayload,
  BiddingTurnPayload,
  MultiplayerRoom,
  MultiplayerPlayer,
} from "@price-game/shared";
import {
  INITIAL_BOT_STATE,
  type BotStateSnapshot,
  type RoomSnapshot,
} from "./types";

/** Subset of `room:player_joined` we depend on (server emits more). */
interface RoomPlayerJoinedPayload {
  playerId: string;
  displayName: string;
  avatar: Avatar;
}

/** Subset of `game:player_locked`. */
interface PlayerLockedPayload {
  playerId: string;
}

/** Subset of `game:over`. */
interface GameOverPayload {
  results?: RoundResultsPayload;
  roomCode?: string;
}

/**
 * Minimal Socket.IO-like surface the observer needs. Real sockets, fake
 * sockets, and EventEmitters all satisfy this with a thin adapter.
 */
export interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

export type ObserverListener = (state: BotStateSnapshot) => void;

interface ObserverOptions {
  /** Called once per state mutation. The full new snapshot is passed. */
  onChange?: ObserverListener;
  /**
   * Optional clock for deterministic tests. Defaults to Date.now.
   * Returns the current time in ms since epoch.
   */
  now?: () => number;
  /**
   * Bot persona display name. When set, the observer auto-binds
   * `myPlayerId` on the first `ROOM_UPDATED` whose players list
   * contains an entry with `displayName === personaName`. Without
   * this binding, every consumer that gates on `myPlayerId`
   * (`onPlayerLocked`, the bidding seat-matching wait in the
   * driver, MP win attribution) silently degrades to its
   * fallback path — most painfully, the bidding seat-matching
   * wait burns a full 90s on every round before falling through
   * to whatever turn payload is current (usually turn 0).
   *
   * Sticky: once bound, subsequent ROOM_UPDATED with a colliding
   * displayName cannot rebind. Defends against a real-MP join
   * where two players happened to enter the same name.
   */
  personaName?: string;
}

/**
 * Wire up an observer to a SocketLike. Returns a handle the caller can
 * use to read the current state, subscribe to changes, and detach.
 *
 * Listeners attached during initialisation are kept stable — the
 * observer itself does not register/deregister handlers more than once.
 *
 * @param socket SocketLike implementation. Must support `on` and `off`.
 * @param opts See {@link ObserverOptions}.
 * @returns Handle with `getState()`, `onChange()`, `dispose()`.
 */
export function attachObserver(socket: SocketLike, opts: ObserverOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  let state: BotStateSnapshot = { ...INITIAL_BOT_STATE };
  const listeners = new Set<ObserverListener>();
  if (opts.onChange) listeners.add(opts.onChange);

  function set(next: BotStateSnapshot): void {
    state = next;
    for (const fn of listeners) fn(state);
  }

  function snapshotRoom(room: MultiplayerRoom): RoomSnapshot {
    return {
      roomCode: room.code,
      hostId: room.hostPlayerId ?? null,
      players: room.players,
      gameMode: room.gameMode,
      totalRounds: room.totalRounds,
      currentRound: room.currentRound ?? 0,
      status: room.status,
    };
  }

  // Handlers — each mutates `state` via `set()` and ignores events that
  // are inapplicable to the current phase rather than throwing. The bot
  // lives 24/7; defensive merging is more useful than strict assertions.

  function onRoomUpdated(payload: unknown): void {
    const room = payload as MultiplayerRoom | undefined;
    if (!room) return;
    // Map every RoomStatus value explicitly so a future addition of a
    // status (or a transient "ending" emission during round teardown)
    // doesn't silently fall through to "in_lobby" and confuse a strategy
    // that gates behaviour on `phase`.
    let phase: BotStateSnapshot["phase"];
    switch (room.status) {
      case "lobby":
        phase = "in_lobby";
        break;
      case "playing":
        // Preserve in_round when the round_start handler has already
        // flipped us. The "playing" status persists across round_start
        // and round_end events, so we can't infer in_round vs
        // between_rounds from status alone.
        phase = state.phase === "in_round" ? "in_round" : "between_rounds";
        break;
      case "ending":
      case "between_rounds":
        phase = "between_rounds";
        break;
      case "finished":
        phase = "game_over";
        break;
    }
    // Auto-bind myPlayerId on the first ROOM_UPDATED that names us.
    // The bot enters the room with displayName=personaName (see
    // `executeQuickplayBidding` and the join paths); the server's
    // first room snapshot includes us with our server-issued id,
    // which is what the bidding seat-matching wait + lastResult
    // attribution + onPlayerLocked all need to compare against.
    // Sticky: never overwrite once bound, even if a later
    // ROOM_UPDATED contains a colliding displayName from a
    // real-MP joiner who happened to pick the same name.
    let nextMyPlayerId = state.myPlayerId;
    if (nextMyPlayerId === null && opts.personaName) {
      const me = room.players.find((p) => p.displayName === opts.personaName);
      if (me) nextMyPlayerId = me.id;
    }
    set({ ...state, phase, room: snapshotRoom(room), myPlayerId: nextMyPlayerId });
  }

  function onPlayerJoined(payload: unknown): void {
    const p = payload as RoomPlayerJoinedPayload | undefined;
    // Server invariant: ROOM_UPDATED is always emitted before any
    // ROOM_PLAYER_JOINED for that room. If we see a join without a room
    // it's a misordered emission or our own listener wasn't attached
    // yet — either way the next ROOM_UPDATED will carry the canonical
    // player list, so dropping the join here is safe.
    if (!p || !state.room) return;
    // Deduplicate — server occasionally re-emits joins on rejoin.
    if (state.room.players.some((pl) => pl.id === p.playerId)) return;
    const newPlayer: MultiplayerPlayer = {
      id: p.playerId,
      displayName: p.displayName,
      avatar: p.avatar,
      isHost: false,
      isConnected: true,
      totalScore: 0,
      isBot: false,
    };
    set({
      ...state,
      room: { ...state.room, players: [...state.room.players, newPlayer] },
    });
  }

  function onRoundStart(payload: unknown): void {
    const p = payload as RoundStartPayload | undefined;
    if (!p) return;
    set({
      ...state,
      phase: "in_round",
      round: { payload: p, receivedAt: now(), submitted: false },
      bidding: null,
      lastResult: null,
    });
  }

  function onPlayerLocked(payload: unknown): void {
    const p = payload as PlayerLockedPayload | undefined;
    if (!p || !state.round) return;
    if (p.playerId !== state.myPlayerId) return;
    set({ ...state, round: { ...state.round, submitted: true } });
  }

  function onRoundEnd(payload: unknown): void {
    const p = payload as RoundResultsPayload | undefined;
    if (!p) return;
    set({
      ...state,
      phase: "between_rounds",
      round: null,
      bidding: null,
      lastResult: { payload: p, receivedAt: now() },
    });
  }

  function onBiddingTurn(payload: unknown): void {
    const p = payload as BiddingTurnPayload | undefined;
    if (!p) return;
    set({ ...state, bidding: { turn: p, receivedAt: now() } });
  }

  function onBidPlaced(_payload: unknown): void {
    // TODO(claude, 2026-05-04): track running bid history on the
    // BiddingSnapshot so the bidding strategy can compute "highest
    // standing bid" without round-tripping through round_end. Wiring
    // this in PR 10 (bidding strategy) once it has a concrete consumer.
  }

  function onGameOver(payload: unknown): void {
    const p = payload as GameOverPayload | undefined;
    set({
      ...state,
      phase: "game_over",
      lastResult: p?.results ? { payload: p.results, receivedAt: now() } : state.lastResult,
    });
  }

  // Map: socket-event name → handler. Each handler matches the
  // SocketLike `(payload: unknown) => void` signature.
  const bindings: Array<[string, (payload: unknown) => void]> = [
    [SOCKET_EVENTS.ROOM_UPDATED, onRoomUpdated],
    [SOCKET_EVENTS.ROOM_PLAYER_JOINED, onPlayerJoined],
    [SOCKET_EVENTS.GAME_ROUND_START, onRoundStart],
    [SOCKET_EVENTS.GAME_PLAYER_LOCKED, onPlayerLocked],
    [SOCKET_EVENTS.GAME_ROUND_END, onRoundEnd],
    [SOCKET_EVENTS.GAME_BIDDING_TURN, onBiddingTurn],
    [SOCKET_EVENTS.GAME_BID_PLACED, onBidPlaced],
    [SOCKET_EVENTS.GAME_OVER, onGameOver],
  ];
  for (const [name, fn] of bindings) socket.on(name, fn);

  return {
    /** Returns the current snapshot. Always defined. */
    getState(): BotStateSnapshot {
      return state;
    },
    /** Subscribe to future state changes. Returns an unsubscribe fn. */
    onChange(listener: ObserverListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Bind the bot's own player id once it's been issued by the server.
     * The player id is needed so onPlayerLocked can recognise our own
     * lock and not flip `submitted` on every other player's submission.
     */
    setMyPlayerId(id: string | null): void {
      set({ ...state, myPlayerId: id });
    },
    /**
     * Clear round/lastResult/bidding so the next plan starts from a
     * clean slate. Solo modes never emit `game:round_end`, so the last
     * round's payload would otherwise sit in `state.round` and be
     * served back to `waitForRoundStart` on the next plan — causing the
     * strategy to compute on stale product IDs that aren't in the new
     * plan's DOM. Room snapshot and `myPlayerId` are deliberately
     * preserved (still session-scoped, repopulated by the next
     * `room:updated`).
     */
    resetGameplayState(): void {
      set({ ...state, round: null, lastResult: null, bidding: null });
    },
    /** Detach all socket listeners and clear in-memory subscribers. */
    dispose(): void {
      for (const [name, fn] of bindings) socket.off(name, fn);
      listeners.clear();
    },
  };
}

export type Observer = ReturnType<typeof attachObserver>;
