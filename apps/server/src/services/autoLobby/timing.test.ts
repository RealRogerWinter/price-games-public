import { describe, it, expect } from "vitest";
import { sampleHumanlikeDelayMs } from "./timing";

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p10: sorted[Math.floor(samples.length * 0.10)],
    p50: sorted[Math.floor(samples.length * 0.50)],
    p90: sorted[Math.floor(samples.length * 0.90)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

describe("sampleHumanlikeDelayMs", () => {
  it("returns positive integers", () => {
    for (let i = 0; i < 100; i++) {
      const ms = sampleHumanlikeDelayMs();
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });

  it("median lands between ~2-5 seconds for default mixture", () => {
    const samples = Array.from({ length: 5000 }, () => sampleHumanlikeDelayMs());
    const stats = summarize(samples);
    expect(stats.p50).toBeGreaterThan(1500);
    expect(stats.p50).toBeLessThan(5500);
  });

  it("produces a fast-confident bucket and a thinking-pause bucket (multimodal)", () => {
    // Fast bucket should yield occasional <1.8s samples; pause bucket should
    // yield occasional >5.5s samples. With 5000 draws, both should fire.
    const samples = Array.from({ length: 5000 }, () => sampleHumanlikeDelayMs());
    const fastCount = samples.filter((s) => s < 1800).length;
    const pauseCount = samples.filter((s) => s > 5500).length;
    expect(fastCount).toBeGreaterThan(500);
    expect(pauseCount).toBeGreaterThan(250);
  });

  it("hard difficulty shifts mass toward the thinking-pause bucket", () => {
    const easySamples = Array.from({ length: 4000 }, () => sampleHumanlikeDelayMs({ difficulty: "easy" }));
    const hardSamples = Array.from({ length: 4000 }, () => sampleHumanlikeDelayMs({ difficulty: "hard" }));
    const easyPause = easySamples.filter((s) => s > 5500).length;
    const hardPause = hardSamples.filter((s) => s > 5500).length;
    expect(hardPause).toBeGreaterThan(easyPause);
  });

  it("respects an explicit cap", () => {
    for (let i = 0; i < 200; i++) {
      const ms = sampleHumanlikeDelayMs({ maxMs: 4000 });
      expect(ms).toBeLessThanOrEqual(4000);
    }
  });
});
