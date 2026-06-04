/**
 * SEO metadata registry — shared between the server (which injects meta tags
 * into index.html responses so bots see correct metadata without executing
 * JS) and the web client (which uses it as fallback/default in the <SEO>
 * component when a page doesn't declare its own override).
 *
 * Keep titles ≤60 chars and descriptions ≤160 chars for best search snippet
 * rendering. All titles are automatically suffixed with " | Price Games" by
 * the resolver unless the title already contains "Price Games".
 */

import { MP_OG_DESCRIPTION } from "./constants.js";

/** Canonical production origin — used to build absolute canonical / og:url values. */
export const SITE_ORIGIN = "https://price.games";

/** Name of the site, used in OG/twitter site_name and title suffixes. */
export const SITE_NAME = "Price Games";

/** Default OG image URL (absolute). Served from the web public root. */
export const SITE_OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;

export interface SeoMeta {
  /** Full title, already formatted (no auto-suffix applied). */
  title: string;
  /** Meta description. */
  description: string;
  /** When true, emit <meta name="robots" content="noindex"> on the page. */
  noindex?: boolean;
  /** When true, this entry should be included in sitemap.xml. Default false. */
  sitemap?: boolean;
  /** Sitemap changefreq hint. */
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  /** Sitemap priority (0.0–1.0). */
  priority?: number;
}

const HOME_DESC = "Play Price Games — the free multiplayer price-guessing game. Daily challenge, real-time rooms, multiple modes. Guess the price of real products.";

/**
 * Static route → meta table. Dynamic routes (e.g. /player/:username) are
 * resolved by `resolveSeoMeta` with parameter interpolation.
 */
export const SEO_ROUTES: Record<string, SeoMeta> = {
  "/": {
    title: "Price Games — Guess the Price of Real Products",
    description: HOME_DESC,
    sitemap: true,
    changefreq: "daily",
    priority: 1.0,
  },
  "/about": {
    title: "About Price Games",
    description: "Learn about Price Games — the free price-guessing game with multiple modes, daily challenges, and live multiplayer rooms.",
    sitemap: true,
    changefreq: "monthly",
    priority: 0.7,
  },
  "/faq": {
    title: "Price Games FAQ — How to Play, Scoring, Accounts",
    description: "Frequently asked questions about Price Games: how rounds work, how scoring is calculated, multiplayer, daily challenge, accounts, and more.",
    sitemap: true,
    changefreq: "monthly",
    priority: 0.7,
  },
  "/contact": {
    title: "Contact Price Games",
    description: "Contact the Price Games team — press inquiries, bug reports, partnerships, and player support.",
    sitemap: true,
    changefreq: "yearly",
    priority: 0.5,
  },
  "/game-modes": {
    title: "Game Modes — Price Games",
    description: "Detailed rules, strategy tips, and scoring for every Price Games mode: Precision, Higher or Lower, Comparison, Underbid, Price Match, and more.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.9,
  },
  "/privacy": {
    title: "Privacy Policy — Price Games",
    description: "How Price Games collects, uses, and protects your data.",
    sitemap: true,
    changefreq: "yearly",
    priority: 0.3,
  },
  "/terms": {
    title: "Terms of Service — Price Games",
    description: "The terms that govern your use of Price Games.",
    sitemap: true,
    changefreq: "yearly",
    priority: 0.3,
  },
  "/scoreboard": {
    title: "Scoreboard — Price Games",
    description: "Your Price Games scoreboard: recent games, best scores, and monthly points.",
    sitemap: true,
    changefreq: "daily",
    priority: 0.5,
  },
  "/leaderboard": {
    title: "Leaderboard — Price Games",
    description: "See the top Price Games players this week, this month, and all time.",
    sitemap: true,
    changefreq: "hourly",
    priority: 0.8,
  },
  "/settings": {
    title: "Account Settings — Price Games",
    description: "Manage your Price Games account, notifications, and profile.",
    noindex: true,
  },
  "/profile": {
    title: "Profile — Price Games",
    description: "Your Price Games profile.",
    noindex: true,
  },
  "/mp": {
    title: "Multiplayer Lobby — Price Games",
    description: "Create or join a Price Games multiplayer room — play price-guessing games live with friends.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.6,
  },
  "/verify-email": { title: "Verify Email — Price Games", description: "Verify your Price Games email address.", noindex: true },
  "/forgot-password": { title: "Reset Password — Price Games", description: "Reset your Price Games password.", noindex: true },
  "/reset-password": { title: "Reset Password — Price Games", description: "Reset your Price Games password.", noindex: true },
  "/giveaway": { title: "Giveaway — Price Games", description: "Price Games monthly giveaway details.", noindex: true },
};

/**
 * Per-game-mode SEO metadata. Each single-player mode has a dedicated
 * `/play/<slug>` landing page so crawlers can index mode-specific long-tail
 * keywords (e.g. "price match game", "higher or lower pricing game").
 * The route is handled by the SPA router, which starts the mode on mount.
 * Bidding is multiplayer-only so it has no single-player landing page
 * (`/mp` remains the multiplayer entry point).
 */
export const SEO_GAME_MODE_ROUTES: Record<string, SeoMeta> = {
  "/play/classic": {
    title: "Precision — Guess the Exact Price | Price Games",
    description: "Play Precision on Price Games — guess the exact price of real products and rack up points for pinpoint accuracy. Free to play, no signup needed.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/higher-lower": {
    title: "Higher or Lower — Price Guessing Game | Price Games",
    description: "Play Higher or Lower on Price Games — is the real price higher or lower than shown? Fast-paced free price-guessing rounds.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/comparison": {
    title: "Comparison — Which Product Costs More? | Price Games",
    description: "Play Comparison on Price Games — pick which product is pricier (or cheaper). A free head-to-head price-guessing game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/closest-without-going-over": {
    title: "Underbid — Closest Without Going Over | Price Games",
    description: "Play Underbid on Price Games — guess as close as possible to the real price without going over. A classic closest-without-going-over pricing challenge.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/price-match": {
    title: "Price Match — Match Products to Prices | Price Games",
    description: "Play Price Match on Price Games — match four products to their correct prices. A free memory + pricing puzzle game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/riser": {
    title: "Riser — Stop the Rising Price | Price Games",
    description: "Play Riser on Price Games — stop the ticking price before it goes over the real value. Nerves of steel required.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/odd-one-out": {
    title: "Odd One Out — Spot the Different Price | Price Games",
    description: "Play Odd One Out on Price Games — find the product that doesn't belong with the price group. Free pattern-spotting game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/market-basket": {
    title: "Market Basket — Estimate Basket Total | Price Games",
    description: "Play Market Basket on Price Games — estimate the total cost of a shopping basket. Free mental-math price-guessing game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/sort-it-out": {
    title: "Sort It Out — Rank Products by Price | Price Games",
    description: "Play Sort It Out on Price Games — rank products from cheapest to most expensive. Free price-sorting puzzle.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/budget-builder": {
    title: "Budget Builder — Pick Items Within Budget | Price Games",
    description: "Play Budget Builder on Price Games — pick items that fit inside the given budget. A free strategic price-picking game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
  "/play/chain-reaction": {
    title: "Chain Reaction — Build an Ascending Price Chain | Price Games",
    description: "Play Chain Reaction on Price Games — build a chain of products in ascending price order. Free combo-building price game.",
    sitemap: true,
    changefreq: "weekly",
    priority: 0.8,
  },
};

/** Fallback meta for unknown routes. */
export const SEO_DEFAULT: SeoMeta = {
  title: "Price Games — Guess the Price of Real Products",
  description: HOME_DESC,
};

/**
 * Resolve a pathname to the SEO meta that should be applied to it.
 * Dynamic routes (/player/:username, /s/:id, /r/:code, /:roomCode) are
 * handled by pattern-matching the segment shape. Query strings are stripped.
 */
export function resolveSeoMeta(pathname: string | undefined | null): SeoMeta {
  const path = normalizePath(pathname);
  const merged = { ...SEO_ROUTES, ...SEO_GAME_MODE_ROUTES };
  if (path in merged) return merged[path];

  if (path.startsWith("/player/")) {
    const uname = path.slice("/player/".length);
    return {
      title: `${uname} on Price Games`,
      description: `${uname}'s Price Games profile — recent games, best scores, and achievements.`,
      sitemap: false,
    };
  }
  if (path.startsWith("/s/")) {
    // Indexable long-tail: each share is a distinct content page
    // (round-by-round breakdown for a specific player's run). Not added to
    // sitemap.xml — we let engines discover them via social referrals
    // rather than actively pushing millions of URLs. Server-side meta
    // injection fills in the per-share title/description from the DB so
    // crawlers and social-link previews show the actual score and mode.
    return {
      title: "Shared Price Games Result",
      description: "A shared Price Games result with the full round-by-round breakdown. View the score and play the same challenge yourself.",
      sitemap: false,
    };
  }
  if (path.startsWith("/r/") || path.startsWith("/go/")) {
    return { title: SITE_NAME, description: HOME_DESC, noindex: true };
  }
  if (/^\/admin(\/|$)/.test(path)) {
    return { title: "Admin — Price Games", description: "Price Games admin panel.", noindex: true };
  }
  if (/^\/universe(\/|$)/.test(path)) {
    return {
      title: "Product Universe — Price Games",
      description: "Explore the Product Universe — the full catalog of Price Games products and categories.",
      sitemap: false,
      noindex: true,
    };
  }
  // /:roomCode — a multiplayer room code. Real codes are 7 chars from
  // nanoid's URL-safe alphabet (`[A-Za-z0-9_-]`). Matching anything
  // broader (e.g. any 4–10 char alphanumeric path) would incorrectly
  // apply "room" meta to typos like `/foobar`.
  if (/^\/[A-Za-z0-9_-]{7}$/.test(path)) {
    return {
      title: `Multiplayer Room ${path.slice(1)} — Price Games`,
      // Pulls from MP_OG_DESCRIPTION so the lobby unfurl text is the same
      // whether a crawler hits the SSR shell or a client renders the SPA
      // <SEO> override. noindex stays true because room URLs are ephemeral
      // (rooms get GC'd after ~10 min) and would pollute search results.
      description: MP_OG_DESCRIPTION,
      noindex: true,
    };
  }
  return SEO_DEFAULT;
}

/** Strip query/hash, collapse trailing slash (except root), lowercase scheme-like parts only.
 *  Defensively handles undefined/non-string input (e.g. tests that mock
 *  `useLocation` without a `pathname`) by defaulting to "/". */
export function normalizePath(pathname: string | undefined | null): string {
  let p = typeof pathname === "string" && pathname.length > 0 ? pathname : "/";
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h !== -1) p = p.slice(0, h);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

/**
 * Build the absolute canonical URL for a pathname.
 */
export function canonicalUrl(pathname: string, origin: string = SITE_ORIGIN): string {
  return origin + normalizePath(pathname);
}
