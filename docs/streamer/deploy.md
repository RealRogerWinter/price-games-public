---
title: Streamer — Deploy
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: operator
category: streamer
summary: Dockerfile variants, env vars, healthchecks, off-host migration.
related_code:
  - infra/streamer
  - packages/bot-streamer
---
# Streamer Bot — Deployment

> Container images, environment, runtime contract. For the production operator runbook (persona swaps, music updates, monitoring), the canonical source is [`../STREAMER.md`](../STREAMER.md). This doc is the contributor-facing reference for the image and its config surface.

## Two images

The bot ships in two Dockerfile flavors:

| Image | File | Used for | Includes |
|---|---|---|---|
| **Production** | [`infra/streamer/Dockerfile`](../../infra/streamer/) | Live 24/7 broadcast | Chromium + Xvfb + Pulseaudio + Piper + ONNX voice + mpd + ffmpeg + nginx-rtmp + bot runner |
| **Sandbox-TTS** | [`Dockerfile.sandbox-tts`](../../Dockerfile.sandbox-tts) | Local / sandbox testing | Same as above **except** Piper is stubbed to emit silence (no voice-model download). |

The sandbox-TTS image builds in ~2 minutes vs ~10–15 for production. Use it whenever you don't need to verify audio output.

The production image is built and shipped **out-of-band** from the main repo's CI — the streamer can ship on its own cadence without retesting everything in the app monorepo every time. The build is triggered by [`scripts/streamer-redeploy.sh`](../../scripts/streamer-redeploy.sh) [ops-only].

## Image layers (production)

Rough order in [`infra/streamer/Dockerfile`](../../infra/streamer/):

1. **Base**: Debian 12 slim + Node 20.19+.
2. **Headed-browser stack**: Xvfb, Pulseaudio, fonts, X11 utils, Chromium-runtime deps (via Playwright's `npx playwright install-deps`).
3. **ffmpeg + nginx-rtmp**: x11grab + pulse capture, x264 encode, push to nginx-rtmp loopback. nginx-rtmp fans out to YouTube/Twitch/Kick.
4. **Piper TTS**: binary download + ONNX voice model. Voice model URL is content-addressed (SHA-256 verified before use).
5. **mpd**: music player daemon, configured to read from `STREAMER_MUSIC_HOST_DIR` (host volume mount).
6. **Bot runner**: `COPY . /app`, `npm ci`, `npm run build -w packages/bot-streamer`, `CMD ["node", "dist/runner/main.js"]`.
7. **Healthcheck**: `HEALTHCHECK CMD curl -fsS http://localhost:9101/healthz || exit 1`.

## Runtime topology

```
┌─ Host (any Debian/Ubuntu with Docker) ───────────────────────────────┐
│                                                                       │
│  app (existing game container)        streamer (this bot)             │
│  ├ Express+Socket.IO                  ├ Xvfb :100 (1920×1080@30)      │
│  ├ port 3001 (loopback)               ├ Chromium (Playwright)         │
│                                       │   └ https://<target>/?broadcast=1│
│                                       ├ Pulseaudio sink "broadcast"   │
│                                       │   ├ mpd (music)               │
│                                       │   └ piper (TTS)               │
│                                       ├ ffmpeg (x11grab + pulse → x264)│
│                                       ├ nginx-rtmp (loopback)         │
│                                       │   └ push fan-out → YT/TW/KICK │
│                                       └ /healthz + /status :9101 loopback│
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

`STREAMER_TARGET_URL` points the bot at the game it should play. Production points at the public domain (`https://price.games/?broadcast=1`). Local dev points at `http://host.docker.internal:3001` or a Tailscale hostname.

## Env vars

Defined and documented in [`.env.example`](../../.env.example) under the streamer section. The ones that matter for deployment:

### Required for streaming

| Var | Purpose |
|---|---|
| `STREAMER_TARGET_URL` | Game URL the bot plays against. **Required.** |
| `STREAMER_BOT_DISPLAY_NAME` | In-game name (default `Pricey`). Used to auto-bind `myPlayerId`. |
| `STREAMER_TTS_VOICE_MODEL` | Path to Piper ONNX voice model inside the container. Empty → silent bot (`nullEngine`). |
| `STREAMER_HEALTH_PORT` | Port for `/healthz` + `/status` (default `9101`). |

### Stream destinations

| Var | Purpose |
|---|---|
| `STREAMER_TWITCH_KEY` | Twitch stream key (rtmp ingest). |
| `STREAMER_YOUTUBE_KEY` | YouTube Live stream key. |
| `STREAMER_KICK_KEY` | Kick.com stream key. |
| `STREAMER_TWITCH_CHANNEL` | Twitch chat channel name (for command ingestion). Empty → no chat. |

Each destination is independent — set only the ones you actually stream to.

### Auth / security

| Var | Purpose |
|---|---|
| `STREAMER_BOT_SECRET` | Shared secret. Required to call `/api/streamer/*` relay endpoints and to bypass analytics counting. Sent as `X-Streamer-Bot` header. |

### Online learning

| Var | Default | Purpose |
|---|---|---|
| `STREAMER_LEARNING_ENABLED` | `false` | Master switch for the worker thread. |
| `STREAMER_LEARNING_MODE` | `off` | `off` / `shadow` / `active`. See [`learning.md`](./learning.md). |
| `STREAMER_LEARNING_DATA_DIR` | `/var/streamer/data` | Where snapshots, `learning.db`, NDJSON logs live. **Persistent volume.** |
| `LEARNING_FORCE_HEURISTIC` | unset | Kill-switch. `1` / `true` / `yes` → bypass NN entirely. Takes precedence over enabled/mode. |

### Music

| Var | Purpose |
|---|---|
| `STREAMER_MUSIC_HOST_DIR` | Host directory of music files, mounted into the container at `/var/streamer/music`. |
| `STREAMER_MUSIC_BITRATE_KBPS` | mpd encoder bitrate. Default 192. |

### Persona / behavior

| Var | Default | Purpose |
|---|---|---|
| `STREAMER_INITIAL_SKILL` | `normal` | Starting softmax temperature tier (`easy` / `normal` / `hard`). Override via `!skill`. |
| `STREAMER_MOOD_INFLUENCE` | `1.0` | Scales mood's effect on softmax temperature. Set to `0` to A/B-test mood-free play. |
| `STREAMER_ROTATION` | (parsed default) | Rotation hint for the plan picker. See [`runtimeConfig.ts`](../../packages/bot-streamer/src/runner/runtimeConfig.ts). |
| `STREAMER_MODE_WHITELIST` | (all modes) | Comma-separated game modes the bot is allowed to play. |
| `STREAMER_BIDDING_BOT_DIFFICULTY` | `normal` | NPC difficulty in `quickplay_bidding` plans. |

### Development overrides

| Var | Effect |
|---|---|
| `STREAMER_SLOWMO_MS` | Add a fixed delay between Playwright actions. Visual debugging. |
| `STREAMER_THINKING_PAD_MS` | Extra dwell after decisions before next action. |
| `STREAMER_TTS_DEBUG` | Verbose log of every `say()` call. |

## Health endpoints

Both bound to `127.0.0.1:9101` (loopback) inside the container:

### `GET /healthz`

Docker healthcheck binary. Returns:

- **200** when the watchdog reports a successful round in the last 5 minutes AND `panicCount < 5`.
- **503** otherwise. Docker restarts after 4 consecutive failures (~2 minutes).

Body is JSON with a `healthy: true/false` plus the watchdog's reasoning.

### `GET /status`

Verbose dashboard JSON. Always returns 200, even when the bot is stalled, so post-incident inspection still works. Includes:

- Watchdog state (`lastSuccessfulRoundAt`, `panicCount`).
- Learning block (mode, snapshot age, db latency p95, disk used ratio, frozen flag).
- Mood snapshot (vibe, morale, streak, label).
- Last plan + outcome.
- Telemetry counters (rounds played, rounds won, errors by category, stale predict count).

Restrict access — these endpoints share infrastructure secrets and should not be public-facing. The production reverse proxy listens only on loopback.

## Volumes

| Mount | Purpose |
|---|---|
| `<host-music-dir>` → `/var/streamer/music` | Music library mpd plays from. |
| `streamer-data` → `/var/streamer/data` | Learning DB, snapshots, NDJSON round log. **Persistent.** |
| `chromium-cache` → `/root/.cache/chromium` | Speeds up restart. Optional. |

The data volume is the only one that must survive container recreation — losing it wipes the NN's learning state.

## Healthcheck configuration

In [`docker-compose.prod.yml`](../../docker-compose.prod.yml) under the `streamer` service:

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "http://localhost:9101/healthz"]
  interval: 30s
  timeout: 5s
  retries: 4
  start_period: 60s
```

`start_period: 60s` gives Chromium + Xvfb + Pulse time to come up before the first healthcheck. Without it, the container reliably restart-loops on cold boot.

## Off-host migration

Deploying the streamer to a different host than the app server is supported:

1. Build the image (or pull from a registry).
2. Run the host on the same Tailscale tailnet as the app server.
3. Set `STREAMER_TARGET_URL` to the app server's tailnet hostname (e.g. `http://price-server.tail12345.ts.net:3001/?broadcast=1`).
4. The app server's Caddy needs to allow the streamer's tailnet origin for `?broadcast=1` — see [`../DEPLOYMENT.md`](../DEPLOYMENT.md) Tailscale section.

Why split hosts? The streamer is CPU-heavy (Chromium + x264 encoding); moving it to a dedicated host keeps it from competing with the game server for resources.

## Stream destinations

The bot pushes one composite video stream from ffmpeg into nginx-rtmp on loopback. nginx-rtmp's config then **fans out** to each configured destination:

```
ffmpeg (x11grab + pulse → x264)
       │
       ▼
rtmp://localhost/live/stream    (nginx-rtmp ingress)
       │
       ▼
   ┌───┴────┬─────────┬─────────┐
   ▼        ▼         ▼         ▼
 YouTube  Twitch    Kick      (recording, optional)
```

Each destination is a `push` rule in nginx-rtmp's config keyed by the corresponding env var. Empty var → no push.

## Updating the image

The streamer ships on its own cadence — pushes to `main` of the app repo do **not** automatically rebuild the streamer image (it's heavy and rebuilding for every web fix would be wasteful).

When the bot itself changes (anything under `packages/bot-streamer/`), an operator runs [`scripts/streamer-redeploy.sh`](../../scripts/streamer-redeploy.sh) to rebuild and restart. The image rebuild is idempotent and uses BuildKit caching, so incremental changes are quick.

For non-code changes (env, music, persona swaps, ONNX voice swaps), no image rebuild is needed — see [`../STREAMER.md`](../STREAMER.md) for the hot-swap recipes.
