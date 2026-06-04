/**
 * Socket connection state and rate limiting.
 *
 * Centralizes all module-level Maps that track socket-to-player
 * associations and per-socket/per-IP rate limits.
 */

import type { Socket } from "socket.io";
import { isIP } from "net";
import { config } from "../config";

/**
 * True when `ip` is an address Express would treat as a trusted proxy hop
 * under `trust proxy: ["loopback", "linklocal", "uniquelocal"]`. We honor
 * `X-Forwarded-For` from these sources only.
 *
 * In production, the Express server runs in a Docker container behind Caddy
 * on the host. Docker default-bridge port-mapping rewrites the source IP to
 * the bridge gateway (e.g. `172.18.0.1`) — NOT loopback — so a strict
 * loopback-only check would silently ignore Caddy's XFF and collapse every
 * external client into one bucket.
 */
function isTrustedProxySource(ip: string): boolean {
  // Reject anything that isn't a parseable IPv4/IPv6 literal. `net.isIP`
  // returns 0 for non-IPs, so a malformed/forged `socket.handshake.address`
  // like `"127.0.0.1.evil.com"` or `"fcebook.com"` cannot pass the
  // startsWith-style range checks below.
  const lower = ip.toLowerCase();
  if (isIP(lower) === 0) return false;
  // Strip the IPv4-mapped IPv6 prefix so the IPv4 ranges below match.
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  // Loopback (127.0.0.0/8, ::1)
  if (lower === "::1") return true;
  if (v4.startsWith("127.")) return true;
  // Link-local: IPv4 169.254/16, IPv6 fe80::/10 (high two bits of the
  // second nibble are `10` → fe80:, fe90:, fea0:, feb0:).
  if (v4.startsWith("169.254.")) return true;
  if (
    lower.startsWith("fe80:") ||
    lower.startsWith("fe90:") ||
    lower.startsWith("fea0:") ||
    lower.startsWith("feb0:")
  ) {
    return true;
  }
  // RFC-1918
  if (v4.startsWith("10.")) return true;
  if (v4.startsWith("192.168.")) return true;
  // 172.16.0.0 – 172.31.255.255. Match the leading octet exactly with
  // `\d+\.` so `"172.16abc..."` doesn't sneak past.
  const v172 = /^172\.(\d{1,3})\./.exec(v4);
  if (v172) {
    const second = parseInt(v172[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 unique-local: fc00::/7. Require a `:` so this only fires on
  // IPv6 literals — guards against an unexpected `directIp` source one
  // day handing us a hostname starting with `fc`/`fd`.
  if ((lower.startsWith("fc") || lower.startsWith("fd")) && lower.includes(":")) return true;
  return false;
}

/**
 * Extract the real client IP from a Socket.IO socket, honoring the same
 * `trust proxy` set used by Express (loopback + link-local + RFC-1918 /
 * unique-local). When the direct peer is a trusted proxy hop we read the
 * leftmost entry of `X-Forwarded-For`; otherwise we treat the direct
 * address as authoritative.
 *
 * NOTE: assumes a single trusted proxy (Caddy → docker-bridge → container).
 * If a CDN like Cloudflare is added in front, switch to rightmost-trusted-proxy
 * logic and tighten the trusted set.
 */
export function getClientIp(socket: Socket): string {
  const directIp = socket.handshake.address || "unknown";
  if (directIp !== "unknown" && isTrustedProxySource(directIp)) {
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const firstIp = forwarded.split(",")[0]?.trim();
      if (firstIp) return firstIp;
    }
  }
  return directIp;
}

export interface SocketPlayerMeta {
  playerId: string;
  roomCode: string;
  playerToken: string;
  userId?: string;
}

// Map socket.id -> { playerId, roomCode, playerToken }
const socketMeta = new Map<string, SocketPlayerMeta>();

// Map playerId -> socket.id (for targeted messaging)
const playerSockets = new Map<string, string>();

// Per-socket event rate limiter
const socketEventCounters = new Map<string, { count: number; resetTime: number }>();

// Per-IP room creation rate limiter (max 5 rooms per minute)
const createRoomLimiter = new Map<string, { count: number; resetTime: number }>();

// Per-socket last activity timestamp (for TTL eviction)
const socketLastActivity = new Map<string, number>();

// Per-room-code join attempt limiter (prevents password brute force)
const roomJoinLimiter = new Map<string, { count: number; resetTime: number }>();

// Pending disconnect timers, keyed by playerId. When a socket drops, we
// schedule the `ROOM_PLAYER_LEFT` broadcast + DB update on a short timer
// instead of running them immediately. If the player reconnects inside
// the grace window, the timer is cancelled and the rest of the room
// never sees a leave.
const pendingDisconnectTimers = new Map<string, NodeJS.Timeout>();

// Active grace-period duration. Overridable in tests so existing
// integration tests that rely on near-instant leave broadcasts don't
// wait 15 s per case. Defaults to `MP_DISCONNECT_GRACE_MS`.
let activeDisconnectGraceMs: number | null = null;

export function getSocketMeta(socketId: string): SocketPlayerMeta | undefined {
  return socketMeta.get(socketId);
}

export function setSocketMeta(socketId: string, meta: SocketPlayerMeta): void {
  socketMeta.set(socketId, meta);
}

export function deleteSocketMeta(socketId: string): void {
  socketMeta.delete(socketId);
  socketLastActivity.delete(socketId);
}

export function getPlayerSocketId(playerId: string): string | undefined {
  return playerSockets.get(playerId);
}

export function setPlayerSocket(playerId: string, socketId: string): void {
  playerSockets.set(playerId, socketId);
}

export function deletePlayerSocket(playerId: string): void {
  playerSockets.delete(playerId);
}

/**
 * Return the set of player IDs that currently have a live socket mapping.
 * Used by cleanup to detect ghost players still marked connected in the DB.
 */
export function getLivePlayerIds(): Set<string> {
  return new Set(playerSockets.keys());
}

export function deleteSocketEventCounter(socketId: string): void {
  socketEventCounters.delete(socketId);
}

export function checkSocketRateLimit(socketId: string, maxPerSecond: number = config.socketMaxEventsPerSecond): boolean {
  const now = Date.now();
  let entry = socketEventCounters.get(socketId);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 1000 };
    socketEventCounters.set(socketId, entry);
  }
  entry.count++;
  return entry.count <= maxPerSecond;
}

export function checkCreateRoomLimit(ip: string): boolean {
  const now = Date.now();
  let entry = createRoomLimiter.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 60_000 };
    createRoomLimiter.set(ip, entry);
  }
  entry.count++;
  return entry.count <= config.roomCreateLimitPerMinute;
}

/**
 * Record activity for a socket, used for TTL-based eviction of stale entries.
 *
 * @param socketId - The socket ID to touch.
 */
export function touchSocketActivity(socketId: string): void {
  socketLastActivity.set(socketId, Date.now());
}

/**
 * Check whether a room code has exceeded its join attempt rate limit.
 * Prevents brute-force guessing of room passwords.
 *
 * @param roomCode - The room code being joined.
 * @param maxPerMinute - Maximum allowed join attempts per minute (default 5).
 * @returns true if within limit, false if exceeded.
 */
export function checkRoomJoinLimit(roomCode: string, maxPerMinute: number = config.roomJoinLimitPerMinute): boolean {
  const now = Date.now();
  let entry = roomJoinLimiter.get(roomCode);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 60_000 };
    roomJoinLimiter.set(roomCode, entry);
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}

/**
 * Schedule a deferred disconnect action for a player, overwriting any
 * previously-scheduled timer for the same playerId. If `delayMs` is
 * not provided (or the grace period has been overridden for tests),
 * the runtime-effective value is used.
 *
 * @param playerId - The player whose disconnect is being deferred.
 * @param fn - The callback to run when the grace window elapses.
 * @param delayMs - Optional override. Falls back to the runtime grace
 *                  period (settable via `setDisconnectGraceMs`).
 */
export function schedulePendingDisconnect(
  playerId: string,
  fn: () => void,
  delayMs?: number
): void {
  const existing = pendingDisconnectTimers.get(playerId);
  if (existing) clearTimeout(existing);
  const effective = delayMs ?? activeDisconnectGraceMs;
  if (effective == null) {
    throw new Error("schedulePendingDisconnect: no delay and no grace default set");
  }
  const timer = setTimeout(() => {
    pendingDisconnectTimers.delete(playerId);
    fn();
  }, effective);
  pendingDisconnectTimers.set(playerId, timer);
}

/**
 * Override the grace period used by `schedulePendingDisconnect` when
 * no explicit delay is passed. Intended for integration tests that
 * want a near-instant leave broadcast.
 *
 * @param ms - New grace period, or `null` to restore the default.
 */
export function setDisconnectGraceMs(ms: number | null): void {
  activeDisconnectGraceMs = ms;
}

/** Current effective grace period, for introspection in tests. */
export function getDisconnectGraceMs(): number | null {
  return activeDisconnectGraceMs;
}

/**
 * Cancel any pending deferred disconnect for a player. Called when the
 * player reconnects within the grace window so the `ROOM_PLAYER_LEFT`
 * broadcast never fires.
 *
 * @param playerId - The player whose pending disconnect should be cleared.
 * @returns true if a timer was cancelled, false if no timer was pending.
 */
export function cancelPendingDisconnect(playerId: string): boolean {
  const timer = pendingDisconnectTimers.get(playerId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingDisconnectTimers.delete(playerId);
  return true;
}

/**
 * Whether a pending deferred disconnect is scheduled for this player.
 * Used by tests and introspection.
 */
export function hasPendingDisconnect(playerId: string): boolean {
  return pendingDisconnectTimers.has(playerId);
}

/**
 * Cancel every pending deferred-disconnect timer. Intended for graceful
 * shutdown paths (e.g. test teardown) where the DB is about to be
 * closed: letting the timers fire afterwards would try to
 * `db.prepare(...)` on a closed connection and throw an uncaught
 * `TypeError`, polluting test runs and masking real failures.
 *
 * @returns Number of timers cleared.
 */
export function cancelAllPendingDisconnects(): number {
  const count = pendingDisconnectTimers.size;
  for (const timer of pendingDisconnectTimers.values()) clearTimeout(timer);
  pendingDisconnectTimers.clear();
  return count;
}

/**
 * Reset all in-memory state. Used by integration tests only.
 *
 * @throws Error if called in a production environment.
 */
export function resetAllSocketState(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("resetAllSocketState() must not be called in production");
  }
  socketMeta.clear();
  playerSockets.clear();
  socketEventCounters.clear();
  createRoomLimiter.clear();
  socketLastActivity.clear();
  roomJoinLimiter.clear();
  for (const timer of pendingDisconnectTimers.values()) clearTimeout(timer);
  pendingDisconnectTimers.clear();
}

// Periodic cleanup of stale rate limiter entries and inactive sockets
const SOCKET_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of socketEventCounters) {
    if (now > entry.resetTime + 5000) socketEventCounters.delete(key);
  }
  for (const [key, entry] of createRoomLimiter) {
    if (now > entry.resetTime + 5000) createRoomLimiter.delete(key);
  }
  for (const [key, entry] of roomJoinLimiter) {
    if (now > entry.resetTime + 5000) roomJoinLimiter.delete(key);
  }

  // Evict socket state for connections with no activity in 30 minutes
  for (const [socketId, lastActive] of socketLastActivity) {
    if (now - lastActive > SOCKET_TTL_MS) {
      const meta = socketMeta.get(socketId);
      if (meta) {
        playerSockets.delete(meta.playerId);
      }
      socketMeta.delete(socketId);
      socketEventCounters.delete(socketId);
      socketLastActivity.delete(socketId);
    }
  }
}, 30_000).unref();
