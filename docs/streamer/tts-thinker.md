---
title: Streamer — TTS & Thinker
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: "Piper TTS pipeline, mouth animation, and the visual-only Thinker thought bubbles."
related_code:
  - packages/bot-streamer/src/tts
---
# Streamer Bot — TTS and the Thinker

> Pricey speaks (narrator + Piper TTS) and thinks (Thinker visual thought bubbles). Two related but distinct subsystems. For the surrounding loop, see [`architecture.md`](./architecture.md).

## Narrator vs. Thinker, at a glance

|  | Narrator | Thinker |
|---|---|---|
| **Output** | Audible TTS line + on-screen subtitle | Visual-only thought bubble on the overlay |
| **Triggered by** | Lifecycle / round-result events | Strategy / NN / outcome events |
| **Mood handling** | Picks a mood-tagged line variant; Piper applies prosody | Picks a mood-tagged template variant; bubble shows mood emoji |
| **Queueing** | Serial TTS queue (no overlap) | Fire-and-forget (no queue) |
| **Gates** | None — every queued line speaks | TTS-active watermark + min interval + template-exists |
| **Module** | [`src/runner/narrator.ts`](../../packages/bot-streamer/src/runner/narrator.ts) + [`src/tts/`](../../packages/bot-streamer/src/tts/) | [`src/runner/thinker.ts`](../../packages/bot-streamer/src/runner/thinker.ts) |
| **Tests** | [`narrator.test.ts`](../../packages/bot-streamer/tests/narrator.test.ts) | [`thinker.test.ts`](../../packages/bot-streamer/tests/thinker.test.ts) |

A useful mental model: the narrator is Pricey's **mouth**; the Thinker is Pricey's **inner monologue made visible**. They are gated to never compete for audience attention.

## TTS engine abstraction

[`src/tts/engine.ts`](../../packages/bot-streamer/src/tts/engine.ts) — `TtsEngine` is the contract:

```typescript
interface TtsEngine {
  say(line: string, opts?: SayOptions): Promise<void>;
  dispose(): Promise<void>;
}
```

Three implementations ship:

- `nullEngine` — drops every line. Default for unit tests and any local dev where the streamer container isn't running.
- `loggingEngine` — writes lines to a sink. Useful for asserting which lines fired in what order.
- `piperEngine` — spawns Piper as a subprocess, pipes its PCM stdout to Pulseaudio. Production.

`SayOptions` carries `lengthScale`, `noiseScale`, `noiseW` (mood-driven Piper args, clamped inside `piperEngine`) and `meta` (opaque per-utterance metadata threaded through the engine's callbacks so the runner can attribute PCM chunks back to the *correct* utterance when two `narrator.speak()` calls overlap).

## Piper pipeline

[`src/tts/piperEngine.ts`](../../packages/bot-streamer/src/tts/piperEngine.ts):

```
narrator.speak(intent, mood)
        │
        ▼
linePicker → mood-tagged line text
        │
        ▼
engine.say(text, { lengthScale, noiseScale, noiseW, meta })
        │
        ▼
spawn piper --model <voice> --length_scale ... --noise_scale ... --noise_w ...
        │
        ▼ stdin: text
        ▼ stdout: raw 16-bit mono PCM @ 22050 Hz
        │
   ┌────┴────┐
   ▼         ▼
PulseAudio   PCM batcher → chunkThrottle → overlay
("broadcast" (`src/runner/pcmBatcher.ts`, `chunkThrottle.ts`)
 sink)       │
             ▼
        Avatar mouth animation
        (viseme aperture from RMS amplitude)
```

Two consumers, one PCM stream:

1. **PulseAudio sink `broadcast`** — captured by ffmpeg alongside Xvfb video and pushed to nginx-rtmp.
2. **PCM batcher → chunk throttle → overlay** — the same audio bytes are batched into ~50ms chunks, throttled to the wall-clock playback rate, and forwarded to the overlay as `tts.utterance.audio_chunk` events. The Avatar component decodes RMS amplitude per chunk into a mouth-aperture (0–1) and selects from `BODY_BY_MOOD[mood][closed|mid|wide]`.

**Chunk burst timing was the root cause** of the lip-sync saga (PRs #260–#308). [`src/runner/chunkThrottle.ts`](../../packages/bot-streamer/src/runner/chunkThrottle.ts) is the fix: Piper produces PCM faster than real-time, so without throttling the overlay sees every chunk for an utterance arrive in a burst before any audio plays. The throttle paces chunk delivery to match wall-clock playback.

## The line library

[`src/tts/lines.ts`](../../packages/bot-streamer/src/tts/lines.ts) — mood-tagged line library + `createLinePicker(opts)`.

Each `LineEvent` (e.g. `round_start`, `round_win`, `round_loss`, `viewer_command_ack`, `ack_mode`, `ack_hint_lead`) has either:

- A flat list of generic variants, or
- A `byMood` object mapping `Mood → string[]`.

The picker:

1. Looks at the event's variants and the optional mood hint.
2. With probability `moodBias` (default 0.75), draws from the mood-tagged pool when one exists for the requested mood; otherwise from the generic pool.
3. Avoids repeating any line within a sliding `noRepeatWindow` (default 3 lines).

Adding a new line is a single-file edit. Adding a new event is two-step: extend `LineEvent`, add lines to the library.

## The Narrator

[`src/runner/narrator.ts`](../../packages/bot-streamer/src/runner/narrator.ts) wraps the line picker + TTS engine and adds:

- **`speak(intent, mood)`** — pick a line for `intent` biased toward `mood`, pass mood's prosody to the engine. Returns `LineMeta` for the runner to feed to the Thinker's `observeTtsLine` and the overlay's subtitle component.
- **`say(text)`** — raw text passthrough (no line picking, no mood-tagged variants). Used for variable text like the literal `lastRationale` or stats.
- **`onLine(callback)`** — the runner subscribes to be notified the *moment* a line is decided, so the overlay subtitle + utterance controller see it before Piper has produced any audio.

The TTS queue is serial — calling `speak()` twice in quick succession plays them back-to-back, not in parallel. The `meta` field in `SayOptions` lets the runner correctly attribute later PCM chunks to the right utterance when two are queued.

## The Thinker

[`src/runner/thinker.ts`](../../packages/bot-streamer/src/runner/thinker.ts) — Pricey's visual inner monologue.

### Why it exists

Watching the bot, viewers ask "what is it thinking?" That's hard to answer audibly — every guess can't trigger a TTS line without drowning out everything else. The Thinker gives Pricey **a visible thought bubble at decision moments** that don't warrant a spoken line: strategy considered, NN prediction, surprised by outcome, etc.

### The interface

```typescript
interface Thinker {
  observeTtsLine(durationMs: number): void;
  consider(event: ThoughtEvent, mood: Mood | undefined, payload: ThoughtPayload): void;
  forceEmit(event: ThoughtEvent, mood: Mood | undefined, payload: ThoughtPayload): void;
}
```

- `observeTtsLine` is called by the narrator's `onLine` callback. The Thinker sets a "TTS active" watermark to `now + durationMs + ttsTailBufferMs` (default tail buffer: 500ms).
- `consider` is fire-and-forget. It drops silently if any gate fails (TTS active, min-interval not elapsed, no template variants for the event/mood combo).
- `forceEmit` skips gates. Used when the thought *is* the entire point of the moment (e.g., emitting the literal strategy rationale that used to be a round-decision spoken line).

### Gates

| Gate | Default | Why |
|---|---|---|
| TTS-active watermark | `now + durationMs + 500ms` | Audience can't read + listen to two streams |
| Min interval between thoughts | 8000ms | Back-to-back bubbles read as a flood |
| Template exists | n/a | If the event has no variants for the given mood, drop |

### Templates

[`src/tts/thoughts.ts`](../../packages/bot-streamer/src/tts/thoughts.ts) — `createThoughtPicker(opts)`.

Templates are keyed by `ThoughtEvent` (e.g. `strategy_considered`, `nn_prediction`, `outcome_surprised`, `mood_shift`, `teaching_moment`) and `Mood`. Each template is a Mustache-like string with placeholders that pull from the `ThoughtPayload`:

```
strategy_considered + focused:
  "{{rationale}} — committing."

nn_prediction + neutral:
  "Net says about ${{predictionDollars}}."

outcome_surprised + frustrated:
  "Didn't see ${{actualDollars}} coming."
```

The picker fills the template, returns the text, and the Thinker wraps it in a `ThoughtBubblePayload` `{ id, text, intent, mood, at }` and emits it to the overlay.

### Overlay rendering

The broadcast overlay's `ThoughtBubble` panel keys list entries by the bubble's `id` and animates each one for a TTL relative to `at`. Stacked thoughts are rendered as a feed (newest on top), oldest fading out as new ones arrive.

## Cold-start guarantees

PR #299 hardened the boot path: the Avatar component mounts on the overlay before the first `narrator.speak()` fires (5s timeout). Without that, the first utterance of a fresh container could fire before the Avatar's chunk listener was attached, and the mouth would stay closed through the first line.

## Operator levers

| Env var | Effect |
|---|---|
| `STREAMER_TTS_VOICE_MODEL` | Path to Piper ONNX voice model. Absent → `nullEngine` (silent bot, useful for soak tests). |
| `STREAMER_THINKING_PAD_MS` | Extra dwell after a decision before the next action — gives the Thinker time to render. |
| `STREAMER_TTS_DEBUG=1` | Logs every `say()` call with text + chosen prosody. |

## Testing patterns

- Use `loggingEngine` or a fake engine that records call order.
- For the Thinker, inject `now` and `idGen` for determinism. Assert `forceEmit` emits regardless of gates; `consider` drops when watermark hasn't elapsed; consider's template fill matches expectations.
- See [`packages/bot-streamer/tests/narrator.test.ts`](../../packages/bot-streamer/tests/narrator.test.ts), [`thinker.test.ts`](../../packages/bot-streamer/tests/thinker.test.ts), [`thoughts.test.ts`](../../packages/bot-streamer/tests/thoughts.test.ts), [`piperEngine.test.ts`](../../packages/bot-streamer/tests/piperEngine.test.ts), [`pcmBatcher.test.ts`](../../packages/bot-streamer/tests/pcmBatcher.test.ts), [`chunkThrottle.test.ts`](../../packages/bot-streamer/tests/chunkThrottle.test.ts).
