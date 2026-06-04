/**
 * Unit tests for the PcmBatcher accumulator. Pins the size-threshold
 * + flush-on-end + cross-utterance isolation invariants the runner
 * depends on. Without these tests, a regression in the batching
 * policy (e.g. forgetting to clear the accumulator after handoff,
 * double-flushing on audio_end, off-by-one on the >= cutover) would
 * only surface via manual sandbox testing.
 */

import { describe, it, expect, vi } from "vitest";
import { createPcmBatcher } from "../src/runner/pcmBatcher";

describe("createPcmBatcher", () => {
  it("flushes immediately when the batch reaches `size`", () => {
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    for (let i = 0; i < 5; i++) {
      batcher.push("u-1", { samples: `b64-${i}`, ts: i });
    }
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toBe("u-1");
    expect(onFlush.mock.calls[0][1]).toHaveLength(5);
    expect(batcher.pending()).toEqual({ id: null, count: 0 });
  });

  it("does NOT flush before the batch reaches `size`", () => {
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    for (let i = 0; i < 4; i++) {
      batcher.push("u-1", { samples: `b64-${i}`, ts: i });
    }
    expect(onFlush).not.toHaveBeenCalled();
    expect(batcher.pending()).toEqual({ id: "u-1", count: 4 });
  });

  it("flush() ships the trailing < size accumulator", () => {
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    for (let i = 0; i < 3; i++) {
      batcher.push("u-1", { samples: `b64-${i}`, ts: i });
    }
    batcher.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][1]).toHaveLength(3);
    expect(batcher.pending()).toEqual({ id: null, count: 0 });
  });

  it("7 chunks + flush → 1 full batch + 1 trailing batch", () => {
    // Mirrors the production audio_end path: full batches fire as
    // they fill, then `flush()` ships whatever's left.
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    for (let i = 0; i < 7; i++) {
      batcher.push("u-1", { samples: `b64-${i}`, ts: i });
    }
    batcher.flush();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[0][1]).toHaveLength(5); // full batch
    expect(onFlush.mock.calls[1][1]).toHaveLength(2); // trailing
    expect(onFlush.mock.calls[0][0]).toBe("u-1");
    expect(onFlush.mock.calls[1][0]).toBe("u-1");
  });

  it("flush() on an empty accumulator is a no-op", () => {
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    batcher.flush();
    batcher.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("a push for a new id flushes the previous batch under its OLD id", () => {
    // Defence against cross-utterance contamination — chunks from
    // utterance A must never appear in utterance B's envelope.
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 5, onFlush });
    batcher.push("u-A", { samples: "a-1", ts: 1 });
    batcher.push("u-A", { samples: "a-2", ts: 2 });
    batcher.push("u-B", { samples: "b-1", ts: 3 });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toBe("u-A");
    expect(onFlush.mock.calls[0][1]).toHaveLength(2);
    expect(batcher.pending()).toEqual({ id: "u-B", count: 1 });
  });

  it("each `onFlush` invocation receives independent chunk arrays (no shared mutation)", () => {
    // The accumulator hands off ownership; subsequent pushes must
    // not mutate the array a previous flush handed to the sink.
    const captured: Array<Array<{ samples: string; ts: number }>> = [];
    const batcher = createPcmBatcher({
      size: 2,
      onFlush: (_id, chunks) => captured.push(chunks),
    });
    batcher.push("u-1", { samples: "a", ts: 1 });
    batcher.push("u-1", { samples: "b", ts: 2 });
    batcher.push("u-1", { samples: "c", ts: 3 });
    batcher.push("u-1", { samples: "d", ts: 4 });
    expect(captured).toHaveLength(2);
    expect(captured[0]).toHaveLength(2);
    expect(captured[1]).toHaveLength(2);
    expect(captured[0][0].samples).toBe("a");
    expect(captured[1][0].samples).toBe("c");
  });

  it("rejects size < 1 at construction time", () => {
    expect(() => createPcmBatcher({ size: 0, onFlush: () => {} })).toThrow();
    expect(() => createPcmBatcher({ size: -3, onFlush: () => {} })).toThrow();
  });

  it("size=1 flushes on every push (degenerate case used by the synthetic test harness)", () => {
    const onFlush = vi.fn();
    const batcher = createPcmBatcher({ size: 1, onFlush });
    batcher.push("u-1", { samples: "a", ts: 1 });
    batcher.push("u-1", { samples: "b", ts: 2 });
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[0][1]).toEqual([{ samples: "a", ts: 1 }]);
    expect(onFlush.mock.calls[1][1]).toEqual([{ samples: "b", ts: 2 }]);
  });

  describe("firstBatchSize", () => {
    it("first batch flushes at firstBatchSize, subsequent at size", () => {
      // Production wiring: firstBatchSize=1, size=5 — first chunk
      // ships immediately so mouth animation is in sync with audio,
      // then steady state batches every 5 chunks for CDP efficiency.
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 1, onFlush });
      // First chunk → flushes immediately (firstBatchSize threshold).
      batcher.push("u-1", { samples: "a", ts: 1 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][1]).toHaveLength(1);
      // Next 4 chunks → no flush (steady-state threshold = 5).
      for (let i = 0; i < 4; i++) {
        batcher.push("u-1", { samples: `b-${i}`, ts: i });
      }
      expect(onFlush).toHaveBeenCalledTimes(1);
      // 5th post-first chunk reaches size threshold → second flush.
      batcher.push("u-1", { samples: "f", ts: 99 });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][1]).toHaveLength(5);
    });

    it("firstBatchSize threshold resets per utterance id", () => {
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 1, onFlush });
      // Utterance A — first chunk flushes immediately.
      batcher.push("u-A", { samples: "a-1", ts: 1 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // Utterance B — first chunk also flushes immediately (firstBatchSize
      // threshold applies independently per id).
      batcher.push("u-B", { samples: "b-1", ts: 2 });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][0]).toBe("u-B");
      expect(onFlush.mock.calls[1][1]).toHaveLength(1);
    });

    it("firstBatchSize=2 flushes the first batch at 2 chunks then steady-state at size", () => {
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 2, onFlush });
      batcher.push("u-1", { samples: "a", ts: 1 });
      expect(onFlush).not.toHaveBeenCalled();
      batcher.push("u-1", { samples: "b", ts: 2 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0][1]).toHaveLength(2);
      // Steady state — needs 5 more before next flush.
      for (let i = 0; i < 4; i++) {
        batcher.push("u-1", { samples: `c-${i}`, ts: i });
      }
      expect(onFlush).toHaveBeenCalledTimes(1);
      batcher.push("u-1", { samples: "h", ts: 99 });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][1]).toHaveLength(5);
    });

    it("defaults firstBatchSize to size when omitted (existing behaviour preserved)", () => {
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, onFlush });
      // First 4 chunks → no flush, same as today.
      for (let i = 0; i < 4; i++) {
        batcher.push("u-1", { samples: `b64-${i}`, ts: i });
      }
      expect(onFlush).not.toHaveBeenCalled();
      // 5th chunk → first flush at size threshold.
      batcher.push("u-1", { samples: "b64-4", ts: 4 });
      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it("rejects firstBatchSize outside [1, size] at construction time", () => {
      expect(() =>
        createPcmBatcher({ size: 5, firstBatchSize: 0, onFlush: () => {} }),
      ).toThrow();
      expect(() =>
        createPcmBatcher({ size: 5, firstBatchSize: 6, onFlush: () => {} }),
      ).toThrow();
      expect(() =>
        createPcmBatcher({ size: 5, firstBatchSize: -1, onFlush: () => {} }),
      ).toThrow();
    });

    it("flush() on an empty accumulator preserves lastFlushedId (no spurious reset)", () => {
      // Defence against a bug where flush() on empty accumulator would
      // reset the first-batch shortcut for the SAME id — production
      // calls flush() in audio_end paths even when the size-threshold
      // already shipped the trailing chunks. Without the no-mutation
      // path in flushImpl's empty-early-return, a same-id push after
      // such a flush would re-trigger the firstBatchSize threshold and
      // emit an extra single-chunk batch mid-utterance.
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 1, onFlush });
      batcher.push("u-1", { samples: "a", ts: 1 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // Empty flush — no-op, must not lose the lastFlushedId memory.
      batcher.flush();
      batcher.flush();
      expect(onFlush).toHaveBeenCalledTimes(1);
      // Subsequent same-id push should use steady-state size, not
      // firstBatchSize. So 4 more chunks: still no flush.
      for (let i = 0; i < 4; i++) {
        batcher.push("u-1", { samples: `b-${i}`, ts: i });
      }
      expect(onFlush).toHaveBeenCalledTimes(1);
      // 5th post-flush chunk hits steady-state threshold.
      batcher.push("u-1", { samples: "z", ts: 99 });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][1]).toHaveLength(5);
    });

    it("same-id push after explicit flush() uses steady-state threshold", () => {
      // audio_end flush ships the trailing chunks; if the same
      // utterance somehow continues (e.g. a future restart-on-error
      // path), the next push must NOT re-trigger firstBatchSize — the
      // page already saw the first batch under that id.
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 1, onFlush });
      // Flush first batch immediately, then accumulate 3 more, then
      // explicit flush (mirrors audio_end's trailing-chunk flush).
      batcher.push("u-1", { samples: "a", ts: 1 });
      for (let i = 0; i < 3; i++) {
        batcher.push("u-1", { samples: `b-${i}`, ts: i });
      }
      batcher.flush();
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1][1]).toHaveLength(3);
      // Same-id push: should buffer (no firstBatchSize shortcut).
      batcher.push("u-1", { samples: "c-0", ts: 10 });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(batcher.pending()).toEqual({ id: "u-1", count: 1 });
    });

    it("cross-utterance flush + new id triggers firstBatchSize threshold", () => {
      // Live race coverage: pendingId=u-A has chunks queued, then
      // u-B's first chunk arrives. The cross-utterance flush ships
      // u-A's batch under its OLD id, then u-B's chunk lands as a
      // FIRST batch (firstBatchSize threshold applies, not size).
      const onFlush = vi.fn();
      const batcher = createPcmBatcher({ size: 5, firstBatchSize: 1, onFlush });
      // Flush u-A's first batch immediately.
      batcher.push("u-A", { samples: "a-1", ts: 1 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // Subsequent u-A chunks now under steady-state threshold.
      batcher.push("u-A", { samples: "a-2", ts: 2 });
      batcher.push("u-A", { samples: "a-3", ts: 3 });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // u-B push flushes the partial u-A batch then starts u-B's
      // first batch — which immediately flushes at firstBatchSize=1.
      batcher.push("u-B", { samples: "b-1", ts: 4 });
      expect(onFlush).toHaveBeenCalledTimes(3);
      expect(onFlush.mock.calls[1][0]).toBe("u-A");
      expect(onFlush.mock.calls[1][1]).toHaveLength(2);
      expect(onFlush.mock.calls[2][0]).toBe("u-B");
      expect(onFlush.mock.calls[2][1]).toHaveLength(1);
    });
  });
});
