import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { piperEngine, buildPiperArgs } from "../src/tts/piperEngine";

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

describe("piperEngine", () => {
  it("spawns piper + aplay and forwards stdout into aplay.stdin", async () => {
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    aplay.stdin.write = vi.fn() as never;
    aplay.stdin.end = vi.fn();
    const calls: string[] = [];
    const spawnFn = vi.fn((bin: string) => {
      calls.push(bin);
      // Schedule aplay's exit on the next microtask so the listener
      // has time to attach before the event fires.
      const child = calls.length === 1 ? piper : aplay;
      if (calls.length === 2) setTimeout(() => child.emit("exit"), 0);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/voices/amy.onnx",
      spawnFn,
    });

    const sayP = engine.say("hello");
    // Yield once so runOnce attaches its listeners before we emit data.
    await Promise.resolve();
    piper.stdout.emit("data", Buffer.from([0x01, 0x02, 0x03, 0x04]));
    piper.stdout.emit("end");
    await sayP;

    expect(calls).toEqual(["piper", "aplay"]);
    expect(aplay.stdin.write).toHaveBeenCalled();
    expect(piper.stdin.write).toHaveBeenCalledWith("hello\n");
    expect(piper.stdin.end).toHaveBeenCalled();
  });

  it("queues sequential say() calls", async () => {
    const order: string[] = [];
    const spawnFn = vi.fn(() => {
      const child = makeFakeChild();
      // Emit exit asynchronously to simulate the pipe completing.
      setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
    });

    const a = engine.say("first").then(() => order.push("a"));
    const b = engine.say("second").then(() => order.push("b"));
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("invokes onError when spawn throws", async () => {
    const onError = vi.fn();
    const spawnFn = vi.fn(() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
      onError,
    });
    await engine.say("hi");
    expect(onError).toHaveBeenCalled();
    const [err, line] = onError.mock.calls[0];
    expect((err as Error).message).toBe("ENOENT");
    expect(line).toBe("hi");
  });

  it("dispose() drains the in-flight queue", async () => {
    const spawnFn = vi.fn(() => {
      const child = makeFakeChild();
      // Schedule exit far enough out that dispose() observes the in-
      // flight say still pending, then fires.
      setTimeout(() => child.emit("exit"), 10);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
    });

    const sayPromise = engine.say("first");
    const disposePromise = engine.dispose();
    await Promise.all([sayPromise, disposePromise]);
  });

  it("drops empty lines without spawning", async () => {
    const spawnFn = vi.fn();
    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn,
    });
    await engine.say("");
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("forwards Piper stdout to aplay AND emits PCM chunks of the configured size", async () => {
    // PCM tap (Phase 1B): the engine teehs Piper's raw audio so aplay
    // continues to play it through Pulse while a sidechannel callback
    // sees the same bytes and emits them as Int16Array chunks of a
    // fixed size for downstream lipsync consumers.
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    const aplayWrites: Buffer[] = [];
    aplay.stdin.write = vi.fn((b: Buffer | string) => {
      aplayWrites.push(Buffer.from(b as Buffer));
      return true;
    }) as never;
    aplay.stdin.end = vi.fn();
    const calls: string[] = [];
    const spawnFn = vi.fn((bin: string) => {
      calls.push(bin);
      const child = calls.length === 1 ? piper : aplay;
      if (calls.length === 2) setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const chunks: Array<{ samples: Int16Array; ts: number }> = [];
    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
      pcmChunkBytes: 8, // 4 samples per chunk for test ergonomics
      onPcmChunk: (samples, ts) => chunks.push({ samples, ts }),
    });

    const sayPromise = engine.say("hello");
    // Yield once so runOnce can attach data listeners before we emit.
    await Promise.resolve();
    // 14 bytes = 7 samples → expect 1 full chunk (4 samples) + 3 leftover
    // bytes that get flushed only at end-of-stream. Emit in two pushes
    // to confirm the buffer accumulates across `data` events.
    const first = Buffer.from([0x10, 0x00, 0x20, 0x00, 0x30, 0x00]);   // 3 samples
    const second = Buffer.from([0x40, 0x00, 0x50, 0x00, 0x60, 0x00, 0x70, 0x00]); // 4 samples
    piper.stdout.emit("data", first);
    piper.stdout.emit("data", second);
    piper.stdout.emit("end");
    await sayPromise;

    // Audio playback path (aplay) saw every byte exactly once, in order.
    const aplayConcat = Buffer.concat(aplayWrites);
    expect(aplayConcat.equals(Buffer.concat([first, second]))).toBe(true);

    // Lipsync path saw 1 full 4-sample chunk; the 3-sample remainder
    // may either flush at end-of-stream or be dropped — current contract
    // requires the full chunk and tolerates the remainder either way.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const c0 = chunks[0];
    expect(c0.samples).toBeInstanceOf(Int16Array);
    expect(c0.samples.length).toBe(4);
    expect(Array.from(c0.samples)).toEqual([0x10, 0x20, 0x30, 0x40]);
    expect(typeof c0.ts).toBe("number");
  });

  it("fires onAudioEnd from aplay.exit so the UtteranceController gets the real audio-end signal", async () => {
    // PR 2 introduces this callback as the source-of-truth replacement
    // for the speakingClock's PCM-quiescence heuristic. The contract
    // is: onAudioEnd fires once per say() call, exactly when aplay
    // exits (i.e. the speaker buffer has actually drained), and BEFORE
    // the say() promise resolves so any synchronous follow-up
    // (`controller.noteAudioEnd`) lands before the next runOnce can
    // grab the chain.
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    aplay.stdin.write = vi.fn() as never;
    aplay.stdin.end = vi.fn();
    const calls: string[] = [];
    const spawnFn = vi.fn((bin: string) => {
      calls.push(bin);
      const child = calls.length === 1 ? piper : aplay;
      if (calls.length === 2) setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const onAudioEnd = vi.fn();
    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
      onAudioEnd,
    });
    const p = engine.say("hi");
    await Promise.resolve();
    piper.stdout.emit("data", Buffer.from([0x10, 0x00, 0x20, 0x00]));
    piper.stdout.emit("end");
    await p;
    expect(onAudioEnd).toHaveBeenCalledTimes(1);
  });

  it("onAudioEnd that throws does not break the audio chain (errors swallowed)", async () => {
    const spawnFn = vi.fn(() => {
      const child = makeFakeChild();
      setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
      onAudioEnd: () => { throw new Error("downstream boom"); },
    });
    // say() must still resolve cleanly even though the callback threw.
    await expect(engine.say("hi")).resolves.toBeUndefined();
    // Subsequent say() must still queue and run — chain was not broken.
    await expect(engine.say("again")).resolves.toBeUndefined();
  });

  it("does not invoke onPcmChunk when not configured (back-compat with Phase 1A)", async () => {
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    aplay.stdin.write = vi.fn() as never;
    aplay.stdin.end = vi.fn();
    const calls: string[] = [];
    const spawnFn = vi.fn((bin: string) => {
      calls.push(bin);
      const child = calls.length === 1 ? piper : aplay;
      if (calls.length === 2) setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const engine = piperEngine({
      voiceModelPath: "/v.onnx",
      spawnFn,
    });
    const p = engine.say("hi");
    await Promise.resolve();
    piper.stdout.emit("data", Buffer.from([0x10, 0x00, 0x20, 0x00]));
    piper.stdout.emit("end");
    await p;
    // No onPcmChunk option → no observable mismatch / errors. Audio
    // path still works (the only thing the existing call-site uses).
    expect(aplay.stdin.write).toHaveBeenCalled();
  });
});

describe("buildPiperArgs", () => {
  it("baseline argv when no prosody is provided", () => {
    expect(buildPiperArgs("/v.onnx")).toEqual(["--model", "/v.onnx", "--output_raw"]);
    expect(buildPiperArgs("/v.onnx", {})).toEqual(["--model", "/v.onnx", "--output_raw"]);
  });

  it("appends --length_scale when a finite value is provided", () => {
    expect(buildPiperArgs("/v.onnx", { lengthScale: 0.95 })).toEqual([
      "--model", "/v.onnx", "--output_raw", "--length_scale", "0.95",
    ]);
  });

  it("appends --noise_scale and --noise_w when finite values are provided", () => {
    expect(buildPiperArgs("/v.onnx", { noiseScale: 0.85, noiseW: 1.0 })).toEqual([
      "--model", "/v.onnx", "--output_raw",
      "--noise_scale", "0.85",
      "--noise_w", "1",
    ]);
  });

  it("appends every knob in argv order: length_scale, noise_scale, noise_w", () => {
    // Stable ordering matters for snapshot-style assertions in
    // upstream tests + makes the rendered argv predictable to read in
    // logs.
    expect(
      buildPiperArgs("/v.onnx", { lengthScale: 1.05, noiseScale: 0.5, noiseW: 0.65 }),
    ).toEqual([
      "--model", "/v.onnx", "--output_raw",
      "--length_scale", "1.05",
      "--noise_scale", "0.5",
      "--noise_w", "0.65",
    ]);
  });

  it("clamps lengthScale to the practical [0.5, 2.0] range to keep speech intelligible", () => {
    // Outside this range Piper either clips syllables (too fast) or
    // sounds drugged (too slow). The clamp protects against a
    // malformed descriptor or a bug in a future caller from asking
    // for nonsensical pacing.
    const high = buildPiperArgs("/v.onnx", { lengthScale: 5.0 });
    expect(high[high.length - 1]).toBe("2");
    const low = buildPiperArgs("/v.onnx", { lengthScale: 0.1 });
    expect(low[low.length - 1]).toBe("0.5");
  });

  it("clamps noiseScale and noiseW to [0.0, 1.5] (Piper artefacts past ~1.0)", () => {
    const high = buildPiperArgs("/v.onnx", { noiseScale: 9, noiseW: 9 });
    expect(high[high.indexOf("--noise_scale") + 1]).toBe("1.5");
    expect(high[high.indexOf("--noise_w") + 1]).toBe("1.5");
    const low = buildPiperArgs("/v.onnx", { noiseScale: -2, noiseW: -2 });
    expect(low[low.indexOf("--noise_scale") + 1]).toBe("0");
    expect(low[low.indexOf("--noise_w") + 1]).toBe("0");
  });

  it("ignores non-finite knobs (NaN, ±Infinity) — falls back to baseline argv", () => {
    expect(buildPiperArgs("/v.onnx", { lengthScale: Number.NaN })).toEqual(["--model", "/v.onnx", "--output_raw"]);
    expect(buildPiperArgs("/v.onnx", { lengthScale: Number.POSITIVE_INFINITY })).toEqual(["--model", "/v.onnx", "--output_raw"]);
    expect(buildPiperArgs("/v.onnx", { lengthScale: Number.NEGATIVE_INFINITY })).toEqual(["--model", "/v.onnx", "--output_raw"]);
    expect(buildPiperArgs("/v.onnx", { noiseScale: Number.NaN, noiseW: Number.NaN })).toEqual(["--model", "/v.onnx", "--output_raw"]);
  });
});

describe("piperEngine — say(line, opts) threads prosody into Piper argv", () => {
  it("passes every prosody knob present on SayOptions through to argv", async () => {
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    aplay.stdin.write = vi.fn() as never;
    aplay.stdin.end = vi.fn();
    const seenArgs: string[][] = [];
    const spawnFn = vi.fn().mockImplementation((bin: string, args: string[]) => {
      seenArgs.push(args);
      const child = bin === "piper" ? piper : aplay;
      if (bin !== "piper") setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = piperEngine({ voiceModelPath: "/v.onnx", spawnFn });
    const p = engine.say("hi", { lengthScale: 1.10, noiseScale: 0.85, noiseW: 1.0 });
    await Promise.resolve();
    piper.stdout.emit("end");
    await p;
    // First spawn was piper; argv should include all three flags.
    const piperArgs = seenArgs[0];
    expect(piperArgs[piperArgs.indexOf("--length_scale") + 1]).toBe("1.1");
    expect(piperArgs[piperArgs.indexOf("--noise_scale") + 1]).toBe("0.85");
    expect(piperArgs[piperArgs.indexOf("--noise_w") + 1]).toBe("1");
  });

  it("does NOT pass any prosody flags when no opts are set (baseline argv)", async () => {
    const piper = makeFakeChild();
    const aplay = makeFakeChild();
    aplay.stdin.write = vi.fn() as never;
    aplay.stdin.end = vi.fn();
    const seenArgs: string[][] = [];
    const spawnFn = vi.fn().mockImplementation((bin: string, args: string[]) => {
      seenArgs.push(args);
      const child = bin === "piper" ? piper : aplay;
      if (bin !== "piper") setTimeout(() => child.emit("exit"), 5);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const engine = piperEngine({ voiceModelPath: "/v.onnx", spawnFn });
    const p = engine.say("hi");
    await Promise.resolve();
    piper.stdout.emit("end");
    await p;
    expect(seenArgs[0]).not.toContain("--length_scale");
    expect(seenArgs[0]).not.toContain("--noise_scale");
    expect(seenArgs[0]).not.toContain("--noise_w");
  });
});
