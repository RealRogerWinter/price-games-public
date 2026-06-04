import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { useMultiplayerSocket } from "../hooks/useMultiplayerSocket";
import type { MultiplayerGameHandlers } from "../hooks/useMultiplayerGame";
import {
  connectSocket,
  disconnectSocket,
  savePlayerSession,
  getPlayerSession,
  clearPlayerSession,
} from "../api/socket";
import { makeRoom, flushMicrotasks } from "./testUtils";

// --- Module mock ---
vi.mock("../api/socket", () => ({
  getSocket: vi.fn(() => null),
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
  savePlayerSession: vi.fn(),
  getPlayerSession: vi.fn(() => null),
  clearPlayerSession: vi.fn(),
}));

// --- Helpers ---

/**
 * Creates a mock Socket.IO socket object with emit, on, off, and io properties.
 * Listeners are tracked in maps for easy retrieval in tests.
 */
function createMockSocket() {
  const listeners = new Map<string, Function>();
  const ioListeners = new Map<string, Function>();
  return {
    emit: vi.fn((event: string, _data: any, cb?: Function) => cb && cb({})),
    on: vi.fn((event: string, handler: Function) => {
      listeners.set(event, handler);
    }),
    off: vi.fn(),
    io: {
      on: vi.fn((event: string, handler: Function) => {
        ioListeners.set(event, handler);
      }),
      off: vi.fn(),
    },
    listeners,
    ioListeners,
    connected: true,
  };
}

/** Creates a mock MultiplayerGameHandlers object with all methods as vi.fn(). */
function createMockHandlers(): MultiplayerGameHandlers {
  return {
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
    handleContinueFromResults: vi.fn(() => ({ shouldEmitContinue: false })),
    handlePlayAgainLocal: vi.fn(),
    setRoom: vi.fn(),
    setPlayerId: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setScreen: vi.fn(),
    setHasGuessed: vi.fn(),
    setRoundData: vi.fn(),
    setLockedPlayerIds: vi.fn(),
    setRoundResults: vi.fn(),
    setAllRoundResults: vi.fn(),
    setIsGameOver: vi.fn(),
    setHasContinued: vi.fn(),
    setContinuedPlayerIds: vi.fn(),
    getPlayerId: vi.fn(() => "player-1"),
    restoreScreenFromRoomState: vi.fn(() => ({ shouldEmitContinue: false })),
    // Quick play re-queue plumbing added in feat/avatar-notification-polish.
    // Tests that don't exercise the quick play path still need these stubbed
    // because createRoom / leave always call setQuickPlayContext.
    setQuickPlayContext: vi.fn(),
    getQuickPlayContext: vi.fn(() => null),
    handleResetForRequeue: vi.fn(),
  };
}

describe("useMultiplayerSocket", () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let handlers: MultiplayerGameHandlers;
  let onLeave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    handlers = createMockHandlers();
    onLeave = vi.fn();
    vi.mocked(connectSocket).mockReturnValue(mockSocket as any);
    vi.mocked(getPlayerSession).mockReturnValue(null);
  });

  /** Helper to render the hook with defaults. */
  function renderSocketHook(urlRoomCode?: string) {
    return renderHook(() =>
      useMultiplayerSocket(handlers, onLeave, urlRoomCode)
    );
  }

  /**
   * Helper: renders the hook and calls createRoom with a successful response so
   * that socketRef is populated. Returns the rendered hook for further action
   * calls. Clears the emit mock after setup so tests start with a clean slate.
   */
  function renderWithSocket() {
    const room = makeRoom({ code: "ABCD" });
    mockSocket.emit.mockImplementation(
      (event: string, _data: any, cb?: Function) => {
        if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
          cb({ room, playerId: "player-1", playerToken: "token-abc" });
        }
      }
    );

    const hook = renderSocketHook();
    act(() => {
      hook.result.current.actions.createRoom("Alice", "classic");
    });

    // Reset emit so tests see only their own calls
    mockSocket.emit.mockClear();
    mockSocket.emit.mockImplementation(
      (_event: string, _data: any, cb?: Function) => {
        if (cb) cb({});
      }
    );

    return hook;
  }

  describe("initial state", () => {
    it("returns connected status and reconnectAttempt 0", () => {
      const { result } = renderSocketHook();
      expect(result.current.connectionStatus).toBe("connected");
      expect(result.current.reconnectAttempt).toBe(0);
    });

    it("exposes all action functions", () => {
      const { result } = renderSocketHook();
      const { actions } = result.current;
      expect(typeof actions.createRoom).toBe("function");
      expect(typeof actions.joinRoom).toBe("function");
      expect(typeof actions.startRound).toBe("function");
      expect(typeof actions.submitGuess).toBe("function");
      expect(typeof actions.kickPlayer).toBe("function");
      expect(typeof actions.changeSettings).toBe("function");
      expect(typeof actions.continueFromResults).toBe("function");
      expect(typeof actions.playAgain).toBe("function");
      expect(typeof actions.leave).toBe("function");
      expect(typeof actions.manualReconnect).toBe("function");
    });
  });

  describe("createRoom", () => {
    it("emits room:create and calls savePlayerSession on success", () => {
      const room = makeRoom({ code: "XYZW" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room, playerId: "player-1", playerToken: "token-abc" });
          }
        }
      );

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.createRoom("Alice", "classic", {
          categories: ["Electronics"],
          password: "secret",
          totalRounds: 5,
        });
      });

      expect(handlers.setLoading).toHaveBeenCalledWith(true);
      expect(handlers.setError).toHaveBeenCalledWith(null);
      expect(connectSocket).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_CREATE,
        expect.objectContaining({
          displayName: "Alice",
          gameMode: "classic",
          categories: ["Electronics"],
          password: "secret",
          totalRounds: 5,
        }),
        expect.any(Function)
      );
      expect(handlers.setLoading).toHaveBeenCalledWith(false);
      expect(savePlayerSession).toHaveBeenCalledWith("XYZW", "player-1", "token-abc");
      expect(handlers.setRoom).toHaveBeenCalledWith(room);
      expect(handlers.setPlayerId).toHaveBeenCalledWith("player-1");
      expect(handlers.setScreen).toHaveBeenCalledWith("lobby");
    });

    it("sets error on failure", () => {
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ error: "Room creation failed" });
          }
        }
      );

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.createRoom("Alice", "classic");
      });

      expect(handlers.setLoading).toHaveBeenCalledWith(false);
      expect(handlers.setError).toHaveBeenCalledWith("Room creation failed");
      expect(savePlayerSession).not.toHaveBeenCalled();
      expect(handlers.setScreen).not.toHaveBeenCalledWith("lobby");
    });

    it("emits preferredAvatar from the persisted guest identity", () => {
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room: makeRoom({ code: "XYZW" }), playerId: "p", playerToken: "t" });
          }
        }
      );
      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.createRoom("Alice", "classic");
      });
      const createCall = mockSocket.emit.mock.calls.find(
        (c: unknown[]) => c[0] === SOCKET_EVENTS.ROOM_CREATE,
      );
      expect(createCall).toBeDefined();
      const payload = createCall![1] as { preferredAvatar?: string };
      expect(typeof payload.preferredAvatar).toBe("string");
      expect(payload.preferredAvatar!.length).toBeGreaterThan(0);
    });
  });

  describe("joinRoom", () => {
    it("emits room:join and calls savePlayerSession on success", () => {
      const room = makeRoom({ code: "ABCD" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_JOIN && cb) {
            cb({ room, playerId: "player-2", playerToken: "token-def" });
          }
        }
      );

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.joinRoom("ABCD", "Bob", "password123");
      });

      expect(handlers.setLoading).toHaveBeenCalledWith(true);
      expect(handlers.setError).toHaveBeenCalledWith(null);
      expect(connectSocket).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_JOIN,
        expect.objectContaining({
          roomCode: "ABCD",
          displayName: "Bob",
          password: "password123",
        }),
        expect.any(Function)
      );
      expect(handlers.setLoading).toHaveBeenCalledWith(false);
      expect(savePlayerSession).toHaveBeenCalledWith("ABCD", "player-2", "token-def");
      expect(handlers.setRoom).toHaveBeenCalledWith(room);
      expect(handlers.setPlayerId).toHaveBeenCalledWith("player-2");
      expect(handlers.setScreen).toHaveBeenCalledWith("lobby");
    });

    it("sets error on failure", () => {
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_JOIN && cb) {
            cb({ error: "Room not found" });
          }
        }
      );

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.joinRoom("ABCD", "Bob");
      });

      expect(handlers.setLoading).toHaveBeenCalledWith(false);
      expect(handlers.setError).toHaveBeenCalledWith("Room not found");
      expect(savePlayerSession).not.toHaveBeenCalled();
    });
  });

  describe("startRound", () => {
    it("emits room:host_start_countdown", () => {
      const { result } = renderWithSocket();

      act(() => {
        result.current.actions.startRound();
      });

      expect(handlers.setLoading).toHaveBeenCalledWith(true);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_HOST_START_COUNTDOWN,
        {},
        expect.any(Function)
      );
    });

    it("sets error when startRound receives an error response", () => {
      const { result } = renderWithSocket();

      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_HOST_START_COUNTDOWN && cb) {
            cb({ error: "Not enough players" });
          }
        }
      );

      act(() => {
        result.current.actions.startRound();
      });

      expect(handlers.setError).toHaveBeenCalledWith("Not enough players");
    });
  });

  describe("submitGuess", () => {
    it("sets hasGuessed and emits game:submit_guess", () => {
      const { result } = renderWithSocket();

      const guessData = { guessedPriceCents: 1500 };
      act(() => {
        result.current.actions.submitGuess(guessData);
      });

      expect(handlers.setHasGuessed).toHaveBeenCalledWith(true);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.GAME_SUBMIT_GUESS,
        { guessData },
        expect.any(Function)
      );
    });

    it("resets hasGuessed on error response", () => {
      const { result } = renderWithSocket();

      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.GAME_SUBMIT_GUESS && cb) {
            cb({ error: "Invalid guess" });
          }
        }
      );

      act(() => {
        result.current.actions.submitGuess({ guessedPriceCents: -1 });
      });

      expect(handlers.setHasGuessed).toHaveBeenCalledWith(true);
      expect(handlers.setHasGuessed).toHaveBeenCalledWith(false);
    });
  });

  describe("kickPlayer", () => {
    it("emits room:kick with target player id", () => {
      const { result } = renderWithSocket();

      act(() => {
        result.current.actions.kickPlayer("player-2");
      });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_KICK,
        { playerId: "player-2" },
        expect.any(Function)
      );
    });
  });

  describe("changeSettings", () => {
    it("emits room:settings with settings data", () => {
      const { result } = renderWithSocket();

      const settings = {
        gameMode: "higher-lower" as const,
        categories: ["Electronics"],
        totalRounds: 5,
        password: "secret",
      };
      act(() => {
        result.current.actions.changeSettings(settings);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_SETTINGS,
        settings,
        expect.any(Function)
      );
    });
  });

  describe("continueFromResults", () => {
    it("calls handleContinueFromResults and does not emit when shouldEmitContinue is false", () => {
      vi.mocked(handlers.handleContinueFromResults).mockReturnValue({
        shouldEmitContinue: false,
      });

      const { result } = renderWithSocket();

      mockSocket.emit.mockClear();

      act(() => {
        result.current.actions.continueFromResults();
      });

      expect(handlers.handleContinueFromResults).toHaveBeenCalled();
      expect(mockSocket.emit).not.toHaveBeenCalledWith(
        SOCKET_EVENTS.GAME_CONTINUE,
        expect.anything(),
        expect.anything()
      );
    });

    it("calls handleContinueFromResults and emits continue when shouldEmitContinue is true", () => {
      vi.mocked(handlers.handleContinueFromResults).mockReturnValue({
        shouldEmitContinue: true,
      });

      const { result } = renderWithSocket();

      mockSocket.emit.mockClear();

      act(() => {
        result.current.actions.continueFromResults();
      });

      expect(handlers.handleContinueFromResults).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.GAME_CONTINUE,
        {},
        expect.any(Function)
      );
    });
  });

  describe("playAgain", () => {
    it("calls handlePlayAgainLocal and emits room:play_again", () => {
      const { result } = renderWithSocket();

      act(() => {
        result.current.actions.playAgain();
      });

      expect(handlers.handlePlayAgainLocal).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_PLAY_AGAIN,
        {},
        expect.any(Function)
      );
    });
  });

  describe("leave", () => {
    it("clears session, disconnects, and calls onLeave", () => {
      const { result } = renderSocketHook();

      act(() => {
        result.current.actions.leave();
      });

      expect(clearPlayerSession).toHaveBeenCalled();
      expect(disconnectSocket).toHaveBeenCalled();
      expect(onLeave).toHaveBeenCalled();
    });
  });

  describe("manualReconnect", () => {
    it("creates new socket when session exists", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.manualReconnect();
      });

      expect(connectSocket).toHaveBeenCalled();
      // Should set up listeners on the new socket (connect handler will auto-rejoin)
      expect(mockSocket.on).toHaveBeenCalled();
    });

    it("calls onLeave when no session exists", () => {
      vi.mocked(getPlayerSession).mockReturnValue(null);

      const { result } = renderSocketHook();
      act(() => {
        result.current.actions.manualReconnect();
      });

      expect(onLeave).toHaveBeenCalled();
    });
  });

  describe("auto-rejoin on mount", () => {
    it("attempts rejoin when urlRoomCode matches saved session", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });

      const room = makeRoom({ code: "ABCD" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_REJOIN && cb) {
            cb({ room, playerId: "player-1" });
          }
        }
      );

      renderSocketHook("ABCD");

      expect(handlers.setLoading).toHaveBeenCalledWith(true);
      expect(connectSocket).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.ROOM_REJOIN,
        { roomCode: "ABCD", playerToken: "token-abc" },
        expect.any(Function)
      );
      expect(handlers.setRoom).toHaveBeenCalledWith(room);
      expect(handlers.setPlayerId).toHaveBeenCalledWith("player-1");
      expect(handlers.restoreScreenFromRoomState).toHaveBeenCalled();
    });

    it("surfaces a typed error code on rejoin failure and does NOT silently call onLeave", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });

      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_REJOIN && cb) {
            cb({ error: true, code: "room_expired" });
          }
        }
      );

      const { result } = renderSocketHook("ABCD");

      expect(handlers.setLoading).toHaveBeenCalledWith(false);
      expect(clearPlayerSession).toHaveBeenCalled();
      // The important invariant: the user is NOT silently navigated home.
      expect(onLeave).not.toHaveBeenCalled();
      expect(result.current.connectionStatus).toBe("rejoin_failed");
      expect(result.current.rejoinErrorCode).toBe("room_expired");
    });

    it("emits game:continue when restoreScreenFromRoomState returns shouldEmitContinue", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });

      vi.mocked(handlers.restoreScreenFromRoomState).mockReturnValue({
        shouldEmitContinue: true,
      });

      const room = makeRoom({ code: "ABCD", status: "between_rounds" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_REJOIN && cb) {
            cb({ room, playerId: "player-1" });
          }
        }
      );

      renderSocketHook("ABCD");

      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.GAME_CONTINUE,
        {},
        expect.any(Function)
      );
    });
  });

  describe("fetchRoomInfo", () => {
    it("fetches room info when urlRoomCode does not match saved session", async () => {
      vi.mocked(getPlayerSession).mockReturnValue(null);

      const room = makeRoom({ code: "WXYZ" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(room),
      } as Response);

      renderSocketHook("WXYZ");
      await flushMicrotasks();

      expect(fetchSpy).toHaveBeenCalledWith("/api/mp/room/WXYZ");
      expect(handlers.setRoom).toHaveBeenCalledWith(room);
      fetchSpy.mockRestore();
    });

    it("calls onLeave when fetch returns non-ok response", async () => {
      vi.mocked(getPlayerSession).mockReturnValue(null);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
      } as Response);

      renderSocketHook("WXYZ");
      await flushMicrotasks();

      expect(onLeave).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("calls onLeave when fetch throws", async () => {
      vi.mocked(getPlayerSession).mockReturnValue(null);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

      renderSocketHook("WXYZ");
      await flushMicrotasks();

      expect(onLeave).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("fetches room info when saved session roomCode differs from url", async () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "AAAA",
        playerId: "player-1",
        playerToken: "token-old",
      });

      const room = makeRoom({ code: "BBBB" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(room),
      } as Response);

      renderSocketHook("BBBB");
      await flushMicrotasks();

      expect(fetchSpy).toHaveBeenCalledWith("/api/mp/room/BBBB");
      expect(handlers.setRoom).toHaveBeenCalledWith(room);
      fetchSpy.mockRestore();
    });
  });

  describe("socket event listeners", () => {
    /**
     * Helper: creates a room so that socketRef is set and listeners are
     * registered, then returns the listener map.
     */
    function setupWithListeners() {
      const room = makeRoom({ code: "ABCD" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room, playerId: "player-1", playerToken: "token-abc" });
          }
        }
      );

      const hook = renderSocketHook();
      act(() => {
        hook.result.current.actions.createRoom("Alice", "classic");
      });

      return { hook, listeners: mockSocket.listeners, ioListeners: mockSocket.ioListeners };
    }

    it("registers listeners after createRoom succeeds", () => {
      const { listeners, ioListeners } = setupWithListeners();

      expect(listeners.has(SOCKET_EVENTS.ROOM_PLAYER_JOINED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_PLAYER_LEFT)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_PLAYER_RECONNECTED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_PLAYER_KICKED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_HOST_CHANGED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.ROOM_UPDATED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.GAME_ROUND_START)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.GAME_PLAYER_LOCKED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.GAME_PLAYER_CONTINUED)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.GAME_ROUND_END)).toBe(true);
      expect(listeners.has(SOCKET_EVENTS.GAME_OVER)).toBe(true);
      expect(listeners.has("disconnect")).toBe(true);
      expect(listeners.has("connect")).toBe(true);
      expect(ioListeners.has("reconnect_attempt")).toBe(true);
      expect(ioListeners.has("reconnect_failed")).toBe(true);
    });

    it("player_joined listener calls handlePlayerJoined", () => {
      const { listeners } = setupWithListeners();
      const player = { id: "player-3", displayName: "Charlie" };

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_PLAYER_JOINED)!({ player });
      });

      expect(handlers.handlePlayerJoined).toHaveBeenCalledWith(player);
    });

    it("player_left listener calls handlePlayerLeft", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_PLAYER_LEFT)!({ playerId: "player-2" });
      });

      expect(handlers.handlePlayerLeft).toHaveBeenCalledWith("player-2");
    });

    it("player_reconnected listener calls handlePlayerReconnected", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_PLAYER_RECONNECTED)!({ playerId: "player-2" });
      });

      expect(handlers.handlePlayerReconnected).toHaveBeenCalledWith("player-2");
    });

    it("player_kicked listener calls handlePlayerKicked", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_PLAYER_KICKED)!({ playerId: "player-2" });
      });

      expect(handlers.handlePlayerKicked).toHaveBeenCalledWith("player-2");
    });

    it("player_kicked disconnects and leaves when self is kicked", () => {
      const { listeners } = setupWithListeners();

      // getPlayerId returns "player-1", so being kicked as player-1 means self-kick
      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_PLAYER_KICKED)!({ playerId: "player-1" });
      });

      expect(handlers.handlePlayerKicked).toHaveBeenCalledWith("player-1");
      expect(clearPlayerSession).toHaveBeenCalled();
      expect(disconnectSocket).toHaveBeenCalled();
      expect(onLeave).toHaveBeenCalled();
    });

    it("host_changed listener calls handleHostChanged", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_HOST_CHANGED)!({ newHostId: "player-2" });
      });

      expect(handlers.handleHostChanged).toHaveBeenCalledWith("player-2");
    });

    it("settings_updated listener calls handleSettingsUpdated", () => {
      const { listeners } = setupWithListeners();
      const data = {
        gameMode: "higher-lower",
        categories: ["Electronics"],
        totalRounds: 5,
        hasPassword: true,
      };

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED)!(data);
      });

      expect(handlers.handleSettingsUpdated).toHaveBeenCalledWith(data);
    });

    it("room_updated listener calls handleRoomUpdated", () => {
      const { listeners } = setupWithListeners();
      const updatedRoom = makeRoom({ code: "WXYZ" });

      act(() => {
        listeners.get(SOCKET_EVENTS.ROOM_UPDATED)!(updatedRoom);
      });

      expect(handlers.handleRoomUpdated).toHaveBeenCalledWith(updatedRoom);
    });

    it("round_start listener calls handleRoundStart", () => {
      // The hasExplicitlyLeft guard requires a saved session to allow
      // the listener to run — savePlayerSession is mocked, so we wire
      // getPlayerSession to mirror that for this test.
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      const { listeners } = setupWithListeners();
      const payload = { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: {} };

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_ROUND_START)!(payload);
      });

      expect(handlers.handleRoundStart).toHaveBeenCalledWith(payload);
    });

    it("round_start listener SUPPRESSES handler when player has explicitly left (no MP session)", () => {
      // No saved session → hasExplicitlyLeft returns true → handler is
      // suppressed even though the socket is technically still alive.
      vi.mocked(getPlayerSession).mockReturnValue(null);
      const { listeners } = setupWithListeners();
      const payload = { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: {} };

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_ROUND_START)!(payload);
      });

      expect(handlers.handleRoundStart).not.toHaveBeenCalled();
    });

    it("player_locked listener calls handlePlayerLocked", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_PLAYER_LOCKED)!({ playerId: "player-2" });
      });

      expect(handlers.handlePlayerLocked).toHaveBeenCalledWith("player-2");
    });

    it("player_continued listener calls handlePlayerContinued", () => {
      const { listeners } = setupWithListeners();

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_PLAYER_CONTINUED)!({ playerId: "player-2" });
      });

      expect(handlers.handlePlayerContinued).toHaveBeenCalledWith("player-2");
    });

    it("round_end listener calls handleRoundEnd", () => {
      const { listeners } = setupWithListeners();
      const results = { roundNumber: 1, playerResults: [], standings: [] };

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_ROUND_END)!(results);
      });

      expect(handlers.handleRoundEnd).toHaveBeenCalledWith(results);
    });

    it("game_over listener calls handleGameOver with results", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      const { listeners } = setupWithListeners();
      const results = { roundNumber: 5, playerResults: [], standings: [] };

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_OVER)!({ results, roomCode: "ABCD" });
      });

      expect(handlers.handleGameOver).toHaveBeenCalledWith(results);
    });

    it("game_over listener SUPPRESSES handler when player has explicitly left (no MP session)", () => {
      // Reproduces the auto-return-to-game bug: user left mid-game, the
      // session was cleared via actions.leave(), but a server-side
      // game_over arrives before the socket has fully torn down. Without
      // the guard, this would yank the user back into the MP results
      // screen even though they're now on home / a different page.
      vi.mocked(getPlayerSession).mockReturnValue(null);
      const { listeners } = setupWithListeners();
      const results = { roundNumber: 5, playerResults: [], standings: [] };

      act(() => {
        listeners.get(SOCKET_EVENTS.GAME_OVER)!({ results, roomCode: "ABCD" });
      });

      expect(handlers.handleGameOver).not.toHaveBeenCalled();
    });

    it("game_over listener SUPPRESSES handler when URL no longer matches the registered room code", () => {
      // The user is still authenticated for the MP session (rejoin token
      // is intact for the rejoin banner) but has navigated to a different
      // page. The path-mismatch branch of the guard fires.
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      const room = makeRoom({ code: "ABCD" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room, playerId: "player-1", playerToken: "token-abc" });
          }
        }
      );
      const hook = renderHook(() =>
        useMultiplayerSocket(handlers, onLeave, "ABCD")
      );
      act(() => {
        hook.result.current.actions.createRoom("Alice", "classic");
      });
      // createRoom replaceState's to `/ABCD` — simulate the user
      // navigating away to home so the path-mismatch branch fires.
      window.history.replaceState(null, "", "/");

      const results = { roundNumber: 5, playerResults: [], standings: [] };
      act(() => {
        mockSocket.listeners.get(SOCKET_EVENTS.GAME_OVER)!({ results, roomCode: "ABCD" });
      });

      expect(handlers.handleGameOver).not.toHaveBeenCalled();
    });

    it("disconnect listener sets status to reconnecting for unintentional disconnect", () => {
      const { hook, listeners } = setupWithListeners();

      act(() => {
        listeners.get("disconnect")!("transport close");
      });

      expect(hook.result.current.connectionStatus).toBe("reconnecting");
      expect(hook.result.current.reconnectAttempt).toBe(0);
    });

    it("disconnect listener ignores intentional client disconnect", () => {
      const { hook, listeners } = setupWithListeners();

      act(() => {
        listeners.get("disconnect")!("io client disconnect");
      });

      // Should remain connected (not set to reconnecting)
      expect(hook.result.current.connectionStatus).toBe("connected");
    });

    it("reconnect_attempt updates attempt counter", () => {
      const { hook, ioListeners } = setupWithListeners();

      act(() => {
        ioListeners.get("reconnect_attempt")!(3);
      });

      expect(hook.result.current.reconnectAttempt).toBe(3);
    });

    it("reconnect_failed sets status to disconnected", () => {
      const { hook, ioListeners } = setupWithListeners();

      act(() => {
        ioListeners.get("reconnect_failed")!();
      });

      expect(hook.result.current.connectionStatus).toBe("disconnected");
    });

    it("connect listener stays in resyncing until ROOM_REJOIN acks", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      // Queue: listeners register, then emit-on-ROOM_REJOIN holds the
      // callback so we can inspect the intermediate state. Other emits
      // still complete synchronously for the createRoom path.
      let rejoinCb: Function | null = null;
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room: makeRoom({ code: "ABCD" }), playerId: "player-1", playerToken: "token-abc" });
            return;
          }
          if (event === SOCKET_EVENTS.ROOM_REJOIN) {
            rejoinCb = cb ?? null;
            return;
          }
          if (cb) cb({});
        }
      );
      const { result } = renderSocketHook();
      act(() => { result.current.actions.createRoom("Alice", "classic"); });
      const onConnect = mockSocket.listeners.get("connect")!;

      // Simulate a reconnect: socket 'connect' fires, rejoin emit
      // goes out and awaits ack. We should be in "resyncing".
      act(() => { onConnect(); });
      expect(result.current.connectionStatus).toBe("resyncing");
      expect(rejoinCb).not.toBeNull();

      // Ack arrives → status flips to "connected".
      const room = makeRoom({ code: "ABCD" });
      act(() => { rejoinCb!({ room, playerId: "player-1" }); });
      expect(result.current.connectionStatus).toBe("connected");
    });

    it("connect listener falls into rejoin_failed with typed code when ack reports error", () => {
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room: makeRoom({ code: "ABCD" }), playerId: "player-1", playerToken: "token-abc" });
            return;
          }
          if (event === SOCKET_EVENTS.ROOM_REJOIN && cb) {
            cb({ error: true, code: "kicked" });
            return;
          }
          if (cb) cb({});
        }
      );
      const { result } = renderSocketHook();
      act(() => { result.current.actions.createRoom("Alice", "classic"); });
      const onConnect = mockSocket.listeners.get("connect")!;

      act(() => { onConnect(); });
      expect(result.current.connectionStatus).toBe("rejoin_failed");
      expect(result.current.rejoinErrorCode).toBe("kicked");
      // Kicked is terminal — session should be cleared, user should NOT
      // be force-navigated.
      expect(clearPlayerSession).toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
    });

    it("connect listener transitions to rejoin_failed with 'timeout' when no ack arrives in time", () => {
      vi.useFakeTimers();
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room: makeRoom({ code: "ABCD" }), playerId: "player-1", playerToken: "token-abc" });
            return;
          }
          // For ROOM_REJOIN, DO NOT invoke the callback — simulate a
          // server that's taking too long to respond.
          if (event === SOCKET_EVENTS.ROOM_REJOIN) return;
          if (cb) cb({});
        }
      );
      const { result } = renderSocketHook();
      act(() => { result.current.actions.createRoom("Alice", "classic"); });
      const onConnect = mockSocket.listeners.get("connect")!;

      act(() => { onConnect(); });
      expect(result.current.connectionStatus).toBe("resyncing");

      // Advance past the 8s rejoin-ack timeout.
      act(() => { vi.advanceTimersByTime(8500); });
      expect(result.current.connectionStatus).toBe("rejoin_failed");
      expect(result.current.rejoinErrorCode).toBe("timeout");
      expect(onLeave).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("a late rejoin ack arriving after the timeout does not stomp rejoin_failed state", () => {
      vi.useFakeTimers();
      vi.mocked(getPlayerSession).mockReturnValue({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-abc",
      });
      let rejoinCb: Function | null = null;
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room: makeRoom({ code: "ABCD" }), playerId: "player-1", playerToken: "token-abc" });
            return;
          }
          if (event === SOCKET_EVENTS.ROOM_REJOIN) {
            rejoinCb = cb ?? null;
            return;
          }
          if (cb) cb({});
        }
      );
      const { result } = renderSocketHook();
      act(() => { result.current.actions.createRoom("Alice", "classic"); });
      const onConnect = mockSocket.listeners.get("connect")!;

      act(() => { onConnect(); });
      // Cross the timeout — state goes to rejoin_failed.
      act(() => { vi.advanceTimersByTime(8500); });
      expect(result.current.connectionStatus).toBe("rejoin_failed");
      expect(result.current.rejoinErrorCode).toBe("timeout");

      // Now a late ack arrives. It must NOT flip us back to connected
      // or overwrite the timeout error — the user already saw the
      // error UI and may have chosen to retry.
      const room = makeRoom({ code: "ABCD" });
      act(() => { rejoinCb!({ room, playerId: "player-1" }); });
      expect(result.current.connectionStatus).toBe("rejoin_failed");
      expect(result.current.rejoinErrorCode).toBe("timeout");

      vi.useRealTimers();
    });
  });

  describe("cleanup on unmount", () => {
    it("calls disconnectSocket on unmount", () => {
      const { unmount } = renderSocketHook();

      vi.mocked(disconnectSocket).mockClear();
      unmount();

      expect(disconnectSocket).toHaveBeenCalled();
    });

    it("cleans up socket listeners on unmount", () => {
      // Set up a room so listeners are registered
      const room = makeRoom({ code: "ABCD" });
      mockSocket.emit.mockImplementation(
        (event: string, _data: any, cb?: Function) => {
          if (event === SOCKET_EVENTS.ROOM_CREATE && cb) {
            cb({ room, playerId: "player-1", playerToken: "token-abc" });
          }
        }
      );

      const { result, unmount } = renderSocketHook();
      act(() => {
        result.current.actions.createRoom("Alice", "classic");
      });

      unmount();

      // off should have been called for cleanup
      expect(mockSocket.off).toHaveBeenCalled();
      expect(mockSocket.io.off).toHaveBeenCalled();
    });
  });
});
