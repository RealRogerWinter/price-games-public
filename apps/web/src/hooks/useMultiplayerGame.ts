import { useState, useCallback, useRef } from "react";
import type {
  MultiplayerRoom,
  MultiplayerPlayer,
  GameMode,
  RoundStartPayload,
  RoundResultsPayload,
  BiddingTurnPayload,
  BidPlacedPayload,
  BotDifficulty,
} from "@price-game/shared";

/**
 * Quick play context, preserved across the game lifecycle so a Play Again
 * tap after a quick play match can instantly re-queue the user into another
 * game with the same settings (same mode + bot profile). Null when the
 * current game did not originate from the quick play flow.
 */
export interface QuickPlayContext {
  gameMode: GameMode;
  botCount: number;
  botDifficulty: BotDifficulty;
  displayName: string;
  /** YYYY-MM-DD when the original quick play came from a daily challenge. */
  dailyDate?: string;
}

/** Possible screens in the multiplayer flow. */
export type MPScreen = "join" | "lobby" | "playing" | "round_result" | "game_over";

/** All game state returned by the hook for rendering. */
export interface MultiplayerGameState {
  screen: MPScreen;
  room: MultiplayerRoom | null;
  playerId: string | null;
  error: string | null;
  loading: boolean;
  roundData: RoundStartPayload | null;
  hasGuessed: boolean;
  lockedPlayerIds: Set<string>;
  roundResults: RoundResultsPayload | null;
  allRoundResults: RoundResultsPayload[];
  isGameOver: boolean;
  hasContinued: boolean;
  continuedPlayerIds: Set<string>;
  biddingTurn: BiddingTurnPayload | null;
  placedBids: BidPlacedPayload[];
  /**
   * Quick play origin context. Set on room creation when `autoStart` was
   * passed, cleared on leave. Drives the "instant re-queue" behaviour of
   * the Play Again button on the MP results screen.
   */
  quickPlayContext: QuickPlayContext | null;
}

/**
 * Handlers exposed so the socket layer can push state changes into the game state.
 * Each handler corresponds to a socket event or a user/socket-triggered state mutation.
 */
export interface MultiplayerGameHandlers {
  setScreen: (screen: MPScreen) => void;
  setRoom: React.Dispatch<React.SetStateAction<MultiplayerRoom | null>>;
  setPlayerId: (id: string | null) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setRoundData: (data: RoundStartPayload | null) => void;
  setHasGuessed: (guessed: boolean) => void;
  setLockedPlayerIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setRoundResults: (results: RoundResultsPayload | null) => void;
  setAllRoundResults: React.Dispatch<React.SetStateAction<RoundResultsPayload[]>>;
  setIsGameOver: (over: boolean) => void;
  setHasContinued: (continued: boolean) => void;
  setContinuedPlayerIds: React.Dispatch<React.SetStateAction<Set<string>>>;

  /** Called on player_joined socket event. */
  handlePlayerJoined: (player: MultiplayerPlayer) => void;
  /** Called on player_left socket event. */
  handlePlayerLeft: (leftId: string) => void;
  /** Called on player_reconnected socket event. */
  handlePlayerReconnected: (reconId: string) => void;
  /** Called on player_kicked socket event. Returns the current playerId for self-kick detection. */
  handlePlayerKicked: (kickedId: string) => void;
  /** Called on host_changed socket event. */
  handleHostChanged: (newHostId: string) => void;
  /** Called on settings_updated socket event. */
  handleSettingsUpdated: (data: { gameMode: GameMode; categories: string[] | null; totalRounds: number; hasPassword: boolean }) => void;
  /** Called on room:updated socket event. */
  handleRoomUpdated: (updatedRoom: MultiplayerRoom) => void;
  /** Called on game:round_start socket event. */
  handleRoundStart: (payload: RoundStartPayload) => void;
  /** Called on game:player_locked socket event. */
  handlePlayerLocked: (lockedId: string) => void;
  /** Called on game:player_continued socket event. */
  handlePlayerContinued: (contId: string) => void;
  /** Called on game:round_end socket event. */
  handleRoundEnd: (results: RoundResultsPayload) => void;
  /** Called on game:over socket event. */
  handleGameOver: (results: RoundResultsPayload) => void;
  /** Called on room:bots_updated socket event. */
  handleBotsUpdated: (data: { botCount: number; botDifficulty: string; players: MultiplayerPlayer[] }) => void;
  /** Called on game:bidding_turn socket event. */
  handleBiddingTurn: (payload: BiddingTurnPayload) => void;
  /** Called on game:bid_placed socket event. */
  handleBidPlaced: (payload: BidPlacedPayload) => void;
  /**
   * Restore screen from room state after rejoining.
   * Returns any socket emissions needed (e.g. game:continue for between_rounds).
   */
  restoreScreenFromRoomState: (
    roomState: MultiplayerRoom,
    rejoiningPlayerId: string,
    currentRoundData?: RoundStartPayload | null,
    guessedPlayerIds?: string[]
  ) => { shouldEmitContinue: boolean };
  /** Reset state for play-again flow. */
  handlePlayAgainLocal: () => void;
  /** Transition from round_result to game_over screen when game is finished. */
  handleContinueFromResults: () => { shouldEmitContinue: boolean };
  /** Get current playerId (for self-kick detection in the socket layer). */
  getPlayerId: () => string | null;
  /**
   * Remember that the current/next room was created from the quick play
   * flow. Called by the socket layer right after a room is created with
   * the autoStart option.
   */
  setQuickPlayContext: (ctx: QuickPlayContext | null) => void;
  /** Snapshot of the current quick play context (for re-queue). */
  getQuickPlayContext: () => QuickPlayContext | null;
  /**
   * Clear all game state for a quick play re-queue. Preserves the
   * quickPlayContext so the re-queue action can re-create the room with
   * the same settings. Differs from handlePlayAgainLocal in that it also
   * wipes the room reference (we are about to get a new one).
   */
  handleResetForRequeue: () => void;
}

/**
 * Custom hook that encapsulates all multiplayer game state and the
 * state-update handlers that socket events call into. The hook does NOT
 * know about sockets -- it only manages React state.
 *
 * @returns game state for rendering and handlers for the socket layer
 */
export function useMultiplayerGame(): {
  state: MultiplayerGameState;
  handlers: MultiplayerGameHandlers;
} {
  const [screen, setScreen] = useState<MPScreen>("join");
  const [room, setRoom] = useState<MultiplayerRoom | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Game state
  const [roundData, setRoundData] = useState<RoundStartPayload | null>(null);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [lockedPlayerIds, setLockedPlayerIds] = useState<Set<string>>(new Set());
  const [roundResults, setRoundResults] = useState<RoundResultsPayload | null>(null);
  const [allRoundResults, setAllRoundResults] = useState<RoundResultsPayload[]>([]);
  const [isGameOver, setIsGameOverRaw] = useState(false);
  const isGameOverRef = useRef(false);
  const setIsGameOver = useCallback((value: boolean) => {
    isGameOverRef.current = value;
    setIsGameOverRaw(value);
  }, []);
  const [hasContinued, setHasContinued] = useState(false);
  const [continuedPlayerIds, setContinuedPlayerIds] = useState<Set<string>>(new Set());
  const [biddingTurn, setBiddingTurn] = useState<BiddingTurnPayload | null>(null);
  const [placedBids, setPlacedBids] = useState<BidPlacedPayload[]>([]);

  // Ref so callbacks always see latest playerId without re-registering listeners
  const playerIdRef = useRef<string | null>(null);
  const setPlayerIdWrapped = useCallback((id: string | null) => {
    playerIdRef.current = id;
    setPlayerId(id);
  }, []);

  const getPlayerId = useCallback(() => playerIdRef.current, []);

  // Quick play context — held in both state (for React re-renders that
  // depend on it, e.g. MPResultsScreen prop wiring) and a ref (so
  // imperative socket callbacks can snapshot it without stale closures).
  const [quickPlayContext, setQuickPlayContextState] = useState<QuickPlayContext | null>(null);
  const quickPlayContextRef = useRef<QuickPlayContext | null>(null);
  const setQuickPlayContext = useCallback((ctx: QuickPlayContext | null) => {
    quickPlayContextRef.current = ctx;
    setQuickPlayContextState(ctx);
  }, []);
  const getQuickPlayContext = useCallback(() => quickPlayContextRef.current, []);

  const handlePlayerJoined = useCallback((player: MultiplayerPlayer) => {
    setRoom((prev) =>
      prev ? { ...prev, players: [...prev.players.filter((p) => p.id !== player.id), player] } : prev
    );
  }, []);

  const handlePlayerLeft = useCallback((leftId: string) => {
    setRoom((prev) =>
      prev
        ? {
            ...prev,
            players: prev.players.map((p) =>
              p.id === leftId ? { ...p, isConnected: false } : p
            ),
          }
        : prev
    );
  }, []);

  const handlePlayerReconnected = useCallback((reconId: string) => {
    setRoom((prev) =>
      prev
        ? {
            ...prev,
            players: prev.players.map((p) =>
              p.id === reconId ? { ...p, isConnected: true } : p
            ),
          }
        : prev
    );
  }, []);

  const handlePlayerKicked = useCallback((kickedId: string) => {
    setRoom((prev) =>
      prev
        ? { ...prev, players: prev.players.filter((p) => p.id !== kickedId) }
        : prev
    );
  }, []);

  const handleHostChanged = useCallback((newHostId: string) => {
    setRoom((prev) =>
      prev
        ? {
            ...prev,
            hostPlayerId: newHostId,
            players: prev.players.map((p) => ({
              ...p,
              isHost: p.id === newHostId,
            })),
          }
        : prev
    );
  }, []);

  const handleSettingsUpdated = useCallback(
    (data: { gameMode: GameMode; categories: string[] | null; totalRounds: number; hasPassword: boolean; isPublic?: boolean }) => {
      setRoom((prev) =>
        prev
          ? {
              ...prev,
              gameMode: data.gameMode,
              categories: data.categories,
              totalRounds: data.totalRounds,
              hasPassword: data.hasPassword,
              // Honor an explicit isPublic from the server broadcast; if the
              // server omitted it (older event shape), preserve the prior value.
              isPublic: data.isPublic ?? prev.isPublic,
            }
          : prev
      );
    },
    []
  );

  const handleRoomUpdated = useCallback((updatedRoom: MultiplayerRoom) => {
    setRoom(updatedRoom);
    if (updatedRoom.status === "lobby") {
      setAllRoundResults([]);
      setIsGameOver(false);
      setScreen("lobby");
    }
  }, [setIsGameOver]);

  const handleRoundStart = useCallback((payload: RoundStartPayload) => {
    setRoundData(payload);
    setHasGuessed(false);
    setLockedPlayerIds(new Set());
    setRoundResults(null);
    setIsGameOver(false);
    setHasContinued(false);
    setContinuedPlayerIds(new Set());
    setBiddingTurn(null);
    setPlacedBids([]);
    setRoom((prev) =>
      prev ? { ...prev, status: "playing", currentRound: payload.roundNumber } : prev
    );
    setScreen("playing");
  }, []);

  const handlePlayerLocked = useCallback((lockedId: string) => {
    setLockedPlayerIds((prev) => new Set(prev).add(lockedId));
  }, []);

  const handlePlayerContinued = useCallback((contId: string) => {
    setContinuedPlayerIds((prev) => new Set(prev).add(contId));
  }, []);

  const handleRoundEnd = useCallback((results: RoundResultsPayload) => {
    setRoundResults(results);
    setAllRoundResults((prev) => [...prev, results]);
    setRoom((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        status: "between_rounds",
        players: prev.players.map((p) => {
          const standing = results.standings.find((s) => s.playerId === p.id);
          return standing ? { ...p, totalScore: standing.totalScore } : p;
        }),
      };
    });
    setScreen("round_result");
  }, []);

  const handleGameOver = useCallback((results: RoundResultsPayload) => {
    setRoundResults(results);
    setAllRoundResults((prev) => [...prev, results]);
    setIsGameOver(true);
    setRoom((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        status: "finished",
        players: prev.players.map((p) => {
          const standing = results.standings.find((s) => s.playerId === p.id);
          return standing ? { ...p, totalScore: standing.totalScore } : p;
        }),
      };
    });
    setScreen("round_result");
  }, []);

  const handleBotsUpdated = useCallback(
    (data: { botCount: number; botDifficulty: string; players: MultiplayerPlayer[] }) => {
      setRoom((prev) =>
        prev
          ? {
              ...prev,
              botCount: data.botCount,
              botDifficulty: data.botDifficulty as any,
              players: data.players,
            }
          : prev
      );
    },
    []
  );

  const handleBiddingTurn = useCallback((payload: BiddingTurnPayload) => {
    setBiddingTurn(payload);
  }, []);

  const handleBidPlaced = useCallback((payload: BidPlacedPayload) => {
    setPlacedBids((prev) => [...prev, payload]);
  }, []);

  const restoreScreenFromRoomState = useCallback(
    (
      roomState: MultiplayerRoom,
      rejoiningPlayerId: string,
      currentRoundData?: RoundStartPayload | null,
      guessedPlayerIds?: string[]
    ): { shouldEmitContinue: boolean } => {
      const status = roomState.status;
      let shouldEmitContinue = false;

      if (status === "lobby") {
        setScreen("lobby");
      } else if (status === "playing") {
        if (currentRoundData) {
          setRoundData(currentRoundData);
          setHasGuessed(false);
          if (guessedPlayerIds && guessedPlayerIds.length > 0) {
            setLockedPlayerIds(new Set(guessedPlayerIds));
            if (guessedPlayerIds.includes(rejoiningPlayerId)) {
              setHasGuessed(true);
            }
          }
          setScreen("playing");
        } else {
          setScreen("playing");
        }
      } else if (status === "between_rounds") {
        setHasContinued(true);
        shouldEmitContinue = true;
        setScreen("round_result");
      } else if (status === "finished") {
        setScreen("game_over");
      }

      return { shouldEmitContinue };
    },
    []
  );

  const handlePlayAgainLocal = useCallback(() => {
    setAllRoundResults([]);
    setIsGameOver(false);
    setRoom((prev) =>
      prev
        ? { ...prev, status: "lobby", currentRound: 0, players: prev.players.map((p) => ({ ...p, totalScore: 0 })) }
        : prev
    );
    setScreen("lobby");
  }, []);

  // Used by the quick play re-queue flow (MPResultsScreen → Play Again when
  // the current game was originally a quick play match). Wipes everything
  // game-specific so the next createRoom/joinRoom call lands on a fresh
  // state, but intentionally does NOT clear quickPlayContext — the caller
  // needs to re-read it to know the mode/bot settings to queue with.
  const handleResetForRequeue = useCallback(() => {
    setRoom(null);
    setPlayerIdWrapped(null);
    setError(null);
    setRoundData(null);
    setHasGuessed(false);
    setLockedPlayerIds(new Set());
    setRoundResults(null);
    setAllRoundResults([]);
    setIsGameOver(false);
    setHasContinued(false);
    setContinuedPlayerIds(new Set());
    setBiddingTurn(null);
    setPlacedBids([]);
    // Show the lobby "loading" spinner via loading=true until the next
    // room is created. Screen stays at 'game_over' for an instant so there's
    // no jarring flash back to the join screen; the socket layer transitions
    // screen once the new room arrives.
    setLoading(true);
  }, [setPlayerIdWrapped]);

  const handleContinueFromResults = useCallback((): { shouldEmitContinue: boolean } => {
    if (isGameOverRef.current) {
      setScreen("game_over");
      return { shouldEmitContinue: false };
    } else {
      setHasContinued(true);
      return { shouldEmitContinue: true };
    }
  }, []);

  const state: MultiplayerGameState = {
    screen,
    room,
    playerId,
    error,
    loading,
    roundData,
    hasGuessed,
    lockedPlayerIds,
    roundResults,
    allRoundResults,
    isGameOver,
    hasContinued,
    continuedPlayerIds,
    biddingTurn,
    placedBids,
    quickPlayContext,
  };

  const handlers: MultiplayerGameHandlers = {
    setScreen,
    setRoom,
    setPlayerId: setPlayerIdWrapped,
    setError,
    setLoading,
    setRoundData,
    setHasGuessed,
    setLockedPlayerIds,
    setRoundResults,
    setAllRoundResults,
    setIsGameOver,
    setHasContinued,
    setContinuedPlayerIds,
    handlePlayerJoined,
    handlePlayerLeft,
    handlePlayerReconnected,
    handlePlayerKicked,
    handleHostChanged,
    handleSettingsUpdated,
    handleRoomUpdated,
    handleRoundStart,
    handlePlayerLocked,
    handlePlayerContinued,
    handleRoundEnd,
    handleGameOver,
    handleBotsUpdated,
    handleBiddingTurn,
    handleBidPlaced,
    restoreScreenFromRoomState,
    handlePlayAgainLocal,
    handleContinueFromResults,
    getPlayerId,
    setQuickPlayContext,
    getQuickPlayContext,
    handleResetForRequeue,
  };

  return { state, handlers };
}
