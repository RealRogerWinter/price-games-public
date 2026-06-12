---
title: Streamer Bot — Operations
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: operator
category: streamer
summary: "Ops runbook: deployment, day-to-day operations, persona swaps, music updates, monitoring."
related_code:
  - packages/bot-streamer
  - infra/streamer
---
# 24/7 Bot Streamer — Operator Runbook

> **For contributors and operators.** This file is the **operator runbook** — what you do at the host to deploy, swap personas, update music, debug a wedged bot. Many sections below assume shell access to the production host (commands like `ssh`, `docker compose`, `docker exec`); those are operator-only and won't apply to a local fork. Sections that touch architecture or behaviour are useful to any contributor. For the **architecture** of the bot itself (how the runner loop works, how strategies decide, how mood and TTS interact, how the online learner is structured), see [`streamer/architecture.md`](./streamer/architecture.md) and its siblings: [`strategies.md`](./streamer/strategies.md), [`chat.md`](./streamer/chat.md), [`mood.md`](./streamer/mood.md), [`tts-thinker.md`](./streamer/tts-thinker.md), [`observer.md`](./streamer/observer.md), [`heuristics.md`](./streamer/heuristics.md), [`learning.md`](./streamer/learning.md), [`dev.md`](./streamer/dev.md), [`deploy.md`](./streamer/deploy.md). For first-time fork-and-run, see [`QUICKSTART.md`](./QUICKSTART.md).

The streamer is a Docker container that runs alongside the production game on the Hetzner host. It logs into price.games as a regular client (URL `https://price.games/?broadcast=1`), drives gameplay via Playwright, captures the resulting Chromium framebuffer with ffmpeg, and pushes the encoded video to YouTube / Twitch / Kick simultaneously via a local nginx-rtmp instance.

> **Status (2026-05):** the streamer is fully shipped. The container build, encoder pipeline, audio chain, bot-streamer npm workspace, and the full Playwright runner (solo + multiplayer end-to-end) are all in `main`. A reliability overhaul added round-level retries, adaptive timeouts, a watchdog, page-crash hooks, telemetry, and split `/healthz` + `/status` endpoints. The full `runner/main.ts` boots Chromium, attaches the observer, runs the lifecycle loop, drives chat + Piper, and exposes both health endpoints.

## Architecture

```
┌─ Hetzner host ─────────────────────────────────────────────────────┐
│                                                                     │
│  app (existing)         streamer (new, opt-in)                      │
│  ├ Express+Socket.IO    ├ Xvfb :100 (1920×1080@30)                  │
│  └ port 3001 lo         ├ Chromium (Playwright)                     │
│                         │   └ https://price.games/?broadcast=1      │
│                         ├ Pulseaudio (sink: broadcast)              │
│                         │   ├ mpd (music)                           │
│                         │   └ piper (TTS)                           │
│                         ├ ffmpeg (x11grab + pulse → x264)           │
│                         ├ nginx-rtmp (loopback)                     │
│                         │   └ push fan-out → YT / Twitch / Kick     │
│                         └ /healthz + /status on :9101 (loopback)    │
└─────────────────────────────────────────────────────────────────────┘
```

## Deploying for the first time

1. **Build the streamer image** on the host (CI doesn't build this image — it's deployed out-of-band so the streamer can ship on its own cadence):

   ```bash
   cd /path/to/price-game
   docker build -f infra/streamer/Dockerfile -t ghcr.io/<owner>/price-game-streamer:latest .
   ```

2. **Set env vars in `.env`** at repo root. See `.env.example` for the full list. Minimum to actually broadcast:

   ```ini
   STREAMER_BOT_DISPLAY_NAME=Pricey
   STREAMER_BOT_AVATAR=wizard
   STREAMER_YOUTUBE_KEY=your-youtube-stream-key
   STREAMER_BOT_SECRET=<random-256-bit-string>
   ```

   Add `STREAMER_TWITCH_KEY` / `STREAMER_KICK_KEY` for additional destinations. Stream keys for each platform live in their respective creator dashboards (YouTube Studio → Go Live, Twitch dashboard → Settings → Stream).

   `STREAMER_BOT_SECRET` is a shared-secret string used to keep the bot's gameplay out of analytics counters. The bot's Playwright context attaches it as the `X-Streamer-Bot` HTTP header on every request and on the Socket.IO handshake; the server (which reads the same env var) skips analytics event ingest, visitor-attribution UTM-cohort counters (`games_played`, `first_game_*`), `user_game_history` writes, and `mp_leaderboard` rows for any seat that joined with a matching header. Generate any high-entropy string (e.g. `openssl rand -hex 32`) and set it in **both** the bot's container env and the server's `.env` — when they don't match, the bot's traffic falls back to being counted like a regular client. When the env is unset on either side, the feature is a no-op.

   **What the bot IS counted in:** lifetime W/L + signed streak on the bot's own `visitor_attribution` row, so the in-game HUD chip the bot reads in its own Chromium browser shows real numbers. The W/L row is auto-created on first game with `utm_source='direct'`. See `docs/SCORING.md` for the per-row W/L policy.

3. **Stage music** — drop royalty-free `.mp3`/`.flac`/`.ogg` files into `${STREAMER_MUSIC_HOST_DIR:-$HOME/streamer-music}/` on the host. mpd loops them automatically. Recommended sources:
   - [Pixabay Music](https://pixabay.com/music/) — CC0
   - [Lofi Girl OBS pack](https://lofigirl.com/community/obs/) — license bundle for streams
   - [Epidemic Sound](https://www.epidemicsound.com/) — paid, easy clearance

4. **Bring the service up** behind the `streamer` profile so it's opt-in:

   ```bash
   docker compose --profile streamer up -d streamer
   ```

5. **Verify health** — should return `{"status":"ok",...}`:

   ```bash
   docker compose exec streamer wget -qO- http://localhost:9101/healthz
   docker compose logs --tail=200 streamer
   ```

## Day-to-day operations

### Swap the music playlist

Music files are mounted read-only from the host. Drop files into the music dir and restart mpd inside the container:

```bash
cp /path/to/track.mp3 "${STREAMER_MUSIC_HOST_DIR:-$HOME/streamer-music}/"
docker compose exec streamer mpc update
docker compose exec streamer mpc play
```

### Change the bot's persona without rebuilding

Bot identity is env-driven. Edit `.env`:

```ini
STREAMER_BOT_DISPLAY_NAME=Pricey
STREAMER_BOT_AVATAR=pirate
STREAMER_SKILL_TEMPERATURE=0.4
STREAMER_TTS_VOICE=en_US-amy-medium
STREAMER_MOOD_INFLUENCE=1
```

Then restart the service:

```bash
docker compose --profile streamer up -d --force-recreate streamer
```

Validation rules enforced by the env loader (`packages/bot-streamer/src/persona/profile.ts`): name ≤ 32 chars, avatar / voice slugs match `/^[A-Za-z0-9_-]+$/`, voice ≤ 64 chars, skill temperature in `[0, 5]`, **mood influence in `[0, 1]`**. Bad values fall back to the Pricey defaults rather than crashing the runner.

#### `STREAMER_MOOD_INFLUENCE` — the mood-pipeline kill-switch

The bot's mood system (vibe + morale + 8 labels — see `packages/bot-streamer/src/persona/mood.ts`) feeds into the NN's predictions and behavior via three composed gains: a candidate-sampler temperature multiplier, an additive ε bump on negative-valence labels, and per-sample importance weighting in the training path that combines GANE-style memory consolidation (`arousalGainFor`) with Eldar-Niv mood-congruent credit (`signedCreditGain`). The full design lives at `packages/bot-streamer/src/persona/moodScale.ts`.

`STREAMER_MOOD_INFLUENCE` is the master gate over the whole pipeline:

- `0` — provably inert. The FiLM head is skipped, every gain collapses to 1, and the bot's NN behavior takes the bare-embedding path through the *same* code (the `workerCoreFilm.test.ts` "moodInfluence=0 is bit-identical to no-mood baseline" test pins this byte-equality). Mood UI / TTS prosody still works; only the *NN* path is gated. Use this if you need a pure-trunk regression run, an A/B against the live bot, or to revert behavior after a problematic deploy.
- **`1` (default — live)** — full mood-conditioned pipeline. `focused` tightens to T·0.7, `despondent` widens to T·1.30 with an additional ε·0.05 corrective exploration, etc.
- Any value between is a partial ramp — useful for bisection if a behavioral regression appears.

To revert to the inert baseline without rebuilding:

```bash
# In the streamer container's .env
STREAMER_MOOD_INFLUENCE=0
```

Then `docker compose --profile streamer up -d --force-recreate streamer`. The bot will resume from the persisted mood snapshot (vibe/morale survive container restarts via the SQLite `streamer_state.mood_json` row) but with the NN no longer reading it — same code, neutral gain.

### Force a specific mode (chat command — once the runner ships)

In the bot's Twitch / YouTube / Kick chat:

```
!mode bidding
```

Cooldowns: 60s per-user, 5s globally. Mode names are the canonical slugs from `packages/shared/src/constants.ts` (e.g. `higher-lower`, `closest-without-going-over`, `chain-reaction`).

Other commands:

| Command | Cooldown (per-user) | Effect |
|---|---|---|
| `!mode <name>` | 60s | Queue mode change for the next round |
| `!hint` | 120s | Bot speaks the rationale for its current decision |
| `!skill easy\|normal\|hard` | 300s, **mods only** | Bump skill temperature live |
| `!song` | 15s | Bot announces the currently-playing track |
| `!stats` | 20s | Bot announces W/L/streak |
| `!join` | 5s | Bot posts its current room code so a viewer can join |

### Reset stats

Stats are persisted in the `streamer-data` volume (currently in `/var/streamer/data`). To zero out:

```bash
docker compose --profile streamer down streamer
docker volume rm price-game_streamer-data   # local image; production may differ
docker compose --profile streamer up -d streamer
```

This also wipes the bot's Chromium profile, so the bot re-registers as a fresh anonymous client on next boot.

### Drop bitrate / resolution to relieve host CPU

```ini
STREAMER_WIDTH=1280
STREAMER_HEIGHT=720
STREAMER_BITRATE_KBPS=2800
```

Then `docker compose --profile streamer up -d --force-recreate streamer`. 720p30 at 2800k uses roughly half the CPU of 1080p30 at 4500k.

### Memory stability (OOM crash-loop prevention)

The streamer container packs Chromium + Xvfb + ffmpeg + Node + Piper + mpd into one memory cgroup; at 1080p the working set peaks ~4–5 GiB and creeps higher over long sessions (Chromium renderer + X11 pixmaps). Three layers keep it from OOM-killing Xvfb (which otherwise leaves the encoder a zombie publishing a black frame):

1. **Container limit `6g`** (`docker-compose.prod.yml` → `deploy.resources.limits.memory`). Raised from `2.5g`, which sat *below* the working set and caused a hard-OOM crash-loop. Keep a few GiB of host **swap** provisioned so transient spikes degrade gracefully instead of hard-killing.
2. **Proactive browser recycle** (`STREAMER_BROWSER_RECYCLE_PLANS`, default `25`). The runner relaunches a fresh Chromium every N lifecycle plans, releasing accumulated renderer/pixmap memory. Mood/stats persist across the recycle. Set `0` to disable.
3. **Host mem-watchdog** (`infra/streamer/pricey-mem-watchdog.{sh,service,timer}`). A systemd timer that `docker restart`s the container when its cgroup `memory.current` crosses ~5 GiB — a graceful pre-emptive recycle before the 6 GiB hard cap. Install:
   ```bash
   sudo cp infra/streamer/pricey-mem-watchdog.sh /usr/local/bin/ && sudo chmod 755 /usr/local/bin/pricey-mem-watchdog.sh
   sudo cp infra/streamer/pricey-mem-watchdog.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now pricey-mem-watchdog.timer
   ```

> **Compose v2 required.** The legacy `docker-compose` v1.29.2 crashes with `KeyError: 'ContainerConfig'` against Docker Engine ≥ 26 when *recreating* a container — and it removes the old container before failing, leaving you with **none** running. Use the `docker compose` v2 plugin. If stuck on v1, recover with `docker rm -f <hash>_price-game_streamer_1` then `docker-compose … up -d --no-deps streamer` (the pure-create path sidesteps the bug).

### Stop streaming entirely

```bash
docker compose --profile streamer stop streamer
```

The main `app` service is unaffected (the streamer's `depends_on` is one-way).

### Tuning the shutdown grace period

`CLEANUP_GRACE_SECONDS` (default `8`) bounds how long the entrypoint waits for daemons (Xvfb, Pulse, nginx-rtmp, mpd, ffmpeg, the Node runner) to handle SIGTERM before it escalates to SIGKILL. The default sits well under compose's `stop_grace_period: 30s`, so a `docker compose stop` still completes within compose's window even when a child is wedged. Operators rarely need to touch this; bump it only if you see clean-shutdown logs being cut off and you're confident the daemons would eventually exit on their own. The bound also guards the *daemon-died* restart path — if Xvfb gets OOM-killed mid-stream, the entrypoint must exit so Docker's `restart: unless-stopped` can give us a fresh container; an unbounded wait there is what once wedged production at "Up (unhealthy)" for two days before this knob existed.

## Monitoring

The bot exposes two HTTP endpoints on `STREAMER_HEALTH_PORT` (default `9101`, loopback-only inside the container):

- **`GET /healthz`** — Docker healthcheck binary. Returns `200` only when:
  - the watchdog has seen a successful round in the last 5 minutes, AND
  - `panicCount < 5` (the watchdog hasn't been asked to give up).
  - During cold-start (no rounds yet) the response body reports `"status": "starting"` rather than `"stalled"`. Docker's `start_period` covers this.
  Returns `503` otherwise. Configure the Docker healthcheck as `interval=30s, timeout=5s, retries=4, start_period=60s` — four consecutive failures (~2 minutes) restart the container.

- **`GET /status`** — verbose dashboard view, always `200`. Returns `{ startedAt, uptimeMs, lastLifecycleTick, watchdog: { lastSuccessfulRoundAt, lastActivityAt, panicCount, lastPanicAt } }`. Use this for ops dashboards — a single endpoint shouldn't go silent precisely when its diagnostics matter most.

Other monitoring affordances:
- **Logs**: `docker compose logs -f streamer`. Lifecycle events, encoder errors, and chat command rejections all flow here.
- **Mood vocabulary**: the bot's mood label set lives in `packages/shared/src/moods.ts` (`MOOD_LABELS`, `MOOD_REGISTRY`). The set has 8 labels — `confident`, `elated`, `tilted`, `despondent` plus the original `neutral`/`happy`/`frustrated`/`focused`. Adding a mood is a one-row registry edit; the overlay reducer's allowlist, the server validator, the `MoodWheel` panel, and the operator HUD all consume the registry directly. Each descriptor carries a `spriteFallback` field — today every mood points it at itself (identity), but the field stays in the type so a future mood can ship without dedicated artwork by falling back to an existing anchor.
- **Mood wheel** (`apps/web/src/broadcast/panels/MoodWheel.tsx`): viewer-facing mood indicator slotted between Avatar and "Pricey's brain". An 8-sector colored ring (sector ordering and angle math in `moodWheelGeometry.ts`) with a dominant central hub readout — emoji + uppercase label + directional caret ("↗ Confident") + streak pill (gated at `|streak| ≥ 2`). A glowing pointer on the rim animates smoothly between sector anchors as the mood transitions, with distance-aware timing (`min(700ms + 4ms/deg, 1400ms)`). Direction-of-travel is encoded primarily as text in the hub sub-label (the most legible channel for a 1-second Twitch glance) and reinforced by pointer motion. Sectors render dim by default (30% chroma); the active sector + ±1 neighbours light up so the wheel is *context*, not a competing readout. Active-sector colour drives `--mood-color` for the panel chrome (border, glow, hub label, streak pill). Cold-start (no snapshot yet) shows "Warming up" with the pointer hidden. Honours `prefers-reduced-motion` (no rotation transition, no hub breathing).
- **Mood-driven body sprites**: the avatar swaps its body sprite per `(mood, mouthState)` — 24 `pricey-v3-mouth-{mood}-{closed,mid,wide}.webp` files in `apps/web/src/assets/avatar/`, statically imported and selected via `BODY_BY_MOOD[mood][state]` in `Avatar.tsx`. Each per-mood trio is a coherent set: the closed sprite is fed to Gemini's image-edit endpoint with a per-state prompt, body identity (eyes, coin, blush, outline, pose) is preserved, and only the mouth shape changes across the trio. All 24 sprites are 384×384 with chromakey'd transparent backgrounds so opacity-only swaps animate the mouth without the painted Pricey jumping position — the prior layout (one body sprite at 384×384 + two 512×512 mouth-only overlays) had the overlay's painted mouth landing in transparent space ~30px off the body's snout under `object-fit: contain`, which made every opacity flip visually invisible (this was the bug fixed by going to the trio). Stylistic variation between moods is intentional — viewers read mood faster from a body-language shift than from facial-expression deltas alone. All source rasters are stored facing **left**; the CSS `transform: scaleX(-1)` on `.broadcast-avatar-frame` flips them to face right on screen. Regeneration: `GEMINI_API_KEY=… node scripts/regen-pricey-mouth-sprites.mjs` (preserves the existing mood originals as inputs, idempotent on re-runs).
- **Mood engine**: two-layer state machine in `packages/bot-streamer/src/persona/mood.ts`. Vibe (∈ [-3, 3], 0.92 decay per round, fast) tracks the recent-round emotional read; morale (∈ [-1, 1], EMA α=0.18 over game outcomes, slow) tracks the multi-game arc. The pure `resolveMood(vibe, morale, streak)` function picks one of the 8 labels per a small decision table documented inline. `nextMood(prev, input)` accepts a discriminated `MoodInput` — `{ kind: "round_outcome", outcome }` from `attemptRound` and `{ kind: "game_outcome", win }` from `finalizeGameOutcome`.
- **Mood persistence + snapshot socket event**: the engine state survives container restart via the `streamer_state` row's `mood_json` column (migration v70). Bot pushes the full snapshot (`{ mood, vibe, morale, streak, updatedAt }`) to `POST /api/streamer/mood` after every `nextMood` call (per-round and once at `finalizeGameOutcome`); the server persists it and fans out via `STREAMER_BOT_MOOD` (`streamer:mood` socket event). Bot also calls `GET /api/streamer/mood` once on runner boot (`driver.hydrateMood()` from `main.ts`) so a deploy / OOM / container kill resumes Pricey's emotional arc instead of resetting to neutral. The richer `mood.snapshot` overlay event carries the hidden vibe + morale axes the legacy `STREAMER_BOT_STATS` payload doesn't expose — `MoodWheel` consumes the vibe slope for its directional caret, and the operator HUD reads the raw axes for trend arrows / morale bars. The legacy `stats.mood` field is still mirrored from each snapshot so existing consumers (Avatar's `data-mood`, debug HUD's label) stay in sync without a coordinated cutover.
- **Reactive narration**: Pricey speaks an outcome-driven line after every round and every game. Per-round mapping in `packages/bot-streamer/src/runner/outcome.ts::reactiveLineForOutcome` — `correct` → `win_correct`, `partial` → `loss_off_a_little`, `incorrect` → `loss_off_a_lot`. Per-game mapping in `playwrightDriver.finalizeGameOutcome` — `win` → `game_win`, `loss` → `game_loss`. Mood biases the line pool (each LineEvent has `byMood` variants for happy/frustrated/focused). Reactive lines drop silently if Pricey is still mid-utterance from earlier in the round (rate limit lives in `narrator.reactive`) — the audience would otherwise hear a result line two utterances after the score landed on screen. To extend the reactive vocabulary, add a new `LineEvent` to `tts/lines.ts` and call `narrator.reactive("<event>", mood)` from the appropriate driver hook.
- **Voice prosody per mood**: each mood descriptor in `packages/shared/src/moods.ts` carries a `prosody.lengthScale` value that the narrator threads through `engine.say(..., { lengthScale })` to Piper as `--length_scale`. Positive moods speak faster (elated 0.90, happy 0.95, confident 0.97); neutral is 1.00; negative moods speak slower (focused/tilted 1.05, frustrated 1.10, despondent 1.15). Practical Piper range is [0.85, 1.20]; values outside [0.5, 2.0] are clamped at the engine boundary in `buildPiperArgs`. Manual `narrator.say()` calls (used by `!hint` chat command and similar) carry no mood and omit the length-scale flag — Piper falls back to the model's built-in default. To rebalance pacing, edit the per-mood `prosody.lengthScale` rows in the registry; the polarity-contract test in `moodRegistry.test.ts` pins the qualitative direction so an accidental inversion (e.g. setting despondent below 1.0) trips CI.
- **Mood diagnostics**: the bot logs `[mood] outcome=X vibe=A→B streak=A→B mood=A→B` after every per-round mood update. To also log mood transitions on the server side as it receives stats POSTs, set `STREAMER_MOOD_DEBUG=1` in the *server* `.env` (not the bot container) — when set, the server prints one line per mood label change (not per push, to avoid flooding stdout). For an in-page visual confirmation, append `?moodDebug=1&broadcast=1` to the URL the operator preview renders; a small top-right HUD shows the current mood, the **resting** sprite the avatar would render right now, a `speaking: yes (mouth wins)` indicator that fires whenever Avatar is in its PCM-driven mouth branch, and the last 12 transitions. The HUD freezes the resting sprite during speech rather than guess at the live PCM mouth state — that's the whole point of the diagnostic, since the audit's primary suspicion is that mood is structurally hidden whenever Pricey is speaking. Production stream output never carries this overlay (it's gated on the URL flag, not env).
- **Lipsync diagnostics**: the TTS / subtitle / lipsync pipeline crosses three processes and four serialization boundaries. Two diagnostic surfaces let an operator confirm each stage is alive:
  1. **In-overlay HUD** — append `?lipsyncDebug=1&broadcast=1` to the operator-preview URL (e.g. `https://<tailnet-host>/play/classic?broadcast=1&lipsyncDebug=1`). A small bottom-right card polls every 250ms and shows the **utterance lifecycle** (the single source of truth for lipsync state): `ready` (true once Avatar's mount useEffect has fired), the active utterance's text + age vs estimate, the audio state (`pending` / `playing (Xms)` / `ended (Xms)`), the intent, the `__pgPcmStats` counters (`received` / `decoded` / `dispatched` + `synth audio_start` warn-row when the reducer back-fills a missing audioStartedAt), and the `__pgVisemeStats` counters (`processed` / `lastRms` / `lastAperture`). `dispatched` and `processed` should both increment together during speech; if `received` is rising but `decoded` isn't, the envelope shape changed; if `decoded` rises but `processed` doesn't, Avatar's chunk listener is detached; if `synth audio_start` is rising every utterance, either Piper is crashing before producing PCM OR the runner's `tts.utterance.audio_started` envelope is dropping on the wire.
  2. **`GET /diag/page` JSON** — the bot's loopback health server (`STREAMER_HEALTH_PORT`, default `9101`) exposes a snapshot of the same counters via `page.evaluate`. Auth-gated on the `X-Streamer-Bot` header (must match `STREAMER_BOT_SECRET`):
     ```bash
     docker exec price-game-streamer sh -c \
       'curl -s -H "X-Streamer-Bot: $STREAMER_BOT_SECRET" http://127.0.0.1:9101/diag/page' | jq .
     ```
     Returns `{ url, pcm: {received, decoded, dispatched, lastDecodeError, ...}, viseme: {processed, lastRms, lastAperture, ...}, avatarMounted, avatarSpeaking, indicatorSpeaking }`. Use this when SSH access exists but the operator preview doesn't (e.g. tailnet not configured for your workstation).
- **Lipsync cold-start guarantee**: Avatar sets `window.__pgBroadcastReady = true` on mount (one-shot — never cleared on unmount, since React.StrictMode's cleanup-then-mount-again pattern would briefly flip it false), and the runner's `awaitBroadcastReady` (`packages/bot-streamer/src/runner/playwrightDriver.ts`, 5s timeout) gates the first `narrator.speak` after each `softNavigate`. On timeout the runner emits a `broadcast_ready_timeout` telemetry event (operators should grep for this — its presence signals the cold-start race regressed and the replay buffer is doing the heavy lifting alone). As a safety net, the page-side bus (`apps/web/src/broadcast/state/overlayBus.ts`) has a module-load-time fallback message listener that buffers up to 500 envelopes (~10s of PCM) and a 50-entry PCM replay queue; both drain through normal processing once `useOverlayState` and `Avatar` have mounted respectively. Net effect: the very first utterance of a session animates the mouth even when the Avatar's `lazy()` chunk is still fetching when the runner starts speaking.
- **Structured telemetry**: each lifecycle event is also written as a single JSON line to stdout (one per `runner.start`, `plan.start`, `plan.end`, `watchdog.panic`, `watchdog.give_up`). Tail via `docker logs streamer | jq 'select(.evt)'`.
- **Active publisher**: from inside the container, `wget -qO- http://localhost:8080/stat` returns the nginx-rtmp stats XML. Useful for checking that the encoder is actually publishing.
- **Platform dashboards**: each service has its own preview / health view (YouTube Studio → Go Live, Twitch Dashboard → Stream Manager, Kick → Stream Manager).

## Reliability supervision

The runner has two layers of recovery:

- **Round-level retries (`attemptRound`)** — phase-scoped retry contract. A WAITING_FOR_ROUND timeout reloads the page and tries once more. A THINKING-phase strategy throw skips THIS round only (the next round still proceeds). An ACTING-phase enactor failure retries with jitter. A REVIEWING-phase modal-not-found tries a 1.5x extension. **Plan completion threshold is `≥ 50%` of rounds** — a 4/5 plan reports `completed`, not `no_match`.

- **Watchdog (`runner/watchdog.ts`)** — parallel `setInterval` monitor. After 4 minutes without a successful round it calls `driver.panic()` (closes the browser; next `ensureSession()` relaunches). After 5 panics in 1 hour it calls `process.exit(70)` so Docker restarts the container. Healthy uptime decays the panic counter so a long-lived deployment doesn't accumulate stale credit. `page.on("crash")` and `page.on("close")` route through the same panic path — Chromium-level failures are handled even when no timeout fires.

## Plan picker

The lifecycle picker is now stateful and probabilistic by default:

- Kind weights: `solo` 0.6 / `quickplay_bidding` 0.4 / `public_join` 0 / `host_public` 0 (configurable via `PolicyConfig.kindWeights`). Real-MP is opt-in via env override.
- Never `host_public` twice in a row (60s lobby waits are dead air).
- No-immediate-mode-repetition: the same game mode is filtered out when the whitelist has more than one candidate.
- EWMA per-mode success rate (`alpha=0.3`, floor `0.1`) downweights modes that keep failing without ever excluding them — broken enactors retain a recovery slot.
- The next-3-plans lookahead is emitted to telemetry only; the on-stream "Up Next" teaser was removed once the soft-nav plan-boundary fix landed.

`STREAMER_ROTATION` and `STREAMER_MODES` env vars opt back into the legacy fixed-rotation cursor and narrow the mode whitelist respectively. Operators can use these during stabilisation when some enactors aren't yet reliable on stream.

### `quickplay_bidding` plan kind

Quick Play is the bot's path into bidding-war games — the user explicitly opted out of real multiplayer. The runner POSTs `/api/mp/quickplay { gameMode: "bidding" }` and either joins an existing lobby (`action: "join"`) or creates a fresh one with 3 NPC bots auto-seated (`action: "create"`). Either way, the resulting room has 4 bidders (the streamer-bot + 3 NPCs).

Per-round, the bidding strategy reads:
- `BiddingTurnPayload` from the observer (turnIdx, totalPlayers, previousBids).
- A per-room `OpponentTracker` posterior over NPC archetypes — built at room enter, updated on each `bid_placed` + reveal, cleared on game over.
- The NN's `squashedRegression` (μ, σ on log-residual) and `pinballQ40LogResidual` outputs.

The position-conditional decoder (`strategies/biddingDecoder.ts`) injects discrete candidates per branch:
- **First**: q25 / q35 / q45 of the price posterior — anchor low to leave bracket-undercut room.
- **Middle**: q40, mid-quantile, undercut-leader-by-1¢ when the standing leader is sub-μ.
- **Last**: clip-by-1¢, $1 gambit, q40, q50, μ × 0.95.

Each candidate's expected MP rank-score is estimated by Monte-Carlo over (price-posterior draw × per-archetype opponent simulation); the argmax wins. The pinball-q40 head's output acts as a robustness floor: if the simulator argmax sits >10% above q40·heuristic AND the bot isn't last-bidder clipping, the decoder snaps down.

When `STREAMER_ROTATION` is set, the runner switches `useStatefulPicker: false` automatically — otherwise the stateful picker's probabilistic kind weights silently override the rotation array (`solo,solo,solo` would still produce ~30% public_join + ~20% host_public). Disabling the stateful picker also turns off the picker's per-mode EWMA failure-bias downweighting, so a mode that's currently flaky won't be auto-deprioritised — the rotation iterates strictly through what you wrote in the env. Use `STREAMER_MODES` to exclude a flaky mode entirely.

### Per-round pace knobs

Three env vars throttle the bot's per-round cadence — all default to 0 and additively extend the natural realism beats:

| Env var | Default | Purpose |
|---|---|---|
| `STREAMER_THINKING_PAD_MS` | 0 | Extra fixed sleep after Phase 2's decisionDelayMs, before the enactor acts. Adds visible "thinking" beat. |
| `STREAMER_RESULT_LINGER_MS` | 0 | Per-round dwell on the round-result modal (every round, including the final one). Stacks with the natural decisionDelayMs jitter. |
| `STREAMER_FINAL_LINGER_MS` | 0 | Dwell on the dedicated final-results page (`[data-testid="result-page"]` from `apps/web/src/pages/ResultPage.tsx`) that appears AFTER the last round's Next click navigates off the modal. Skipped silently if the result page doesn't mount within 5s. |

Use case: when the rotation is pinned to solo, the bot's request rate against `price.games` API can trip a server-side rate limit (manifesting as `429`s in the browser console + plans abandoning with `3 unhealthy rounds exceeded budget`). Pace knobs ease the rate without re-introducing multiplayer lobby waits. Recommended starting values: `STREAMER_THINKING_PAD_MS=2500`, `STREAMER_RESULT_LINGER_MS=2500`, `STREAMER_FINAL_LINGER_MS=12000`. The split between the per-round and final-page lingers is intentional: viewers don't want 12s of dead air after every round, but they DO want to absorb the final score before the next game starts.

## Broadcast UX

The bot's overlay is now a glass-shell rendered ON TOP of a full-bleed 1920×1080 game. Game pixels are never scaled — alpha-glass panels float over the letterbox margins game UI naturally leaves.

### Layout

```
y=0    ┌── HeaderBar (96px, full-width) ─────────────────────────┐
       │ PRICE.GAMES                                  [phase chip]│
y=96   ├──────────┬───────────────────────────────────┬───────────┤
       │ BotCard  │                                   │ Chat      │
       │ + Recent │       FULL GAME (no scale)        │ Overlay   │
       │ Rounds   │                                   │           │
y=1008 ├──────────┴───────────────────────────────────┴───────────┤
       │ MusicTicker · ●▮▮▮ Pricey (when speaking) (72px footer)  │
y=1080 └──────────────────────────────────────────────────────────┘
```

### Components (`apps/web/src/broadcast/panels/*`)

- **HeaderBar** — top-left brand block: site logo, the "24/7 BOT STREAM" tag, and "Play at https://price.games". No full-width bar across the screen and no lifecycle-phase chip — both stole vertical space from the centred game canvas without giving viewers information they couldn't infer from the rest of the overlay.
- **BotCard** — avatar + mood emoji ring + W/L/streak tiles. Stats arrive over **two** channels (see "Stats relay" below): same-window `stats.update` postMessage (legacy, fast path within the bot's own Chromium tab) and the server-mediated `streamer:stats` Socket.IO event (works for any `?broadcast=1` viewer, including operator previews and split-host deployments). The overlay bus reduces both transports identically.
- **RecentRounds** — last 6 rounds with mood-color outcome glyphs (✓ correct, ✗ incorrect, · partial).
- **ChatOverlay** — bottom-aligned auto-scroll, multi-platform badges (TW/YT/KK), per-message platform color.
- **MusicTicker** — currently-playing track from `music.now`.
- **ThoughtBubble** — anchored near the cursor, shows the bot's decision rationale ("Pricey thinks: $30 going slightly over"). Enters with overshoot easing; dims after 3s; exits when `round.result` arrives.
- **AimReticle** — telegraphs each click target with a contracting ring before the cursor arrives. Fired by `cursor.aim` events from the MotionEngine.
- **Subtitles** — bottom-third caption strip; **mandatory accessibility cue** because Twitch silences audio by default. Reads from the `currentUtterance` slot reduced from the runner's `tts.utterance.start` / `tts.utterance.audio_started` / `tts.utterance.audio_ended` envelopes; hides on REAL audio-end (with a 1500ms floor for short ack-style lines), no longer estimate-driven.
- **LobbyRadar** — center-stage overlay during host_public opponent waits. Sweep radar + room code + opponents-found count + remaining countdown. Replaces the worst current dead-air gap.
- **NeuralDebugHud** — bottom-right numbers-only telemetry overlay. Two columns: BELIEF (top guess, top-prob confidence, softmax entropy in bits, σ in cents, top-3 candidates) and TRAINING (loss + 10-round avg with trend arrow, grad-norm p95, effective LR with warmup progress, replay-buffer fill, batch × steps per round, golden MAE, snapshot-age extrapolated locally between ticks, teaching moments counter, frozen / NaN-rollback warnings). Reads from the same `nn.tick` relay as the brain-rail panels — no new socket event. Gated by the `debug` panel key (defaults on; opt out via `?panels=mlp,gauge,dots,card`).

### MotionEngine (`runner/motionEngine.ts`)

The cursor traces a humanlike Bézier path between targets at 33ms-per-waypoint cadence (one frame at the stream's 30fps output) instead of teleporting between CDP hover/click pairs.

- `planMousePath` (in `realism/mouse.ts`) generates 6–33 waypoints with Fitts-Law-ish duration scaling: `clamp(180 + 180·log2(distance/width + 1) + N(0, 60), 240, 1100)`. Far/small targets get longer paths; near/large ones snap.
- Click feedback is a three-layer composite: cursor press-down (`scale(0.85)`) + click ripple (sibling div, scale(0)→scale(2.5)) + target outline flash (250ms yellow outline).
- Playwright's `slowMo` is now 0 by default; the per-waypoint cadence replaces its visibility purpose. `STREAMER_SLOWMO_MS` env still overrides for ops experimentation.
- Defensive fallback: when `boundingBox()` is missing/null or `page.mouse` is undefined (test fakes, detached elements), the engine falls through to bare hover+click.

### Per-mode inter-action timing

`realism/timing.ts:interActionDelayMs(mode)` inserts humanlike pauses between consecutive sub-actions inside a single round. The motivating example: price-match would tap product → price → product → price (8 clicks) with **zero** inter-tap pause. Read as a robot.

| Mode | Mean | Special |
|---|---|---|
| `price-match` | 850ms | Pause between every product→price pair + final beat before submit |
| `sort-it-out` | 600ms | First swap heavier (1300ms) — comprehension beat for the initial layout |
| `budget-builder` | 550ms | Last 1–2 picks heavier (800ms) — "reconsidering budget headroom" |
| `chain-reaction` | 900ms | Final link heavier (1300ms) — stakes-rising beat |
| `bidding-fill` | 1500ms | Floor 800ms (sub-800ms bids would tip MP opponents that they're playing a bot) |

## Server-mediated overlay relays

Two slots on the broadcast overlay used to depend on a same-window `window.postMessage` from the bot's runner into the bot's own Chromium tab: the BotCard's W/L/streak (`stats.update`) and the MusicTicker's now-playing line (`music.now`). That works only for the one tab the bot drives. Operator previews, co-streamer overlays, and any deployment where the runner and the captured Chromium are on different machines saw zeros / "music will start when the streamer is up" forever.

Both slots now also flow through the server:

| Bot pushes | Server stores | Server emits | Broadcast hook |
|---|---|---|---|
| `POST /api/streamer/stats` | `latestStats` in `routes/streamer.ts` | `streamer:stats` | `useStreamerStatsRelay` |
| `POST /api/streamer/music` | `latestMusic` in `routes/streamer.ts` | `streamer:music` | `useStreamerMusicRelay` |

Auth on the POST is the existing `X-Streamer-Bot: <STREAMER_BOT_SECRET>` shared-secret header. The same socket fan-out is used for both — every connected socket receives the event; non-broadcast pages just don't subscribe. Each hook also hits its `GET /api/streamer/<slot>` counterpart on first mount so a freshly-loaded page hydrates without waiting for the next round / track-change.

The local `overlay.send(...)` path is left intact as a low-latency fast-path inside the bot's own tab. The two transports converge in the overlay bus reducer — `stats.update` and `music.now` envelopes are handled identically regardless of which transport delivered them.

When `STREAMER_BOT_SECRET` is unset (dev / unit tests) the bot skips the POST and the endpoint refuses writes, so dev runs degrade to local-only without erroring.

### Persistence + heartbeat (closes the restart-blank window)

The relay has two failure modes the in-memory cache alone can't paper over:

1. **Server restart wipes the cache.** A deploy, OOM, or container kill takes both slots back to `null` until the bot's next POST. Without persistence the broadcast panel reverts to zeros / "music will start..." for as long as that takes — minutes for solo plans, longer if the bot is mid-handshake.
2. **mpd track-change events are the bot's only `music.now` trigger.** A long track + a server restart in the middle = the panel stays empty until the track ends.

The current architecture closes both gaps:

- **SQLite-backed cache** (migration v68 / `streamer_state` singleton row). Every successful `POST /api/streamer/stats` and `POST /api/streamer/music` writes through, and `createStreamerRouter` hydrates from the row on construction. A fresh server boot already serves the last-known values on the first GET. Hydrated payloads are re-validated through `parseStatsPayload` / `parseMusicPayload` so a corrupt row can't poison the IO emit.
- **Music heartbeat** (`musicSource.heartbeatIntervalMs`, default 30s). Every tick re-POSTs the most-recently-seen track payload to `/api/streamer/music`. The local `overlay.send(...)` is NOT re-emitted — it's already in the bot's own bus. Heartbeats are dropped while a relay POST is in flight (in-flight cap), and skip entirely when no track has been seen yet (mpd up but queue genuinely empty).
- **No stats heartbeat.** `publishStats()` already fires after every round and after every plan-boundary `page.goto`, so the cadence is naturally ≤ ~30s on healthy plans. Adding a separate timer would just duplicate work.

Because the cache is now persisted, the only on-deploy gap is the time between server-up and the first hydration — sub-millisecond in practice (one synchronous SQLite read).

### Solo W/L sourcing

The bot's `commandState.wins / losses / streak` is fed by two transports, depending on game type:

| Mode | Result transport | Bot-side capture point |
|---|---|---|
| Multiplayer | Socket.IO `game:round_end` | `observer.lastResult` |
| Solo (every solo mode) | HTTP response to `POST /api/game/:sessionId/guess` | `page.on("response")` listener in `playwrightDriver.ts` |

Solo modes don't emit `round_end` — the score lands in the HTTP body. Without the response listener, `commandState.wins` stays at 0 forever for solo plays, and the broadcast panel publishes 0/0/0 every round despite the bot winning. The listener parses `body.result.score` and feeds it through `deriveSoloOutcome(score, mode)`, which grades against `getPerRoundMaxScore(mode)` and `WIN_RATIO_THRESHOLD = 0.5` from `packages/shared/src/winRecord.ts` — the same rule the canonical player streak uses, so the bot's streak indicator agrees with what the price.game UI would record for a non-bot player at the same score:

| Score | Bucket | Mood input |
|---|---|---|
| `score === 0` | `incorrect` | `loss` |
| `0 < score < 0.5 * perRoundMax` | `partial` | `soft_loss` (vibe -0.4) |
| `score >= 0.5 * perRoundMax` | `correct` | `win` |

For chain-reaction the per-round max is 1313, so the threshold is 657 (657/1313 = 50.04%); for every other mode the max is 1000 and the threshold is 500. The same `WIN_RATIO_THRESHOLD` is applied at game-end inside `finalizeGameOutcome`'s solo branch: the game is a win iff `currentGameScore / (perRoundMax * roundsObserved) >= 0.5`. Pre-fix both gates used `score > 0`, which made the bot's streak grow monotonically positive in solo (the heuristic + learned model earn *some* points on virtually every round) and locked mood into `focused`/`elated`/`happy` — starving the corrective negative-valence branches the mood engine relies on.

Per-round freshness gate: only outcomes captured during the current `attemptRound`'s wall-clock window are credited, so a delayed previous-round response can't be mis-credited.

## Multiplayer host wait

`host_public` plans default to `waitForOpponentsSeconds=60` (was 90s in earlier builds). The runner subscribes to ROOM_PLAYER_JOINED events and exits the wait early:

- 1 opponent → 15s grace period, then start.
- 2+ opponents → start within 5s.
- 0 opponents at the configured ceiling → return `no_match` so the lifecycle picks a solo plan instead of standing in an empty room.

The `mp.lobby_countdown` overlay event fires every 10s during the wait so the broadcast HUD can show `"Looking for opponents · 47s in queue · 2 lobbies seen"`.

## Known issues / gaps

- **YouTube + Kick chat adapters are not yet implemented** — only Twitch. The aggregator interface is generic so future adapters drop in without touching the router.
- **No supply-chain checksums** on the Piper binary or voice ONNX downloads in the Dockerfile. A future change should pin SHA-256 digests.
- **Chromium profile lives in a Docker volume.** If the bot ever logs into a privileged account those credentials persist there. Today the bot runs anonymously so this is theoretical.

## Off-host migration

If the production host can't sustain 1080p30 encoding, the entire streamer container can move to a Hetzner Cloud VPS without code changes — only env tweaks:

1. Provision a CPX21 (3 vCPU / 4 GB / 80 GB / 20 TB egress, ~€8/mo).
2. Copy the streamer image (push to GHCR and pull on the VPS, or `docker save | ssh vps docker load`).
3. Copy `.env` (with stream keys) and the music dir.
4. Install Tailscale on the VPS (`tailscale up`) and join the same tailnet as the production host. The bot connects to the broadcast overlay over the tailnet, so the VPS must be a tailnet member.
5. Run `docker compose --profile streamer up -d` against a one-service compose file. Point `STREAMER_TARGET_URL` at the production host's tailnet hostname (e.g. `https://onestreamer.tail-abcd.ts.net`).

## Where the bot connects

The bot's Chromium navigates to the broadcast overlay over the **tailnet**, not the public `price.games` domain. The overlay is blocked on the public domain at two layers:

1. **Caddy** (`Caddyfile`) — the public `price.games` and `sandbox.price.games` vhosts return 404 for any request whose query string contains `broadcast=1`.
2. **Express middleware** (`apps/server/src/middleware/broadcastAccess.ts`) — same block, defence in depth, so a Caddy misconfig doesn't widen the exposure.

The tailnet route (via `tailscale serve --https=443 http://localhost:3001`) bypasses Caddy entirely and reaches the same Express backend with no broadcast restriction. That is the path the bot uses.

`STREAMER_TARGET_URL` is required and validated at boot — the runner refuses to start if it is unset or points at a known-public host (see `packages/bot-streamer/src/runner/targetUrl.ts`).

## Caddyfile changes

The streamer doesn't expose a public-facing endpoint of its own, so no Caddy block is required for the streamer container. The `/healthz` endpoint is loopback-only inside the container (compose doesn't publish the port). Operator visibility is via `docker compose logs streamer` (or via Tailscale if you want a remote shell).

The Caddyfile **does** carry the broadcast 404 stanzas described above, on both the public `price.games` and `sandbox.price.games` vhosts.

## Online learning subsystem

The streamer can run a small online-learning multi-task neural network alongside the heuristic estimator. Default is **off** — flip on via env vars when ready (no rebuild needed; just edit `.env` and `docker compose restart streamer`).

When learning is enabled the bot publishes a per-round `VisualTick` to the broadcast overlay via two transports: same-window `postMessage` (so the bot's own Chromium tab reacts) and `POST /api/streamer/nn-tick` (so the server fans out to every other `?broadcast=1` viewer over Socket.IO). Three panels render the tick under the "Pricey's brain" rail, each in its own labeled card: **Neural Network** (the focal MLP diagram + sparkline — sized larger than the others, with animated edge dash-flow on top-quartile-magnitude weights and travelling glow pulses along edges that touch most-active neurons), **Price Guess** (ConfidenceGauge — tick mark slides on each prediction, halo breathes during `phase==="thinking"`), and **Last 10 Guesses** (RecentAccuracy dots — one dot per individual product reveal, so multi-product modes like comparison / market-basket / odd-one-out advance the row by N per round; newest dot pops in and stays subtly pulsing). A fourth telemetry panel — **NeuralDebugHud** (`debug` key) — anchors bottom-right outside the rail and surfaces training/health internals as numbers (see § "Broadcast UX" above). All four panel keys default on; toggle via `?panels=mlp,gauge,dots,debug`. See `docs/WEBSOCKET_EVENTS.md` § `streamer:nn-tick` for the payload schema.

### Architecture

```
Main thread                     Worker thread (cpuset-pinned to host CPUs 2,3)
─────────────────               ────────────────────────────────────────────
Playwright (Chromium)           MLP forward + backward + AdamW
TTS / chat / Socket.IO          Prioritized replay buffer (PER, cap 512)
LearningBridge ◄── messages ──┤ Teaching Moments buffer (32, "aha")
  predict (150 ms budget)        Feature extractor + EMA normalizer
  update (fire-and-forget)       better-sqlite3 (snapshots + round log)
                                 NDJSON round logger (rotating, 14d)
```

Source: `packages/bot-streamer/src/learning/`. Compute: ~4,800 params (~38 KB), <2 ms per round forward+backward+AdamW.

### Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `STREAMER_LEARNING_ENABLED` | `false` | Master flag; flip to `true` to start the worker |
| `STREAMER_LEARNING_MODE` | `off` | `off` / `shadow` (predict + update; ignored by strategy) / `active` (predict drives strategy) |
| `STREAMER_LEARNING_DATA_DIR` | `/var/streamer/data` | SQLite DB + seed file location |
| `LEARNING_FORCE_HEURISTIC` | _(unset)_ | Kill-switch. `1` / `true` / `yes` skips the learning bridge boot entirely, regardless of `STREAMER_LEARNING_ENABLED`. Faster recovery path during incidents than flipping the bridge flag + waiting for it to reset. |
| `NN_DIVERGENCE_THRESHOLD_OVERRIDE` | `1e5` | Stabilisation knob. Lowers the per-step pre-clip grad-norm rollback threshold. Try `5000` for the first ~1000 rounds after a fresh deploy. |
| `NN_NAN_STORM_THRESHOLD` | `10` | Stabilisation knob. Drops the count of NaN rollbacks per hour that flips the freeze gate. Try `5` for the first 24h after a fresh deploy. |
| `STREAMER_BIDDING_BOT_DIFFICULTY` | `medium` | NPC difficulty for `quickplay_bidding`'s auto-fill bots. `easy` / `medium` / `hard`. |
| `STREAMER_COMPETITIVENESS` | `0.7` | Stabilisation knob. ∈ [0,1] persona knob for the bidding decoder — quantile aggressiveness, clip/gambit thresholds, opponent simulator σ-floor. 0.7 = "clearly trying, occasionally human-foolish." |

These learning/stabilisation knobs are advanced and intentionally omitted from `.env.example` (which carries only the common-path streamer vars). The table above is the authoritative reference for them — copy a row into your `.env` only when you need to override the listed default.

### Killswitch

```bash
ssh prod
# Faster recovery via kill-switch (bypasses the learning bridge entirely):
echo 'LEARNING_FORCE_HEURISTIC=1' >> /opt/price-game/.env
docker restart price-game-streamer-1
# Bot returns to heuristic-only mode in <10 s.

# Or, the long-form (older) approach:
sed -i 's/STREAMER_LEARNING_ENABLED=true/STREAMER_LEARNING_ENABLED=false/' /opt/price-game/.env
docker restart price-game-streamer-1
```

### Pre-deploy parachute snapshot

**When to use:** run this immediately before any deploy that changes the model
architecture (the network's layer shape / feature spec). Such changes bump the
`archHash`, which makes the worker auto-archive its current snapshot on boot and
start from a re-initialised network — losing the trained weights. The parachute
is a plain filesystem copy of `learning.db` taken *before* the deploy, so if the
post-deploy model misbehaves you have a deterministic restore point instead of
having to hunt for the right archived snapshot row.

```bash
sudo bash scripts/streamer-parachute-snapshot.sh
# Writes $HOME/learning.db.parachute-pre-3d2 (+ -wal / -shm if present)
# (override the destination with the PARACHUTE_PATH env var)
```

To restore: `docker cp learning.db.parachute-pre-3d2 price-game_streamer_1:/var/streamer/data/learning.db && docker restart price-game_streamer_1`.

### Smoke test

```bash
docker compose -f docker-compose.prod.yml up -d streamer
docker exec price-game-streamer-1 ls -la /var/streamer/data/learning.db*
curl -s localhost:9101/healthz | jq .learning
# Default: { enabled: false, mode: "off", … }
watch -n 30 'curl -s localhost:9101/healthz | jq ".learning | {bufferSize, lastSnapshotRound, nanRollbacks, goldenMAE, staleResponses}"'
```

### Manual rollback

**When to use:** the learned model has drifted or destabilised (e.g. a NaN-storm
the auto-thaw didn't recover from, or a bad run of predictions) and you want to
revert it to a known-good earlier state without wiping it entirely. Pick a round
number from before the problem started.

```bash
./scripts/nn-rollback.sh 1234   # rolls back to round 1234
```

The script re-inserts an archived snapshot row from `nn_snapshots_archived` into `nn_snapshots`, then restarts the container so the worker reloads.

### Operational guards

The bridge + worker enforce six guards. Each surfaces on `/healthz.learning` and is documented for on-call response.

| Guard | Threshold | What happens | `/healthz.learning` field |
| --- | --- | --- | --- |
| **Worker heartbeat** | absent >30 s | Bridge logs + auto-respawns the worker (`maybeRestartWorker`); bot stays on heuristic during the gap. Container is NEVER killed (would tear down Chromium + the live stream). | `degraded: "worker_dead"` |
| **NaN-storm freeze** | >10 rollbacks in 1 hour | Worker freezes — skips Adam steps, keeps prediction running on the last-good params. Auto-thaws once the rate falls back below threshold. | `degraded: "nan_storm"`, `frozen: true`, `nanRollbacks` count |
| **Snapshot-age alarm** | >10 min during active stream | Surfaced for ops dashboards; no automatic action (the worker keeps trying every snapshot interval). | `snapshotAgeMs` |
| **Disk-pressure** | usage ≥80% | NDJSON writes pause; `degraded:'disk'` flips. At ≥90% snapshots also stop. Polled every 60 s by `checkDiskPressure`. | `degraded: "disk"`, `diskUsedRatio` |
| **DB-write latency** | p95 > 50 ms | Telemetry only; alarm wiring is operator-side. | `dbWriteLatencyP95Ms` |
| **Snapshot-only-when-idle** | `bridge.lastPredictAt < 2 s ago` | Snapshot defers to next predict-idle window. Prevents `wal_checkpoint(TRUNCATE)` from blocking mid-frame. | n/a (silent) |
| **150 ms predict budget** | predict response > 150 ms | Bridge resolves to null; strategy falls back to heuristic. | `staleResponses` count |

On-call response by signal:

- **`degraded: "worker_dead"`** — Bridge auto-restarts every 10 s. If it persists for >5 min, check `docker logs price-game-streamer-1 | grep "worker"` for repeated init failures. Most likely culprit: SQLite write failure (DB volume full → see disk pressure).
- **`degraded: "nan_storm"`** — Capture `nanRollbacks`, the recent product feed, and the last 50 round-log rows (`SELECT * FROM nn_round_log ORDER BY round DESC LIMIT 50;`). Then either wait it out (auto-thaw is the happy path) or `./scripts/nn-rollback.sh <last-known-good-round>` to a snapshot from before the storm.
- **`degraded: "disk"`** — `df -h /var/streamer` to confirm. Either grow the volume or `./scripts/nn-rollback.sh` to drop NDJSON history.
- **`snapshotAgeMs` > 10 min** — Snapshots only run when `lastPredictAt > 2 s ago`; a stuck-busy bot would explain it. Check the bot's `/status` for `panicCount` first.
- **`dbWriteLatencyP95Ms` > 50 ms** — Disk contention or a swap-thrashed VM. Check host `iostat`.

### Reset endpoint

When the model has wedged itself badly enough that rollback can't recover (e.g. you bumped MODEL_SPEC without bumping arch_hash, or a long sample-flood drift), the operator can wipe everything and start fresh:

```bash
curl -X POST -H "X-Streamer-Bot: $STREAMER_BOT_SECRET" \
  http://localhost:9101/reset-learning
# {"ok": true}
```

This:

1. Archives the current snapshot to `nn_snapshots_archived` (so it can be restored later).
2. Zeros every mutable structure inside the worker (network params, optimizer, normalizer, replay buffer, teaching moments, OOD blender, uncertainty weights).
3. Resets the round counter to 0.
4. Emits a null `streamer:nn-tick` so the broadcast panels go idle until the next round trains.

Bot keeps playing throughout — it's heuristic-only for the first ~32 rounds (normalizer warmup) then gradually relearns.

### Seed files

```bash
node scripts/build-brand-tier-seed.mjs --db apps/server/data/price-game.db --out /var/streamer/data/brand-tiers.json
node scripts/build-golden-eval-seed.mjs --db apps/server/data/price-game.db --out /var/streamer/data/golden-eval.json
```

Both are optional — when absent the system still trains, the brand-tier head just sees mid-tier (=1) labels for every product.

## See also

- `infra/streamer/README.md` — image build instructions
- `infra/streamer/Dockerfile` — container layout
- `infra/streamer/entrypoint.sh` — daemon orchestration
- `packages/bot-streamer/` — the bot's TypeScript source
- `packages/bot-streamer/src/learning/` — multi-task learning subsystem
- `.env.example` — full env-var reference
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — main app deployment (sibling doc in this directory)
