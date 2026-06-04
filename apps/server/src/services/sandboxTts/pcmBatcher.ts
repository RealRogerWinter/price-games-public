/**
 * VENDORED FROM `packages/bot-streamer/src/runner/pcmBatcher.ts` —
 * byte-equivalent. Sync if upstream changes. See sibling
 * piperEngine.ts header for why we vendor instead of import.
 *
 * Per-utterance PCM batch accumulator. Extracted from `main.ts`'s
 * inline closure so the batching policy (size threshold, flush-on-end,
 * drop-on-id-change) is unit-testable in isolation. The runner
 * accumulates ~5 chunks (~200ms of audio at Piper's 40ms cadence)
 * before dispatching a single `tts.utterance.audio_batch` envelope —
 * cuts the `page.evaluate` round-trip rate ~5x without sacrificing
 * perceptual lipsync responsiveness.
 *
 * The batcher is keyed on utterance id; a `push` for a new id flushes
 * the previous accumulator first so chunks from one utterance can't
 * piggyback on another's batch. Empty batches are no-ops.
 *
 * `firstBatchSize` (optional) lets the FIRST batch of each utterance
 * flush at a smaller size than steady-state batches. Defaults to
 * `size` (no special behaviour). Production sets it to 1 so the very
 * first chunk of an utterance reaches the page immediately — mouth
 * animation starts in sync with audio instead of waiting for the
 * size-5 threshold (which lands the first batch ~160ms after
 * audio_started under the chunk-START throttle, producing visible
 * lipsync lag in the broadcast feed).
 */

export interface PcmBatcherOptions {
  /** Target steady-state batch size — chunks accumulate until this many before auto-flush. */
  size: number;
  /**
   * Optional smaller size used ONLY for the first batch of each
   * utterance id. Tracked via `lastFlushedId` so the smaller
   * threshold applies until the first flush of an id, after which
   * subsequent batches of the same id use `size`. Defaults to
   * `size` (no special behaviour). Must be in [1, size].
   */
  firstBatchSize?: number;
  /**
   * Sink for completed batches. The batcher hands off ownership of
   * the chunks array; callers must not mutate after receipt.
   */
  onFlush: (id: string, chunks: Array<{ samples: string; ts: number }>) => void;
}

export interface PcmBatcher {
  /**
   * Append a chunk to the current batch. If the batch grows to
   * `size` chunks, flush immediately. If `id` differs from the
   * current batch's id, flush the prior batch under its OLD id
   * before re-tagging — defence-in-depth so cross-utterance chunks
   * can't end up in the same envelope.
   */
  push(id: string, chunk: { samples: string; ts: number }): void;
  /**
   * Flush the current batch (if any) and clear the accumulator.
   * Used at audio-end to ship trailing < `size` chunks; idempotent
   * on an empty accumulator.
   */
  flush(): void;
  /** Test-only inspection. */
  pending(): { id: string | null; count: number };
}

export function createPcmBatcher(opts: PcmBatcherOptions): PcmBatcher {
  if (opts.size < 1) throw new Error(`PcmBatcher size must be >= 1 (got ${opts.size})`);
  const firstBatchSize = opts.firstBatchSize ?? opts.size;
  if (firstBatchSize < 1 || firstBatchSize > opts.size) {
    throw new Error(`PcmBatcher firstBatchSize must be in [1, size] (got ${firstBatchSize}, size=${opts.size})`);
  }
  let pendingId: string | null = null;
  let pendingChunks: Array<{ samples: string; ts: number }> = [];
  // Most recently flushed utterance id. Used to decide whether the
  // current batch is the FIRST batch of its utterance (different id)
  // or a steady-state batch (same id). Survives across `flushImpl`
  // resets so a newly-emptied accumulator still remembers it just
  // shipped a batch under that id.
  let lastFlushedId: string | null = null;

  function flushImpl(): void {
    if (pendingChunks.length === 0 || pendingId === null) {
      pendingChunks = [];
      pendingId = null;
      return;
    }
    const id = pendingId;
    const chunks = pendingChunks;
    pendingChunks = [];
    pendingId = null;
    lastFlushedId = id;
    opts.onFlush(id, chunks);
  }

  return {
    push(id, chunk) {
      if (pendingId !== null && pendingId !== id) {
        // Cross-utterance chunk; flush the prior batch under its
        // OLD id before retagging to the new one.
        flushImpl();
      }
      pendingId = id;
      pendingChunks.push(chunk);
      // First batch of an utterance: lastFlushedId !== id (either
      // null on cold start or the previous utterance's id). After
      // that batch flushes, lastFlushedId becomes id and the steady-
      // state `size` threshold takes over.
      const threshold = lastFlushedId === id ? opts.size : firstBatchSize;
      if (pendingChunks.length >= threshold) flushImpl();
    },
    flush(): void {
      flushImpl();
    },
    pending(): { id: string | null; count: number } {
      return { id: pendingId, count: pendingChunks.length };
    },
  };
}
