/**
 * Narrator — converts lifecycle / round-result events into spoken
 * lines via the line picker + TtsEngine. Stateful in mood + recent-
 * lines so consecutive narrations vary naturally.
 *
 * Production wires this to a Piper engine; tests use the logging
 * engine to assert which lines fired in what order.
 */

import { createLinePicker, type LineEvent } from "../tts/lines";
import type { Mood } from "../persona/mood";
import { DEFAULT_MOOD, MOOD_REGISTRY } from "@price-game/shared";
import type { SayOptions, TtsEngine } from "../tts/engine";

/**
 * Per-line metadata pinned at queue time and threaded through
 * `engine.say` → piperEngine's `runOnce` → `onLineProcess` /
 * `onPcmChunk` / `onAudioEnd` callbacks. The runner consumes this
 * shape via main.ts's wiring: `onLineProcess` calls
 * `controller.start(meta)` SYNCHRONOUSLY with the engine's serial
 * chain so PCM chunks for THIS line are correctly attributed even
 * when two `narrator.speak()` calls are queued back-to-back. Opaque
 * to the engine itself; runner does the cast.
 */
export interface LineMeta {
  text: string;
  intent: string;
  mood: Mood;
  estimatedDurationMs: number;
}

export interface NarratorOptions {
  /** Optional RNG injection — defaults to Math.random. */
  rng?: () => number;
  /** No-repeat window for line selection. Defaults to 3. */
  noRepeatWindow?: number;
  /**
   * Probability of drawing from the mood-tagged pool when a mood is
   * supplied. See `PickerOptions.moodBias` in `tts/lines.ts`. Default
   * 0.75. Plumbed here so the runner / tests can override without
   * reaching into the picker directly.
   */
  moodBias?: number;
  /**
   * Optional callback fired with each line about to be spoken. The
   * production driver wires this to the broadcast overlay so
   * `Subtitles` (and PR 2+'s UtteranceController) get the line metadata
   * the moment narrator decides on it — before `engine.say` is even
   * queued, let alone Piper has produced audio.
   *
   * @param line  The line text passed to the engine.
   * @param intent The lifecycle event ("round_start", "viewer_command_ack", etc.)
   *               or "manual" for raw `say()` calls.
   * @param durationMs Estimated speech duration in ms.
   * @param mood Mood used when picking this line. Defaults to
   *             `DEFAULT_MOOD` for `say()` (no event/mood association).
   *             Lets the UtteranceController capture
   *             mood-at-time-of-decision instead of guessing later
   *             from a possibly-changed `stats.mood`.
   */
  onLine?: (line: string, intent: string, durationMs: number, mood: Mood) => void;
}

export interface Narrator {
  /**
   * Speak a line for `event` (with optional mood-aware variant
   * pool). Returns once the line has been queued — the engine
   * sequences playback internally.
   *
   * When `mood` is provided, the mood's prosody descriptor
   * (length_scale) flows through `engine.say` to the underlying
   * Piper subprocess so the utterance pacing matches the mood.
   * Without `mood`, no length_scale is set and Piper falls back to
   * its model default.
   */
  speak(event: LineEvent, mood?: Mood): Promise<void>;
  /**
   * Outcome-driven, rate-limited variant of `speak`. Drops the call
   * silently if an utterance is already in flight; otherwise behaves
   * identically to `speak` (including the mood → prosody threading).
   * Used by the runner for `win_correct` / `loss_off_a_lot` /
   * `game_win` / `game_loss` reactions where queueing would announce
   * a result two utterances after it happened — by then the on-screen
   * state has moved on and the line lands as off-tempo. Skipping is
   * preferable to lagging.
   */
  reactive(event: LineEvent, mood?: Mood): Promise<void>;
  /**
   * Speak a literal string (for !hint and similar where the runner
   * already has the text it wants). Manual say() calls carry no mood
   * signal so prosody is omitted — Piper uses its model default.
   */
  say(line: string): Promise<void>;
  /** Tear down. */
  dispose(): Promise<void>;
}

/**
 * Estimate spoken-line duration in ms. Piper at neutral cadence
 * runs ~200 wpm ≈ 5 chars/word ≈ 60ms/char. Clamped to a
 * [1500, 8000]ms envelope so very short lines still get a
 * readable subtitle window and very long lines don't overstay.
 */
function estimateSpeechDurationMs(text: string): number {
  const raw = text.length * 60;
  return Math.max(1500, Math.min(8000, raw));
}

export function createNarrator(engine: TtsEngine, opts: NarratorOptions = {}): Narrator {
  const pick = createLinePicker({
    rng: opts.rng,
    noRepeatWindow: opts.noRepeatWindow,
    moodBias: opts.moodBias,
  });
  // Tracks utterances the narrator has handed to the engine that have
  // not yet resolved. The runner uses fire-and-forget for `speak` /
  // `reactive`, but the engine's `say()` Promise still resolves
  // when playback completes (Piper) or returns (logging/null) — we
  // treat "any in-flight engine.say()" as "Pricey is currently
  // talking" for the rate-limit check inside `reactive`. A counter
  // (rather than a boolean) tolerates tests that intentionally fire
  // overlapping `speak` calls without throwing off the gating logic.
  let inFlight = 0;
  function emit(line: string, intent: string, mood: Mood): void {
    if (!line || !opts.onLine) return;
    try {
      opts.onLine(line, intent, estimateSpeechDurationMs(line), mood);
    } catch {
      // Telemetry-style callback; never block the engine on a
      // failed dispatch.
    }
  }
  /**
   * Resolve `SayOptions` to attach to an `engine.say` call. Forwards
   * all three Piper prosody knobs from the mood's descriptor so the
   * engine can shell them through to the subprocess. Returns
   * `undefined` when there's no mood, so engine call sites can pass
   * `undefined` straight through to the (no-op) options arg and the
   * subprocess falls back to Piper's model defaults.
   */
  function sayOptionsForMood(mood: Mood | undefined): SayOptions | undefined {
    if (!mood) return undefined;
    const { lengthScale, noiseScale, noiseW } = MOOD_REGISTRY[mood].prosody;
    return { lengthScale, noiseScale, noiseW };
  }
  async function dispatch(line: string, intent: string, mood?: Mood): Promise<void> {
    // Mood defaults to DEFAULT_MOOD for callers (manual `say()`) that
    // don't carry one. The engine only receives a prosody override
    // when the caller explicitly passed a mood — `say()` stays at
    // Piper's model default — but onLine ALWAYS reports a mood so
    // downstream consumers can rely on the field being populated.
    const resolvedMood = mood ?? DEFAULT_MOOD;
    emit(line, intent, resolvedMood);
    inFlight++;
    const meta: LineMeta = {
      text: line,
      intent,
      mood: resolvedMood,
      estimatedDurationMs: estimateSpeechDurationMs(line),
    };
    const sayOpts: SayOptions = { ...sayOptionsForMood(mood), meta };
    try {
      await engine.say(line, sayOpts);
    } finally {
      inFlight--;
    }
  }
  return {
    async speak(event, mood) {
      const line = pick(event, mood);
      await dispatch(line, event, mood);
    },
    async reactive(event, mood) {
      // Drop silently when the engine is mid-utterance — see
      // `Narrator.reactive` doc for why queueing is wrong here.
      if (inFlight > 0) return;
      const line = pick(event, mood);
      try {
        await dispatch(line, event, mood);
      } catch {
        // Reactive lines are decorative and the runner calls this
        // fire-and-forget (`void narrator?.reactive(...)`); a Piper
        // crash here would otherwise surface as an unhandled
        // rejection with no observability. Swallow so a one-time
        // engine error stays a missing line, not a crash. The
        // in-flight counter is still decremented by `dispatch`'s
        // own try/finally — see the test pinning that contract.
      }
    },
    async say(line) {
      if (!line) return;
      // Manual `say()` calls don't carry a mood — the runner uses
      // them for `!hint` rebroadcasts and other operator paths
      // where Pricey's emotional state isn't the relevant signal.
      // Engine receives no prosody override → Piper's model default
      // (length_scale = 1.0) applies.
      await dispatch(line, "manual");
    },
    async dispose() {
      await engine.dispose();
    },
  };
}
