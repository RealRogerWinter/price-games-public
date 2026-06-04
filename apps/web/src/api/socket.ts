import { io, Socket } from "socket.io-client";
import { MP_SESSION_TTL_MS } from "@price-game/shared";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 15,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // Cap the handshake at 10s so a mobile browser waking up next to
      // a dead TCP connection doesn't sit on a 20s default before we
      // hear about it and start reconnecting.
      timeout: 10000,
    });
    // The 24/7 stream bot's page-bridge probe (packages/bot-streamer)
    // looks for the Socket.IO instance on this global so it can attach
    // an `onAny` forwarder to surface server events to the Node-side
    // observer. The assignment is unconditional: it's a tiny pointer
    // either way, and gating it on broadcast mode would couple the
    // socket layer to the URL-flag check unnecessarily.
    if (typeof window !== "undefined") {
      (window as unknown as { __pgBotSocket?: Socket }).__pgBotSocket = socket;
    }
  }
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  return s;
}

export function disconnectSocket(): void {
  if (socket?.connected) {
    socket.disconnect();
  }
}

// Persistent rejoin session. Stored in localStorage (not sessionStorage)
// so the session survives the mobile OS evicting the browser tab while
// backgrounded — the common cause of the "dumped to home with no
// error" bug. A TTL caps how long we'll auto-rejoin into a stale game.
const MP_SESSION_KEY = "mp_session_v2";
// Legacy keys from the old sessionStorage-based implementation. Cleaned
// up lazily so users upgrading don't carry dead entries around forever.
const LEGACY_SESSION_KEYS = ["mp_room_code", "mp_player_token", "mp_player_id"] as const;

export interface PlayerSession {
  roomCode: string;
  playerId: string;
  playerToken: string;
}

interface StoredSession extends PlayerSession {
  savedAt: number;
}

/**
 * Persist the multiplayer rejoin session. Overwrites any existing
 * entry and stamps the current time so TTL checks work on read.
 */
export function savePlayerSession(roomCode: string, playerId: string, playerToken: string): void {
  const payload: StoredSession = { roomCode, playerId, playerToken, savedAt: Date.now() };
  try {
    localStorage.setItem(MP_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Storage quota / disabled — session is best-effort.
  }
  // Sweep legacy sessionStorage keys on every write so migrating
  // clients don't keep stale data around.
  try {
    for (const key of LEGACY_SESSION_KEYS) sessionStorage.removeItem(key);
  } catch { /* sessionStorage can throw in some embedded contexts */ }
}

/**
 * Read the rejoin session if it's still within the TTL window. Stale
 * or malformed entries are removed as a side-effect so the next read
 * doesn't keep hitting the same bad data.
 */
export function getPlayerSession(): PlayerSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MP_SESSION_KEY);
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        parsed &&
        typeof parsed.roomCode === "string" &&
        typeof parsed.playerId === "string" &&
        typeof parsed.playerToken === "string" &&
        typeof parsed.savedAt === "number" &&
        Date.now() - parsed.savedAt <= MP_SESSION_TTL_MS
      ) {
        return {
          roomCode: parsed.roomCode,
          playerId: parsed.playerId,
          playerToken: parsed.playerToken,
        };
      }
      // Malformed or expired — clear so we don't keep paying the parse cost.
      try { localStorage.removeItem(MP_SESSION_KEY); } catch { /* noop */ }
    } catch {
      try { localStorage.removeItem(MP_SESSION_KEY); } catch { /* noop */ }
    }
  }

  // Migration path: an older client may still have sessionStorage keys
  // from before this change. Hydrate the new shape so an in-progress
  // game survives the upgrade, then clear the legacy entries.
  try {
    const legacyRoom = sessionStorage.getItem("mp_room_code");
    const legacyId = sessionStorage.getItem("mp_player_id");
    const legacyToken = sessionStorage.getItem("mp_player_token");
    if (legacyRoom && legacyId && legacyToken) {
      savePlayerSession(legacyRoom, legacyId, legacyToken);
      return { roomCode: legacyRoom, playerId: legacyId, playerToken: legacyToken };
    }
  } catch { /* noop */ }

  return null;
}

/**
 * Remove the saved rejoin session (on explicit leave, kick, or
 * unrecoverable rejoin failure). Also sweeps the legacy sessionStorage
 * keys defensively.
 */
export function clearPlayerSession(): void {
  try { localStorage.removeItem(MP_SESSION_KEY); } catch { /* noop */ }
  try {
    for (const key of LEGACY_SESSION_KEYS) sessionStorage.removeItem(key);
  } catch { /* noop */ }
}
