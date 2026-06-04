import { describe, it, expect } from "vitest";
import { softmaxSample } from "../src/realism/softmax";
import { seeded, sampleMany } from "./_rng";

describe("softmaxSample", () => {
  it("throws when the candidate list is empty", () => {
    expect(() => softmaxSample([])).toThrow();
  });

  it("returns the only candidate with no RNG draws", () => {
    const c = { payload: "only", score: 5 };
    expect(softmaxSample([c])).toBe(c);
  });

  it("with T=0 always returns the highest-scoring candidate", () => {
    const cs = [
      { payload: "a", score: 0.5 },
      { payload: "b", score: 1.5 },
      { payload: "c", score: 0.8 },
    ];
    const rng = seeded(1);
    for (let i = 0; i < 100; i++) {
      expect(softmaxSample(cs, { temperature: 0, rng }).payload).toBe("b");
    }
  });

  it("with high T approaches uniform distribution over candidates", () => {
    const cs = [
      { payload: "a", score: 0 },
      { payload: "b", score: 1 },
      { payload: "c", score: 2 },
    ];
    const rng = seeded(11);
    const counts = { a: 0, b: 0, c: 0 } as Record<string, number>;
    sampleMany(3000, () => softmaxSample(cs, { temperature: 1000, rng })).forEach((s) => {
      counts[s.payload as string]++;
    });
    // Each ~1000 ± a generous margin.
    for (const k of ["a", "b", "c"]) {
      expect(counts[k]).toBeGreaterThan(700);
      expect(counts[k]).toBeLessThan(1300);
    }
  });

  it("with low T concentrates mass on the best candidate", () => {
    const cs = [
      { payload: "a", score: 0 },
      { payload: "b", score: 1 },
      { payload: "c", score: 2 },
    ];
    const rng = seeded(22);
    const counts = { a: 0, b: 0, c: 0 } as Record<string, number>;
    sampleMany(3000, () => softmaxSample(cs, { temperature: 0.1, rng })).forEach((s) => {
      counts[s.payload as string]++;
    });
    // 'c' should dominate by a wide margin.
    expect(counts.c).toBeGreaterThan(counts.a + counts.b);
  });

  it("is deterministic for a seeded RNG at fixed temperature", () => {
    const cs = [
      { payload: 1, score: 0.4 },
      { payload: 2, score: 0.6 },
      { payload: 3, score: 0.5 },
    ];
    const a = softmaxSample(cs, { temperature: 0.4, rng: seeded(99) });
    const b = softmaxSample(cs, { temperature: 0.4, rng: seeded(99) });
    expect(a).toBe(b);
  });
});
