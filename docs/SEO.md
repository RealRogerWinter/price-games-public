---
title: SEO
status: stable
last_reviewed: 2026-06-03
owner: growth
audience: contributor
category: features
summary: Sitemap, robots.txt, per-route meta injection, admin-editable content pages.
related_code:
  - apps/server/src/routes
  - apps/web
---
# SEO

How Price Games surfaces itself to search engines, and how to operate it.

## Surfaces

| URL                         | What                                             | Indexable |
| --------------------------- | ------------------------------------------------ | --------- |
| `/robots.txt`               | Crawler directives — points at the sitemap       | n/a       |
| `/sitemap.xml`              | Dynamic sitemap, regenerated every 10 minutes    | n/a       |
| `/`                         | Home / game mode picker                          | ✅        |
| `/about`                    | About page (admin-editable)                      | ✅        |
| `/faq`                      | FAQ page (admin-editable, emits FAQPage JSON-LD) | ✅        |
| `/contact`                  | Contact page (admin-editable)                    | ✅        |
| `/game-modes`               | All 12 modes with rules + strategy + VideoGame LD¹| ✅        |
| `/play/<slug>`              | One landing page per single-player mode (11 URLs) with mode-specific title, description, and crawler body | ✅ |
| `/privacy`, `/terms`        | Legal pages (admin-editable via /admin/legal)    | ✅        |
| `/scoreboard`, `/leaderboard` | Indexable but without per-user PII             | ✅        |
| `/mp`                       | Multiplayer lobby landing                        | ✅        |
| `/s/:id`                    | Shared game result — indexable long-tail page with per-share meta | ✅        |
| `/admin`, `/settings`, auth flows | `noindex` via meta injection               | ❌        |
| `/go/:code`, `/r/:code`, `/:roomCode` | `X-Robots-Tag: noindex`              | ❌        |

¹ 12 total game modes: 11 single-player modes plus 1 multiplayer-only mode
(`bidding`). `/game-modes` documents all 12; the dedicated `/play/<slug>`
landing pages cover only the 11 single-player modes (bidding keeps `/mp`).

## How per-route meta works

The SPA ships with a single `index.html` whose `<title>` and `<meta>` tags are
**injected at request time** by Express before the shell is served. This lets
search-engine crawlers see route-appropriate metadata without executing
JavaScript.

- Source of truth: `packages/shared/src/seo.ts` (the `SEO_ROUTES` +
  `SEO_GAME_MODE_ROUTES` tables + `resolveSeoMeta(pathname)` resolver).
  Shared so server and client render the same values.
- Server injection: `apps/server/src/routes/seo.ts`'s
  `createIndexHtmlMetaMiddleware` reads `index.html` once at boot, then swaps
  `<title>`, `<meta name="description">`, OG/Twitter tags, and injects
  `<link rel="canonical">` (and optional `<meta robots noindex>`) per request.
- Client sync: `<SEO>` component (`apps/web/src/components/SEO.tsx`) uses
  `react-helmet-async` to keep meta in sync during client-side navigation.
  Every route-owned page renders `<SEO />`; it falls back to the registry
  when no props are passed.

## Per-route static body for non-JS crawlers

Googlebot runs JavaScript reasonably well, but most AI search crawlers
(ChatGPT, Perplexity, Claude retrieval) and link-preview fetchers do not.
To give those agents real content we inject per-route HTML **inside**
`<div id="root">…</div>` before sending the shell.

- Renderer: `apps/server/src/routes/seoBody.ts`'s `renderSeoBody(pathname, db)`
  returns escaped HTML for `/`, `/play/<slug>`, `/game-modes`, `/faq`,
  `/about`, `/contact`, and a generic h1+description for other indexable
  registry routes. Returns `""` for `noindex` / dynamic routes.
- Injection: `createIndexHtmlMetaMiddleware` calls the renderer and swaps
  the empty `#root` marker via `injectSeoBody`.
- Hydration: `main.tsx` uses `ReactDOM.createRoot().render(...)`, which
  unconditionally replaces `#root`'s children — users only see the static
  copy during the pre-hydration window.
- Source of truth: mode rules + strategy live in
  `packages/shared/src/modeDetails.ts` (`MODE_DETAILS`) so the `/game-modes`
  React page and the server body render the same copy.

## Per-mode landing pages

Each single-player mode has a dedicated URL: `/play/<slug>` (e.g.
`/play/higher-lower`, `/play/price-match`). These are long-tail SEO
landing pages — each one has a unique title, description, and body
copy with rules + strategy + an internal link to the mode.

- 11 URLs (one per SP mode — bidding is multiplayer-only and keeps `/mp`).
- Each is registered in `SEO_GAME_MODE_ROUTES` with `sitemap: true` and
  `priority: 0.8`, so `sitemap.xml` lists them automatically.
- The React router has a single `<Route path="/play/:mode">` that reuses
  `SinglePlayerApp`. On mount, the component reads `useParams().mode`
  and starts the game, then replaces the URL with `/` so the in-app
  navigation stays consistent after the initial deep-link.
- Legacy `/?mode=<slug>` still works — it's resolved through the same
  effect. New internal links should use `/play/<slug>`.

### Adding a new route

1. Add an entry to `SEO_ROUTES` (or extend `resolveSeoMeta` for a dynamic
   pattern) in `packages/shared/src/seo.ts`.
2. If the page should show up in search, set `sitemap: true` with a
   `changefreq` and `priority`.
3. Rebuild `@price-game/shared`.

That's it — the server injector picks it up automatically, and the `<SEO />`
component on the page will resolve the right defaults on client navigation.

## Admin-editable content pages

Three public pages are driven by the `site_settings` table and editable from
`/admin/content`:

| Page       | `site_settings` key   | Shape (JSON)                                                   |
| ---------- | --------------------- | -------------------------------------------------------------- |
| `/about`   | `content_about`       | `{title, body (markdown)}`                                     |
| `/faq`     | `content_faq`         | `{title, items: [{question, answer (markdown)}]}`              |
| `/contact` | `content_contact`     | `{title, body (markdown), email?, social: [{label, url}]}`     |

Admins edit them under the **Content → Pages** tab in the admin panel. Changes
are live instantly (the public pages fetch `GET /api/content/:key` with a
60-second cache header; Caddy adds compression on top).

## Per-page visibility toggle

Six public SEO pages (`/about`, `/faq`, `/contact`, `/game-modes`, `/privacy`,
`/terms`) have an independent **visible on site** flag stored under the
`enabled_pages` site-settings key. The flag defaults to **disabled** for every
page on a fresh deploy — an admin must explicitly opt each page in after it has
been populated.

When a page is disabled:

- the footer link in `SiteFooter` disappears,
- the React route renders an in-app 404 shell (`RequireEnabled`),
- `GET /api/content/:key` and `GET /api/settings/legal/:key` return 404,
- the URL is omitted from `/sitemap.xml`,
- `/robots.txt` emits an explicit `Disallow:` for the path,
- the server-injected meta tags force `noindex,nofollow` on the SPA shell.

Admins manage the flags at **Content → Visibility** (`/admin/pages`). The
public read-only visibility map is exposed at `GET /api/content/pages-enabled`
so the frontend can gate navigation without probing each content endpoint.

## Shared results (`/s/:id`)

Every shared game result is indexable. These are long-tail content pages —
each one has a unique round-by-round breakdown, product images, score, and
player name — and make good organic landing pages when someone shares the
URL on Reddit/Discord/iMessage.

They are **NOT** added to `sitemap.xml`: we don't want to push millions of
share URLs to engines. Discovery happens via social referrals (the share
feature emits OG previews) and backlinks. The server-side meta injector
(`resolveShareMeta`) queries the `shared_games` row per request and fills
in the actual score and mode, so search snippets and Discord cards show
"4,250 points in Higher or Lower — Price Games Result" rather than the
generic shell title.

## Structured data (JSON-LD)

- **Site-wide** (from `apps/web/index.html`): `Organization` + `WebSite`
  graph, linked via `publisher` `@id`. Applies to every route because the
  SPA ships a single shell.
- **Home**: `WebSite` + `VideoGame` (client-rendered via `<SEO>`)
- **/game-modes**: `VideoGame`
- **/faq**: `FAQPage` with each Q&A as a `Question`/`Answer` pair (eligible for
  Google's FAQ rich result)

## Deploying sitemap changes

`/sitemap.xml` is dynamic — no file to upload. After a deploy, it regenerates
on the first hit after its 10-minute in-process cache expires.

### Submitting the sitemap to search engines

First-time setup, one per engine:

1. **Google Search Console** — https://search.google.com/search-console
   - Add `price.games` as a property (use the **Domain** property type so it
     covers all subdomains).
   - Verify via DNS TXT record — easier than HTML meta because we don't need
     to round-trip a deploy.
   - Once verified, go to **Sitemaps** and add `https://price.games/sitemap.xml`.
2. **Bing Webmaster Tools** — https://www.bing.com/webmasters
   - Add the site; Bing will offer to import the verification from Google
     Search Console.
   - Submit the same sitemap URL.

After submission, changes to the sitemap are picked up automatically on the
engines' own crawl schedule (no need to resubmit on every content update).

## Verifying crawlability

Quick checks any time:

```bash
curl -sS https://price.games/robots.txt
curl -sS https://price.games/sitemap.xml | head -40
curl -sS https://price.games/about | grep -E '<title|<meta name="description'
```

The `curl` response for `/about` should show an injected title and description
— that's what a JS-less crawler sees.

Google Search Console's **URL Inspection** tool is the ground truth for how
the Googlebot renders each page; use it when debugging indexing problems.

## Gotchas

- **Sitemap cache**: after a code change that affects the sitemap, hits in the
  first 10 minutes will still return the old content until the in-process cache
  expires. Redeploy or restart to flush.
- **Canonical**: the canonical URL for `/` is always `https://price.games/`
  (apex, no `www`). Caddy redirects `www.price.games` with a 301 to the apex.
- **Query strings**: meta injection and canonical normalization drop the query
  string, so `/?mode=classic` and `/` share the same metadata. The `?mode=`
  param is consumed client-side to start a game, so we don't want distinct
  canonical variants. The canonical deep-link format is `/play/<slug>` —
  use it in all new internal links and external campaigns.
- **Crawler body hydration**: the static `#root` content is replaced
  unconditionally by React on mount. If a future migration introduces
  `hydrateRoot` (SSR hydration) instead of `createRoot`, the static body
  must either match the React tree exactly or be removed from the shell.
