/**
 * SEO routes: `/robots.txt` and `/sitemap.xml`, plus a helper that injects
 * per-route `<title>`, `<meta description>`, `<link rel="canonical">`, and
 * OG/Twitter tags into the SPA's `index.html` response so search-engine
 * crawlers see correct meta without executing JavaScript.
 *
 * The sitemap is generated on-demand from the shared SEO registry and
 * cached in-memory with a short TTL to keep it cheap.
 */

import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  SEO_ROUTES,
  SEO_GAME_MODE_ROUTES,
  SITE_ORIGIN,
  SITE_OG_IMAGE,
  SITE_NAME,
  canonicalUrl,
  getGameModeName,
  resolveSeoMeta,
  type GameMode,
  type SeoMeta,
} from "@price-game/shared";
import { getEnabledPages, PAGE_KEYS, type PageKey } from "../services/siteSettings";

/** Map each `PageKey` to the canonical URL pathname it renders at. The
 *  storage key uses `game_modes` for JSON-friendliness but the public
 *  URL is `/game-modes`. Exported so the SEO body injector can also gate
 *  admin-toggleable pages without duplicating the mapping. */
export const PAGE_KEY_TO_PATH: Record<PageKey, string> = {
  about: "/about",
  faq: "/faq",
  contact: "/contact",
  game_modes: "/game-modes",
  privacy: "/privacy",
  terms: "/terms",
};

/** Inverse of `PAGE_KEY_TO_PATH` — resolves an incoming URL path to its
 *  `PageKey` so request handlers can look up the visibility toggle for
 *  the page they're about to serve. Exported alongside `PAGE_KEY_TO_PATH`
 *  for reuse by the body injector. */
export const PATH_TO_PAGE_KEY: Record<string, PageKey> = Object.fromEntries(
  Object.entries(PAGE_KEY_TO_PATH).map(([k, v]) => [v, k as PageKey]),
) as Record<string, PageKey>;

/**
 * Resolve per-request SEO overrides for the public page-visibility toggle.
 *
 * When the requested pathname maps to one of the six admin-toggleable SEO
 * pages AND that page is disabled, return `{ noindex: true }` so the
 * server-injected meta tags tell crawlers not to index the stub that the
 * client will render (the client-side guard will show an in-app 404, but
 * a crawler hitting the shell directly should still be told to skip it).
 *
 * Returns null when the path isn't one of the toggleable pages or when
 * the page is enabled, so the caller can fall through to other resolvers.
 */
export function resolvePageVisibilityMeta(
  getDb: () => DatabaseType,
  pathname: string,
): Partial<SeoMeta> | null {
  const pageKey = PATH_TO_PAGE_KEY[pathname];
  if (!pageKey) return null;
  try {
    const pages = getEnabledPages(getDb());
    if (pages[pageKey] === true) return null;
    return { noindex: true };
  } catch {
    // If the DB lookup fails, don't block SPA rendering — just skip the
    // override and let the static registry drive meta.
    return null;
  }
}

/**
 * Build the contents of `/robots.txt`. Allows all crawlers on public paths
 * and explicitly disallows auth/admin/short-link endpoints that should never
 * appear in search results.
 */
export function buildRobotsTxt(
  sitemapUrl: string = `${SITE_ORIGIN}/sitemap.xml`,
  extraDisallowPaths: readonly string[] = [],
): string {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /admin/",
    "Disallow: /api/",
    "Disallow: /go/",
    "Disallow: /r/",
    "Disallow: /verify-email",
    "Disallow: /reset-password",
    "Disallow: /forgot-password",
    "Disallow: /settings",
    "Disallow: /profile",
    "Disallow: /giveaway",
    "Disallow: /universe",
  ];
  for (const p of extraDisallowPaths) {
    lines.push(`Disallow: ${p}`);
  }
  lines.push("", `Sitemap: ${sitemapUrl}`, "");
  return lines.join("\n");
}

/** Escape an XML attribute/text value (covers the 5 entity characters). */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface SitemapEntry {
  loc: string;
  changefreq?: SeoMeta["changefreq"];
  priority?: number;
  lastmod?: string;
}

/**
 * Enumerate all sitemap-eligible entries from the static route table.
 * Dynamic entries (top-N player profiles) are added by `getDynamicEntries`
 * when a database is provided.
 *
 * @param disabledPaths - Optional set of URL pathnames (e.g. `/about`,
 *   `/game-modes`) to exclude from the sitemap because the admin has
 *   marked the page as not visible. Disabled pages are dropped entirely
 *   rather than emitted with `noindex` — the sitemap is an allowlist
 *   for crawlers, so silence is the correct signal.
 */
export function collectStaticSitemapEntries(
  disabledPaths: ReadonlySet<string> = new Set<string>(),
): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const merged: Record<string, SeoMeta> = { ...SEO_ROUTES, ...SEO_GAME_MODE_ROUTES };
  for (const [pathname, meta] of Object.entries(merged)) {
    if (!meta.sitemap) continue;
    if (disabledPaths.has(pathname)) continue;
    entries.push({
      loc: canonicalUrl(pathname),
      changefreq: meta.changefreq,
      priority: meta.priority,
    });
  }
  return entries;
}

/**
 * Collect the set of admin-toggled-off page paths for sitemap exclusion.
 * Safe to call with any DB state: on error returns an empty set so the
 * sitemap still renders (with no disabled pages filtered out).
 */
function getDisabledPageUrlPaths(getDb: () => DatabaseType): ReadonlySet<string> {
  try {
    const pages = getEnabledPages(getDb());
    const disabled = new Set<string>();
    // Iterate the typed `PAGE_KEYS` allowlist instead of `Object.entries`
    // so a missing key in a malformed stored row (defensively defaulted by
    // `getEnabledPages`) still produces a deterministic disabled entry.
    for (const key of PAGE_KEYS) {
      if (pages[key] !== true) disabled.add(PAGE_KEY_TO_PATH[key]);
    }
    return disabled;
  } catch {
    return new Set<string>();
  }
}

/**
 * Pull the top N players by lifetime score for inclusion in the sitemap.
 * Returns an empty array if the query fails so a malformed DB state never
 * takes the sitemap down.
 */
export function getTopPlayerEntries(db: DatabaseType, limit: number = 100): SitemapEntry[] {
  try {
    const rows = db
      .prepare<[number], { username: string }>(
        "SELECT username FROM users WHERE username IS NOT NULL AND username != '' ORDER BY lifetime_score DESC LIMIT ?",
      )
      .all(limit);
    return rows
      .filter((r) => /^[A-Za-z0-9_-]{1,32}$/.test(r.username))
      .map((r) => ({
        loc: `${SITE_ORIGIN}/player/${encodeURIComponent(r.username)}`,
        changefreq: "weekly" as const,
        priority: 0.4,
      }));
  } catch {
    return [];
  }
}

/**
 * Render a list of sitemap entries into a valid sitemap.xml document.
 */
export function renderSitemapXml(entries: SitemapEntry[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const e of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${xmlEscape(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
    if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (typeof e.priority === "number") {
      lines.push(`    <priority>${e.priority.toFixed(1)}</priority>`);
    }
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return lines.join("\n");
}

/**
 * Create the SEO router (serves `/robots.txt` and `/sitemap.xml`).
 *
 * @param getDb - Lazy database accessor so tests can swap the instance.
 * @param options.sitemapCacheMs - Server-side cache TTL for the sitemap XML.
 */
export function createSeoRouter(
  getDb: () => DatabaseType,
  options: { sitemapCacheMs?: number } = {},
): Router {
  const router = Router();
  const CACHE_MS = options.sitemapCacheMs ?? 10 * 60 * 1000;
  let cached: { xml: string; expires: number } | null = null;

  router.get("/robots.txt", (_req: Request, res: Response) => {
    res.type("text/plain");
    res.setHeader("Cache-Control", "public, max-age=3600");
    // Explicitly disallow admin-disabled SEO pages as a defense-in-depth
    // signal; they're also excluded from the sitemap and served with
    // `noindex` so well-behaved crawlers get three consistent hints.
    const disabled = [...getDisabledPageUrlPaths(getDb)];
    res.send(buildRobotsTxt(undefined, disabled));
  });

  router.get("/sitemap.xml", (_req: Request, res: Response) => {
    const now = Date.now();
    // `<=` rather than `<` so that `CACHE_MS = 0` (tests) disables the
    // cache entirely — with `<`, expires === now on the very next call
    // would still be considered fresh.
    if (!cached || cached.expires <= now) {
      const disabledPaths = getDisabledPageUrlPaths(getDb);
      const staticEntries = collectStaticSitemapEntries(disabledPaths);
      const playerEntries = getTopPlayerEntries(getDb(), 100);
      cached = {
        xml: renderSitemapXml([...staticEntries, ...playerEntries]),
        expires: now + CACHE_MS,
      };
    }
    res.type("application/xml");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(cached.xml);
  });

  return router;
}

/** 8-char base64url — matches the share id format enforced by `/api/share`. */
const SHARE_ID_REGEX = /^\/s\/([A-Za-z0-9_-]{8})$/;

interface ShareRow {
  game_mode: string;
  total_score: number;
  player_name: string | null;
  round_data: string;
}

/**
 * Resolve per-share SEO meta for a `/s/:id` request: queries the
 * `shared_games` row and builds a descriptive title + description so
 * crawlers and social-link previews show the actual score/mode instead
 * of the generic shell.
 *
 * Returns null when the id is malformed, the row is missing, or the DB
 * query fails — the caller then falls back to the static registry default
 * for `/s/*`.
 */
export function resolveShareMeta(
  getDb: () => DatabaseType,
  pathname: string,
): Partial<SeoMeta> | null {
  const match = SHARE_ID_REGEX.exec(pathname);
  if (!match) return null;
  try {
    const row = getDb()
      .prepare(
        "SELECT game_mode, total_score, player_name, round_data FROM shared_games WHERE id = ?",
      )
      .get(match[1]) as ShareRow | undefined;
    if (!row) return null;
    const modeName = getGameModeName(row.game_mode as GameMode);
    const score = row.total_score.toLocaleString("en-US");
    const rounds = countRounds(row.round_data);
    const who = row.player_name && row.player_name.length > 0 ? row.player_name : "A player";
    const roundStr = rounds ? `${rounds}-round ` : "";
    return {
      title: `${score} points in ${modeName} — Price Games Result`,
      description: `${who} scored ${score} points in a ${roundStr}${modeName} Price Games run — see the round-by-round breakdown and play the same challenge.`,
      // Indexable: removed the noindex default so these long-tail shared
      // results can be discovered through social referrals.
    };
  } catch {
    return null;
  }
}

/** Safely extract the round count from the serialized snapshot. */
function countRounds(roundDataJson: string): number {
  try {
    const parsed = JSON.parse(roundDataJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Known static-asset extensions handled by the `express.static` middleware
 * upstream of this meta injector. When the last path segment matches one
 * of these, the request is for a real file (possibly a 404 lookup) and is
 * passed through untouched. SPA routes that legitimately contain a dot in
 * a dynamic segment (e.g., a future `/player/first.last`) are NOT skipped
 * because the final segment has no extension.
 */
const STATIC_ASSET_EXT = /\/[^/]+\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|json|xml|txt|woff2?|ttf|otf|eot|mp[34]|webm|wasm|pdf)$/i;

/**
 * Load the compiled SPA `index.html` from disk ONCE at process start, then
 * return a request handler that injects route-specific meta tags before
 * sending it. This is safe under the project's current Docker deploy model
 * (container restart replaces the process and re-reads the file). If you
 * ever switch to in-place dist swaps without a restart, replace this with
 * a per-request read or invalidation hook.
 *
 * If the template cannot be read (dev mode, wrong path), the handler is a
 * no-op passthrough so the catch-all still serves the raw file.
 */
export function createIndexHtmlMetaMiddleware(
  indexHtmlPath: string,
  options: {
    /** Optional per-request resolver for dynamic meta overrides. Returns
     *  a partial `SeoMeta` whose fields win over the static registry. */
    dynamicResolver?: (pathname: string) => Partial<SeoMeta> | null;
    /** Optional per-request resolver for static body content inserted
     *  inside `<div id="root">…</div>` so non-JS crawlers (AI bots, older
     *  indexers) see real page content. React 18's `createRoot` replaces
     *  these children on hydration, so the static content is only seen
     *  by crawlers and by users during the brief pre-hydration window. */
    bodyResolver?: (pathname: string) => string;
  } = {},
) {
  let template: string | null = null;
  try {
    template = fs.readFileSync(indexHtmlPath, "utf-8");
  } catch {
    template = null;
  }
  const { dynamicResolver, bodyResolver } = options;

  return function metaInjector(req: Request, res: Response, next: NextFunction): void {
    // Only run on GET requests that are likely to land on the SPA shell.
    // Skip API paths, asset paths, and any path whose final segment
    // resembles a real static asset (the static middleware has already
    // handled those; we get here only for missing files, which should
    // 404). Dynamic SPA paths that happen to contain a dot in a segment
    // other than the last (e.g. `/player/first.last`) are allowed through.
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) return next();
    if (req.path.startsWith("/assets/")) return next();
    if (req.path === "/robots.txt" || req.path === "/sitemap.xml") return next();
    if (STATIC_ASSET_EXT.test(req.path)) return next();
    if (!template) return next();

    const staticMeta = resolveSeoMeta(req.path);
    const dynamicMeta = dynamicResolver ? dynamicResolver(req.path) : null;
    const meta: SeoMeta = { ...staticMeta, ...(dynamicMeta ?? {}) };
    const canonical = canonicalUrl(req.path);
    let html = injectMeta(template, {
      title: meta.title,
      description: meta.description,
      canonical,
      ogImage: SITE_OG_IMAGE,
      noindex: Boolean(meta.noindex),
      siteName: SITE_NAME,
    });
    if (bodyResolver) {
      const body = bodyResolver(req.path);
      if (body) html = injectSeoBody(html, body);
    }
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };
}

/**
 * Replace `<div id="root"></div>` (the empty hydration target) with
 * `<div id="root">{body}</div>` so pre-hydration crawlers see real
 * content. Matches the open/close form that Vite emits (any amount of
 * whitespace between the tags is tolerated). If the marker isn't found
 * (e.g. template has been restructured or switched to a self-closing
 * form), returns the HTML unchanged so we never break a request by
 * silently dropping the app mount point.
 */
export function injectSeoBody(html: string, body: string): string {
  const re = /<div\s+id="root"\s*>\s*<\/div>/;
  if (!re.test(html)) return html;
  return html.replace(re, `<div id="root">${body}</div>`);
}

interface InjectOptions {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  siteName: string;
  noindex: boolean;
}

/**
 * Replace / insert the SEO-relevant tags in the template. Uses literal
 * string replacement (not regex) for the known `<title>` element and
 * descriptor meta tags so the transform is predictable and cheap.
 */
export function injectMeta(template: string, o: InjectOptions): string {
  let out = template;
  // Ampersand MUST be escaped first — escaping it later would double-escape
  // the entities produced by the other replacements (e.g. `&quot;` → `&amp;quot;`).
  const esc = htmlAttrEscape;

  // Replace <title>...</title>
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${esc(o.title)}</title>`);

  // Replace description (both <meta name=...> and <meta property=og:description>, twitter:description)
  out = replaceMetaByAttr(out, "name", "description", o.description);
  out = replaceMetaByAttr(out, "property", "og:title", o.title);
  out = replaceMetaByAttr(out, "property", "og:description", o.description);
  out = replaceMetaByAttr(out, "property", "og:url", o.canonical);
  out = replaceMetaByAttr(out, "property", "og:site_name", o.siteName);
  out = replaceMetaByAttr(out, "property", "og:image", o.ogImage);
  out = replaceMetaByAttr(out, "name", "twitter:title", o.title);
  out = replaceMetaByAttr(out, "name", "twitter:description", o.description);
  out = replaceMetaByAttr(out, "name", "twitter:image", o.ogImage);

  // Insert canonical + robots directives right before </head>. We insert
  // rather than replace because the static template doesn't carry them.
  const extras: string[] = [];
  extras.push(`    <link rel="canonical" href="${esc(o.canonical)}" />`);
  if (o.noindex) extras.push('    <meta name="robots" content="noindex,nofollow" />');
  out = out.replace(/<\/head>/, `${extras.join("\n")}\n  </head>`);

  return out;
}

/** Replace the `content=` of a `<meta {attr}="{val}" content="...">` tag. */
function replaceMetaByAttr(html: string, attr: string, val: string, newContent: string): string {
  const esc = htmlAttrEscape;
  const re = new RegExp(
    `<meta\\s+${attr}="${escapeRegExp(val)}"\\s+content="[^"]*"\\s*/?>`,
    "i",
  );
  if (re.test(html)) {
    return html.replace(re, `<meta ${attr}="${val}" content="${esc(newContent)}" />`);
  }
  // Tag missing — insert before </head>.
  return html.replace(
    /<\/head>/,
    `    <meta ${attr}="${val}" content="${esc(newContent)}" />\n  </head>`,
  );
}

/** HTML attribute-value escape. `&` must be escaped before the other
 *  entities or their own `&`-prefixed output would be double-escaped. */
function htmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape `s` for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Re-export the index.html path resolver used at runtime (eases testing). */
export function resolveIndexHtmlPath(webDist: string): string {
  return path.join(webDist, "index.html");
}
