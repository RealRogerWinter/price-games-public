import { describe, it, expect } from "vitest";
import { createLinePicker, LINE_LIBRARY } from "../src/tts/lines";
import { nullEngine, loggingEngine } from "../src/tts/engine";
import { seeded } from "./_rng";

describe("LINE_LIBRARY", () => {
  it("has at least 3 lines for every event so the no-repeat picker has options", () => {
    for (const [event, set] of Object.entries(LINE_LIBRARY)) {
      expect(set.default.length, `event ${event}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("createLinePicker", () => {
  it("returns a string from the configured event's library", () => {
    const pick = createLinePicker({ rng: seeded(1) });
    const line = pick("round_start");
    expect(LINE_LIBRARY.round_start.default.includes(line)).toBe(true);
  });

  it("does not repeat a line within the no-repeat window", () => {
    const pick = createLinePicker({ rng: seeded(2), noRepeatWindow: 3 });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) seen.push(pick("decision_announce"));
    // Walk the trailing window and confirm no duplicates.
    for (let i = 1; i < seen.length; i++) {
      const window = seen.slice(Math.max(0, i - 3), i);
      expect(window.includes(seen[i])).toBe(false);
    }
  });

  it("falls back gracefully when the no-repeat window exhausts the pool", () => {
    // Only one event has a tiny pool — synthesize the test by choosing
    // a window larger than the pool. Picker must not throw.
    const pick = createLinePicker({ rng: seeded(3), noRepeatWindow: 100 });
    for (let i = 0; i < 20; i++) {
      const line = pick("win_close");
      expect(typeof line).toBe("string");
    }
  });

  it("biases toward mood-specific variants when present", () => {
    const pick = createLinePicker({ rng: seeded(4) });
    const happyLines = LINE_LIBRARY.round_start.byMood?.happy ?? [];
    const found = new Set<string>();
    for (let i = 0; i < 200; i++) found.add(pick("round_start", "happy"));
    // At least one happy-only line should have been picked.
    const overlap = happyLines.some((l) => found.has(l));
    expect(overlap).toBe(true);
  });
});

describe("TTS engines", () => {
  it("nullEngine drops every line without throwing", async () => {
    const e = nullEngine();
    await e.say("hello");
    await e.say("world", { priority: "high" });
    await e.dispose();
  });

  it("loggingEngine appends lines to the sink", async () => {
    const e = loggingEngine();
    await e.say("first");
    await e.say("second", { priority: "high" });
    expect(e.log.map((x) => x.line)).toEqual(["first", "second"]);
    expect(e.log[1].priority).toBe("high");
  });
});
