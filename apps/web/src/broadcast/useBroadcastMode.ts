/**
 * useBroadcastMode — returns true when the page is loaded in "broadcast
 * mode", i.e. the URL contains `?broadcast=1`. Broadcast mode is the
 * render path used by the 24/7 livestream bot's Chromium instance:
 *
 * - The `BroadcastShell` wrapper composes a 1920×1080 stage with branded
 *   side panels around the game.
 * - Site chrome (cookie banner, notification prompts, install prompts,
 *   auth modals, promo banners) is suppressed so the stream stays clean.
 *
 * Architecture: the flag is read from the URL exactly ONCE per session,
 * by `BroadcastShell` alone (the one component that is mounted once,
 * above `<BrowserRouter>`, and never remounted for the life of the
 * session). BroadcastShell seeds a `BroadcastModeContext.Provider` with
 * that value; every other consumer reads the flag via `useContext`
 * through this hook instead of re-deriving it from `window.location`
 * itself.
 *
 * This used to be a per-hook `useState(readFlag)` lazy initializer
 * called independently by every consumer. That was safe for components
 * that mount early (alongside BroadcastShell, while the URL still has
 * `?broadcast=1`), but leaked for anything that first mounts LATER —
 * e.g. after the streamer-bot driver soft-navigates the SPA via
 * `window.__pgBroadcastNav(url)` (see `BroadcastNavHandle`) to a target
 * URL that doesn't happen to carry `broadcast=1`. A component mounting
 * for the first time on that later route would independently read the
 * CURRENT (now-different) URL and could disagree with the still-active
 * BroadcastShell stage about whether broadcast mode is on. Centralizing
 * the read in one Provider, seeded once, removes that class of bug: all
 * consumers — no matter when they first mount — see the exact same
 * stable value BroadcastShell captured at startup.
 *
 * Network-layer access is gated by Caddy + the Express
 * `denyPublicBroadcast` middleware: `?broadcast=1` only resolves over
 * the tailnet, not on the public price.games domain.
 *
 * The `body.broadcast` class is owned by `BroadcastShell` (the stage
 * owner) because if every consumer toggled the class, an `AuthModal`
 * unmounting mid-session would strip the class while the shell still
 * wanted it.
 */
import { createContext, useContext } from "react";

/**
 * Context carrying the broadcast-mode flag, seeded exactly once by
 * `BroadcastShell`. Defaults to `false` so any consumer that somehow
 * renders outside the `BroadcastShell` subtree (e.g. an isolated unit
 * test) safely falls back to "not broadcasting" rather than throwing.
 */
export const BroadcastModeContext = createContext<boolean>(false);

/**
 * One-time reader of the `?broadcast=1` URL flag. Exported so
 * `BroadcastShell` — the sole owner of the initial read — can seed its
 * `useState` initializer with it. Nothing else should call this
 * directly; every other consumer should go through `useBroadcastMode()`
 * so it observes BroadcastShell's stable, context-provided value
 * instead of re-reading a URL that may have since changed underneath
 * it.
 */
export function readBroadcastFlagOnce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("broadcast") === "1";
  } catch {
    return false;
  }
}

/**
 * @returns the broadcast-mode flag seeded once by `BroadcastShell` at
 * the start of the session, via `BroadcastModeContext`. Every consumer
 * throughout the app — no matter when it first mounts — reads this same
 * stable value rather than performing its own URL read.
 */
export function useBroadcastMode(): boolean {
  return useContext(BroadcastModeContext);
}
