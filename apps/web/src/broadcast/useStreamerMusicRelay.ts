/**
 * useStreamerMusicRelay — same shape as useStreamerStatsRelay, but
 * for the bot's "now playing" track. Bridges the server's
 * `streamer:music` Socket.IO event into the broadcast overlay bus
 * by dispatching a `music.now` envelope, so the MusicTicker panel
 * doesn't need to know which transport delivered the track.
 *
 * Background: the bot's `musicSource.ts` originally only published
 * via `overlay.send("music.now", ...)` → `window.postMessage` into
 * the bot's own Chromium tab. Any other `?broadcast=1` viewer saw
 * the idle placeholder forever, same root cause as the W/L/streak
 * relay. The bot now also POSTs `/api/streamer/music`; the server
 * fans out via Socket.IO.
 *
 * On mount the hook also fetches `/api/streamer/music` so a freshly-
 * loaded page sees the current track immediately instead of waiting
 * for the next mpd track-change.
 */

import { useEffect } from "react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { connectSocket } from "../api/socket";
import { dispatchOverlayEvent } from "./state/overlayBus";

interface MusicPayload {
  title: string;
  artist?: string;
  album?: string;
}

function isMusicPayload(v: unknown): v is MusicPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === "string" && o.title.length > 0;
}

/**
 * Wire the broadcast page to the server's streamer-music relay.
 *
 * @param enabled No-op when false (broadcast mode off). Same gating
 *                as the stats relay so a non-broadcast page never
 *                opens a Socket.IO connection just for the relay.
 */
export function useStreamerMusicRelay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;
    // Attach the socket BEFORE issuing the GET so a track-change
    // emitted mid-fetch isn't overwritten by the older cached value
    // when the GET resolves. See `useStreamerStatsRelay` for the
    // same pattern; both relays carry the same race shape.
    let socketDeliveredFirst = false;

    const socket = connectSocket();
    function onMusic(payload: unknown): void {
      // Server emits `null` for queue-stop; the overlay bus accepts
      // that explicitly and clears the track display.
      if (payload === null) {
        socketDeliveredFirst = true;
        dispatchOverlayEvent("music.now", null);
        return;
      }
      if (!isMusicPayload(payload)) return;
      socketDeliveredFirst = true;
      dispatchOverlayEvent("music.now", payload);
    }
    socket.on(SOCKET_EVENTS.STREAMER_BOT_MUSIC, onMusic);

    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/streamer/music", {
          credentials: "same-origin",
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { music?: unknown };
        if (cancelled || socketDeliveredFirst) return;
        if (data.music === null) {
          dispatchOverlayEvent("music.now", null);
        } else if (isMusicPayload(data.music)) {
          dispatchOverlayEvent("music.now", data.music);
        }
      } catch {
        /* Network error / abort — let the socket path catch up. */
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      socket.off(SOCKET_EVENTS.STREAMER_BOT_MUSIC, onMusic);
    };
  }, [enabled]);
}
