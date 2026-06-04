/**
 * Socket.IO namespace for admin realtime analytics.
 *
 * Mounts at `/admin-analytics`. Only authenticated admins with a valid
 * `admin_session` cookie + completed 2FA enrollment may connect. The
 * namespace broadcasts a lightweight `live-pulse` event every 10 seconds
 * containing the current count of "live" visitors (sessions active in
 * the last 5 minutes) plus a tiny burst of recently-observed event names
 * so the Overview tab can animate a heartbeat without the client having
 * to poll a REST endpoint every few seconds.
 *
 * Scope choices:
 *  - We intentionally DO NOT stream raw events. The admin tab only needs
 *    a count + a rolling recent-names list; leaking raw event payloads
 *    over a socket would widen the PII blast radius for no product gain.
 *  - Emission runs on a single interval per namespace instance (not per
 *    client), and only while at least one admin is connected, to avoid
 *    a pointless query loop on an empty server.
 */

import type { Server as IOServer, Namespace, Socket } from "socket.io";
import type { Database as DatabaseType } from "better-sqlite3";
import { config } from "../config";
import { validateAdminSession } from "../services/adminAuth";
import { isTotpEnabled } from "../services/adminTotp";

/**
 * Minimal Cookie: header parser. Avoids a runtime dependency on the
 * `cookie` npm package for the one place this namespace needs it.
 *
 * @param header - Raw Cookie header value (possibly empty).
 * @returns Map of cookie name → value (first occurrence wins).
 */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

/** Shape of the pulse payload emitted on an interval. */
export interface LivePulsePayload {
  ts: number;
  /** Distinct visitor_ids active in the last 5 min. */
  liveVisitors: number;
  /** Events that arrived in the last 10s, bucketed by name. */
  recentEvents: Array<{ name: string; count: number }>;
  /** Sessions opened in the last 60s. */
  sessionsStartedLastMinute: number;
}

/** Socket.IO event names this namespace emits to connected admins. */
export const ADMIN_REALTIME_EVENTS = {
  LIVE_PULSE: "live-pulse",
} as const;

const PULSE_WINDOW_MS = 10 * 1000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const SESSIONS_WINDOW_MS = 60 * 1000;

let pulseInterval: NodeJS.Timeout | null = null;

/**
 * Mount the `/admin-analytics` namespace on the existing Socket.IO server
 * and wire up the periodic pulse broadcaster.
 *
 * @param io - Existing Socket.IO server instance.
 * @param db - Database instance used to query live counts.
 * @returns The namespace handle (for tests / teardown).
 */
export function setupAdminAnalyticsNamespace(
  io: IOServer,
  db: DatabaseType,
): Namespace {
  // Re-init guard. Without this, calling setup twice (e.g. hot-reload
  // or an integration test that re-bootstraps) would leave the prior
  // interval running and leak memory.
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
  }

  const ns = io.of("/admin-analytics");

  ns.use((socket: Socket, next: (err?: Error) => void) => {
    try {
      const raw = socket.handshake.headers.cookie ?? "";
      const cookies = parseCookieHeader(String(raw));
      const token = cookies[config.adminCookieName];
      if (!token || typeof token !== "string") {
        return next(new Error("unauthorized"));
      }
      const admin = validateAdminSession(db, token);
      if (!admin) return next(new Error("unauthorized"));
      // Enforce 2FA enrollment. Matches the HTTP admin guard including
      // the sandbox-only SKIP_ADMIN_2FA bypass so dev flows stay
      // consistent between REST and socket auth.
      const skip2fa = process.env.SKIP_ADMIN_2FA === "1";
      if (!skip2fa && !isTotpEnabled(db, admin.id)) {
        return next(new Error("2fa-required"));
      }
      (socket.data as { adminId: string }).adminId = admin.id;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  ns.on("connection", (socket: Socket) => {
    // Fire an immediate pulse so the newly-connected admin's UI doesn't
    // wait up to PULSE_WINDOW_MS for its first data.
    try {
      socket.emit(ADMIN_REALTIME_EVENTS.LIVE_PULSE, computePulse(db));
    } catch (err) {
      console.error("[admin-realtime] initial pulse failed:", err);
    }
  });

  // Single interval per namespace. Gate on connected-client count to
  // avoid pointless DB work when no admin is watching.
  pulseInterval = setInterval(() => {
    try {
      if (ns.sockets.size === 0) return;
      ns.emit(ADMIN_REALTIME_EVENTS.LIVE_PULSE, computePulse(db));
    } catch (err) {
      console.error("[admin-realtime] pulse broadcast failed:", err);
    }
  }, PULSE_WINDOW_MS);
  pulseInterval.unref?.();

  return ns;
}

/**
 * Test + teardown helper: clear the pulse interval so a test run doesn't
 * leak a timer and Vitest doesn't hang on watchers.
 *
 * @internal
 */
export function __stopAdminAnalyticsPulse(): void {
  if (pulseInterval) clearInterval(pulseInterval);
  pulseInterval = null;
}

/**
 * Compute a single pulse payload. Exported so tests and the initial
 * per-connection emit can share the implementation.
 *
 * @param db - Database instance.
 * @param now - Epoch ms (exposed for tests).
 * @returns Pulse payload.
 */
export function computePulse(
  db: DatabaseType,
  now: number = Date.now(),
): LivePulsePayload {
  const live = db
    .prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS n
         FROM analytics_sessions
        WHERE last_event_at >= ? AND is_bot = 0`,
    )
    .get(now - LIVE_WINDOW_MS) as { n: number };

  const recent = db
    .prepare(
      `SELECT event_name AS name, COUNT(*) AS n
         FROM events
        WHERE ts_server >= ? AND is_bot = 0 AND is_synthetic = 0
        GROUP BY event_name
        ORDER BY n DESC
        LIMIT 10`,
    )
    .all(now - PULSE_WINDOW_MS) as { name: string; n: number }[];

  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM analytics_sessions
        WHERE started_at >= ? AND is_bot = 0`,
    )
    .get(now - SESSIONS_WINDOW_MS) as { n: number };

  return {
    ts: now,
    liveVisitors: live.n,
    recentEvents: recent.map((r) => ({ name: r.name, count: r.n })),
    sessionsStartedLastMinute: sessions.n,
  };
}
