/**
 * Tests for the Thinker — pin the throttle contract (TTS-active gate
 * + min-interval), the forceEmit bypass, and the overlay envelope
 * shape pushed on `thought.bubble`.
 */

import { describe, it, expect } from "vitest";
import { createThinker } from "../src/runner/thinker";
import type { OverlayForwarder } from "../src/runner/overlay";

interface RecordingForwarder extends OverlayForwarder {
  events: { kind: string; payload?: unknown }[];
}
function recordingForwarder(): RecordingForwarder {
  const events: { kind: string; payload?: unknown }[] = [];
  return {
    events,
    async send(kind, payload) {
      events.push({ kind, payload });
    },
  };
}

/**
 * Build a Thinker bound to a controllable clock for deterministic
 * timing assertions.
 */
function fixture(clockStart = 1000) {
  const overlay = recordingForwarder();
  let now = clockStart;
  let nextId = 0;
  const thinker = createThinker(overlay, {
    now: () => now,
    idGen: () => `t${nextId++}`,
    minIntervalMs: 1000,
    ttsTailBufferMs: 200,
  });
  return {
    overlay,
    thinker,
    advance: (ms: number) => { now += ms; },
    setNow: (t: number) => { now = t; },
    nowRef: () => now,
  };
}

describe("createThinker", () => {
  it("emits a thought.bubble envelope on consider() when no gate is active", () => {
    const { overlay, thinker } = fixture();
    thinker.consider("nn_confidence_high", "happy", { predictedCents: 999, sigmaCents: 100 });
    expect(overlay.events).toHaveLength(1);
    expect(overlay.events[0].kind).toBe("thought.bubble");
    const p = overlay.events[0].payload as { text: string; intent: string; mood: string; id: string };
    expect(p.text).toMatch(/\$/); // cents got formatted
    expect(p.intent).toBe("nn_confidence_high");
    expect(p.mood).toBe("happy");
    expect(p.id).toBe("t0"); // deterministic via idGen
  });

  it("drops consider() while TTS is mid-utterance (observeTtsLine + buffer)", () => {
    const { overlay, thinker, advance } = fixture();
    thinker.observeTtsLine(2000);
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(0);
    // Advance past durationMs but still inside the tail buffer.
    advance(2100);
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(0);
    // Advance past tail buffer.
    advance(200);
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(1);
  });

  it("drops consider() while still inside the min-interval window", () => {
    const { overlay, thinker, advance } = fixture();
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(1);
    advance(500); // < minIntervalMs (1000)
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(1);
    advance(600); // total 1100 — past min interval
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(2);
  });

  it("forceEmit bypasses both the TTS-active gate and the min-interval gate", () => {
    const { overlay, thinker } = fixture();
    thinker.observeTtsLine(5000); // lock TTS gate for 5s + tail
    thinker.forceEmit("strategy_rationale", "neutral", { literalText: "must be visible" });
    expect(overlay.events).toHaveLength(1);
    // Back-to-back force should also land — no min-interval gate either.
    thinker.forceEmit("strategy_rationale", "neutral", { literalText: "second" });
    expect(overlay.events).toHaveLength(2);
  });

  it("observeTtsLine takes the max watermark — short utterance during a long one's window", () => {
    // The narrator emits onLine at queue time, not playback time, so
    // two back-to-back lines could call observe before either has
    // finished. The Thinker must take max(prev, candidate) so a short
    // one doesn't shrink the active window.
    const { overlay, thinker, advance } = fixture();
    thinker.observeTtsLine(5000); // long line — lock until 1000+5000+200 = 6200
    thinker.observeTtsLine(500);  // short line — would be 1000+500+200 = 1700 if min were taken
    advance(1800);                // past short, well before long
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(0);
  });

  it("observeTtsLine guards against non-finite durations (no NaN watermark)", () => {
    const { overlay, thinker, advance } = fixture();
    thinker.observeTtsLine(NaN);
    // NaN clamps to 0 — the tail buffer (200ms) is the only delay,
    // not an unbounded NaN-poisoned watermark. Past the buffer, the
    // gate releases.
    advance(300);
    thinker.consider("nn_top_feature", "neutral", { featureName: "brand" });
    expect(overlay.events).toHaveLength(1);
  });

  it("each emission carries an id, intent, mood, at, and pre-filled text", () => {
    const { overlay, thinker } = fixture(5000);
    thinker.consider("exploration_draw", "elated", { predictedCents: 1000, drawCents: 1500 });
    const env = overlay.events[0];
    expect(env.kind).toBe("thought.bubble");
    const p = env.payload as { id: string; text: string; intent: string; mood: string; at: number };
    expect(p).toMatchObject({
      intent: "exploration_draw",
      mood: "elated",
      at: 5000,
    });
    expect(typeof p.id).toBe("string");
    expect(p.id.length).toBeGreaterThan(0);
    expect(p.text).toMatch(/\$/); // cents formatted into the template
  });

  it("falls back to DEFAULT_MOOD when no mood is supplied", () => {
    const { overlay, thinker } = fixture();
    thinker.consider("nn_top_feature", undefined, { featureName: "brand" });
    const p = overlay.events[0].payload as { mood: string };
    expect(p.mood).toBe("neutral"); // DEFAULT_MOOD per @price-game/shared
  });
});
