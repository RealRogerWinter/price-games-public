---
title: Architecture
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: architecture
summary: The big picture: how the server, client, shared package, extension, and streamer bot fit together.
related_code:
  - apps
  - packages
---
# Architecture — Price Games

> High-level module map. Updated during audits and when modules are added/removed/restructured.

## System Overview

A multiplayer web game where players guess Amazon product prices. Twelve game modes (including the multiplayer-only Bidding War), real-time multiplayer via WebSocket with bot support, persistent user accounts with OAuth, and a leaderboard system.

```
                         ┌──────────────┐
                         │    Caddy      │
            Internet ───▶│  (HTTPS/TLS) │──── /admin/* and ?broadcast=1 blocked (respond 404)
                         │ price.games   │
                         └──────┬───────┘
                                │ reverse_proxy :3001
                                ▼
                   ┌────────────────────────┐
  Tailscale ──────▶│   Express + Socket.IO  │
  (admin access,   │       (port 3001)      │
  broadcast        │                        │
   overlay)        │  /api/*    REST API    │
  tailscale serve  │  /socket.io  WebSocket │
                   │  /*   Static frontend  │
                   └───────────┬────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │   SQLite    │
                        │ (products,  │
                        │  sessions,  │
                        │  scores,    │
                        │  users)     │
                        └─────────────┘
```

## Monorepo Layout

```
price-game/                          npm workspaces
├── apps/
│   ├── server/                      Express + Socket.IO backend
│   │   ├── src/
│   │   │   ├── index.ts             Entry point, middleware, static serving, graceful shutdown
│   │   │   ├── config.ts            Environment-variable config (ports, bcrypt rounds, session durations, OAuth, rate limits)
│   │   │   ├── db.ts                SQLite connection, schema DDL, versioned migrations (1–70+ at HEAD; see file for latest)
│   │   │   ├── routes/              REST API route handlers
│   │   │   │   ├── game.ts          Single-player game endpoints (optionalUser middleware for history)
│   │   │   │   ├── leaderboard.ts   Leaderboard v2 (lifetime / period / streaks / rank)
│   │   │   │   ├── player.ts        Public player profile endpoints (stats, score-history, game history)
│   │   │   │   ├── multiplayer.ts   Multiplayer room + leaderboard REST
│   │   │   │   ├── share.ts         POST/GET /api/share endpoints for the shareable URL view (backed by shared_games table; see docs/SHARING.md)
│   │   │   │   ├── shortLinks.ts    Public `/go/:code` redirect router (atomic click counter via `recordShortCodeClick`)
│   │   │   │   ├── admin.ts         Admin auth + 2FA + analytics + rewards + UTM tags + banner + legal + user management + daily challenge REST endpoints
│   │   │   │   ├── user.ts          User accounts: register, login, logout, profile, email/password, game history, stats, OAuth, rewards, referrals
│   │   │   │   ├── daily.ts         Daily challenge public endpoints (today, start, history)
│   │   │   │   ├── push.ts          Push notification user endpoints (subscribe, unsubscribe, preferences, VAPID key, click tracking)
│   │   │   │   ├── adminNotifications.ts  Admin notification management (template CRUD, send, stats, log)
│   │   │   │   ├── attribution.ts   Anonymous visitor attribution tracking (POST /api/attribution/track)
│   │   │   │   └── universe.ts      Product Universe knowledge graph API
│   │   │   ├── services/            Business logic (decomposed into focused modules)
│   │   │   │   ├── gameEngine.ts    Re-export facade → gameSession + gameHints + gameGuess
│   │   │   │   ├── gameSession.ts   Game session lifecycle (start, get)
│   │   │   │   ├── gameHints.ts     Hint system for single-player
│   │   │   │   ├── gameGuess.ts     Single-player guess submission + scoring (12 modes — VALID_GAME_MODES)
│   │   │   │   ├── multiplayerEngine.ts  Re-export facade → mp* modules
│   │   │   │   ├── mpTimerState.ts  Round timers, ended flags, continue tracking
│   │   │   │   ├── mpRoundStart.ts  Multiplayer round start + payload building
│   │   │   │   ├── mpGuess.ts       Multiplayer guess submission + scoring
│   │   │   │   ├── mpRoundEnd.ts    Round end, reveal data, leaderboard save (links user_id)
│   │   │   │   ├── mpBidding.ts     Bidding mode bid submission + comparative scoring
│   │   │   │   ├── mpBiddingState.ts  Bidding mode state machine (sequential turns, turn timer, auto-bid)
│   │   │   │   ├── botNames.ts      Bot name generator (silly/themed display names)
│   │   │   │   ├── botGuess.ts      Bot guess generator (mode-appropriate guesses scaled by difficulty)
│   │   │   │   ├── botScheduler.ts  Bot action scheduler (human-like delays, 2-6s)
│   │   │   │   ├── mpReconnect.ts   Reconnect payloads, guessed player tracking
│   │   │   │   ├── roomManager.ts   Room CRUD, player join/leave/kick, settings, bcrypt passwords (accepts userId)
│   │   │   │   ├── productSelection.ts   Product selection with LRU fairness
│   │   │   │   ├── productMapper.ts Shared product mapping (toProduct, computePriceRange, etc.)
│   │   │   │   ├── imageProxy.ts    Image proxy with URL scraping and LRU cache
│   │   │   │   ├── inputSanitizer.ts     Name/password sanitization + profanity filter + validateUsername
│   │   │   │   ├── errors.ts        UserFacingError class + safeErrorMessage utility
│   │   │   │   ├── exchangeRates.ts      Currency conversion via frankfurter.app
│   │   │   │   ├── adminAuth.ts    Admin user CRUD, login w/ lockout, session mgmt, seeding
│   │   │   │   ├── userAuth.ts     User registration, login (email/username), sessions, password/email change, email verification
│   │   │   │   ├── oauth.ts        OAuth 2.0 authorization code flow (Google, Facebook, Amazon), CSRF state, user linking
│   │   │   │   ├── userGameHistory.ts  Game history recording, dedup, stats aggregation, lifetime score tracking
│   │   │   │   ├── publicProfile.ts   Public player profile queries: lifetime leaderboard, user rank, profile stats, score history, game history (date-only)
│   │   │   │   ├── analytics.ts    Analytics aggregation (overview, time-series, distributions)
│   │   │   │   ├── analyticsUsers.ts  User analytics (registrations, retention, top players)
│   │   │   │   ├── analyticsGamesForDate.ts  Daily drill-down game details
│   │   │   │   ├── adminProducts.ts   Product CRUD (list, create, update, delete, bulk activate/deactivate, archive)
│   │   │   │   ├── adminManufacturers.ts  Manufacturer CRUD
│   │   │   │   ├── rewards.ts         Reward pool CRUD, manual/random-roll awarding, qualifying player queries, user reward retrieval
│   │   │   │   ├── utmTags.ts         UTM tag preset CRUD, URL generation (`buildTagUrl` / `buildShortUrl`), short-code validation + nanoid suggestion (`validateShortCode`, `generateShortCodeSuggestion`), atomic click counter (`recordShortCodeClick`), conversion funnel (`getUtmTagStats(id, opts?)`: optionally range-bound; clicks → anonymousPlays → signups → played → giveaway-eligible → won reward), per-tag daily series (`getUtmTagTimeSeries`), and cross-tag leaderboard (`getUtmTagComparison` with Wilson 95% CIs + low-sample / significance flags + 7-day signup sparklines)
│   │   │   │   ├── attribution.ts     Signup UTM validation + storage (`validateAttribution`, `storeSignupAttribution`, `hasRecentSignupWithoutAttribution`), visitor-row merge helper (`mergeVisitorAttributionIntoUser`)
│   │   │   │   ├── visitorAttribution.ts  Anonymous (pre-signup) attribution store — first-touch UTM insert, game-play counter, and claim-on-signup helpers keyed by the `visitor_id` cookie
│   │   │   │   ├── siteSettings.ts    Key-value settings store (promo banner, game modes, legal documents)
│   │   │   │   ├── referrals.ts      Referral system (code generation, credit/reject evaluation, anti-abuse, dashboard)
│   │   │   │   ├── turnstile.ts      Cloudflare Turnstile CAPTCHA verification
│   │   │   │   ├── email.ts          Transactional email via Resend (verification, password reset)
│   │   │   │   ├── adminUsers.ts     Admin user management (list, detail, deactivate, reactivate, delete, reset password)
│   │   │   │   ├── authHelpers.ts    Shared auth utilities (constant-time compare, lockout helpers)
│   │   │   │   ├── guessScoring.ts   Mode-specific guess scoring dispatch
│   │   │   │   ├── productPairing.ts  Product pairing for comparison/price-match modes (variant rejection, spread targeting)
│   │   │   │   ├── roundComposer.ts   Difficulty-aware product selection (easy/medium/hard curve, per-user product memory)
│   │   │   │   ├── dailyPuzzle.ts    Daily puzzle generator (seeded PRNG, getOrCreateDailyPuzzle)
│   │   │   │   ├── dailyRoundComposer.ts  Daily-specific round composition
│   │   │   │   ├── dailyStreak.ts    Streak tracking and update logic
│   │   │   │   ├── dailyHelpers.ts   Daily mode helpers (date handling, schedule lookup)
│   │   │   │   ├── adminDaily.ts     Daily mode admin operations (overview, schedule, play deletion)
│   │   │   │   ├── adminTotp.ts      Admin TOTP 2FA (setup, verification, recovery codes, pending tokens, audit log)
│   │   │   │   ├── pushNotification.ts  Web Push delivery via VAPID, subscription/preference management, template CRUD, notification stats
│   │   │   │   ├── notificationScheduler.ts  Background scheduler for queued and triggered push notifications (streak reminders, daily puzzle alerts)
│   │   │   │   ├── dbTypes.ts        Shared database type definitions
│   │   │   │   └── ai/              AI provider layer for Product Universe enrichment
│   │   │   │       ├── claude-provider.ts  Claude API integration
│   │   │   │       ├── prompts.ts    Enrichment prompt templates
│   │   │   │       ├── schemas.ts    Response validation schemas
│   │   │   │       └── types.ts      AI service type definitions
│   │   │   ├── middleware/
│   │   │   │   ├── adminAuth.ts    requireAdmin middleware, cookie config, setDb injection
│   │   │   │   ├── userAuth.ts     requireUser + optionalUser middleware, cookie config, setDb injection
│   │   │   │   ├── visitorCookie.ts  Anonymous visitor cookie issuer — attaches `req.visitorId` to every REST request, used by the pre-signup attribution pipeline
│   │   │   │   └── requireExtensionPermission.ts  Extension bearer token auth
│   │   │   ├── socket/              WebSocket layer (decomposed into focused handlers)
│   │   │   │   ├── handlers.ts      Orchestrator — wires socket events to handler modules, user session extraction from cookies
│   │   │   │   ├── roomHandlers.ts  Room create/join/rejoin/kick/settings (auto-populates username for logged-in users)
│   │   │   │   ├── gameHandlers.ts  Start round/submit guess/continue/play again/timer expire
│   │   │   │   ├── disconnectHandler.ts  Disconnect, host promotion, early round end
│   │   │   │   └── socketState.ts   Socket-to-player maps, rate limiting, cleanup (SocketPlayerMeta includes userId)
│   │   │   ├── pipeline/            Amazon product scraping tools
│   │   │   │   ├── scrape-amazon.ts Automated scraper
│   │   │   │   ├── verify-products.ts  Data validation
│   │   │   │   ├── discover-curated.ts  Curated product discovery
│   │   │   │   ├── manufacturer-contacts/  Manufacturer contact pipeline
│   │   │   │   └── backup-restore.ts   Database backup/restore
│   │   │   ├── test/                Test utilities
│   │   │   │   ├── dbHelper.ts      In-memory SQLite factory for test isolation (seedUser, seedAdminUser, seedProducts, seedAnalyticsData)
│   │   │   │   └── socketHelper.ts  Socket.IO server factory + client helpers for integration tests
│   │   │   └── integration/         Integration & regression tests
│   │   │       ├── multiplayerFlow.test.ts      Full multiplayer lifecycle via Socket.IO
│   │   │       ├── disconnectReconnect.test.ts  Disconnect, reconnect, host promotion
│   │   │       ├── timerAndRaces.test.ts        Timer expiry, race conditions, double-end prevention
│   │   │       ├── crossModeRegression.test.ts  All 11 game modes through Socket.IO pipeline
│   │   │       ├── singlePlayerFlow.test.ts     Full 10-round single-player for all modes + hints
│   │   │       ├── leaderboardIntegration.test.ts  SP/MP leaderboard save, placement, filtering
│   │   │       ├── passwordAndEdgeCases.test.ts    Passwords, round counts, continue voting, kick
│   │   │       ├── adminAuthFlow.test.ts           Admin login→analytics→logout e2e flow
│   │   │       ├── userAuthFlow.test.ts            Register→login→me→change password→logout e2e flow
│   │   │       └── extensionImportFlow.test.ts    Chrome extension product import e2e flow
│   │   ├── scripts/                 Development tooling (not part of app runtime)
│   │   │   ├── scrape-*.ts          12 ad-hoc category-specific scrapers
│   │   │   ├── seed.ts              Database seeder
│   │   │   ├── seed-data.ts         Seed product data
│   │   │   ├── find-dupes.ts        Duplicate product finder
│   │   │   ├── fix-images.ts        Image URL repair tool
│   │   │   └── prune-similar.ts     Similar product pruner
│   │   └── vitest.config.ts         Test configuration (85% coverage thresholds)
│   └── web/                         React + Vite frontend
│       ├── vitest.config.ts         Test configuration (jsdom, React Testing Library)
│       └── src/
│           ├── App.tsx              Route definitions (React Router 7), OAuth error redirect handling, promo banner
│           ├── main.tsx             Entry point
│           ├── setupTests.ts        Test setup (jest-dom matchers)
│           ├── pages/               Page components per game mode
│           │   ├── HomePage.tsx     Mode selection + category picker
│           │   ├── GamePage.tsx     Classic (precision) mode
│           │   ├── HigherLowerPage.tsx
│           │   ├── ComparisonPage.tsx
│           │   ├── ClosestPage.tsx
│           │   ├── PriceMatchPage.tsx
│           │   ├── RiserPage.tsx
│           │   ├── OddOneOutPage.tsx
│           │   ├── MarketBasketPage.tsx
│           │   ├── SortItOutPage.tsx
│           │   ├── BudgetBuilderPage.tsx
│           │   ├── ChainReactionPage.tsx
│           │   ├── MultiplayerPage.tsx  Multiplayer lobby/game/results orchestrator
│           │   ├── ResultPage.tsx   Post-game results + auto-rank display (logged-in) / sign-up prompt (guest) + Share Results modal
│           │   ├── DailyIntroPage.tsx  Daily challenge intro screen
│           │   ├── DailyResultPage.tsx  Daily challenge results with streak display and sharing
│           │   ├── SharePage.tsx    Read-only /s/:id view of a shared game — fetches SharedGameRecord, renders emoji grid + per-round cards + "Play your own" CTA
│           │   ├── LeaderboardPage.tsx  Lifetime score leaderboard (v2) — clickable usernames open PlayerProfileModal. Supports openUsername prop for /player/:username deep links.
│           │   ├── SettingsPage.tsx  User settings: email/password management, rewards, referrals, notifications
│           │   ├── ScoreboardPage.tsx  Player scoreboard: lifetime score, streak, game history/stats
│           │   ├── LegalPage.tsx    Privacy policy and terms of service display
│           │   ├── ForgotPasswordPage.tsx  Password reset request
│           │   ├── ResetPasswordPage.tsx   Password reset with token
│           │   └── VerifyEmailPage.tsx     Email verification with token
│           ├── components/          Reusable UI components
│           │   ├── ProductCard.tsx, PriceInput.tsx, Timer.tsx, etc.
│           │   ├── auth/            User authentication components
│           │   │   ├── LoginForm.tsx      Email/username + password login form
│           │   │   ├── RegisterForm.tsx   Registration form with client-side validation
│           │   │   ├── AuthModal.tsx      Modal wrapper switching between login/register views
│           │   │   ├── OAuthButtons.tsx   Google/Facebook/Amazon OAuth buttons (auto-hidden when unconfigured)
│           │   │   ├── UserDropdown.tsx    Auth dropdown: login/signup buttons or avatar + scoreboard/settings/logout
│           │   │   ├── UserNavBar.tsx     Legacy auth nav (replaced by UserDropdown)
│           │   │   ├── ChangeEmailForm.tsx   Email change with password confirmation
│           │   │   └── ChangePasswordForm.tsx  Password change with current password verification
│           │   ├── share/            Wordle-style result sharing (see docs/SHARING.md)
│           │   │   ├── ShareModal.tsx     Modal with text + PNG previews, copy/share/download actions, eager POST to /api/share
│           │   │   ├── shareCanvas.ts     Canvas-rendered PNG share card (pure drawShareCard + renderShareImage, optional shareUrl footer)
│           │   │   └── clipboard.ts       Feature-detecting Clipboard + Web Share API wrappers
│           │   ├── GiveawayModal.tsx Giveaway rules modal with auth-aware CTAs
│           │   ├── RewardTracker.tsx Monthly points progress tracker
│           │   ├── PageTopBar.tsx     Top navigation bar for route-level pages (Settings, Scoreboard)
│           │   ├── GameHistoryPanel.tsx Interactive game history panel for scoreboard page
│           │   ├── PlayerProfileModal.tsx Public player profile modal — KPIs, score-over-time chart, games-by-mode chart, paginated game history (date-only). Opened from LeaderboardPage or /player/:username deep link.
│           │   ├── ReferralDashboard.tsx Referral code, stats, and history display
│           │   ├── CookieConsent.tsx Cookie consent banner (GA4 opt-in/opt-out)
│           │   ├── ErrorBoundary.tsx  React error boundary with chunk-load-error recovery
│           │   ├── charts/          Recharts + SVG chart components for admin analytics dashboard
│           │   └── multiplayer/     MP-specific components (Lobby, Game, Results)
│           ├── api/                 API + Socket client
│           │   ├── client.ts        REST API client (fetch wrapper, credentials: same-origin)
│           │   ├── adminClient.ts   Admin API client (credentials: same-origin)
│           │   ├── userClient.ts    User account API client (register, login, logout, profile, history, stats, OAuth providers)
│           │   ├── dailyClient.ts   Daily challenge API client
│           │   ├── pushClient.ts    Push notification API client
│           │   ├── universeClient.ts  Product Universe API client
│           │   └── socket.ts        Socket.IO client singleton
│           ├── hooks/               React hooks
│           │   ├── useGame.ts       Single-player game state machine
│           │   ├── useTimer.ts      Countdown timer hook
│           │   ├── useMultiplayerGame.ts   MP game state + screen transitions
│           │   ├── useMultiplayerSocket.ts Socket lifecycle + event handling
│           │   ├── useScreenHistory.ts    Browser back-button navigation for game screens
│           │   ├── useModalHistory.ts     Browser back-button navigation for modals
│           │   ├── useShareData.ts        Derives ShareGridInput + SharedRoundSnapshot[] from SP or MP round results
│           │   ├── useDaily.ts            Daily challenge state hook
│           │   └── usePushNotifications.ts  Push notification subscription hook
│           ├── context/
│           │   ├── CurrencyContext.tsx    Currency conversion context
│           │   ├── AdminAuthContext.tsx   Admin auth state (login/logout/session check)
│           │   └── UserAuthContext.tsx    User auth state (login/register/logout/session check, OAuth provider discovery)
│           ├── utils/
│           │   ├── validation.ts    Client-side validation (username, email, password, password match)
│           │   ├── analytics.ts     GA4 dynamic bootstrap + consent helpers (loadGA, grant/revoke, trackEvent)
│           │   └── cookieConsent.ts Cookie consent preferences (localStorage-backed)
│           ├── pages/admin/         Admin panel UI
│           │   ├── AdminApp.tsx     Admin sub-router with protected routes
│           │   ├── AdminLoginPage.tsx    Login form
│           │   ├── AdminDashboard.tsx    Analytics dashboard V2 (Recharts, date range selector, KPI deltas, drill-down)
│           │   ├── DailyDrillDownModal.tsx  Game-by-game detail for a selected day
│           │   ├── AdminProductsPage.tsx  Product management (CRUD, search, filters, bulk ops)
│           │   ├── AdminArchivedProductsPage.tsx  Archived products view
│           │   ├── AdminProductDetailPage.tsx  Individual product create/edit
│           │   ├── AdminExtensionPage.tsx Extension management + downloadable .zip
│           │   ├── AdminRewardsPage.tsx  Reward pool management, manual award, random roll
│           │   ├── AdminUtmTagsPage.tsx  UTM tag dashboard: range / status / origin filters, KPI strip, hero leaderboard chart (top 10 by sessions, click-to-drill), sortable leaderboard table with Wilson CI + 7d sparkline + low-sample/significant flags, plus the existing CRUD modal (create / edit / archive / delete + smart Copy + QR + Generate short code)
│           │   ├── AdminUtmTagDetailPage.tsx  Per-tag drill-down: range pills (Lifetime / 7d / 28d / 90d), traffic-over-time area chart (sessions / signups / anonymous plays), this-tag-vs-all-tags-average comparison block with Wilson CI + significance flags, and the conversion funnel (clicks → signups → played → giveaway-eligible → won)
│           │   ├── QrCodeModal.tsx  QR code modal for UTM tag short URL (uses `qrcode` package; PNG + SVG download)
│           │   ├── AdminGameModesPage.tsx Game mode enable/disable controls
│           │   ├── Admin2faSettingsPage.tsx  Admin 2FA setup/management UI
│           │   ├── AdminDailyModePage.tsx    Daily mode schedule management
│           │   ├── AdminNotificationsPage.tsx  Push notification admin UI (templates, send, stats)
│           │   ├── AdminBannerPage.tsx   Promo banner + giveaway settings
│           │   ├── AdminLegalPage.tsx    Privacy policy and ToS editor
│           │   ├── AdminUsersPage.tsx    User account list with search and filters
│           │   ├── AdminUserDetailPage.tsx  User detail: stats, history, activity, admin actions
│           │   ├── AdminEmailPage.tsx   Email notification template editor + send-test UI
│           │   ├── AdminGhostUsersPage.tsx Ghost-user roster, kill-switch, daily-challenge simulation
│           │   ├── AdminGalleryPage.tsx Image archive browser (reads $IMAGE_ARCHIVE_ROOT)
│           │   ├── AdminMetricsPage.tsx Server-side metrics dashboard
│           │   ├── ManufacturerModal.tsx  Manufacturer contacts modal
│           │   ├── AdminNav.tsx          Admin navigation sidebar
│           │   └── admin.css        Admin panel styles (dark theme, rewards, banner)
│           └── __tests__/           Frontend test suite
│               ├── testUtils.tsx    Shared test helpers (renderWithProviders, makeProduct, makePlayer, makeUser factories)
│               ├── validation.test.ts        Client-side validation utilities
│               ├── userClient.test.ts        User API client (all endpoints)
│               ├── UserAuthContext.test.tsx   Auth context state transitions
│               ├── LoginForm.test.tsx         Login form rendering + behavior
│               ├── RegisterForm.test.tsx      Registration + validation + OAuth buttons
│               ├── AuthModal.test.tsx         Modal switching + overlay behavior
│               ├── UserDropdown.test.tsx      User dropdown menu states
│               ├── SettingsPage.test.tsx      Settings page (rewards, referrals, account)
│               ├── ScoreboardPage.test.tsx    Scoreboard page (score, streak, history)
│               ├── PageTopBar.test.tsx        Page top bar + resume game button
│               ├── ChangeEmailForm.test.tsx   Email change form
│               ├── ChangePasswordForm.test.tsx  Password change form
│               ├── ResultPage.test.tsx        Includes auto-fill username when logged in
│               ├── JoinScreen.test.tsx        Includes default display name when logged in
│               ├── App.test.tsx               Routing incl. /settings, /scoreboard, /profile redirect, UserAuthProvider wrapping
│               └── ... (hooks, components, context, API client, pages, admin panel tests)
├── extension/                      Chrome extension for Amazon product importing
│   ├── manifest.json               Manifest v3
│   ├── vite.config.ts              Build config (IIFE wrapping for content scripts)
│   └── src/
│       ├── background.ts           Service worker (auth, message handling, scraping)
│       ├── content.ts              Content script for Amazon product pages
│       ├── amazon-search-content.ts  Search results scraper
│       ├── product-detector.ts     Universal product detection (JSON-LD, Open Graph, microdata)
│       ├── scraper.ts              ASIN/price extraction from product pages
│       ├── amazon-search-scraper.ts  Extract products from search results
│       ├── api.ts                  Extension API client (login, import, categories, search)
│       ├── scraper.test.ts        Scraper unit tests
│       ├── product-detector.test.ts  Product detection tests
│       └── popup/                  Popup UI (HTML, TS, CSS)
└── packages/
    └── shared/                      Shared between server + web
        └── src/
            ├── index.ts             Barrel re-export (types + constants + scoring + shareGrid)
            ├── types.ts             All type definitions: game, admin, user account, OAuth, game history, stats, rewards, promo banner
            ├── constants.ts         Game constants, avatars, categories, game mode list, getGameModeName helper
            ├── scoring.ts           12 scoring functions (one per game mode; bidding has both MP and solo variants)
            └── shareGrid.ts         Wordle-style share grid: tier mapping, text/accessible-text/footer builders, per-round max, SharedGameRecord/SharedRoundSnapshot/CreateShareRequest/CreateShareResponse types
```

## Frontend State Management

The web app keeps cross-component state in a small set of React Contexts. Each one is mounted near the top of `apps/web/src/App.tsx` and consumed via a custom hook.

| Context | File | Provides | Notes |
|---|---|---|---|
| `UserAuthContext` | `apps/web/src/context/UserAuthContext.tsx` | Logged-in user, `login()`, `logout()`, `refreshUser()`, OAuth-config map | Loaded from `GET /api/user/me` on mount. The OAuth-provider map is fetched once from `/api/user/auth-config` and drives which provider buttons render. |
| `AdminAuthContext` | `apps/web/src/context/AdminAuthContext.tsx` | Admin session, 2FA enrollment state, `login()`, `verify2fa()`, `logout()` | Separate from user auth so admin sessions don't bleed into the player experience. Wraps every route under `/admin`. |
| `CurrencyContext` | `apps/web/src/context/CurrencyContext.tsx` | Active display currency + symbol, conversion helpers | Drives every price formatter. Defaults to USD; switchable via the currency selector in the top bar. Exchange rates are fetched from `/api/exchange-rates`. |
| `GamePauseContext` | `apps/web/src/context/GamePauseContext.tsx` | Global pause flag for in-progress games | Mostly used by modal dialogs and the daily-challenge resume flow so opening a modal doesn't tick the round timer down. |
| `EnabledPagesContext` | `apps/web/src/context/EnabledPagesContext.tsx` | Visibility map for admin-toggleable static pages (`about`, `faq`, `contact`, `game_modes`, `privacy`, `terms`) | Loaded from `GET /api/content/pages-enabled`. Defaults to **all-disabled** so a fresh app doesn't show empty pages while the network request is in flight. Footer links and routes consume this to render nothing when a page is admin-disabled. |

Per-feature hooks compose these contexts with route- or page-scoped state — for example, `useGame()` in `apps/web/src/hooks/useGame.ts` owns the single-player session lifecycle and reads the logged-in user from `useUserAuth()`; `useMultiplayerGame()` does the equivalent for multiplayer rooms and the Socket.IO connection.

When adding a new page that depends on an admin-toggleable visibility flag, extend `EnabledPagesContext` (and its backing `enabled_pages` site setting) rather than gating on a custom field; the centralized map keeps the footer, the router, and the SEO sitemap in sync.

## Module Dependency Map

### Data Flow — Single Player
```
Client (React)
  → REST API (routes/game.ts)
    → optionalUser middleware (attaches user when logged in)
    → gameSession.ts / gameGuess.ts / gameHints.ts
      → productSelection.ts (product picking)
      → productMapper.ts (product transformation)
      → shared/scoring functions
      → db.ts (SQLite reads/writes)
    → userGameHistory.ts (records game for logged-in users — credits user_game_history + lifetime_score)
```

### Data Flow — Multiplayer
```
Client (React + Socket.IO)
  → socket/handlers.ts (orchestrator, extracts user session from cookie)
    → roomHandlers.ts → roomManager.ts (room CRUD, player state, userId linking)
    → gameHandlers.ts → mpRoundStart / mpGuess / mpRoundEnd
      → productSelection.ts (product picking)
      → productMapper.ts (product transformation)
      → shared/scoring functions
      → db.ts (SQLite reads/writes)
    → mpRoundEnd.ts → userGameHistory.ts (records game for logged-in players)
    → disconnectHandler.ts → schedulePendingDisconnect (15s grace timer) → roomManager + mpRoundEnd
```

**Mobile reconnect resilience.** Mobile browsers aggressively freeze backgrounded tabs and kill their WebSocket connections. Two mechanisms keep short blips invisible and long disconnects recoverable:

1. **Server-side 15 s grace period** — `disconnectHandler.ts` defers the `connected=0` DB flip and the `ROOM_PLAYER_LEFT` broadcast via `schedulePendingDisconnect` in `socketState.ts`. A rejoin inside the window cancels the timer and leaves the room state untouched for the rest of the players.
2. **Client lifecycle hook** — `apps/web/src/hooks/useConnectionLifecycle.ts` listens for `visibilitychange`, `pagehide`/`pageshow`, `freeze`/`resume`, and `online`/`offline`. It proactively closes the socket after 5 minutes of being hidden, **but only when the user is mid-round** (`screen === "playing" || "round_result"`); on lobby / results / join screens the socket stays open across long backgrounds so a glance at another tab doesn't trigger a "Reconnecting…" flash. On resume it issues a `MP_HEARTBEAT` with a 5 s ack timeout to catch iOS Safari zombie sockets (WebKit bug 247943). The saved rejoin session lives in `localStorage` with a 30-minute TTL — every successful rejoin restamps the TTL so long-running games (Bidding War, daily) don't expire mid-play. `useMultiplayerSocket` also guards `round_start` / `game_over` listeners against firing for an abandoned room (the user explicitly left or navigated away), so a late server event can never auto-yank them back into a game they've closed.

See `docs/WEBSOCKET_EVENTS.md` for the full rejoin error-code vocabulary and `connectionStateRecovery` notes.

### Data Flow — User Accounts
```
Client (React)
  → UserAuthContext (session state, OAuth provider discovery)
    → userClient.ts (fetch with credentials: same-origin)
      → REST API (routes/user.ts)
        → middleware/userAuth.ts (requireUser — cookie validation)
        → userAuth.ts (registration, login, session CRUD, password/email mgmt)
        → oauth.ts (Google/Facebook/Amazon OAuth — token exchange, user linking)
        → userGameHistory.ts (history queries, stats aggregation)
        → db.ts (SQLite reads/writes)
```

### Data Flow — Admin Panel
```
Client (React — /admin/*)
  → AdminAuthContext (session state)
    → adminClient.ts (fetch with credentials: same-origin)
      → REST API (routes/admin.ts)
        → middleware/adminAuth.ts (requireAdmin + require2faEnrolled — cookie + 2FA validation)
        → adminAuth.ts (login, 2FA login verification, session CRUD, seeding)
        → adminTotp.ts (2FA setup, verification, recovery codes, audit log)
        → adminProducts.ts (product CRUD, bulk operations, archive)
        → adminManufacturers.ts (manufacturer CRUD)
        → adminUsers.ts (user list, detail, deactivate, reactivate, delete, reset password)
        → adminDaily.ts (daily challenge overview, schedule, play management)
        → rewards.ts (reward pool CRUD, awarding, qualifying players)
        → siteSettings.ts (promo banner, game modes, legal documents)
        → analytics.ts (overview, time-series, distributions)
        → analyticsUsers.ts (user registrations, retention, top players)
        → analyticsGamesForDate.ts (daily drill-down)
        → pushNotification.ts (template CRUD, send, stats via routes/adminNotifications.ts)
        → db.ts (SQLite reads/writes)
```

### Data Flow — Rewards
```
Admin (React — /admin/rewards)
  → adminClient.ts (reward pool CRUD, award, random roll)
    → REST API (routes/admin.ts)
      → rewards.ts (pool management, manual/random-roll award with CSPRNG)
      → db.ts (reward_pool, reward_awards tables)

Admin (React — /admin/banner)
  → adminClient.ts (banner get/update)
    → REST API (routes/admin.ts)
      → siteSettings.ts (promo banner get/update incl. giveaway settings)
      → db.ts (site_settings table)

User (React — /settings)
  → userClient.ts (GET rewards, POST claim)
    → REST API (routes/user.ts)
      → rewards.ts (getUserRewards with masked codes, claimReward reveals full code)
      → db.ts (reward_awards, reward_pool tables)

User (React — home page, RewardTracker)
  → userClient.ts (GET monthly-points)
    → REST API (routes/user.ts)
      → db.ts (user_game_history aggregate for current month)

Public (React — home page, promo banner + GiveawayModal)
  → fetch /api/settings/banner (unauthenticated)
    → siteSettings.ts (read-only, linkUrl must be relative path)
```

### Data Flow — Referral System
```
Referrer (React — /settings)
  → userClient.ts (GET /api/user/referrals)
    → REST API (routes/user.ts)
      → referrals service (dashboard: code, stats, history)
      → db.ts (users.referral_code, referrals table)

Referred user (React — /r/CODE landing)
  → sessionStorage stores referral code
  → RegisterForm includes referralCode + turnstileToken
    → userClient.ts (POST /api/user/register)
      → REST API (routes/user.ts)
        → Cloudflare Turnstile verification (server-side)
        → userAuth.ts (create account)
        → referrals service (create pending referral)
        → db.ts (users, referrals tables)

Email verification trigger
  → POST /api/user/verify-email
    → referrals service (evaluate pending referral)
      → Anti-abuse checks (IP match, disposable email, multi-account)
      → Credit or reject referral
      → db.ts (referrals.status, referrals.credited_at)

Giveaway random roll (admin)
  → rewards.ts (weighted random roll)
    → Each credited referral = 1 extra entry for the referrer
    → CSPRNG weighted selection from qualifying players
```

#### Referral System Design

- **Code generation**: 8-character alphanumeric codes, generated at account creation, collision-resistant (retry on UNIQUE constraint violation)
- **Referral flow**: Code generation at signup → shareable `/r/CODE` URL → sessionStorage capture on landing → code submitted with registration → pending referral created → email verification triggers credit/reject evaluation
- **Anti-abuse protections**:
  - IP matching: referrer and referred cannot share the same IP address
  - Disposable email blocking: registration rejected for known disposable email domains
  - Multi-account detection: checks for existing accounts from the same IP
  - Cloudflare Turnstile CAPTCHA: required on all registrations to prevent bot signups
- **Giveaway integration**: The random roll in `rewards.ts` uses weighted selection where each qualifying player's entry count = 1 (base) + number of credited referrals. This gives referrers a proportional advantage without guaranteeing wins.

### Data Flow — Legal Documents
```
Admin (React — /admin/legal)
  → adminClient.ts (GET/PUT /api/admin/legal/:key)
    → REST API (routes/admin.ts)
      → siteSettings.ts (read/write legal document markdown)
      → db.ts (site_settings table)

Public (React — /legal/privacy, /legal/terms)
  → fetch /api/settings/legal/:key (unauthenticated)
    → index.ts route → siteSettings.ts (read-only)
```

### Data Flow — Chrome Extension
```
Extension (Manifest V3)
  → background.ts (service worker — auth, message routing)
    → content.ts / product-detector.ts (product detection on any page)
    → scraper.ts (ASIN/price extraction from Amazon)
    → api.ts (REST client with bearer token)
      → REST API (routes/admin.ts)
        → middleware/requireExtensionPermission.ts (bearer token validation)
        → adminProducts.ts (upsertProductByAsin)
        → db.ts (SQLite reads/writes)
```

### Key Dependencies per Module

| Module | Depends On | Depended On By |
|--------|-----------|----------------|
| `db.ts` | better-sqlite3 | All server modules |
| `config.ts` | (env vars) | All services, middleware, routes, index |
| `shared/*` | (none) | gameGuess, mpGuess, mpRoundStart, roomManager, routes |
| `errors.ts` | (none) | inputSanitizer, roomManager, productSelection, userAuth, oauth, routes |
| `productMapper.ts` | (none) | gameSession, gameGuess, mpRoundStart, mpRoundEnd, mpReconnect |
| `productSelection.ts` | db | gameSession, mpRoundStart |
| `inputSanitizer.ts` | errors | roomManager, userAuth, routes/game |
| `gameSession.ts` | db, productSelection, productMapper, shared | routes/game |
| `gameGuess.ts` | db, productMapper, shared | routes/game |
| `gameHints.ts` | db, gameSession | routes/game |
| `roomManager.ts` | db, shared, inputSanitizer, bcryptjs | socket handlers, routes/multiplayer |
| `mpTimerState.ts` | (none) | mpRoundStart, mpGuess, mpRoundEnd, mpReconnect, gameHandlers |
| `mpRoundStart.ts` | db, productSelection, productMapper, mpTimerState, shared | gameHandlers |
| `mpGuess.ts` | db, mpTimerState, mpReconnect, shared | gameHandlers |
| `mpRoundEnd.ts` | db, mpTimerState, mpReconnect, productMapper, shared, userGameHistory | gameHandlers, disconnectHandler |
| `mpReconnect.ts` | db, mpTimerState, productMapper, shared | gameHandlers, disconnectHandler, roomHandlers |
| `socketState.ts` | (none) | handlers, roomHandlers, gameHandlers, disconnectHandler |
| `imageProxy.ts` | (external HTTP) | index.ts |
| `exchangeRates.ts` | (external API) | index.ts |
| `adminAuth.ts` | db, config, bcryptjs, crypto | routes/admin, middleware/adminAuth, index |
| `userAuth.ts` | db, config, bcryptjs, crypto, inputSanitizer | routes/user, middleware/userAuth, index |
| `oauth.ts` | db, config, userAuth (rowToUserAccount) | routes/user |
| `userGameHistory.ts` | db | routes/user, routes/game, mpRoundEnd |
| `analytics.ts` | db | routes/admin |
| `analyticsUsers.ts` | db | routes/admin |
| `analyticsGamesForDate.ts` | db | routes/admin |
| `adminUsers.ts` | db, userAuth | routes/admin |
| `referrals.ts` | db, config, email | routes/user |
| `turnstile.ts` | config, (external HTTP) | routes/user |
| `email.ts` | config, (Resend API) | userAuth, referrals, routes/user |
| `adminProducts.ts` | db, inputSanitizer | routes/admin |
| `adminManufacturers.ts` | db | routes/admin |
| `rewards.ts` | db, crypto | routes/admin, routes/user |
| `siteSettings.ts` | db, @price-game/shared | routes/admin, index.ts |
| `productPairing.ts` | db, productMapper | mpRoundStart, gameSession |
| `roundComposer.ts` | db, productSelection, productPairing | gameSession, mpRoundStart |
| `middleware/adminAuth.ts` | adminAuth service, config | routes/admin |
| `middleware/userAuth.ts` | userAuth service, config | routes/user, routes/game, socket/handlers |
| `middleware/requireExtensionPermission.ts` | adminAuth service | routes/admin (extension endpoints) |

## Database Schema (SQLite)

### Tables
- **schema_version** — Migration version tracking (prevents re-running applied migrations)
- **products** — Product catalog (title, ASIN, price_cents, category, image_url, active status)
- **game_sessions** — Single-player game state (rounds, score, mode, selected products, user_id)
- **game_rounds** — Per-round guess data for single-player
- ~~**leaderboard**~~ — Removed in v53; the moderation panel now sources from `user_game_history` directly.
- **mp_rooms** — Multiplayer room state (code, mode, round progress, bcrypt-hashed password, is_public, bot_count, bot_difficulty)
- **mp_players** — Players in multiplayer rooms (name, avatar, token, score, connection status, user_id, is_bot)
- **mp_guesses** — Per-round guesses in multiplayer
- **mp_leaderboard** — _(Deprecated for UI)_ Multiplayer high scores. Leaderboard v2 uses `users.lifetime_score`.
- **admin_users** — Admin accounts (username, bcrypt hash, lockout state, active flag, TOTP 2FA fields)
- **admin_sessions** — Admin sessions (token, expiry, idle timeout, IP, user-agent)
- **analytics_daily** — Pre-computed daily game summaries by type and mode
- **analytics_daily_categories** — Pre-computed daily category usage counts
- **users** — User accounts (username, email, bcrypt password_hash, email_verified, oauth_provider, oauth_provider_id, lifetime_score, lockout state, referral_code)
- **user_sessions** — User sessions (token, expiry, idle timeout, IP, user-agent)
- **email_verification_tokens** — Email verification tokens (token, email, expiry, used_at)
- **user_game_history** — Per-game records for logged-in users (game_type, game_mode, score, placement, session_id/room_code)
- **referrals** — Referral tracking (referrer_id, referred_id, referral_code, status, rejection_reason, referrer_ip, referred_ip, created_at, credited_at)
- **user_rewards** — Legacy placeholder (unused, superseded by reward_pool/reward_awards)
- **user_product_views** — Tracks which products each user has seen (user_id, product_id, session_id, seen_at) for per-user product memory
- **reward_pool** — Admin-managed gift card inventory (type, amount_cents, code UNIQUE, status: available/awarded/claimed, created_by admin)
- **reward_awards** — Award tracking (reward_id UNIQUE, user_id, method: manual/random_roll, criteria JSON, awarded_by admin, claimed_at)
- **password_reset_tokens** — Password reset tokens (id, token, user_id, expires_at, used_at)
- **site_settings** — Key-value store for admin-configurable settings (promo banner, daily_enabled, daily_schedule)
- **visitor_attribution** — Anonymous pre-signup UTM tracking (visitor_id cookie, first-touch UTM, game counters)
- **daily_puzzles** — Cached daily puzzle per UTC date (mode, product_ids, round_data)
- **daily_plays** — Daily completion ledger (user_id, session_id, score, streak)
- **push_subscriptions** — Web Push subscriptions (endpoint, keys, per user)
- **notification_preferences** — Per-user notification preferences
- **notification_templates** — Admin-managed notification templates
- **notification_log** — Notification send log with click tracking
- **scheduled_notifications** — Background scheduler queue
- **admin_2fa_recovery_codes** — Hashed one-time admin 2FA recovery codes
- **admin_2fa_pending** — Short-lived pending 2FA login tokens
- **admin_2fa_audit_log** — 2FA event audit trail

### Product Universe Tables
- **pu_materials** — Materials knowledge base (name, category, sustainability_score)
- **pu_product_materials** — Product-to-material links with percentages and confidence
- **pu_companies** — Company knowledge graph (name, website, headquarters, revenue)
- **pu_locations** — Geographic locations (country, region, lat/long)
- **pu_supply_chain_nodes** — Supply chain stages per product
- **pu_company_relationships** — Corporate relationships (parent, subsidiary, competitor)
- **pu_product_companies** — Product-to-company links with roles
- **pu_product_similarity** — Product similarity scores
- **pu_galaxy_positions** — 3D visualization coordinates (x, y, z, cluster)
- **pu_sources** — Data source references (URL, title, content_hash)
- **pu_enrichment_jobs** — Enrichment pipeline job tracking (status, priority, attempts)
- **pu_search_cache** — Search result caching with TTL
- **pu_material_locations** — Material sourcing locations

### Migration System
Migrations are tracked via the `schema_version` table. Each migration has a version number and SQL statements. On startup, `db.ts` checks which migrations have been applied and runs any pending ones in order. Existing databases that pre-date the migration system are auto-detected and bootstrapped.

**Current migrations (1–70+ at HEAD — the list below is partial; check `apps/server/src/db.ts` for the authoritative list):**
1. Add columns to game_sessions, game_rounds, leaderboard, products
2. Add password column to mp_rooms
3. Performance indexes on mp_players, mp_guesses, products, mp_rooms
4. Product manufacturer column
5. Create admin_users, admin_sessions, analytics_daily, analytics_daily_categories tables
6. Add last_activity_at column to mp_rooms (room cleanup)
7. User accounts: users, user_sessions, email_verification_tokens, user_game_history, user_rewards
8. Link existing tables to user accounts: user_id columns on leaderboard, mp_leaderboard, mp_players, game_sessions
9. OAuth columns on users (oauth_provider, oauth_provider_id)
10. Game history dedup index (partial unique index on user_id + session_id)
11. User product views tracking (user_product_views table)
12. Extension permissions (admin can_use_extension column)
13–17. Product Universe tables (materials, companies, locations, supply chain, similarity, galaxy positions, sources, enrichment jobs, search cache)
18–19. Data integrity fixes (game_rounds unique index, pu_sources URL dedup)
20. Rewards system: reward_pool and reward_awards tables
21. Site settings key-value table with default promo banner
22. UNIQUE constraint on reward_pool.code (prevents duplicate gift card codes)
23. Password reset tokens table
24. Add username_pending column to users
25. Legal documents seeding (programmatic, no-op SQL)
26. Product archived status (`is_archived` column + index on products)
27. Add referral_code column (UNIQUE) on users table + create referrals table
28. UTM attribution columns on users (captured at signup)
29. utm_tags preset table + cohort index on users
30. Short-link columns on utm_tags (short_code, click_count, last_clicked_at)
31. **visitor_attribution table + mp_players.visitor_id** — anonymous pre-signup attribution (see "Anonymous visitor attribution" below)
32. Daily challenge mode: daily_puzzles, daily_plays tables; streak columns; session daily fields
33. Configurable total_rounds on game_sessions
34. Leaderboard v2 index (users.lifetime_score DESC)
35. Push notification tables: push_subscriptions, notification_preferences, notification_templates, notification_log, scheduled_notifications
36. Admin 2FA: TOTP columns on admin_users; admin_2fa_recovery_codes, admin_2fa_pending, admin_2fa_audit_log tables
37. User avatar preferences (`users.avatar TEXT`)
38. **Bots, public lobbies, and bidding** — `mp_players.is_bot`, `mp_rooms.is_public`, `mp_rooms.bot_count`, `mp_rooms.bot_difficulty`, index `idx_mp_rooms_public_lobby`

## Outbound Link Tagging (emails + push)

Every URL in an outgoing email or push notification is auto-tagged with UTM parameters that identify the template type that emitted it. Implementation lives in two places:

- `packages/shared/src/outboundOrigins.ts` — `OUTBOUND_ORIGINS` registry mapping each origin key (e.g. `email:reward_awarded`, `push:daily_puzzle`) to its `(utm_source, utm_medium, utm_campaign[, utm_content])` tuple. 21 origins total covering the four reward emails, eight marketing emails, two transactional emails (verify, password reset), and six push notification types.
- `apps/server/src/services/outboundLinks.ts` — runtime tagging service:
  - `tagUrl(url, originKey)` — appends UTMs to a URL, preserves existing query/fragment, defers to author-supplied UTMs on collision.
  - `tagAndShortenUrl(db, url, originKey)` — picks short-link vs long-UTM strategy. For per-recipient tokenized URLs (`/claim/<token>`, `/verify-email`, `/reset-password`) it returns the long form with UTMs. For static destinations it lazily materializes a system-managed `utm_tags` row (one per `(origin, destination)` pair) and returns `${appUrl}/go/<code>`.
  - `rewriteHtmlLinks(html, originKey, db)` / `rewriteTextLinks(text, originKey, db)` — auto-rewriters that walk the rendered email body and tag every `<a href="${appUrl}/...">` (or bare URL in text) without touching `mailto:`, `tel:`, the unsubscribe footer, or the push click tracker.

Wiring:
- Reward emails (`apps/server/src/services/email.ts`) call `tagUrl`/`tagAndShortenUrl` directly inside each sender.
- Marketing emails (`apps/server/src/services/emailNotification.ts` → `sendMarketingEmail`) run `rewriteHtmlLinks` + `rewriteTextLinks` on the rendered body BEFORE `appendUnsubscribeFooter`, so the HMAC-signed unsubscribe URL is never tagged.
- Push notifications (`apps/server/src/services/pushNotification.ts` → `sendPushToUser`) pre-tag `payload.url` BEFORE the `/api/push/click/<logId>?r=...` click-tracker wrap. No short-link substitution for push (URLs aren't user-visible and `notification_log` already provides per-template click attribution).

Click flow lands on the regular `captureUtmFromUrl()` capture in `apps/web/src/utils/attribution.ts` — first-touch wins via `sessionStorage`, server-side first-touch wins via `WHERE utm_source IS NULL` guards in `storeSignupAttribution`, so transactional email clicks from already-attributed users never overwrite their original attribution.

Migration v66 added `utm_tags.origin_key` plus a partial UNIQUE index on `(origin_key, destination_url)` so admin-created and system-managed rows coexist without conflicting. Admin UI surfaces system rows under a "System origins" filter pill; they render read-only because the in-process short-code cache assumes the row stays stable.

## Anonymous Visitor Attribution

Pre-signup "first game played" tracking relies on a cookie-backed visitor
identity so that marketing cohorts can be measured without requiring
registration. The flow:

1. **Cookie issuance.** On every `/api/` request the `visitorCookie`
   middleware (`apps/server/src/middleware/visitorCookie.ts`) checks for
   a `visitor_id` cookie. If absent or malformed, it generates a UUID,
   sets an httpOnly / sameSite=lax / 90-day cookie, and attaches
   `req.visitorId`. The sameSite=lax choice is deliberate: a strict
   cookie would not be sent on the top-level navigation from an ad
   click, which is exactly the flow we need to capture.
2. **First-touch capture.** `main.tsx` calls `captureUtmFromUrl()` on
   page load to stash the UTM tuple in `sessionStorage`, then fires
   `trackAttributionOnServer()` (fire-and-forget) which POSTs to
   `/api/attribution/track`. The server validates the payload with the
   same `validateAttribution()` used at signup and inserts a
   `visitor_attribution` row keyed by `visitor_id`. `INSERT OR IGNORE`
   enforces first-touch wins.
3. **Game-play credit.** When a single-player game completes, the
   `/api/game/:sessionId/guess` handler calls `recordVisitorGamePlay()`
   with the current `visitor_id`. A single `UPDATE` sets
   `first_game_at`/`type`/`mode` via `COALESCE` (only on the first play)
   and always bumps `games_played`. Multiplayer follows the same path:
   `mp_players.visitor_id` is populated from `socket.data.visitorId` at
   `ROOM_CREATE` / `ROOM_JOIN`, and `mpRoundEnd.saveToLeaderboard()`
   calls `recordVisitorGamePlay()` once per standings row. Both paths
   no-op when the visitor has no attribution row, so untracked visitors
   never accumulate state.
4. **Signup merge.** When a user registers (email or OAuth), the route
   handler calls `mergeVisitorAttributionIntoUser()`
   (`services/attribution.ts`). If a visitor row exists, its UTM fields
   are pushed through `storeSignupAttribution()` (whose `utm_source IS
   NULL` guard preserves the first-touch invariant on the users row)
   and the row is marked with `claimed_user_id`. The request-body
   attribution still wins when both sources are present — the merge is
   a no-op on a row that `storeSignupAttribution()` has already touched.

   On the same auth events (register / login / OAuth callback), two
   sibling services also run off the same `visitor_id`:
   `claimAnonymousDailyPlays()` (daily challenge plays + streak
   bootstrap — `services/dailyClaim.ts`) and
   `claimAnonymousGameHistory()` (completed non-daily single-player
   rounds — `services/gameHistoryClaim.ts`). The latter finds
   `game_sessions` rows where `visitor_id` matches, `user_id IS NULL`,
   `completed_at IS NOT NULL`, and `is_daily = 0`, records each into
   `user_game_history` via the existing `recordSinglePlayerGame()`
   (idempotent via `INSERT OR IGNORE` on `(user_id, session_id)`),
   bumps `users.lifetime_score`, and stamps the session's `user_id`
   so repeat logins don't re-claim.
5. **Funnel reporting.** `getUtmTagStats()` adds an `anonymousPlays`
   field counting `visitor_attribution` rows matching the tag's UTM
   tuple where `first_game_at IS NOT NULL AND claimed_user_id IS NULL`.
   Excluding claimed rows avoids double-counting visitors who later
   signed up (they're already under `signups` / `playedFirstGame`).

Privacy / retention notes: the `visitor_attribution` table stores no
IPs, user agents, or email addresses — only the UTM tuple, the landing
page, the referrer (when present), and aggregate counters. The cookie
TTL is 90 days (`visitorCookieMaxAgeMs`) which is long enough for a
click → giveaway funnel without becoming long-lived PII.

## Bots, Public Lobbies & Bidding

### Bot Subsystem

Bots are AI-controlled players that fill multiplayer rooms. The host configures bot count (1-5) and difficulty (easy/medium/hard) via the `room:bot_config` socket event.

- **`botNames.ts`** — Generates silly themed display names for bots (no repeats within a room)
- **`botPersonality.ts`** — Assigns each bot a stable archetype (expert, overbidder, lowballer, average-joe, wild-card, anchored) deterministically from `hash(botPlayerId + roomCode)`. Archetype controls a log-normal mixture error model (close / moderate / wild components) plus human-style round-number snapping ($X.99, round $5/$10/$25). Bidding mode adds a shade-down-below-estimate, occasional `+$1` clip when last bidder, and rare `$1` "everyone overbid" gambit.
- **`botGuess.ts`** — Dispatches mode-appropriate guesses. Price-based modes (classic, closest-without-going-over, riser, market-basket, bidding) delegate to the personality sampler so individual bots vary in style and guesses spread across accuracy bands — copying any single bot is unreliable. Categorical modes (higher-lower, comparison, odd-one-out, chain-reaction, price-match, sort-it-out, budget-builder) retain difficulty-keyed correctness probabilities.
- **Difficulty tier** modulates the *mix* of archetypes drawn per room (hard → more experts, easy → more wild-cards), not a single noise scale.
- **`botScheduler.ts`** — Schedules bot actions with human-like random delays (2-6 seconds) to avoid instant responses. Cleans up pending timers on round end or room teardown.

Bot players are stored in `mp_players` with `is_bot = 1` and are excluded from user-linked history and leaderboard tracking.

### Public Lobby System

Rooms can be marked as public (`mp_rooms.is_public = 1`) to appear in a browsable lobby list.

- **`GET /api/mp/lobbies`** — Returns public rooms with capacity, filtered by game mode, ordered by human player count descending
- **`POST /api/mp/quickplay`** — Matchmaking endpoint that joins an available public lobby or tells the client to create a new one
- **Index**: `idx_mp_rooms_public_lobby ON mp_rooms(is_public, status)` enables efficient lobby queries

### Bidding State Machine

The bidding game mode uses a sequential-turn model instead of the standard simultaneous-guess model.

- **`mpBiddingState.ts`** — Manages the turn queue: randomizes player order each round, tracks the current turn, enforces 20-second per-turn timers, auto-bids $0.01 on timeout
- **`mpBidding.ts`** — Handles bid submission and comparative scoring. After the last bid, all bids are scored together using closest-without-going-over rules (the closest bid that doesn't exceed the actual price wins)
- Events: `game:bidding_turn` → `game:submit_bid` → `game:bid_placed` → (repeat) → `game:round_end`

### Ready-Up System

Players mark themselves as ready in the lobby via `room:ready`. The server broadcasts `room:player_ready` to all room members. When all human players (non-bot) are ready, the game auto-starts without requiring the host to manually press start.

## Affiliate CTA System

Every outbound Amazon link rendered to a user — product-detail pages, post-round overlays, tooltips, breakdowns, share cards, the Product Universe dashboard, all multiplayer screens — flows through a single React component so the visual language, compliance, and affiliate tagging stay consistent.

**Component**: `apps/web/src/components/AmazonCTA.tsx`

| Variant | Size | Where used | Disclosure |
|---|---|---|---|
| `button` | `md` | Post-round result overlays, per-mode finishing screens, MP hero reveal, share cards, Product Universe hero action | Yes (hero surface) |
| `button` | `sm` | Product tooltips, multi-product overlays (Comparison, Price-Match, Sort-It-Out, Market-Basket, Budget-Builder, Chain-Reaction, Odd-One-Out), MP per-round breakdown rows | No |
| `inline` | — | Breakdown tables (`ResultPage`), shared-round-card rows, MP final-results rows | No |

- **Copy**: `"See it on Amazon"` + trailing external-link glyph. Amazon Associates prohibits "Buy" verbs for affiliates.
- **`rel` attribute** (every instance): `sponsored nofollow noopener noreferrer` — `sponsored` is required by the [FTC Endorsement Guides](https://www.ftc.gov/business-guidance/resources/ftc-endorsement-guides-what-people-are-asking) and Amazon Associates Operating Agreement §5; `noopener noreferrer` prevents tabnabbing; `nofollow` is the Google-recognized legacy signal.
- **`target="_blank"`** always; `aria-label` includes the product title and `"(opens in new tab)"` suffix.
- **FTC close-proximity disclosure** — the hero (`md`) variant with `showDisclosure` renders an `Affiliate link — we may earn a commission.` caption directly beneath the button. The site-wide footer disclosure in `SiteFooter` is retained for Associates compliance.
- **Animation** — `transform`/`opacity` only, hover-triggered diagonal shimmer sweep (no idle pulse; disabled under `prefers-reduced-motion`).

### Affiliate-tag single source of truth

`packages/shared/src/constants.ts` exports:

- `AMAZON_ASSOCIATE_TAG = "pg081-20"` — the associate tag.
- `amazonProductUrl(asin)` → `https://www.amazon.com/dp/<asin>?tag=pg081-20`.
- `amazonSearchUrl(query)` → `https://www.amazon.com/s?k=<encoded>&tag=pg081-20`.

Server-side, `productMapper.ts` and `historyRecap.ts` call `amazonProductUrl` to build every outbound `amazonUrl` from an ASIN. Client-side, `ProductDashboard`'s search CTA calls `amazonSearchUrl`.

**Policy**: no code anywhere in `apps/` may construct an `amazon.com/dp/` or `amazon.com/s?k=` URL by string concatenation. Any new user-facing Amazon link must route through one of the helpers above so the affiliate tag is impossible to omit.

## Security Measures

- **Input sanitization** — Display names, passwords, and usernames sanitized (HTML stripping, profanity filter, length limits, alphanumeric+underscore enforcement for usernames)
- **Error isolation** — `UserFacingError` class separates user-safe messages from internal errors via `safeErrorMessage()`
- **Password hashing** — Room passwords and user passwords hashed with bcryptjs before storage (cost factor 12 for user/admin)
- **HTTP hardening** — helmet middleware, 100kb body limit, express-rate-limit (60 req/min general, plus specific rate limits for login and registration)
- **Socket rate limiting** — Per-socket event counter with auto-disconnect on abuse
- **Room creation throttling** — IP-based rate limit on room creation
- **Image proxy safety** — ASIN validation, `execFileSync` with array args (no shell injection)
- **Graceful shutdown** — SIGTERM/SIGINT handlers close HTTP server, Socket.IO, and DB connection
- **Admin auth** — Session-based with httpOnly/SameSite=Strict/Secure cookies, bcrypt (cost 12), constant-time comparison for non-existent users (DUMMY_HASH), account lockout (5 failures → 15min lock), IP rate limiting (5/15min), 8h absolute + 30m idle session timeouts, periodic expired session cleanup. **Mandatory TOTP 2FA** for all admin accounts — AES-256-GCM encrypted secrets at rest, 10 single-use hashed recovery codes, pending login tokens (short-lived, hashed), replay protection via counter, audit logging for all 2FA events. Most admin routes gated by `require2faEnrolled` middleware.
- **User auth** — Session-based with httpOnly/SameSite=Strict/Secure cookies, bcrypt (cost 12), constant-time comparison (DUMMY_HASH), account lockout (5 failures → 15min lock), 30-day absolute + 7-day idle session timeouts, max 5 concurrent sessions (oldest evicted), password change invalidates all other sessions, login rate limiting (10/15min), registration rate limiting (3/hour), generic "Invalid credentials" error (no user-existence leaking), reserved username blocking
- **OAuth security** — CSRF state tokens (single-use, 10-minute expiry, capped at 10k pending), Facebook and Amazon access tokens sent in Authorization header (not URL), Google email_verified check, OAUTH_NO_PASSWORD sentinel for OAuth-only accounts, email-match linking guard (won't overwrite existing OAuth provider)
- **CSRF protection** — SameSite=Strict cookies + CORS sufficient (no separate token needed)
- **SQL injection prevention** — Parameterized queries only (better-sqlite3 `.prepare()`)
- **XSS prevention** — httpOnly cookies (no JS access), input sanitization
- **Socket.IO auth** — Cookie extraction at connection for user session (non-blocking — guests always allowed)
- **Room cleanup** — Abandoned rooms automatically cleaned up (5min with 0 connected players, 2hr hard cap for any room)
- **Extension auth** — Bearer token authentication for Chrome extension API endpoints
- **Rewards security** — Gift card codes masked (last 4 chars) in GET responses; full code only revealed at claim time via POST; CSPRNG (`crypto.randomInt`) for weighted random roll winner selection (referral bonus entries); UNIQUE constraint prevents duplicate codes; claim ownership verified (user can only claim their own awards); banner `linkUrl` validated server-side (relative paths only, no open redirect)
- **Referral anti-abuse** — IP matching blocks self-referrals (referrer and referred IPs compared); disposable email domains rejected at registration; multi-account detection checks for existing accounts from the same IP; Cloudflare Turnstile CAPTCHA required on all registrations; referral credited only after email verification; rejected referrals include a `rejection_reason` for auditability

## Test Infrastructure

### Server Tests (`apps/server`)
- **Framework**: Vitest + @vitest/coverage-v8
- **Coverage thresholds**: 85% for statements, branches, functions, and lines
- **Test isolation**: Each test file uses an in-memory SQLite database via `createTestDb()`
- **Test helpers**: `seedUser()`, `seedAdminUser()`, `seedProducts()`, `seedAnalyticsData()` in `dbHelper.ts`
- **Mocking pattern**: `vi.mock("../db")` with dynamic `await import()` for module-level DB replacement
- **Integration tests**: Real HTTP + Socket.IO server via `socketHelper.ts`, real `socket.io-client` connections
- **Current metrics**: ~91 test files

### Frontend Tests (`apps/web`)
- **Framework**: Vitest + jsdom + React Testing Library + @testing-library/user-event
- **Test helpers**: `testUtils.tsx` provides `renderWithProviders` (CurrencyContext wrapper), `makeProduct`, `makePlayer`, `makeUser` factories
- **Mocking**: `vi.spyOn(globalThis, "fetch")` for API/exchange rate mocking, `vi.mock("../api/client")` and `vi.mock("../api/userClient")` for module mocks
- **Current metrics**: ~135 test files covering hooks, components, context, API client, pages, auth forms, and admin panel

### Extension Tests (`apps/extension`)
- **Framework**: Vitest
- **Current metrics**: ~61 tests across 2 files covering scraper, product detection, API client, and search functionality

### Combined Totals
- **~228 test files** (server + web + extension)
- Run all: `npm test` (server + web sequentially)
- Run individually: `npm run test:server` / `npm run test:web`

## Streamer-bot online learning (separate Worker thread)

The streamer-bot package (`packages/bot-streamer/`) optionally runs a small online-learning multi-task neural network. Implementation: `packages/bot-streamer/src/learning/`. When enabled (`STREAMER_LEARNING_ENABLED=true` + `STREAMER_LEARNING_MODE=shadow|active`) it:

1. Spawns a **Worker thread** pinned via `cpuset: "2,3"` at compose level so it doesn't compete with the host's other Docker services.
2. Owns a hand-rolled MLP (~4,800 params, ~38 KB) with a shared trunk (114→32→16) and five heads — price (μ + log σ²), pair (concat 32→1), category (16→30), brand-tier (16→3), viz (16→2 projection) — plus per-mode bias terms and Kendall&Gal uncertainty weighting.
3. Persists state to a **separate SQLite database** at `/var/streamer/data/learning.db` on a Docker volume — see `docs/DATABASE.md` § "Streamer-bot learning DB".
4. Communicates with the main thread via a `LearningBridge` (`packages/bot-streamer/src/learning/bridge.ts`). Predict has a 150 ms staleness budget; over → main falls back to heuristic. Update is fire-and-forget. Heartbeat every 5 s; >30 s without one flips `degraded:'worker_dead'` on `/healthz` (container does NOT restart — would kill Chromium and the live stream).
5. Snapshots state every `STREAMER_LEARNING_SNAPSHOT_INTERVAL` rounds (default 100) but defers when the bridge is mid-round (`lastPredictAt < 2 s ago`) so `wal_checkpoint(TRUNCATE)` doesn't block mid-frame.

```
Main thread (Playwright + TTS)        Worker thread (cpuset-pinned)
──────────────────────────────        ─────────────────────────────
Chromium + game enactor               MLP forward+backward+AdamW
Strategy.candidates(round, ctx)       Prioritized replay buffer (PER, cap 512)
LearningBridge.predict(req) ─────►    Feature extractor + EMA normalizer
LearningBridge.update(req) ─────►     better-sqlite3 (WAL, idle-only checkpoints)
                                      NDJSON round log (rotating, 14d)
```

Training recipe (per the design plan):

- AdamW (lr 1e-3 post 200-round warmup, β1 0.9, β2 0.99, wd 1e-4); β-NLL price head with log σ² clamp; PER (α=0.5, β anneal 0.4→1 over 5000 rounds, 20% uniform fraction, max-2-per-roundId de-correlation); GradVac-lite zeros the largest-norm head every 8th step; per-task uncertainty weighting auto-balances the four task losses.
- Pre-update assertFinite + ‖∇‖₂ ≤ 5 clip; post-update NaN guard restores from in-memory snapshot, increments `nanRollbacks` exposed on `/healthz`.

Operational details (killswitch, smoke test, rollback) are documented in `docs/STREAMER.md`.
