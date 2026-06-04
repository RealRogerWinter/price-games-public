/**
 * Target-URL resolution for the streamer-bot's Chromium.
 *
 * The bot drives a real Chromium browser to a deployed instance of the
 * Price Games web app and operates the broadcast overlay
 * (`?broadcast=1`). That overlay is intentionally NOT exposed on the
 * public price.games domain — Caddy 404s `?broadcast=1` requests on
 * the public vhost, and the Express server enforces the same block in
 * `apps/server/src/middleware/broadcastAccess.ts`. Operators must
 * point the bot at the Tailscale hostname for the host machine, e.g.
 * `https://onestreamer.tail-abcd.ts.net`, which reaches the same
 * Express backend through `tailscale serve`.
 *
 * This module's job is to validate `STREAMER_TARGET_URL` at boot and
 * fail fast with a clear message if it is unset or points at one of
 * the known public hostnames — otherwise the bot would silently 404
 * its way through every navigation attempt.
 */

/**
 * Hostnames the bot must NOT navigate to. Kept in sync with the
 * default block list in
 * `apps/server/src/middleware/broadcastAccess.ts` so the two layers
 * agree on what "public" means.
 */
export const PUBLIC_BROADCAST_HOSTS: ReadonlySet<string> = new Set([
  "price.games",
  "www.price.games",
  "sandbox.price.games",
]);

/**
 * Resolve and validate `STREAMER_TARGET_URL`.
 *
 * @param raw - The raw env value (or undefined).
 * @returns The validated URL string with any trailing slash stripped.
 * @throws If the env is unset, malformed, or points at a known public
 *   host where the broadcast overlay is blocked.
 */
export function resolveTargetUrl(raw: string | undefined): string {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "STREAMER_TARGET_URL is required. Set it to your tailnet hostname, e.g. " +
        "STREAMER_TARGET_URL=https://onestreamer.tail-abcd.ts.net — the broadcast " +
        "overlay is not exposed on the public price.games domain.",
    );
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  let host: string;
  try {
    // Strip the trailing dot from the FQDN form — `https://price.games./`
    // parses to hostname `"price.games."`, which would slip past the
    // exact-match `Set.has()` and let an operator silently point the
    // bot at the public site. DNS resolves both forms identically.
    host = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    throw new Error(`STREAMER_TARGET_URL is not a valid URL: "${raw}"`);
  }
  if (PUBLIC_BROADCAST_HOSTS.has(host)) {
    throw new Error(
      `STREAMER_TARGET_URL points at "${host}", but the broadcast overlay is ` +
        "blocked on public hostnames. Use the tailnet hostname instead " +
        "(e.g. https://onestreamer.tail-abcd.ts.net).",
    );
  }
  return trimmed;
}
