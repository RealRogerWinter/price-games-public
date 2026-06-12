---
title: API Reference
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: api
summary: "All REST endpoints — public, authenticated, and admin."
related_code:
  - apps/server/src/routes
---
# API Reference

All endpoints are prefixed with `/api`. The server runs on port 3001 (configurable via `PORT` env var).

## Authentication

- **User auth**: Session-based with httpOnly cookies. Use `POST /api/user/login` to authenticate.
- **Admin auth**: Separate session-based auth with httpOnly cookies. Use `POST /api/admin/login`.
- **Extension auth**: Bearer token in `Authorization` header. Obtain via `POST /api/admin/extension/login`.

Endpoints marked with (auth) require authentication. Endpoints marked with (admin) require admin authentication.

## Game

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/game/categories` | List selectable product categories with counts. Only returns categories with a non-empty name AND at least 15 active products. |
| POST | `/api/game/start` | Start a new game session. Body: `{ mode, categories?, excludeProductIds?, rounds? }`. `rounds` must be 3, 5, or 10 (defaults to 5). Rejects `bidding` mode (multiplayer-only). |
| GET | `/api/game/:sessionId` | Get session state |
| GET | `/api/game/:sessionId/product` | Get current round's product(s) |
| POST | `/api/game/:sessionId/hint` | Get a price hint (classic & closest modes only) |
| POST | `/api/game/:sessionId/guess` | Submit a guess (payload varies by mode) |

## Leaderboard (v2)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/leaderboard/v2?period=all&gameType=all&limit=50&offset=0` | Score leaderboard. `period` is `day` \| `week` \| `month` \| `all` (default `all`). `gameType` is `all` \| `sp` \| `mp` (default `all`). `period=all` + `gameType=all` ranks by `users.lifetime_score` (kept moderation-aware: admin row exclusions decrement the column) and returns `LifetimeLeaderboardEntry` rows with `lifetimeScore`; bounded periods use rolling windows (24h / 7d / 30d) summed from `user_game_history.score` (excluding rows where `excluded_at IS NOT NULL`) and return `PeriodLeaderboardEntry` rows with `score` and in-period `totalGames`. `gameType=sp` / `gameType=mp` filter `user_game_history` rows by `game_type` (`single` / `multiplayer`) — players with zero in-slice score drop off the board. Players with zero in-period score are excluded. Invalid `period` / `gameType` values fall back to `all`. Response: `{ leaderboard, period, gameType, total }` — `total` is the unpaginated row count for the current `period` + `gameType` filter, used by the client for numbered pagination ("Page N of M"). |
| GET | `/api/leaderboard/v2/availability` | Pill-visibility probe: `{ day, week, month, all }`. The bounded windows are 0/1 existence flags computed via indexed `EXISTS` checks; only `all` carries a real player count (used for the lifetime board's "N players" caption). Used by the leaderboard page to hide pills for empty periods. |
| GET | `/api/leaderboard/streaks?limit=20` | Longest daily-challenge streak leaderboard — ranks users by `daily_streak_best` (ties broken by current streak). Users with a best streak of 0 are excluded. `limit` clamps to `[1, 100]`. |
| GET | `/api/leaderboard/rank` | Current user's rank on the lifetime leaderboard (requires auth). Returns `{ rank, totalPlayers, bestRank }`. Both halves of the rank math count against all active users so the response is always coherent even though the leaderboard view itself hides zero-score users. |
| GET | `/api/leaderboard/rank/history?days=30&tz=Europe/Berlin` | Daily rank snapshots for the authenticated user's rank-over-time chart (requires auth). `days` clamped to [1, 365], default 30. Optional `tz` buckets by the given IANA timezone (default `America/Los_Angeles`); the scoreboard auto-populates it with the browser's timezone. Returns sparse daily ranks — days without a recorded rank are omitted because a "no game played" bucket has no meaningful rank value. |

### Player Profiles (public, no auth required)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/player/:username` | Public player profile — stats, games-by-mode, member-since. Case-insensitive username. 404 if not found. |
| GET | `/api/player/:username/score-history?days=30&tz=Europe/Berlin` | Daily score aggregates for charting (max 365 days). Optional `tz` buckets by the given IANA timezone (default `America/Los_Angeles`). Response is zero-filled to `days` entries. |
| GET | `/api/player/:username/history?limit=20&offset=0&tz=Europe/Berlin` | Paginated game history with date-only `playedDate` field. Optional `tz` formats each `playedDate` in the given IANA timezone (default `America/Los_Angeles`); the PlayerProfileModal auto-populates it with the browser's timezone. |

### Multiplayer Per-Room Leaderboard

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/mp/leaderboard?mode={mode}` | Top 20 finished-room placements, filterable by game mode. Sourced from `mp_leaderboard` (one row per `(player, room)` pair, written when the room finishes) — distinct from the lifetime/period leaderboards above. |

## Multiplayer

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/mp/room/:code` | Get room state (before WebSocket connects) |
| GET | `/api/mp/lobbies?mode={gameMode}` | List public lobbies with capacity. Returns `PublicLobbyEntry[]`. Filters by game mode. Ordered by human player count descending. |
| POST | `/api/mp/quickplay` | Quick play matchmaking. Body: `{ gameMode?: string, totalRounds?: 3 \| 5 \| 10, isDailyGame?: boolean, dailyDate?: string }`. Filters public lobbies by game mode (when provided) and round count (when a canonical value). Invalid `totalRounds` values (anything outside `ROUND_COUNT_OPTIONS`) are treated as "no preference". Daily mode: when `isDailyGame: true` + `dailyDate: "YYYY-MM-DD"`, matchmaking is scoped to other daily rooms for the same date (non-daily matchmaking explicitly excludes daily rooms). Returns 404 `daily_disabled` when the daily feature is off, 400 `invalid_daily_date` when malformed, 409 `already_played` when the player/device has already completed that date's daily. Otherwise returns `{ action: "join", roomCode }` or `{ action: "create" }`. |

### Lobby Invite Rewards

These endpoints power the **multiplayer-lobby-invite reward system** — a gameplay-buff issued when a friend joins your room link and completes ≥3 rounds. This is **strictly distinct from the signup-referral system** (`/api/user/me/referral` family), which gives monthly-giveaway entries instead. See [MULTIPLAYER_INVITES.md](MULTIPLAYER_INVITES.md) for the full design.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/mp/rooms/:code/invite-token` | Mint an opaque invite token for the host of `:code`. Body: `{ playerToken: string }` — the host's `mp_players.token`. Validates that the supplied token belongs to the room's host. Returns `{ token, url }` where `url` is the absolute `https://price.games/r/<token>` form. 404 if the room doesn't exist; 403 if the player isn't the host. |
| DELETE | `/api/mp/invite-tokens/:token` | Revoke an invite token. Only the visitor that minted the token may revoke it (matched on the visitor cookie). 204 on success; 404 otherwise. |
| GET | `/r/:token` | **Resolver** (mounted at root, not `/api`). Path-constrained to 10-char alphanumeric tokens so it does not shadow the existing `/r/{8-char-code}` signup-referral redirect. On a valid live token, sets `Set-Cookie: pg_inv=<token>; HttpOnly; SameSite=Lax; Max-Age=1800` and 302s to `/{roomCode}`. On unknown / revoked tokens, 302s to `/multiplayer` with no cookie (silent — never expose rejection to the joiner). |
| GET | `/api/users/me/buffs` | Returns the visitor's outstanding score buffs as `{ active: PendingBuff[] }`. Used by the lobby HUD to show "Bonus active" chips. Works for both authenticated users and guest visitors. |

See [WEBSOCKET_EVENTS.md](WEBSOCKET_EVENTS.md) for real-time multiplayer events.

## Share

Public, unauthenticated endpoints backing the Wordle-style share feature and the `/s/:id` read-only view. Rate-limited under the shared `apiLimiter` (60 req/min per IP by default). See [SHARING.md](SHARING.md) for the feature overview.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/share` | Create a decorative snapshot of a completed game. Returns `{ id, url }` |
| GET | `/api/share/:id` | Fetch a stored snapshot by id for read-only rendering |

### POST /api/share

**Request body:**

```json
{
  "gameMode": "classic",
  "totalScore": 7500,
  "perRoundMax": 1000,
  "playerName": "Alice",
  "roundData": [
    {
      "roundNumber": 1,
      "score": 1000,
      "products": [
        { "title": "Widget", "imageUrl": "https://...", "priceCents": 1999 }
      ],
      "guessedPriceCents": 1950
    }
  ]
}
```

**Validation:**

- `gameMode` must be one of `VALID_GAME_MODES`
- `totalScore` must be a non-negative integer ≤ 100,000
- `perRoundMax` is ignored — server recomputes from `gameMode` (1000 for standard modes, 1313 for chain-reaction)
- `roundData` must be an array of 1..20 entries, each with numeric `score`, 1..10 `products`, and string `title` + `imageUrl` + numeric `priceCents` per product
- Serialized `roundData` must be ≤ 16 KB
- `playerName` is optional; if present, passes through `sanitizeName(name, 30)` (HTML stripping, profanity filter, length cap)

**Response (201):**

```json
{ "id": "aBcD1234", "url": "/s/aBcD1234" }
```

**Errors:** `400 { error }` on any validation failure; `429` on rate limit; `500 { error }` on DB failure.

### GET /api/share/:id

**Path params:** `id` must match `^[A-Za-z0-9_-]{8}$` (nanoid shape) — rejected at the router layer to avoid wildcard DB scans.

**Response (200):**

```json
{
  "id": "aBcD1234",
  "gameMode": "classic",
  "totalScore": 7500,
  "perRoundMax": 1000,
  "playerName": "Alice",
  "roundData": [ /* SharedRoundSnapshot[] */ ],
  "createdAt": 1712700000
}
```

**Errors:** `400 { error }` on malformed id; `404 { error: "Share not found" }` on missing record; `500 { error }` on stored-JSON corruption (logged server-side).

No authentication required — share links are public and any anonymous viewer with the URL can read the record. Records are immutable and never expire.

## User Accounts

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/user/register` | — | Create account. Body: `{ username, email, password, referralCode?, turnstileToken }`. Rate: 3/hour |
| POST | `/api/user/login` | — | Login. Body: `{ identifier, password, stayLoggedIn? }` (identifier = email or username; `stayLoggedIn` boolean, defaults to `true` for backwards compat). Rate: 10/15min |
| POST | `/api/user/logout` | auth | Destroy session, clear cookie |
| GET | `/api/user/me` | auth | Get current authenticated user |
| PUT | `/api/user/username` | auth | Choose or change username. Body: `{ username }` |
| PUT | `/api/user/email` | auth | Change email. Body: `{ newEmail, password }` |
| PUT | `/api/user/password` | auth | Change password. Body: `{ currentPassword, newPassword }` |
| POST | `/api/user/verify-email` | — | Verify email with token. Body: `{ token }` |
| POST | `/api/user/resend-verification` | auth | Resend verification email |
| POST | `/api/user/forgot-password` | — | Request password reset email. Body: `{ email }` |
| POST | `/api/user/reset-password` | — | Reset password with token. Body: `{ token, newPassword }` |
| GET | `/api/user/history?limit=20&offset=0&gameType=single\|multiplayer&gameMode=classic` | auth | Paginated game history. Optional `gameMode` filter (validated against allowed modes) |
| GET | `/api/user/history/:historyId/recap` | — | Round-by-round recap of any `user_game_history` row. Public — the leaderboard player-profile modal can link into it for any player. Returns a `SharedGameRecord` identical to `GET /api/share/:id`: a cache hit against `shared_games` when `share_id` is stamped, or a freshly-synthesized snapshot from session/MP-room data (persisted as `shared_games` + `share_id` stamped on first click). Returns 400 on non-numeric id, 404 on missing row, 200 with `roundData: []` when the underlying session is gone. |
| GET | `/api/user/stats` | auth | Aggregate stats (total games, best score, etc.) |
| GET | `/api/user/win-record?breakdown=mode` | optional | Lifetime W/L/Streak snapshot. Response: `{ record: { wins, losses, currentStreak, bestStreak, totalGames } }`. With `breakdown=mode` (logged-in only) appends `byMode: [{ gameMode, wins, losses, winRate }]`. Logged-in users get cached `users` counters; anonymous viewers get `visitor_attribution` counters keyed on the `visitor_id` cookie; viewers with neither receive zeros. |
| GET | `/api/user/monthly-points` | auth | Points and games played in the current calendar month, plus current daily-challenge streak. Response: `{ points, gamesPlayed, streak }` |
| GET | `/api/user/score-history?days=30&tz=Europe/Berlin` | auth | Daily score aggregates for chart display. `days` defaults to 30, max 365. Optional `tz` buckets by the given IANA timezone (default `America/Los_Angeles`); the web client auto-populates it with the browser's timezone. Response is zero-filled. |
| GET | `/api/user/referrals` | auth | Referral dashboard: user's referral code, stats, and referral history. Returns `ReferralDashboard` |
| GET | `/api/user/rewards` | auth | List user's awarded rewards (codes masked). Response items include `claimToken` and `claimExpiresAt`. Voided + pending-review rows are filtered out. |
| POST | `/api/user/rewards/:id/claim` | auth | Claim reward, reveals full code. Refuses if expired, voided, or pending-review. |
| POST | `/api/user/rewards/claim-by-token` | auth | Claim via the per-award token from the winner email. Body: `{ token }`. Success: `{ ok: true, code, amountCents, rewardType }`. Failure: `{ ok: false, reason }` with status 400 (missing/malformed), 404 (unknown), 403 (wrong_user), or 410 (expired/voided/already_claimed). |
| GET | `/api/user/auth-config` | — | Public auth feature-flag map for the web client. Returns `{ providers: { google, facebook, amazon }, requiresTurnstile, registrationOpen }`. Drives which login buttons render and whether Turnstile mounts on register/login forms. |

### Registration Details

`POST /api/user/register` accepts the following body fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | yes | Alphanumeric + underscore, 3-20 chars |
| `email` | string | yes | Valid email address (disposable email domains blocked) |
| `password` | string | yes | Minimum 10 characters (configurable via `USER_MIN_PASSWORD_LENGTH`) |
| `referralCode` | string | no | 8-character referral code from an existing user. If valid, creates a pending referral that is credited after email verification |
| `turnstileToken` | string | conditional | Cloudflare Turnstile CAPTCHA response token. Required when `TURNSTILE_SECRET_KEY` is configured; skipped in dev/test when not set |
| `attribution` | object | no | UTM attribution object captured client-side. Supported keys: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `landing_page`, `referrer`. All values are strings clamped to 128 chars. Unknown keys are dropped. |

### Signup attribution (OAuth path)

`POST /api/user/attribute-signup` (requires auth) attaches UTM attribution
to a freshly-registered user. Used by the client after an OAuth sign-in
returns, because the server cannot carry attribution through the OAuth
callback redirect.

Request body:

```json
{
  "attribution": {
    "utm_source": "reddit",
    "utm_medium": "cpc",
    "utm_campaign": "giveaway_test"
  }
}
```

Response:

```json
{ "wasAttributed": true }
```

Rules:
- **First-touch wins**: only writes if the user has no existing `utm_source`.
- **10-minute window**: the user must have been created within the last
  10 minutes.
- `wasAttributed` is `true` only when the update actually changed a row,
  allowing the client to fire a Reddit Pixel `SignUp` event exactly once.
- **Visitor cookie fallback**: if the request body is empty or missing
  `utm_source` but the request carries a `visitor_id` cookie pointing at
  a `visitor_attribution` row, the server merges that row onto the user
  instead. This is how OAuth users whose attribution never round-tripped
  through the redirect still get credited to their original cohort.

### Anonymous attribution tracking

`POST /api/attribution/track` (public, no auth) records a UTM payload
against the anonymous `visitor_id` cookie issued by the `visitorCookie`
middleware. The client calls this from `main.tsx` immediately after
`captureUtmFromUrl()` so that pre-signup game plays can be credited to
the marketing source.

Request body:

```json
{
  "attribution": {
    "utm_source": "reddit",
    "utm_medium": "cpc",
    "utm_campaign": "giveaway_test"
  }
}
```

Response:

```json
{ "recorded": true }
```

Rules:
- **First-touch wins**: once a `visitor_attribution` row exists for the
  cookie, subsequent calls with a different UTM tuple are dropped
  (`recorded: false`).
- Silently returns `recorded: false` when `utm_source` is missing, when
  the body is malformed, or when no `visitor_id` cookie is present.
- On subsequent signup, the row is merged into the `users` table and
  marked `claimed_user_id` so it stops counting as an unclaimed visitor
  in the admin funnel. See `services/attribution.ts#mergeVisitorAttributionIntoUser`.

### Referral Dashboard

`GET /api/user/referrals` (requires auth) returns a `ReferralDashboard` object:

```json
{
  "referralCode": "AB12CD34",
  "referralUrl": "https://price.games/r/AB12CD34",
  "totalReferrals": 5,
  "creditedReferrals": 3,
  "pendingReferrals": 1,
  "multiAccountWarning": false,
  "referrals": [
    {
      "id": "uuid",
      "referredUsername": "player123",
      "status": "credited",
      "rejectionReason": null,
      "createdAt": "2026-03-15T10:30:00Z",
      "creditedAt": "2026-03-15T11:00:00Z"
    }
  ]
}
```

## OAuth

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/user/oauth/providers` | List configured OAuth providers |
| GET | `/api/user/oauth/google` | Redirect to Google OAuth |
| GET | `/api/user/oauth/google/callback` | Google OAuth callback |
| GET | `/api/user/oauth/facebook` | Redirect to Facebook OAuth |
| GET | `/api/user/oauth/facebook/callback` | Facebook OAuth callback |
| GET | `/api/user/oauth/amazon` | Redirect to Amazon (Login with Amazon) OAuth |
| GET | `/api/user/oauth/amazon/callback` | Amazon OAuth callback |

## Admin — Authentication

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/admin/login` | Admin login (sets session cookie). If 2FA is enabled, returns `{ requiresTwoFactor: true, pendingToken }` instead of setting a cookie. |
| POST | `/api/admin/logout` | Admin logout (clears session) |
| GET | `/api/admin/me` | Current admin user info |

## Admin — Two-Factor Authentication (2FA)

All admin accounts require TOTP 2FA enrollment. Most admin endpoints are gated by `require2faEnrolled` middleware.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/admin/login/verify-2fa` | — | Complete 2FA login. Body: `{ pendingToken, code, isRecoveryCode? }`. Sets session cookie on success. |
| GET | `/api/admin/2fa/status` | admin | Check 2FA enrollment status for current admin |
| POST | `/api/admin/2fa/setup` | admin | Begin TOTP setup — returns `{ secret, otpauthUri, qrCodeDataUrl }` |
| POST | `/api/admin/2fa/verify-setup` | admin | Verify TOTP code to complete enrollment. Body: `{ code }`. Returns `{ recoveryCodes }`. |
| POST | `/api/admin/2fa/disable` | admin+2FA | Disable 2FA. Body: `{ password, code, isRecoveryCode? }` |
| POST | `/api/admin/2fa/regenerate-codes` | admin+2FA | Regenerate recovery codes. Body: `{ password }`. Returns `{ recoveryCodes }`. |

## Admin — Analytics

All analytics endpoints require admin auth (with 2FA enrolled).

The dashboard analytics surface is backed by the **v2 endpoints under
`/api/admin/analytics/v2/*`** (overview, daily timeseries, acquisition,
UTM tags, paths, games-per-session, heatmap, games-by-mode, join-source,
games-daily-uniques, start-source, share-link-funnel, retention
cohorts/summary/curves/stickiness, funnels, and geo countries). These
are pre-aggregated from the events rollup tables (`analytics_hourly` +
`analytics_sessions`) and are the current source of truth — see
[ANALYTICS.md](ANALYTICS.md) for the design and the full list. The
earlier flat `/api/admin/analytics/*` KPI endpoints have been removed in
favor of this v2 surface.

The lone surviving v1-shaped endpoint is the live operational rooms view:

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/analytics/active-rooms` | Currently active multiplayer rooms. Live operational view (not analytics-stream data); auto-refreshed by the Dashboard, recency-filtered so abandoned rooms don't pollute the list. |

### Referral analytics

Powers the dedicated `/admin/referrals` dashboard. `range` accepts `7d`, `28d` (default), `90d`, or `all` and is treated as a soft input — unknown values fall back to `28d` rather than 400-ing.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/analytics/referrals/summary?range={r}` | Aggregate KPIs (total / credited / pending / rejected / conversion / unique referrers) for the window. |
| GET | `/api/admin/analytics/referrals/daily?range={r}&tz={iana}` | Zero-filled daily time-series with `created` and `credited` counters per calendar day in the admin timezone. |
| GET | `/api/admin/analytics/referrals/top-referrers?range={r}&limit={n}` | Leaderboard of referrers ordered by credited desc. `limit` clamps to `[1, 100]` (default 20). |
| GET | `/api/admin/analytics/referrals/rejections?range={r}` | Counts of rejected referrals grouped by `rejection_reason` (null bucketed as `unknown`). |
| GET | `/api/admin/analytics/referrals/by-referrer?referrerId={id}&range={r}` | Drill-down: list of accounts a single referrer brought in (status, signup time, credit time, rejection reason). 400 if `referrerId` missing. |

## Admin — Products

All product management endpoints require admin auth.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/products?page=1&pageSize=50&search=&category=&isActive=true\|false&isArchived=true\|false&sortBy=&sortOrder=asc\|desc` | Paginated product list. Use `isArchived=false` to exclude archived products. |
| GET | `/api/admin/products/categories` | Distinct categories |
| GET | `/api/admin/products/:id` | Single product detail |
| POST | `/api/admin/products` | Create product |
| PUT | `/api/admin/products/:id` | Update product |
| PATCH | `/api/admin/products/:id/status` | Toggle active/inactive status. Activating also clears archived flag. |
| PATCH | `/api/admin/products/bulk-status` | Set active/inactive for multiple products (max 500). Body: `{ ids, isActive }` |
| PATCH | `/api/admin/products/:id/archive` | Archive/unarchive a product. Archiving also deactivates. Body: `{ isArchived: boolean }` |
| PATCH | `/api/admin/products/bulk-archive` | Archive/unarchive multiple products (max 500). Body: `{ ids: number[], isArchived: boolean }` |

## Admin — Manufacturer Contacts

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/manufacturers/by-name/:name` | admin | Get manufacturer with contacts |
| POST | `/api/admin/manufacturers/:id/contacts` | admin | Add contact |
| PUT | `/api/admin/manufacturers/:id/contacts/:contactId` | admin | Update contact |
| DELETE | `/api/admin/manufacturers/:id/contacts/:contactId` | admin | Delete contact |

## Admin — Rewards

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/rewards?page=1&pageSize=50&status=all\|available\|awarded\|claimed` | admin | List rewards |
| POST | `/api/admin/rewards` | admin | Create reward (gift card) |
| GET | `/api/admin/rewards/:id` | admin | Get reward detail |
| DELETE | `/api/admin/rewards/:id` | admin | Delete reward |
| POST | `/api/admin/rewards/:id/award` | admin | Manually award to a user. Sends winner email immediately (no review step). |
| POST | `/api/admin/rewards/random-roll` | admin | **Phase 1** of the two-phase roll. Picks a candidate winner with CSPRNG-weighted selection (referrals = +1 entry each), writes a pending-review award row, sends NO emails. Body: `{ rewardId, criteria }`. `criteria` accepts `{ mode, minPoints, period, useLifetimePoints, minStreak, month?, excludedUserIds?, excludeTestAccounts? }`. `period` adds `calendar_month` (requires `month: { year, monthIndex }`). `excludedUserIds` is dropped from the pool before the roll. `excludeTestAccounts` defaults to `true`. Returns `{ candidateAward: { id, userId, username, email }, reward, totalQualifying, nonWinnerNotifyCount }`. |
| POST | `/api/admin/rewards/awards/:awardId/confirm` | admin | **Phase 2 — confirm**. Clears the pending flag, sends the winner email + the consolation batch, and starts the 30-day claim window from now. |
| POST | `/api/admin/rewards/awards/:awardId/discard` | admin | **Phase 2 — discard**. Deletes the pending row and returns the reward to `available`. Sends no emails. |
| GET | `/api/admin/rewards/qualifying-players?minPoints=&period=&useLifetimePoints=true\|false&mode=&minStreak=&month=YYYY-MM&excludedUserIds=a,b,c&excludeTestAccounts=true\|false` | admin | Preview qualifying players. `month` (compact `YYYY-MM`) is required when `period=calendar_month`. `excludedUserIds` is a CSV. `excludeTestAccounts` defaults to `true`. Response players include `{ id, username, email, points, gamesPlayed, streak }`. |
| GET | `/api/admin/rewards/search-users?q={query}` | admin | Search users for manual award |

## Admin — Promo Banner

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/banner` | admin | Get current banner settings |
| PUT | `/api/admin/banner` | admin | Update banner. Body: `{ enabled, text, linkText, linkUrl, audienceMode, showLink, showGiveawayModal, giveawayMinPoints, giveawayMinStreak, giveawayQualifyMode, showTracker, qualifiedMessage }`. `giveawayQualifyMode` is one of `points_only`, `streak_only`, `points_and_streak`, `points_or_streak` and controls whether the tracker / giveaway modal gate on points, streak, or both. |

## Admin — UTM Tags

Admin CRUD for UTM tag presets — named `(utm_source, utm_medium, utm_campaign, utm_content, utm_term)` tuples with a destination URL. Used to generate shareable tracking URLs for marketing campaigns. Funnel results are computed by aggregating the existing `users.utm_*` columns (captured at signup via migration v28). Migration v30 added an optional `shortCode` + click counter: the public `/go/:code` redirect atomically increments `click_count` per hit without storing any PII.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/utm-tags?page=1&pageSize=25&status=active\|archived\|all` | admin | List UTM tag presets |
| POST | `/api/admin/utm-tags` | admin | Create a tag. Body: `{ name, utmSource, utmMedium?, utmCampaign?, utmContent?, utmTerm?, destinationUrl, shortCode? }` → 201 on success, 400 on validation error |
| GET | `/api/admin/utm-tags/comparison?range=7\|28\|90&origin=admin\|system\|all` | admin | Cross-tag leaderboard for the dashboard. Returns `{ rows: UtmTagComparisonRow[], summary: UtmTagComparisonSummary }`. Each row includes Wilson 95% CI bounds, low-sample / significantly-different flags, and a 7-day signup sparkline. See "Comparison response" below |
| GET | `/api/admin/utm-tags/:id` | admin | Fetch a single tag; 404 if missing |
| PUT | `/api/admin/utm-tags/:id` | admin | Update mutable fields (partial; undefined fields preserved; pass `shortCode: null` to clear); 400 on validation, 404 if missing |
| PATCH | `/api/admin/utm-tags/:id/status` | admin | Body: `{ status: "active" \| "archived" }` |
| DELETE | `/api/admin/utm-tags/:id` | admin | Hard-delete a tag. Returns **409** with message `Cannot delete UTM tag with matched signups` if any user row matches the tag's UTM tuple |
| GET | `/api/admin/utm-tags/:id/stats?range=7\|28\|90` | admin | Conversion funnel. Returns `{ tagId, signups, playedFirstGame, giveawayEligible, wonReward, giveawayThreshold, clicks, hasShortCode, anonymousPlays }`. Omitting `range` returns the lifetime view (default — backward-compatible). When `range` is set, signups / playedFirstGame / giveawayEligible / wonReward / anonymousPlays are restricted to users created (or visitors who first played) inside the trailing window. `clicks` is always lifetime — the redirect handler does not log per-click events so per-day click decomposition is unavailable. 400 on bad range, 404 if missing |
| GET | `/api/admin/utm-tags/:id/timeseries?range=7\|28\|90` | admin | Daily traffic series for a single tag. Returns `Array<{ date: string, sessions: number, signups: number, anonymousPlays: number }>` with one zero-filled bucket per day in the window (admin TZ, default America/Los_Angeles). 400 on bad range, 404 if missing |
| GET | `/api/admin/utm-tags/short-code/suggest` | admin | Returns `{ code }` — a freshly-generated 6-char lowercase alphanumeric short code that does not collide with any existing `short_code`. Used by the admin UI "Generate" button next to the short-code input |

**Tag response shape** (every endpoint that returns an `AdminUtmTag` now also includes):
- `shortCode: string | null` — current short code, or null when unset
- `clickCount: number` — total short-link hits (0 when `shortCode` is null)
- `lastClickedAt: string | null` — ISO timestamp of the most recent hit

**Validation rules** (all enforced at the service layer):
- `name`: required, trimmed, 1–200 chars, unique
- `utmSource`: required, trimmed, 1–128 chars
- Optional UTM fields: ≤128 chars each; empty strings → null
- `destinationUrl`: required, ≤2048 chars. Must be either a root-relative path (`/giveaway`) or an absolute HTTP(S) URL. Rejects `javascript:`, `data:`, `ftp:`, and protocol-relative `//host` destinations.
- `shortCode`: optional; trimmed + lowercased. 3–32 chars, `[a-z0-9-]` only, must not start or end with a hyphen. Empty string normalizes to null. Unique among non-null values (partial unique index). Duplicate → 400 with `A UTM tag with this short code already exists`.

**Exact-tuple matching**: When computing the funnel or the pre-delete guard, NULL optional fields on the tag require the user/visitor column to also be NULL — they do not act as wildcards. A tag with `utm_medium = NULL` matches only signups whose `utm_medium` is also NULL. This prevents funnel double-counting when two tags share a `utm_source` but differ in optional fields: each signup is counted by exactly one tag — the unique tuple it actually carries.

**Documented cohort asymmetry**: All endpoints that join to `users` or `visitor_attribution` use the full 5-tuple `(source, medium, campaign, content, term)`. Endpoints that join to `analytics_sessions` (the leaderboard query and the time-series sessions count) use a 3-tuple `(source, medium, campaign)` because `analytics_sessions` does not carry `entry_utm_content` / `entry_utm_term` columns. Bringing those columns into the sessions table is a v2 schema migration; in practice the 3-tuple is sufficient because admin tags rarely differ only on content/term.

**Comparison response** (`GET /api/admin/utm-tags/comparison`):

```jsonc
{
  "rows": [
    {
      "tagId": "...", "name": "...", "utmSource": "...",
      "utmMedium": null, "utmCampaign": null, "utmContent": null, "utmTerm": null,
      "status": "active", "originKey": null, "hasShortCode": false,
      "clicksLifetime": 42,        // lifetime click_count (no per-day decomposition)
      "sessions": 100,              // window, bot-filtered, 3-tuple cohort
      "signups": 7,                 // window, 5-tuple cohort
      "anonymousPlays": 12,
      "conversionRate": 0.07,
      "ciLow": 0.034, "ciHigh": 0.139,         // Wilson 95% CI on signups/sessions
      "isLowSample": false,                     // true when sessions < 30
      "isSignificantlyAboveAverage": false,     // CI entirely above the global CI
      "isSignificantlyBelowAverage": false,
      "sparkline": [0, 1, 2, 1, 2, 0, 1]        // last 7 daily signup counts
    }
  ],
  "summary": {
    "totalClicksLifetime": 42, "totalSessions": 100, "totalSignups": 7,
    "totalAnonymousPlays": 12,
    "globalConversionRate": 0.07,
    "globalConversionCi": { "point": 0.07, "lo": 0.034, "hi": 0.139, "halfWidth": 0.05 },
    "rangeDays": 7, "activeTagCount": 1
  }
}
```

Rows are ranked by Wilson lower bound desc; ties broken by sessions desc. Only `status='active'` tags are included. The default origin filter is `admin` (system-managed origin tags from the outbound-links service are hidden unless `?origin=system|all` is passed).

## Public — Short-Link Redirect

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/go/:code` | none (rate-limited) | Looks up the tag whose `short_code` matches `:code` (after lowercasing). On match, atomically increments `click_count`, sets `last_clicked_at = now`, and responds `302` to the full UTM URL with `Cache-Control: no-store` and `X-Robots-Tag: noindex`. On miss, responds `404` (also with `X-Robots-Tag: noindex`). Protected by the standard `apiLimiter` (60 req/min per IP). Archived tags still resolve and still count clicks — old printed or embedded URLs must keep working after a campaign ends. No IP, user agent, or referer is stored. |

## Admin — Game Modes

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/game-modes` | admin | Returns `{ modes: GameMode[], disabledModes: string[] }` |
| PUT | `/api/admin/game-modes` | admin | Update disabled modes. Body: `{ disabledModes: string[] }`. Validates each mode against `VALID_GAME_MODES`. Returns `{ modes: GameMode[], disabledModes: string[] }` |

## Admin — User Management

All user management endpoints require admin auth.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/users?page=1&pageSize=50&search=&sortBy=&sortOrder=asc\|desc` | Paginated user list with search. Each row includes `creditedReferrals` and `totalReferrals`. `sortBy` accepts `username`, `email`, `created_at`, `lifetime_score`, `last_login_at`, or `referrals` (sorts by credited count). |
| GET | `/api/admin/users/:id` | User detail (profile, stats, account status) |
| PUT | `/api/admin/users/:id` | Update user fields |
| DELETE | `/api/admin/users/:id` | Delete user account |
| GET | `/api/admin/users/:id/game-history?page=1&pageSize=20` | User's game history (admin view, page-based pagination) |
| GET | `/api/admin/users/:id/stats` | User's aggregate stats |
| GET | `/api/admin/users/:id/activity?days={n}&tz={iana}` | Daily game-activity buckets for the chart on the admin user detail page. Optional `tz` buckets by the given IANA timezone (default `America/Los_Angeles`). Response zero-filled. |
| POST | `/api/admin/users/:id/deactivate` | Deactivate user account (prevents login) |
| POST | `/api/admin/users/:id/reactivate` | Reactivate a deactivated user account |
| POST | `/api/admin/users/:id/reset-password` | Force-reset user password. Returns `{ temporaryPassword }` (does NOT send email — admin must relay the password manually). |

## Admin — Ghost Users

All endpoints require admin auth + 2FA. Mounted under `/api/admin/ghost-users`. Ghost users are pre-seeded synthetic players the system uses to populate the leaderboard and daily challenge so a fresh deploy doesn't look empty. See [GHOST_USERS.md](GHOST_USERS.md) for the design.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/ghost-users/settings` | Current global ghost-user toggles: enabled flag, daily-challenge participation, fill thresholds. |
| GET | `/api/admin/ghost-users` | Paginated ghost-user list. |
| POST | `/api/admin/ghost-users/bulk` | Bulk-create ghost users. Body: `{ count, persona? }`. |
| POST | `/api/admin/ghost-users/simulate-daily-now` | Force a daily-challenge run for active ghost users (operator action — normally runs on schedule). |
| POST | `/api/admin/ghost-users/kill-switch` | Pause all ghost-user activity. Idempotent. |

## Admin — Leaderboard Moderation

All endpoints require admin auth + 2FA. Mounted under `/api/admin/leaderboard`.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/leaderboard/stats` | Aggregate counts: `{ totalEntries, excludedEntries, bannedUsers, testAccounts }` |
| GET | `/api/admin/leaderboard/entries?mode=&search=&scoreMin=&scoreMax=&dateFrom=&dateTo=&status=&limit=&offset=&sort=&direction=` | Filtered, paginated entries with admin-only fields (`isExcluded`, `userBanned`, `userIsTest`). `status` is `active\|excluded\|all` (default `all`). |
| POST | `/api/admin/leaderboard/entries/:id/exclude` | Soft-exclude. Body: `{ reason: string }` (required). Idempotent: re-exclude updates reason but preserves original `excludedAt`. |
| POST | `/api/admin/leaderboard/entries/:id/restore` | Reverse exclude. Body: `{ reason?: string }`. No-op (no audit) if entry already active. |
| POST | `/api/admin/leaderboard/entries/bulk-exclude` | Bulk soft-exclude. Body: `{ ids: number[], reason: string }`. Returns `{ excluded, notFound }`. |
| GET | `/api/admin/leaderboard/users/:userId` | Per-account drilldown: ban state, test flag, entry counts, recent entries. |
| POST | `/api/admin/leaderboard/users/:userId/ban` | Ban from leaderboard. Body: `{ reason: string, durationDays?: number }`. Omit `durationDays` for permanent ban. |
| POST | `/api/admin/leaderboard/users/:userId/ban-history` | Ban user AND soft-exclude every leaderboard entry they own in one transaction. Body: `{ reason: string, durationDays?: number }`. Use when bad scores need to be wiped from history all at once. |
| POST | `/api/admin/leaderboard/users/:userId/unban` | Lift ban. Body: `{ reason?: string }`. |
| POST | `/api/admin/leaderboard/users/:userId/test-flag` | Mark/unmark a test account. Body: `{ isTest: boolean }`. Test accounts are silently hidden from public leaderboards. |
| GET | `/api/admin/leaderboard/banned?limit=&offset=` | Currently-banned users list. |
| GET | `/api/admin/leaderboard/audit?action=&targetType=&targetId=&limit=&offset=` | Append-only moderation audit log (newest first). `action` is one of `exclude_entry\|restore_entry\|ban_user\|unban_user\|set_test_flag`. |

Public leaderboard reads (`/api/leaderboard*`) automatically filter out
soft-excluded entries, banned-user entries, and test-account entries —
this is enforced server-side, no client opt-in.

## Admin — Legal Documents

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/legal/:key` | admin | Get legal document by key (`privacy_policy` or `terms_of_service`) |
| PUT | `/api/admin/legal/:key` | admin | Update legal document. Body: `{ content }` (markdown) |

## Admin — Site Content (About / FAQ / Contact)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/content/:key` | admin | Get site content document (`about`, `faq`, `contact`) |
| PUT | `/api/admin/content/:key` | admin | Update site content. Body shape depends on key — see [docs/SEO.md](SEO.md) |

## Admin — Page Visibility

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/pages` | admin | Fetch the visibility map for the six public SEO pages. Returns `{ pages: {about, faq, contact, game_modes, privacy, terms} }` (all booleans). |
| PUT | `/api/admin/pages` | admin | Replace the visibility map. Body: `{ pages: {about, faq, contact, game_modes, privacy, terms} }` — unknown keys are dropped, missing keys persist as `false`. |

## Public — Site Content

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/content/:key` | Public read-only access to site content documents (`about`, `faq`, `contact`). Returns 404 if the page is disabled. 60s cache header. |
| GET | `/api/content/pages-enabled` | Public read-only visibility map for the six SEO pages. Returns `{ pages: {about, faq, contact, game_modes, privacy, terms} }` (all booleans). 60s cache header. |

## Public — SEO

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/robots.txt` | Crawler directives + sitemap pointer |
| GET | `/sitemap.xml` | Dynamic sitemap enumerating all indexable pages + top 100 player profiles (regenerated every 10 minutes) |

## Admin — Extension

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/admin/extension/login` | — | Login (returns bearer token or `{ requiresTwoFactor, pendingToken }` if 2FA is enabled) |
| POST | `/api/admin/extension/login/verify-2fa` | — | Complete extension 2FA login. Body: `{ pendingToken, code, isRecoveryCode? }`. Returns bearer token. |
| GET | `/api/admin/extension/verify` | bearer | Check token validity |
| POST | `/api/admin/extension/import` | bearer | Import/upsert product by ASIN |
| GET | `/api/admin/extension/download` | admin | Download extension as ZIP |

## Product Universe

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/pu/search` | Search products (triggers enrichment if needed) |
| GET | `/api/pu/product/:id` | Full product detail with enrichment data |
| GET | `/api/pu/product/:id/cards` | AI-generated summary cards |
| GET | `/api/pu/product/:id/supply-chain` | Geographic supply chain data |
| GET | `/api/pu/product/:id/materials` | Materials breakdown |
| GET | `/api/pu/product/:id/related?limit={n}` | Similar/related products |
| GET | `/api/pu/galaxy?limit={n}` | 3D galaxy visualization data (max 5000 nodes) |
| GET | `/api/pu/galaxy/product/:id` | Galaxy centered on a specific product |
| GET | `/api/pu/companies?q={query}&limit={n}` | Search companies |
| GET | `/api/pu/company/:id` | Company detail + relationships |
| GET | `/api/pu/company/:id/web` | Corporate relationship graph |
| GET | `/api/pu/stats` | Public universe statistics |

## Daily Challenge

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/daily/today` | Get today's daily puzzle info (mode, date, alreadyPlayed, streak). Returns 404 if daily disabled or no available mode. |
| POST | `/api/daily/start` | Start a daily game session. Returns 404 if disabled, 409 if already played today. |
| GET | `/api/daily/history` | (auth) Daily plays for the authenticated user. Accepts optional `?limit=N` (1–90, default 30). |
| GET | `/api/daily/recap/:date` | (auth) Rich recap for a daily the user has completed. Returns per-round scores joined with the full product lineup (titles, images, prices, Amazon affiliate links) by reading `daily_puzzles.round_data` for the given date. Errors: `400 invalid_date` (not YYYY-MM-DD), `404 not_completed` (user hasn't finished that daily), `404 puzzle_missing` (puzzle row was pruned), `404 corrupt_puzzle` (malformed JSON in the stored row). |

## Admin — Daily Challenge

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/daily/overview?days=14&startDate=YYYY-MM-DD` | (admin) Feature flag, schedule, and overview. Optional `startDate` for week navigation. Response includes `productImageUrls` and `productPriceCents` per day. |
| PUT | `/api/admin/daily/enabled` | (admin) Toggle the daily feature flag. Body: `{ enabled: boolean }` |
| PUT | `/api/admin/daily/schedule` | (admin) Replace the 7-slot weekly schedule. Body: `{ schedule: GameMode[] }` (length 7, index 0 = Sunday) |
| PUT | `/api/admin/daily/:date/products` | (admin) Override products for a specific date. Body: `{ gameMode, productIds }` |
| POST | `/api/admin/daily/:date/regenerate` | (admin) Regenerate puzzle from seed. Body: `{ force?: boolean }` (force clears manual override) |
| GET | `/api/admin/daily/stats` | (admin) Aggregated daily stats + top streaks. |
| DELETE | `/api/admin/daily/plays/:userId/:date` | (admin) Clear a user's daily play for support purposes. |

## Push Notifications (User-Facing)

Mounted at `/api/push`. Web Push subscription management and notification preferences.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/push/vapid-key` | — | Returns `{ vapidPublicKey }`. 503 if push not configured. |
| POST | `/api/push/subscribe` | auth | Save a Web Push subscription. Body: `{ endpoint, keys: { p256dh, auth }, expirationTime? }` |
| POST | `/api/push/unsubscribe` | auth | Remove a subscription. Body: `{ endpoint }` |
| GET | `/api/push/preferences` | auth | Get notification preferences (daily_puzzle, streak_reminder, etc.) |
| PUT | `/api/push/preferences` | auth | Update preferences. Body: partial `NotificationPreferences` (push_enabled, daily_puzzle, streak_reminder, leaderboard_updates, multiplayer_invites, promotional, quiet_hours_start/end, timezone) |
| GET | `/api/push/click/:logId` | — | Record notification click and redirect. Query: `?r=/path` |

## Admin — Notifications

Mounted at `/api/admin/notifications`. Template CRUD, manual send, and analytics.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/notifications/templates` | admin | List all notification templates |
| GET | `/api/admin/notifications/templates/:id` | admin | Get a single template |
| POST | `/api/admin/notifications/templates` | admin | Create template. Body: `{ name, type, titleTemplate, bodyTemplate, icon?, urlPath?, actionsJson?, ttl?, urgency? }` |
| PUT | `/api/admin/notifications/templates/:id` | admin | Update template fields |
| DELETE | `/api/admin/notifications/templates/:id` | admin | Delete template |
| POST | `/api/admin/notifications/send` | admin | Manual send — to a specific user or all subscribers. Body: `{ userId?, templateId?, title?, body?, type?, urlPath? }` |
| POST | `/api/admin/notifications/test` | admin | Send a test notification to a specific user. Body: `{ userId, title?, body? }` |
| GET | `/api/admin/notifications/stats` | admin | Aggregate notification stats (sent, clicked, failed counts) |
| GET | `/api/admin/notifications/log?page=1&pageSize=50&type=&status=` | admin | Paginated notification send log |
| GET | `/api/admin/notifications/subscribers` | admin | Subscriber counts (total, active, by preference) |

## Email Notifications (User-Facing)

Mounted at `/api/email`. Marketing / re-engagement email preferences and one-click unsubscribe. Parallel to `/api/push` but with a coarser cadence and opt-in defaults. See [`docs/EMAIL_NOTIFICATIONS.md`](./EMAIL_NOTIFICATIONS.md) for architecture.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/email/preferences` | auth | Get the current user's email preferences. All flags default `false` (opt-in). |
| PUT | `/api/email/preferences` | auth | Update preferences. Body: partial `EmailPreferences` (`emailEnabled`, `streakRisk`, `streakSave`, `inactivityReminder`, `weeklyDigest`, `promotional`, `preferredHour` 0–23, `timezone` IANA). |
| GET | `/api/email/unsubscribe?token=...&all=1` | — | HTML landing page; verifies HMAC token and flips matching preference (or all when `all=1`). |
| POST | `/api/email/unsubscribe` | — | RFC 8058 one-click unsubscribe. Accepts `{ token }` in body. |
| POST | `/api/email/webhook/resend` | — | Resend webhook receiver. Maps `email.opened`/`clicked`/`bounced`/`complained` to the log row by `provider_message_id`. |

## Admin — Emails

Mounted at `/api/admin/email`. CRUD + send + trigger tuning for the marketing-email channel.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/email/templates` | admin | List all email templates. |
| GET | `/api/admin/email/templates/:id` | admin | Get a single template. |
| POST | `/api/admin/email/templates` | admin | Create. Body: `{ name, type, subjectTemplate, htmlTemplate, textTemplate?, isActive? }`. |
| PUT | `/api/admin/email/templates/:id` | admin | Update fields. |
| DELETE | `/api/admin/email/templates/:id` | admin | Delete. |
| POST | `/api/admin/email/send` | admin | Manual send. Either `templateId` or `{ subject, html, text?, type }`. Target with `userId` or `toAllOptedIn: true`. Optional `adminOverride: true` bypasses cooldowns. |
| POST | `/api/admin/email/send-test` | admin | Send a minimal test email to `{ userId }` or raw `{ to }`. |
| GET | `/api/admin/email/stats?days=7` | admin | Aggregate stats: sent / opened / clicked / bounced / complained + rates + per-type breakdown. |
| GET | `/api/admin/email/log?page=1&limit=50&type=&status=&userId=` | admin | Paginated email log with filters. |
| GET | `/api/admin/email/triggers` | admin | List all trigger config rows. |
| GET | `/api/admin/email/triggers/:type` | admin | Get a single trigger config. |
| PUT | `/api/admin/email/triggers/:type` | admin | Update `isEnabled`, `cooldownHours`, `thresholdJson`, `templateId`. |
| GET | `/api/admin/email/preferences/:userId` | admin | Read a specific user's preferences. |
| PUT | `/api/admin/email/preferences/:userId` | admin | Update a specific user's preferences (admin override). |

## Admin — Asset Gallery

Mounted at `/api/admin/gallery`. Provides CRUD over a host-level image archive (default `$HOME/image-archive`, override via `IMAGE_ARCHIVE_ROOT`) and file binary serving with magic-byte Content-Type detection. All routes require an authenticated admin session with 2FA enrolled. The `/files/*` endpoint is a high-volume binary CDN and skips rate limiting when a session cookie is attached; all other gallery routes share a dedicated 2000 req/min limiter distinct from the main admin limiter.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/admin/gallery/assets` | admin + 2fa | List every asset in the archive with its sidecar metadata. Returns `{ assets: AssetMetadata[], categories: string[] }`. Category list is the unique sorted set across all returned assets. The server walks the archive directory on every request, so newly written files appear without any rebuild or restart. |
| GET | `/api/admin/gallery/assets/*` | admin + 2fa | Get a single asset's metadata. The `*` wildcard is the relative path under the archive's `images/` directory (slashes allowed, URL-encode each segment). Returns 404 if the file doesn't exist, 400 on path-traversal attempts. |
| PATCH | `/api/admin/gallery/assets/*` | admin + 2fa | Update an asset's sidecar JSON. Body accepts a partial: `{ title?, category?, tags?, description?, prompt?, aspectRatio?, source? }`. Unknown keys are stripped; string fields are length-capped; `tags` is capped at 50. |
| DELETE | `/api/admin/gallery/assets/*` | admin + 2fa | Delete both the image file and its sidecar. Returns 204 on success, 404 if the file doesn't exist. Empty parent directories are cleaned up best-effort. |
| GET | `/api/admin/gallery/files/*` | admin + 2fa | Stream the raw image bytes. `Content-Type` is detected from magic bytes (PNG, JPEG, WebP, GIF) so mismatched extensions still render in browsers under `X-Content-Type-Options: nosniff`. Falls back to `application/octet-stream` for unknown formats. |
| POST | `/api/admin/gallery/upload` | admin + 2fa | Upload one or more image files. `multipart/form-data` with `files` (1–50 files, 20 MB each) plus form fields: `namespace` (required — slugified subdirectory under `images/`), `category?`, `title?` (single-file only), `tags?` (comma-separated), `description?`. Every file is magic-byte-validated before any write; the extension is normalized to match actual bytes; filename collisions append `-2`, `-3`, ... atomically via `O_CREAT | O_EXCL`. Returns 201 `{ assets: AssetMetadata[], failures: [{ filename, error }] }`. |

### AssetMetadata shape

```ts
interface AssetMetadata {
  id: string;           // path relative to images/, e.g. "avatars/pirate.png"
  filename: string;
  title: string;
  category: string;     // drives the gallery tab grouping
  tags: string[];
  description?: string;
  prompt?: string;      // the generator prompt, if known
  model?: string;       // e.g. "gemini-3-pro-image-preview"
  aspectRatio?: string;
  createdAt: string;    // ISO; falls back to file birth time
  updatedAt?: string;
  source?: "generated" | "migrated" | "imported";
  sizeBytes: number;
}
```

## Analytics

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/events/track` | Visitor cookie | Client-side event beacon. Body: `{ tabId, sentAt, events: [{ name, category?, properties?, path, ts, seq, clientEventId }] }`. Returns `204` (fire-and-forget). Rate-limited 120/min per IP. Respects `DNT` / `Sec-GPC` headers. See `docs/ANALYTICS.md`. |
| GET | `/api/admin/gdpr/export?userId=<id>` | Admin + 2FA | GDPR right-to-access. Returns JSON of all analytics rows for the user (events, sessions, profiles, aliases). |
| DELETE | `/api/admin/gdpr/forget?userId=<id>` | Admin + 2FA | GDPR right-to-delete. Cascades delete across events, analytics_sessions, visitor_profile, visitor_aliases. Returns `{ ok: true, counts: { events, sessions, profiles, aliases } }`. |

## Streamer Bot Relay

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/streamer/stats` | None | Returns `{ stats: { wins, losses, streak, mood?, winRate? } | null }` — the most recent payload published by the 24/7 streamer-bot. Used by the broadcast page to hydrate the BotCard on first mount before any Socket.IO event arrives. |
| POST | `/api/streamer/stats` | `X-Streamer-Bot` shared secret | Bot pushes its current stats. Body: `{ wins, losses, streak, mood?, winRate? }` (mood ∈ neutral/happy/frustrated/focused). Server stores the latest in memory and emits `streamer:stats` to every connected socket. Returns `403` without a valid header, `400` for malformed payloads, `{ ok: true }` on success. See `docs/STREAMER.md` § "Server-mediated overlay relays". |
| GET | `/api/streamer/music` | None | Returns `{ music: { title, artist?, album? } | null }` — the most recent "now playing" track from the bot's mpd source. `null` means the queue is stopped or the bot has never published. |
| POST | `/api/streamer/music` | `X-Streamer-Bot` shared secret | Bot pushes the current track. Body: `{ title, artist?, album? }` or `null` (queue stopped). Emits `streamer:music`. Same auth + error semantics as `POST /stats`. |
| GET | `/api/streamer/nn-tick` | None | Returns `{ tick: VisualTick \| null }` — the most recent NN visualisation tick published by the bot's online-learning subsystem. Used by `?broadcast=1` viewers to hydrate the five NN panels on first mount before any Socket.IO event arrives. See `docs/WEBSOCKET_EVENTS.md` § `streamer:nn-tick` for the full payload schema. |
| POST | `/api/streamer/nn-tick` | `X-Streamer-Bot` shared secret | Bot pushes a fresh `VisualTick` after each round (when `STREAMER_LEARNING_MODE !== "off"`). Server validates field-by-field via `parseNnTickPayload`, clips oversized arrays (≤8 layers, ≤256 weight samples, ≤60 recent losses, ≤16 recent accuracy buckets, ≤200-char strings), stores the latest in memory, and emits `streamer:nn-tick` to every connected socket. Returns `403` without a valid header, `400` for malformed payloads, `{ ok: true }` on success. |
| POST | `/api/streamer/reset-learning` | `X-Streamer-Bot` shared secret | Operator clears the cached NN tick and emits a null `streamer:nn-tick` fan-out so every `?broadcast=1` panel returns to idle. Pair this with the bot-streamer's own `POST :9101/reset-learning` (same auth) to also wipe the worker's in-memory state — see `docs/STREAMER.md` § "Reset endpoint". |

## Utility

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/exchange-rates` | Currency exchange rates (via frankfurter.app) |
| GET | `/api/image/:productId` | Image proxy (scrapes Amazon if needed) |
| GET | `/api/settings/banner` | Public banner settings (unauthenticated) |
| GET | `/api/settings/game-modes` | Public disabled game modes (unauthenticated). Returns `{ disabledModes: string[] }` |
| GET | `/api/settings/legal/:key` | Public legal documents (unauthenticated). Key: `privacy_policy` or `terms_of_service`. Returns `{ content }` (markdown). Returns 404 when the corresponding page (`privacy` or `terms`) is disabled via the admin visibility toggle. |

**Source**: `apps/server/src/routes/*.ts`
