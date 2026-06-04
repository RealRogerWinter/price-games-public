/**
 * Tests for the UtteranceController — the runner-side single source of
 * truth for "what is Pricey saying right now". The controller mints
 * one Utterance per narrator dispatch and forwards lifecycle events
 * (start / audio_started / audio_chunk / audio_ended / cancelled) to a
 * sink. Subtitle hide, speaking flag, and Avatar mouth state will all
 * derive from a single page-side `currentUtterance` slot reduced from
 * these events (PR 3) — but PR 2 only ships the runner-side authority.
 *
 * The controller replaces the speakingClock heuristic. Speaking turns
 * on at the FIRST PCM chunk (`noteAudioStart` or `noteAudioChunk` —
 * either may be the wake-up). It turns off at the REAL audio end
 * (`noteAudioEnd`, driven by aplay.exit), not at PCM quiescence.
 */

import { describe, it, expect } from "vitest";
import { createUtteranceController, type UtteranceEnvelope } from "../src/runner/utterance";

function makeRecorder(): { sink: (env: UtteranceEnvelope) => void; events: UtteranceEnvelope[] } {
  const events: UtteranceEnvelope[] = [];
  return { sink: (env) => events.push(env), events };
}

describe("createUtteranceController", () => {
  it("start mints a unique id and emits utterance.start with the input fields", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink, now: () => 1000 });
    const id = c.start({
      text: "hello viewers",
      intent: "round_start",
      mood: "happy",
      estimatedDurationMs: 1800,
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(8);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe("tts.utterance.start");
    expect(r.events[0].payload).toMatchObject({
      id,
      text: "hello viewers",
      intent: "round_start",
      mood: "happy",
      estimatedDurationMs: 1800,
      at: 1000,
    });
  });

  it("two consecutive start calls produce distinct ids", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id1 = c.start({ text: "a", intent: "round_start", mood: "neutral", estimatedDurationMs: 1500 });
    const id2 = c.start({ text: "b", intent: "round_start", mood: "neutral", estimatedDurationMs: 1500 });
    expect(id1).not.toBe(id2);
  });

  it("noteAudioStart fires utterance.audio_started exactly once per id (idempotent)", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink, now: () => 2000 });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioStart(id);
    c.noteAudioStart(id); // idempotent
    const audioStarted = r.events.filter((e) => e.kind === "tts.utterance.audio_started");
    expect(audioStarted).toHaveLength(1);
    expect(audioStarted[0].payload).toMatchObject({ id, at: 2000 });
  });

  it("noteAudioChunk implicitly triggers audio_started on the first chunk", () => {
    // Convenience: callers don't have to wire BOTH noteAudioStart AND
    // noteAudioChunk. Whichever fires first counts as audio start.
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioBatch(id, [{ samples: "AAAAAAAAAAA=", ts: 100 }], 22050);
    const audioStarted = r.events.filter((e) => e.kind === "tts.utterance.audio_started");
    expect(audioStarted).toHaveLength(1);
  });

  it("noteAudioChunk emits utterance.audio_chunk envelopes carrying the id", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    // The wire payload's `samples` field is the b64 string the runner
    // pre-encoded; we pass distinct b64 strings to verify the
    // controller emits each with the right id-to-payload pairing.
    c.noteAudioBatch(id, [{ samples: "B64-ABC", ts: 100 }], 22050);
    c.noteAudioBatch(id, [{ samples: "B64-DEF", ts: 200 }], 22050);
    const batches = r.events.filter((e) => e.kind === "tts.utterance.audio_batch");
    expect(batches).toHaveLength(2);
    expect((batches[0].payload as { id: string }).id).toBe(id);
    expect((batches[0].payload as { sampleRate: number }).sampleRate).toBe(22050);
    expect((batches[0].payload as { chunks: Array<{ samples: string; ts: number }> }).chunks).toEqual([{ samples: "B64-ABC", ts: 100 }]);
    expect((batches[1].payload as { chunks: Array<{ samples: string; ts: number }> }).chunks).toEqual([{ samples: "B64-DEF", ts: 200 }]);
  });

  it("noteAudioBatch with a multi-chunk array emits a single envelope carrying all chunks", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioBatch(id, [
      { samples: "B64-1", ts: 100 },
      { samples: "B64-2", ts: 140 },
      { samples: "B64-3", ts: 180 },
    ], 22050);
    const batches = r.events.filter((e) => e.kind === "tts.utterance.audio_batch");
    expect(batches).toHaveLength(1);
    const chunks = (batches[0].payload as { chunks: Array<{ samples: string }> }).chunks;
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.samples)).toEqual(["B64-1", "B64-2", "B64-3"]);
  });

  it("noteAudioBatch with an empty chunks array is a no-op (no envelope, no implicit start)", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    const before = r.events.length;
    c.noteAudioBatch(id, [], 22050);
    expect(r.events.length).toBe(before);
    expect(c.current()?.audioStartedAt).toBeNull();
  });

  it("noteAudioChunk for a stale id (cancelled / replaced) is dropped silently", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id1 = c.start({ text: "a", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.start({ text: "b", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    // First utterance was implicitly cancelled by the second start; chunks
    // for it must NOT be forwarded.
    const before = r.events.length;
    c.noteAudioBatch(id1, [{ samples: "AAAAAAA=", ts: 100 }], 22050);
    expect(r.events.length).toBe(before);
  });

  it("noteAudioEnd emits utterance.audio_ended with actualDurationMs", () => {
    const r = makeRecorder();
    let nowMs = 5000;
    const c = createUtteranceController({ sink: r.sink, now: () => nowMs });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 2000 });
    nowMs = 5100;
    c.noteAudioStart(id);
    nowMs = 7000;
    c.noteAudioEnd(id);
    const ended = r.events.filter((e) => e.kind === "tts.utterance.audio_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ id, at: 7000, actualDurationMs: 1900 });
  });

  it("noteAudioEnd before any audio_started reports actualDurationMs=0 (Piper crashed before producing audio)", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink, now: () => 1000 });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioEnd(id);
    const ended = r.events.filter((e) => e.kind === "tts.utterance.audio_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ id, actualDurationMs: 0 });
  });

  it("noteAudioEnd after the utterance has already ended is a no-op", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioEnd(id);
    const before = r.events.length;
    c.noteAudioEnd(id);
    expect(r.events.length).toBe(before);
  });

  it("noteAudioChunk after noteAudioEnd is dropped silently (audio already over)", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioStart(id);
    c.noteAudioEnd(id);
    const before = r.events.length;
    c.noteAudioBatch(id, [{ samples: "AAAAAAA=", ts: 100 }], 22050);
    expect(r.events.length).toBe(before);
  });

  it("cancel emits utterance.cancelled and clears current()", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink, now: () => 9000 });
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.cancel(id);
    const cancelled = r.events.filter((e) => e.kind === "tts.utterance.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].payload).toMatchObject({ id, at: 9000 });
    expect(c.current()).toBeNull();
  });

  it("cancel for a stale id is a no-op", () => {
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    c.start({ text: "a", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.cancel("never-existed");
    const cancelled = r.events.filter((e) => e.kind === "tts.utterance.cancelled");
    expect(cancelled).toHaveLength(0);
  });

  it("starting a new utterance while one is in flight implicitly cancels the prior one", () => {
    // Important contract: the runner's narrator queues lines serially
    // via the engine, so under normal operation a new start call
    // implies the previous utterance is finishing or done. Belt-and-
    // braces: if the runner ever fires two starts back-to-back, the
    // controller should clean up the prior utterance rather than leak
    // its state into the new one.
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id1 = c.start({ text: "a", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.start({ text: "b", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    const cancelled = r.events.filter((e) => e.kind === "tts.utterance.cancelled");
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0].payload as { id: string }).id).toBe(id1);
  });

  it("after implicit-cancel, lifecycle calls for the cancelled id are no-ops", () => {
    // Defends the runner-side wiring's assumption that a stale id from
    // a prior `runOnce` callback (back-to-back narrator.speak() that
    // queued ahead of audio playback) cannot accidentally emit a
    // bogus envelope for the cancelled utterance. This is the test
    // case the reviewer flagged as missing — the original
    // "implicitly cancels" test at line 167 only verifies that the
    // cancelled envelope fires for id1, not that subsequent
    // noteAudio* calls for id1 are dropped silently.
    const r = makeRecorder();
    const c = createUtteranceController({ sink: r.sink });
    const id1 = c.start({ text: "a", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.start({ text: "b", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    const lengthAfterCancel = r.events.length;
    // Late audio_start, audio_chunk, audio_end for the cancelled id1
    // must NOT cause any new envelopes to fire — those would mis-
    // attribute audio to id1 in PR 3's page-side reducer.
    c.noteAudioStart(id1);
    c.noteAudioBatch(id1, [{ samples: "B64-LATE", ts: 100 }], 22050);
    c.noteAudioEnd(id1);
    expect(r.events.length).toBe(lengthAfterCancel);
  });

  it("current() reflects the active utterance with timestamps populated as the lifecycle progresses", () => {
    const r = makeRecorder();
    let nowMs = 100;
    const c = createUtteranceController({ sink: r.sink, now: () => nowMs });
    expect(c.current()).toBeNull();
    const id = c.start({ text: "hi", intent: "manual", mood: "happy", estimatedDurationMs: 1500 });
    expect(c.current()).toMatchObject({
      id,
      text: "hi",
      mood: "happy",
      startedAt: 100,
      audioStartedAt: null,
      audioEndedAt: null,
    });
    nowMs = 200;
    c.noteAudioStart(id);
    expect(c.current()).toMatchObject({ audioStartedAt: 200, audioEndedAt: null });
    nowMs = 1700;
    c.noteAudioEnd(id);
    // After end, current() returns null — the utterance is no longer active.
    expect(c.current()).toBeNull();
  });

  it("idGenerator can be injected for deterministic tests", () => {
    const ids = ["fixed-1", "fixed-2"];
    let i = 0;
    const r = makeRecorder();
    const c = createUtteranceController({
      sink: r.sink,
      idGenerator: () => ids[i++],
    });
    expect(c.start({ text: "a", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 })).toBe("fixed-1");
    expect(c.start({ text: "b", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 })).toBe("fixed-2");
  });

  it("sink errors are swallowed so a misbehaving overlay forwarder can't kill the runner", () => {
    let calls = 0;
    const c = createUtteranceController({
      sink: () => { calls++; throw new Error("downstream boom"); },
    });
    // Each lifecycle method invokes the sink — none should throw.
    const id = c.start({ text: "x", intent: "manual", mood: "neutral", estimatedDurationMs: 1500 });
    c.noteAudioStart(id);
    c.noteAudioBatch(id, [{ samples: "AAAAAAA=", ts: 100 }], 22050);
    c.noteAudioEnd(id);
    expect(calls).toBeGreaterThan(0);
  });
});
