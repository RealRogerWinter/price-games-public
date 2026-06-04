import { describe, it, expect } from "vitest";
import { gaussian, readingDelayMs, decisionDelayMs, interActionDelayMs } from "../src/realism/timing";
import { seeded, sampleMany } from "./_rng";

describe("gaussian", () => {
  it("produces deterministic output for a seeded RNG", () => {
    const a = gaussian(0, 1, seeded(42));
    const b = gaussian(0, 1, seeded(42));
    expect(a).toBe(b);
  });

  it("approximates the requested mean and stddev over many samples", () => {
    const rng = seeded(1);
    const samples = sampleMany(2000, () => gaussian(10, 2, rng));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
    const stddev = Math.sqrt(variance);
    expect(Math.abs(mean - 10)).toBeLessThan(0.2);
    expect(Math.abs(stddev - 2)).toBeLessThan(0.2);
  });
});

describe("readingDelayMs", () => {
  it("is bounded to [1200, 6000] ms", () => {
    const rng = seeded(7);
    for (let i = 0; i < 500; i++) {
      const d = readingDelayMs(40, { rng });
      expect(d).toBeGreaterThanOrEqual(1200);
      expect(d).toBeLessThanOrEqual(6000);
    }
  });

  it("trends longer for longer prompts", () => {
    const rng = seeded(3);
    const short = sampleMany(500, () => readingDelayMs(20, { rng }));
    const long = sampleMany(500, () => readingDelayMs(400, { rng }));
    const meanShort = short.reduce((a, b) => a + b, 0) / short.length;
    const meanLong = long.reduce((a, b) => a + b, 0) / long.length;
    expect(meanLong).toBeGreaterThan(meanShort);
  });

  it("handles zero-length prompts without exploding", () => {
    expect(readingDelayMs(0, { rng: seeded(11) })).toBeGreaterThanOrEqual(1200);
  });
});

describe("decisionDelayMs", () => {
  it("is always at least 50ms", () => {
    const rng = seeded(99);
    for (let i = 0; i < 500; i++) {
      expect(decisionDelayMs({ rng })).toBeGreaterThanOrEqual(50);
    }
  });

  it("most samples fall in the short range; some in the second-thought range", () => {
    const rng = seeded(13);
    const samples = sampleMany(2000, () => decisionDelayMs({ rng }));
    const shortish = samples.filter((d) => d <= 1100).length;
    const longish = samples.filter((d) => d >= 1500).length;
    // 92% short, 8% long target. Loose bounds so the test isn't flaky.
    expect(shortish).toBeGreaterThan(samples.length * 0.85);
    expect(longish).toBeGreaterThan(samples.length * 0.02);
    expect(longish).toBeLessThan(samples.length * 0.15);
  });
});

describe("interActionDelayMs", () => {
  it("price-match averages near 850ms (range fits within [200, 2400])", () => {
    const rng = seeded(11);
    const samples = sampleMany(500, () => interActionDelayMs("price-match", { rng }));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(700);
    expect(mean).toBeLessThan(1000);
    samples.forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(2400);
    });
  });

  it("sort-it-out-first is markedly slower than sort-it-out", () => {
    const rng = seeded(17);
    const regular = sampleMany(500, () => interActionDelayMs("sort-it-out", { rng }));
    const first = sampleMany(500, () => interActionDelayMs("sort-it-out-first", { rng }));
    const meanRegular = regular.reduce((a, b) => a + b, 0) / regular.length;
    const meanFirst = first.reduce((a, b) => a + b, 0) / first.length;
    expect(meanFirst).toBeGreaterThan(meanRegular + 400);
  });

  it("bidding-fill never returns less than 800ms (MP turn-deadline floor)", () => {
    const rng = seeded(23);
    for (let i = 0; i < 500; i++) {
      expect(interActionDelayMs("bidding-fill", { rng })).toBeGreaterThanOrEqual(800);
    }
  });

  it("chain-reaction-final is heavier than chain-reaction (stakes-rising beat)", () => {
    const rng = seeded(29);
    const regular = sampleMany(500, () => interActionDelayMs("chain-reaction", { rng }));
    const final = sampleMany(500, () => interActionDelayMs("chain-reaction-final", { rng }));
    const meanRegular = regular.reduce((a, b) => a + b, 0) / regular.length;
    const meanFinal = final.reduce((a, b) => a + b, 0) / final.length;
    expect(meanFinal).toBeGreaterThan(meanRegular + 200);
  });
});
