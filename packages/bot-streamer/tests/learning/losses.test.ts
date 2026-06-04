import { describe, expect, it } from "vitest";
import {
  betaNLL,
  ordinalSmoothedCE,
  pairwiseMarginLoss,
  sigmoidBCE,
  smoothL1,
  softmaxCE,
  softmax,
} from "../../src/learning/losses";

const EPS = 1e-3;

describe("smoothL1", () => {
  it("is quadratic inside the delta band", () => {
    const { loss, grad } = smoothL1(0.4, 0, 1);
    expect(loss).toBeCloseTo(0.5 * 0.4 * 0.4, 6);
    expect(grad).toBeCloseTo(0.4, 6);
  });

  it("is linear outside the delta band", () => {
    const { loss, grad } = smoothL1(2, 0, 1);
    expect(loss).toBeCloseTo(1.5, 6);
    expect(grad).toBe(1);
  });

  it("matches numerical gradient", () => {
    for (const v of [-0.3, 0.1, 0.7, 1.5, -2.1]) {
      const target = 0.2;
      const { grad } = smoothL1(v, target);
      const numGrad = (smoothL1(v + EPS, target).loss - smoothL1(v - EPS, target).loss) / (2 * EPS);
      expect(Math.abs(numGrad - grad)).toBeLessThan(1e-3);
    }
  });
});

describe("betaNLL (Seitzer 2022 with stop_grad on (σ²)^β)", () => {
  // Reference NLL per-sample (no β prefactor): L_NLL = ½(log σ² + r²/σ²).
  // The β-NLL implementation multiplies by (σ²)^β but treats it as a
  // *detached* prefactor for gradient purposes. So:
  //   gradMu        = (σ²)^β · (μ−y)/σ²
  //   gradLogSigma2 = (σ²)^β · ½(1 − r²/σ²)
  // Numerical-gradient checks below verify against L_NLL (un-prefactored)
  // multiplied by the prefactor evaluated at the center point — i.e. the
  // gradient that flows into the priceHead under stop_grad semantics.

  it("gradMu matches stop_grad analytical form", () => {
    const target = 0.4;
    const logSigma2 = 0.2;
    const beta = 0.5;
    const sigma2 = Math.exp(logSigma2);
    const prefactor = Math.pow(sigma2, beta);
    for (const mu of [-0.5, 0.0, 0.5, 1.2]) {
      const { gradMu } = betaNLL(mu, logSigma2, target, beta);
      // Analytical: (σ²)^β · (μ−y)/σ²
      const expected = prefactor * (mu - target) / sigma2;
      expect(Math.abs(expected - gradMu)).toBeLessThan(1e-6);
    }
  });

  it("gradLogSigma2 detaches the (σ²)^β prefactor", () => {
    const target = 0.4;
    const mu = 0.7;
    const beta = 0.5;
    for (const lz of [-1.0, -0.3, 0.0, 0.5, 1.2]) {
      const { gradLogSigma2 } = betaNLL(mu, lz, target, beta);
      // Numerical gradient of just L_NLL = ½(log σ² + r²/σ²), then
      // multiplied by the prefactor (σ²)^β evaluated at the centre —
      // i.e. the gradient under stop_grad on the prefactor.
      const sigma2Center = Math.exp(lz);
      const prefactor = Math.pow(sigma2Center, beta);
      const lNll = (z: number): number => {
        return 0.5 * (z + (mu - target) ** 2 / Math.exp(z));
      };
      const numGrad = prefactor * (lNll(lz + EPS) - lNll(lz - EPS)) / (2 * EPS);
      expect(Math.abs(numGrad - gradLogSigma2)).toBeLessThan(2e-3);
    }
  });

  it("β=0 reproduces ordinary NLL loss value", () => {
    const { loss } = betaNLL(0.5, 0.0, 0, 0);
    // L_NLL = 0.5·(0 + 0.25/1) = 0.125; (σ²)^0 = 1
    expect(loss).toBeCloseTo(0.125, 6);
  });

  it("gradient stays finite + bounded under high-residual / small-σ regime", () => {
    // This is the regression test for the round-530 divergence:
    // a large residual with a small σ² used to produce gradients
    // that grew without bound, eventually crashing to NaN. Under
    // stop_grad the gradient on logSigma2 is bounded by the prefactor
    // (which itself is ≤ exp(β·LOG_SIGMA2_CLAMP)) times ½(r²/σ²),
    // and under the upstream LOG_SIGMA2_CLAMP=4 the runaway is gone.
    const beta = 0.5;
    // r = 10, logσ² clamped at -4 (smallest σ² the caller ever passes)
    const { loss, gradMu, gradLogSigma2 } = betaNLL(10, -4, 0, beta);
    expect(Number.isFinite(loss)).toBe(true);
    expect(Number.isFinite(gradMu)).toBe(true);
    expect(Number.isFinite(gradLogSigma2)).toBe(true);
    // Sanity: well below the runaway magnitudes seen in production
    // (which reached 1e17). Under stop_grad with the upstream clamp
    // these stay in the low thousands.
    expect(Math.abs(gradMu)).toBeLessThan(1e4);
    expect(Math.abs(gradLogSigma2)).toBeLessThan(1e4);
  });

  it("σ² does NOT collapse under repeated bad-fit gradient steps", () => {
    // Property test: simulate Adam-free gradient descent on logσ² alone
    // with a fixed bad μ. Under the buggy (non-stop-grad) form, the
    // β·log σ² self-amplifying term makes σ² oscillate to ±∞ within
    // ~1000 steps. Under stop_grad the iterate stays bounded.
    let logSigma2 = 0.0;
    const mu = 5;
    const target = 0;
    const beta = 0.5;
    const lr = 0.01;
    for (let i = 0; i < 2000; i++) {
      const { gradLogSigma2 } = betaNLL(mu, logSigma2, target, beta);
      logSigma2 -= lr * gradLogSigma2;
      // Mimic the production clamp.
      if (logSigma2 > 4) logSigma2 = 4;
      if (logSigma2 < -4) logSigma2 = -4;
    }
    // The iterate should converge near logσ² = log(r²) = log(25) ≈ 3.22
    // (the maximum-likelihood σ² for this fixed μ). Any value in [2.5, 4]
    // proves it didn't collapse / explode.
    expect(logSigma2).toBeGreaterThan(2);
    expect(logSigma2).toBeLessThanOrEqual(4);
  });
});

describe("softmaxCE", () => {
  it("loss + grad match numerical for label smoothing 0", () => {
    const logits = new Float32Array([1.2, -0.3, 0.7, 2.1]);
    const target = 2;
    const { grad, loss } = softmaxCE(logits, target, 0);
    for (let i = 0; i < logits.length; i++) {
      const orig = logits[i];
      logits[i] = orig + EPS;
      const lp = softmaxCE(logits, target, 0).loss;
      logits[i] = orig - EPS;
      const lm = softmaxCE(logits, target, 0).loss;
      logits[i] = orig;
      const num = (lp - lm) / (2 * EPS);
      expect(Math.abs(num - grad[i])).toBeLessThan(1e-3);
    }
    expect(loss).toBeGreaterThan(0);
  });

  it("loss + grad match numerical for label smoothing 0.1", () => {
    const logits = new Float32Array([0.5, -1.0, 2.0]);
    const target = 0;
    const { grad } = softmaxCE(logits, target, 0.1);
    for (let i = 0; i < logits.length; i++) {
      const orig = logits[i];
      logits[i] = orig + EPS;
      const lp = softmaxCE(logits, target, 0.1).loss;
      logits[i] = orig - EPS;
      const lm = softmaxCE(logits, target, 0.1).loss;
      logits[i] = orig;
      const num = (lp - lm) / (2 * EPS);
      expect(Math.abs(num - grad[i])).toBeLessThan(1e-3);
    }
  });

  it("softmax sums to 1", () => {
    const p = softmax(new Float32Array([1, 2, 3]));
    let s = 0;
    for (let i = 0; i < p.length; i++) s += p[i];
    expect(s).toBeCloseTo(1, 6);
  });
});

describe("ordinalSmoothedCE", () => {
  // Synthetic catalog: log-spaced like real prices. The log-distance
  // smoothing in ordinal CE means missing the target by adjacent
  // index is much less wrong than missing by 5 indices.
  const logPrices = [
    Math.log(100),
    Math.log(500),
    Math.log(1000),
    Math.log(2000),
    Math.log(5000),
    Math.log(10000),
  ];
  const tau = Math.log(1.15);

  it("loss matches numerical gradient on logits", () => {
    const logits = new Float32Array([0.5, -0.2, 1.1, 0.3, -0.4, 0.0]);
    const target = 2;
    const { grad } = ordinalSmoothedCE(logits, target, logPrices, tau);
    for (let i = 0; i < logits.length; i++) {
      const orig = logits[i];
      logits[i] = orig + EPS;
      const lp = ordinalSmoothedCE(logits, target, logPrices, tau).loss;
      logits[i] = orig - EPS;
      const lm = ordinalSmoothedCE(logits, target, logPrices, tau).loss;
      logits[i] = orig;
      const num = (lp - lm) / (2 * EPS);
      expect(Math.abs(num - grad[i])).toBeLessThan(1e-3);
    }
  });

  it("perfect prediction (logit-spike at target) gives near-zero loss", () => {
    // With a huge logit at target, softmax ≈ one-hot at target.
    // Ordinal smoothing puts >0 mass on adjacent classes, so loss is
    // not exactly 0 — but it's small and bounded.
    const logits = new Float32Array(logPrices.length);
    logits[2] = 50; // dominate
    const { loss } = ordinalSmoothedCE(logits, 2, logPrices, tau);
    expect(loss).toBeGreaterThan(0);
    expect(loss).toBeLessThan(0.5);
  });

  it("smoothed labels sum to 1", () => {
    const logits = new Float32Array(logPrices.length);
    const { smoothed } = ordinalSmoothedCE(logits, 2, logPrices, tau);
    let s = 0;
    for (let i = 0; i < smoothed.length; i++) s += smoothed[i];
    expect(s).toBeCloseTo(1, 5);
  });

  it("smoothed mass concentrates on the target with neighbours getting small mass", () => {
    const logits = new Float32Array(logPrices.length);
    const { smoothed } = ordinalSmoothedCE(logits, 2, logPrices, tau);
    // Target gets the largest mass; mass decays with log-distance.
    expect(smoothed[2]).toBeGreaterThan(smoothed[1]);
    expect(smoothed[2]).toBeGreaterThan(smoothed[3]);
    expect(smoothed[1]).toBeGreaterThan(smoothed[0]);
    expect(smoothed[3]).toBeGreaterThan(smoothed[4]);
  });

  it("loss is greater when prediction is far from target than when close", () => {
    // Predict catalog[5] when target is catalog[2] — much worse than predicting catalog[3].
    const logitsClose = new Float32Array(logPrices.length);
    logitsClose[3] = 5;
    const lossClose = ordinalSmoothedCE(logitsClose, 2, logPrices, tau).loss;

    const logitsFar = new Float32Array(logPrices.length);
    logitsFar[5] = 5;
    const lossFar = ordinalSmoothedCE(logitsFar, 2, logPrices, tau).loss;

    expect(lossFar).toBeGreaterThan(lossClose);
  });

  it("τ=0 reduces to one-hot CE (no smoothing)", () => {
    // With τ → 0 the smoothing band collapses to the target only.
    // Compare to softmaxCE with labelSmoothing=0.
    const logits = new Float32Array([0.5, 0.2, 1.1, 0.3, -0.4, 0.0]);
    const { loss: ordinalLoss, grad: ordinalGrad } = ordinalSmoothedCE(logits, 2, logPrices, 1e-9);
    const { loss: ceLoss, grad: ceGrad } = softmaxCE(logits, 2, 0);
    expect(ordinalLoss).toBeCloseTo(ceLoss, 4);
    for (let i = 0; i < logits.length; i++) {
      expect(ordinalGrad[i]).toBeCloseTo(ceGrad[i], 4);
    }
  });

  it("gracefully handles target at boundary indices", () => {
    const logits = new Float32Array(logPrices.length);
    const r0 = ordinalSmoothedCE(logits, 0, logPrices, tau);
    const rLast = ordinalSmoothedCE(logits, logPrices.length - 1, logPrices, tau);
    let s0 = 0, sLast = 0;
    for (let i = 0; i < logits.length; i++) {
      s0 += r0.smoothed[i];
      sLast += rLast.smoothed[i];
    }
    expect(s0).toBeCloseTo(1, 5);
    expect(sLast).toBeCloseTo(1, 5);
    expect(Number.isFinite(r0.loss)).toBe(true);
    expect(Number.isFinite(rLast.loss)).toBe(true);
  });

  it("Phase 2 mask: out-of-range classes get zero gradient and zero smoothed mass", () => {
    const priceCents: number[] = [];
    const logPrices: number[] = [];
    for (let i = 0; i < 16; i++) {
      const p = 100 * (i + 1); // $1.00, $2.00, ... $16.00
      priceCents.push(p);
      logPrices.push(Math.log(p));
    }
    const logits = new Float32Array(16);
    for (let i = 0; i < 16; i++) logits[i] = Math.random() - 0.5;
    const target = 7; // $8.00
    const masked = ordinalSmoothedCE(logits, target, logPrices, Math.log(1.15), {
      catalogPrices: priceCents,
      priceRangeCents: { min: 500, max: 1000 }, // [$5, $10]
    });
    // Out-of-range classes (0-3 and 10-15) must have grad ≈ 0 and smoothed ≈ 0.
    for (let i = 0; i < 16; i++) {
      const inRange = priceCents[i] >= 500 && priceCents[i] <= 1000;
      if (!inRange) {
        expect(Math.abs(masked.grad[i])).toBeLessThan(1e-9);
        expect(masked.smoothed[i]).toBe(0);
      }
    }
    // Smoothed sums to 1 within the in-range slice.
    let smoothedSum = 0;
    for (let i = 0; i < 16; i++) smoothedSum += masked.smoothed[i];
    expect(smoothedSum).toBeCloseTo(1, 5);
  });

  it("Phase 2 mask: degenerate (target out of range) falls through to unmasked", () => {
    const priceCents = [100, 200, 300, 400, 500];
    const logPrices = priceCents.map((p) => Math.log(p));
    const logits = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const target = 4; // $5.00
    // Bound that doesn't include $5.00.
    const masked = ordinalSmoothedCE(logits, target, logPrices, Math.log(1.15), {
      catalogPrices: priceCents,
      priceRangeCents: { min: 100, max: 300 },
    });
    const unmasked = ordinalSmoothedCE(logits, target, logPrices, Math.log(1.15));
    // Should be identical when the mask falls through.
    for (let i = 0; i < 5; i++) {
      expect(masked.smoothed[i]).toBeCloseTo(unmasked.smoothed[i], 5);
      expect(masked.grad[i]).toBeCloseTo(unmasked.grad[i], 5);
    }
  });

  it("Phase 2 mask: when not provided, behaviour is bit-identical to pre-Phase-2", () => {
    const priceCents = [100, 200, 300, 400];
    const logPrices = priceCents.map((p) => Math.log(p));
    const logits = new Float32Array([0.5, -0.2, 0.7, -0.4]);
    const target = 1;
    const a = ordinalSmoothedCE(logits, target, logPrices, Math.log(1.15));
    const b = ordinalSmoothedCE(logits, target, logPrices, Math.log(1.15), undefined);
    for (let i = 0; i < 4; i++) {
      expect(a.smoothed[i]).toBe(b.smoothed[i]);
      expect(a.grad[i]).toBe(b.grad[i]);
    }
    expect(a.loss).toBe(b.loss);
  });
});

describe("sigmoidBCE", () => {
  it("matches numerical gradient", () => {
    for (const t of [0, 1] as const) {
      for (const x of [-2.0, -0.5, 0.0, 0.7, 3.1]) {
        const { grad } = sigmoidBCE(x, t);
        const num = (sigmoidBCE(x + EPS, t).loss - sigmoidBCE(x - EPS, t).loss) / (2 * EPS);
        expect(Math.abs(num - grad)).toBeLessThan(1e-3);
      }
    }
  });

  it("loss is non-negative", () => {
    expect(sigmoidBCE(0, 1).loss).toBeGreaterThan(0);
    expect(sigmoidBCE(10, 1).loss).toBeGreaterThanOrEqual(0);
  });
});

describe("pairwiseMarginLoss (Phase 3c)", () => {
  it("returns zero on a satisfied margin", () => {
    // scoreCorrect beats scoreIncorrect by more than the margin.
    const { loss, dCorrect, dIncorrect } = pairwiseMarginLoss(2.0, 1.0, 0.5);
    expect(loss).toBe(0);
    expect(dCorrect).toBe(0);
    expect(dIncorrect).toBe(0);
  });

  it("returns the margin gap on a violated margin", () => {
    // scoreCorrect equals scoreIncorrect; full margin is the loss.
    const { loss, dCorrect, dIncorrect } = pairwiseMarginLoss(0, 0, 0.5);
    expect(loss).toBeCloseTo(0.5, 6);
    expect(dCorrect).toBe(-1);
    expect(dIncorrect).toBe(1);
  });

  it("matches numerical gradient w.r.t. scoreCorrect / scoreIncorrect", () => {
    const margin = 0.5;
    // Cover violated, exactly-on-boundary, and satisfied regions.
    const cases: Array<{ correct: number; wrong: number }> = [
      { correct: 0.0, wrong: 0.0 }, // violated
      { correct: 0.2, wrong: 0.5 }, // violated
      { correct: 1.0, wrong: 0.6 }, // exactly on margin → loss=0
      { correct: 1.5, wrong: 0.7 }, // satisfied
      { correct: -0.4, wrong: 0.3 }, // strongly violated
    ];
    for (const { correct, wrong } of cases) {
      const { loss, dCorrect, dIncorrect } = pairwiseMarginLoss(correct, wrong, margin);
      // Hinge loss is non-differentiable at the kink (loss==0).
      // Skip the numerical check on those corner cases — the
      // analytical gradient is the right-derivative we use.
      if (loss === 0) continue;
      const numCorrect =
        (pairwiseMarginLoss(correct + EPS, wrong, margin).loss
          - pairwiseMarginLoss(correct - EPS, wrong, margin).loss)
        / (2 * EPS);
      const numIncorrect =
        (pairwiseMarginLoss(correct, wrong + EPS, margin).loss
          - pairwiseMarginLoss(correct, wrong - EPS, margin).loss)
        / (2 * EPS);
      expect(Math.abs(numCorrect - dCorrect)).toBeLessThan(1e-3);
      expect(Math.abs(numIncorrect - dIncorrect)).toBeLessThan(1e-3);
    }
  });
});
