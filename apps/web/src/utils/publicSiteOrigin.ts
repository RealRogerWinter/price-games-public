/**
 * Returns the canonical public origin for shareable URLs (UTM links,
 * QR codes, short links).
 *
 * `window.location.origin` is wrong for these surfaces because the admin
 * panel is served behind Tailscale — admins see something like
 * `https://admin.tailnet.ts.net`, and any URL we encode for sharing or print
 * media would lead non-admin visitors to a host they cannot reach. The
 * canonical public origin must be `https://price.games` regardless of how
 * the admin happens to reach the panel.
 *
 * Resolution order:
 * 1. `VITE_PUBLIC_SITE_URL` (build-time, allows preview environments to
 *    override without code changes — e.g. a sandbox could set this to its
 *    own public origin).
 * 2. `https://price.games` (production canonical default).
 *
 * The returned string never has a trailing slash, so callers can safely
 * concatenate `${origin}${path}`.
 */
export function getPublicSiteOrigin(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined;
  const raw = fromEnv && fromEnv.length > 0 ? fromEnv : "https://price.games";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Returns the host portion of {@link getPublicSiteOrigin} (e.g.
 * `price.games`). Used by the UTM admin to display short-link previews
 * like `price.games/go/abc123` without exposing the Tailscale hostname.
 */
export function getPublicSiteHost(): string {
  try {
    return new URL(getPublicSiteOrigin()).host;
  } catch {
    return "price.games";
  }
}
