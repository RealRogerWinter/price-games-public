/**
 * Phase 3e.1 — regression guards on the four optimizer-unblock
 * constants that landed together in a single bundled deploy.
 *
 * These tests aren't exhaustive behavioural tests (the existing K&G,
 * AdamW, and snapshot-gate suites cover behaviour); they're pure
 * regression locks against silent reversion. The four values were
 * chosen jointly by the 3-reviewer NN debate, and ship to prod
 * directly without a sandbox soak — re-introducing the old values
 * by accident in a future PR would silently lock the optimiser back
 * into clip-saturated sign-SGD.
 */
import { describe, expect, it } from "vitest";
import { MAX_GRAD_NORM, withDefaults } from "../../src/learning/workerCore";
import { clipGradientsInPlace } from "../../src/learning/mlp";
import {
  FIXED_PHASE_ROUNDS,
  FIXED_TASK_WEIGHTS,
  TASK_INDEX,
} from "../../src/learning/uncertaintyWeighting";

describe("Phase 3e.1 — optimizer-unblock constants", () => {
  it("MAX_GRAD_NORM is 3.0 (Phase 3e.1: was 0.3)", () => {
    // The 0.3 ceiling was binding on 100% of post-reset minibatch
    // steps — every Adam update was reduced to a fixed-magnitude
    // sign vector. 3.0 lets healthy steps pass with calibrated Adam
    // magnitude; the goldenEval regression gate (SNAPSHOT_MAE_REGRESSION_FACTOR
    // 1.2× from Phase 3e.0) is the safety net that catches divergence.
    expect(MAX_GRAD_NORM).toBe(3.0);
  });

  it("AdamW weightDecay default is 0 (Phase 3e.1: was 1e-4)", () => {
    // With Phase 3d.1's tight clip 0.3 binding on every step, WD's
    // deterministic shrink became larger than the clipped-grad
    // signal on heads with chronic clip saturation, producing slow
    // drift toward zero. The 0 default isolates the optimiser-unblock
    // signal during the prod deploy. Restore to 1e-5 once 3e.1's
    // clip relaxation has stabilised in prod for 24h+.
    expect(withDefaults().adamw.weightDecay).toBe(0);
  });

  it("FIXED_PHASE_ROUNDS is 500 (Phase 3e.1: was 3000)", () => {
    // Pre-3e.1 the 3000-round phase had never finished in any
    // production model lineage — every architectural PR wiped before
    // round 3000, so K&G uncertainty weighting was effectively dead
    // code. 500 lets K&G activate within hours at the prod 130-150
    // rounds/hr cadence; per-task MIN_TASK_OBSERVATIONS=100 still
    // gates per-head activation independently.
    expect(FIXED_PHASE_ROUNDS).toBe(500);
  });

  it("FIXED_TASK_WEIGHTS[priceClass] is 0.4 (Phase 3e.1: was 1.0)", () => {
    // priceClass demoted to free trunk gradient for the heads modes
    // actually consume (pair / squashedReg / pinballQ40). Head stays
    // in the network — UI / bidding centerpoint / comparison fallback
    // all still read its argmax — but its gradient share drops from
    // ~50-65% of trunk mass to ~25-30%.
    expect(FIXED_TASK_WEIGHTS[TASK_INDEX.priceClass]).toBe(0.4);
  });

  it("other FIXED_TASK_WEIGHTS untouched (regression guard against accidental re-rebalance)", () => {
    // Phase 3e.1 changes priceClass alone. If a future PR meant to
    // retune e.g. squashedReg this test surfaces the choice instead
    // of letting it slip in alongside an unrelated change.
    expect(FIXED_TASK_WEIGHTS[TASK_INDEX.pairLogit]).toBe(1.0);
    expect(FIXED_TASK_WEIGHTS[TASK_INDEX.squashedReg]).toBe(1.0);
    expect(FIXED_TASK_WEIGHTS[TASK_INDEX.pinballQ40]).toBe(0.3);
    expect(FIXED_TASK_WEIGHTS[TASK_INDEX.logPrice]).toBe(0.1);
  });

  it("clip-semantics: a 200-norm grad clips to MAX_GRAD_NORM, not the old 0.3 ceiling", () => {
    // Behavioural test that ties MAX_GRAD_NORM to the actual post-clip
    // path. The 5 constant locks above guard against silent literal
    // edits, but a future PR could revert MAX_GRAD_NORM AND the
    // regression lock together. This test catches that case by
    // exercising clipGradientsInPlace directly: a synthetic 200-norm
    // gradient post-clip should land at exactly MAX_GRAD_NORM (=3.0
    // in 3e.1), not at the pre-3e.1 0.3 ceiling.
    const a = new Float32Array([200, 0, 0]);
    const norm = clipGradientsInPlace([a], MAX_GRAD_NORM);
    expect(norm).toBeCloseTo(200, 4);
    expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(3.0, 4);
    // Sanity: a much-smaller norm passes through unclipped.
    const b = new Float32Array([1, 1, 1]); // L2 ≈ 1.732, < 3.0
    const bNorm = clipGradientsInPlace([b], MAX_GRAD_NORM);
    expect(bNorm).toBeCloseTo(Math.sqrt(3), 4);
    expect(b[0]).toBe(1); // unchanged
  });
});
