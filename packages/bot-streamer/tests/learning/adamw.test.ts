import { describe, expect, it } from "vitest";
import { AdamW } from "../../src/learning/adamw";

const OPTS = {
  lr: 1e-2,
  beta1: 0.9,
  beta2: 0.99,
  eps: 1e-8,
  weightDecay: 1e-3,
  warmupRounds: 10,
  warmupStartLr: 1e-4,
};

describe("AdamW", () => {
  it("warmup interpolates from start lr to target lr linearly", () => {
    const adam = new AdamW(OPTS);
    expect(adam.effectiveLr(0)).toBeCloseTo(OPTS.warmupStartLr, 6);
    expect(adam.effectiveLr(5)).toBeCloseTo(
      OPTS.warmupStartLr + (OPTS.lr - OPTS.warmupStartLr) * 0.5,
      6,
    );
    expect(adam.effectiveLr(10)).toBeCloseTo(OPTS.lr, 6);
    expect(adam.effectiveLr(100)).toBeCloseTo(OPTS.lr, 6);
  });

  it("converges on a 1-d quadratic", () => {
    // f(x) = (x - 3)^2 ; gradient = 2(x-3). Optimal x = 3.
    // Adam can briefly overshoot due to momentum, so we check that the
    // final loss is much lower than the initial loss, not strict monotonicity.
    const adam = new AdamW({ ...OPTS, weightDecay: 0, warmupRounds: 0, lr: 0.1 });
    const params = new Float32Array([0]);
    const grads = new Float32Array(1);
    adam.bind([1]);
    const initialLoss = (params[0] - 3) ** 2;
    for (let step = 0; step < 500; step++) {
      grads[0] = 2 * (params[0] - 3);
      adam.beginStep();
      adam.stepBuffer(0, params, grads);
    }
    const finalLoss = (params[0] - 3) ** 2;
    expect(finalLoss).toBeLessThan(initialLoss * 1e-4);
    expect(Math.abs(params[0] - 3)).toBeLessThan(0.05);
  });

  it("decoupled weight decay shrinks params even with zero gradients", () => {
    const adam = new AdamW({ ...OPTS, warmupRounds: 0, weightDecay: 1.0, lr: 0.5 });
    const params = new Float32Array([1]);
    const grads = new Float32Array([0]);
    adam.bind([1]);
    adam.beginStep();
    adam.stepBuffer(0, params, grads);
    // Step: p ← p − lr·(0/√0+eps + 1.0·p) = 1 − 0.5·1 = 0.5
    expect(params[0]).toBeCloseTo(0.5, 5);
  });

  it("serialise round-trips", () => {
    const a = new AdamW(OPTS);
    a.bind([3, 2]);
    a.beginStep();
    a.stepBuffer(0, new Float32Array([0.1, 0.2, 0.3]), new Float32Array([1, -1, 0.5]));
    const buf = a.serialize();
    const b = AdamW.deserialize(buf, OPTS);
    expect(b.step_count).toBe(a.step_count);
    expect(Array.from(b["moments"][0])).toEqual(Array.from(a["moments"][0]));
    expect(Array.from(b["secondMoments"][0])).toEqual(Array.from(a["secondMoments"][0]));
    expect(Array.from(b["moments"][1])).toEqual(Array.from(a["moments"][1]));
  });
});
