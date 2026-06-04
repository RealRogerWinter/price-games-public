/**
 * useStreamerStatsRelay — bridges the server's `streamer:stats`
 * Socket.IO event into the broadcast overlay bus.
 *
 * Background: the bot's `publishStats` originally only used a
 * same-window `window.postMessage` into the overlay bus. That works
 * inside the bot's own Chromium tab, but any other `?broadcast=1`
 * viewer (operator preview, co-streamer overlay, the bot pointed at
 * a different host than the page is rendered on) saw zeros forever
 * because postMessage is local to a single window. The bot now also
 * POSTs to `/api/streamer/stats`; the server fans out via Socket.IO.
 *
 * This hook:
 *   1. Hydrates from `/api/streamer/stats` on mount so a freshly
 *      loaded page sees the latest payload immediately instead of
 *      waiting for the next round to land.
 *   2. Subscribes to the `streamer:stats` socket event and forwards
 *      every payload into the existing overlay bus by dispatching a
 *      `stats.update` envelope. The overlay bus reducer treats it
 *      identically to a postMessage — the overlay panels don't need
 *      to know which transport delivered the payload.
 *
 * Mount the hook from `BroadcastShell` (the single component that
 * lives for the duration of broadcast mode). It's a no-op when
 * `?broadcast=1` is off.
 */

import { useEffect } from "react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { connectSocket } from "../api/socket";
import { dispatchOverlayEvent } from "./state/overlayBus";

interface StreamerStatsPayload {
  wins: number;
  losses: number;
  streak: number;
  mood?: string;
  winRate?: number;
}

function isStatsPayload(v: unknown): v is StreamerStatsPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.wins === "number"
    && typeof o.losses === "number"
    && typeof o.streak === "number"
  );
}

/**
 * Wire the broadcast page to the server's streamer-stats relay.
 *
 * @param enabled Pass `false` to keep the hook a no-op when not in
 *                broadcast mode. The hook is cheap when enabled but
 *                the socket connect adds a websocket handshake to
 *                pages that don't otherwise need one.
 */
export function useStreamerStatsRelay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    // Attach the socket FIRST, then kick off the GET hydrate. If a
    // socket event arrives mid-fetch, the flag below tells the GET
    // resolver to drop its (older) cached payload — otherwise a
    // freshly-published stat could be silently overwritten by the
    // server's pre-publish snapshot when the GET response lands.
    let socketDeliveredFirst = false;

    const socket = connectSocket();
    function onStats(payload: unknown): void {
      if (!isStatsPayload(payload)) return;
      socketDeliveredFirst = true;
      dispatchOverlayEvent("stats.update", payload);
    }
    socket.on(SOCKET_EVENTS.STREAMER_BOT_STATS, onStats);

    // Best-effort hydrate. Aborted if the hook unmounts mid-flight.
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/streamer/stats", {
          credentials: "same-origin",
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { stats?: unknown };
        if (cancelled || socketDeliveredFirst) return;
        if (isStatsPayload(data.stats)) {
          dispatchOverlayEvent("stats.update", data.stats);
        }
      } catch {
        // Network error, abort, or 404 on a server without the route
        // yet — ignore. The socket path will eventually deliver.
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      socket.off(SOCKET_EVENTS.STREAMER_BOT_STATS, onStats);
    };
  }, [enabled]);
}
