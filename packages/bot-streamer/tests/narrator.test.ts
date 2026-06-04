import { describe, it, expect } from "vitest";
import { MOOD_REGISTRY } from "@price-game/shared";
import { createNarrator } from "../src/runner/narrator";
import { loggingEngine, type TtsEngine } from "../src/tts/engine";
import { LINE_LIBRARY } from "../src/tts/lines";
import { seeded } from "./_rng";

describe("createNarrator", () => {
  it("speak() picks from the configured event library and queues via the engine", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.speak("round_start");
    expect(engine.log).toHaveLength(1);
    expect(LINE_LIBRARY.round_start.default.includes(engine.log[0].line)).toBe(true);
  });

  it("speak() can pull from mood-specific variants", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(2) });
    const happyLines = LINE_LIBRARY.round_start.byMood?.happy ?? [];
    let happyHits = 0;
    for (let i = 0; i < 200; i++) {
      await narrator.speak("round_start", "happy");
    }
    happyHits = engine.log.filter((entry) => happyLines.includes(entry.line)).length;
    expect(happyHits).toBeGreaterThan(0);
  });

  it("speak(event, mood) draws from the mood pool the majority of the time (default moodBias=0.75)", async () => {
    // Pre-fix behavior was uniform-over-union, so a 12-default vs
    // 2-mood event surfaced mood lines only ~14% of the time. The
    // re-weighted picker should now hit mood lines well above 50%.
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(7) });
    const happyLines = LINE_LIBRARY.round_start.byMood?.happy ?? [];
    expect(happyLines.length).toBeGreaterThan(0);
    const N = 400;
    for (let i = 0; i < N; i++) await narrator.speak("round_start", "happy");
    const happyHits = engine.log.filter((e) => happyLines.includes(e.line)).length;
    // 0.75 bias minus statistical wiggle for N=400 — comfortably > 0.5.
    expect(happyHits / N).toBeGreaterThan(0.6);
  });

  it("moodBias=1 routes every pick to the mood pool when one exists", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(11), moodBias: 1 });
    const elatedLines = LINE_LIBRARY.win_correct.byMood?.elated ?? [];
    expect(elatedLines.length).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await narrator.speak("win_correct", "elated");
    const allMood = engine.log.every((e) => elatedLines.includes(e.line));
    expect(allMood).toBe(true);
  });

  it("moodBias=0 reproduces default-pool-only behavior even when a mood is supplied", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(13), moodBias: 0 });
    const happyLines = LINE_LIBRARY.round_start.byMood?.happy ?? [];
    const defaultLines = LINE_LIBRARY.round_start.default;
    for (let i = 0; i < 50; i++) await narrator.speak("round_start", "happy");
    const moodHits = engine.log.filter((e) => happyLines.includes(e.line)).length;
    const defaultHits = engine.log.filter((e) => defaultLines.includes(e.line)).length;
    expect(moodHits).toBe(0);
    expect(defaultHits).toBe(50);
  });

  it("falls back to the default pool when the supplied mood has no entries for that event", async () => {
    // mode_change_classic has no byMood pool — supplying a mood
    // should be a silent no-op routing-wise; we still draw from
    // the default pool.
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(17) });
    const defaults = LINE_LIBRARY.mode_change_classic.default;
    for (let i = 0; i < 25; i++) await narrator.speak("mode_change_classic", "elated");
    const allDefault = engine.log.every((e) => defaults.includes(e.line));
    expect(allDefault).toBe(true);
  });

  it("say() forwards a literal line to the engine", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine);
    await narrator.say("hello viewers");
    expect(engine.log[0].line).toBe("hello viewers");
  });

  it("say() ignores empty strings", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine);
    await narrator.say("");
    expect(engine.log).toHaveLength(0);
  });

  it("dispose() drains the engine", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine);
    await narrator.dispose();
    // No assertion beyond "doesn't throw" — loggingEngine.dispose is a no-op.
    expect(true).toBe(true);
  });

  it("onLine fires for speak() with intent + estimated durationMs", async () => {
    const engine = loggingEngine();
    const captured: { line: string; intent: string; durationMs: number }[] = [];
    const narrator = createNarrator(engine, {
      rng: seeded(1),
      onLine: (line, intent, durationMs) => captured.push({ line, intent, durationMs }),
    });
    await narrator.speak("round_start");
    expect(captured).toHaveLength(1);
    expect(captured[0].intent).toBe("round_start");
    expect(captured[0].durationMs).toBeGreaterThanOrEqual(1500);
    expect(captured[0].durationMs).toBeLessThanOrEqual(8000);
  });

  it("onLine fires for say() with intent='manual'", async () => {
    const engine = loggingEngine();
    const captured: { intent: string }[] = [];
    const narrator = createNarrator(engine, {
      onLine: (_line, intent) => captured.push({ intent }),
    });
    await narrator.say("the answer is forty");
    expect(captured).toHaveLength(1);
    expect(captured[0].intent).toBe("manual");
  });

  it("onLine carries the mood for speak() so the UtteranceController can capture mood-at-decision", async () => {
    const engine = loggingEngine();
    const captured: { mood: string }[] = [];
    const narrator = createNarrator(engine, {
      rng: seeded(1),
      onLine: (_line, _intent, _durationMs, mood) => captured.push({ mood }),
    });
    await narrator.speak("round_start", "happy");
    expect(captured).toHaveLength(1);
    expect(captured[0].mood).toBe("happy");
  });

  it("onLine defaults mood to DEFAULT_MOOD for say() (no event/mood association)", async () => {
    const engine = loggingEngine();
    const captured: { mood: string }[] = [];
    const narrator = createNarrator(engine, {
      onLine: (_line, _intent, _durationMs, mood) => captured.push({ mood }),
    });
    await narrator.say("hello");
    expect(captured).toHaveLength(1);
    // DEFAULT_MOOD is "neutral" per @price-game/shared.
    expect(captured[0].mood).toBe("neutral");
  });

  it("onLine does not fire when say() is given an empty string", async () => {
    const engine = loggingEngine();
    const captured: string[] = [];
    const narrator = createNarrator(engine, {
      onLine: (line) => captured.push(line),
    });
    await narrator.say("");
    expect(captured).toHaveLength(0);
  });

  it("onLine swallowing exceptions does not break engine.say()", async () => {
    // A mistakenly-throwing onLine consumer must not block the
    // narrator from queueing the line for playback.
    const engine = loggingEngine();
    const narrator = createNarrator(engine, {
      onLine: () => { throw new Error("downstream boom"); },
    });
    await narrator.say("still spoken");
    expect(engine.log[0].line).toBe("still spoken");
  });
});

describe("narrator.reactive (rate-limited speak)", () => {
  /**
   * `reactive` is the entrypoint the runner calls for outcome-driven
   * narration (win_correct / loss_off_a_lot / game_win / …). Its
   * contract differs from `speak`:
   *   - When an utterance is already in flight, the new call is
   *     suppressed (resolves silently, no engine.say) — reactive
   *     lines are decorative; queueing them would make Pricey
   *     announce a result two utterances after it happened.
   *   - When the engine is idle, it behaves identically to `speak`.
   *
   * The engine here is the synchronous loggingEngine — its `say`
   * resolves immediately, so to test the suppression we need a
   * gated engine that holds the first say() open until we let go.
   */

  function gatedEngine(): TtsEngine & { log: string[]; release(): void } {
    const log: string[] = [];
    let resolveCurrent: (() => void) | null = null;
    return {
      log,
      say(line: string) {
        log.push(line);
        return new Promise<void>((resolve) => { resolveCurrent = resolve; });
      },
      dispose: async () => {},
      release(): void {
        const r = resolveCurrent;
        resolveCurrent = null;
        r?.();
      },
    };
  }

  it("when idle, reactive() speaks like speak()", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.reactive("win_correct");
    expect(engine.log).toHaveLength(1);
    expect(LINE_LIBRARY.win_correct.default.includes(engine.log[0].line)).toBe(true);
  });

  it("when an utterance is in flight, reactive() suppresses (resolves with no engine call)", async () => {
    const engine = gatedEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    // Kick off a long utterance — engine holds it open.
    const inFlight = narrator.speak("round_start");
    expect(engine.log.length).toBe(1); // round_start landed in the engine
    // Reactive call lands while inFlight is pending → should be dropped.
    await narrator.reactive("win_correct");
    expect(engine.log.length).toBe(1); // still only the first utterance
    // Let the first one finish and confirm reactive() can speak again
    // — fire-and-forget here so we don't block on the gated engine's
    // second never-resolved promise; we only need to confirm the
    // engine.say WAS invoked, which gatedEngine records synchronously.
    engine.release();
    await inFlight;
    void narrator.reactive("win_correct");
    expect(engine.log.length).toBe(2);
  });

  it("suppressed reactive() does not fire onLine", async () => {
    const engine = gatedEngine();
    const captured: string[] = [];
    const narrator = createNarrator(engine, {
      rng: seeded(1),
      onLine: (_line, intent) => captured.push(intent),
    });
    const inFlight = narrator.speak("round_start");
    await narrator.reactive("win_correct");
    // Only the round_start onLine should have fired.
    expect(captured).toEqual(["round_start"]);
    engine.release();
    await inFlight;
  });

  it("two reactive() calls back-to-back: first speaks, second is suppressed until first finishes", async () => {
    const engine = gatedEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    const first = narrator.reactive("win_correct");
    await narrator.reactive("loss_off_a_lot");
    expect(engine.log.length).toBe(1);
    engine.release();
    await first;
  });

  it("an engine rejection inside reactive() is swallowed AND decrements the in-flight counter", async () => {
    // Load-bearing invariant of the rate limiter: if the try/finally
    // around engine.say in dispatch ever breaks, a single Piper
    // failure permanently silences Pricey because inFlight stays >0
    // forever. This test pins both halves of the contract.
    let saysSeen = 0;
    const engine: TtsEngine & { sink: string[] } = {
      sink: [],
      async say(line) {
        saysSeen++;
        if (saysSeen === 1) throw new Error("piper boom");
        this.sink.push(line);
      },
      async dispose() {},
    };
    const narrator = createNarrator(engine, { rng: seeded(1) });
    // First reactive call: engine throws — must NOT propagate, and
    // inFlight must decrement so the next call isn't suppressed.
    await expect(narrator.reactive("win_correct")).resolves.toBeUndefined();
    expect(engine.sink.length).toBe(0); // first say threw
    // Second reactive call should now succeed, proving inFlight === 0.
    await narrator.reactive("win_correct");
    expect(engine.sink.length).toBe(1);
  });
});

describe("narrator threads mood prosody into engine.say", () => {
  it("speak(event, mood) passes every prosody knob from the descriptor via SayOptions", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.speak("round_start", "elated");
    expect(engine.log).toHaveLength(1);
    // Elated reads as breathless excitement → fastest pacing + most
    // expressive variability in the registry.
    const elated = MOOD_REGISTRY.elated.prosody;
    expect(engine.log[0].lengthScale).toBe(elated.lengthScale);
    expect(engine.log[0].noiseScale).toBe(elated.noiseScale);
    expect(engine.log[0].noiseW).toBe(elated.noiseW);
  });

  it("reactive(event, mood) also passes the full prosody descriptor to the engine", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.reactive("loss_off_a_lot", "despondent");
    expect(engine.log).toHaveLength(1);
    const desp = MOOD_REGISTRY.despondent.prosody;
    expect(engine.log[0].lengthScale).toBe(desp.lengthScale);
    expect(engine.log[0].noiseScale).toBe(desp.noiseScale);
    expect(engine.log[0].noiseW).toBe(desp.noiseW);
  });

  it("speak() WITHOUT a mood omits all prosody knobs (Piper falls back to model defaults)", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.speak("round_start");
    expect(engine.log[0].lengthScale).toBeUndefined();
    expect(engine.log[0].noiseScale).toBeUndefined();
    expect(engine.log[0].noiseW).toBeUndefined();
  });

  it("manual say() always omits prosody (no mood signal at the !hint path)", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine);
    await narrator.say("hint relayed by chat");
    expect(engine.log[0].lengthScale).toBeUndefined();
    expect(engine.log[0].noiseScale).toBeUndefined();
    expect(engine.log[0].noiseW).toBeUndefined();
  });

  it("polarity contract: positive moods speak faster than neutral, negative slower", async () => {
    const engine = loggingEngine();
    const narrator = createNarrator(engine, { rng: seeded(1) });
    await narrator.speak("round_start", "happy");
    await narrator.speak("round_start", "neutral");
    await narrator.speak("round_start", "frustrated");
    const [happy, neutral, frustrated] = engine.log;
    expect(happy.lengthScale!).toBeLessThan(neutral.lengthScale!);
    expect(frustrated.lengthScale!).toBeGreaterThan(neutral.lengthScale!);
  });

  it("expressiveness contract: elated/tilted are more variable than focused/despondent", async () => {
    // The registry encodes "deflated" moods (focused, despondent) as
    // low-variance and "agitated" moods (elated, tilted) as high.
    // Locking that ordering here keeps a future tweak from accidentally
    // collapsing the expressive axis.
    const elated = MOOD_REGISTRY.elated.prosody;
    const tilted = MOOD_REGISTRY.tilted.prosody;
    const focused = MOOD_REGISTRY.focused.prosody;
    const despondent = MOOD_REGISTRY.despondent.prosody;
    expect(elated.noiseScale).toBeGreaterThan(focused.noiseScale);
    expect(elated.noiseW).toBeGreaterThan(focused.noiseW);
    expect(tilted.noiseScale).toBeGreaterThan(despondent.noiseScale);
    expect(tilted.noiseW).toBeGreaterThan(despondent.noiseW);
  });
});
