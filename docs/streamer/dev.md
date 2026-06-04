---
title: Streamer — Local Dev
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: Running the bot locally without streaming. Test patterns, fixtures, debugging.
related_code:
  - packages/bot-streamer/src
---
# Streamer Bot — Local Development

> How to run, test, and debug the bot without a live Twitch stream. For deploying to production, see [`deploy.md`](./deploy.md) and [`../STREAMER.md`](../STREAMER.md).

## Quick orientation

You can do almost all bot development without ever spawning Chromium, Piper, or ffmpeg. The bot is intentionally layered so each subsystem is unit-testable against a fake of its only side-effecting dependency:

- **Strategies** — pure functions, test with `mockRound` fixtures.
- **Observer** — wraps a `SocketLike`, test with `fakeSocket`.
- **Narrator / Thinker** — wraps a `TtsEngine`, test with `loggingEngine` or `nullEngine`.
- **Chat router** — wraps a `ChatSource`, test with `mockChatSource`.
- **Learning bridge** — wraps a `WorkerTransport`, test with an in-process fake worker.

Reach for Playwright + Piper only when you need to verify end-to-end behavior (lip-sync timing, real round-trip latency).

## Setup

```bash
# From the repo root
npm install
npm run build -w packages/shared    # shared types must build first
npm run build -w packages/bot-streamer

# Run the tests
npm test -w packages/bot-streamer

# Watch mode while developing
npm run test:watch -w packages/bot-streamer
```

Tests use Vitest. No DB, no network, no Chromium. They run in ~5–10 seconds.

## Test patterns

### Strategy

```typescript
import { describe, it, expect } from "vitest";
import { classicStrategy } from "../src/strategies/classic";
import { mockRoundStart } from "../src/test-helpers/fixtures";

describe("classic strategy", () => {
  it("returns at least one candidate with score in [0,1]", () => {
    const cands = classicStrategy.candidates(
      mockRoundStart("classic", { /* product overrides */ }),
      { rng: () => 0.5 },  // deterministic
    );
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every(c => c.score >= 0 && c.score <= 1)).toBe(true);
  });
});
```

### Observer

```typescript
import { attachObserver } from "../src/observer/observer";
import { fakeSocket } from "../src/test-helpers/fakeSocket";
import { mockRoomUpdated, mockRoundStart } from "../src/test-helpers/fixtures";

const socket = fakeSocket();
const observer = attachObserver(socket, { personaName: "Pricey" });
socket.emit("room:updated", mockRoomUpdated({ players: [{ playerId: "p1", displayName: "Pricey" }] }));
expect(observer.getState().myPlayerId).toBe("p1");
```

### Narrator

```typescript
import { createNarrator } from "../src/runner/narrator";
import { loggingEngine } from "../src/tts/engine";

const log: string[] = [];
const narrator = createNarrator(loggingEngine(log));
await narrator.speak("round_start", "happy");
expect(log).toContain("…");  // assert a happy-tagged round_start line was picked
```

### Chat router + handlers

```typescript
import { createCommandRouter } from "../src/chat/router";
import { registerChatCommands, createInitialCommandState } from "../src/runner/chatHandlers";

const router = createCommandRouter({ now: () => 1000 });
const state = createInitialCommandState(0.35);
registerChatCommands({ router, state });

const result = await router.dispatch({
  platform: "twitch", user: "viewer", text: "!mode classic",
  id: "msg1", at: 1000, badges: [],
});
expect(result.kind).toBe("dispatched");
expect(state.nextModeOverride).toBe("classic");
```

### Lifecycle runner (with mock driver)

```typescript
import { runLifecycle } from "../src/lifecycle/runner";

const plans: LifecyclePlan[] = [];
const driver: Driver = {
  async execute(plan) {
    plans.push(plan);
    return { kind: "ok", scoreDelta: 0 };
  },
};

const abort = new AbortController();
const loop = runLifecycle(driver, { signal: abort.signal });
setTimeout(() => abort.abort(), 500);
await loop;
expect(plans.length).toBeGreaterThan(0);
```

Existing patterns at [`packages/bot-streamer/tests/runner.test.ts`](../../packages/bot-streamer/tests/runner.test.ts), [`policy.test.ts`](../../packages/bot-streamer/tests/policy.test.ts).

## Running the bot against a local game server

When you need end-to-end behavior — actual round-trip latency, the real `RoundStartPayload` shape, real ffmpeg encoding — bring up the streamer container locally.

### Prereqs

- Local game server running on `http://localhost:3001` (`npm run dev` from repo root) **OR** a sandbox on `https://sandbox.price.games`.
- Docker installed.
- An `.env` with at least `STREAMER_TARGET_URL` (pointing at your local server) and a `STREAMER_BOT_DISPLAY_NAME`.

### Sandbox-TTS image (lighter)

[`Dockerfile.sandbox-tts`](../../Dockerfile.sandbox-tts) builds a stripped-down image that:

- Mocks Piper with a stub that emits silence (no voice model needed).
- Still runs Chromium + Xvfb + the real bot runner.
- Builds much faster than the production image.

```bash
docker build -f Dockerfile.sandbox-tts -t price-game-streamer-sandbox .
docker run --rm -it \
  --env-file .env \
  -e STREAMER_TARGET_URL=http://host.docker.internal:3001 \
  -p 9101:9101 \
  -p 5900:5900 \
  price-game-streamer-sandbox
```

`5900` is the VNC display so you can watch the bot via `vncviewer localhost:5900`.

### Full production image

Builds Piper, ONNX voice models, mpd, nginx-rtmp, ffmpeg. Use only when you need to verify the audio chain or the rtmp fan-out. See [`deploy.md`](./deploy.md).

## Debugging tips

### "The bot doesn't seem to do anything."

- Check `GET /healthz` and `GET /status`. Lifecycle tick should be recent.
- Check the runner logs (`docker logs <container>` or `tail -f` if running locally). Look for backoff messages — the runner backs off exponentially on errors.
- Check that the persona name matches a real player in the lobby — `myPlayerId` not binding is the silent killer.

### "It picks the same answer every round."

- The softmax temperature defaults to `0.35`. If `STREAMER_LEARNING_MODE=active` and the NN is over-confident, candidate spread collapses. Try `!skill easy` in chat to bump temperature to 0.9 (or set `STREAMER_INITIAL_SKILL=easy` in env).

### "Mouth doesn't move during TTS."

- Almost always a PCM-chunk-burst issue. Confirm `chunkThrottle.ts` is in the build (it was the fix in PR #314).
- Confirm the Avatar overlay component mounted before the first `narrator.speak()` (5-second timeout from PR #299).

### "TTS plays but no audio on the stream."

- PulseAudio sink misconfiguration. The streamer container expects a `broadcast` sink that ffmpeg captures.
- Check `pactl list short sinks` inside the container.

### "The bot is bidding way too low / high in bidding war."

- The bidding decoder is the most complex strategy. Read [`src/strategies/biddingDecoder.ts`](../../packages/bot-streamer/src/strategies/biddingDecoder.ts) end-to-end.
- The `competitiveness` knob (default 0.7) lowers the bid quantile when raised. Operator can tune via runtime config.
- Opponent posteriors are per-game and reset on game-over. The first round of a new opponent set is effectively prior-only.

### "The NN keeps tripping the NaN-storm guard."

- Almost always a feature normalization issue. Check that `EMA normalizer warmup` has elapsed before the failures.
- Inspect the most recent snapshot's weight L2 norm. Runaway norm → effective learning rate too high. Try `STREAMER_LEARNING_LR=5e-4`.
- Worst case, `LEARNING_FORCE_HEURISTIC=1` and let the operator deal with it after the broadcast stabilizes.

## Useful env overrides for development

```ini
# Disable learning entirely
STREAMER_LEARNING_ENABLED=false

# Or learn but don't use predictions
STREAMER_LEARNING_MODE=shadow

# Slow the bot down for visual debugging
STREAMER_SLOWMO_MS=1000

# Extra dwell after decisions so thoughts have time to render
STREAMER_THINKING_PAD_MS=3000

# Skip mood's effect on softmax temperature (A/B isolation)
STREAMER_MOOD_INFLUENCE=0

# Force the kill-switch
LEARNING_FORCE_HEURISTIC=1

# Disable TTS (silent run for soak tests)
STREAMER_TTS_VOICE_MODEL=

# Verbose TTS logging
STREAMER_TTS_DEBUG=1
```

## Where to look first when something goes wrong

1. **`GET /status`** — verbose state. Always returns 200; useful even when the bot is wedged.
2. **`GET /healthz`** — terse pass/fail. The container's restart trigger.
3. **`logs`** — runner log lines tagged with subsystem prefix (`[runner]`, `[learning]`, `[chat]`, `[piper]`).
4. **`vncviewer localhost:5900`** — watch what the bot sees in real time.
5. **The unit tests** — every subsystem has a corresponding test file. If you can reproduce the bug in a unit test, you don't need Chromium to fix it.
