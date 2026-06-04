/**
 * Thinker — Pricey's visual-only inner monologue. Counterpart to
 * `Narrator` (which speaks via TTS); the Thinker only writes to the
 * broadcast overlay.
 *
 * Lifecycle:
 *   1. Runner creates a Thinker per session, wired to the overlay
 *      forwarder.
 *   2. Runner installs `thinker.observeTtsLine(durationMs)` as the
 *      narrator's `onLine` callback so the Thinker knows when TTS
 *      is active. Thoughts never fire while a TTS line is mid-flight.
 *   3. Runner calls `thinker.consider(event, mood, payload)` at NN /
 *      strategy / outcome moments. The Thinker may render the
 *      thought (filling the template + emitting overlay event) or
 *      drop the call silently if a gate fails:
 *        - TTS is currently active (audience would be reading + listening
 *          to two streams at once)
 *        - the inter-thought min interval hasn't elapsed
 *        - the bullet-payload-shaped event has no template variants
 *
 * The Thinker is fire-and-forget from the runner's perspective —
 * `consider()` never throws; rendering errors are swallowed inside
 * the dispatch callback (same contract as overlay.send).
 */

import { randomUUID } from "node:crypto";
import type { Mood } from "../persona/mood";
import { DEFAULT_MOOD } from "../persona/mood";
import type { OverlayForwarder } from "./overlay";
import {
  createThoughtPicker,
  type ThoughtEvent,
  type ThoughtPayload,
} from "../tts/thoughts";

/**
 * Payload pushed onto the overlay bus as `thought.bubble`. The UI
 * renders these in a stacked feed; `id` lets it key list entries
 * stably and `at` drives the per-thought TTL animation.
 */
export interface ThoughtBubblePayload {
  id: string;
  text: string;
  intent: ThoughtEvent;
  mood: Mood;
  at: number;
}

export interface ThinkerOptions {
  /**
   * Optional buffer (ms) to add to TTS durationMs before the
   * "TTS active" gate releases. Without a buffer, a thought could
   * race with the tail end of an utterance — the audience reads
   * mid-sentence. Default 500ms ≈ a comfortable beat after speech.
   */
  ttsTailBufferMs?: number;
  /**
   * Minimum interval between rendered thoughts. Default 8000ms.
   * The audience needs reading time; back-to-back thoughts read
   * as a flood. Set lower in tests for faster assertions.
   */
  minIntervalMs?: number;
  /** Optional clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional RNG for the picker. Defaults to Math.random. */
  rng?: () => number;
  /** Optional id generator for tests that want stable thought ids. */
  idGen?: () => string;
}

export interface Thinker {
  /**
   * Observe a TTS line that just hit the engine. Sets the "TTS
   * active" watermark to `now + durationMs + ttsTailBufferMs` so
   * subsequent `consider()` calls drop until that watermark passes.
   * Wired to the narrator's `onLine` callback by the runner.
   */
  observeTtsLine(durationMs: number): void;
  /**
   * Consider rendering a thought for the given event. Drops silently
   * if any gate fails; otherwise picks a template, fills it, and
   * emits a `thought.bubble` overlay event. Fire-and-forget.
   */
  consider(event: ThoughtEvent, mood: Mood | undefined, payload: ThoughtPayload): void;
  /**
   * Force-emit a thought regardless of TTS / interval gates. Used
   * for callsites where the thought is the WHOLE point (e.g., the
   * literal strategy_rationale stream that replaces the old
   * round.decision rationale). Caller is responsible for not
   * spamming.
   */
  forceEmit(event: ThoughtEvent, mood: Mood | undefined, payload: ThoughtPayload): void;
}

/**
 * Build a Thinker bound to an overlay forwarder. The forwarder is
 * the only side-effecting dependency; everything else is pure /
 * injectable for tests.
 *
 * @param overlay  Where rendered thoughts get sent.
 * @param opts     See {@link ThinkerOptions}.
 */
export function createThinker(overlay: OverlayForwarder, opts: ThinkerOptions = {}): Thinker {
  const ttsTail = Math.max(0, opts.ttsTailBufferMs ?? 500);
  const minInterval = Math.max(0, opts.minIntervalMs ?? 8000);
  const now = opts.now ?? (() => Date.now());
  const idGen = opts.idGen ?? (() => randomUUID());
  const pick = createThoughtPicker({ rng: opts.rng });

  let ttsActiveUntil = 0;
  let lastEmittedAt = 0;

  function emit(event: ThoughtEvent, mood: Mood | undefined, payload: ThoughtPayload): void {
    const resolvedMood = mood ?? DEFAULT_MOOD;
    const text = pick(event, mood, payload);
    if (!text) return;
    const at = now();
    const bubble: ThoughtBubblePayload = {
      id: idGen(),
      text,
      intent: event,
      mood: resolvedMood,
      at,
    };
    void overlay.send("thought.bubble", bubble);
    lastEmittedAt = at;
  }

  return {
    observeTtsLine(durationMs) {
      const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
      const candidate = now() + safeMs + ttsTail;
      // Use max so a short utterance landing during a long one's
      // window doesn't shrink the watermark. (Engine queues serialize
      // utterances; each onLine fires at queue time, not playback
      // start, so two back-to-back lines could both call observe
      // before either has finished.)
      if (candidate > ttsActiveUntil) ttsActiveUntil = candidate;
    },
    consider(event, mood, payload) {
      const t = now();
      if (t < ttsActiveUntil) return;
      if (t - lastEmittedAt < minInterval) return;
      emit(event, mood, payload);
    },
    forceEmit(event, mood, payload) {
      emit(event, mood, payload);
    },
  };
}
