import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useBroadcastMode } from "./useBroadcastMode";

/**
 * Window-global identifier under which the broadcast navigation helper
 * is registered. Exported so the streamer-bot driver and tests can
 * reference it via a single source of truth.
 */
export const BROADCAST_NAV_GLOBAL = "__pgBroadcastNav" as const;

declare global {
  interface Window {
    [BROADCAST_NAV_GLOBAL]?: (url: string) => void;
  }
}

/**
 * Registers `window.__pgBroadcastNav(url)` while the app is in broadcast
 * mode. The helper performs a same-tab React Router navigation
 * (pushState + Routes re-render) instead of a full document load. The
 * streamer-bot driver calls this helper between plan boundaries so the
 * `BroadcastShell` overlay (Avatar lipsync engine, NN canvases, audio
 * context, chat scroll, persisted stats) stays mounted across games.
 *
 * Mounted as a sibling of `<Routes>` inside `<BrowserRouter>` so it has
 * access to React Router's `useNavigate`. Renders nothing.
 *
 * Outside broadcast mode (`?broadcast=1` not set) the helper is NOT
 * exposed — non-bot viewers get no global side-effect.
 *
 * Security note: `?broadcast=1` is open to any visitor, so any
 * broadcast-mode page (not just the bot's Chromium) exposes this
 * global. A viewer poking it from devtools could trigger a route
 * change and, via App.tsx's URL-reactive deep-link effect, start a
 * fresh game in their own tab. Impact is bounded: the URL is
 * same-origin only (helper rejects others), `doStartGame` validates
 * the mode against `VALID_GAME_MODES`, and the server enforces the
 * usual rate limits — viewers can already click any mode tile to
 * start a game. The helper does not give them anything new beyond
 * skipping a click.
 */
export default function BroadcastNavHandle(): null {
  const broadcast = useBroadcastMode();
  const navigate = useNavigate();
  useEffect(() => {
    if (!broadcast) return;
    if (typeof window === "undefined") return;
    window[BROADCAST_NAV_GLOBAL] = (url: string): void => {
      try {
        const u = new URL(url, window.location.origin);
        // Only allow same-origin navigation. A bot driver passing a
        // cross-origin URL is almost certainly a bug; falling through
        // to a no-op surfaces it loudly (the driver's page-state probe
        // will diverge on the missing URL change).
        if (u.origin !== window.location.origin) return;
        navigate(`${u.pathname}${u.search}${u.hash}`);
      } catch {
        // Malformed URL — drop silently; the driver will fall back to
        // its full-reload recovery path on the next round if the SPA
        // nav was needed.
      }
    };
    return () => {
      if (window[BROADCAST_NAV_GLOBAL]) {
        delete window[BROADCAST_NAV_GLOBAL];
      }
    };
  }, [broadcast, navigate]);
  return null;
}
