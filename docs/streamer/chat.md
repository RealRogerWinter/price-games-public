---
title: Streamer — Chat
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: Twitch chat ingestion, command routing, rate limits, and adding a new chat command.
related_code:
  - packages/bot-streamer/src/chat
---
# Streamer Bot — Chat System

> How Twitch chat reaches the bot, how commands are parsed and rate-limited, and how to add a new command. For the surrounding loop, see [`architecture.md`](./architecture.md).

## Pipeline

```
┌───────────────┐    ┌───────────────┐    ┌───────────────┐    ┌──────────────┐
│ TwitchSource  │───▶│   Chat        │───▶│   Command     │───▶│   Handler    │
│ (tmi.js)      │    │   Aggregator  │    │   Router      │    │              │
└───────────────┘    └───────────────┘    └───────────────┘    └──────────────┘
                          │  dedupe          │  parse !cmd       │  e.g. !mode
                          │  fan-out         │  rate-limit       │  mutates
                          │  multi-source    │  mod-gate         │  RunnerCommandState
                          ▼                  ▼                   ▼
                     (multi-platform     (cooldowns          (narrator.speak
                      ready for           per-user +          for ack lines)
                      YouTube/Kick)       global)
```

## The four layers

### 1. Source

A `ChatSource` is a platform adapter. Today there's one production source:

- [`src/chat/sources/twitch.ts`](../../packages/bot-streamer/src/chat/sources/twitch.ts) — wraps `tmi.js`, joins the configured channel, emits `IncomingChatMessage` events.

Plus one for testing:

- [`src/chat/sources/mock.ts`](../../packages/bot-streamer/src/chat/sources/mock.ts) — push messages programmatically.

YouTube and Kick adapters are intentionally absent for now — the aggregator's contract is multi-source-ready, so adding them is a self-contained PR.

### 2. Aggregator

[`src/chat/aggregator.ts`](../../packages/bot-streamer/src/chat/aggregator.ts) — `createChatAggregator(sources, opts)`.

- Subscribes to every source's `start(listener)` and fans messages out to a single subscriber bus.
- Dedupes by `${platform}:${id}` with a rolling window (default 200 messages) so a flaky adapter that re-emits doesn't dispatch twice.
- Stamps `at` only when the source omits it (so `at: 0` in tests survives).

### 3. Router

[`src/chat/router.ts`](../../packages/bot-streamer/src/chat/router.ts) — `createCommandRouter(opts)`.

- `parseCommand(message)` extracts `!name args...` from messages starting with `!`.
- `register(spec)` registers a `CommandSpec` (handler + rate limit + mod gate). Last registration wins; calling twice replaces.
- `dispatch(message)` runs the parse + rate-limit + mod-gate gauntlet, then invokes the handler if all checks pass.
- Outcomes are returned so the runner can surface them on the operator UI ("command on cooldown") and to telemetry via `onRejected`.

Defaults: `perUserSeconds: 30`, `globalSeconds: 5`, `modOnly: false`. Each registration can override.

Mod gate accepts the `broadcaster` and `moderator` Twitch badges. ([`MOD_BADGES`](../../packages/bot-streamer/src/chat/router.ts) constant.)

### 4. Handlers

[`src/runner/chatHandlers.ts`](../../packages/bot-streamer/src/runner/chatHandlers.ts) — `registerChatCommands({ router, state, narrator })`.

Handlers mutate `RunnerCommandState` (a small shared mutable struct the runner reads each tick) and optionally trigger narrator lines for spoken acks. They never throw — errors are swallowed by the router so a buggy handler can't take down the dispatch loop.

## The shipped commands

| Command | Per-user | Global | Mod-only | What it does |
|---|---|---|---|---|
| `!mode <name>` | 60s | 5s | no | Queue a one-shot mode override for the next solo plan. Rejects MP-only modes (e.g. `bidding`) silently. |
| `!hint` | 120s | 10s | no | Re-narrate the last decision's rationale ("I picked X because…"). |
| `!skill easy\|normal\|hard` | 300s | 30s | **yes** | Live-set softmax temperature (`easy=0.9`, `normal=0.35`, `hard=0.05`). |
| `!song` | 15s | 5s | no | Speak the currently playing music track (from `mpc`). |
| `!stats` | 20s | 5s | no | Speak win/loss/streak. Updated per **game**, not per round. |
| `!join` | 5s | 5s | no | Echo the bot's current hosted public room code (or "playing solo" if there isn't one). |

All ack lines use `narrator.speak(intent, mood)` so the spoken response is mood-tagged. Variable text (the rationale itself, the stats string) is spoken with the un-mood-tagged `narrator.say()`.

## Mutable state

`RunnerCommandState` ([`src/runner/chatHandlers.ts`](../../packages/bot-streamer/src/runner/chatHandlers.ts)) is the chat surface:

| Field | Written by | Read by |
|---|---|---|
| `nextModeOverride` | `!mode` | Runner before each plan (cleared on read) |
| `skillTemperature` | `!skill` | Runner when sampling candidates |
| `lastRationale` | Runner (per decision) | `!hint` |
| `wins`, `losses`, `streak` | Runner via `finalizeGameOutcome` (per game) | `!stats` |
| `moodState` | Runner via `nextMood` (per round) | Narrator (prosody), overlay (emoji) |
| `nowPlaying` | `musicSource` mpd idleloop subscription | `!song` |
| `hostedRoomCode` | Runner when hosting | `!join` |
| `opponentTracker` | Runner on `quickplay_bidding` plan | Bidding strategy |

## How to add a new command

### 1. Decide the rate limit and mod gate

Spoken responses are cheap, but viewers will spam any new command for the novelty. Default to a generous per-user cooldown (60s+) and a tight global (5–10s). Mod-only any command that mutates the bot's behavior in disruptive ways (changing skill, forcing restarts).

### 2. Register it

In `registerChatCommands` ([`src/runner/chatHandlers.ts`](../../packages/bot-streamer/src/runner/chatHandlers.ts)):

```typescript
router.register({
  name: "vibe",
  rateLimit: { perUserSeconds: 30, globalSeconds: 5 },
  handler: async (cmd) => {
    // cmd.args is string[], cmd.message has user/badges/platform/at
    await narrator?.speak("ack_vibe_lead", state.moodState.mood);
    await narrator?.say(`Right now I'm feeling ${state.moodState.mood}.`);
  },
});
```

If your handler needs new mutable state, add a field to `RunnerCommandState` and to `createInitialCommandState`. Keep the surface narrow.

### 3. (Optional) Add an ack line

Mood-aware ack lines live in [`src/tts/lines.ts`](../../packages/bot-streamer/src/tts/lines.ts) keyed by `intent`. Add `ack_vibe_lead: { ... }` with per-mood variants if you want a spoken lead-in.

### 4. Test it

```typescript
// tests/chatHandlers.test.ts pattern
import { createCommandRouter } from "../src/chat/router";
import { registerChatCommands, createInitialCommandState } from "../src/runner/chatHandlers";

const router = createCommandRouter();
const state = createInitialCommandState(0.35);
const narratorCalls: string[] = [];
const narrator = { speak: (i: string) => { narratorCalls.push(i); return Promise.resolve(); }, say: () => Promise.resolve() };

registerChatCommands({ router, state, narrator });
await router.dispatch({ platform: "twitch", user: "viewer", text: "!vibe", id: "1", at: 0 });
expect(narratorCalls).toContain("ack_vibe_lead");
```

Existing patterns at [`packages/bot-streamer/tests/chatHandlers.test.ts`](../../packages/bot-streamer/tests/chatHandlers.test.ts) and [`chat.test.ts`](../../packages/bot-streamer/tests/chat.test.ts).

## Pipeline subscriber

[`src/runner/chatPipeline.ts`](../../packages/bot-streamer/src/runner/chatPipeline.ts) — `chatPipelineSubscriber`. The runner subscribes the aggregator to a subscriber that does:

1. Pass the message into the router.
2. Forward "interesting" chat (commands + emote-heavy messages, etc.) to the overlay so the broadcast shows a chat scroller.
3. Update mood inputs from chat sentiment (currently neutral; placeholder for future).

## Operational concerns

- **No Twitch credentials → no chat.** Missing `STREAMER_TWITCH_CHANNEL` skips the aggregator wire-up entirely. The runner boots fine without chat.
- **Auth.** Anonymous join is fine for read-only chat consumption. To **post** as the bot persona on Twitch, you'd need a bot account token (not currently wired — the bot's "voice" is the TTS audio on the stream, not Twitch chat messages).
- **YouTube/Kick.** Not wired. The aggregator's `ChatSource` contract is platform-neutral; adding either adapter is contained to a new file in `src/chat/sources/`.
