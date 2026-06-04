/**
 * useStreamerMoodRelay — bridges the server's `streamer:mood`
 * Socket.IO event into the broadcast overlay bus.
 *
 * Companion to `useStreamerStatsRelay`: the bot's `publishStats`
 * already carries the resolved mood label on the legacy stats event
 * (back-compat), but PR 7 introduces a richer per-snapshot channel
 * that includes the hidden vibe + morale axes the engine tracks.
 * The overlay's MoodWheel (and the operator-facing MoodDebugHud)
 * use those hidden axes for trend caret + sector highlighting.
 *
 * This hook:
 *   1. Hydrates from `/api/streamer/mood` on mount so a freshly
 *      loaded page sees the latest snapshot immediately instead of
 *      waiting for the next mood transition to land over the socket.
 *   2. Subscribes to the `streamer:mood` socket event and forwards
 *      every payload into the overlay bus by dispatching a
 *      `mood.snapshot` envelope. The overlay reducer treats it
 *      identically to a postMessage — the panels don't care which
 *      transport delivered the snapshot.
 *
 * Mount the hook from `BroadcastShell` (the single component that
 * lives for the duration of broadcast mode). It's a no-op when
 * `?broadcast=1` is off.
 */

import { useEffect } from "react";
import { SOCKET_EVENTS, isMood } from "@price-game/shared";
import { connectSocket } from "../api/socket";
import { dispatchOverlayEvent } from "./state/overlayBus";

interface StreamerMoodPayload {
  mood: string;
  vibe: number;
  morale: number;
  streak: number;
  updatedAt?: number;
}

function isMoodPayload(v: unknown): v is StreamerMoodPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isMood(o.mood)
    && typeof o.vibe === "number" && Number.isFinite(o.vibe)
    && typeof o.morale === "number" && Number.isFinite(o.morale)
    && typeof o.streak === "number" && Number.isFinite(o.streak)
  );
}

/**
 * Wire the broadcast page to the server's streamer-mood relay.
 *
 * @param enabled Pass `false` to keep the hook a no-op when not in
 *                broadcast mode. The hook is cheap when enabled but
 *                the socket connect adds a websocket handshake to
 *                pages that don't otherwise need one.
 */
export function useStreamerMoodRelay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    // Same race-handling shape as useStreamerStatsRelay: attach the
    // socket FIRST, then kick off the GET hydrate. If a socket event
    // arrives mid-fetch, the flag below tells the GET resolver to
    // drop its (older) cached payload — otherwise a freshly-published
    // snapshot could be silently overwritten by the server's
    // pre-publish snapshot when the GET response lands.
    let socketDeliveredFirst = false;

    const socket = connectSocket();
    function onMood(payload: unknown): void {
      if (!isMoodPayload(payload)) return;
      socketDeliveredFirst = true;
      dispatchOverlayEvent("mood.snapshot", payload);
    }
    socket.on(SOCKET_EVENTS.STREAMER_BOT_MOOD, onMood);

    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/streamer/mood", {
          credentials: "same-origin",
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { mood?: unknown };
        if (cancelled || socketDeliveredFirst) return;
        if (isMoodPayload(data.mood)) {
          dispatchOverlayEvent("mood.snapshot", data.mood);
        }
      } catch {
        // Network error, abort, or 404 on a server without the route
        // yet — ignore. The socket path will eventually deliver.
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      socket.off(SOCKET_EVENTS.STREAMER_BOT_MOOD, onMood);
    };
  }, [enabled]);
}
