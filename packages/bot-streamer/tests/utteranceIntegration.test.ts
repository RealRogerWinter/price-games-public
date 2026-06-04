/**
 * Integration test: narrator + piperEngine + UtteranceController
 * composed end-to-end. Each layer has its own unit-tests but the
 * audio-attribution race the reviewer flagged on PR #301 only
 * manifests at composition time — it's invisible to single-layer
 * tests because each layer's contract holds in isolation.
 *
 * Pinning the contract here prevents a future refactor from
 * accidentally re-introducing the race (e.g. moving
 * `controller.start` back to `narrator.onLine` instead of
 * `piperEngine.onLineProcess`).
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createNarrator, type LineMeta } from "../src/runner/narrator";
import { piperEngine } from "../src/tts/piperEngine";
import { createUtteranceController, type UtteranceEnvelope } from "../src/runner/utterance";
import type { SayOptions } from "../src/tts/engine";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { pipe: (target: unknown) => unknown };
  stdin: { write: (s: string) => void; end: () => void };
  kill: () => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { pipe: vi.fn() }) as FakeChild["stdout"];
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

/**
 * Build a controller-wired piperEngine that uses fake child
 * processes. Returns the engine, the controller, the recorded
 * envelopes, and a way to drive each utterance's audio + exit.
 */
function harness() {
  const events: UtteranceEnvelope[] = [];
  const controller = createUtteranceController({ sink: (env) => events.push(env) });

  // FIFO of (piper, aplay) pairs, one per spawned `runOnce`.
  const pairs: { piper: FakeChild; aplay: FakeChild }[] = [];
  let pendingPiper: FakeChild | null = null;
  const spawnFn = vi.fn(() => {
    if (!pendingPiper) {
      pendingPiper = makeFakeChild();
      return pendingPiper;
    }
    const aplay = makeFakeChild();
    pairs.push({ piper: pendingPiper, aplay });
    pendingPiper = null;
    return aplay;
  }) as unknown as typeof import("node:child_process").spawn;

  type PinnedLineMeta = LineMeta & { utteranceId?: string };

  const engine = piperEngine({
    voiceModelPath: "/v.onnx",
    spawnFn,
    onLineProcess: (_line, sayOpts: SayOptions | undefined) => {
      const meta = sayOpts?.meta as LineMeta | undefined;
      if (!meta) return;
      const id = controller.start({
        text: meta.text,
        intent: meta.intent,
        mood: meta.mood,
        estimatedDurationMs: meta.estimatedDurationMs,
      });
      // Pin the id back so onPcmChunk + onAudioEnd can read it.
      // Mirrors main.ts's wiring exactly.
      if (sayOpts) (sayOpts.meta as PinnedLineMeta).utteranceId = id;
    },
    onPcmChunk: (_samples, ts, sayOpts) => {
      const meta = sayOpts?.meta as PinnedLineMeta | undefined;
      if (meta?.utteranceId) {
        // Test harness: mirror main.ts's batch flow but with a
        // batch-size-of-1 so each runOnce-side chunk produces one
        // batch envelope. The sentinel b64 string lets us assert id
        // attribution per envelope.
        controller.noteAudioBatch(
          meta.utteranceId,
          [{ samples: `B64-${meta.intent}`, ts }],
          22050,
        );
      }
    },
    onAudioEnd: (sayOpts) => {
      const meta = sayOpts?.meta as PinnedLineMeta | undefined;
      if (meta?.utteranceId) controller.noteAudioEnd(meta.utteranceId);
    },
  });

  const narrator = createNarrator(engine);

  return { engine, narrator, controller, events, pairs };
}

describe("utterance integration (narrator + piperEngine + controller)", () => {
  it("two back-to-back narrator.say() calls correctly attribute each utterance's chunks to its own id", async () => {
    // The race the reviewer flagged: narrator.say() fires
    // controller.start synchronously inside `dispatch`'s `emit` →
    // onLine → controller.start. Two back-to-back .say() calls
    // would have the second start clobber the first id BEFORE the
    // first utterance's audio plays. PR's fix moves controller.start
    // to piperEngine.onLineProcess, which fires inside `runOnce`
    // (serial), so each utterance keeps its own id.
    const { narrator, events, pairs } = harness();
    // Fire BOTH say() calls without awaiting — the engine queues
    // them, then runOnces them in order. This is the production
    // pattern from playwrightDriver.ts:1306,1376
    // (`void narrator?.speak(...)`).
    const p1 = narrator.say("first line");
    const p2 = narrator.say("second line");

    // Drive utterance 1 to completion: emit some PCM, then aplay exit.
    // Yield once so runOnce had a chance to spawn its pair.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(pairs.length, "first runOnce should have spawned").toBeGreaterThanOrEqual(1);
    pairs[0].piper.stdout.emit("data", Buffer.alloc(1764)); // one full chunk
    pairs[0].piper.stdout.emit("end");
    pairs[0].aplay.emit("exit");
    await p1;

    // Now utterance 2 runs. Drive it.
    await new Promise((r) => setTimeout(r, 0));
    expect(pairs.length, "second runOnce should have spawned after first completed").toBe(2);
    pairs[1].piper.stdout.emit("data", Buffer.alloc(1764));
    pairs[1].piper.stdout.emit("end");
    pairs[1].aplay.emit("exit");
    await p2;

    // Each utterance should have its own complete lifecycle:
    // start → audio_started → audio_chunk → audio_ended.
    const startEvents = events.filter((e) => e.kind === "tts.utterance.start");
    const chunkEvents = events.filter((e) => e.kind === "tts.utterance.audio_batch");
    const endEvents = events.filter((e) => e.kind === "tts.utterance.audio_ended");
    const cancelEvents = events.filter((e) => e.kind === "tts.utterance.cancelled");
    expect(startEvents).toHaveLength(2);
    expect(endEvents).toHaveLength(2);
    expect(cancelEvents, "no implicit-cancel should fire under serial runOnce").toHaveLength(0);

    // Each chunk must carry the SAME id as its sibling start/end.
    // This is the key assertion the unit tests can't make: it pins
    // the cross-layer attribution invariant.
    const id1 = (startEvents[0].payload as { id: string }).id;
    const id2 = (startEvents[1].payload as { id: string }).id;
    expect(id1).not.toBe(id2);
    expect(chunkEvents).toHaveLength(2);
    expect((chunkEvents[0].payload as { id: string }).id).toBe(id1);
    expect((chunkEvents[1].payload as { id: string }).id).toBe(id2);
    expect((endEvents[0].payload as { id: string }).id).toBe(id1);
    expect((endEvents[1].payload as { id: string }).id).toBe(id2);
  });

  it("a single utterance's chunks all carry the same id even across many chunk callbacks", async () => {
    const { narrator, events, pairs } = harness();
    const p = narrator.say("a line with multiple chunks worth of audio");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Five full-size chunks → five onPcmChunk callbacks → five
    // utterance.audio_chunk envelopes, all with the same id.
    for (let i = 0; i < 5; i++) {
      pairs[0].piper.stdout.emit("data", Buffer.alloc(1764));
    }
    pairs[0].piper.stdout.emit("end");
    pairs[0].aplay.emit("exit");
    await p;

    const chunks = events.filter((e) => e.kind === "tts.utterance.audio_batch");
    expect(chunks).toHaveLength(5);
    const ids = new Set(chunks.map((c) => (c.payload as { id: string }).id));
    expect(ids.size).toBe(1);
  });
});
