/**
 * Phase 3e.3 — Adaptive Gradient Clipping (AGC) unit tests.
 *
 * AGC's per-buffer rule:
 *   scale_i = min(1, lambda * max(||W_i||, eps_param) / max(||g_i||, eps_grad))
 *   g_i *= scale_i
 *
 * The tests cover the math directly so a future refactor can't silently
 * break the per-buffer scaling. Integration with WorkerCore's training
 * step is covered by the broader workerCore_guards suite via the
 * gradNormP95 telemetry — this file is the focused contract.
 */
import { describe, expect, it } from "vitest";
import { adaptiveClipGradientsInPlace } from "../../src/learning/mlp";

describe("adaptiveClipGradientsInPlace", () => {
  it("leaves gradients untouched when ||g|| <= lambda * ||W||", () => {
    // ||W|| = 10 (sqrt(100)). lambda = 0.1 → threshold = 1.0.
    // ||g|| = 0.5 < 1.0 → no clip.
    const W = new Float32Array([10, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // ||W|| = 10
    const g = new Float32Array([0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // ||g|| = 0.5
    const before = Array.from(g);
    const result = adaptiveClipGradientsInPlace([W], [g], 0.1);
    expect(result.numClipped).toBe(0);
    expect(result.minScale).toBe(1);
    expect(Array.from(g)).toEqual(before);
  });

  it("scales gradient to exactly lambda * ||W|| when over threshold", () => {
    // ||W|| = 10. lambda = 0.1 → threshold = 1.0.
    // ||g|| = 5.0 > 1.0 → scale = 0.2; new ||g|| = 1.0.
    const W = new Float32Array([10, 0, 0, 0]);
    const g = new Float32Array([5, 0, 0, 0]);
    const result = adaptiveClipGradientsInPlace([W], [g], 0.1);
    expect(result.numClipped).toBe(1);
    expect(result.minScale).toBeCloseTo(0.2, 6);
    // After scaling, ||g|| should equal threshold = 1.0.
    const newNorm = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
    expect(newNorm).toBeCloseTo(1.0, 5);
  });

  it("clips multiple buffers independently", () => {
    // Buffer 0: well-conditioned (no clip).
    // Buffer 1: explosive grad (clip).
    const W0 = new Float32Array([5, 0, 0, 0]); // ||W|| = 5
    const g0 = new Float32Array([0.4, 0, 0, 0]); // ||g|| = 0.4 < 0.5
    const W1 = new Float32Array([5, 0, 0, 0]); // ||W|| = 5
    const g1 = new Float32Array([100, 0, 0, 0]); // ||g|| = 100 >> 0.5
    const result = adaptiveClipGradientsInPlace([W0, W1], [g0, g1], 0.1);
    expect(result.numClipped).toBe(1);
    expect(result.minScale).toBeCloseTo(0.005, 6); // 0.5 / 100
    // Buffer 0 unchanged.
    expect(g0[0]).toBeCloseTo(0.4, 6);
    // Buffer 1 clipped to ||g|| = lambda * ||W|| = 0.5.
    expect(g1[0]).toBeCloseTo(0.5, 5);
  });

  it("uses epsParam floor for tiny / zero-init parameter buffers", () => {
    // Zero-init param: without eps_param, threshold would be 0,
    // and any non-zero grad would scale to 0 → kill the gradient.
    // With eps_param = 1e-3, threshold = lambda * 1e-3 = 1e-4 (for
    // lambda = 0.1). A modest grad should still get clipped tightly
    // but not zeroed.
    const W = new Float32Array([0, 0, 0, 0]); // ||W|| = 0
    const g = new Float32Array([1, 0, 0, 0]); // ||g|| = 1
    const result = adaptiveClipGradientsInPlace([W], [g], 0.1, 1e-3);
    expect(result.numClipped).toBe(1);
    // Threshold = 0.1 * 1e-3 = 1e-4. Scale = 1e-4 / 1 = 1e-4.
    expect(result.minScale).toBeCloseTo(1e-4, 8);
    expect(g[0]).toBeCloseTo(1e-4, 8);
  });

  it("handles zero-grad buffers without division-by-zero", () => {
    const W = new Float32Array([1, 2, 3]);
    const g = new Float32Array([0, 0, 0]);
    const result = adaptiveClipGradientsInPlace([W], [g], 0.1);
    // ||g|| = 0; epsGrad floors it; threshold > epsGrad so no clip.
    expect(result.numClipped).toBe(0);
    expect(result.minScale).toBe(1);
    expect(Array.from(g)).toEqual([0, 0, 0]);
  });

  it("rejects param/grad length mismatch", () => {
    const W = new Float32Array([1, 2, 3]);
    const g = new Float32Array([1, 2]);
    expect(() => adaptiveClipGradientsInPlace([W], [g], 0.1)).toThrow(/length mismatch/);
  });

  it("rejects buffer-count mismatch", () => {
    const W0 = new Float32Array([1]);
    const g0 = new Float32Array([1]);
    const g1 = new Float32Array([2]);
    expect(() => adaptiveClipGradientsInPlace([W0], [g0, g1], 0.1)).toThrow(/params\.length/);
  });

  it("S5: lambda === 0 is a no-op contract (returns unchanged grads)", () => {
    // Updated post-#343 review: previously lambda=0 zeroed every
    // gradient via epsParam-floored threshold. The function now
    // treats lambda=0 as an explicit "skip me" signal, matching the
    // WorkerCore caller's `if (agcLambda > 0)` guard. This is the
    // safer contract — direct callers who pass 0 won't accidentally
    // wipe their gradients.
    const W = new Float32Array([10]);
    const g = new Float32Array([1, 2, 3]);
    const before = Array.from(g);
    const result = adaptiveClipGradientsInPlace([W], [g], 0);
    expect(result.numClipped).toBe(0);
    expect(result.minScale).toBe(1);
    expect(Array.from(g)).toEqual(before);
  });

  it("matches the documented Brock 2021 formula on a realistic small case", () => {
    // ||W|| = sqrt(0.1²+0.2²+0.3²+0.4²) = sqrt(0.3) ≈ 0.5477
    // ||g|| = sqrt(1²+2²+3²+4²) = sqrt(30) ≈ 5.477
    // lambda = 0.05 → threshold ≈ 0.0274
    // ratio = 0.0274 / 5.477 ≈ 0.005
    // post-scale ||g|| should ≈ threshold ≈ 0.0274
    const W = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const g = new Float32Array([1, 2, 3, 4]);
    const result = adaptiveClipGradientsInPlace([W], [g], 0.05);
    expect(result.numClipped).toBe(1);
    const newNorm = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
    const expectedThreshold = 0.05 * Math.sqrt(0.3);
    expect(newNorm).toBeCloseTo(expectedThreshold, 5);
    expect(result.minScale).toBeCloseTo(expectedThreshold / Math.sqrt(30), 5);
  });

  it("S4: rejects negative lambda (would flip gradient signs)", () => {
    const W = new Float32Array([1]);
    const g = new Float32Array([1]);
    expect(() => adaptiveClipGradientsInPlace([W], [g], -0.1)).toThrow(/must be >= 0/);
  });

  it("S4: rejects NaN / Infinity lambda", () => {
    const W = new Float32Array([1]);
    const g = new Float32Array([1]);
    expect(() => adaptiveClipGradientsInPlace([W], [g], Number.NaN)).toThrow(/finite/);
    expect(() => adaptiveClipGradientsInPlace([W], [g], Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("B2: skipIndices skips listed buffers entirely", () => {
    const W0 = new Float32Array([10, 0, 0, 0]);
    const g0 = new Float32Array([10, 0, 0, 0]); // would clip: ||g||=10 > λ·||W||=1
    const W1 = new Float32Array([1, 0, 0, 0]); // bias-like
    const g1 = new Float32Array([5, 0, 0, 0]); // would clip HARD
    const result = adaptiveClipGradientsInPlace(
      [W0, W1],
      [g0, g1],
      0.1,
      undefined,
      undefined,
      new Set([1]),
    );
    expect(result.numClipped).toBe(1);
    expect(g0[0]).toBeCloseTo(1.0, 5); // clipped to threshold
    expect(g1[0]).toBe(5); // skipped, untouched
  });

  it("B2: skipIndices=undefined applies AGC to all buffers (back-compat)", () => {
    const W = new Float32Array([1]);
    const g = new Float32Array([100]);
    const result = adaptiveClipGradientsInPlace([W], [g], 0.1);
    expect(result.numClipped).toBe(1);
  });
});
