/**
 * Geo-IP resolution for the analytics ingest path.
 *
 * Strategy: **Cloudflare `CF-IPCountry` header first, MaxMind fallback.**
 * Since price.games sits behind Cloudflare, the header is present on every
 * inbound request and is both accurate and zero-cost. MaxMind is only
 * consulted if the header is missing (e.g. direct-to-origin hits during
 * local development or a bypassed CDN). To keep the server image small, the
 * MaxMind reader is resolved lazily: if `@maxmind/geoip2-node` is not
 * installed or the DB path is not configured, geo lookups quietly return
 * `null` rather than throwing.
 */

import type { Request } from "express";

/** Minimal geo record populated on every event. */
export interface GeoRecord {
  country: string | null;
  region: string | null;
}

type MaxMindReader = {
  country: (ip: string) => { country?: { isoCode?: string } };
  city: (ip: string) => {
    country?: { isoCode?: string };
    subdivisions?: Array<{ isoCode?: string }>;
  };
};

let maxmindReader: MaxMindReader | null | undefined;

/**
 * Lazily load MaxMind once on first miss. If the package or DB file is
 * unavailable, marks the reader as permanently null so we don't retry.
 */
function getMaxmindReader(): MaxMindReader | null {
  if (maxmindReader !== undefined) return maxmindReader;

  const dbPath = process.env.MAXMIND_DB_PATH;
  if (!dbPath) {
    maxmindReader = null;
    return null;
  }

  try {
    // Optional dependency — resolved dynamically so that missing it doesn't
    // break the server build. `require` is allowed here because the server
    // bundle is CommonJS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@maxmind/geoip2-node");
    const buffer = require("fs").readFileSync(dbPath);
    maxmindReader = mod.Reader.openBuffer(buffer) as MaxMindReader;
    return maxmindReader;
  } catch (err) {
    console.warn("MaxMind geo reader unavailable — falling back to header-only geo:", err);
    maxmindReader = null;
    return null;
  }
}

/**
 * Resolve the country / region for a request. Always prefers the
 * Cloudflare `CF-IPCountry` header (and `CF-Region-Code` if present) over
 * MaxMind — the CDN is closer to the client than our origin and more
 * accurate for country-level attribution.
 *
 * @param req - Express request (for headers + IP).
 * @returns Geo record. Either field may be null if unresolvable.
 */
export function lookupGeo(req: Request): GeoRecord {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const cfCountry = headerString(headers["cf-ipcountry"]);
  const cfRegion = headerString(headers["cf-region-code"]);

  if (cfCountry && cfCountry !== "XX" && cfCountry !== "T1") {
    return { country: cfCountry.toUpperCase(), region: cfRegion ?? null };
  }

  const reader = getMaxmindReader();
  if (!reader) return { country: null, region: null };

  const ip = getIp(req);
  if (!ip) return { country: null, region: null };

  try {
    const result = reader.city(ip);
    return {
      country: result.country?.isoCode?.toUpperCase() ?? null,
      region: result.subdivisions?.[0]?.isoCode ?? null,
    };
  } catch {
    return { country: null, region: null };
  }
}

/** Extract the first valid IP from the request chain, prefering CF-Connecting-IP. */
export function getIp(req: Request): string | null {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const cfConnIp = headerString(headers["cf-connecting-ip"]);
  if (cfConnIp) return cfConnIp;

  const xff = headerString(headers["x-forwarded-for"]);
  if (xff) {
    // First non-empty IP in the chain is the client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function headerString(value: string | string[] | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value.trim() || null;
}

/**
 * Test-only: clear the cached reader so tests can exercise the lazy path
 * under different env vars.
 *
 * @internal
 */
export function __resetMaxmindReader(): void {
  maxmindReader = undefined;
}
