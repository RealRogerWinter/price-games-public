# Streamer container

Runs the 24/7 bot streamer pipeline in one image:

- **Xvfb** virtual display (`:100`, 1920×1080@30 by default)
- **Chromium** headed-on-Xvfb, driven by Playwright from the bot runner
- **Pulseaudio** virtual sink `broadcast` for music + TTS
- **mpd** plays royalty-free music from `/var/streamer/music` into the broadcast sink
- **Piper TTS** synthesises the bot's narration into the broadcast sink
- **ffmpeg** captures the X11 display + Pulse monitor, x264-encodes, and pushes to local nginx-rtmp
- **nginx-rtmp** fans the encoded stream out to YouTube / Twitch / Kick simultaneously
- **bot-streamer** Node runner — drives Playwright, observes Socket.IO, dispatches strategies, narrates via Piper

## Build

```bash
docker build -f infra/streamer/Dockerfile -t price-game-streamer:latest .
```

(Note: build context must be the **repo root** so the Dockerfile can `COPY` workspace files.)

## Run

The compose integration ships in PR 14. For a manual smoke test:

```bash
docker run --rm \
  --env-file .env.streamer \
  -v price-game_streamer-data:/var/streamer \
  -v "$HOME/streamer-music:/var/streamer/music:ro" \
  price-game-streamer:latest
```

Required env vars (see PR 14's `.env.example`):

- `STREAMER_TARGET_URL` (no default — required) — the URL Playwright loads. Must be the tailnet hostname for the host (e.g. `https://onestreamer.tail-abcd.ts.net`); the broadcast overlay is intentionally blocked on the public `price.games` domain. The runner refuses to start with this unset or pointing at a known-public host.
- `STREAMER_BOT_DISPLAY_NAME` / `STREAMER_BOT_AVATAR` — bot identity
- `STREAMER_YOUTUBE_KEY` / `STREAMER_TWITCH_KEY` / `STREAMER_KICK_KEY` — RTMP destinations (any subset; missing keys mean that platform is skipped)
- `STREAMER_TWITCH_CHANNEL` — channel to read chat from
- `STREAMER_TWITCH_OAUTH` — optional, only needed if the bot wants to chat back

## Quality knobs

- `STREAMER_WIDTH` / `STREAMER_HEIGHT` (default 1920/1080)
- `STREAMER_FPS` (default 30)
- `STREAMER_BITRATE_KBPS` (default 4500). Drop to 2800 if the host CPU is constrained.

## What's NOT in this PR

- docker-compose integration (PR 14)
- Caddy / DNS for an operator-only preview UI (PR 14)
- The `runner/main.ts` entrypoint that `entrypoint.sh` exec's into still has to be filled out — for now it's a placeholder that boots Chromium and idles. The full Playwright-driven bot runner ships in a follow-up PR.
- YouTube + Kick chat adapters (still in flight — Twitch is the only chat source wired in)

See `docs/STREAMER.md` (PR 15) for the full operator runbook.
