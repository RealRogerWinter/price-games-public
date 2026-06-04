/**
 * Test helper for Socket.IO integration tests.
 *
 * Provides a real HTTP + Socket.IO server backed by an in-memory SQLite
 * database. Connects real socket.io-client instances for end-to-end
 * multiplayer testing.
 */
import { createServer, Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { setupSocketHandlers } from "../socket/handlers";
import {
  resetAllSocketState,
  setDisconnectGraceMs,
  cancelAllPendingDisconnects,
} from "../socket/socketState";
import { createTestDb, seedProducts } from "./dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

export interface TestServer {
  httpServer: HttpServer;
  io: IOServer;
  db: DatabaseType;
  port: number;
  url: string;
}

/**
 * Create a test server with Socket.IO and an in-memory database.
 *
 * @param productCount - Number of test products to seed (default 50).
 * @param options - Extra knobs — `disconnectGraceMs` overrides the
 *        deferred-disconnect grace window (default 50 ms so most
 *        existing tests behave as if the disconnect is synchronous;
 *        grace-specific tests can pass a longer value).
 * @returns Server instance with db, port, and url.
 */
export async function createTestServer(
  productCount: number = 50,
  options: { disconnectGraceMs?: number } = {}
): Promise<TestServer> {
  // Clear all socket state from previous tests (rate limiters, player maps, etc.)
  resetAllSocketState();
  setDisconnectGraceMs(options.disconnectGraceMs ?? 50);

  const db = createTestDb();
  seedProducts(db, productCount);

  // Inject test DB into the db module
  const dbMod = await import("../db");
  (dbMod as any).default = db;

  const httpServer = createServer();
  const io = new IOServer(httpServer, {
    cors: { origin: "*" },
    // Long timeouts to prevent false disconnects during tests
    pingInterval: 50000,
    pingTimeout: 30000,
  });

  setupSocketHandlers(io);

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        httpServer,
        io,
        db,
        port: addr.port,
        url: `http://localhost:${addr.port}`,
      });
    });
  });
}

/**
 * Connect a socket.io-client to the test server.
 *
 * @param url - Server URL.
 * @param timeoutMs - Connection timeout in milliseconds (default 5000).
 * @param extraHeaders - HTTP headers to attach to the websocket
 *   handshake. Tests typically inject `cookie: visitor_id=<uuid>` so
 *   the server-side socket middleware can read the visitor identity
 *   and stamp it on emitted analytics events; without it the emit
 *   path silently no-ops.
 * @returns Connected client socket.
 */
export function connectClient(
  url: string,
  timeoutMs: number = 5000,
  extraHeaders: Record<string, string> = {},
): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ["websocket"],
      forceNew: true,
      // socket.io-client passes extraHeaders to the websocket handshake.
      // Tests use this to inject a visitor_id cookie so the server-side
      // socket middleware can read it via socket.handshake.headers.cookie
      // and emit MP_* analytics events bound to a real visitorId.
      extraHeaders,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timeout connecting to ${url}`));
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

/**
 * Close a test server and all connected sockets.
 *
 * @param server - The test server to shut down.
 */
export async function closeTestServer(server: TestServer): Promise<void> {
  return new Promise((resolve) => {
    server.io.close(() => {
      server.httpServer.close(() => {
        // Clearing the io server triggers per-socket disconnect handlers
        // which each schedule a deferred `finalizeDisconnect` timer.
        // Those timers would fire after `db.close()` and throw
        // "The database connection is not open" — cancel them first.
        cancelAllPendingDisconnects();
        server.db.close();
        resolve();
      });
    });
  });
}

/**
 * Disconnect a client socket and wait for it to fully close.
 *
 * @param socket - Client socket to disconnect.
 */
export function disconnectClient(socket: ClientSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.disconnected) {
      resolve();
      return;
    }
    socket.on("disconnect", () => resolve());
    socket.disconnect();
  });
}

export interface RoomCreationResult {
  room: any;
  playerId: string;
  playerToken: string;
}

/**
 * Create a room via a connected socket.
 *
 * @param socket - Connected client socket.
 * @param displayName - Player display name.
 * @param options - Room creation options.
 * @returns Room creation result.
 */
export function createRoom(
  socket: ClientSocket,
  displayName: string,
  options?: { gameMode?: string; categories?: string[]; password?: string; totalRounds?: number }
): Promise<RoomCreationResult> {
  return new Promise((resolve, reject) => {
    socket.emit("room:create", { displayName, ...options }, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Join a room via a connected socket.
 *
 * @param socket - Connected client socket.
 * @param roomCode - Room code to join.
 * @param displayName - Player display name.
 * @param password - Room password if required.
 * @returns Join result with room, playerId, playerToken.
 */
export function joinRoom(
  socket: ClientSocket,
  roomCode: string,
  displayName: string,
  password?: string
): Promise<RoomCreationResult> {
  return new Promise((resolve, reject) => {
    socket.emit("room:join", { roomCode, displayName, password }, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Rejoin a room via a connected socket.
 *
 * @param socket - Connected client socket.
 * @param roomCode - Room code.
 * @param playerToken - Player reconnection token.
 * @returns Rejoin result.
 */
export function rejoinRoom(
  socket: ClientSocket,
  roomCode: string,
  playerToken: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("room:rejoin", { roomCode, playerToken }, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Start a round via a connected socket.
 *
 * @param socket - Connected client socket (must be host).
 * @returns Success/error response.
 */
export function startRound(socket: ClientSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("room:start_round", {}, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Submit a guess via a connected socket.
 *
 * @param socket - Connected client socket.
 * @param guessData - Mode-specific guess data.
 * @returns Score result.
 */
export function submitGuess(socket: ClientSocket, guessData: any): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("game:submit_guess", { guessData }, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Send continue vote via a connected socket.
 *
 * @param socket - Connected client socket.
 * @returns Success response.
 */
export function continueRound(socket: ClientSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("game:continue", {}, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Play again via a connected socket.
 *
 * @param socket - Connected client socket (must be host).
 * @returns Success response.
 */
export function playAgain(socket: ClientSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("room:play_again", {}, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Update room settings via a connected socket.
 *
 * @param socket - Connected client socket (must be host).
 * @param settings - Settings to update.
 * @returns Success response.
 */
export function updateSettings(socket: ClientSocket, settings: any): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("room:settings", settings, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Kick a player via a connected socket.
 *
 * @param socket - Connected client socket (must be host).
 * @param playerId - Player to kick.
 * @returns Success response.
 */
export function kickPlayer(socket: ClientSocket, playerId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit("room:kick", { playerId }, (response: any) => {
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * Wait for a specific event on a socket with timeout.
 *
 * @param socket - Client socket to listen on.
 * @param event - Event name.
 * @param timeoutMs - Timeout in milliseconds (default 5000).
 * @returns Event data.
 */
export function waitForEvent(socket: ClientSocket, event: string, timeoutMs: number = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (data: any) => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    socket.once(event, handler);
  });
}

/**
 * Collect events on a socket into an array.
 *
 * @param socket - Client socket to listen on.
 * @param event - Event name.
 * @returns Object with events array and a stop function.
 */
export function collectEvents(socket: ClientSocket, event: string): { events: any[]; stop: () => void } {
  const events: any[] = [];
  const handler = (data: any) => events.push(data);
  socket.on(event, handler);
  return {
    events,
    stop: () => socket.off(event, handler),
  };
}
