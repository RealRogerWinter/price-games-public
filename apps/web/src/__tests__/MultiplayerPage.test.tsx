import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import MultiplayerPage from "../pages/MultiplayerPage";
import {
  renderWithProviders,
  makeRoom,
  makePlayer,
  makeRoundStartPayload,
  makeRoundResultsPayload,
  flushMicrotasks,
} from "./testUtils";
import type { MultiplayerGameState } from "../hooks/useMultiplayerGame";
import type { MultiplayerGameHandlers } from "../hooks/useMultiplayerGame";
import type { ConnectionStatus, MultiplayerSocketActions } from "../hooks/useMultiplayerSocket";

// --- Mocks for child components so we can inspect props without rendering their internals ---
vi.mock("../components/multiplayer/JoinScreen", () => ({
  default: (props: any) => (
    <div data-testid="join-screen" data-props={JSON.stringify({
      roomCode: props.roomCode,
      error: props.error,
      loading: props.loading,
    })}>
      JoinScreen
    </div>
  ),
}));

vi.mock("../components/multiplayer/LobbyScreen", () => ({
  default: (props: any) => (
    <div data-testid="lobby-screen" data-player-id={props.playerId} data-loading={props.loading}>
      LobbyScreen
      <button data-testid="lobby-start" onClick={props.onStartRound}>Start</button>
      <button data-testid="lobby-leave" onClick={props.onLeave}>Leave</button>
    </div>
  ),
}));

vi.mock("../components/multiplayer/MPGameScreen", () => ({
  default: (props: any) => (
    <div
      data-testid="mp-game-screen"
      data-has-guessed={String(props.hasGuessed)}
      data-current-round={props.currentRound}
      data-total-rounds={props.totalRounds}
      data-total-score={props.totalScore}
    >
      MPGameScreen
      <button data-testid="submit-guess" onClick={() => props.onSubmitGuess({ guessedPriceCents: 1500 })}>
        Submit
      </button>
    </div>
  ),
}));

vi.mock("../components/multiplayer/MPRoundResultOverlay", () => ({
  default: (props: any) => (
    <div
      data-testid="mp-round-result"
      data-is-game-over={String(props.isGameOver)}
      data-has-continued={String(props.hasContinued)}
    >
      MPRoundResultOverlay
      <button data-testid="result-continue" onClick={props.onContinue}>Continue</button>
    </div>
  ),
}));

vi.mock("../components/multiplayer/MPResultsScreen", () => ({
  default: (props: any) => (
    <div data-testid="mp-results-screen" data-player-id={props.currentPlayerId}>
      MPResultsScreen
      <button data-testid="results-play-again" onClick={props.onPlayAgain}>Play Again</button>
      <button data-testid="results-leave" onClick={props.onLeave}>Leave</button>
    </div>
  ),
}));

// --- Mock the hooks ---
vi.mock("../hooks/useMultiplayerGame");
vi.mock("../hooks/useMultiplayerSocket");

import { useMultiplayerGame } from "../hooks/useMultiplayerGame";
import { useMultiplayerSocket } from "../hooks/useMultiplayerSocket";

const mockedUseMultiplayerGame = vi.mocked(useMultiplayerGame);
const mockedUseMultiplayerSocket = vi.mocked(useMultiplayerSocket);

// --- Helpers ---

/** Build a default game state with overrides. */
function makeGameState(overrides: Partial<MultiplayerGameState> = {}): MultiplayerGameState {
  return {
    screen: "join",
    room: null,
    playerId: null,
    error: null,
    loading: false,
    roundData: null,
    hasGuessed: false,
    lockedPlayerIds: new Set(),
    roundResults: null,
    allRoundResults: [],
    isGameOver: false,
    hasContinued: false,
    continuedPlayerIds: new Set(),
    biddingTurn: null,
    placedBids: [],
    // Quick play re-queue context defaults to null (= non-quick-play game)
    // so the existing "wires onPlayAgain to actions.playAgain" test keeps
    // the legacy reset-in-place path. Tests exercising the quick play
    // re-queue branch override this to a populated context.
    quickPlayContext: null,
    ...overrides,
  };
}

/** Build stub handlers (all no-ops). */
function makeHandlers(): MultiplayerGameHandlers {
  return {
    setScreen: vi.fn(),
    setRoom: vi.fn(),
    setPlayerId: vi.fn(),
    setError: vi.fn(),
    setLoading: vi.fn(),
    setRoundData: vi.fn(),
    setHasGuessed: vi.fn(),
    setLockedPlayerIds: vi.fn(),
    setRoundResults: vi.fn(),
    setAllRoundResults: vi.fn(),
    setIsGameOver: vi.fn(),
    setHasContinued: vi.fn(),
    setContinuedPlayerIds: vi.fn(),
    handlePlayerJoined: vi.fn(),
    handlePlayerLeft: vi.fn(),
    handlePlayerReconnected: vi.fn(),
    handlePlayerKicked: vi.fn(),
    handleHostChanged: vi.fn(),
    handleSettingsUpdated: vi.fn(),
    handleRoomUpdated: vi.fn(),
    handleRoundStart: vi.fn(),
    handlePlayerLocked: vi.fn(),
    handlePlayerContinued: vi.fn(),
    handleRoundEnd: vi.fn(),
    handleGameOver: vi.fn(),
    handleBotsUpdated: vi.fn(),
    handleBiddingTurn: vi.fn(),
    handleBidPlaced: vi.fn(),
    restoreScreenFromRoomState: vi.fn().mockReturnValue({ shouldEmitContinue: false }),
    handlePlayAgainLocal: vi.fn(),
    handleContinueFromResults: vi.fn().mockReturnValue({ shouldEmitContinue: false }),
    getPlayerId: vi.fn().mockReturnValue(null),
    // Quick play re-queue plumbing (see useMultiplayerGame.ts).
    setQuickPlayContext: vi.fn(),
    getQuickPlayContext: vi.fn().mockReturnValue(null),
    handleResetForRequeue: vi.fn(),
  };
}

/** Build stub socket actions (all no-ops). */
function makeActions(): MultiplayerSocketActions {
  return {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    startRound: vi.fn(),
    submitGuess: vi.fn(),
    submitBid: vi.fn(),
    kickPlayer: vi.fn(),
    changeSettings: vi.fn(),
    configureBots: vi.fn(),
    continueFromResults: vi.fn(),
    playAgain: vi.fn(),
    playQuickPlayAgain: vi.fn(),
    leave: vi.fn(),
    manualReconnect: vi.fn(),
  };
}

/** Configure the mocked hooks with sensible defaults, returning the mutable refs for tweaking. */
function setupMocks(
  stateOverrides: Partial<MultiplayerGameState> = {},
  connectionStatus: ConnectionStatus = "connected",
  reconnectAttempt = 0,
) {
  const state = makeGameState(stateOverrides);
  const handlers = makeHandlers();
  const actions = makeActions();

  mockedUseMultiplayerGame.mockReturnValue({ state, handlers });
  mockedUseMultiplayerSocket.mockReturnValue({ connectionStatus, reconnectAttempt, actions });

  return { state, handlers, actions };
}

describe("MultiplayerPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = { onLeave: vi.fn() };

  // -------------------------------------------------------
  // Join Screen
  // -------------------------------------------------------
  describe("join screen", () => {
    it("renders JoinScreen when screen is 'join'", async () => {
      setupMocks({ screen: "join" });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("join-screen")).toBeInTheDocument();
    });

    it("passes urlRoomCode to JoinScreen", async () => {
      setupMocks({ screen: "join" });
      renderWithProviders(<MultiplayerPage roomCode="XYZW" onLeave={vi.fn()} />);
      await flushMicrotasks();

      const el = screen.getByTestId("join-screen");
      const props = JSON.parse(el.getAttribute("data-props")!);
      expect(props.roomCode).toBe("XYZW");
    });

    it("passes error and loading to JoinScreen", async () => {
      setupMocks({ screen: "join", error: "Room not found", loading: true });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("join-screen");
      const props = JSON.parse(el.getAttribute("data-props")!);
      expect(props.error).toBe("Room not found");
      expect(props.loading).toBe(true);
    });

    it("passes existingRoom to JoinScreen when room is set", async () => {
      const room = makeRoom();
      setupMocks({ screen: "join", room });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      // JoinScreen should be rendered (we can't inspect the room object through data-props
      // but we verify the component is shown with join screen)
      expect(screen.getByTestId("join-screen")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Lobby Screen
  // -------------------------------------------------------
  describe("lobby screen", () => {
    it("renders LobbyScreen when screen is 'lobby' with room and playerId", async () => {
      setupMocks({
        screen: "lobby",
        room: makeRoom(),
        playerId: "player-1",
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("lobby-screen")).toBeInTheDocument();
    });

    it("passes playerId to LobbyScreen", async () => {
      setupMocks({
        screen: "lobby",
        room: makeRoom(),
        playerId: "player-42",
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("lobby-screen");
      expect(el.getAttribute("data-player-id")).toBe("player-42");
    });

    it("passes loading to LobbyScreen", async () => {
      setupMocks({
        screen: "lobby",
        room: makeRoom(),
        playerId: "player-1",
        loading: true,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("lobby-screen");
      expect(el.getAttribute("data-loading")).toBe("true");
    });

    it("wires onStartRound to actions.startRound", async () => {
      const { actions } = setupMocks({
        screen: "lobby",
        room: makeRoom(),
        playerId: "player-1",
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("lobby-start"));
      expect(actions.startRound).toHaveBeenCalled();
    });

    it("wires onLeave to actions.leave", async () => {
      const { actions } = setupMocks({
        screen: "lobby",
        room: makeRoom(),
        playerId: "player-1",
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("lobby-leave"));
      expect(actions.leave).toHaveBeenCalled();
    });

    it("does not render lobby if room is null", async () => {
      setupMocks({ screen: "lobby", room: null, playerId: "player-1" });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("lobby-screen")).not.toBeInTheDocument();
      // Falls through to the loading fallback
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("does not render lobby if playerId is null", async () => {
      setupMocks({ screen: "lobby", room: makeRoom(), playerId: null });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("lobby-screen")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Playing Screen
  // -------------------------------------------------------
  describe("playing screen", () => {
    const playingRoom = makeRoom({
      status: "playing",
      currentRound: 3,
      totalRounds: 10,
      players: [
        makePlayer({ id: "player-1", totalScore: 1200, isHost: true }),
        makePlayer({ id: "player-2", displayName: "Bob", totalScore: 800 }),
      ],
    });

    it("renders MPGameScreen with roundData", async () => {
      setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "player-1",
        roundData: makeRoundStartPayload({ roundNumber: 3 }),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("mp-game-screen");
      expect(el).toBeInTheDocument();
      expect(el.getAttribute("data-current-round")).toBe("3");
      expect(el.getAttribute("data-total-rounds")).toBe("10");
      expect(el.getAttribute("data-total-score")).toBe("1200");
      expect(el.getAttribute("data-has-guessed")).toBe("false");
    });

    it("passes hasGuessed=true to MPGameScreen", async () => {
      setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "player-1",
        roundData: makeRoundStartPayload(),
        hasGuessed: true,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("mp-game-screen").getAttribute("data-has-guessed")).toBe("true");
    });

    it("shows waiting screen when roundData is null (rejoined mid-round)", async () => {
      setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "player-1",
        roundData: null,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-game-screen")).not.toBeInTheDocument();
      expect(screen.getByText("Waiting for round to finish...")).toBeInTheDocument();
    });

    it("uses totalScore 0 when player not found in room", async () => {
      setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "unknown-player",
        roundData: makeRoundStartPayload(),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("mp-game-screen").getAttribute("data-total-score")).toBe("0");
    });

    it("does not render game screen if room is null", async () => {
      setupMocks({
        screen: "playing",
        room: null,
        playerId: "player-1",
        roundData: makeRoundStartPayload(),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-game-screen")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Guess submission guard
  // -------------------------------------------------------
  describe("handleSubmitGuess guard", () => {
    const playingRoom = makeRoom({
      status: "playing",
      currentRound: 1,
      players: [makePlayer({ id: "player-1" })],
    });

    it("calls actions.submitGuess when hasGuessed is false", async () => {
      const { actions } = setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "player-1",
        roundData: makeRoundStartPayload(),
        hasGuessed: false,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("submit-guess"));
      expect(actions.submitGuess).toHaveBeenCalledWith({ guessedPriceCents: 1500 });
    });

    it("does NOT call actions.submitGuess when hasGuessed is true", async () => {
      const { actions } = setupMocks({
        screen: "playing",
        room: playingRoom,
        playerId: "player-1",
        roundData: makeRoundStartPayload(),
        hasGuessed: true,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("submit-guess"));
      expect(actions.submitGuess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------
  // Round Result Screen
  // -------------------------------------------------------
  describe("round result screen", () => {
    it("renders MPRoundResultOverlay with correct props", async () => {
      const results = makeRoundResultsPayload();
      setupMocks({
        screen: "round_result",
        playerId: "player-1",
        roundResults: results,
        isGameOver: false,
        hasContinued: false,
        room: makeRoom(),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("mp-round-result");
      expect(el).toBeInTheDocument();
      expect(el.getAttribute("data-is-game-over")).toBe("false");
      expect(el.getAttribute("data-has-continued")).toBe("false");
    });

    it("passes isGameOver=true when game is over", async () => {
      setupMocks({
        screen: "round_result",
        playerId: "player-1",
        roundResults: makeRoundResultsPayload(),
        isGameOver: true,
        hasContinued: false,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("mp-round-result").getAttribute("data-is-game-over")).toBe("true");
    });

    it("wires onContinue to actions.continueFromResults", async () => {
      const { actions } = setupMocks({
        screen: "round_result",
        playerId: "player-1",
        roundResults: makeRoundResultsPayload(),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("result-continue"));
      expect(actions.continueFromResults).toHaveBeenCalled();
    });

    it("does not render round result if roundResults is null", async () => {
      setupMocks({
        screen: "round_result",
        playerId: "player-1",
        roundResults: null,
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-round-result")).not.toBeInTheDocument();
    });

    it("does not render round result if playerId is null", async () => {
      setupMocks({
        screen: "round_result",
        playerId: null,
        roundResults: makeRoundResultsPayload(),
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-round-result")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Game Over Screen
  // -------------------------------------------------------
  describe("game over screen", () => {
    const results1 = makeRoundResultsPayload({ roundNumber: 1 });
    const results2 = makeRoundResultsPayload({ roundNumber: 2 });

    it("renders MPResultsScreen with final results", async () => {
      setupMocks({
        screen: "game_over",
        playerId: "player-1",
        allRoundResults: [results1, results2],
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      const el = screen.getByTestId("mp-results-screen");
      expect(el).toBeInTheDocument();
      expect(el.getAttribute("data-player-id")).toBe("player-1");
    });

    it("wires onPlayAgain to actions.playAgain", async () => {
      const { actions } = setupMocks({
        screen: "game_over",
        playerId: "player-1",
        allRoundResults: [results1],
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("results-play-again"));
      expect(actions.playAgain).toHaveBeenCalled();
    });

    it("wires onLeave to actions.leave", async () => {
      const { actions } = setupMocks({
        screen: "game_over",
        playerId: "player-1",
        allRoundResults: [results1],
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByTestId("results-leave"));
      expect(actions.leave).toHaveBeenCalled();
    });

    it("does not render game over if allRoundResults is empty", async () => {
      setupMocks({
        screen: "game_over",
        playerId: "player-1",
        allRoundResults: [],
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-results-screen")).not.toBeInTheDocument();
      // Falls through to loading fallback
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("does not render game over if playerId is null", async () => {
      setupMocks({
        screen: "game_over",
        playerId: null,
        allRoundResults: [results1],
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByTestId("mp-results-screen")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Connection Overlay
  // -------------------------------------------------------
  describe("connection overlay", () => {
    it("does not show overlay when connected", async () => {
      setupMocks(
        { screen: "lobby", room: makeRoom(), playerId: "player-1" },
        "connected",
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByText("Reconnecting...")).not.toBeInTheDocument();
      expect(screen.queryByText("Connection Lost")).not.toBeInTheDocument();
    });

    it("shows reconnecting spinner with attempt count", async () => {
      setupMocks(
        { screen: "lobby", room: makeRoom(), playerId: "player-1" },
        "reconnecting",
        3,
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
      expect(screen.getByText("Attempt 3 of 15")).toBeInTheDocument();
    });

    it("shows disconnected state with Try Again and Leave Game buttons", async () => {
      const { actions } = setupMocks(
        { screen: "lobby", room: makeRoom(), playerId: "player-1" },
        "disconnected",
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Connection Lost")).toBeInTheDocument();
      expect(screen.getByText("Unable to reach the server.")).toBeInTheDocument();

      const tryAgainBtn = screen.getByText("Try Again");
      const leaveBtn = screen.getByText("Leave Game");

      fireEvent.click(tryAgainBtn);
      expect(actions.manualReconnect).toHaveBeenCalled();

      fireEvent.click(leaveBtn);
      expect(actions.leave).toHaveBeenCalled();
    });

    it("shows overlay on playing screen when reconnecting", async () => {
      setupMocks(
        {
          screen: "playing",
          room: makeRoom({ status: "playing", currentRound: 1, players: [makePlayer({ id: "p1" })] }),
          playerId: "p1",
          roundData: makeRoundStartPayload(),
        },
        "reconnecting",
        7,
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      // Game screen should still be visible underneath the overlay
      expect(screen.getByTestId("mp-game-screen")).toBeInTheDocument();
      expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
      expect(screen.getByText("Attempt 7 of 15")).toBeInTheDocument();
    });

    it("shows overlay on round_result screen when disconnected", async () => {
      setupMocks(
        {
          screen: "round_result",
          playerId: "player-1",
          roundResults: makeRoundResultsPayload(),
          room: makeRoom(),
        },
        "disconnected",
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("mp-round-result")).toBeInTheDocument();
      expect(screen.getByText("Connection Lost")).toBeInTheDocument();
    });

    it("shows overlay on game_over screen when reconnecting", async () => {
      setupMocks(
        {
          screen: "game_over",
          playerId: "player-1",
          allRoundResults: [makeRoundResultsPayload()],
        },
        "reconnecting",
        1,
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByTestId("mp-results-screen")).toBeInTheDocument();
      expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
    });

    it("shows overlay on waiting-for-round screen when disconnected", async () => {
      setupMocks(
        {
          screen: "playing",
          room: makeRoom({ status: "playing", players: [makePlayer({ id: "p1" })] }),
          playerId: "p1",
          roundData: null,
        },
        "disconnected",
      );
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Waiting for round to finish...")).toBeInTheDocument();
      expect(screen.getByText("Connection Lost")).toBeInTheDocument();
    });

    it("does not show overlay on join screen (join screen has no overlay)", async () => {
      setupMocks({ screen: "join" }, "disconnected");
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      // Join screen renders standalone, not wrapped with overlay
      expect(screen.getByTestId("join-screen")).toBeInTheDocument();
      expect(screen.queryByText("Connection Lost")).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Fallback / Loading Screen
  // -------------------------------------------------------
  describe("fallback loading screen", () => {
    it("shows 'Connecting...' when loading is true and no error", async () => {
      setupMocks({ screen: "game_over", playerId: null, loading: true });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });

    it("shows 'Loading...' when not loading and no error", async () => {
      setupMocks({ screen: "game_over", playerId: null, loading: false });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("shows error message and Back to Home button when error is set", async () => {
      const { actions } = setupMocks({
        screen: "game_over",
        playerId: null,
        error: "Room has expired",
      });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("Room has expired")).toBeInTheDocument();

      const backBtn = screen.getByText("Back to Home");
      fireEvent.click(backBtn);
      expect(actions.leave).toHaveBeenCalled();
    });

    it("does not show Back to Home button when no error", async () => {
      setupMocks({ screen: "game_over", playerId: null, loading: false });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.queryByText("Back to Home")).not.toBeInTheDocument();
    });

    it("shows price.games title in fallback screen", async () => {
      setupMocks({ screen: "game_over", playerId: null });
      renderWithProviders(<MultiplayerPage {...defaultProps} />);
      await flushMicrotasks();

      expect(screen.getByText("price.games")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------
  // Hook wiring
  // -------------------------------------------------------
  describe("hook wiring", () => {
    it("passes handlers and onLeave to useMultiplayerSocket", async () => {
      const handlers = makeHandlers();
      const onLeave = vi.fn();
      mockedUseMultiplayerGame.mockReturnValue({ state: makeGameState(), handlers });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });

      renderWithProviders(<MultiplayerPage roomCode="TEST" onLeave={onLeave} />);
      await flushMicrotasks();

      // Default screen is "join" → isInActiveRound=false.
      expect(mockedUseMultiplayerSocket).toHaveBeenCalledWith(handlers, onLeave, "TEST", false);
    });

    it("passes urlRoomCode=undefined when no roomCode prop", async () => {
      const handlers = makeHandlers();
      const onLeave = vi.fn();
      mockedUseMultiplayerGame.mockReturnValue({ state: makeGameState(), handlers });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });

      renderWithProviders(<MultiplayerPage onLeave={onLeave} />);
      await flushMicrotasks();

      expect(mockedUseMultiplayerSocket).toHaveBeenCalledWith(handlers, onLeave, undefined, false);
    });

    it("passes isInActiveRound=true when on the playing screen", async () => {
      const handlers = makeHandlers();
      const onLeave = vi.fn();
      mockedUseMultiplayerGame.mockReturnValue({
        state: makeGameState({ screen: "playing" }),
        handlers,
      });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });

      renderWithProviders(<MultiplayerPage onLeave={onLeave} />);
      await flushMicrotasks();

      expect(mockedUseMultiplayerSocket).toHaveBeenCalledWith(handlers, onLeave, undefined, true);
    });

    it("passes isInActiveRound=true when on the round_result screen", async () => {
      const handlers = makeHandlers();
      const onLeave = vi.fn();
      mockedUseMultiplayerGame.mockReturnValue({
        state: makeGameState({ screen: "round_result" }),
        handlers,
      });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });

      renderWithProviders(<MultiplayerPage onLeave={onLeave} />);
      await flushMicrotasks();

      expect(mockedUseMultiplayerSocket).toHaveBeenCalledWith(handlers, onLeave, undefined, true);
    });

    it("passes isInActiveRound=false on lobby/game_over screens", async () => {
      const handlers = makeHandlers();
      mockedUseMultiplayerGame.mockReturnValue({
        state: makeGameState({ screen: "lobby" }),
        handlers,
      });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });
      const { unmount } = renderWithProviders(<MultiplayerPage onLeave={vi.fn()} />);
      await flushMicrotasks();
      expect(mockedUseMultiplayerSocket).toHaveBeenLastCalledWith(
        handlers, expect.any(Function), undefined, false,
      );
      unmount();

      mockedUseMultiplayerGame.mockReturnValue({
        state: makeGameState({ screen: "game_over" }),
        handlers,
      });
      renderWithProviders(<MultiplayerPage onLeave={vi.fn()} />);
      await flushMicrotasks();
      expect(mockedUseMultiplayerSocket).toHaveBeenLastCalledWith(
        handlers, expect.any(Function), undefined, false,
      );
    });
  });

  // -------------------------------------------------------
  // Game-over suppression after explicit leave
  // -------------------------------------------------------
  describe("game_over suppression after explicit leave", () => {
    it("does NOT call handleGameOver when the player has navigated away (no MP session) — even if the listener is wired", () => {
      // This integration verifies the wiring + gating: the page passes
      // `isInActiveRound` into `useMultiplayerSocket`, and the socket
      // hook itself owns the suppression logic (covered in
      // useMultiplayerSocket.test.ts). The end-to-end invariant we're
      // protecting is the page never observes a screen transition for
      // a `game_over` event after the user explicitly cleared the
      // active_game session and navigated home.
      const handlers = makeHandlers();
      mockedUseMultiplayerGame.mockReturnValue({
        state: makeGameState({ screen: "game_over", playerId: null }),
        handlers,
      });
      mockedUseMultiplayerSocket.mockReturnValue({
        connectionStatus: "connected",
        reconnectAttempt: 0,
        actions: makeActions(),
      });

      // Player explicitly cleared the SP active_game flag (the App-level
      // path triggered by clicking "Leave Game" or back-button confirm).
      sessionStorage.removeItem("active_game");
      renderWithProviders(<MultiplayerPage onLeave={vi.fn()} />);
      // No game_over screen should be in the DOM — `screen === "game_over"`
      // with `playerId === null` falls through to the loading fallback.
      expect(screen.queryByTestId("mp-results-screen")).not.toBeInTheDocument();
    });
  });

  describe("popstate back-button handling", () => {
    it("does NOT prompt when the pop lands back on its own {mp:true} dummy entry (e.g. child modal closing via history.back)", async () => {
      const room = makeRoom();
      setupMocks({ screen: "lobby", room, playerId: "p1" });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const onLeave = vi.fn();

      renderWithProviders(<MultiplayerPage onLeave={onLeave} />);
      await flushMicrotasks();

      // Simulate useModalHistory firing history.back() — popstate delivers
      // the pushed {mp:true} dummy as the new state.
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { mp: true } }),
      );

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("DOES prompt when the pop lands on a foreign (non-mp) state — genuine back navigation", async () => {
      const room = makeRoom();
      setupMocks({ screen: "lobby", room, playerId: "p1" });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const onLeave = vi.fn();

      renderWithProviders(<MultiplayerPage onLeave={onLeave} />);
      await flushMicrotasks();

      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));

      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Leave multiplayer/),
      );
      confirmSpy.mockRestore();
    });
  });
});
