/**
 * VENDORED FROM `packages/bot-streamer/src/runner/utterance.ts` —
 * kept byte-equivalent (only the `Mood` import path differs) so the
 * sandbox lipsync diagnostic exercises the same envelope state
 * machine production runs. The server image cannot import
 * `@price-game/bot-streamer` directly without pulling Playwright
 * into the alpine production image, so this copy is the lesser of
 * two evils. If the upstream module changes, sync this file
 * alongside.
 *
 * UtteranceController — single source of truth on the runner side for
 * "what is Pricey saying right now". Replaces the speaking-clock
 * heuristic (PCM-quiescence-based on/off) with explicit lifecycle
 * events keyed on a per-utterance id:
 *
 *     start      — narrator decided on a line, about to call engine.say
 *     audio_started — Piper produced the first PCM byte (or first chunk
 *                     callback fired) — the moment the speaker actually
 *                     emits audio
 *     audio_chunk    — each chunk of raw PCM samples, carrying the id
 *     audio_ended   — aplay.exit observed — real audio end, NOT a
 *                     quiescence heuristic
 *     cancelled     — the runner abandoned the utterance (e.g. shutdown
 *                     in flight, replaced by a higher-priority line)
 *
 * The controller forwards all five envelopes to a sink; the runner
 * wires the sink to the overlay forwarder so the page receives a
 * coherent stream of `tts.utterance.*` events. PR 3 introduces the
 * page-side `currentUtterance` slot that derives subtitle visibility,
 * speaking flag, and Avatar mouth-snap-closed from a single source —
 * eliminating the three-independent-timelines drift that the v1 design
 * (estimated subtitle duration + PCM quiescence + first-chunk wake-up)
 * suffered from.
 *
 * PR 2 (this module) ships the runner-side authority. The legacy
 * `tts.line` / `tts.state` / `tts.audio_chunk` envelopes continue to
 * be emitted alongside the new ones for one release cycle so the
 * existing page-side reducer keeps working until PR 3 lands.
 *
 * The controller is intentionally event-shape-agnostic — `sink` is the
 * only injection point, so tests record envelopes into an array and
 * production wires it to `OverlayForwarder.send`.
 */

import type { Mood } from "@price-game/shared";

/**
 * Discriminated union of every envelope the controller may emit. The
 * shape mirrors the wire-format the runner posts onto the page bus
 * (envelope is the `{ kind, payload }` body — `OverlayForwarder.send`
 * adds the `source` field).
 */
export type UtteranceEnvelope =
  | {
      kind: "tts.utterance.start";
      payload: {
        id: string;
        text: string;
        intent: string;
        mood: Mood;
        estimatedDurationMs: number;
        at: number;
      };
    }
  | { kind: "tts.utterance.audio_started"; payload: { id: string; at: number } }
  /**
   * Batched PCM envelope (PR 4 cutover). Carries N pre-encoded
   * base64 chunks in a single envelope so the runner's `page.evaluate`
   * round-trip fires once per ~5 chunks (~200ms of audio) instead of
   * per chunk (~40ms / 25Hz). The page-side reducer iterates the
   * array and dispatches per-chunk events on `pcmEvents` — Avatar's
   * listener still sees one `chunk` event per array entry, but the
   * IPC overhead drops 5x.
   *
   * Wire format: chunks carry pre-encoded base64 samples + per-chunk
   * timestamp. `sampleRate` lives once on the batch (the runner pins
   * it at 22050 to match piperEngine's aplay arguments).
   */
  | {
      kind: "tts.utterance.audio_batch";
      payload: { id: string; sampleRate: number; chunks: Array<{ samples: string; ts: number }> };
    }
  | {
      kind: "tts.utterance.audio_ended";
      payload: { id: string; at: number; actualDurationMs: number };
    }
  | { kind: "tts.utterance.cancelled"; payload: { id: string; at: number } };

/** Snapshot of the active utterance — what `current()` returns. */
export interface ActiveUtterance {
  id: string;
  text: string;
  intent: string;
  mood: Mood;
  estimatedDurationMs: number;
  startedAt: number;
  audioStartedAt: number | null;
  audioEndedAt: number | null;
}

/** Input to `start()` — the immutable fields known when the line is decided. */
export interface UtteranceStartInput {
  text: string;
  intent: string;
  mood: Mood;
  estimatedDurationMs: number;
}

/** Construction options. */
export interface UtteranceControllerOptions {
  /**
   * Where to deliver every emitted envelope. Production wires this
   * to `OverlayForwarder.send`; tests inject a recording array.
   * Errors thrown by the sink are absorbed — a misbehaving overlay
   * forwarder must NEVER kill the lifecycle.
   */
  sink: (env: UtteranceEnvelope) => void;
  /** Injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for deterministic tests. Defaults to `crypto.randomUUID`. */
  idGenerator?: () => string;
}

/** Public surface of the controller. */
export interface UtteranceController {
  /**
   * Mint a new utterance id, set it as `current()`, and emit
   * `tts.utterance.start`. If a previous utterance was still active,
   * it is implicitly cancelled (`tts.utterance.cancelled` fires for
   * the prior id) so `current()` always reflects exactly one in-flight
   * utterance.
   *
   * @returns The freshly-minted utterance id. Pass it to subsequent
   *   `noteAudio*` / `cancel` calls to associate them with this
   *   utterance.
   */
  start(input: UtteranceStartInput): string;
  /**
   * Mark that real audio has started flowing for `id`. Emits
   * `tts.utterance.audio_started` exactly once per id (subsequent
   * calls are no-ops) — page-side reducers can rely on monotonic
   * lifecycle progression without de-duplication. Production
   * currently relies on `noteAudioBatch`'s implicit-start path
   * rather than wiring this explicitly.
   */
  noteAudioStart(id: string): void;
  /**
   * Forward a batch of pre-encoded PCM chunks for `id`. PR 4
   * replaces the per-chunk `noteAudioChunk` with this batched form
   * to drop CDP IPC overhead 5x — the runner accumulates ~5 chunks
   * (~200ms of audio at Piper's 40ms cadence) before flushing.
   * Implicitly fires `audio_started` if it hasn't fired yet (the
   * first chunk in the first batch IS audio start). Batches for a
   * stale id (cancelled or replaced by a newer start) are silently
   * dropped; same for batches that arrive after `audio_ended`.
   *
   * @param chunks Array of pre-encoded base64 chunks. Empty arrays
   *               are no-ops (don't fire an envelope, don't trigger
   *               implicit start). Caller is responsible for chunk
   *               ordering — page-side dispatches in array order.
   * @param sampleRate Sample rate Hz (always 22050 in production
   *                   — pinned to piperEngine's aplay arguments).
   */
  noteAudioBatch(id: string, chunks: Array<{ samples: string; ts: number }>, sampleRate: number): void;
  /**
   * Mark audio end for `id` and clear `current()`. Production wires
   * this to aplay's `exit` event — the moment the audio buffer
   * actually drains, not a quiescence heuristic. Idempotent: a
   * second call for the same id is a no-op.
   */
  noteAudioEnd(id: string): void;
  /**
   * Abandon the in-flight utterance. Emits `tts.utterance.cancelled`
   * and clears `current()`. Wired into the runner's shutdown
   * `finally` block so a SIGTERM mid-utterance produces a clean
   * cancelled envelope rather than leaving the page-side
   * currentUtterance reducer (PR 3) stuck thinking Pricey is still
   * speaking.
   */
  cancel(id: string): void;
  /**
   * Inspect the active utterance. Returns null when nothing is in
   * flight (initial state, post-end, post-cancel).
   */
  current(): ActiveUtterance | null;
}

/**
 * Simple base-36 fallback id generator for environments where
 * `crypto.randomUUID` is unavailable (older Node, sandboxed test
 * runners). Uniqueness is bounded by the 9-character random suffix
 * (~8 chars of randomness over [0-9a-z], roughly 2^46 space) plus a
 * monotonic counter — collisions across one runner process are
 * impossible.
 */
function fallbackIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const rnd = Math.random().toString(36).slice(2, 11);
    return `utt-${counter.toString(36)}-${rnd}`;
  };
}

function defaultIdGenerator(): () => string {
  if (typeof globalThis !== "undefined") {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") {
      return () => c.randomUUID!();
    }
  }
  return fallbackIdGenerator();
}

/**
 * Construct a fresh UtteranceController. Pure factory — no envelopes
 * are emitted until the first `start()` call.
 *
 * @param opts See {@link UtteranceControllerOptions}.
 */
export function createUtteranceController(opts: UtteranceControllerOptions): UtteranceController {
  const sink = opts.sink;
  const now = opts.now ?? (() => Date.now());
  const idGen = opts.idGenerator ?? defaultIdGenerator();

  let active: ActiveUtterance | null = null;

  function emit(env: UtteranceEnvelope): void {
    try {
      sink(env);
    } catch {
      // Decorative path; never let a misbehaving sink crash the runner
      // (matches the existing pattern in OverlayForwarder.send).
    }
  }

  function clearActive(): void {
    active = null;
  }

  return {
    start(input: UtteranceStartInput): string {
      // If a previous utterance is still in flight, cancel it first
      // so `current()` always reflects exactly one active utterance.
      // Under normal narrator/engine sequencing this never happens —
      // the engine's serial queue ensures one say() at a time — but
      // it's a cheap invariant to enforce against future refactors.
      if (active !== null) {
        emit({ kind: "tts.utterance.cancelled", payload: { id: active.id, at: now() } });
        clearActive();
      }
      const id = idGen();
      const startedAt = now();
      active = {
        id,
        text: input.text,
        intent: input.intent,
        mood: input.mood,
        estimatedDurationMs: input.estimatedDurationMs,
        startedAt,
        audioStartedAt: null,
        audioEndedAt: null,
      };
      emit({
        kind: "tts.utterance.start",
        payload: {
          id,
          text: input.text,
          intent: input.intent,
          mood: input.mood,
          estimatedDurationMs: input.estimatedDurationMs,
          at: startedAt,
        },
      });
      return id;
    },

    noteAudioStart(id: string): void {
      if (active === null || active.id !== id) return;
      if (active.audioStartedAt !== null) return; // idempotent
      const at = now();
      active.audioStartedAt = at;
      emit({ kind: "tts.utterance.audio_started", payload: { id, at } });
    },

    noteAudioBatch(id, chunks, sampleRate): void {
      if (active === null || active.id !== id) return;
      if (active.audioEndedAt !== null) return; // batch after end → drop
      if (chunks.length === 0) return; // no-op
      // Implicitly mark audio start if the caller didn't wire
      // noteAudioStart. The first chunk in the first batch IS
      // audio start.
      if (active.audioStartedAt === null) {
        const at = now();
        active.audioStartedAt = at;
        emit({ kind: "tts.utterance.audio_started", payload: { id, at } });
      }
      emit({
        kind: "tts.utterance.audio_batch",
        payload: { id, sampleRate, chunks },
      });
    },

    noteAudioEnd(id: string): void {
      if (active === null || active.id !== id) return;
      if (active.audioEndedAt !== null) return; // idempotent
      const at = now();
      active.audioEndedAt = at;
      const actualDurationMs = active.audioStartedAt !== null
        ? Math.max(0, at - active.audioStartedAt)
        : 0;
      emit({
        kind: "tts.utterance.audio_ended",
        payload: { id, at, actualDurationMs },
      });
      clearActive();
    },

    cancel(id: string): void {
      if (active === null || active.id !== id) return;
      emit({ kind: "tts.utterance.cancelled", payload: { id, at: now() } });
      clearActive();
    },

    current(): ActiveUtterance | null {
      return active;
    },
  };
}
