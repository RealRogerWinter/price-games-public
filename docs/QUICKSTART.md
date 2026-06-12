---
title: Quickstart
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: getting-started
summary: "Fork → clone → install → run, with the minimum env config."
related_code:
  - package.json
  - apps
  - .env.example
---
# Quickstart

A linear path from `git clone` to a working local dev server. If you just want the system overview, read [`ARCHITECTURE.md`](./ARCHITECTURE.md) instead.

## Prerequisites

- **Node.js 20.19+** ([nodesource](https://github.com/nodesource/distributions), `nvm`, or your package manager)
- **npm 10+** (ships with Node 20)
- **git**
- *(Optional)* **Docker + docker-compose** — only needed for the sandbox environment or to run the streamer bot locally

No system-wide SQLite install is required; `better-sqlite3` ships its own binary.

## 1. Clone and install

```bash
git clone https://github.com/price-games/price-game.git
cd price-game
npm install
```

This installs the root + every workspace (`apps/server`, `apps/web`, `apps/extension`, `packages/shared`, `packages/bot-streamer`). First install takes 1–2 minutes.

## 2. Create your `.env`

```bash
cp .env.example .env
```

`.env.example` is the source of truth and runs to ~350 lines, most of it heavily commented. For local development, **almost every var is optional**. The only ones you must address before first run:

| Var | Why | What to do for local dev |
|---|---|---|
| `NODE_ENV` | Mode | Set to `development`. |
| `PORT` | API server port | Default `3001` is fine. |
| `ADMIN_INITIAL_USERNAME` + `ADMIN_INITIAL_PASSWORD` | Seeds the first admin so you can sign in to `/admin` | Set them. They're only used on a fresh DB. **Remove from `.env` after first login.** |
| `ADMIN_2FA_ENCRYPTION_KEY` | 2FA is mandatory for admin accounts | Generate with `openssl rand -hex 32` and paste in. Without this, the admin panel boots in a degraded state. |

Everything else (OAuth, Turnstile, Resend email, VAPID push, Twitch streamer keys, …) is **off by default**. Set them only when you want to exercise that feature. The fallbacks are sensible — sign-up works without Turnstile, email-verification is skipped without Resend, OAuth providers don't render their buttons without credentials.

If you'd rather start from a minimal `.env`, the truly required block is:

```ini
NODE_ENV=development
PORT=3001
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=replace-this-with-a-strong-password
ADMIN_2FA_ENCRYPTION_KEY=<paste the output of: openssl rand -hex 32>
```

## 3. Seed the database

```bash
npm run seed
```

This creates `apps/server/data/app.db` and populates it with a sample product catalog so the game is playable end-to-end on first boot. Re-running the seed is idempotent — it skips products that already exist.

The seed file is a small curated set (~hundreds of products). For a more realistic dataset, import via the Chrome extension (see [`EXTENSION.md`](./EXTENSION.md)) after you have a working dev server and admin login.

## 4. Run the dev server

```bash
npm run dev
```

This runs the server and the web client concurrently:

- **Web (Vite)** — `http://localhost:5173` (the URL you'll actually visit)
- **Server (Express + Socket.IO)** — `http://localhost:3001` (Vite proxies `/api` and `/socket.io` here)

Open the web URL, create an account, and play a round.

## 5. Sign in as admin

Once the seed has run and `ADMIN_INITIAL_USERNAME`/`ADMIN_INITIAL_PASSWORD` are set, visit `http://localhost:5173/admin/login`. Log in with the credentials you set; you'll be walked through 2FA enrollment on first login (scan the QR with any TOTP app — Authy, 1Password, Google Authenticator).

After you log in successfully **once**, remove `ADMIN_INITIAL_USERNAME` and `ADMIN_INITIAL_PASSWORD` from `.env`. They're only consulted to seed an empty `admin_users` table.

## 6. Run the tests

```bash
npm test                # all tests (server + web)
npm run test:server     # server only
npm run test:web        # web only
```

Typecheck (faster than tests, catches most errors):

```bash
npx tsc --noEmit -p apps/server/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

Coverage thresholds are enforced in CI: **server ≥ 85% line and branch**, **web ≥ 75%**. If your change drops below those, CI will fail — add tests before merging.

## Optional: sandbox environment

The sandbox spins up a production-shaped Docker stack on a different port and database, so you can manually QA changes against the same Express + Caddy topology that runs in prod.

```bash
npm run sandbox            # builds + starts on port 3002 → http://localhost:3002
npm run sandbox:seed       # one-time seed
npm run sandbox:down       # tear down
npm run sandbox:rebuild    # nuke and rebuild from source
```

Each git worktree can have its own sandbox by setting `SANDBOX_PORT=<port>`. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full sandbox story.

## Optional: run the streamer bot locally

The autonomous Twitch bot ("Pricey") lives in `packages/bot-streamer/`. Most bot development needs no Docker — unit tests run against fakes. To exercise the full lifecycle (Chromium + Playwright + Piper TTS), see [`streamer/dev.md`](./streamer/dev.md).

## Where to go next

- **Architecture overview** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Adding a feature?** → [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the workflow, then the relevant `docs/` doc per the doc-update checklist.
- **Adding a new game mode?** → [`GAME_MODES.md`](./GAME_MODES.md) "How to Add a New Game Mode".
- **Streamer-bot work?** → [`streamer/architecture.md`](./streamer/architecture.md).
- **Deploying your own fork?** → [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Troubleshooting

**`better-sqlite3` build error during `npm install`.** Make sure you're on Node 20.19+ and have build essentials (`apt install build-essential` on Debian/Ubuntu, `xcode-select --install` on macOS). Then `npm rebuild better-sqlite3`.

**Port 3001 / 5173 already in use.** Set `PORT` in `.env` and Vite will pick up its config from `apps/web/vite.config.ts`.

**`/admin/login` says "no admin users".** Confirm `ADMIN_INITIAL_USERNAME` + `ADMIN_INITIAL_PASSWORD` are set in `.env`, then restart the dev server — they're only consulted at startup against an empty `admin_users` table.

**OAuth provider buttons missing.** Expected — they only render when the corresponding `OAUTH_<PROVIDER>_CLIENT_ID` env var is set. Local development can use email/password.

**Sign-up rejected with "captcha required".** Cloudflare Turnstile is required when `TURNSTILE_SECRET_KEY` is set. Either set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to real values (see [Cloudflare's docs](https://developers.cloudflare.com/turnstile/)) or leave both unset for local dev.

**Email verification link broken.** Without `RESEND_API_KEY`, verification emails are no-ops. Users still get created and can play; verification status just stays `pending`.

**Tests pass locally but fail in CI.** Almost always coverage: CI runs `test:coverage` and fails if it drops below thresholds. Run `npm run test:coverage` locally to see which file is the culprit.
