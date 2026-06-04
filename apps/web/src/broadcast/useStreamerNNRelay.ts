/**
 * useStreamerNNRelay — bridges the server's `streamer:nn-tick`
 * Socket.IO event into the broadcast overlay bus.
 *
 * Mirrors {@link useStreamerStatsRelay} for the NN visualisation slot.
 * The bot POSTs a fresh VisualTick each round via
 * `POST /api/streamer/nn-tick`; the server fans it out via Socket.IO
 * and persists the latest payload for first-mount hydration.
 *
 * This hook:
 *   1. Hydrates from `GET /api/streamer/nn-tick` on mount so a freshly
 *      loaded broadcast page sees the latest tick immediately instead
 *      of waiting for the next round to fire.
 *   2. Subscribes to the `streamer:nn-tick` socket event and forwards
 *      every payload into the overlay bus by dispatching an
 *      `nn.tick` envelope. The reducer treats it identically to a
 *      same-window postMessage path (which the bot still uses for
 *      its own Chromium tab).
 *
 * Mount once from BroadcastShell. No-op when `?broadcast=1` is off.
 */

import { useEffect } from "react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { connectSocket } from "../api/socket";
import { dispatchOverlayEvent, sanitizeNnTick } from "./state/overlayBus";

/**
 * Wire the broadcast page to the server's NN-tick relay.
 *
 * @param enabled Pass `false` to keep the hook a no-op when not in
 *                broadcast mode. The hook is cheap when enabled, but
 *                a socket connect adds a websocket handshake to pages
 *                that don't otherwise need one.
 */
export function useStreamerNNRelay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    let socketDeliveredFirst = false;

    const socket = connectSocket();
    function onTick(payload: unknown): void {
      if (!sanitizeNnTick(payload)) return;
      socketDeliveredFirst = true;
      dispatchOverlayEvent("nn.tick", payload);
    }
    socket.on(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, onTick);

    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/streamer/nn-tick", {
          credentials: "same-origin",
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { tick?: unknown };
        if (cancelled || socketDeliveredFirst) return;
        if (sanitizeNnTick(data.tick)) {
          dispatchOverlayEvent("nn.tick", data.tick);
        }
      } catch {
        // Network error / abort / 404 on a server without the route —
        // ignore. The socket path will deliver eventually.
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      socket.off(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, onTick);
    };
  }, [enabled]);
}
