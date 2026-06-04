/**
 * Subscribe to the admin analytics Socket.IO namespace and expose the
 * latest `live-pulse` payload as React state.
 *
 * One socket per admin tab: the hook opens the connection on mount and
 * closes it on unmount. The socket lives on `/admin-analytics` and the
 * namespace authenticates via the admin session cookie that the browser
 * sends automatically with `withCredentials: true`.
 *
 * Connection failures (e.g. the admin's session expired) surface as
 * `error: string`; the Overview component shows a muted fallback rather
 * than a blocking error because the rest of the dashboard works fine
 * without realtime.
 */

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface LivePulse {
  ts: number;
  liveVisitors: number;
  recentEvents: Array<{ name: string; count: number }>;
  sessionsStartedLastMinute: number;
}

interface UseLivePulse {
  pulse: LivePulse | null;
  error: string | null;
  connected: boolean;
}

/**
 * Hook that connects to /admin-analytics and yields the freshest pulse.
 *
 * @returns `{ pulse, error, connected }`. pulse is null until first
 *   payload arrives; error is a human string when the socket refuses
 *   to connect.
 */
export function useLivePulse(): UseLivePulse {
  const [pulse, setPulse] = useState<LivePulse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Use same-origin so cookies + the existing CSP apply. The `path`
    // default matches the server's default ('/socket.io').
    const socket: Socket = io("/admin-analytics", {
      withCredentials: true,
      transports: ["websocket", "polling"],
      reconnectionAttempts: 3,
    });

    socket.on("connect", () => {
      if (cancelled) return;
      setConnected(true);
      setError(null);
    });
    socket.on("disconnect", () => {
      if (cancelled) return;
      setConnected(false);
    });
    socket.on("connect_error", (err: Error) => {
      if (cancelled) return;
      setError(err.message || "connection failed");
      setConnected(false);
    });
    socket.on("live-pulse", (payload: LivePulse) => {
      if (cancelled) return;
      setPulse(payload);
    });

    return () => {
      cancelled = true;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  return { pulse, error, connected };
}
