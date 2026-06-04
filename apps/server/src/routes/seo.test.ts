/**
 * Tests for SEO infrastructure — robots.txt, sitemap.xml, the meta-injection
 * middleware, and the helper functions they rely on. Handlers are driven
 * directly from the Express router stack (no supertest — matches the style
 * of attribution.test.ts and the other route tests).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createSeoRouter,
  buildRobotsTxt,
  createIndexHtmlMetaMiddleware,
  injectMeta,
  renderSitemapXml,
  collectStaticSitemapEntries,
  getTopPlayerEntries,
  resolveShareMeta,
  resolvePageVisibilityMeta,
} from "./seo";
import { setEnabledPages } from "../services/siteSettings";

/** Flip every admin-toggleable SEO page on — used by tests that expect
 *  the page's URL in the sitemap or a 200-style response from content
 *  endpoints (the service now defaults all pages to disabled). */
function enableAllPages(target: DatabaseType = db) {
  setEnabledPages(target, {
    about: true,
    faq: true,
    contact: true,
    game_modes: true,
    privacy: true,
    terms: true,
  });
}

let db: DatabaseType;
let router: ReturnType<typeof createSeoRouter>;

beforeEach(() => {
  db = createTestDb();
  router = createSeoRouter(() => db, { sitemapCacheMs: 0 });
});

interface MockRes {
  statusCode?: number;
  body?: unknown;
  contentType?: string;
  headers: Record<string, string>;
}

/**
 * Resolve the final route handler for a given path + method from the
 * router stack.
 */
function getHandler(path: string, method: string = "get"): ((req: any, res: any) => void) | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stack = layer.route.stack.filter((s: any) => s.method === method);
      return stack[stack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockRes(): { res: any; data: MockRes } {
  const data: MockRes = { headers: {} };
  const res: any = {
    json(d: unknown) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
    type(t: string) { data.contentType = t; data.headers["Content-Type"] = t; return res; },
    send(s: unknown) { data.body = s; return res; },
    setHeader(k: string, v: string) { data.headers[k] = v; return res; },
  };
  return { res, data };
}

describe("buildRobotsTxt", () => {
  it("allows all crawlers by default", () => {
    const txt = buildRobotsTxt();
    expect(txt).toMatch(/User-agent: \*/);
    expect(txt).toMatch(/Allow: \//);
  });

  it("disallows admin, API, and short-link paths", () => {
    const txt = buildRobotsTxt();
    expect(txt).toContain("Disallow: /admin");
    expect(txt).toContain("Disallow: /api/");
    expect(txt).toContain("Disallow: /go/");
    expect(txt).toContain("Disallow: /r/");
    expect(txt).toContain("Disallow: /settings");
  });

  it("does NOT disallow /s/ — shared results are indexable long-tail pages", () => {
    const txt = buildRobotsTxt();
    expect(txt).not.toContain("Disallow: /s/");
  });

  it("references the sitemap", () => {
    const txt = buildRobotsTxt("https://price.games/sitemap.xml");
    expect(txt).toContain("Sitemap: https://price.games/sitemap.xml");
  });
});

describe("GET /robots.txt", () => {
  it("returns text/plain with the robots directives", () => {
    const handler = getHandler("/robots.txt");
    expect(handler).toBeDefined();
    const { res, data } = mockRes();
    handler!({}, res);
    expect(data.contentType).toBe("text/plain");
    expect(typeof data.body).toBe("string");
    expect(data.body as string).toContain("User-agent: *");
    expect(data.body as string).toContain("Sitemap:");
  });
});

describe("collectStaticSitemapEntries", () => {
  it("includes the home page with priority 1", () => {
    const entries = collectStaticSitemapEntries();
    const home = entries.find((e) => e.loc === "https://price.games/");
    expect(home).toBeDefined();
    expect(home?.priority).toBe(1.0);
  });

  it("includes /about, /faq, /contact, /game-modes by default", () => {
    // Function-level call: no disabled-paths set provided → every
    // sitemap-eligible SEO_ROUTES entry is included.
    const entries = collectStaticSitemapEntries();
    const paths = entries.map((e) => e.loc);
    expect(paths).toContain("https://price.games/about");
    expect(paths).toContain("https://price.games/faq");
    expect(paths).toContain("https://price.games/contact");
    expect(paths).toContain("https://price.games/game-modes");
  });

  it("includes per-mode /play/<slug> landing pages", () => {
    const entries = collectStaticSitemapEntries();
    const paths = entries.map((e) => e.loc);
    expect(paths).toContain("https://price.games/play/classic");
    expect(paths).toContain("https://price.games/play/higher-lower");
    expect(paths).toContain("https://price.games/play/price-match");
    // Bidding is multiplayer-only and has no single-player landing page.
    expect(paths).not.toContain("https://price.games/play/bidding");
  });

  it("excludes noindex paths like /settings and /verify-email", () => {
    const entries = collectStaticSitemapEntries();
    const paths = entries.map((e) => e.loc);
    expect(paths).not.toContain("https://price.games/settings");
    expect(paths).not.toContain("https://price.games/verify-email");
    expect(paths).not.toContain("https://price.games/forgot-password");
  });

  it("drops disabled paths when a disabled set is provided", () => {
    const entries = collectStaticSitemapEntries(new Set(["/about", "/game-modes"]));
    const paths = entries.map((e) => e.loc);
    expect(paths).not.toContain("https://price.games/about");
    expect(paths).not.toContain("https://price.games/game-modes");
    // Non-disabled pages still present.
    expect(paths).toContain("https://price.games/faq");
  });
});

describe("getTopPlayerEntries", () => {
  it("returns empty when no users exist", () => {
    const entries = getTopPlayerEntries(db);
    expect(entries).toEqual([]);
  });

  it("swallows query errors and returns an empty array", () => {
    // A DB closed before the call triggers the prepare/run failure path.
    db.close();
    const entries = getTopPlayerEntries(db);
    expect(entries).toEqual([]);
  });

  it("returns player profile URLs for top users by lifetime score", () => {
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, lifetime_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("u1", "Alice", "alice", "a@test.com", "h", "2026-01-01", "2026-01-01", 5000);
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, lifetime_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("u2", "Bob", "bob", "b@test.com", "h", "2026-01-01", "2026-01-01", 9000);

    const entries = getTopPlayerEntries(db, 10);
    expect(entries.length).toBe(2);
    // Highest score first.
    expect(entries[0].loc).toBe("https://price.games/player/Bob");
    expect(entries[1].loc).toBe("https://price.games/player/Alice");
  });

  it("skips usernames containing unsafe characters", () => {
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, lifetime_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("u1", "bad/name", "bad/name", "bad@test.com", "h", "2026-01-01", "2026-01-01", 1);
    const entries = getTopPlayerEntries(db, 10);
    expect(entries).toEqual([]);
  });
});

describe("renderSitemapXml", () => {
  it("produces a valid urlset document", () => {
    const xml = renderSitemapXml([
      { loc: "https://price.games/", priority: 1.0, changefreq: "daily" },
    ]);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://price.games/</loc>");
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
  });

  it("escapes XML entities in the loc field", () => {
    const xml = renderSitemapXml([{ loc: "https://price.games/?q=a&b=c" }]);
    expect(xml).toContain("<loc>https://price.games/?q=a&amp;b=c</loc>");
  });
});

describe("GET /sitemap.xml", () => {
  it("returns application/xml and includes the home + content page URLs when enabled", () => {
    enableAllPages();
    const handler = getHandler("/sitemap.xml");
    expect(handler).toBeDefined();
    const { res, data } = mockRes();
    handler!({}, res);
    expect(data.contentType).toBe("application/xml");
    const xml = data.body as string;
    expect(xml).toContain("<loc>https://price.games/</loc>");
    expect(xml).toContain("<loc>https://price.games/about</loc>");
    expect(xml).toContain("<loc>https://price.games/faq</loc>");
    expect(xml).toContain("<loc>https://price.games/contact</loc>");
    expect(xml).toContain("<loc>https://price.games/game-modes</loc>");
  });

  it("excludes toggleable pages from the sitemap when they are disabled", () => {
    // Fresh DB: every toggleable page is off, so only non-toggleable
    // entries (home, /mp, /scoreboard, etc.) should show up.
    const handler = getHandler("/sitemap.xml");
    const { res, data } = mockRes();
    handler!({}, res);
    const xml = data.body as string;
    expect(xml).not.toContain("<loc>https://price.games/about</loc>");
    expect(xml).not.toContain("<loc>https://price.games/faq</loc>");
    expect(xml).not.toContain("<loc>https://price.games/contact</loc>");
    expect(xml).not.toContain("<loc>https://price.games/game-modes</loc>");
    expect(xml).not.toContain("<loc>https://price.games/privacy</loc>");
    expect(xml).not.toContain("<loc>https://price.games/terms</loc>");
    // Home still present.
    expect(xml).toContain("<loc>https://price.games/</loc>");
  });

  it("does not include admin or noindex paths", () => {
    enableAllPages();
    const handler = getHandler("/sitemap.xml");
    const { res, data } = mockRes();
    handler!({}, res);
    const xml = data.body as string;
    expect(xml).not.toContain("<loc>https://price.games/admin</loc>");
    expect(xml).not.toContain("<loc>https://price.games/settings</loc>");
    expect(xml).not.toContain("<loc>https://price.games/verify-email</loc>");
  });
});

describe("GET /robots.txt — disabled-page handling", () => {
  it("adds Disallow lines for every toggleable page when all are disabled", () => {
    // Fresh DB: all toggleable pages disabled by default.
    const handler = getHandler("/robots.txt");
    const { res, data } = mockRes();
    handler!({}, res);
    const txt = data.body as string;
    expect(txt).toContain("Disallow: /about");
    expect(txt).toContain("Disallow: /faq");
    expect(txt).toContain("Disallow: /contact");
    expect(txt).toContain("Disallow: /game-modes");
    expect(txt).toContain("Disallow: /privacy");
    expect(txt).toContain("Disallow: /terms");
  });

  it("omits Disallow lines for pages that are enabled", () => {
    enableAllPages();
    const handler = getHandler("/robots.txt");
    const { res, data } = mockRes();
    handler!({}, res);
    const txt = data.body as string;
    expect(txt).not.toContain("Disallow: /about");
    expect(txt).not.toContain("Disallow: /game-modes");
  });
});

describe("resolvePageVisibilityMeta", () => {
  it("forces noindex for a disabled path", () => {
    const meta = resolvePageVisibilityMeta(() => db, "/about");
    expect(meta).toEqual({ noindex: true });
  });

  it("returns null for an enabled path so other resolvers can apply", () => {
    enableAllPages();
    const meta = resolvePageVisibilityMeta(() => db, "/about");
    expect(meta).toBeNull();
  });

  it("returns null for non-toggleable paths", () => {
    // Fresh DB: / isn't a toggleable path.
    const meta = resolvePageVisibilityMeta(() => db, "/");
    expect(meta).toBeNull();
  });

  it("maps URL paths to storage keys correctly (game-modes → game_modes)", () => {
    // Disabled by default — meta should force noindex.
    expect(resolvePageVisibilityMeta(() => db, "/game-modes")).toEqual({ noindex: true });
    enableAllPages();
    expect(resolvePageVisibilityMeta(() => db, "/game-modes")).toBeNull();
  });

  it("swallows DB errors and returns null", () => {
    db.close();
    expect(resolvePageVisibilityMeta(() => db, "/about")).toBeNull();
  });
});

describe("injectMeta", () => {
  const template = `<!DOCTYPE html>
<html>
  <head>
    <title>price.games</title>
    <meta name="description" content="Original description" />
    <meta property="og:title" content="price.games" />
    <meta property="og:description" content="Original description" />
    <meta property="og:url" content="https://price.games" />
    <meta property="og:site_name" content="price.games" />
    <meta property="og:image" content="https://price.games/og-image.png" />
    <meta name="twitter:title" content="price.games" />
    <meta name="twitter:description" content="Original description" />
    <meta name="twitter:image" content="https://price.games/og-image.png" />
  </head>
  <body></body>
</html>`;

  it("replaces the title and description", () => {
    const out = injectMeta(template, {
      title: "About Price Games",
      description: "Learn about us",
      canonical: "https://price.games/about",
      ogImage: "https://price.games/og-image.png",
      siteName: "Price Games",
      noindex: false,
    });
    expect(out).toContain("<title>About Price Games</title>");
    expect(out).toContain('<meta name="description" content="Learn about us" />');
    expect(out).toContain('<meta property="og:title" content="About Price Games" />');
    expect(out).toContain('<link rel="canonical" href="https://price.games/about" />');
  });

  it("matches a 7-char roomcode path as a multiplayer room, not a content page", () => {
    const { resolveSeoMeta } = require("@price-game/shared");
    const meta = resolveSeoMeta("/aB3xYZ9");
    expect(meta.title).toContain("Multiplayer Room");
    expect(meta.noindex).toBe(true);
  });

  it("uses MP_OG_DESCRIPTION for room URL meta so social unfurls show rich text", () => {
    const { resolveSeoMeta, MP_OG_DESCRIPTION } = require("@price-game/shared");
    const meta = resolveSeoMeta("/aB3xYZ9");
    expect(meta.description).toBe(MP_OG_DESCRIPTION);
  });

  it("preserves room-code casing in the title (codes are case-sensitive)", () => {
    const { resolveSeoMeta } = require("@price-game/shared");
    const meta = resolveSeoMeta("/aB3xYZ9");
    // Was previously upper-cased — that broke the visual round-trip with
    // the actual case-sensitive nanoid code shown in the lobby.
    expect(meta.title).toContain("aB3xYZ9");
  });

  it("buildMpShareText interpolates {code} and {url} placeholders", () => {
    const { buildMpShareText } = require("@price-game/shared");
    const text = buildMpShareText("ABC1234", "https://price.games/ABC1234");
    expect(text).toContain("ABC1234");
    expect(text).toContain("https://price.games/ABC1234");
    // Sanity: no leftover unfilled placeholders
    expect(text).not.toContain("{code}");
    expect(text).not.toContain("{url}");
  });

  it("resolves /play/<mode> to a mode-specific indexable title", () => {
    const { resolveSeoMeta } = require("@price-game/shared");
    const meta = resolveSeoMeta("/play/higher-lower");
    expect(meta.title).toContain("Higher or Lower");
    expect(meta.title).toContain("Price Games");
    expect(meta.noindex).toBeFalsy();
    expect(meta.sitemap).toBe(true);
  });

  it("does NOT match a 6-char path as a room — nanoid codes are exactly 7 chars", () => {
    const { resolveSeoMeta } = require("@price-game/shared");
    const meta = resolveSeoMeta("/abcdef");
    expect(meta.title).not.toContain("Multiplayer Room");
  });

  it("inserts a robots noindex tag when requested", () => {
    const out = injectMeta(template, {
      title: "Settings",
      description: "desc",
      canonical: "https://price.games/settings",
      ogImage: "https://price.games/og-image.png",
      siteName: "Price Games",
      noindex: true,
    });
    expect(out).toContain('<meta name="robots" content="noindex,nofollow" />');
  });

  it("escapes special characters in titles and descriptions", () => {
    const out = injectMeta(template, {
      title: 'Hello "Quotes" & <tags>',
      description: "Less-than: < and an ampersand: &",
      canonical: "https://price.games/?a=1&b=2",
      ogImage: "https://price.games/og-image.png",
      siteName: "Price Games",
      noindex: false,
    });
    expect(out).toContain("&quot;Quotes&quot;");
    expect(out).toContain("&lt;tags&gt;");
    // `&` must be HTML-entity-escaped or OG/Twitter parsers reject the doc.
    expect(out).toContain("ampersand: &amp;");
    expect(out).toContain("&amp;b=2");
    // And the escape must not double-escape the `&` it introduces itself.
    expect(out).not.toContain("&amp;amp;");
  });

  it("skips /admin-prefixed paths via a anchored match (no /administration false-positive)", () => {
    // Sanity check for the anchored regex in resolveSeoMeta: `/administration`
    // (not a real route) should fall through to the default, not be tagged
    // as noindex by the /admin branch.
    const { resolveSeoMeta } = require("@price-game/shared");
    const meta = resolveSeoMeta("/administration");
    expect(meta.noindex).toBeUndefined();
  });

  it("inserts tags missing from the template via the fallback branch", () => {
    // A minimal template that lacks og:title and twitter:image — exercises
    // the "tag missing — insert before </head>" path in replaceMetaByAttr.
    const bare = `<!DOCTYPE html><html><head><title>old</title></head><body></body></html>`;
    const out = injectMeta(bare, {
      title: "New",
      description: "D",
      canonical: "https://price.games/",
      ogImage: "https://price.games/og.png",
      siteName: "Price Games",
      noindex: false,
    });
    expect(out).toContain("<title>New</title>");
    expect(out).toContain('<meta name="description" content="D" />');
    expect(out).toContain('<meta property="og:title" content="New" />');
    expect(out).toContain('<meta name="twitter:image" content="https://price.games/og.png" />');
    expect(out).toContain('<link rel="canonical" href="https://price.games/" />');
  });
});

describe("resolveShareMeta", () => {
  function insertShare(id: string, fields: Partial<{
    game_mode: string;
    total_score: number;
    per_round_max: number;
    player_name: string | null;
    round_data: string;
  }> = {}) {
    // `player_name` needs `in` check so callers can explicitly pass null
    // to distinguish "no name" from "use default".
    const playerName = "player_name" in fields ? fields.player_name : "Alice";
    db.prepare(
      `INSERT INTO shared_games (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      fields.game_mode ?? "classic",
      fields.total_score ?? 4250,
      fields.per_round_max ?? 1000,
      playerName,
      fields.round_data ?? JSON.stringify([{ r: 1 }, { r: 2 }, { r: 3 }, { r: 4 }, { r: 5 }]),
      Date.now(),
    );
  }

  it("returns null for non-share paths", () => {
    expect(resolveShareMeta(() => db, "/about")).toBeNull();
    expect(resolveShareMeta(() => db, "/")).toBeNull();
  });

  it("returns null for malformed share ids", () => {
    expect(resolveShareMeta(() => db, "/s/short")).toBeNull();
    expect(resolveShareMeta(() => db, "/s/waaay_too_long_id")).toBeNull();
    expect(resolveShareMeta(() => db, "/s/bad!chars")).toBeNull();
  });

  it("returns null when the share id is not found", () => {
    const meta = resolveShareMeta(() => db, "/s/abcd1234");
    expect(meta).toBeNull();
  });

  it("returns a descriptive title and description for a stored share", () => {
    insertShare("abcd1234", {
      game_mode: "higher-lower",
      total_score: 4250,
      player_name: "Alice",
    });
    const meta = resolveShareMeta(() => db, "/s/abcd1234");
    expect(meta).not.toBeNull();
    expect(meta!.title).toContain("4,250 points in Higher or Lower");
    expect(meta!.description).toContain("Alice");
    expect(meta!.description).toContain("4,250");
    expect(meta!.description).toContain("Higher or Lower");
    // Share pages are indexable — the dynamic resolver shouldn't set noindex.
    expect(meta!.noindex).toBeUndefined();
  });

  it("falls back to 'A player' when player_name is missing", () => {
    insertShare("AaAaAaAa", { player_name: null });
    const meta = resolveShareMeta(() => db, "/s/AaAaAaAa");
    expect(meta!.description).toContain("A player scored");
  });

  it("mentions the round count when round_data is a valid array", () => {
    insertShare("rrrrrrrr", {
      round_data: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ r: i }))),
    });
    const meta = resolveShareMeta(() => db, "/s/rrrrrrrr");
    expect(meta!.description).toContain("10-round");
  });

  it("gracefully skips the N-round prefix when round_data is malformed", () => {
    insertShare("mmmmmmmm", { round_data: "not-json" });
    const meta = resolveShareMeta(() => db, "/s/mmmmmmmm");
    expect(meta).not.toBeNull();
    // "-round" would match literal "5-round" or "10-round"; regex anchors
    // to a digit before the dash to avoid matching "round-by-round".
    expect(meta!.description).not.toMatch(/\d+-round/);
  });

  it("returns null when the DB query throws", () => {
    db.close();
    expect(resolveShareMeta(() => db, "/s/abcd1234")).toBeNull();
  });
});

describe("createIndexHtmlMetaMiddleware", () => {
  let tmpDir: string;
  let indexPath: string;
  const template = `<!DOCTYPE html><html><head><title>price.games</title><meta name="description" content="orig" /></head><body></body></html>`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-mw-"));
    indexPath = path.join(tmpDir, "index.html");
    fs.writeFileSync(indexPath, template, "utf-8");
  });

  function call(method: string, url: string) {
    const mw = createIndexHtmlMetaMiddleware(indexPath);
    const req: any = { method, path: url, url };
    let sent: string | null = null;
    let nextCalled = false;
    const res: any = {
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k] = v; return this; },
      send(s: string) { sent = s; return this; },
    };
    mw(req, res, () => { nextCalled = true; });
    return { sent, nextCalled, res };
  }

  it("injects per-route meta for SPA paths", () => {
    const { sent, nextCalled } = call("GET", "/about");
    expect(nextCalled).toBe(false);
    expect(sent).not.toBeNull();
    expect(sent!).toContain("<title>About Price Games</title>");
  });

  it("passes through /api/ paths without injection", () => {
    const { sent, nextCalled } = call("GET", "/api/health");
    expect(nextCalled).toBe(true);
    expect(sent).toBeNull();
  });

  it("passes through /assets/ paths without injection", () => {
    const { sent, nextCalled } = call("GET", "/assets/main.js");
    expect(nextCalled).toBe(true);
    expect(sent).toBeNull();
  });

  it("passes through known static-asset extensions", () => {
    const { sent, nextCalled } = call("GET", "/favicon.ico");
    expect(nextCalled).toBe(true);
    expect(sent).toBeNull();
  });

  it("still injects for SPA paths that contain a dot in a non-final segment", () => {
    // A future /player/first.last route would have a dot in the middle
    // segment. The extension regex anchors to the final segment only, so
    // this should NOT be treated as a static asset.
    const { sent, nextCalled } = call("GET", "/player/first.last");
    expect(nextCalled).toBe(false);
    expect(sent).not.toBeNull();
  });

  it("passes through /robots.txt and /sitemap.xml so their handlers win", () => {
    const r1 = call("GET", "/robots.txt");
    const r2 = call("GET", "/sitemap.xml");
    expect(r1.nextCalled).toBe(true);
    expect(r2.nextCalled).toBe(true);
  });

  it("is a no-op passthrough when the template file doesn't exist", () => {
    const mw = createIndexHtmlMetaMiddleware(path.join(tmpDir, "nonexistent.html"));
    const req: any = { method: "GET", path: "/about", url: "/about" };
    let nextCalled = false;
    const res: any = { setHeader() {}, send() {} };
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("passes through non-GET requests", () => {
    const { sent, nextCalled } = call("POST", "/about");
    expect(nextCalled).toBe(true);
    expect(sent).toBeNull();
  });

  it("applies dynamic resolver overrides on top of the static meta", () => {
    const mw = createIndexHtmlMetaMiddleware(indexPath, {
      dynamicResolver: (p) =>
        p === "/s/abcd1234"
          ? { title: "Custom Share Title", description: "Custom share desc" }
          : null,
    });
    const req: any = { method: "GET", path: "/s/abcd1234", url: "/s/abcd1234" };
    let sent: string | null = null;
    const res: any = {
      setHeader() { return this; },
      send(s: string) { sent = s; return this; },
    };
    mw(req, res, () => {});
    expect(sent).not.toBeNull();
    expect(sent!).toContain("<title>Custom Share Title</title>");
    expect(sent!).toContain('<meta name="description" content="Custom share desc" />');
  });

  it("keeps static meta when the dynamic resolver returns null", () => {
    const mw = createIndexHtmlMetaMiddleware(indexPath, {
      dynamicResolver: () => null,
    });
    const req: any = { method: "GET", path: "/about", url: "/about" };
    let sent: string | null = null;
    const res: any = {
      setHeader() { return this; },
      send(s: string) { sent = s; return this; },
    };
    mw(req, res, () => {});
    expect(sent!).toContain("<title>About Price Games</title>");
  });
});
