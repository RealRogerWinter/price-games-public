/**
 * Phase 3e.2 — regression guards on the architecture changes that
 * landed together. These tests aren't exhaustive (the existing
 * mlp / archHash / warmStart suites cover the behavioural contracts);
 * they're locks against silent reversion of the deliberate-wipe PR's
 * spec.
 */
import { describe, expect, it } from "vitest";
import {
  COND_DIM,
  EMBEDDING_DIM,
  HEAD_TOPOLOGY_VERSION,
  MODEL_SPEC,
  PAIR_LOGIT_SCALAR_FEATURES,
} from "../../src/learning/types";
import { archHash } from "../../src/learning/archHash";
import { createNetwork, pairLogitScalarFeatures } from "../../src/learning/mlp";

describe("Phase 3e.2 — architecture constants", () => {
  it("COND_DIM is 3 (Phase 3e.2: was 6)", () => {
    expect(COND_DIM).toBe(3);
    expect(MODEL_SPEC.condDim).toBe(3);
  });

  it("HEAD_TOPOLOGY_VERSION is 3 (Phase 3e.2: was 2)", () => {
    expect(HEAD_TOPOLOGY_VERSION).toBe(3);
    expect(MODEL_SPEC.headTopologyVersion).toBe(3);
  });

  it("PAIR_LOGIT_SCALAR_FEATURES is 3 (logA, logB, logRatio)", () => {
    expect(PAIR_LOGIT_SCALAR_FEATURES).toBe(3);
  });

  it("pairLogitHead input dim is 2*embeddingDim + PAIR_LOGIT_SCALAR_FEATURES", () => {
    const rng = () => 0.5;
    const net = createNetwork(rng);
    expect(net.pairLogitHead.inDim).toBe(2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES);
    expect(net.pairLogitHead.outDim).toBe(1);
  });

  it("filmGen input dim follows COND_DIM (Phase 3e.2: 3 not 6)", () => {
    const rng = () => 0.5;
    const net = createNetwork(rng);
    expect(net.filmGen.inDim).toBe(COND_DIM);
    expect(net.filmGen.outDim).toBe(2 * EMBEDDING_DIM);
  });

  it("archHash differs from a synthetic v2-shaped spec (each field's contribution locked)", () => {
    // Forces an archHash bump on this PR — the surviving on-disk
    // snapshot from 3e.1 must auto-archive when 3e.2 boots. We lock
    // EACH spec field's individual contribution to the hash so a
    // future refactor that accidentally collapses both back together
    // (e.g. both end up at 6 or both end up at 3) is still caught
    // — this assertion would still pass under that scenario, but
    // the per-field assertions below would not.
    const v2Like = {
      ...MODEL_SPEC,
      condDim: 6,
      headTopologyVersion: 2,
    };
    expect(archHash(MODEL_SPEC)).not.toBe(archHash(v2Like));
    // Each field changing in isolation must also bump the hash.
    expect(archHash(MODEL_SPEC)).not.toBe(archHash({ ...MODEL_SPEC, condDim: 6 }));
    expect(archHash(MODEL_SPEC)).not.toBe(archHash({ ...MODEL_SPEC, headTopologyVersion: 2 }));
    // And a featureDim drift would have to bump too — the warm-start
    // prefix-copy assumes featureDim stability.
    expect(archHash(MODEL_SPEC)).not.toBe(archHash({ ...MODEL_SPEC, featureDim: 124 }));
  });
});

describe("Phase 3e.2 — pairLogitScalarFeatures helper", () => {
  it("returns [logA/1000, logB/1000, log(A/B)] for finite positive prices", () => {
    const [logA, logB, logRatio] = pairLogitScalarFeatures(2000, 1000);
    expect(logA).toBeCloseTo(Math.log(2), 6); // log(2000/1000) = log 2
    expect(logB).toBeCloseTo(Math.log(1), 6); // log(1000/1000) = 0
    expect(logRatio).toBeCloseTo(Math.log(2), 6); // log(2000/1000)
  });

  it("floors degenerate inputs at 1¢ to keep log finite", () => {
    // Non-finite or non-positive prices fall back to 1, producing
    // log(1/1000) = log(0.001) ≈ -6.9. The output is finite, so
    // the head receives a defined input even when priceClass yields
    // garbage.
    const [a1, b1, r1] = pairLogitScalarFeatures(NaN, 1000);
    expect(Number.isFinite(a1)).toBe(true);
    expect(b1).toBeCloseTo(0, 6);
    expect(Number.isFinite(r1)).toBe(true);

    const [a2, b2, r2] = pairLogitScalarFeatures(0, -50);
    expect(Number.isFinite(a2)).toBe(true);
    expect(Number.isFinite(b2)).toBe(true);
    expect(r2).toBeCloseTo(0, 6); // log(1/1) = 0
  });

  it("logRatio is the direct anchor for the binary comparison decision", () => {
    // The third feature is exactly log(priceA / priceB) — the head's
    // single most informative input for "is A more expensive than B".
    // Magnitude scales with the price gap and sign tracks the answer.
    const [, , rPos] = pairLogitScalarFeatures(5000, 100);
    const [, , rNeg] = pairLogitScalarFeatures(100, 5000);
    expect(rPos).toBeGreaterThan(0);
    expect(rNeg).toBeLessThan(0);
    expect(rPos).toBeCloseTo(-rNeg, 6);
  });
});
