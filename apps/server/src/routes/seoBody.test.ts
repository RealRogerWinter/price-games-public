/**
 * Tests for `renderSeoBody` — the per-route static body injector that
 * gives non-JS crawlers real content inside the SPA shell. Verifies per-
 * route HTML shape, that dynamic DB-backed routes render stored copy, and
 * that unknown/noindex routes emit an empty string.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { renderSeoBody } from "./seoBody";
import { injectSeoBody } from "./seo";
import { setSiteContent, setEnabledPages } from "../services/siteSettings";

let db: DatabaseType;

/** Fresh DB defaults every SEO-toggleable page to disabled. Tests that
 *  assert rich body content need the page flipped on first. */
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

beforeEach(() => {
  db = createTestDb();
});

describe("renderSeoBody — home", () => {
  it("renders an h1 with the target keyword and the lead paragraph", () => {
    const html = renderSeoBody("/", db);
    expect(html).toContain("<h1>");
    expect(html).toContain("Price Games");
    expect(html).toContain("Play the free price guessing game");
  });

  it("includes a link to every single-player mode under /play/<slug>", () => {
    const html = renderSeoBody("/", db);
    expect(html).toContain('href="/play/classic"');
    expect(html).toContain('href="/play/higher-lower"');
    expect(html).toContain('href="/play/chain-reaction"');
    // Bidding is multiplayer-only — no SP landing page.
    expect(html).not.toContain('href="/play/bidding"');
  });

  it("includes internal nav links to FAQ, About, Leaderboard, Multiplayer", () => {
    const html = renderSeoBody("/", db);
    expect(html).toContain('href="/faq"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/leaderboard"');
    expect(html).toContain('href="/mp"');
  });
});

describe("renderSeoBody — /play/<mode>", () => {
  it("renders the mode name in h1 and includes rules + strategy", () => {
    const html = renderSeoBody("/play/higher-lower", db);
    expect(html).toContain("<h1>Play Higher or Lower");
    expect(html).toContain("How to play");
    expect(html).toContain("Strategy tip");
    // Copy comes from MODE_DETAILS in shared.
    expect(html).toContain("shelf archetype");
  });

  it("returns empty body for a bidding slug (multiplayer-only)", () => {
    // Emitting the generic home body here would duplicate-index a
    // non-canonical URL, so the SP-only template short-circuits to "".
    expect(renderSeoBody("/play/bidding", db)).toBe("");
  });

  it("returns empty body for an unknown slug", () => {
    expect(renderSeoBody("/play/not-a-real-mode", db)).toBe("");
  });
});

describe("renderSeoBody — /game-modes", () => {
  beforeEach(() => enableAllPages());

  it("renders the full mode catalog with per-mode rules", () => {
    const html = renderSeoBody("/game-modes", db);
    expect(html).toContain("<h1>Game Modes");
    expect(html).toContain("Precision");
    expect(html).toContain("Higher or Lower");
    expect(html).toContain("Bidding War");
    expect(html).toContain("How to play");
    expect(html).toContain("Strategy tip");
  });

  it("points each mode at its canonical URL (/play/<slug> or /mp)", () => {
    const html = renderSeoBody("/game-modes", db);
    expect(html).toContain('href="/play/classic"');
    expect(html).toContain('href="/play/price-match"');
    // Bidding (multiplayer-only) links to /mp, not /play/bidding.
    expect(html).toContain('href="/mp"');
    expect(html).not.toContain('href="/play/bidding"');
  });
});

describe("renderSeoBody — /faq", () => {
  beforeEach(() => enableAllPages());

  it("renders the default FAQ when no admin override is stored", () => {
    const html = renderSeoBody("/faq", db);
    expect(html).toContain("<h1>Frequently Asked Questions");
    expect(html).toContain("Is Price Games free?");
  });

  it("renders admin-edited FAQ items verbatim", () => {
    setSiteContent(db, "faq", {
      key: "faq",
      title: "Our FAQ",
      items: [{ question: "Custom Q?", answer: "Custom A." }],
    });
    const html = renderSeoBody("/faq", db);
    expect(html).toContain("<h1>Our FAQ");
    expect(html).toContain("Custom Q?");
    expect(html).toContain("Custom A.");
  });

  it("escapes HTML in admin-edited FAQ content", () => {
    setSiteContent(db, "faq", {
      key: "faq",
      title: "FAQ",
      items: [{ question: "<script>x</script>", answer: "<b>bold</b>" }],
    });
    const html = renderSeoBody("/faq", db);
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderSeoBody — /about and /contact", () => {
  beforeEach(() => enableAllPages());

  it("renders About body as escaped paragraphs", () => {
    setSiteContent(db, "about", {
      key: "about",
      title: "About Us",
      body: "First paragraph.\n\nSecond paragraph.",
    });
    const html = renderSeoBody("/about", db);
    expect(html).toContain("<h1>About Us");
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("renders Contact email and social links", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Reach Us",
      body: "We love mail.",
      email: "hi@example.com",
      social: [{ label: "Twitter", url: "https://twitter.com/x" }],
    });
    const html = renderSeoBody("/contact", db);
    expect(html).toContain("<h1>Reach Us");
    expect(html).toContain("mailto:hi@example.com");
    expect(html).toContain("https://twitter.com/x");
    expect(html).toContain("Twitter");
  });
});

describe("renderSeoBody — admin page visibility gate", () => {
  // Fresh DB defaults every toggleable page to disabled — no setup needed.

  it("emits empty body for /about when the page is disabled", () => {
    expect(renderSeoBody("/about", db)).toBe("");
  });

  it("emits empty body for /faq when the page is disabled", () => {
    expect(renderSeoBody("/faq", db)).toBe("");
  });

  it("emits empty body for /contact when the page is disabled", () => {
    expect(renderSeoBody("/contact", db)).toBe("");
  });

  it("emits empty body for /game-modes when the page is disabled", () => {
    expect(renderSeoBody("/game-modes", db)).toBe("");
  });

  it("emits empty body for /privacy and /terms when disabled", () => {
    expect(renderSeoBody("/privacy", db)).toBe("");
    expect(renderSeoBody("/terms", db)).toBe("");
  });

  it("renders content for /about once the admin enables the page", () => {
    enableAllPages();
    const html = renderSeoBody("/about", db);
    expect(html).toContain("<h1>");
  });
});

describe("renderSeoBody — other routes", () => {
  it("returns a generic h1+description for static registry routes like /leaderboard", () => {
    const html = renderSeoBody("/leaderboard", db);
    expect(html).toContain("<h1>");
    expect(html).toContain("Leaderboard");
  });

  it("returns empty string for noindex registry routes like /settings", () => {
    expect(renderSeoBody("/settings", db)).toBe("");
  });

  it("returns empty string for dynamic routes (share, room, player)", () => {
    expect(renderSeoBody("/s/abcd1234", db)).toBe("");
    expect(renderSeoBody("/aB3xYZ9", db)).toBe("");
    expect(renderSeoBody("/player/somebody", db)).toBe("");
  });
});

describe("injectSeoBody (middleware helper)", () => {
  it("replaces the empty #root div with one that wraps the body", () => {
    const shell = `<html><body><div id="root"></div></body></html>`;
    const out = injectSeoBody(shell, "<section>hi</section>");
    expect(out).toContain(`<div id="root"><section>hi</section></div>`);
  });

  it("returns the template unchanged if the root marker is missing", () => {
    const shell = `<html><body><main>no root</main></body></html>`;
    const out = injectSeoBody(shell, "<section>hi</section>");
    expect(out).toBe(shell);
  });
});
