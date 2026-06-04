/**
 * Unit tests for the per-utterance chunk-throttle helper. The helper
 * encodes the timing math that brings Piper's ~10x-real-time PCM
 * stream back into sample-rate-paced cadence on the page side. These
 * tests inject a fake clock + fake setTimeout so the math is tested
 * in isolation from real timers / Piper / Playwright.
 */

import { describe, it, expect, vi } from "vitest";
import { createChunkThrottle } from "../src/runner/chunkThrottle";

interface ScheduledTask {
  cb: () => void;
  fireAt: number;
}

/**
 * Build a deterministic test rig: a `now()` that returns a mutable
 * clock and a `setTimeout` that records every scheduled task without
 * firing it until `flushUntil` is called. Lets the test step the
 * clock and assert per-fire ordering / target times.
 */
function makeRig() {
  let clock = 1_000;
  const tasks: ScheduledTask[] = [];
  const dispatched: Array<{ id: string; payload: unknown; firedAt: number }> = [];

  const throttle = createChunkThrottle({
    sampleRate: 22050,
    dispatch: (id, payload) => {
      dispatched.push({ id, payload, firedAt: clock });
    },
    now: () => clock,
    setTimeout: (cb, ms) => {
      const fireAt = clock + Math.max(0, ms);
      tasks.push({ cb, fireAt });
      return undefined;
    },
  });

  function advance(ms: number): void {
    clock += ms;
    // Fire any tasks whose target time has arrived. Re-iterate after
    // each fire in case the callback itself enqueued more — the
    // production throttle doesn't, but defensive against future
    // refactors.
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].fireAt <= clock) {
        const t = tasks[i];
        tasks.splice(i, 1);
        i--;
        t.cb();
      }
    }
  }

  return { throttle, dispatched, advance, get clock() { return clock; }, get pending() { return tasks.length; } };
}

describe("createChunkThrottle", () => {
  it("schedules the first chunk at the anchor wall time (no delay)", () => {
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    throttle.enqueue("u1", 882, { samples: "AA==", ts: 0 });
    advance(0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ id: "u1", payload: { samples: "AA==", ts: 0 } });
  });

  it("schedules subsequent chunks at sample-rate-paced wall times (chunk-START)", () => {
    // 882 samples at 22050 Hz = 40ms. Chunk N starts at anchor +
    // N * 40ms — chunk 0 at +0, chunk 1 at +40, chunk 2 at +80...
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    for (let i = 0; i < 3; i++) {
      throttle.enqueue("u1", 882, { samples: `c${i}`, ts: i });
    }
    // No chunks fire at anchor itself — only chunk 0 is at sleepMs=0.
    advance(0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].payload).toMatchObject({ samples: "c0" });
    // Advance to +40ms — chunk 1 fires.
    advance(40);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].payload).toMatchObject({ samples: "c1" });
    // Advance to +80ms — chunk 2 fires.
    advance(40);
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2].payload).toMatchObject({ samples: "c2" });
  });

  it("anchors the wall clock on the FIRST enqueue, not on beginUtterance", () => {
    // beginUtterance only resets state; the anchor lands on the first
    // chunk so a slow Piper warmup (no chunks for 70ms) doesn't push
    // every subsequent chunk's target into the past.
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    advance(70); // 70ms of "Piper warmup" with no chunks.
    throttle.enqueue("u1", 882, { samples: "first", ts: 0 });
    throttle.enqueue("u1", 882, { samples: "second", ts: 0 });
    // First chunk fires at the anchor (which is NOW after warmup).
    advance(0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].payload).toMatchObject({ samples: "first" });
    // Second chunk fires 40ms later.
    advance(40);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].payload).toMatchObject({ samples: "second" });
  });

  it("invokes onFirstChunk exactly once per utterance, on the first enqueue", () => {
    const onFirstChunk = vi.fn();
    const { throttle, advance } = makeRig();
    throttle.beginUtterance("u1");
    throttle.enqueue("u1", 882, {}, onFirstChunk);
    throttle.enqueue("u1", 882, {}, onFirstChunk);
    throttle.enqueue("u1", 882, {}, onFirstChunk);
    advance(200);
    expect(onFirstChunk).toHaveBeenCalledOnce();
  });

  it("swallows errors thrown by onFirstChunk so audio dispatch keeps flowing", () => {
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    expect(() => {
      throttle.enqueue("u1", 882, { samples: "x", ts: 0 }, () => { throw new Error("boom"); });
    }).not.toThrow();
    advance(0);
    expect(dispatched).toHaveLength(1);
  });

  it("drops scheduled chunks for an utterance that has already ended", () => {
    // Fast-burst Piper finishes producing chunks before any of their
    // scheduled wall times arrive. If the operator (or aplay.exit)
    // calls `endUtterance` mid-queue, the still-pending setTimeouts
    // must NOT fire dispatch — otherwise stale chunks would leak
    // into the next utterance's batch.
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    throttle.enqueue("u1", 882, { samples: "1a", ts: 0 });
    throttle.enqueue("u1", 882, { samples: "1b", ts: 0 });
    throttle.enqueue("u1", 882, { samples: "1c", ts: 0 });
    // Fire only the first; pretend aplay exited early.
    advance(0);
    expect(dispatched).toHaveLength(1);
    throttle.endUtterance();
    advance(120); // chunks 1b + 1c WOULD have fired here.
    expect(dispatched).toHaveLength(1);
  });

  it("drops scheduled chunks tagged with an old id once a new utterance starts", () => {
    // A new utterance can begin while old setTimeouts are still
    // pending (event-loop stall straddles utterance boundary). The
    // active-id check inside the throttle must drop the old chunks
    // even though dispatch is mechanically callable — pcmBatcher's
    // cross-id flush is defence in depth, not a guarantee.
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    throttle.enqueue("u1", 882, { samples: "u1-a", ts: 0 });
    throttle.enqueue("u1", 882, { samples: "u1-b", ts: 0 });
    advance(0); // u1-a fires.
    throttle.endUtterance();
    throttle.beginUtterance("u2");
    throttle.enqueue("u2", 882, { samples: "u2-a", ts: 0 });
    advance(40); // u1-b's pending fire arrives — must be dropped.
    // Order: u1-a first (already), then u2-a. u1-b dropped.
    expect(dispatched.map((d) => (d.payload as { samples: string }).samples)).toEqual(["u1-a", "u2-a"]);
  });

  it("returns the absolute target wall time from enqueue (diagnostic exposure)", () => {
    const { throttle } = makeRig();
    throttle.beginUtterance("u1");
    const t0 = throttle.enqueue("u1", 882, {}); // anchor + 0
    const t1 = throttle.enqueue("u1", 882, {}); // anchor + 40
    expect(t1 - t0).toBeCloseTo(40, 5);
  });

  it("treats every utterance as a fresh sample window after beginUtterance", () => {
    // Without the per-utterance reset, a long bot session would
    // accumulate sample counts across utterances and push every new
    // chunk's target far into the future.
    const { throttle, dispatched, advance } = makeRig();
    throttle.beginUtterance("u1");
    for (let i = 0; i < 25; i++) throttle.enqueue("u1", 882, {}); // 1s of audio
    advance(1000);
    expect(dispatched.length).toBe(25);

    // New utterance — first chunk should fire at sleepMs=0 again.
    throttle.endUtterance();
    throttle.beginUtterance("u2");
    const before = dispatched.length;
    throttle.enqueue("u2", 882, { samples: "u2-first", ts: 0 });
    advance(0);
    expect(dispatched.length).toBe(before + 1);
    expect(dispatched[before].payload).toMatchObject({ samples: "u2-first" });
  });
});
