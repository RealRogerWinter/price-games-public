/**
 * Tests for the Wilson 95% interval helper exported from
 * `@price-game/shared`. The helper is consumed by `getUtmTagComparison` for
 * ranking-by-lower-bound and by the admin UI for the inline CI display, so
 * regressions here would silently corrupt the leaderboard order.
 */

import { describe, expect, it } from "vitest";
import {
  WILSON_Z_95,
  wilsonCompare,
  wilsonInterval,
} from "@price-game/shared";

describe("wilsonInterval", () => {
  it("returns the maximally-uninformative interval for n=0", () => {
    const r = wilsonInterval(0, 0);
    expect(r.lo).toBe(0);
    expect(r.hi).toBe(1);
    expect(r.halfWidth).toBe(0.5);
    // Point is NaN (k/n = 0/0); callers render '—' or hide.
    expect(Number.isNaN(r.point)).toBe(true);
  });

  it("falls back to n=0 semantics on bad inputs", () => {
    // Negative trials, negative successes, k > n, NaN, +Inf — math is
    // undefined for any of these, so we want a safe pass-through.
    for (const [k, n] of [
      [-1, 10],
      [10, -1],
      [11, 10],
      [Number.NaN, 5],
      [5, Number.NaN],
      [Number.POSITIVE_INFINITY, 10],
    ] as Array<[number, number]>) {
      const r = wilsonInterval(k, n);
      expect(r.lo).toBe(0);
      expect(r.hi).toBe(1);
    }
  });

  it("gives a non-degenerate interval when k=0 (no successes)", () => {
    // Normal approximation would give a width-0 interval at the boundary
    // — Wilson's whole point is that it doesn't.
    const r = wilsonInterval(0, 10);
    expect(r.point).toBe(0);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(0);
    expect(r.hi).toBeLessThan(1);
    // Sanity: ≈ 0.2775 from scipy's binomtest(0, 10).proportion_ci(method="wilson").
    // (R's prop.test uses continuity correction by default and gives ≈ 0.31 —
    // we deliberately implement vanilla Wilson, matching scipy/Wikipedia.)
    expect(r.hi).toBeCloseTo(0.2775, 3);
  });

  it("gives a non-degenerate interval when k=n (all successes)", () => {
    const r = wilsonInterval(10, 10);
    expect(r.point).toBe(1);
    expect(r.hi).toBe(1);
    expect(r.lo).toBeLessThan(1);
    expect(r.lo).toBeGreaterThan(0);
    // Symmetry: lo at k=n should equal 1 - hi at k=0 (Wilson is symmetric).
    expect(r.lo).toBeCloseTo(1 - 0.2775, 3);
  });

  it("matches reference values for a mid-range case", () => {
    // 5/12 = 41.67%. Reference Wilson CI at 95% computed from the
    // Wikipedia textbook formula:
    //   center = (k + z²/2) / (n + z²) = 6.9207 / 15.8415 ≈ 0.43687
    //   half   = (z · √( k(n-k)/n + z²/4 )) / (n + z²) ≈ 0.24362
    //   lower  ≈ 0.19326, upper ≈ 0.68049.
    const r = wilsonInterval(5, 12);
    expect(r.point).toBeCloseTo(5 / 12, 6);
    expect(r.lo).toBeCloseTo(0.19326, 4);
    expect(r.hi).toBeCloseTo(0.68049, 4);
  });

  it("narrows as N grows for a fixed point estimate", () => {
    // Same 50% rate, larger N → smaller half-width. Catches reversed
    // sign in the std-error term (a classic copy-paste bug).
    const small = wilsonInterval(5, 10);
    const big = wilsonInterval(500, 1000);
    expect(big.halfWidth).toBeLessThan(small.halfWidth);
    expect(big.halfWidth).toBeLessThan(0.05);
  });

  it("clamps lo and hi to [0, 1] to absorb float drift", () => {
    // Defensive: at any (k, n) the math may produce -1e-17 / 1+1e-17 due
    // to ULP rounding. The interval must still be a probability.
    for (const [k, n] of [
      [0, 1],
      [1, 1],
      [0, 1_000_000],
      [1_000_000, 1_000_000],
    ] as Array<[number, number]>) {
      const r = wilsonInterval(k, n);
      expect(r.lo).toBeGreaterThanOrEqual(0);
      expect(r.hi).toBeLessThanOrEqual(1);
    }
  });

  it("uses the documented 95% z constant", () => {
    // If someone bumps WILSON_Z_95 to a 99% z by accident, downstream
    // ranking thresholds shift silently — pin it.
    expect(WILSON_Z_95).toBeCloseTo(1.96, 2);
    expect(WILSON_Z_95).toBeGreaterThan(1.959);
    expect(WILSON_Z_95).toBeLessThan(1.961);
  });
});

describe("wilsonCompare", () => {
  it("reports 'above' when a is entirely above b", () => {
    const a = wilsonInterval(95, 100); // ≈ 0.95
    const b = wilsonInterval(5, 100); // ≈ 0.05
    expect(wilsonCompare(a, b)).toBe("above");
  });

  it("reports 'below' when a is entirely below b", () => {
    const a = wilsonInterval(5, 100);
    const b = wilsonInterval(95, 100);
    expect(wilsonCompare(a, b)).toBe("below");
  });

  it("reports 'overlap' when intervals touch even slightly", () => {
    // Two near-equal proportions at high N — intervals will overlap.
    const a = wilsonInterval(50, 100);
    const b = wilsonInterval(52, 100);
    expect(wilsonCompare(a, b)).toBe("overlap");
  });

  it("reports 'overlap' when one is the [0, 1] uninformative interval", () => {
    // n=0 case must NEVER be flagged as significantly different — used by
    // the dashboard to suppress ★/▼ badges on empty tags.
    const empty = wilsonInterval(0, 0);
    const real = wilsonInterval(10, 100);
    expect(wilsonCompare(empty, real)).toBe("overlap");
    expect(wilsonCompare(real, empty)).toBe("overlap");
  });
});
