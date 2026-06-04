import { useState, useEffect, useCallback, useRef } from "react";
import type {
  MultiplayerPlayer,
  MultiplayerRoom,
  GameMode,
  RoundStartPayload,
  RoundResultsPayload,
  BotDifficulty,
  BiddingTurnPayload,
  BidPlacedPayload,
  RejoinErrorCode,
  JoinSource,
} from "@price-game/shared";
import { SOCKET_EVENTS } from "@price-game/shared";
import {
  getSocket,
  connectSocket,
  disconnectSocket,
  savePlayerSession,
  getPlayerSession,
  clearPlayerSession,
} from "../api/socket";
import { useConnectionLifecycle } from "./useConnectionLifecycle";
import type { MultiplayerGameHandlers } from "./useMultiplayerGame";
import { soundEngine } from "../audio/SoundEngine";
import { getOrCreateGuestIdentity } from "../utils/guestIdentity";

/**
 * Resolve the avatar an anonymous client should request when creating or
 * joining a room. Logged-in users' avatars are still handled server-side
 * from their account preference — the server ignores `preferredAvatar` in
 * that case — so this only matters for guests.
 *
 * Returns `undefined` when no guest identity is available (e.g. SSR), which
 * the server treats as "pick a random avatar for me."
 */
function resolveGuestAvatar(): string | undefined {
  try {
    return getOrCreateGuestIdentity().avatar;
  } catch {
    return undefined;
  }
}

/**
 * Connection status as tracked by the socket layer.
 *
 * - `connected` — socket open AND room state has been successfully
 *   rehydrated (either via rejoin ack or a fresh join).
 * - `reconnecting` — socket is dropping/retrying at the transport level.
 * - `resyncing` — socket reopened, rejoin emitted, waiting for ack.
 * - `rejoin_failed` — rejoin ack came back with an error (or timed
 *   out). The UI surfaces `rejoinErrorCode` so the user sees a real
 *   reason rather than being silently navigated home.
 * - `disconnected` — all reconnect attempts exhausted; manual retry only.
 */
export type ConnectionStatus =
  | "connected"
  | "reconnecting"
  | "resyncing"
  | "rejoin_failed"
  | "disconnected";

/** How long we'll wait for a `ROOM_REJOIN` ack before calling it a timeout. */
const REJOIN_ACK_TIMEOUT_MS = 8000;

/** Actions the page component can invoke to interact with the server. */
export interface MultiplayerSocketActions {
  createRoom: (displayName: string, gameMode: GameMode, options?: { categories?: string[]; password?: string; totalRounds?: number; isPublic?: boolean; autoStart?: { botCount: number; botDifficulty: BotDifficulty }; dailyDate?: string }) => void;
  joinRoom: (
    code: string,
    displayName: string,
    password?: string,
    /**
     * How the user reached this join attempt. Forwarded to the server so
     * v2 analytics can break down room arrivals by acquisition path.
     * Defaults to 'browser' when omitted.
     */
    source?: JoinSource,
  ) => void;
  startRound: () => void;
  submitGuess: (guessData: any) => void;
  submitBid: (bidCents: number) => void;
  kickPlayer: (targetId: string) => void;
  changeSettings: (settings: { gameMode?: GameMode; categories?: string[] | null; totalRounds?: number; password?: string | null; isPublic?: boolean }) => void;
  configureBots: (botCount: number, botDifficulty: BotDifficulty) => void;
  continueFromResults: () => void;
  playAgain: () => void;
  /**
   * Instant re-queue after a quick play match. Tears down the finished room
   * connection, then either joins an existing public lobby or spins up a
   * fresh room + bots + auto-start with the same settings as the original
   * quick play session. No-op if the current game didn't originate from
   * quick play (caller should fall back to `playAgain` in that case).
   */
  playQuickPlayAgain: () => void;
  leave: () => void;
  manualReconnect: () => void;
}

/**
 * Custom hook that manages Socket.IO connection lifecycle, event listeners,
 * and emission helpers for multiplayer rooms.
 *
 * @param gameHandlers - state-update handlers from useMultiplayerGame
 * @param onLeave - callback invoked when the player should navigate away
 * @param urlRoomCode - optional room code from the URL for auto-rejoin
 * @param isInActiveRound - true when the player is on a mid-round screen
 *   (`playing` / `round_result`). Threaded into `useConnectionLifecycle`
 *   so the visibility-hidden disconnect timer ONLY arms during an active
 *   round, and used to guard the `game_over` / `round_start` listeners
 *   from yanking the user back into a game they've already left.
 * @returns connection state and action functions
 */
export function useMultiplayerSocket(
  gameHandlers: MultiplayerGameHandlers,
  onLeave: () => void,
  urlRoomCode?: string,
  isInActiveRound: boolean = false
): {
  connectionStatus: ConnectionStatus;
  reconnectAttempt: number;
  rejoinErrorCode: RejoinErrorCode | "timeout" | null;
  actions: MultiplayerSocketActions;
} {
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const intentionalDisconnectRef = useRef(false);
  const inRoomRef = useRef(false);
  // Track the URL room code through a ref so the `onGameOver` /
  // `onRoundStart` listeners can compare the current `window.location`
  // against the room they were registered for. If the user navigated
  // away (path no longer ends with the room code), a late server event
  // for the abandoned game must not auto-yank them back.
  const urlRoomCodeRef = useRef(urlRoomCode);
  urlRoomCodeRef.current = urlRoomCode;

  // Connection state — React state for re-renders
  const [connectionStatus, setConnectionStatusState] = useState<ConnectionStatus>("connected");
  const [reconnectAttempt, setReconnectAttemptState] = useState(0);
  const [rejoinErrorCode, setRejoinErrorCode] = useState<RejoinErrorCode | "timeout" | null>(null);

  // Stable reference to game handlers so listeners don't go stale
  const handlersRef = useRef(gameHandlers);
  handlersRef.current = gameHandlers;

  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  /**
   * Set up all socket event listeners on the given socket.
   * Previous listeners are cleaned up before new ones are registered.
   */
  function setupSocketListeners(socket: ReturnType<typeof connectSocket>) {
    cleanupListenersRef.current?.();

    const h = handlersRef.current;

    /**
     * True if the player has navigated/intentionally left the room —
     * detected by an explicit-leave flag, a cleared MP session, or the
     * current URL no longer pointing at the room we registered the
     * listeners for. Used to suppress server-driven screen transitions
     * (`round_start`, `game_over`) that arrive in the brief window
     * between `actions.leave()` and unmount.
     */
    const hasExplicitlyLeft = (): boolean => {
      if (intentionalDisconnectRef.current) return true;
      if (!getPlayerSession()) return true;
      const code = urlRoomCodeRef.current;
      if (code && typeof window !== "undefined") {
        // Room URL pattern: `/{ROOMCODE}` (case-insensitive). If the
        // pathname no longer ends with the captured room code, the user
        // is on a different route (home, /mp, /scoreboard, etc.).
        const path = window.location.pathname.toLowerCase();
        if (!path.endsWith(`/${code.toLowerCase()}`)) return true;
      }
      return false;
    };

    const onPlayerJoined = ({ player }: { player: MultiplayerPlayer }) => {
      if (!mountedRef.current) return;
      h.handlePlayerJoined(player);
      soundEngine.play("player_join");
    };

    const onPlayerLeft = ({ playerId: leftId }: { playerId: string }) => {
      if (!mountedRef.current) return;
      h.handlePlayerLeft(leftId);
      soundEngine.play("player_leave");
    };

    const onPlayerReconnected = ({ playerId: reconId }: { playerId: string }) => {
      if (!mountedRef.current) return;
      h.handlePlayerReconnected(reconId);
    };

    const onPlayerKicked = ({ playerId: kickedId }: { playerId: string }) => {
      if (!mountedRef.current) return;
      h.handlePlayerKicked(kickedId);
      // If we were kicked, go home
      if (kickedId === handlersRef.current.getPlayerId()) {
        intentionalDisconnectRef.current = true;
        clearPlayerSession();
        disconnectSocket();
        onLeaveRef.current();
      }
    };

    const onHostChanged = ({ newHostId }: { newHostId: string }) => {
      if (!mountedRef.current) return;
      h.handleHostChanged(newHostId);
    };

    const onSettingsUpdated = (data: { gameMode: GameMode; categories: string[] | null; totalRounds: number; hasPassword: boolean; isPublic?: boolean }) => {
      if (!mountedRef.current) return;
      h.handleSettingsUpdated(data);
    };

    const onRoomUpdated = (updatedRoom: MultiplayerRoom) => {
      if (!mountedRef.current) return;
      h.handleRoomUpdated(updatedRoom);
    };

    const onRoundStart = (payload: RoundStartPayload) => {
      if (!mountedRef.current) return;
      // Suppress auto-screen-transition if the user has navigated away
      // (no MP session OR URL no longer matches the room route). The
      // listener can still fire briefly between `actions.leave()` and
      // the unmount cleanup running, and during that window the server
      // may legitimately deliver a `round_start` for the next round in
      // the room they JUST left — without the guard, the player gets
      // yanked back into a game they explicitly closed.
      if (hasExplicitlyLeft()) return;
      h.handleRoundStart(payload);
      soundEngine.play("round_start");
    };

    const onPlayerContinued = ({ playerId: contId }: { playerId: string }) => {
      if (!mountedRef.current) return;
      h.handlePlayerContinued(contId);
    };

    const onPlayerLocked = ({ playerId: lockedId }: { playerId: string }) => {
      if (!mountedRef.current) return;
      h.handlePlayerLocked(lockedId);
      soundEngine.play("player_locked");
    };

    const onRoundEnd = (results: RoundResultsPayload) => {
      if (!mountedRef.current) return;
      h.handleRoundEnd(results);
      soundEngine.play("round_end_mp");
    };

    const onGameOver = ({ results }: { results: RoundResultsPayload; roomCode: string }) => {
      if (!mountedRef.current) return;
      // Same suppression rationale as `onRoundStart`. A `game_over`
      // event for the abandoned room would otherwise transition the
      // user back to the multiplayer game-over screen even if they're
      // already on a different page — the rejoin banner remains the
      // only sanctioned way back into a finished room.
      if (hasExplicitlyLeft()) return;
      h.handleGameOver(results);
      soundEngine.play("game_over");
    };

    const onBotsUpdated = (data: { botCount: number; botDifficulty: string; players: MultiplayerPlayer[] }) => {
      if (!mountedRef.current) return;
      h.handleBotsUpdated(data);
    };

    const onBiddingTurn = (payload: BiddingTurnPayload) => {
      if (!mountedRef.current) return;
      h.handleBiddingTurn(payload);
      soundEngine.play("spotlight_activate");
    };

    const onBidPlaced = (payload: BidPlacedPayload) => {
      if (!mountedRef.current) return;
      h.handleBidPlaced(payload);
      soundEngine.play("bid_reveal");
    };

    const onDisconnect = (reason: string) => {
      if (!mountedRef.current) return;
      if (reason === "io client disconnect" || intentionalDisconnectRef.current) return;
      setConnectionStatusState("reconnecting");
      setReconnectAttemptState(0);
    };

    /**
     * `connect` event fires on reconnection (the initial connect
     * already happened before listeners are set up). We stay in
     * `"resyncing"` until `ROOM_REJOIN` is acked; we do NOT call
     * `onLeave()` on rejoin failure — silently navigating away was
     * the exact "dropped to home with no error" bug we're fixing.
     */
    const onConnect = () => {
      if (!mountedRef.current) return;
      const saved = getPlayerSession();
      if (!saved) {
        // Fresh connect with no rejoin intent — the create/join flows
        // set `"connected"` themselves once the ack lands.
        setConnectionStatusState("connected");
        setReconnectAttemptState(0);
        return;
      }

      setConnectionStatusState("resyncing");
      setRejoinErrorCode(null);

      // Two flags so a *late* ack (one that arrives after the timer
      // already ran and flipped us to `rejoin_failed`) is ignored
      // instead of overwriting the user-visible error.
      let acked = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!mountedRef.current || acked) return;
        timedOut = true;
        setRejoinErrorCode("timeout");
        setConnectionStatusState("rejoin_failed");
      }, REJOIN_ACK_TIMEOUT_MS);

      socket.emit(
        SOCKET_EVENTS.ROOM_REJOIN,
        { roomCode: saved.roomCode, playerToken: saved.playerToken },
        (response: any) => {
          acked = true;
          clearTimeout(timer);
          if (!mountedRef.current || timedOut) return;
          if (response?.error) {
            const code: RejoinErrorCode =
              (response.code as RejoinErrorCode | undefined) ?? "unknown";
            // Invalid-token / kicked / room_expired sessions can't be
            // resumed by retrying — drop them. `room_full` is also
            // non-recoverable for the same session.
            if (code !== "unknown") clearPlayerSession();
            setRejoinErrorCode(code);
            setConnectionStatusState("rejoin_failed");
            return;
          }
          setReconnectAttemptState(0);
          setConnectionStatusState("connected");
          // Refresh the saved session's TTL — same rationale as the
          // mount-time `handleRejoin` path (long games would otherwise
          // expire mid-play).
          savePlayerSession(saved.roomCode, response.playerId, saved.playerToken);
          handlersRef.current.setRoom(response.room);
          handlersRef.current.setPlayerId(response.playerId);
          const { shouldEmitContinue } = handlersRef.current.restoreScreenFromRoomState(
            response.room, response.playerId, response.currentRoundData, response.guessedPlayerIds
          );
          if (shouldEmitContinue) {
            socket.emit(SOCKET_EVENTS.GAME_CONTINUE, {}, () => {});
          }
        }
      );
    };

    socket.on(SOCKET_EVENTS.ROOM_PLAYER_JOINED, onPlayerJoined);
    socket.on(SOCKET_EVENTS.ROOM_PLAYER_LEFT, onPlayerLeft);
    socket.on(SOCKET_EVENTS.ROOM_PLAYER_RECONNECTED, onPlayerReconnected);
    socket.on(SOCKET_EVENTS.ROOM_PLAYER_KICKED, onPlayerKicked);
    socket.on(SOCKET_EVENTS.ROOM_HOST_CHANGED, onHostChanged);
    socket.on(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, onSettingsUpdated);
    socket.on(SOCKET_EVENTS.ROOM_UPDATED, onRoomUpdated);
    socket.on(SOCKET_EVENTS.GAME_ROUND_START, onRoundStart);
    socket.on(SOCKET_EVENTS.GAME_PLAYER_LOCKED, onPlayerLocked);
    socket.on(SOCKET_EVENTS.GAME_PLAYER_CONTINUED, onPlayerContinued);
    socket.on(SOCKET_EVENTS.GAME_ROUND_END, onRoundEnd);
    socket.on(SOCKET_EVENTS.GAME_OVER, onGameOver);
    socket.on(SOCKET_EVENTS.ROOM_BOTS_UPDATED, onBotsUpdated);
    socket.on(SOCKET_EVENTS.GAME_BIDDING_TURN, onBiddingTurn);
    socket.on(SOCKET_EVENTS.GAME_BID_PLACED, onBidPlaced);
    socket.on("disconnect", onDisconnect);
    socket.on("connect", onConnect);

    // Manager-level events for reconnection tracking
    const onReconnectAttempt = (attempt: number) => {
      if (!mountedRef.current) return;
      setReconnectAttemptState(attempt);
    };

    const onReconnectFailed = () => {
      if (!mountedRef.current) return;
      setRejoinErrorCode(null);
      setConnectionStatusState("disconnected");
    };

    socket.io.on("reconnect_attempt", onReconnectAttempt);
    socket.io.on("reconnect_failed", onReconnectFailed);

    cleanupListenersRef.current = () => {
      socket.off(SOCKET_EVENTS.ROOM_PLAYER_JOINED, onPlayerJoined);
      socket.off(SOCKET_EVENTS.ROOM_PLAYER_LEFT, onPlayerLeft);
      socket.off(SOCKET_EVENTS.ROOM_PLAYER_RECONNECTED, onPlayerReconnected);
      socket.off(SOCKET_EVENTS.ROOM_PLAYER_KICKED, onPlayerKicked);
      socket.off(SOCKET_EVENTS.ROOM_HOST_CHANGED, onHostChanged);
      socket.off(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, onSettingsUpdated);
      socket.off(SOCKET_EVENTS.ROOM_UPDATED, onRoomUpdated);
      socket.off(SOCKET_EVENTS.GAME_ROUND_START, onRoundStart);
      socket.off(SOCKET_EVENTS.GAME_PLAYER_LOCKED, onPlayerLocked);
      socket.off(SOCKET_EVENTS.GAME_PLAYER_CONTINUED, onPlayerContinued);
      socket.off(SOCKET_EVENTS.GAME_ROUND_END, onRoundEnd);
      socket.off(SOCKET_EVENTS.GAME_OVER, onGameOver);
      socket.off(SOCKET_EVENTS.ROOM_BOTS_UPDATED, onBotsUpdated);
      socket.off(SOCKET_EVENTS.GAME_BIDDING_TURN, onBiddingTurn);
      socket.off(SOCKET_EVENTS.GAME_BID_PLACED, onBidPlaced);
      socket.off("disconnect", onDisconnect);
      socket.off("connect", onConnect);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
      socket.io.off("reconnect_failed", onReconnectFailed);
    };
  }

  /**
   * Mount-time rejoin using a saved player token. Differs from the
   * `onConnect` rejoin in that there is no prior `reconnecting` state
   * on screen — we show a page-level loading spinner via
   * `handlers.setLoading` while the ack is in flight.
   */
  function handleRejoin(code: string, token: string) {
    handlersRef.current.setLoading(true);
    handlersRef.current.setError(null);
    intentionalDisconnectRef.current = false;
    const socket = connectSocket();
    socketRef.current = socket;
    inRoomRef.current = true;

    socket.emit(SOCKET_EVENTS.ROOM_REJOIN, { roomCode: code, playerToken: token }, (response: any) => {
      handlersRef.current.setLoading(false);
      if (response?.error) {
        const rejoinCode: RejoinErrorCode =
          (response.code as RejoinErrorCode | undefined) ?? "unknown";
        if (rejoinCode !== "unknown") clearPlayerSession();
        setRejoinErrorCode(rejoinCode);
        setConnectionStatusState("rejoin_failed");
        setupSocketListeners(socket);
        return;
      }
      // Refresh the saved session's TTL on a successful rejoin. Long-
      // running games (especially the 30-min Bidding War / daily) used
      // to expire their session mid-game even though the user was still
      // actively playing — every successful rejoin restamps `savedAt`
      // so the rejoin banner / next-mount rejoin keep working as long
      // as the user is engaged.
      savePlayerSession(code, response.playerId, token);
      handlersRef.current.setRoom(response.room);
      handlersRef.current.setPlayerId(response.playerId);
      setConnectionStatusState("connected");
      setupSocketListeners(socket);

      const { shouldEmitContinue } = handlersRef.current.restoreScreenFromRoomState(
        response.room, response.playerId, response.currentRoundData, response.guessedPlayerIds
      );
      if (shouldEmitContinue) {
        socket.emit(SOCKET_EVENTS.GAME_CONTINUE, {}, () => {});
      }
    });
  }

  // Try to rejoin on mount if we have a saved session
  useEffect(() => {
    mountedRef.current = true;
    if (urlRoomCode) {
      const saved = getPlayerSession();
      if (saved && saved.roomCode === urlRoomCode) {
        handleRejoin(urlRoomCode, saved.playerToken);
        return;
      }
      // Fetch room info for display
      fetchRoomInfo(urlRoomCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlRoomCode]);

  /** Fetch room info from REST API for display on the join screen. */
  async function fetchRoomInfo(code: string) {
    try {
      const res = await fetch(`/api/mp/room/${code}`);
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        handlersRef.current.setRoom(data);
      } else {
        onLeaveRef.current();
      }
    } catch {
      if (!mountedRef.current) return;
      onLeaveRef.current();
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      disconnectSocket();
    };
  }, []);

  // --- Action functions ---

  const createRoom = useCallback(
    (displayName: string, gameMode: GameMode, options?: { categories?: string[]; password?: string; totalRounds?: number; isPublic?: boolean; autoStart?: { botCount: number; botDifficulty: BotDifficulty }; dailyDate?: string }) => {
      handlersRef.current.setLoading(true);
      handlersRef.current.setError(null);
      intentionalDisconnectRef.current = false;
      const socket = connectSocket();
      socketRef.current = socket;

      const { autoStart, ...createOpts } = options ?? {};

      // Persist quick play context before the round even starts so a mid-game
      // crash / reload / Play Again tap can re-queue with the original
      // settings. Non-autoStart creations clear the context (this is a
      // normal room, not a quick play match).
      if (autoStart) {
        handlersRef.current.setQuickPlayContext({
          gameMode,
          botCount: autoStart.botCount,
          botDifficulty: autoStart.botDifficulty,
          displayName,
          ...(createOpts.dailyDate ? { dailyDate: createOpts.dailyDate } : {}),
        });
      } else {
        handlersRef.current.setQuickPlayContext(null);
      }

      // Include the guest avatar so anon players appear with the same sticker
      // shown on the IdentityCard instead of the generic silhouette. Server
      // ignores this for logged-in users (their saved avatar wins) and falls
      // back to a random pick if the requested avatar is invalid or taken.
      const preferredAvatar = resolveGuestAvatar();
      socket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName, gameMode, preferredAvatar, ...createOpts }, (response: any) => {
        handlersRef.current.setLoading(false);
        if (response.error) {
          handlersRef.current.setError(response.error);
          return;
        }
        savePlayerSession(response.room.code, response.playerId, response.playerToken);
        handlersRef.current.setRoom(response.room);
        handlersRef.current.setPlayerId(response.playerId);
        setConnectionStatusState("connected");
        setRejoinErrorCode(null);
        inRoomRef.current = true;
        handlersRef.current.setScreen("lobby");
        setupSocketListeners(socket);
        // Update URL to the room code so the link is shareable
        window.history.replaceState(null, "", `/${response.room.code}`);

        // Auto-start: add bots then immediately start the round
        if (autoStart) {
          socket.emit(SOCKET_EVENTS.ROOM_BOT_CONFIG, { botCount: autoStart.botCount, botDifficulty: autoStart.botDifficulty }, (botResp: any) => {
            if (botResp?.error) {
              console.error("[autoStart] bot config failed:", botResp.error);
              return;
            }
            // Small delay to let bot_config broadcast settle before starting round
            setTimeout(() => {
              socket.emit(SOCKET_EVENTS.ROOM_START_ROUND, {}, (startResp: any) => {
                if (startResp?.error) {
                  console.error("[autoStart] start round failed:", startResp.error);
                }
              });
            }, 500);
          });
        }
      });
    },
    []
  );

  const joinRoom = useCallback(
    (code: string, displayName: string, password?: string, source: JoinSource = "browser") => {
      handlersRef.current.setLoading(true);
      handlersRef.current.setError(null);
      intentionalDisconnectRef.current = false;
      const socket = connectSocket();
      socketRef.current = socket;

      // Same rationale as createRoom: prefer the anon player's guest avatar;
      // server falls back to random if taken or invalid, and ignores it for
      // logged-in users who have a saved preference.
      const preferredAvatar = resolveGuestAvatar();
      socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode: code, displayName, password, preferredAvatar, source }, (response: any) => {
        handlersRef.current.setLoading(false);
        if (response.error) {
          handlersRef.current.setError(response.error);
          return;
        }
        savePlayerSession(response.room.code, response.playerId, response.playerToken);
        handlersRef.current.setRoom(response.room);
        handlersRef.current.setPlayerId(response.playerId);
        setConnectionStatusState("connected");
        setRejoinErrorCode(null);
        inRoomRef.current = true;
        handlersRef.current.setScreen("lobby");
        setupSocketListeners(socket);
      });
    },
    []
  );

  const startRound = useCallback(() => {
    handlersRef.current.setLoading(true);
    // Host-clicked Start now opens a 10-second countdown for every
    // player in the room (server sets `mp_rooms.countdown_target_at` and
    // broadcasts ROOM_UPDATED; the existing AutoLobbyCountdown banner
    // renders the timer; the countdown driver tick fires the actual
    // startRound when the timer elapses).
    socketRef.current?.emit(SOCKET_EVENTS.ROOM_HOST_START_COUNTDOWN, {}, (response: any) => {
      handlersRef.current.setLoading(false);
      if (response?.error) {
        handlersRef.current.setError(response.error);
      }
    });
  }, []);

  const submitGuess = useCallback((guessData: any) => {
    handlersRef.current.setHasGuessed(true);
    soundEngine.play("guess_submit");
    socketRef.current?.emit(SOCKET_EVENTS.GAME_SUBMIT_GUESS, { guessData }, (response: any) => {
      if (response.error) {
        handlersRef.current.setHasGuessed(false);
      }
    });
  }, []);

  const submitBid = useCallback((bidCents: number) => {
    handlersRef.current.setHasGuessed(true);
    soundEngine.play("guess_submit");
    socketRef.current?.emit(SOCKET_EVENTS.GAME_SUBMIT_BID, { bidCents }, (response: any) => {
      if (response.error) {
        handlersRef.current.setHasGuessed(false);
      }
    });
  }, []);

  const configureBots = useCallback((botCount: number, botDifficulty: BotDifficulty) => {
    socketRef.current?.emit(SOCKET_EVENTS.ROOM_BOT_CONFIG, { botCount, botDifficulty }, () => {});
  }, []);

  const kickPlayer = useCallback((targetId: string) => {
    socketRef.current?.emit(SOCKET_EVENTS.ROOM_KICK, { playerId: targetId }, () => {});
  }, []);

  const changeSettings = useCallback(
    (settings: { gameMode?: GameMode; categories?: string[] | null; totalRounds?: number; password?: string | null; isPublic?: boolean }) => {
      socketRef.current?.emit(SOCKET_EVENTS.ROOM_SETTINGS, settings, () => {});
    },
    []
  );

  const continueFromResults = useCallback(() => {
    const { shouldEmitContinue } = handlersRef.current.handleContinueFromResults();
    if (shouldEmitContinue) {
      socketRef.current?.emit(SOCKET_EVENTS.GAME_CONTINUE, {}, () => {});
    }
  }, []);

  const playAgain = useCallback(() => {
    handlersRef.current.handlePlayAgainLocal();
    socketRef.current?.emit(SOCKET_EVENTS.ROOM_PLAY_AGAIN, {}, (res: any) => {
      if (res?.error) {
        console.error("play_again error:", res.error);
      }
    });
  }, []);

  const playQuickPlayAgain = useCallback(() => {
    const ctx = handlersRef.current.getQuickPlayContext();
    if (!ctx) {
      // Caller guard: should never happen if MPResultsScreen gates the
      // button on the context being present. Fall back to the regular
      // play-again reset so we don't leave the user stranded.
      handlersRef.current.handlePlayAgainLocal();
      return;
    }

    // Tear down the current room's socket cleanly — this triggers the
    // server's disconnect handler, which removes the player and deletes
    // the room if no humans remain (the finished quick play room is a
    // throwaway since it's bot-filled).
    intentionalDisconnectRef.current = true;
    clearPlayerSession();
    disconnectSocket();
    socketRef.current = null;

    // Clear per-game state but keep quickPlayContext intact so it's
    // still available if the user taps Play Again again from the next
    // game's results. setLoading(true) keeps the UI in a "spinning up"
    // mood until the new room arrives a moment later.
    handlersRef.current.handleResetForRequeue();

    // Hit the server matchmaker first — if there's an existing public
    // lobby for this mode with real humans, we want to drop the user
    // into it rather than always spinning up bots. The endpoint's
    // response mirrors the initial quick play flow in MultiplayerPage.
    //
    // Explicitly check `res.ok` before calling `.json()` so a 4xx/5xx
    // (e.g., rate limit, transient server error) flows through the catch
    // fallback instead of silently landing in the success branch with
    // `data.action === undefined` — that path happened to work but hid
    // server failures.
    fetch("/api/mp/quickplay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameMode: ctx.gameMode }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`matchmaker failed: ${res.status}`);
        return res.json();
      })
      .then((data: { action: "join" | "create"; roomCode?: string }) => {
        intentionalDisconnectRef.current = false;
        if (data.action === "join" && data.roomCode) {
          joinRoom(data.roomCode, ctx.displayName, undefined, "quickplay");
        } else {
          createRoom(ctx.displayName, ctx.gameMode, {
            isPublic: true,
            autoStart: { botCount: ctx.botCount, botDifficulty: ctx.botDifficulty },
          });
        }
      })
      .catch(() => {
        // Fallback: always succeed by making a solo+bots room.
        intentionalDisconnectRef.current = false;
        createRoom(ctx.displayName, ctx.gameMode, {
          isPublic: true,
          autoStart: { botCount: ctx.botCount, botDifficulty: ctx.botDifficulty },
        });
      });
  }, [createRoom, joinRoom]);

  const leave = useCallback(() => {
    intentionalDisconnectRef.current = true;
    inRoomRef.current = false;
    clearPlayerSession();
    disconnectSocket();
    handlersRef.current.setQuickPlayContext(null);
    setRejoinErrorCode(null);
    onLeaveRef.current();
  }, []);

  const manualReconnect = useCallback(() => {
    const saved = getPlayerSession();
    if (saved) {
      intentionalDisconnectRef.current = false;
      setRejoinErrorCode(null);
      setConnectionStatusState("reconnecting");
      setReconnectAttemptState(0);
      // Force a fresh transport: if the user is retrying after a
      // failed rejoin (e.g., after visibilitychange → hidden
      // disconnect), the socket may be closed. Disconnect-then-connect
      // guarantees a `connect` event which re-runs the rejoin flow.
      const existing = socketRef.current;
      if (existing?.connected) existing.disconnect();
      const socket = connectSocket();
      socketRef.current = socket;
      setupSocketListeners(socket);
      // Socket.IO will auto-reconnect and the connect handler will rejoin
    } else {
      onLeaveRef.current();
    }
  }, []);

  // Mobile tab-lifecycle handling: proactively close on long
  // background, verify liveness on resume, react to online/offline.
  // Only engaged while the user is actually in a room — the initial
  // join / quick-play-matchmaker flow manages its own socket lifetime.
  //
  // `shouldArmHiddenDisconnect` is gated on `isInActiveRound` so the
  // visibility-hidden timer ONLY arms during gameplay (`playing`,
  // `round_result`). On lobby / results / join screens we keep the
  // socket open across long backgrounds because (a) there's no live
  // round to lose, and (b) silently dropping it caused the UI to flash
  // a "Reconnecting..." overlay every time the user glanced at another
  // tab from the results screen.
  useConnectionLifecycle({
    enabled: true,
    shouldArmHiddenDisconnect: isInActiveRound,
    getSocket: () => socketRef.current ?? (inRoomRef.current ? getSocket() : null),
    connect: () => {
      if (!inRoomRef.current || intentionalDisconnectRef.current) return;
      const saved = getPlayerSession();
      if (!saved) return;
      const socket = connectSocket();
      socketRef.current = socket;
      setupSocketListeners(socket);
    },
    disconnect: () => {
      if (!inRoomRef.current) return;
      // Use manager-level disconnect so Socket.IO's own reconnect
      // loop doesn't fight us on the way back in.
      disconnectSocket();
    },
  });

  const actions: MultiplayerSocketActions = {
    createRoom,
    joinRoom,
    startRound,
    submitGuess,
    submitBid,
    kickPlayer,
    changeSettings,
    configureBots,
    continueFromResults,
    playAgain,
    playQuickPlayAgain,
    leave,
    manualReconnect,
  };

  return { connectionStatus, reconnectAttempt, rejoinErrorCode, actions };
}
