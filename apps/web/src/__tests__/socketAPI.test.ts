import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the socket singleton management functions (getSocket, connectSocket,
 * disconnectSocket) and session helpers.
 *
 * socket.io-client is mocked to avoid real network connections in tests.
 * vi.resetModules() is called in beforeEach to reset the module-level socket
 * singleton so each test starts with a fresh socket instance.
 *
 * NOTE: the session helpers were migrated from sessionStorage to
 * localStorage (with a TTL blob) to survive mobile OS tab eviction.
 * Assertions here target the new `mp_session_v2` localStorage key.
 */
vi.mock("socket.io-client", () => {
  const mockSocket = {
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return { io: vi.fn(() => mockSocket) };
});

describe("socket API", () => {
  let socketModule: typeof import("../api/socket");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    socketModule = await import("../api/socket");
  });

  /** Helper: parse the stored session blob, or return null. */
  function readStoredSession(): { roomCode: string; playerId: string; playerToken: string; savedAt: number } | null {
    const raw = localStorage.getItem("mp_session_v2");
    return raw ? JSON.parse(raw) : null;
  }

  // -------------------------------------------------------------------------
  // getSocket
  // -------------------------------------------------------------------------
  describe("getSocket", () => {
    it("calls io() to create a socket on first invocation", async () => {
      const { io } = await import("socket.io-client");
      socketModule.getSocket();
      expect(io).toHaveBeenCalled();
    });

    it("returns a socket object (the mock socket from io())", () => {
      const socket = socketModule.getSocket();
      // Verify the returned object is the mock socket (has connect/disconnect)
      expect(socket).toHaveProperty("connect");
      expect(socket).toHaveProperty("disconnect");
    });

    it("io() was called at least once when the module initialized", () => {
      // The socket is a lazy singleton — getSocket() triggers io() on first call.
      const socket = socketModule.getSocket();
      expect(socket).toBeTruthy();
    });

    it("returns the same socket instance on repeated calls (singleton)", () => {
      const first = socketModule.getSocket();
      const second = socketModule.getSocket();
      expect(first).toBe(second);
    });
  });

  // -------------------------------------------------------------------------
  // connectSocket
  // -------------------------------------------------------------------------
  describe("connectSocket", () => {
    it("calls socket.connect() when the socket is not connected", () => {
      const socket = socketModule.getSocket();
      // Ensure socket is not connected
      (socket as unknown as { connected: boolean }).connected = false;
      socketModule.connectSocket();
      expect(socket.connect).toHaveBeenCalledTimes(1);
    });

    it("does not call socket.connect() when the socket is already connected", () => {
      const socket = socketModule.getSocket();
      (socket as unknown as { connected: boolean }).connected = true;
      socketModule.connectSocket();
      expect(socket.connect).not.toHaveBeenCalled();
      // Reset for subsequent tests
      (socket as unknown as { connected: boolean }).connected = false;
    });

    it("returns the socket instance", () => {
      const socket = socketModule.getSocket();
      (socket as unknown as { connected: boolean }).connected = false;
      const result = socketModule.connectSocket();
      expect(result).toBe(socket);
    });
  });

  // -------------------------------------------------------------------------
  // disconnectSocket
  // -------------------------------------------------------------------------
  describe("disconnectSocket", () => {
    it("calls socket.disconnect() when the socket is connected", () => {
      const socket = socketModule.getSocket();
      (socket as unknown as { connected: boolean }).connected = true;
      socketModule.disconnectSocket();
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      (socket as unknown as { connected: boolean }).connected = false;
    });

    it("does not call socket.disconnect() when the socket is not connected", () => {
      const socket = socketModule.getSocket();
      (socket as unknown as { connected: boolean }).connected = false;
      socketModule.disconnectSocket();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // savePlayerSession
  // -------------------------------------------------------------------------
  describe("savePlayerSession", () => {
    it("stores roomCode in the localStorage blob", () => {
      socketModule.savePlayerSession("ROOM1", "player-1", "token-abc");
      expect(readStoredSession()?.roomCode).toBe("ROOM1");
    });

    it("stores playerId in the localStorage blob", () => {
      socketModule.savePlayerSession("ROOM1", "player-42", "token-abc");
      expect(readStoredSession()?.playerId).toBe("player-42");
    });

    it("stores playerToken in the localStorage blob", () => {
      socketModule.savePlayerSession("ROOM1", "player-1", "tok-secret");
      expect(readStoredSession()?.playerToken).toBe("tok-secret");
    });

    it("stamps the blob with savedAt so TTL checks work on read", () => {
      const before = Date.now();
      socketModule.savePlayerSession("ROOM1", "player-1", "tok");
      const after = Date.now();
      const saved = readStoredSession();
      expect(saved?.savedAt).toBeGreaterThanOrEqual(before);
      expect(saved?.savedAt).toBeLessThanOrEqual(after);
    });

    it("overwrites an existing session when called again", () => {
      socketModule.savePlayerSession("OLD_ROOM", "old-player", "old-token");
      socketModule.savePlayerSession("NEW_ROOM", "new-player", "new-token");
      const saved = readStoredSession();
      expect(saved?.roomCode).toBe("NEW_ROOM");
      expect(saved?.playerId).toBe("new-player");
      expect(saved?.playerToken).toBe("new-token");
    });
  });

  // -------------------------------------------------------------------------
  // getPlayerSession
  // -------------------------------------------------------------------------
  describe("getPlayerSession", () => {
    it("returns the full session object when the blob is present and fresh", () => {
      socketModule.savePlayerSession("ABCD", "player-1", "token-xyz");
      const session = socketModule.getPlayerSession();
      expect(session).toEqual({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-xyz",
      });
    });

    it("returns null when no session is stored", () => {
      expect(socketModule.getPlayerSession()).toBeNull();
    });

    it("returns null when the blob is malformed JSON (and evicts the bad entry)", () => {
      localStorage.setItem("mp_session_v2", "{not json");
      expect(socketModule.getPlayerSession()).toBeNull();
      expect(localStorage.getItem("mp_session_v2")).toBeNull();
    });

    it("returns null when the blob is missing a required field", () => {
      // No playerToken.
      localStorage.setItem("mp_session_v2", JSON.stringify({
        roomCode: "ABCD",
        playerId: "player-1",
        savedAt: Date.now(),
      }));
      expect(socketModule.getPlayerSession()).toBeNull();
    });

    it("migrates a legacy sessionStorage session on first read", () => {
      sessionStorage.setItem("mp_room_code", "LEG");
      sessionStorage.setItem("mp_player_id", "old-player");
      sessionStorage.setItem("mp_player_token", "old-token");
      expect(socketModule.getPlayerSession()).toEqual({
        roomCode: "LEG",
        playerId: "old-player",
        playerToken: "old-token",
      });
      // Legacy keys should be swept.
      expect(sessionStorage.getItem("mp_room_code")).toBeNull();
      expect(readStoredSession()?.roomCode).toBe("LEG");
    });
  });

  // -------------------------------------------------------------------------
  // clearPlayerSession
  // -------------------------------------------------------------------------
  describe("clearPlayerSession", () => {
    it("removes the localStorage blob and any legacy sessionStorage keys", () => {
      socketModule.savePlayerSession("ABCD", "player-1", "token-xyz");
      sessionStorage.setItem("mp_room_code", "LEG");
      socketModule.clearPlayerSession();
      expect(localStorage.getItem("mp_session_v2")).toBeNull();
      expect(sessionStorage.getItem("mp_room_code")).toBeNull();
    });

    it("does not throw when no session data exists", () => {
      expect(() => socketModule.clearPlayerSession()).not.toThrow();
    });

    it("getPlayerSession returns null after clearPlayerSession", () => {
      socketModule.savePlayerSession("ABCD", "player-1", "token-xyz");
      socketModule.clearPlayerSession();
      expect(socketModule.getPlayerSession()).toBeNull();
    });
  });
});
