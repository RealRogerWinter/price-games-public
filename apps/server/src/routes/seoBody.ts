/**
 * Per-route static body content injected into the SPA shell before React
 * hydrates. Crawlers that don't execute JavaScript (most AI search bots,
 * older indexers, link-preview fetchers) read this content directly from
 * the HTML response. Real users see it for only a few hundred milliseconds
 * before `ReactDOM.createRoot(...).render(...)` replaces it with the live
 * app — the replacement is unconditional, so there's no risk of the static
 * content being styled as a hydration mismatch.
 *
 * Kept tiny on purpose: this file renders plain HTML strings with escaped
 * text content and a handful of anchor tags. No templating engine, no
 * markdown parser on the main path — the input data is either hard-coded
 * in `@price-game/shared` or admin-edited text where we emit paragraphs
 * after escaping. Anything more complex would expand the attack surface
 * (XSS via admin input) and add a dependency the server does not need.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  GAME_MODES,
  MODE_DETAILS,
  MULTIPLAYER_ONLY_MODES,
  SEO_ROUTES,
  SEO_GAME_MODE_ROUTES,
  resolveSeoMeta,
  type GameMode,
} from "@price-game/shared";
import {
  getSiteContent,
  isPageEnabled,
  type AboutContent,
  type ContactContent,
  type FaqContent,
} from "../services/siteSettings";
import { PATH_TO_PAGE_KEY } from "./seo";

/** HTML text-content and attribute-value escape. Covers all five XML
 *  entity characters — including the apostrophe, which our current
 *  templates don't rely on (every href/attr uses double quotes) but we
 *  escape anyway so a future single-quoted attribute doesn't silently
 *  reintroduce XSS. */
function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render plain-text markdown-ish content as escaped `<p>` paragraphs.
 *  Splits on blank lines. Does NOT attempt to render bold/links/headings —
 *  this is SEO plaintext, not a markdown renderer. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${h(p)}</p>`)
    .join("\n");
}

/** Full list of single-player `/play/<slug>` URLs, used for internal
 *  link blocks that give crawlers a path to every mode landing page. */
const SP_MODES = GAME_MODES.filter((m) => !MULTIPLAYER_ONLY_MODES.has(m.mode));

function modeListHtml(): string {
  return `<ul class="seo-mode-list">\n${SP_MODES.map(
    (m) => `  <li><a href="/play/${h(m.mode)}">${h(m.name)}</a> — ${h(m.description)}</li>`,
  ).join("\n")}\n</ul>`;
}

function siteNavHtml(): string {
  return `<nav class="seo-nav" aria-label="Site"><ul>
  <li><a href="/">Home</a></li>
  <li><a href="/game-modes">Game Modes</a></li>
  <li><a href="/faq">FAQ</a></li>
  <li><a href="/about">About</a></li>
  <li><a href="/leaderboard">Leaderboard</a></li>
  <li><a href="/mp">Multiplayer</a></li>
</ul></nav>`;
}

/** Home page body. */
function homeBody(): string {
  return `<section class="seo-body seo-home">
  <h1>Price Games — Play the free price guessing game. Guess real product prices.</h1>
  <p>Price Games is a free online price-guessing game. Look at a real product, guess what it costs, and see how close you got. Multiple single-player modes plus live multiplayer rooms — no signup required, no downloads, playable in any browser.</p>
  <h2>Pick a mode</h2>
  ${modeListHtml()}
  <p>Looking for a multiplayer room? <a href="/mp">Create or join a live game</a>, or try the <a href="/play/classic">daily Precision challenge</a>. New to the game? Read the <a href="/faq">FAQ</a> or browse <a href="/game-modes">all game modes</a>.</p>
  ${siteNavHtml()}
</section>`;
}

/** `/play/<mode>` landing body. Returns null for an unknown mode slug so
 *  the caller falls back to the generic body. */
function playModeBody(modeSlug: string): string | null {
  const mode = GAME_MODES.find((m) => m.mode === modeSlug);
  if (!mode) return null;
  if (MULTIPLAYER_ONLY_MODES.has(mode.mode as GameMode)) return null;
  const detail = MODE_DETAILS[mode.mode as GameMode];
  return `<section class="seo-body seo-play-mode">
  <h1>Play ${h(mode.name)} — Price Games</h1>
  <p>${h(mode.description)}</p>
  <h2>How to play</h2>
  <p>${h(detail.rules)}</p>
  <h2>Strategy tip</h2>
  <p>${h(detail.strategy)}</p>
  <p><a href="/play/${h(mode.mode)}">Play ${h(mode.name)} now</a> — free, no signup needed. Or browse <a href="/game-modes">all Price Games modes</a>.</p>
  ${siteNavHtml()}
</section>`;
}

/** `/game-modes` body — full catalog for crawlers. */
function gameModesBody(): string {
  const items = GAME_MODES.map((m) => {
    const detail = MODE_DETAILS[m.mode];
    const mpOnly = MULTIPLAYER_ONLY_MODES.has(m.mode);
    const href = mpOnly ? "/mp" : `/play/${h(m.mode)}`;
    const badge = mpOnly ? " (multiplayer)" : "";
    return `  <li>
    <h2><a href="${href}">${h(m.name)}</a>${h(badge)}</h2>
    <p>${h(m.description)}</p>
    <p><strong>How to play:</strong> ${h(detail.rules)}</p>
    <p><strong>Strategy tip:</strong> ${h(detail.strategy)}</p>
  </li>`;
  }).join("\n");
  return `<section class="seo-body seo-game-modes">
  <h1>Game Modes — Price Games</h1>
  <p>Price Games offers many ways to test your pricing instincts — solo, against bots, or live against friends in multiplayer rooms. Every mode is free, with no signup required.</p>
  <ul class="seo-mode-details">
${items}
  </ul>
  ${siteNavHtml()}
</section>`;
}

/** `/faq` body — renders the DB-backed FAQ items. */
function faqBody(db: DatabaseType): string {
  const faq = getSiteContent(db, "faq") as FaqContent;
  const items = (faq.items ?? [])
    .map((q) => `  <li><h3>${h(q.question)}</h3><p>${h(q.answer)}</p></li>`)
    .join("\n");
  return `<section class="seo-body seo-faq">
  <h1>${h(faq.title)}</h1>
  <ul class="seo-faq-items">
${items}
  </ul>
  ${siteNavHtml()}
</section>`;
}

/** `/about` body — renders the DB-backed About markdown as escaped paragraphs. */
function aboutBody(db: DatabaseType): string {
  const about = getSiteContent(db, "about") as AboutContent;
  return `<section class="seo-body seo-about">
  <h1>${h(about.title)}</h1>
  ${paragraphs(about.body ?? "")}
  ${siteNavHtml()}
</section>`;
}

/** `/contact` body — renders the DB-backed Contact markdown + links. */
function contactBody(db: DatabaseType): string {
  const contact = getSiteContent(db, "contact") as ContactContent;
  const emailLine =
    contact.email && contact.email.length > 0
      ? `<p>Email: <a href="mailto:${h(contact.email)}">${h(contact.email)}</a></p>`
      : "";
  const socialLines =
    contact.social && contact.social.length > 0
      ? `<ul class="seo-contact-social">${contact.social
          .map((s) => `<li><a href="${h(s.url)}" rel="noopener noreferrer">${h(s.label)}</a></li>`)
          .join("")}</ul>`
      : "";
  return `<section class="seo-body seo-contact">
  <h1>${h(contact.title)}</h1>
  ${paragraphs(contact.body ?? "")}
  ${emailLine}
  ${socialLines}
  ${siteNavHtml()}
</section>`;
}

/** Generic fallback body — h1 + description from the static SEO registry.
 *  Used for routes that have registry metadata but no custom template. */
function genericBody(pathname: string): string {
  const meta = resolveSeoMeta(pathname);
  return `<section class="seo-body seo-generic">
  <h1>${h(meta.title)}</h1>
  <p>${h(meta.description)}</p>
  ${siteNavHtml()}
</section>`;
}

/**
 * Return the HTML string to inject inside `<div id="root">…</div>` for the
 * given pathname. Returns an empty string for routes where injecting
 * static content provides no SEO value (admin, auth pages, dynamic
 * share/room routes) so we don't add noise to the shell response.
 *
 * @param pathname - Request pathname (no query string).
 * @param db - SQLite database for reading admin-edited About/FAQ/Contact.
 */
export function renderSeoBody(pathname: string, db: DatabaseType): string {
  // Admin-disabled SEO pages (about/faq/contact/game_modes/privacy/terms)
  // must NOT expose their body content to crawlers: `resolvePageVisibilityMeta`
  // already forces `noindex`, but shipping rich body copy on a `noindex`
  // page weakens the suppression signal and lets JS-less crawlers index
  // whatever the admin chose to hide. Short-circuit before any template
  // runs so disabled pages get a truly empty shell.
  const pageKey = PATH_TO_PAGE_KEY[pathname];
  if (pageKey && !isPageEnabled(db, pageKey)) return "";

  // Home.
  if (pathname === "/") return homeBody();

  // Per-mode landing page: `/play/<slug>`. Unknown slugs return `""`
  // rather than the home-meta generic body — the server still responds
  // HTTP 200 (SPA catchall), but emitting content here would duplicate
  // the home page under a non-canonical URL. Let the client render its
  // in-app 404 and give crawlers nothing to index.
  if (pathname.startsWith("/play/")) {
    const slug = pathname.slice("/play/".length);
    return playModeBody(slug) ?? "";
  }

  // Admin-editable public content pages — render the stored copy so
  // crawlers see the real page without running JS. We reach this branch
  // only after the visibility check above, so the page is enabled.
  if (pathname === "/game-modes") return gameModesBody();
  if (pathname === "/faq") {
    try {
      return faqBody(db);
    } catch {
      return genericBody(pathname);
    }
  }
  if (pathname === "/about") {
    try {
      return aboutBody(db);
    } catch {
      return genericBody(pathname);
    }
  }
  if (pathname === "/contact") {
    try {
      return contactBody(db);
    } catch {
      return genericBody(pathname);
    }
  }

  // Other statically-registered routes — emit the generic h1 + description
  // so crawlers still get something meaningful rather than an empty shell.
  if (pathname in SEO_ROUTES || pathname in SEO_GAME_MODE_ROUTES) {
    const meta = resolveSeoMeta(pathname);
    // Suppress for noindex pages to keep the shell small on low-value routes.
    if (meta.noindex) return "";
    return genericBody(pathname);
  }

  // Dynamic routes (/player/:u, /s/:id, /r/:c, /:roomCode, /recap/:id, /admin/*)
  // and unknown paths: emit nothing. The client will hydrate and render the
  // real page; crawlers rarely care about these.
  return "";
}
