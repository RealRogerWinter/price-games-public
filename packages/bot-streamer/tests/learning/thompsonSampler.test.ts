import { describe, expect, it } from "vitest";
import { adaptiveEpsilon, MODE_EPSILON_MULTIPLIER, quantileShift, thompsonDraw } from "../../src/learning/thompsonSampler";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("thompsonDraw", () => {
  it("centres on mu in expectation", () => {
    const rng = lcg(42);
    const samples: number[] = [];
    for (let i = 0; i < 5000; i++) samples.push(thompsonDraw(10, 1, 1, rng));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(Math.abs(mean - 10)).toBeLessThan(0.1);
  });

  it("std-dev scales with k·sigma", () => {
    const rng1 = lcg(1);
    const rng2 = lcg(2);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 5000; i++) {
      a.push(thompsonDraw(0, 1, 1, rng1));
      b.push(thompsonDraw(0, 1, 2, rng2));
    }
    function std(arr: number[]): number {
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
      return Math.sqrt(v);
    }
    expect(std(a)).toBeCloseTo(1, 0);
    expect(std(b)).toBeCloseTo(2, 0);
  });
});

describe("adaptiveEpsilon", () => {
  it("clamps at the floor early", () => {
    const e = adaptiveEpsilon({
      sigmaPred: 0.1,
      sigmaCalibratedMedian: 0.4,
      categoryEntropy: 1.0,
      round: 0,
      epsilonFloorStart: 0.1,
      epsilonFloorEnd: 0.03,
      epsilonDecayRounds: 1000,
    });
    expect(e).toBeGreaterThanOrEqual(0.1);
  });

  it("decays floor over decayRounds", () => {
    const lateE = adaptiveEpsilon({
      sigmaPred: 0,
      sigmaCalibratedMedian: 100,
      categoryEntropy: 0,
      round: 1000,
      epsilonFloorStart: 0.1,
      epsilonFloorEnd: 0.03,
      epsilonDecayRounds: 1000,
    });
    expect(lateE).toBeCloseTo(0.05, 2);
  });

  it("rises with sigmaPred above calibrated median", () => {
    const low = adaptiveEpsilon({
      sigmaPred: 0,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy: 0,
      round: 0,
      epsilonFloorStart: 0,
      epsilonFloorEnd: 0,
      epsilonDecayRounds: 1,
    });
    const high = adaptiveEpsilon({
      sigmaPred: 1.5,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy: 0,
      round: 0,
      epsilonFloorStart: 0,
      epsilonFloorEnd: 0,
      epsilonDecayRounds: 1,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("entropy bonus only fires above 3.0", () => {
    const noEnt = adaptiveEpsilon({
      sigmaPred: 0,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy: 2.5,
      round: 0,
      epsilonFloorStart: 0,
      epsilonFloorEnd: 0,
      epsilonDecayRounds: 1,
    });
    const withEnt = adaptiveEpsilon({
      sigmaPred: 0,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy: 3.5,
      round: 0,
      epsilonFloorStart: 0,
      epsilonFloorEnd: 0,
      epsilonDecayRounds: 1,
    });
    expect(withEnt - noEnt).toBeCloseTo(0.15, 2);
  });

  it("hard ceiling at 0.5", () => {
    const e = adaptiveEpsilon({
      sigmaPred: 100,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy: 5,
      round: 0,
      epsilonFloorStart: 0,
      epsilonFloorEnd: 0,
      epsilonDecayRounds: 1,
    });
    expect(e).toBeLessThanOrEqual(0.5);
  });
});

describe("quantileShift", () => {
  it("subtracts τ·σ", () => {
    expect(quantileShift(10, 2, 0.4)).toBeCloseTo(10 - 0.8, 6);
    expect(quantileShift(10, 2, 0)).toBe(10);
  });
});

describe("adaptiveEpsilon mode multiplier", () => {
  it("τ-quantile-shift modes get a 0.5 multiplier", () => {
    for (const m of ["closest-without-going-over", "riser", "budget-builder", "bidding"]) {
      expect(MODE_EPSILON_MULTIPLIER[m]).toBe(0.5);
    }
  });

  it("multiplied modes have lower ε than unmultiplied modes (same input)", () => {
    const base = {
      sigmaPred: 1,
      sigmaCalibratedMedian: 0.3,
      categoryEntropy: 1,
      round: 5_000,
      epsilonFloorStart: 0.01,
      epsilonFloorEnd: 0.01,
      epsilonDecayRounds: 1_000,
    };
    const classic = adaptiveEpsilon(base);
    const closest = adaptiveEpsilon({ ...base, modeMultiplier: 0.5 });
    expect(closest).toBeLessThan(classic);
  });

  it("never pushes ε below 1/2 of the floor", () => {
    const eps = adaptiveEpsilon({
      sigmaPred: 0,
      sigmaCalibratedMedian: 100,
      categoryEntropy: 0,
      round: 100_000,
      epsilonFloorStart: 0.1,
      epsilonFloorEnd: 0.04,
      epsilonDecayRounds: 1_000,
      modeMultiplier: 0.01, // aggressive
    });
    // Floor end is 0.04 → guard at 0.02.
    expect(eps).toBeGreaterThanOrEqual(0.02);
  });
});
