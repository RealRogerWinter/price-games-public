---
title: Streamer — Mood
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: "Vibe/morale state machine, prosody, and mood-driven sprite selection."
related_code:
  - packages/bot-streamer/src/realism
  - packages/bot-streamer/src/persona
---
# Streamer Bot — Mood System

> Pricey's emotional state machine. Drives narrator prosody, softmax temperature, NN credit weighting, and avatar sprite selection. For the surrounding loop, see [`architecture.md`](./architecture.md).

## The vocabulary

Eight mood labels, defined in [`packages/shared/src/moods.ts`](../../packages/shared/src/moods.ts):

```typescript
export const MOOD_LABELS = [
  "neutral",
  "happy",
  "frustrated",
  "focused",
  "confident",
  "elated",
  "tilted",
  "despondent",
] as const;
export type Mood = typeof MOOD_LABELS[number];
```

Each carries a `MoodDescriptor` (emoji, sprite fallback, prosody triple). The full registry lives in the same file. Updating the vocabulary is a structured operation — see "Adding a new mood" below.

## State machine

`MoodState` lives at [`src/persona/mood.ts`](../../packages/bot-streamer/src/persona/mood.ts):

```typescript
interface MoodState {
  mood: Mood;       // currently displayed label
  vibe: number;     // ∈ [-3, 3]   short-term, decays per round
  morale: number;   // ∈ [-1, 1]   long-term EMA over game outcomes
  streak: number;   // signed round streak (±N for N same-direction outcomes)
}
```

**Two-layer model:**

- **Vibe** is fast. It decays at `0.92` per round (so memory ≈ 12 rounds) and absorbs each round's outcome via `VIBE_DELTA[outcome]`. This is what drives the mood you see flicker after a win or loss.
- **Morale** is slow. It's an EMA over per-**game** outcomes with `α = 0.18` (memory ≈ 5 games). One bad game won't tip it; a session of bad games will. Morale is what makes Pricey settle into "despondent" after a long losing run rather than bouncing back the moment a single round goes their way.
- **Streak** is signed: `+N` after N consecutive wins, `-N` after N losses. Flips reset to `±1`.

### Folding events

Single entry point: `nextMood(prev: MoodState, input: MoodInput): MoodState`.

`MoodInput` is a discriminated union:

```typescript
| { kind: "round_outcome"; outcome: "win" | "loss" | "soft_win" | "soft_loss" }
| { kind: "game_outcome"; win: boolean }
```

The discriminator lets future inputs (chat sentiment, music swap, lobby empty) bolt on as new `kind` arms without changing call sites.

### Resolving the label

`resolveMood(vibe, morale, streak)` is a pure decision table — no ML, just a readable if-chain. The general shape:

| Condition | Mood |
|---|---|
| `vibe ≥ 2 && streak ≥ 3` | `elated` |
| `vibe ≥ 1` | `happy` or `confident` (depending on morale) |
| `vibe ≤ -2 && streak ≤ -3` | `despondent` or `tilted` (depending on morale) |
| `vibe ≤ -1` | `frustrated` |
| `vibe near 0 && morale > 0.3` | `focused` (low-noise, locked-in) |
| else | `neutral` |

Read the inline decision table in [`src/persona/mood.ts`](../../packages/bot-streamer/src/persona/mood.ts) for the exact thresholds — they're tuned and subject to change. The test suite [`packages/bot-streamer/tests/persona.test.ts`](../../packages/bot-streamer/tests/persona.test.ts) and [`moodAdversarial.test.ts`](../../packages/bot-streamer/tests/moodAdversarial.test.ts) covers the decision boundaries and adversarial inputs.

## What mood drives

### 1. Narrator prosody

Every mood has a prosody triple in `MOOD_REGISTRY`:

```typescript
prosody: {
  lengthScale: number,  // Piper --length_scale (pacing — higher = slower)
  noiseScale: number,   // Piper --noise_scale (timbral variability)
  noiseW: number,       // Piper --noise_w (rhythmic variability)
}
```

The narrator passes the mood's prosody through to `engine.say(line, { lengthScale, noiseScale, noiseW })`. Piper applies them. Approximate ranges by mood:

| Mood | lengthScale | Feel |
|---|---|---|
| `elated` | ~0.90 | rapid, excited |
| `happy` | ~0.95 | brisk |
| `confident` | ~1.00 | even |
| `neutral` | ~1.00 | baseline |
| `focused` | ~1.02 | slightly measured |
| `frustrated` | ~1.05 | a beat slower, terser |
| `tilted` | ~1.08 | dragging |
| `despondent` | ~1.15 | noticeably slow |

The `piperEngine` clamps `lengthScale ∈ [0.5, 2.0]`, `noiseScale ∈ [0.0, 1.5]`, `noiseW ∈ [0.0, 1.5]` so a malformed descriptor can't ask Piper for an unintelligible utterance.

### 2. Softmax temperature

The runner reads `state.moodState` when sampling strategy candidates. Mood multiplies the base `skillTemperature`:

- `focused` → tightens (multiplier < 1.0) — bot more often picks its top candidate
- `elated`, `tilted` → loosens (multiplier > 1.0) — bot takes more swings

The exact multipliers live in [`src/persona/moodScale.ts`](../../packages/bot-streamer/src/persona/moodScale.ts).

### 3. NN credit weighting

When online learning is active, mood biases the training signal. `arousalGainFor(mood)` and `signedCreditGain(mood, outcome)` in [`src/persona/moodScale.ts`](../../packages/bot-streamer/src/persona/moodScale.ts) scale the gradient: high-arousal moods (`elated`, `tilted`) weight updates more heavily, simulating the human pattern of remembering wins-when-excited and losses-when-mad more vividly than middle-ground outcomes.

### 4. Avatar sprite

The broadcast overlay's `Avatar` component selects from a `BODY_BY_MOOD[mood][mouthState]` table — three sprites per mood (closed / mid / wide mouth aperture). The sprites live under `apps/web/src/assets/avatars/pricey/` and are regenerated by [`scripts/regen-pricey-mouth-sprites.mjs`](../../scripts/regen-pricey-mouth-sprites.mjs).

## Persistence across restarts

The bot persists mood across container restarts so a multi-hour mood arc survives:

- Runner calls `driver.hydrateMood()` on boot → `GET /api/streamer/mood` returns the last persisted snapshot.
- After every round / game outcome the runner `POST`s to `/api/streamer/mood` with `{ vibe, morale, streak, mood }`.
- The server fans the snapshot out via the `streamer:mood` socket event so the broadcast overlay's MoodWheel updates live for any web viewer.

This is the difference between "happy bot on a 50-round losing streak" (no persistence) and "despondent bot, even after the first win of a new container, until morale recovers".

## Adding a new mood

The mood registry is the single source of truth. Adding a 9th label means three coordinated edits:

### 1. Extend `MOOD_LABELS` and `MOOD_REGISTRY`

```typescript
// packages/shared/src/moods.ts
export const MOOD_LABELS = [
  // ... existing 8
  "amused",
] as const;

export const MOOD_REGISTRY: Readonly<Record<Mood, MoodDescriptor>> = {
  // ... existing 8
  amused: {
    emoji: "😆",
    spriteFallback: "happy",  // until you generate the sprites, fall back to an existing one
    prosody: { lengthScale: 0.93, noiseScale: 0.85, noiseW: 0.9 },
  },
};
```

Every consumer that imports `MOOD_REGISTRY` picks the new entry up automatically — the narrator, the prosody clamper, the overlay.

### 2. Generate the sprite trio

Three sprites per mood: closed mouth, mid aperture, wide aperture (used by the mouth-animation viseme mapper). Re-run [`scripts/regen-pricey-mouth-sprites.mjs`](../../scripts/regen-pricey-mouth-sprites.mjs) with the new mood added to the prompt manifest. Add the three resulting WebP files to `BODY_BY_MOOD` in the web app's `Avatar.tsx`.

Until the sprites exist, `spriteFallback` makes the new mood render with an existing mood's body.

### 3. Wire the decision table

If your new mood should be reachable, extend `resolveMood` in [`src/persona/mood.ts`](../../packages/bot-streamer/src/persona/mood.ts) to return it for some `(vibe, morale, streak)` combination. Otherwise it'll never be selected and the registry entry is dead config.

### 4. Validate

Add tests for the new mood in [`persona.test.ts`](../../packages/bot-streamer/tests/persona.test.ts):

- The "polarity contract" — confirm negative-emotion moods have `lengthScale > 1.0` and positive-emotion ones have `lengthScale < 1.0`.
- The decision-boundary test — confirm `resolveMood` returns your new mood for the inputs you expect.
- A snapshot of the full `MOOD_REGISTRY` to catch accidental shape drift.

## Operator levers

- **`STREAMER_MOOD_INFLUENCE=0`** disables mood's effect on softmax temperature (useful for A/B-testing the bot's gameplay independent of mood).
- **`/api/streamer/mood`** endpoint accepts a manual `POST` to seed a mood for debugging (admin-gated).
- **MoodWheel panel** on the broadcast overlay is the live debug view — vibe bar, morale bar, current label, recent transitions.
