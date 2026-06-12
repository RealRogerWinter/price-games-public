---
title: User Accounts
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: features
summary: "Registration, OAuth (Google, Facebook, Amazon), sessions, password reset."
related_code:
  - apps/server/src/routes
---
# User Accounts

Players can optionally create an account for persistent identity, game history tracking, rewards, and leaderboard attribution. **Guest (anonymous) play is fully supported** — accounts are never required.

## Features

- **Registration** with username, email, and password (Cloudflare Turnstile CAPTCHA when configured)
- **Login** via email or username
- **OAuth login** via Google, Facebook, and Amazon (when configured)
- **Settings page** with rewards, referral dashboard, notification preferences, and account settings
- **Scoreboard page** with lifetime score, streak, interactive game history panel
- **Automatic username** — logged-in users' usernames auto-populate for leaderboard submissions and multiplayer rooms
- **Game history** — single-player and multiplayer games recorded with scores, modes, and placements; interactive chart with score trends
- **Rewards** — gift card rewards awarded by admin, claimable from settings page
- **Referral system** — unique referral codes with shareable links, referral tracking dashboard, giveaway bonus entries

## Registration

`POST /api/user/register` with `{ username, email, password, referralCode?, turnstileToken }`.

- Username: alphanumeric + underscore, 3-20 characters, must be unique (case-insensitive), reserved names blocked
- Email: must be unique, disposable email domains blocked, verification email sent on registration
- Password: minimum 10 characters (configurable), bcrypt-hashed (cost factor 12)
- Referral code: optional 8-character code from an existing user; creates a pending referral credited after email verification
- Turnstile: Cloudflare Turnstile CAPTCHA token required when `TURNSTILE_SECRET_KEY` is configured
- Rate limited: 3 registrations per hour per IP

## Login

`POST /api/user/login` with `{ identifier, password, stayLoggedIn? }` where `identifier` can be email or username and `stayLoggedIn` is an optional boolean (defaults to `true` for backwards compatibility with pre-flag clients).

- Sets httpOnly session cookie (SameSite=Strict, Secure in production)
- **Stay logged in behavior:**
  - `stayLoggedIn=true` (or omitted): persistent cookie with 30-day absolute expiry, 7-day idle timeout
  - `stayLoggedIn=false`: browser-session cookie (deleted on browser close) backed by a 24-hour server-side session cap (`USER_SHORT_SESSION_DURATION_MS`, default 24h) so a misbehaving browser that holds the cookie past the session cannot keep using it
- Max 5 concurrent sessions (oldest evicted) — enforced on both long and short sessions
- Account lockout: 5 failed attempts triggers 15-minute lock
- Login rate limited: 10 attempts per 15 minutes per IP
- Generic "Invalid credentials" error (no user-existence leaking)
- The web client (`LoginForm`) exposes `stayLoggedIn` as an opt-in checkbox that defaults to unchecked (classic "remember me" UX). Other login paths (register auto-login, password change re-login, OAuth callback) always create persistent sessions because there is no form interaction to surface the toggle.

## Password Management

- **Change password**: `PUT /api/user/password` with `{ currentPassword, newPassword }` — invalidates all other sessions
- **Forgot password**: `POST /api/user/forgot-password` with `{ email }` — sends reset email
- **Reset password**: `POST /api/user/reset-password` with `{ token, password }`

## Email Management

- **Change email**: `PUT /api/user/email` with `{ email, password }` — requires password confirmation
- **Verify email**: `POST /api/user/verify-email` with `{ token }`
- **Resend verification**: `POST /api/user/resend-verification`

## OAuth Setup (Optional)

To enable Google, Facebook, and/or Amazon login, set the following environment variables:

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Facebook OAuth
FACEBOOK_APP_ID=your-app-id
FACEBOOK_APP_SECRET=your-app-secret

# Amazon OAuth (Login with Amazon)
AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxx
AMAZON_CLIENT_SECRET=your-client-secret

# Required when any OAuth provider is configured.
# Set this to your own deployment's public base URL (the public site uses
# https://price.games). The OAuth callback path is appended to this base,
# so it must match the redirect URI registered with each provider.
OAUTH_CALLBACK_BASE=https://your-deployment-domain.example
```

OAuth buttons are automatically hidden from the UI when provider credentials are not configured.

### OAuth Flow
1. Client checks `GET /api/user/oauth/providers` to discover available providers
2. User clicks provider button, redirected to `GET /api/user/oauth/{provider}`
3. Provider authenticates and redirects to callback URL
4. Server exchanges authorization code for tokens, creates/links user account
5. Session cookie set, user redirected to app

### Security
- CSRF state tokens: single-use, 10-minute expiry, capped at 10k pending
- Facebook: access token sent in Authorization header (not URL)
- Amazon: access token sent in Authorization header (not URL)
- Google: email_verified check required
- Amazon: phone-only accounts (no email on file) are rejected with a user-facing error
- Email-match linking guard: won't overwrite existing OAuth provider
- `OAUTH_NO_PASSWORD` sentinel for OAuth-only accounts

## Game History

`GET /api/user/history?limit=20&offset=0&gameType=single|multiplayer&gameMode=classic`

Returns paginated game history with:
- Game mode and type (single-player or multiplayer)
- Score and placement (multiplayer)
- Date played
- Session/room identifiers

`GET /api/user/score-history?days=30` returns daily score aggregates for chart display (max 365 days).

### Interactive Game History Panel

The scoreboard page includes an interactive `GameHistoryPanel` component showing:
- Score trend chart over time
- Filterable game list by mode and type
- Per-game score breakdowns

## User Stats

`GET /api/user/stats`

Aggregate statistics:
- Total games played (single + multiplayer)
- Best score per mode
- Lifetime cumulative score
- Win/placement stats (multiplayer)

## Rewards

- `GET /api/user/monthly-points` — points and games played in the current calendar month (used by the home page reward tracker to show progress toward the monthly giveaway threshold)
- `GET /api/user/rewards` — list awarded rewards (gift card codes masked, showing last 4 characters)
- `POST /api/user/rewards/:id/claim` — claim a reward, reveals full gift card code

### Monthly Giveaway
Users who earn enough points in a calendar month (threshold configured by admin) are entered into a random drawing. Requirements:
- Must be registered with a **verified email address**
- Must earn the minimum qualifying points within the current month
- Winners are selected randomly once per month and notified by email

The home page displays a **Reward Tracker** progress bar showing the user's monthly points toward the qualifying threshold. A **Giveaway Details** modal (accessible from the promo banner) explains the full rules.

Rewards are created and awarded by admins. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for the admin side.

## Referral System

Each user receives a unique 8-character referral code at registration, with a shareable URL (`/r/CODE`).

### Referral Flow
1. User shares their referral link `/r/CODE`
2. Visitor lands on the site, referral code saved to sessionStorage
3. Visitor registers — referral code submitted with registration form
4. Pending referral created
5. On email verification, the referral is evaluated and credited or rejected

### Anti-Abuse Protections
- IP matching: referrer and referred cannot share the same IP
- Disposable email domains rejected at registration
- Multi-account detection checks existing accounts from the same IP
- Cloudflare Turnstile CAPTCHA required on all registrations

### Referral Dashboard
`GET /api/user/referrals` returns the user's referral code, total/credited/pending counts, and referral history. Displayed in the `ReferralDashboard` component on the settings page.

### Giveaway Integration
Credited referrals grant bonus entries in the monthly random roll. Each qualifying player's entry count = 1 (base) + number of credited referrals.

## Push Notifications

Users can opt in to Web Push notifications for various event types:

- **Subscribe**: `POST /api/push/subscribe` saves a Web Push subscription (one user can have multiple devices/browsers)
- **Unsubscribe**: `POST /api/push/unsubscribe` removes a subscription
- **Preferences**: `GET/PUT /api/push/preferences` manages notification categories:
  - `daily_puzzle` — new daily challenge available
  - `streak_reminder` — reminder before daily streak resets
  - `leaderboard_updates` — leaderboard position changes
  - `multiplayer_invites` — multiplayer game invitations
  - `promotional` — promotional notifications
  - Quiet hours: `quiet_hours_start/end` + `timezone`
- **In-app**: Real-time notifications are also delivered via Socket.IO (`notification:received` event) as toast notifications

See [API_REFERENCE.md](API_REFERENCE.md#push-notifications-user-facing) for endpoint details.

## Avatars

Available multiplayer avatars: bear, fox, owl, cat, dog, panda, penguin, rabbit, koala, tiger, whale, octopus.

See [API_REFERENCE.md](API_REFERENCE.md) for full endpoint details.
