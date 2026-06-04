/**
 * Outbound link tagging service — applies UTM parameters and short-link
 * substitution to URLs flowing through emails and push notifications.
 *
 * Two complementary tagging strategies, picked automatically by
 * {@link tagAndShortenUrl}:
 *   1. **Per-template short codes** for static / canonical destinations.
 *      One row in `utm_tags` per (origin, destination) pair, lazily
 *      created on first reference, served by the public `/go/<code>`
 *      redirect handler. Aggregates click counts per template type.
 *   2. **Long UTM-only URLs** for tokenized per-recipient destinations
 *      (claim links, verify-email, password-reset). Short-coding these
 *      would either explode the table to per-recipient rows or break
 *      the token-to-user binding.
 *
 * Email body content goes through {@link rewriteHtmlLinks} (HTML) /
 * {@link rewriteTextLinks} (plain text) which find every clickable URL
 * pointing at our own origin and route it through {@link tagAndShortenUrl}.
 * Push payload URLs use {@link tagUrl} directly — push URLs aren't user-
 * visible so short-link aesthetics don't matter, and the existing push
 * click tracker (`/api/push/click/<logId>?r=...`) already provides
 * per-template click attribution from `notification_log`.
 */

import { randomUUID } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { parse } from "node-html-parser";
import {
  OUTBOUND_ORIGINS,
  type OutboundOriginKey,
} from "@price-game/shared";
import { config } from "../config";
import { generateShortCodeSuggestion } from "./utmTags";

// ── Tokenized URL detection ─────────────────────────────────────────────────

/**
 * Per-recipient URL pathname patterns. Matching paths skip short-linking
 * (the URL would carry a token unique to one user; a static short code
 * cannot encode that). UTM params are appended to the long URL instead.
 */
const TOKENIZED_PATHNAMES = new Set<string>([
  "/verify-email",
  "/reset-password",
]);

/**
 * Pathname prefixes whose remainder is a per-recipient token.
 * `/claim/<token>` is the canonical example.
 */
const TOKENIZED_PATH_PREFIXES = ["/claim/"];

/**
 * Extract the pathname from a relative or absolute URL. Returns null if
 * the URL is not parseable (e.g. `mailto:`, `javascript:`).
 */
function pathnameOf(url: string): string | null {
  try {
    // The base URL is only used for relative inputs. For absolute inputs
    // it's ignored entirely.
    const parsed = new URL(url, "http://placeholder.local");
    return parsed.pathname;
  } catch {
    return null;
  }
}

/**
 * True when a URL points at a per-recipient destination that should NOT
 * be short-linked. Detection is path-based: any extra query string (such
 * as `?token=...` on verify-email) is irrelevant — the path alone tells us
 * whether the destination is recipient-bound.
 */
export function isTokenizedUrl(url: string): boolean {
  const pathname = pathnameOf(url);
  if (pathname === null) return false;
  if (TOKENIZED_PATHNAMES.has(pathname)) return true;
  for (const prefix of TOKENIZED_PATH_PREFIXES) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      return true;
    }
  }
  return false;
}

// ── UTM appending ───────────────────────────────────────────────────────────

/**
 * Append `(utm_source, utm_medium, utm_campaign, utm_content?)` to a URL,
 * preserving any existing query parameters and fragment. UTM params already
 * present on the input are NOT overwritten — admin-authored templates may
 * carry their own UTMs and we defer to the author when there's a collision.
 *
 * Relative URLs (starting with `/`) are returned in relative form;
 * absolute URLs are returned absolute. The base URL used internally to
 * parse relative inputs is opaque and never appears in the output.
 *
 * @param url - Relative or absolute URL to tag.
 * @param originKey - Origin whose UTM tuple should be applied.
 * @returns The same URL with UTM params merged in.
 */
export function tagUrl(url: string, originKey: OutboundOriginKey): string {
  const spec = OUTBOUND_ORIGINS[originKey];
  const isRelative = url.startsWith("/");

  let parsed: URL;
  try {
    parsed = new URL(url, "http://placeholder.local");
  } catch {
    // Unparseable input — return unchanged rather than throwing, so a
    // template with a malformed link doesn't break the whole send.
    return url;
  }

  const setIfAbsent = (key: string, value: string | undefined) => {
    if (value && !parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
  };
  setIfAbsent("utm_source", spec.source);
  setIfAbsent("utm_medium", spec.medium);
  setIfAbsent("utm_campaign", spec.campaign);
  setIfAbsent("utm_content", spec.content);

  if (isRelative) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

/**
 * Convenience wrapper: prepend `config.appUrl` to a path then tag.
 * Equivalent to `tagUrl(`${config.appUrl}${path}`, originKey)`.
 */
export function tagAppPath(path: string, originKey: OutboundOriginKey): string {
  const base = config.appUrl.endsWith("/") ? config.appUrl.slice(0, -1) : config.appUrl;
  const sep = path.startsWith("/") ? "" : "/";
  return tagUrl(`${base}${sep}${path}`, originKey);
}

// ── Origin short codes (system-managed utm_tags rows) ───────────────────────

/**
 * In-memory cache of `(origin, destination) → short URL`. Hit rates are
 * effectively 100% in steady state since the universe of (origin, dest)
 * tuples is bounded (~21 origins × small set of canonical destinations).
 */
const shortUrlCache = new Map<string, string>();

/** Compose the cache key. */
function cacheKey(originKey: OutboundOriginKey, destinationUrl: string): string {
  return `${originKey}|${destinationUrl}`;
}

/**
 * For tests only: clear the in-process short-URL cache. Production never
 * calls this — entries live as long as the process.
 */
export function _resetOutboundLinksCacheForTests(): void {
  shortUrlCache.clear();
}

/**
 * Build the short URL for a tag's code. Mirrors `buildShortUrl` in
 * utmTags.ts but inlined here so we avoid an import cycle with the
 * cache-priming flow.
 */
function makeShortUrl(shortCode: string): string {
  const trimmedBase = config.appUrl.endsWith("/")
    ? config.appUrl.slice(0, -1)
    : config.appUrl;
  return `${trimmedBase}/go/${shortCode}`;
}

/**
 * Get (or lazily create) the short URL for a system-managed origin tag.
 *
 * Idempotent: repeat calls with the same `(originKey, destinationUrl)`
 * always return the same short URL. The first call materializes a
 * `utm_tags` row tagged with `origin_key` and a freshly generated short
 * code; subsequent calls hit the in-memory cache or the unique
 * `(origin_key, destination_url)` index.
 *
 * Concurrency: under a multi-process deployment two workers may race on
 * the first INSERT. The migration's partial UNIQUE index on
 * `(origin_key, destination_url)` guarantees one winner; the loser
 * catches the UNIQUE constraint error and reads back the winner's short
 * code via the same index.
 *
 * @param db - Database instance.
 * @param originKey - The origin to materialize.
 * @param destinationUrl - The canonical destination path (e.g. `/`).
 * @returns The full short URL `${appUrl}/go/<code>`.
 * @throws Error only if the row cannot be materialized (e.g. exhausted
 *   short-code suggestions, broken DB).
 */
export function getOrCreateOriginShortCode(
  db: DatabaseType,
  originKey: OutboundOriginKey,
  destinationUrl: string,
): string {
  const key = cacheKey(originKey, destinationUrl);
  const cached = shortUrlCache.get(key);
  if (cached !== undefined) return cached;

  // Fast path: row already exists (other worker, prior process restart,
  // admin manually attached an origin_key, etc.).
  const existing = db
    .prepare(
      `SELECT short_code FROM utm_tags
        WHERE origin_key = ? AND destination_url = ?`,
    )
    .get(originKey, destinationUrl) as { short_code: string | null } | undefined;
  if (existing?.short_code) {
    const url = makeShortUrl(existing.short_code);
    shortUrlCache.set(key, url);
    return url;
  }

  // Materialize a new system row. The name carries a UUID suffix to
  // sidestep the UNIQUE(name) constraint when the same origin needs
  // multiple (destination) variants (e.g. reward_reminder content split).
  const spec = OUTBOUND_ORIGINS[originKey];
  const id = randomUUID();
  const now = new Date().toISOString();
  const shortCode = generateShortCodeSuggestion(db);
  const name = `[system:${originKey}] ${randomUUID().slice(0, 8)}`;

  try {
    db.prepare(
      `INSERT INTO utm_tags
        (id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         destination_url, status, created_at, updated_at, created_by, short_code, origin_key)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      name,
      spec.source,
      spec.medium,
      spec.campaign,
      spec.content ?? null,
      destinationUrl,
      now,
      now,
      shortCode,
      originKey,
    );
  } catch (err: unknown) {
    // UNIQUE on (origin_key, destination_url) — another worker won the
    // race. UNIQUE on short_code or name — extraordinarily unlikely with
    // UUID-suffixed names + 6-char nanoid codes, but the read-back below
    // covers both cases as long as a (origin, dest) row exists.
    if (!(err instanceof Error) || !err.message.includes("UNIQUE")) {
      throw err;
    }
  }

  const row = db
    .prepare(
      `SELECT short_code FROM utm_tags
        WHERE origin_key = ? AND destination_url = ?`,
    )
    .get(originKey, destinationUrl) as { short_code: string | null } | undefined;
  if (!row?.short_code) {
    throw new Error(
      `outboundLinks: failed to materialize short code for ${originKey} -> ${destinationUrl}`,
    );
  }

  const url = makeShortUrl(row.short_code);
  shortUrlCache.set(key, url);
  return url;
}

// ── High-level link-rewriting helpers ───────────────────────────────────────

/**
 * Choose the right tagging strategy for a single URL:
 *   - Tokenized URLs (per-recipient): UTM params appended, no short link.
 *   - Anything else: routed through a short code via
 *     {@link getOrCreateOriginShortCode}, with the destination path
 *     normalized to relative-to-app form.
 *
 * @param db - Database instance.
 * @param url - The URL to tag.
 * @param originKey - Origin whose UTM tuple should be applied.
 * @returns The tagged or shortened URL.
 */
export function tagAndShortenUrl(
  db: DatabaseType,
  url: string,
  originKey: OutboundOriginKey,
): string {
  if (isTokenizedUrl(url)) {
    return tagUrl(url, originKey);
  }
  // Normalize the destination to a relative path so multiple environments
  // (localhost, staging, prod) all share the same `(origin_key,
  // destination_url)` row instead of one per absolute base URL.
  const dest = normalizeDestination(url);
  try {
    return getOrCreateOriginShortCode(db, originKey, dest);
  } catch (err) {
    // Pathological cases (e.g. short-code collision exhausting all 5
    // suggestion attempts, or a foreign-key error) must not break the
    // email send path. Fall back to a tagged long URL so the recipient
    // still gets a working link with correct attribution; the failure
    // is logged so the operational issue is visible.
    console.error(
      `[outboundLinks] short-code materialization failed for ${originKey} -> ${dest}, falling back to long URL:`,
      err,
    );
    return tagUrl(url, originKey);
  }
}

/**
 * Normalize an arbitrary URL to the path form used as the
 * `destination_url` on system tag rows. Absolute URLs whose origin
 * matches `config.appUrl` (or the canonical `price.games` host) are
 * stripped to their path; root-relative URLs are returned as-is. Other
 * absolute URLs (rare; an admin template linking off-site) are kept
 * absolute so click tracking still works.
 */
function normalizeDestination(url: string): string {
  // Protocol-relative ("//host/path") would resolve to a different
  // origin if passed through `new URL(rel, base)`. Defense in depth:
  // shouldRewriteHref already rejects these, but normalizeDestination
  // is also reachable from callers that bypass the rewriter (e.g. the
  // explicit `tagAndShortenUrl` calls inside reward email senders).
  if (url.startsWith("//")) return "/";
  if (url.startsWith("/")) return url || "/";
  try {
    const parsed = new URL(url);
    const appHost = new URL(config.appUrl).host;
    if (
      parsed.host === appHost ||
      parsed.host === "price.games" ||
      parsed.host === "www.price.games"
    ) {
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return path || "/";
    }
    return url;
  } catch {
    return url;
  }
}

// ── HTML / text rewriters ───────────────────────────────────────────────────

/**
 * True when an `href` value should be passed through the tagging service.
 * Skips other-protocol links (mailto/tel/javascript), in-page anchors,
 * already-tracked URLs (the unsubscribe footer's HMAC link, the push
 * click tracker), and external destinations. Both `${config.appUrl}/...`
 * and the canonical `https://price.games/...` form are recognized — some
 * seeded templates hard-code the production origin.
 */
function shouldRewriteHref(href: string): boolean {
  if (!href) return false;
  const lower = href.toLowerCase();
  if (
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("#")
  ) {
    return false;
  }
  // Skip the HMAC-signed unsubscribe link (matches both legacy /unsub
   // and current /unsubscribe paths) and the push click tracker — both
   // are pre-tracked and tagging would distort engagement metrics.
  if (
    href.includes("/api/email/unsub") ||
    href.includes("/api/push/click")
  ) {
    return false;
  }
  // Reject protocol-relative URLs ("//evil.com/...") explicitly. These
  // start with "/" and would otherwise be treated as same-origin paths,
  // but `new URL("//evil.com/x", "https://price.games")` resolves to
  // `https://evil.com/x` — without this guard, a hostile admin-authored
  // template could plant a persistent open redirect via the /go/<code>
  // handler. Mirrors the identical check in validateDestinationUrl.
  if (href.startsWith("//")) return false;
  if (href.startsWith("/")) return true;
  try {
    const u = new URL(href);
    const appHost = new URL(config.appUrl).host;
    if (u.host === appHost) return true;
    if (u.host === "price.games" || u.host === "www.price.games") return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Rewrite every clickable `<a href="...">` in an HTML email body so that
 * URLs pointing at our own origin carry UTM params and (where eligible)
 * resolve through a short-link redirect. Preserves all surrounding
 * markup; image src attributes are left untouched.
 *
 * Run BEFORE `appendUnsubscribeFooter` so the HMAC-signed unsubscribe
 * URL is never tagged (signed token would survive the tag, but tagging
 * is misleading — the unsub click is the action, not a campaign engagement).
 *
 * @param html - Rendered HTML body.
 * @param originKey - Origin to apply.
 * @param db - Database instance.
 * @returns HTML with anchor hrefs rewritten.
 */
export function rewriteHtmlLinks(
  html: string,
  originKey: OutboundOriginKey,
  db: DatabaseType,
): string {
  if (!html) return html;
  const root = parse(html);
  const anchors = root.querySelectorAll("a[href]");
  let mutated = false;
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href || !shouldRewriteHref(href)) continue;
    const tagged = tagAndShortenUrl(db, href, originKey);
    if (tagged !== href) {
      anchor.setAttribute("href", tagged);
      mutated = true;
    }
  }
  return mutated ? root.toString() : html;
}

/**
 * Rewrite bare URLs in a plain-text email body. Plain text is simple
 * enough that a regex is safe — there are no nested structures, no
 * attribute-encoded URLs, and trailing punctuation handling is the only
 * subtle case.
 *
 * @param text - Plain-text body.
 * @param originKey - Origin to apply.
 * @param db - Database instance.
 * @returns Text with URLs rewritten in place.
 */
export function rewriteTextLinks(
  text: string,
  originKey: OutboundOriginKey,
  db: DatabaseType,
): string {
  if (!text) return text;
  return text.replace(/\bhttps?:\/\/[^\s<>"']+/g, (match) => {
    // Strip trailing punctuation that's almost certainly sentence chrome,
    // not part of the URL: `.,;:!?)]`. Keep stripped chars on the result.
    const trailingMatch = match.match(/[.,;:!?)\]]+$/);
    const trailing = trailingMatch?.[0] ?? "";
    const cleanUrl = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    if (!shouldRewriteHref(cleanUrl)) return match;
    return tagAndShortenUrl(db, cleanUrl, originKey) + trailing;
  });
}
