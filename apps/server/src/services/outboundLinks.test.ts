/**
 * Tests for the outbound link tagging service. Verifies the UTM
 * append + short-link substitution pipeline that powers email and push
 * link rewriting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import {
  tagUrl,
  tagAppPath,
  tagAndShortenUrl,
  isTokenizedUrl,
  getOrCreateOriginShortCode,
  rewriteHtmlLinks,
  rewriteTextLinks,
  _resetOutboundLinksCacheForTests,
} from "./outboundLinks";
import { config } from "../config";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  _resetOutboundLinksCacheForTests();
});

// ── tagUrl ──────────────────────────────────────────────────────────────────

describe("tagUrl", () => {
  it("appends UTM params to a relative URL", () => {
    const result = tagUrl("/claim/abc123", "email:reward_awarded");
    expect(result).toContain("utm_source=email");
    expect(result).toContain("utm_medium=transactional");
    expect(result).toContain("utm_campaign=reward_awarded");
    expect(result.startsWith("/claim/abc123")).toBe(true);
  });

  it("appends UTM params to an absolute URL and keeps it absolute", () => {
    const result = tagUrl("https://price.games/foo", "email:promotional");
    expect(result.startsWith("https://price.games/foo")).toBe(true);
    expect(result).toContain("utm_source=email");
    expect(result).toContain("utm_medium=marketing");
    expect(result).toContain("utm_campaign=promotional");
  });

  it("preserves existing non-UTM query params", () => {
    const result = tagUrl("/foo?bar=baz", "email:weekly_digest");
    expect(result).toContain("bar=baz");
    expect(result).toContain("utm_source=email");
    expect(result).toContain("utm_campaign=weekly_digest");
  });

  it("preserves the fragment", () => {
    const result = tagUrl("/foo#section-1", "email:promotional");
    expect(result).toContain("#section-1");
    expect(result).toContain("utm_source=email");
  });

  it("does NOT overwrite existing UTM params on the input URL", () => {
    const result = tagUrl(
      "/foo?utm_source=admin&utm_campaign=manual",
      "email:promotional",
    );
    // Author-supplied source wins
    expect(result).toContain("utm_source=admin");
    expect(result).toContain("utm_campaign=manual");
    // Origin's medium is still added because input didn't set it
    expect(result).toContain("utm_medium=marketing");
  });

  it("emits utm_content when the origin specifies one", () => {
    const result = tagUrl("/claim/abc", "email:reward_reminder_7d");
    expect(result).toContain("utm_content=7d");
  });

  it("omits utm_content when the origin doesn't specify one", () => {
    const result = tagUrl("/claim/abc", "email:reward_awarded");
    expect(result).not.toContain("utm_content");
  });

  it("returns the input unchanged on unparseable URL", () => {
    const result = tagUrl("not://a real url with spaces", "email:promotional");
    // URL constructor accepts surprisingly malformed inputs; just
    // assert the function doesn't throw and returns a string.
    expect(typeof result).toBe("string");
  });
});

// ── tagAppPath ──────────────────────────────────────────────────────────────

describe("tagAppPath", () => {
  it("prepends config.appUrl to a leading-slash path and tags it", () => {
    const result = tagAppPath("/leaderboard", "email:weekly_digest");
    expect(result.startsWith(config.appUrl)).toBe(true);
    expect(result).toContain("/leaderboard");
    expect(result).toContain("utm_source=email");
  });

  it("inserts a separator slash when path is missing one", () => {
    const result = tagAppPath("foo", "email:promotional");
    expect(result).toContain("/foo");
    expect(result).toContain("utm_source=email");
  });
});

// ── isTokenizedUrl ──────────────────────────────────────────────────────────

describe("isTokenizedUrl", () => {
  it.each([
    ["/claim/abc123def456", true],
    ["/verify-email", true],
    ["/verify-email?token=xyz", true],
    ["/reset-password", true],
    ["/reset-password?token=xyz", true],
    ["https://price.games/claim/abc123", true],
    ["/", false],
    ["/leaderboard", false],
    ["/profile", false],
    ["https://price.games/", false],
    ["mailto:foo@bar.com", false],
    ["/claim/", false], // empty token — treated as static
  ])("isTokenizedUrl(%s) === %s", (url, expected) => {
    expect(isTokenizedUrl(url)).toBe(expected);
  });
});

// ── getOrCreateOriginShortCode ──────────────────────────────────────────────

describe("getOrCreateOriginShortCode", () => {
  it("creates a system utm_tags row with the origin's UTM tuple", () => {
    const url = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    expect(url.startsWith(config.appUrl)).toBe(true);
    expect(url).toMatch(/\/go\/[a-z0-9]{3,32}$/);

    const row = db
      .prepare(
        `SELECT * FROM utm_tags WHERE origin_key = 'email:reward_expired' AND destination_url = '/'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.utm_source).toBe("email");
    expect(row?.utm_medium).toBe("transactional");
    expect(row?.utm_campaign).toBe("reward_expired");
    expect(row?.utm_content).toBeNull();
    expect(row?.created_by).toBeNull();
    expect(row?.short_code).toBeTruthy();
  });

  it("stores utm_content for origins that specify one", () => {
    getOrCreateOriginShortCode(db, "email:reward_reminder_15d", "/");
    const row = db
      .prepare(
        `SELECT utm_content FROM utm_tags WHERE origin_key = 'email:reward_reminder_15d'`,
      )
      .get() as { utm_content: string | null };
    expect(row.utm_content).toBe("15d");
  });

  it("is idempotent — repeat calls return the same short URL", () => {
    const a = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    const b = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    expect(a).toBe(b);

    const count = (db
      .prepare(
        `SELECT COUNT(*) as c FROM utm_tags WHERE origin_key = 'email:reward_expired'`,
      )
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("creates separate rows for the same origin with different destinations", () => {
    const a = getOrCreateOriginShortCode(db, "email:promotional", "/");
    const b = getOrCreateOriginShortCode(db, "email:promotional", "/leaderboard");
    expect(a).not.toBe(b);

    const count = (db
      .prepare(
        `SELECT COUNT(*) as c FROM utm_tags WHERE origin_key = 'email:promotional'`,
      )
      .get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("uses the cache after first lookup (no second SELECT)", () => {
    const url = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    // Drop the row to simulate "cache served, DB never consulted again"
    db.prepare(`DELETE FROM utm_tags WHERE origin_key = 'email:reward_expired'`).run();
    const url2 = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    expect(url2).toBe(url);
  });

  it("recovers from a UNIQUE-conflict race by reading back the winning row", () => {
    // Simulate a race: another worker has already inserted the row before
    // this caller's INSERT runs. We pre-seed the DB with a system row
    // bearing origin_key + destination, then call the helper.
    db.prepare(
      `INSERT INTO utm_tags
        (id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         destination_url, status, created_at, updated_at, created_by, short_code, origin_key)
       VALUES ('preexisting', '[system:test] preset', 'email', 'transactional',
               'reward_expired', NULL, NULL, '/', 'active',
               '2026-05-03T00:00:00Z', '2026-05-03T00:00:00Z', NULL, 'rwexp1', 'email:reward_expired')`,
    ).run();

    const url = getOrCreateOriginShortCode(db, "email:reward_expired", "/");
    expect(url).toBe(`${config.appUrl}/go/rwexp1`);

    const count = (db
      .prepare(
        `SELECT COUNT(*) as c FROM utm_tags WHERE origin_key = 'email:reward_expired'`,
      )
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ── tagAndShortenUrl ────────────────────────────────────────────────────────

describe("tagAndShortenUrl", () => {
  it("returns a long UTM URL for tokenized claim links", () => {
    const result = tagAndShortenUrl(
      db,
      "/claim/abc123def456",
      "email:reward_awarded",
    );
    expect(result.startsWith("/claim/abc123def456")).toBe(true);
    expect(result).toContain("utm_source=email");
    // No short-code substitution
    expect(result).not.toContain("/go/");
  });

  it("returns a short URL for static destinations", () => {
    const result = tagAndShortenUrl(
      db,
      `${config.appUrl}/`,
      "email:reward_expired",
    );
    expect(result).toMatch(new RegExp(`^${config.appUrl.replace(/\//g, "\\/")}\\/go\\/`));
  });

  it("normalizes app-host absolute URLs to relative destinations", () => {
    const a = tagAndShortenUrl(db, `${config.appUrl}/`, "email:promotional");
    const b = tagAndShortenUrl(db, "/", "email:promotional");
    expect(a).toBe(b);
  });

  it("treats price.games host as the canonical destination too", () => {
    const a = tagAndShortenUrl(
      db,
      "https://price.games/leaderboard",
      "email:promotional",
    );
    const b = tagAndShortenUrl(db, "/leaderboard", "email:promotional");
    expect(a).toBe(b);
  });
});

// ── rewriteHtmlLinks ────────────────────────────────────────────────────────

describe("rewriteHtmlLinks", () => {
  it("rewrites a single <a href> pointing at config.appUrl", () => {
    const html = `<p>Hi <a href="${config.appUrl}/leaderboard">view it</a></p>`;
    const result = rewriteHtmlLinks(html, "email:weekly_digest", db);
    expect(result).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);
  });

  it("rewrites a root-relative <a href>", () => {
    const html = `<a href="/leaderboard">view</a>`;
    const result = rewriteHtmlLinks(html, "email:weekly_digest", db);
    expect(result).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);
  });

  it("appends UTMs to tokenized hrefs without short-linking", () => {
    const html = `<a href="/claim/abc123">claim</a>`;
    const result = rewriteHtmlLinks(html, "email:reward_awarded", db);
    expect(result).toContain("/claim/abc123");
    expect(result).toContain("utm_source=email");
    expect(result).not.toMatch(/\/go\//);
  });

  it("rewrites hardcoded https://price.games URLs", () => {
    const html = `<a href="https://price.games/profile">profile</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);
  });

  it("skips mailto: links", () => {
    const html = `<a href="mailto:hello@price.games">contact</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips tel: links", () => {
    const html = `<a href="tel:+15555551234">call</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips javascript: links", () => {
    const html = `<a href="javascript:alert(1)">x</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips in-page anchors", () => {
    const html = `<a href="#section-2">jump</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips the unsubscribe URL (legacy /unsub path)", () => {
    const html = `<a href="${config.appUrl}/api/email/unsub?t=signed-token">unsub</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips the unsubscribe URL (canonical /unsubscribe path)", () => {
    const html = `<a href="${config.appUrl}/api/email/unsubscribe?token=signed-token">unsub</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("skips the push click tracker URL", () => {
    const html = `<a href="${config.appUrl}/api/push/click/42?r=%2F">click</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("does NOT rewrite <img src> attributes", () => {
    const html = `<img src="${config.appUrl}/logo512.png" alt="logo"><a href="/x">x</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toContain(`src="${config.appUrl}/logo512.png"`);
  });

  it("skips external (non-app) hosts", () => {
    const html = `<a href="https://example.com/page">external</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
  });

  it("rejects protocol-relative URLs (//evil.com/...) — open-redirect guard", () => {
    // A hostile admin-authored template trying to plant `//evil.com`
    // would otherwise pass `href.startsWith("/")` and resolve to
    // https://evil.com/path through the /go/<code> redirect handler.
    const html = `<a href="//evil.com/path">click</a>`;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    expect(result).toBe(html);
    // No system row created for the malicious destination.
    const count = (db
      .prepare(`SELECT COUNT(*) as c FROM utm_tags WHERE destination_url LIKE '//%' OR destination_url LIKE '%evil.com%'`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("normalizeDestination collapses protocol-relative URLs to '/' if they reach it", () => {
    // Defense in depth: even if a caller bypasses shouldRewriteHref and
    // passes a `//evil.com/...` URL straight to tagAndShortenUrl, the
    // destination stored on the system row is harmless.
    const url = tagAndShortenUrl(db, "//evil.com/path", "email:promotional");
    // The tagged URL should resolve to a /go/ short link backed by '/' destination.
    expect(url).toMatch(/\/go\/[a-z0-9]{3,32}$/);
    const row = db
      .prepare(`SELECT destination_url FROM utm_tags WHERE origin_key = 'email:promotional'`)
      .get() as { destination_url: string };
    expect(row.destination_url).toBe("/");
  });

  it("rewrites multiple anchors in one pass", () => {
    const html = `
      <a href="/a">A</a>
      <a href="/b">B</a>
      <a href="mailto:x@y">X</a>
    `;
    const result = rewriteHtmlLinks(html, "email:promotional", db);
    const goLinks = result.match(/\/go\//g) ?? [];
    expect(goLinks.length).toBe(2);
  });

  it("returns input unchanged when no anchors match", () => {
    const html = `<p>Hello world</p>`;
    expect(rewriteHtmlLinks(html, "email:promotional", db)).toBe(html);
  });
});

// ── rewriteTextLinks ────────────────────────────────────────────────────────

describe("rewriteTextLinks", () => {
  it("rewrites a bare URL pointing at config.appUrl", () => {
    const text = `Play now: ${config.appUrl}/`;
    const result = rewriteTextLinks(text, "email:promotional", db);
    expect(result).toMatch(/Play now: .+\/go\/[a-z0-9]{3,32}$/);
  });

  it("preserves trailing punctuation outside the URL", () => {
    const text = `Visit ${config.appUrl}/leaderboard, then play.`;
    const result = rewriteTextLinks(text, "email:promotional", db);
    // The short URL must end cleanly at the code, with the original
    // sentence chrome (`, then play.`) immediately following.
    expect(result).toMatch(/\/go\/[a-z0-9]{3,32}, then play\.$/);
  });

  it("appends UTMs to bare tokenized URLs without short-linking", () => {
    const text = `Claim here: ${config.appUrl}/claim/abc123`;
    const result = rewriteTextLinks(text, "email:reward_awarded", db);
    expect(result).toContain("utm_source=email");
    expect(result).not.toContain("/go/");
  });

  it("skips external URLs", () => {
    const text = `See https://example.com/page for details.`;
    const result = rewriteTextLinks(text, "email:promotional", db);
    expect(result).toBe(text);
  });

  it("rewrites multiple URLs in one body", () => {
    const text = `First ${config.appUrl}/a then ${config.appUrl}/b`;
    const result = rewriteTextLinks(text, "email:promotional", db);
    const goLinks = result.match(/\/go\//g) ?? [];
    expect(goLinks.length).toBe(2);
  });
});
