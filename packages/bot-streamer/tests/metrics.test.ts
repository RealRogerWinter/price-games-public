/**
 * Tests for adaptive-timeout rolling metrics. The contract:
 *  - Returns `defaultMs` while bootstrapping (sample count <
 *    `bootstrapSamples`).
 *  - Returns `clamp(p95 + safetyMs, floor, ceiling)` once bootstrapped.
 *  - Window size enforces FIFO drop of oldest samples.
 *  - Negative / NaN observations are ignored (defensive).
 */

import { describe, it, expect } from "vitest";
import { createRollingMetric, createDriverMetrics, DRIVER_METRIC_DEFAULTS } from "../src/runner/metrics";

describe("createRollingMetric", () => {
  it("returns the default while bootstrapping", () => {
    const m = createRollingMetric({
      defaultMs: 10_000,
      floorMs: 5_000,
      ceilingMs: 30_000,
      safetyMs: 2_000,
      bootstrapSamples: 5,
    });
    m.observe(500);
    m.observe(800);
    m.observe(1000);
    expect(m.timeout()).toBe(10_000);
  });

  it("adapts to p95 + safety once bootstrapped", () => {
    const m = createRollingMetric({
      defaultMs: 10_000,
      floorMs: 1_000,
      ceilingMs: 30_000,
      safetyMs: 1_000,
      bootstrapSamples: 5,
    });
    // 100 samples uniformly distributed 1000..10000ms.
    // p95 of an evenly-spaced window ≈ 9550ms. With +1000ms safety:
    // ~10_550ms.
    for (let i = 1; i <= 100; i++) m.observe(i * 100);
    const t = m.timeout();
    expect(t).toBeGreaterThan(9_000);
    expect(t).toBeLessThan(12_000);
  });

  it("clamps to ceilingMs when p95 + safety exceeds it", () => {
    const m = createRollingMetric({
      defaultMs: 10_000,
      floorMs: 1_000,
      ceilingMs: 5_000,
      safetyMs: 1_000,
      bootstrapSamples: 5,
    });
    for (let i = 0; i < 20; i++) m.observe(20_000);
    expect(m.timeout()).toBe(5_000);
  });

  it("clamps to floorMs when p95 + safety is below it", () => {
    const m = createRollingMetric({
      defaultMs: 10_000,
      floorMs: 5_000,
      ceilingMs: 30_000,
      safetyMs: 100,
      bootstrapSamples: 5,
    });
    for (let i = 0; i < 20; i++) m.observe(100); // p95 ≈ 100, +safety = 200
    expect(m.timeout()).toBe(5_000);
  });

  it("drops oldest samples when window is full", () => {
    const m = createRollingMetric(
      { defaultMs: 10_000, floorMs: 1_000, ceilingMs: 30_000, safetyMs: 0, bootstrapSamples: 1 },
      5,
    );
    for (let i = 0; i < 5; i++) m.observe(1_000);
    expect(m.sampleCount()).toBe(5);
    // New samples push the small ones out; window now contains only 9_000s.
    for (let i = 0; i < 5; i++) m.observe(9_000);
    expect(m.sampleCount()).toBe(5);
    // p95 of [9000 × 5] = 9000.
    expect(m.timeout()).toBeGreaterThanOrEqual(9_000);
  });

  it("ignores negative or NaN observations", () => {
    const m = createRollingMetric({
      defaultMs: 10_000,
      floorMs: 1_000,
      ceilingMs: 30_000,
      bootstrapSamples: 1,
    });
    m.observe(-500);
    m.observe(Number.NaN);
    m.observe(Number.POSITIVE_INFINITY);
    // Infinity is technically finite-checked false, so we ignore it too.
    expect(m.sampleCount()).toBe(0);
  });
});

describe("createDriverMetrics", () => {
  it("builds a metric set with the default tuning", () => {
    const set = createDriverMetrics();
    expect(set.roundStart.timeout()).toBe(DRIVER_METRIC_DEFAULTS.roundStart.defaultMs);
    expect(set.resultModalPrimary.timeout()).toBe(DRIVER_METRIC_DEFAULTS.resultModalPrimary.defaultMs);
    expect(set.resultModalExtension.timeout()).toBe(DRIVER_METRIC_DEFAULTS.resultModalExtension.defaultMs);
  });
});
