/**
 * Broadcast-overlay access middleware.
 *
 * The streamer-bot's broadcast shell (`?broadcast=1`) is a 1920×1080
 * operator surface — chat panel, neural-network visualisers, mood
 * indicator, etc. — designed to be captured by the bot's Chromium and
 * fed into ffmpeg. It is NOT a public-facing UI: humans hitting
 * `https://price.games/?broadcast=1` would see the operator chrome
 * over their game and could scrape internal state we'd rather keep
 * private (model beliefs, NN tick stream).
 *
 * The boundary lives at two layers, mirroring the `/admin*` pattern:
 *
 *   1. Caddy (network layer) — the public `price.games` vhost returns
 *      404 for any request whose query string contains `broadcast=1`.
 *      The Tailscale interface, fronted by `tailscale serve`, has no
 *      such restriction and reaches the same Express backend.
 *
 *   2. This middleware (application layer, defence in depth) — if a
 *      request still slips through (Caddy misconfig, sandbox vhost,
 *      future hostname added without thinking), reject it server-side.
 *
 * The check is "block by hostname allowlist-of-blocked": the env var
 * `BROADCAST_BLOCKED_HOSTS` lists user-facing hostnames where the
 * broadcast shell must NOT render. Default covers production and
 * sandbox. Tailnet hostnames (`*.ts.net`) and `localhost` are not in
 * the blocklist and pass through.
 *
 * Hostname is read from `req.hostname`, which honours
 * `X-Forwarded-Host` because we set `trust proxy` to loopback in
 * `index.ts`. Caddy and `tailscale serve` both forward the original
 * Host header, so this reflects the browser-facing hostname rather
 * than the upstream loopback address.
 */

import { Request, Response, NextFunction } from "express";

/**
 * Production defaults — always present in the resulting block set,
 * even when the operator provides additional hosts via env. This is a
 * fail-closed choice: a typo in `BROADCAST_BLOCKED_HOSTS` (e.g.
 * dropping `price.games` while adding a mirror) must NOT silently
 * downgrade protection on the production hostnames.
 */
const DEFAULT_BLOCKED_HOSTS = [
  "price.games",
  "www.price.games",
  "sandbox.price.games",
] as const;

/**
 * Parse the comma-separated `BROADCAST_BLOCKED_HOSTS` env var and
 * union it with the production defaults. The defaults are always
 * present — env additions are additive, never subtractive — so an
 * operator typo cannot remove `price.games` from the in-process gate.
 *
 * @param raw - Raw env value (or undefined).
 * @returns Set of blocked hostnames, lowercase, defaults always included.
 */
export function parseBlockedHosts(raw: string | undefined): Set<string> {
  const set = new Set<string>(DEFAULT_BLOCKED_HOSTS);
  if (!raw) return set;
  for (const part of raw.split(",")) {
    const normalised = part.trim().toLowerCase();
    if (normalised) set.add(normalised);
  }
  return set;
}

/**
 * Detect the `?broadcast=1` query flag in a way that matches the
 * web app's own `useBroadcastMode` hook (strict `=== "1"`). Express
 * parses the query string into either a string or string[] when a key
 * is repeated, so we collapse arrays and check the first value.
 */
function isBroadcastRequest(req: Request): boolean {
  const raw = req.query.broadcast;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1";
}

/**
 * Build the broadcast-access middleware. Closes over the blocked-host
 * set so the env var is read once at boot — runtime changes need a
 * server restart, matching how every other config knob behaves.
 *
 * The input set is normalised (lowercase + trailing-dot stripped)
 * inside the factory so a direct caller passing mixed-case or FQDN
 * forms cannot accidentally produce a no-op middleware.
 *
 * @param blockedHosts - Hostnames where broadcast must 404 (any case;
 *   normalised internally).
 * @returns Express middleware. Calls `next()` for any request that is
 *   not a broadcast request OR is reaching us via a non-blocked
 *   hostname (e.g. tailnet); responds 404 otherwise.
 */
export function createDenyPublicBroadcast(
  blockedHosts: Set<string>,
): (req: Request, res: Response, next: NextFunction) => void {
  const normalised = new Set<string>();
  for (const h of blockedHosts) normalised.add(normaliseHost(h));
  // Sandbox-only escape hatch — disables the application-layer gate
  // so sandbox.price.games/?broadcast=1 reaches the overlay for the
  // per-mood TTS lipsync diagnostic (see apps/server/src/routes/
  // sandboxTts.ts). Requires BOTH `SANDBOX=1` AND
  // `BROADCAST_DISABLE_PUBLIC_GATE=1` so a single env-var typo or
  // misconfiguration in production cannot silently downgrade the
  // gate. The Dockerfile.sandbox-tts image bakes both env vars on;
  // production's alpine Dockerfile sets neither. Caddy's vhost-level
  // 404 on `?broadcast=1` for `price.games` / `www.price.games` is
  // the outer defence layer (see /etc/caddy/Caddyfile) and remains
  // in effect regardless of this in-process flag.
  const disabled = process.env.SANDBOX === "1"
    && process.env.BROADCAST_DISABLE_PUBLIC_GATE === "1";
  return function denyPublicBroadcast(req, res, next) {
    if (disabled) {
      next();
      return;
    }
    if (!isBroadcastRequest(req)) {
      next();
      return;
    }
    const host = normaliseHost(req.hostname ?? "");
    if (normalised.has(host)) {
      // Match the Caddy 404 exactly — no body, no hint that the
      // resource exists somewhere else. Operators looking for the
      // overlay are expected to know to use the tailnet hostname.
      res.status(404).end();
      return;
    }
    next();
  };
}

/**
 * Lowercase the hostname and strip any trailing dot. The trailing dot
 * is valid in absolute FQDN form (`Host: price.games.`) and DNS
 * resolves it identically to the non-dotted form, so `Set.has()` must
 * compare both forms as equal — otherwise a request with `Host:
 * price.games.` slips past the in-process block. Caddy normalises
 * this on the public vhost, but the whole point of layer 2 is to
 * backstop layer 1.
 */
function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/**
 * Default-config middleware factory. Reads `BROADCAST_BLOCKED_HOSTS`
 * from the environment at call time and returns a ready-to-mount
 * middleware. Tests can call `createDenyPublicBroadcast` directly
 * with an explicit set instead of going through the env var.
 */
export function denyPublicBroadcastFromEnv(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return createDenyPublicBroadcast(parseBlockedHosts(process.env.BROADCAST_BLOCKED_HOSTS));
}
