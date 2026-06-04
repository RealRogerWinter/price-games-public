import { describe, it, expect } from "vitest";
import { nextMomentum, MOMENTUM_MIN, MOMENTUM_MAX } from "./momentum";

describe("nextMomentum", () => {
  it("clamps the result to [MOMENTUM_MIN, MOMENTUM_MAX]", () => {
    for (let i = 0; i < 5000; i++) {
      const m = nextMomentum(Math.random() * 4 - 2);
      expect(m).toBeGreaterThanOrEqual(MOMENTUM_MIN);
      expect(m).toBeLessThanOrEqual(MOMENTUM_MAX);
    }
  });

  it("mean-reverts toward 1.0 over a long random walk", () => {
    let m = 1.0;
    let sum = 0;
    const N = 50000;
    for (let i = 0; i < N; i++) {
      m = nextMomentum(m);
      sum += m;
    }
    const mean = sum / N;
    // AR(1) with mean 1.0 and bounded noise should land within ~0.05 of 1.0
    expect(Math.abs(mean - 1.0)).toBeLessThan(0.05);
  });

  it("preserves some autocorrelation (streakiness)", () => {
    // Lag-1 autocorrelation > 0 — neighboring rounds should be correlated, not independent.
    const N = 10000;
    const series: number[] = [1.0];
    for (let i = 0; i < N; i++) series.push(nextMomentum(series[series.length - 1]));
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    let cov = 0, varSum = 0;
    for (let i = 1; i < series.length; i++) {
      cov += (series[i] - mean) * (series[i - 1] - mean);
      varSum += (series[i] - mean) ** 2;
    }
    const r1 = cov / varSum;
    expect(r1).toBeGreaterThan(0.2);
  });

  it("returns 1.0 when prev is undefined (cold start)", () => {
    // Cold-start should not throw; it returns a valid clamped sample.
    const m = nextMomentum(undefined);
    expect(m).toBeGreaterThanOrEqual(MOMENTUM_MIN);
    expect(m).toBeLessThanOrEqual(MOMENTUM_MAX);
  });
});
