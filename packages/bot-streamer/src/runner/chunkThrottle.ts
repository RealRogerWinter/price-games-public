/**
 * Real-time PCM chunk throttle. Piper synthesises at ~10x real-time
 * (RTF ≈ 0.10 in production logs); without throttling, all PCM chunks
 * for an utterance reach the page in a 60ms burst at the start, the
 * mouth flickers briefly, and then sits closed for the rest of the
 * audio playback while `aplay` is still emitting voice. The throttle
 * anchors a wall clock at the first chunk and schedules each
 * downstream `dispatch` call at `anchor + (samplesQueuedBefore /
 * sampleRate) * 1000` — chunk-START scheduling, matching `aplay`'s
 * sample-rate-paced consumption on the audio side.
 *
 * Extracted from `runner/main.ts` so the timing math can be unit-
 * tested in isolation against vitest fake timers — without standing
 * up Piper, the OverlayForwarder, or Playwright.
 */

export interface ChunkThrottleOptions {
  /** Sample rate of the PCM stream (Piper pins this at 22050). */
  sampleRate: number;
  /**
   * Called when a scheduled chunk's wall time arrives. Receives
   * `(id, payload)` — the throttle drops the call if `id` no longer
   * matches the active utterance, so callers can rely on this only
   * firing for live chunks.
   */
  dispatch: (id: string, payload: unknown) => void;
  /**
   * Optional injection points for tests. Default to wall-clock /
   * native timers.
   */
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

export interface ChunkThrottle {
  /**
   * Reset the throttle for a new utterance. Call BEFORE the first
   * `enqueue` for the utterance — sets the active id and clears the
   * sample counter. Stale `setTimeout` fires from a previous
   * utterance no-op via the active-id check.
   */
  beginUtterance: (id: string) => void;
  /**
   * Schedule one PCM chunk to dispatch at its real-time playback
   * boundary. The first call within an utterance also anchors the
   * wall clock at "now" and invokes `onFirstChunk` (used by callers
   * that want to fire `audio_started` at first-chunk wall time
   * rather than at the throttled first-batch dispatch). Returns the
   * absolute wall-clock target time the chunk was scheduled for —
   * exposed for tests / diagnostics.
   */
  enqueue: (id: string, sampleCount: number, payload: unknown, onFirstChunk?: () => void) => number;
  /**
   * Drop the active id so any in-flight `setTimeout` fires from the
   * just-ended utterance no-op rather than clobbering the next
   * utterance's accumulator. Call from `onAudioEnd` AFTER any final
   * batch flush.
   */
  endUtterance: () => void;
}

export function createChunkThrottle(opts: ChunkThrottleOptions): ChunkThrottle {
  const sampleRate = opts.sampleRate;
  const dispatch = opts.dispatch;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));

  let audioStartWallMs: number | null = null;
  let totalSamplesQueued = 0;
  let activeId: string | null = null;

  return {
    beginUtterance(id: string): void {
      audioStartWallMs = null;
      totalSamplesQueued = 0;
      activeId = id;
    },
    enqueue(id: string, sampleCount: number, payload: unknown, onFirstChunk?: () => void): number {
      if (audioStartWallMs === null) {
        audioStartWallMs = now();
        if (onFirstChunk) {
          try { onFirstChunk(); } catch { /* never break audio */ }
        }
      }
      const samplesAtChunkStart = totalSamplesQueued;
      totalSamplesQueued += sampleCount;
      const targetWallMs = audioStartWallMs + (samplesAtChunkStart / sampleRate) * 1000;
      const sleepMs = Math.max(0, targetWallMs - now());
      schedule(() => {
        // Drop stale pushes from a previous utterance — covers the
        // rare event-loop-stall case where this fires after
        // `endUtterance` flipped the active id (and a new utterance
        // has started). Without this guard, a stale push would clobber
        // the new utterance's accumulator.
        if (activeId !== id) return;
        dispatch(id, payload);
      }, sleepMs);
      return targetWallMs;
    },
    endUtterance(): void {
      activeId = null;
    },
  };
}
