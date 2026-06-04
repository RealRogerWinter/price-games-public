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
 * The flag is derived from the URL alone — no env vars, auth, or storage.
 * Network-layer access is gated by Caddy + the Express
 * `denyPublicBroadcast` middleware: `?broadcast=1` only resolves over
 * the tailnet, not on the public price.games domain.
 *
 * This hook is intentionally a pure read with no side effects. The
 * `body.broadcast` class is owned by `BroadcastShell` (the stage owner)
 * because if every consumer toggled the class, an `AuthModal` unmounting
 * mid-session would strip the class while the shell still wanted it.
 *
 * @returns true when the URL has `?broadcast=1`, false otherwise.
 */
import { useState } from "react";

function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("broadcast") === "1";
  } catch {
    return false;
  }
}

export function useBroadcastMode(): boolean {
  // Read the flag once on first render. The URL is not expected to change
  // between mount and unmount within the bot's session, and re-reading on
  // every render would invite churn from unrelated history.replaceState
  // calls scattered through App.tsx.
  const [enabled] = useState<boolean>(readFlag);
  return enabled;
}
