---
title: Streamer — Architecture
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: "The runner loop: lifecycle → driver → observer → strategy → enact → outcome → narrator → mood."
related_code:
  - packages/bot-streamer/src/runner
  - packages/bot-streamer/src/lifecycle
---
# Streamer Bot — Architecture

> The autonomous Twitch bot "Pricey" who plays Price Games live, 24/7. This doc is the bird's-eye view of how the bot works internally. For ops/runbook content (deployment, persona swaps, monitoring), see [`../STREAMER.md`](../STREAMER.md). For a specific subsystem, see the sibling docs in this directory.

## The loop, in one breath

The bot is a long-running Node process that:

1. **Picks a plan** ("play a solo classic round", "join the next public bidding lobby", "host a public game") from a stateful policy.
2. **Drives a real browser** (headed Playwright Chromium) to enact the plan against the live game server — clicks lobby buttons, types guesses, submits answers.
3. **Listens** over an injected Socket.IO bridge to the server's events as they happen.
4. **Decides** what to do each round by feeding the observed game state into a per-mode strategy (with optional neural-net assistance).
5. **Reacts** — narrating outcomes via Piper TTS, updating its visible mood, and dropping visual thought bubbles into the overlay.
6. **Records the outcome**, updates online-learning state, applies backoff if anything went wrong, and loops.

A separate ffmpeg process captures the browser's Xvfb framebuffer and pushes the encoded video to nginx-rtmp, which fans out to Twitch / YouTube / Kick.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Streamer Bot Process                                │
│                                                                              │
│   Lifecycle loop ── picks plan ──▶  Playwright driver                       │
│     (policy.ts)                       (playwrightDriver.ts)                  │
│                                              │                               │
│                                              ▼                               │
│                                       Headed Chromium                        │
│                                              │                               │
│                                              ▼                               │
│                                    Observer (socket bridge)                  │
│                                       (observer/observer.ts)                 │
│                                              │                               │
│                                              ▼                               │
│                                    BotStateSnapshot                          │
│                                              │                               │
│                            ┌─────────────────┼─────────────────┐             │
│                            ▼                 ▼                 ▼             │
│                       Strategy           Learning           Bidding          │
│                       (mode-specific)    Bridge             Opponents        │
│                            │              (worker MLP)       (tracker)       │
│                            └─────────────────┬─────────────────┘             │
│                                              ▼                               │
│                                    StrategyCandidate                         │
│                                              │                               │
│                                              ▼                               │
│                                    Softmax sampler (temperature ← mood)      │
│                                              │                               │
│                                              ▼                               │
│                                       Enactor (per-mode UI driver)           │
│                                              │                               │
│                                              ▼                               │
│                                       Outcome capture                        │
│                                              │                               │
│                            ┌─────────────────┼─────────────────┐             │
│                            ▼                 ▼                 ▼             │
│                       Mood update       Narrator (TTS)     Thinker (visual) │
│                       (vibe/morale)                                          │
│                            │                                                 │
│                            └─▶ persisted to /api/streamer/mood              │
│                                                                              │
│                            Chat: Twitch ─▶ aggregator ─▶ router ─▶ handlers │
│                            (independent of the loop, fires async)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Wiring entry point

[`packages/bot-streamer/src/runner/main.ts`](../../packages/bot-streamer/src/runner/main.ts) is the production entry point. Its job is to wire all the layers together and start the loop. The file's doc comment walks through the seven wiring steps in order:

1. Load persona from env (validated at the boundary).
2. Build the TTS engine — Piper when `STREAMER_TTS_VOICE_MODEL` is set, `nullEngine` otherwise.
3. Build the chat aggregator + router when a Twitch channel is configured.
4. Build the overlay forwarder (broadcasts to the Chromium page over Socket.IO).
5. Build the `PlaywrightDriver` — headed Chromium with the observer attached.
6. Hand the driver to the lifecycle runner. The runner repeatedly asks the policy for the next plan and calls `driver.execute(plan, signal)`.
7. Start the `/healthz` + `/status` HTTP server on port `9101`.

The wiring degrades gracefully: missing env vars (no Twitch credentials, no voice model) substitute null implementations rather than refusing to boot.

## The layers

| Layer | Module | Job |
|---|---|---|
| **Lifecycle** | [`src/lifecycle/`](../../packages/bot-streamer/src/lifecycle/) | The outer loop. Picks the next plan, runs it via the driver, applies exponential backoff on errors, exposes telemetry. Has zero knowledge of HTTP, sockets, or browsers — that keeps it unit-testable. |
| **Driver** | [`src/runner/playwrightDriver.ts`](../../packages/bot-streamer/src/runner/playwrightDriver.ts) | The "hands". Owns the Chromium instance, the socket bridge into the page, the observer attached to the bridge, and the per-plan enactors. Implements the `Driver` contract in `src/lifecycle/runner.ts`. |
| **Observer** | [`src/observer/`](../../packages/bot-streamer/src/observer/) | The "eyes". Subscribes to socket events and folds them into a `BotStateSnapshot`. Auto-binds `myPlayerId` once the persona name shows up in a `ROOM_UPDATED`. See [`observer.md`](./observer.md). |
| **Strategy** | [`src/strategies/`](../../packages/bot-streamer/src/strategies/) | The "brain", per mode. Pure functions that map a `RoundStartPayload` to a list of `StrategyCandidate`s with scores in [0, 1]. See [`strategies.md`](./strategies.md). |
| **Learning** | [`src/learning/`](../../packages/bot-streamer/src/learning/) | The neural-net trunk + price-class head, isolated in a worker thread. Predicts and trains online. The strategy layer reads `nnPrediction` from context when active. See [`learning.md`](./learning.md). |
| **Heuristics** | [`src/heuristics/`](../../packages/bot-streamer/src/heuristics/) | Category baselines + token multipliers. Used both as the NN's training-signal scaffolding and as the fallback when the NN is off / cold / stale. See [`heuristics.md`](./heuristics.md). |
| **Enactors** | [`src/runner/enact/`](../../packages/bot-streamer/src/runner/enact/) | One file per game mode. Takes a chosen candidate and drives the actual UI — clicking, typing, submitting. |
| **Realism** | [`src/realism/`](../../packages/bot-streamer/src/realism/) | The "humanization" layer. Adds gaussian timing jitter, mouse-movement curves, "thinking" pauses so the bot doesn't move like a robot. |
| **Persona** | [`src/persona/`](../../packages/bot-streamer/src/persona/) | The mood state machine (vibe + morale + streak → mood label). Mood biases narrator prosody, softmax temperature, NN credit weighting, and avatar sprite. See [`mood.md`](./mood.md). |
| **Narrator** | [`src/runner/narrator.ts`](../../packages/bot-streamer/src/runner/narrator.ts) + [`src/tts/`](../../packages/bot-streamer/src/tts/) | Picks a line from the library based on event + mood, runs it through the TTS engine, fires `onLineProcess` so the avatar can sync mouth animation. |
| **Thinker** | [`src/runner/thinker.ts`](../../packages/bot-streamer/src/runner/thinker.ts) | Visual-only inner monologue. Fires thought bubbles on strategy / NN / outcome events. Gated so it never speaks over the narrator. See [`tts-thinker.md`](./tts-thinker.md). |
| **Chat** | [`src/chat/`](../../packages/bot-streamer/src/chat/) + [`src/runner/chatHandlers.ts`](../../packages/bot-streamer/src/runner/chatHandlers.ts) | Twitch / multi-source aggregator → command router → handlers. Lets viewers nudge the bot via `!mode`, `!hint`, `!skill`, etc. See [`chat.md`](./chat.md). |
| **Watchdog + telemetry** | [`src/runner/watchdog.ts`](../../packages/bot-streamer/src/runner/watchdog.ts), [`src/runner/telemetry.ts`](../../packages/bot-streamer/src/runner/telemetry.ts) | Drives the `/healthz` 200/503 verdict and the `/status` dashboard JSON. |

## Lifecycle plan kinds

A "plan" is the unit of work the bot executes between policy decisions. Defined in [`src/lifecycle/types.ts`](../../packages/bot-streamer/src/lifecycle/types.ts):

- **`solo`** — call `/api/game/start`, play N rounds, emit outcomes.
- **`public_join`** — match into a public quickplay lobby, play whatever mode it's set to.
- **`host_public`** — create a public room and wait up to N seconds for opponents.
- **`quickplay_bidding`** — start a bidding-war Quick Play lobby pre-filled with server-side NPCs.

The plan picker ([`src/lifecycle/policy.ts`](../../packages/bot-streamer/src/lifecycle/policy.ts)) is a stateful sampler that picks plans probabilistically while:

- Never repeating the same plan back-to-back.
- Maintaining an EWMA of recent modes so the rotation feels varied.
- Honoring chat-driven `!mode` overrides (one-shot, cleared on read).

## Health and outages

- **`GET /healthz`** — Docker healthcheck. Returns 200 only when the watchdog reports a successful round in the last 5 minutes AND `panicCount < 5`. Otherwise 503; Docker restarts the container after 4 consecutive failures.
- **`GET /status`** — verbose dashboard. Always 200, even when stalled, so post-incident inspection works.
- **Round-level retries** — the driver retries individual UI interactions before bubbling errors to the lifecycle loop's backoff (initial 2s, capped at 60s, exponential).
- **`maxConsecutiveErrors`** — after 5 failures on the same plan, the runner skips to the next plan rather than wedging forever.
- **`LEARNING_FORCE_HEURISTIC`** env var — operator kill-switch. Bypasses the NN entirely without redeploying.

## Where to go next

- Want to **add a new strategy** for a mode? → [`strategies.md`](./strategies.md)
- Want to **add a chat command**? → [`chat.md`](./chat.md)
- Want to **understand mood / prosody**? → [`mood.md`](./mood.md)
- Want to **change voice / mouth animation**? → [`tts-thinker.md`](./tts-thinker.md)
- Want to **understand the online learner**? → [`learning.md`](./learning.md)
- Want to **run the bot locally**? → [`dev.md`](./dev.md)
- Want to **deploy it**? → [`deploy.md`](./deploy.md) and [`../STREAMER.md`](../STREAMER.md)
