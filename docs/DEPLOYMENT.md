---
title: Deployment
status: stable
last_reviewed: 2026-06-03
owner: infra
audience: operator
category: operations
summary: "Running in production: Docker, Caddy, CI/CD, env vars."
related_code:
  - Dockerfile
  - docker-compose.prod.yml
  - Caddyfile
  - .circleci
---
# Deployment

## Prerequisites

- Node.js 20+
- npm 9+

## Production Build

```bash
npm run build
```

Builds in order: `packages/shared` -> `apps/server` (tsc) -> `apps/web` (vite build).

The compiled server serves the web frontend's `dist/` as static files, so only **one process** is needed in production.

## Running in Production

### Direct

```bash
node apps/server/dist/index.js
```

### pm2 (Legacy — production now runs via Docker)

> **Note for OSS forkers and contributors:** Production runs from a Docker container (`price-game-app-1` via `docker-compose.prod.yml`). The pm2 instructions below are kept for historical context and may still be useful if you want to run the Node process directly on a small VPS without Docker. The `ecosystem.config.cjs` file in the repo root hardcodes the original developer's directory path, so you'll need to edit it before using pm2 in a fresh deployment.

pm2 keeps the server running, auto-restarts on crashes, and survives reboots.

```bash
# Install pm2 globally
sudo npm install -g pm2

# Start the app
pm2 start ecosystem.config.cjs

# Register pm2 to start on boot
pm2 startup
# Run the sudo command it outputs, then:
pm2 save

# Useful commands
pm2 list                    # Process status
pm2 logs price-game         # View logs (also in ./logs/)
pm2 restart price-game      # Restart after code changes
pm2 monit                   # Real-time monitoring
```

Configuration: `ecosystem.config.cjs` in project root.

## Caddy Reverse Proxy

Caddy handles HTTPS with automatic TLS certificates.

`/etc/caddy/Caddyfile`:
```
price.games {
    reverse_proxy localhost:3001
}
```

Apply after changes:
```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

> `/etc/caddy/Caddyfile` is a copy, not a symlink, so the repo Caddyfile must be explicitly `cp`'d over before restart. Deploys via CI do NOT touch Caddy — any Caddyfile change (e.g. the deploy retry buffer or maintenance page) must be applied by hand on the production host.
>
> **Use `systemctl restart`, not `caddy reload`.** The Caddyfile sets `admin off` for security hardening, which disables the admin API on port 2019 that `caddy reload` depends on. `restart` causes a ~1s Caddy restart — brief but non-zero. If truly seamless Caddy reloads become needed, remove `admin off` first.

The project also includes a `Caddyfile` in the repo root with CSP headers, WebSocket support, a deploy retry buffer (`lb_try_duration`), and an inline maintenance page served via `handle_errors`.

## Docker

Build and run using Docker:

```bash
# Build locally
docker build -t price-game .

# Local development compose (builds from source)
docker compose up -d

# Production compose (pulls from GHCR)
docker compose -f docker-compose.prod.yml up -d
```

Configuration files:
- `Dockerfile` — multi-stage build (node:20-alpine)
- `docker-compose.yml` — local development (builds from source)
- `docker-compose.prod.yml` — production (pulls from GHCR, uses `.env` via `env_file`)
- `docker-compose.sandbox.yml` — sandbox environment

## Deploy Workflow (CI/CD)

Production deployment is fully automated via CircleCI (`.circleci/config.yml`):

1. **Build** — Compiles all workspaces, persists artifacts to workspace
2. **Test** — `test-server` and `test-web` run in parallel (2x parallelism each) with CircleCI testsuite CLI for smart test splitting
3. **Docker Push** (main only) — Builds and pushes to GHCR with three tags:
   - `ghcr.io/$DOCKER_IMAGE_NAME:$SHA` (commit)
   - `ghcr.io/$DOCKER_IMAGE_NAME:1.0.$BUILD_NUM-$SHA` (semver)
   - `ghcr.io/$DOCKER_IMAGE_NAME:latest`
4. **Deploy** (main only) — SSHes to production server, pulls latest image, runs `docker compose -f docker-compose.prod.yml up -d --wait` (blocks until the new container's healthcheck passes), then runs a host-level health check
5. **Rollback** — Triggered via pipeline parameters to revert to a previous version tag

### Deploy downtime

Deploys are **soft zero-downtime** — the user almost never sees a failed request, but a brief swap does happen:

- **Pre-pull** — The CI step runs `docker compose pull` *before* `up -d`, so the image is already on disk when the swap begins. The swap gap is container-stop + container-start only, not image-download.
- **Graceful server shutdown** — The Express server handles `SIGTERM` by closing Socket.IO, draining in-flight HTTP, closing the DB, then exiting. Force-exit timeout is 25s; `docker-compose.prod.yml` sets `stop_grace_period: 30s` so Docker always waits for the clean exit before falling back to `SIGKILL`.
- **Docker healthcheck + `--wait`** — The new container isn't considered ready until `/api/health` responds. `docker compose up -d --wait` blocks until that happens, so CI only reports success once the backend is actually serving.
- **Caddy retry buffer** — The production `Caddyfile` sets `lb_try_duration 15s` / `lb_try_interval 250ms` on the backend reverse_proxy. HTTP requests that arrive during the swap are retried by Caddy until the new container is up, instead of failing with 502. Most users see a slightly-slow request rather than an error.
- **Maintenance page fallback** — If a request can't reach the backend even after retries, Caddy's `handle_errors` serves an inline "Redeploying, be right back" 503 page that auto-reloads after 5s.
- **WebSockets drop** — TCP is pinned to the old container's process, so open Socket.IO connections always drop on swap. The client auto-reconnects (via Socket.IO's built-in reconnection) and lands on the new container, usually in well under a second. In-room game state is rehydrated via the existing rejoin flow — **no shared state store is required**.

### Deploy compatibility rules

Because old and new server code can be serving traffic across the brief swap window (and clients may reconnect from one to the other), every deploy must be compatible with the version it's replacing:

- **DB migrations must be additive** — add columns/tables, don't rename or drop in a single deploy. Destructive changes are split across two deploys: deploy 1 adds the new shape and dual-writes; deploy 2 removes the old shape.
- **REST / Socket.IO payloads must be additive** — don't remove or rename existing fields or event names in a single deploy. A client connected to the old server that reconnects to the new one must not see a missing/renamed event.

### CI/CD Environment Variables (set in CircleCI)

| Variable | Description |
|----------|-------------|
| `GHCR_TOKEN` | GitHub Container Registry token |
| `GHCR_USERNAME` | GHCR username |
| `DOCKER_IMAGE_NAME` | Image name (e.g. `user/price-game`) |
| `DEPLOY_USER` | SSH user for production server |
| `DEPLOY_HOST` | Production server hostname |
| `DEPLOY_PATH` | Path to docker-compose.prod.yml on server |

### Legacy: Direct / pm2

For manual or backup deployments:

```bash
node apps/server/dist/index.js       # Direct
pm2 start ecosystem.config.cjs       # pm2 (auto-restart, boot persistence)
```

## Environment Variables

See `.env.example` for all configurable variables. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `NODE_ENV` | development | Environment (production enables secure cookies) |
| `ADMIN_INITIAL_USERNAME` | — | Initial admin username (first run only) |
| `ADMIN_INITIAL_PASSWORD` | — | Initial admin password (min 12 chars) |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `FACEBOOK_APP_ID` | — | Facebook OAuth app ID |
| `FACEBOOK_APP_SECRET` | — | Facebook OAuth app secret |
| `AMAZON_CLIENT_ID` | — | Amazon (Login with Amazon) client ID |
| `AMAZON_CLIENT_SECRET` | — | Amazon OAuth client secret |
| `OAUTH_CALLBACK_BASE` | — | OAuth callback base URL (e.g. `https://price.games`) |
| `RESEND_API_KEY` | — | Resend API key for transactional emails |
| `EMAIL_FROM` | `Price Games <noreply@price.games>` | From address for outgoing emails |
| `APP_URL` | `http://localhost:5173` | Public app URL for email links |
| `TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile site key (anti-bot) |
| `TURNSTILE_SECRET_KEY` | — | Cloudflare Turnstile secret key |
| `CHROME_EXTENSION_ID` | — | Chrome extension ID for CORS |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (Product Universe AI enrichment) |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API key (Product Universe research) |
| `ALLOWED_ORIGINS` | — | Comma-separated list of allowed CORS origins |
| `VAPID_PUBLIC_KEY` | — | VAPID public key for Web Push notifications |
| `VAPID_PRIVATE_KEY` | — | VAPID private key for Web Push notifications |
| `VAPID_SUBJECT` | `mailto:admin@price.games` | VAPID contact email |
| `DAILY_SEED_SALT` | `dev-daily-salt-do-not-ship` | Seed salt for daily puzzle determinism. **Must change in production** — warns at startup if using default. |
| `ADMIN_2FA_ENCRYPTION_KEY` | — | AES-256-GCM key for encrypting admin TOTP secrets at rest. Required for 2FA functionality. |
| `EMAIL_SCHEDULER_INTERVAL_MS` | `900000` (15 min) | Marketing email scheduler tick interval. See [EMAIL_NOTIFICATIONS.md](./EMAIL_NOTIFICATIONS.md). |
| `EMAIL_GLOBAL_COOLDOWN_HOURS` | `24` | Hard-floor per-user cooldown across all marketing email types. |
| `EMAIL_MAX_PER_TICK` | `50` | Max scheduled emails drained per scheduler tick. |
| `EMAIL_MAX_ATTEMPTS` | `3` | Retry cap for failed scheduled email sends. |
| `EMAIL_UNSUB_SECRET` | — | HMAC secret for one-click unsubscribe tokens. **Required in production** — warns at startup if empty. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `RESEND_WEBHOOK_SECRET` | — | Svix signing secret (`whsec_...`) for the Resend event webhook. **Required for the webhook to function** — when unset, `POST /api/email/webhook/resend` returns 503. |
| `SANDBOX` | unset | When `=1`, marks the process as the sandbox build. Gates the sandbox-only test-bypass flags below. **Never set in production.** |
| `SKIP_TURNSTILE` | unset | Sandbox-only. Disables Turnstile gating on register/login/contact. Requires `SANDBOX=1`. **Never set in production.** |
| `SKIP_ADMIN_2FA` | unset | Sandbox-only. Disables 2FA enforcement on the admin panel. Requires `SANDBOX=1`. **Never set in production.** |
| `SKIP_INVITE_IP_CHECKS` | unset | Sandbox-only. Disables IP/cookie anti-abuse on the multiplayer invite reward flow so tests can run from one machine. Requires `SANDBOX=1`. **Never set in production.** |

### Streamer-bot env vars (Pricey)

The autonomous streaming bot's env surface is documented in [`streamer/deploy.md`](./streamer/deploy.md) and `.env.example` (the `STREAMER_*` block). Key vars: `STREAMER_TARGET_URL`, `STREAMER_BOT_DISPLAY_NAME`, `STREAMER_TTS_VOICE_MODEL`, `STREAMER_TWITCH_KEY`, `STREAMER_YOUTUBE_KEY`, `STREAMER_KICK_KEY`, `STREAMER_TWITCH_CHANNEL`, `STREAMER_MUSIC_HOST_DIR`, `STREAMER_LEARNING_ENABLED`, `STREAMER_LEARNING_MODE`, `LEARNING_FORCE_HEURISTIC` (kill-switch). The bot's container is independent of the app container — leaving these unset just means the bot doesn't boot.

### Generating secrets

```bash
# 32-byte hex key (DAILY_SEED_SALT, ADMIN_2FA_ENCRYPTION_KEY)
openssl rand -hex 32

# 48-byte hex secret (EMAIL_UNSUB_SECRET)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# VAPID key pair (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY)
npx web-push generate-vapid-keys

# Strong admin initial password (ADMIN_INITIAL_PASSWORD)
openssl rand -base64 18
```

### Deploying your own fork

The CircleCI pipeline ships docker images to GitHub Container Registry and SSH-deploys to a single host. To run it for your own fork, set these env vars in your CircleCI project settings:

| Var | Example | Notes |
|---|---|---|
| `GHCR_USERNAME` | `myuser` | GitHub username with write access to your fork's GHCR. |
| `GHCR_TOKEN` | `ghp_...` | GitHub personal access token with `write:packages`. |
| `DOCKER_IMAGE_NAME` | `myuser/price-game` | Image name within your registry. |
| `DEPLOY_HOST` | `myhost.example.com` | SSH hostname of the deploy target. |
| `DEPLOY_USER` | `deploy` | SSH user (sudo-capable for `docker compose`). |
| `DEPLOY_PATH` | `/opt/price-game` | Directory on the host containing `docker-compose.prod.yml`. |
| `SSH_PRIVATE_KEY` | (key contents) | Private half of the deploy key registered in `~/.ssh/authorized_keys` on the host. |

The deploy step on the host runs `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`. The streamer container has its own lifecycle (see [`streamer/deploy.md`](./streamer/deploy.md)) and is **not** redeployed by the app pipeline — that's intentional, so a small web tweak doesn't restart the live broadcast.

### Frontend Environment (`apps/web/.env.production`)

The GA4 measurement ID is committed in `apps/web/.env.production` because it is a public, non-sensitive value (visible in every page load). Vite bakes it into the JS bundle at build time.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_GA_MEASUREMENT_ID` | — | GA4 measurement ID (e.g. `G-XXXXXXXXXX`). Omit to disable analytics. |
| `VITE_REDDIT_PIXEL_ID` | — | Reddit Pixel ID (e.g. `a2_xxxxxxxxxxxx`). Enables Reddit ad conversion tracking and retargeting. Omit to disable. |
| `VITE_TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile site key (baked into frontend bundle at build time). |

To override locally, set the variable in `apps/web/.env` (gitignored).

## Tailscale Admin Access

The admin panel (`/admin`, `/api/admin/*`) is blocked on the public internet via Caddy and only accessible through the Tailscale network. This provides network-level access control on top of session-based authentication.

### Server Setup

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate to your tailnet
sudo tailscale up

# Expose the Express app on the tailnet with automatic HTTPS
sudo tailscale serve --https=443 http://localhost:3001

# Verify
tailscale serve status
```

After `tailscale up`, note the assigned hostname (e.g., `price-server.tail12345.ts.net`). Build the Chrome extension with that hostname injected via the `VITE_EXTENSION_API_BASE` env var (see `apps/extension/.env.example`), then redistribute:

```bash
VITE_EXTENSION_API_BASE="https://<tailscale-hostname>.ts.net/api/admin" \
  npm run build -w apps/extension
```

The hostname is not checked into git, so re-provisioning the Tailscale node does not require a commit — only a rebuild.

### Admin Access

Install the Tailscale client on your device, join the tailnet, then access:

```
https://<tailscale-hostname>.ts.net/admin
```

### Admin Serve Self-Healing

The admin-panel access described above depends on a single `tailscale serve`
rule (HTTPS port 443 → `http://localhost:3001`). If that rule is ever removed
— whether by an accidental `tailscale serve --https=443 off`, a tailscaled
state reset, or a confused sandbox cleanup — the admin panel goes dark.

To prevent that class of outage, the repo ships an **idempotent ensure-script**
and a **systemd timer** that self-heals within 5 minutes.

#### The ensure-script

[`scripts/ensure-admin-tailscale-serve.sh`](../scripts/ensure-admin-tailscale-serve.sh)
reads the current `tailscale serve status --json` output, verifies that the
admin rule is present and points at `http://localhost:3001`, and re-installs
it if not. Safe to run repeatedly — a no-op when the rule is healthy.

```bash
# Run manually any time admin access looks wrong:
bash scripts/ensure-admin-tailscale-serve.sh
```

#### systemd timer (one-time install per host)

The systemd units live under [`infra/systemd/`](../infra/systemd/). Install
them once per deploy target:

```bash
# Install the ensure-script to a stable path (decoupled from the repo).
sudo install -m 0755 \
  scripts/ensure-admin-tailscale-serve.sh \
  /usr/local/bin/ensure-price-game-admin-serve.sh

# Install the systemd unit + timer.
sudo cp infra/systemd/price-game-admin-serve.service /etc/systemd/system/
sudo cp infra/systemd/price-game-admin-serve.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now price-game-admin-serve.timer
```

After install, the ensure-script runs 30 s after every boot and every 5 min
thereafter. Verify:

```bash
systemctl list-timers price-game-admin-serve.timer
journalctl -u price-game-admin-serve.service -n 20
```

When the ensure-script changes in the repo, refresh the installed copy:

```bash
sudo install -m 0755 \
  scripts/ensure-admin-tailscale-serve.sh \
  /usr/local/bin/ensure-price-game-admin-serve.sh
```

#### Reserved ports

Port **443** is reserved for the admin Tailscale serve rule. The sandbox
tooling (`scripts/sandbox.sh` and `scripts/sandbox-config.mjs`) will refuse
any operation with `SANDBOX_PORT=443` — use 3002, 3003, etc. instead. This
guardrail exists because a previous fat-fingered sandbox cleanup ran
`tailscale serve --https=443 off` and wiped admin access.

### Troubleshooting

**`/admin` returns 404 or times out over Tailscale:**

1. Check the serve rule exists:
   `sudo tailscale serve status` should show
   `https://<hostname>/ → proxy http://localhost:3001`.
2. If it's missing, run `bash scripts/ensure-admin-tailscale-serve.sh` to
   restore it immediately, or wait up to 5 min for the systemd timer.
3. If the rule is present but `/admin` still fails, check the backend:
   `curl http://localhost:3001/api/health` should return 200.
4. Check the unit logs: `journalctl -u price-game-admin-serve.service -n 50`.

### Break-Glass Procedure

If Tailscale is unavailable, use an SSH tunnel:

```bash
ssh -L 3001:localhost:3001 user@server-public-ip
# Access via local TLS proxy (admin cookies require Secure flag):
caddy reverse-proxy --from localhost:8443 --to localhost:3001
# Then open https://localhost:8443/admin
```

Alternatively, uncomment the break-glass section in the Caddyfile to temporarily restore public admin access, then reload Caddy.

## Tailscale Streamer Access

The streamer-bot's broadcast overlay (`?broadcast=1`) is restricted to the Tailscale network for the same reasons the admin panel is: it is an operator surface that exposes internal state (model beliefs, NN tick stream, mood pipeline) and is not intended for public consumption.

The block is enforced at two layers:

1. **Caddy** — both the production `price.games` vhost and the `sandbox.price.games` vhost return 404 for any request whose query string contains `broadcast=1`. (See the `@broadcast` named matchers in [`Caddyfile`](../Caddyfile).)
2. **Express** — [`apps/server/src/middleware/broadcastAccess.ts`](../apps/server/src/middleware/broadcastAccess.ts) does the same check in-process so a misconfigured Caddy can't accidentally widen the exposure.

The tailnet route, established by `tailscale serve --https=443 http://localhost:3001` (the same rule that gates `/admin`), reaches the Express backend without going through Caddy and therefore has no broadcast restriction. That is the URL the streamer-bot's Chromium opens.

### Bot configuration

In the streamer container's `.env`, set `STREAMER_TARGET_URL` to the host's tailnet hostname:

```bash
STREAMER_TARGET_URL=https://<tailscale-hostname>.ts.net
```

The bot validates this at boot via [`resolveTargetUrl`](../packages/bot-streamer/src/runner/targetUrl.ts) and refuses to start if the value is unset or points at a known-public host (`price.games`, `www.price.games`, `sandbox.price.games`). There is no `https://price.games` fallback — the env var must be set explicitly.

### Verifying the block

From a non-tailnet host (e.g. a phone on cellular, or `curl` from anywhere outside the tailnet):

```bash
curl -I "https://price.games/?broadcast=1"
# expected: HTTP/2 404
```

From a tailnet device:

```bash
curl -I "https://<tailscale-hostname>.ts.net/?broadcast=1"
# expected: HTTP/2 200 (the broadcast shell HTML)
```

If the public-domain request returns 200, either the Caddy `@broadcast` block is missing (check `sudo caddy reload` after editing the Caddyfile) or `BROADCAST_BLOCKED_HOSTS` has been customised away from the defaults. The Express middleware reads `BROADCAST_BLOCKED_HOSTS` from the container env; default `price.games,www.price.games,sandbox.price.games`.

## Sandbox Tailscale Mode

By default, the sandbox binds to `127.0.0.1` and is exposed via `tailscale serve`, making it accessible only to devices on your tailnet. The Tailscale URL is printed to the console after startup.

```bash
npm run sandbox                          # Build and start (Tailscale-only by default, port 3002)
npm run sandbox:down                     # Stop and remove container
npm run sandbox:rebuild                  # Full rebuild (no Docker cache)
npm run sandbox:seed                     # Seed test products into sandbox DB
SANDBOX_TAILSCALE=0 npm run sandbox      # Public via Caddy (sandbox.price.games)
SANDBOX_PORT=3003 npm run sandbox        # Custom port (for worktree isolation)
```

When Tailscale mode is enabled, the sandbox URL will be:
```
https://<tailscale-hostname>.ts.net:<port>/
```

Set `SANDBOX_TAILSCALE=0` to restore public access via the Caddy reverse proxy.

> **Reserved port:** `SANDBOX_PORT=443` is rejected by the sandbox scripts —
> that port belongs to the admin Tailscale serve rule. See
> [Admin Serve Self-Healing](#admin-serve-self-healing) above for the full
> story.

## Health Check

`GET /api/health` — returns 200 when the server is running and the database is accessible.

## Database Backup

```bash
npm run backup -w apps/server          # Create backup
npm run restore -w apps/server         # Restore from backup
npm run backup:status -w apps/server   # Check backup status
```

See [DATABASE.md](DATABASE.md) for schema and migration details.
