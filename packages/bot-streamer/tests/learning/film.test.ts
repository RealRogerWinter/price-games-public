/**
 * FiLM-block unit tests. The block lives between the trunk's 16-d
 * embedding and `priceClassHead`; the bot-streamer's mood signal
 * conditions γ and β via a tiny `Linear(condDim → 2·embeddingDim)`
 * generator with `tanh`-bounded magnitude.
 *
 * The merge-gate properties this file pins are:
 *   1. **Identity at moodInfluence=0.** `forwardFilm` returns
 *      `filmEmbedding = embedding` bit-equal regardless of cond or
 *      filmGen weights — the inert-by-default invariant.
 *   2. **Identity at zero-init.** Even at moodInfluence=1, a freshly
 *      `createLayer(_, _, "zero")` filmGen produces γ=1, β=0 because
 *      `tanh(0) = 0`.
 *   3. **Bounded modulation.** γ ∈ [0.9, 1.1], β ∈ [-0.1, 0.1] for
 *      *any* filmGen weights at full influence.
 *   4. **Backward consistency.** The hand-rolled `backwardFilm`
 *      matches a numerical Jacobian on a small fixture within 1e-4.
 *      Catches off-by-D bugs in the γ/β split and missing tanh
 *      derivatives — the two most likely places this code rots.
 *   5. **No gradient leaks into cond.** `backwardFilm` doesn't
 *      return a `dCond` channel; the function signature itself is
 *      the test of "mood is bot state, not a trainable parameter".
 */

import { describe, expect, it } from "vitest";
import {
  backwardFilm,
  createFilmScratch,
  createLayer,
  forwardFilm,
  forwardLinear,
  type Layer,
} from "../../src/learning/mlp";
import { COND_DIM, EMBEDDING_DIM } from "../../src/learning/types";

/** Mulberry32 — small seeded RNG for reproducible tests. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randVector(rng: () => number, n: number, scale = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * scale;
  return out;
}

function makeFilmGen(rng: () => number, init: "he" | "zero" | "small"): Layer {
  return createLayer(COND_DIM, 2 * EMBEDDING_DIM, init, rng);
}

describe("forwardFilm — identity at scale=0", () => {
  it("returns filmEmbedding bit-equal to embedding regardless of cond / filmGen", () => {
    const rng = mulberry32(42);
    const filmGen = makeFilmGen(rng, "he"); // arbitrary non-zero weights
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM, 5);
    const r = forwardFilm(filmGen, cond, embedding, 0);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      // gamma=1, beta=0 exactly — multiplication is identity, so the
      // returned filmEmbedding must equal input. We `Math.abs` β
      // because IEEE 754 `0 * negative = -0`, which strict `.toBe(0)`
      // (Object.is) treats as different from 0; the *value* is zero.
      expect(r.gamma[i]).toBe(1);
      expect(Math.abs(r.beta[i])).toBe(0);
      expect(r.filmEmbedding[i]).toBe(embedding[i]);
    }
  });
});

describe("forwardFilm — identity at zero-init", () => {
  it("γ=1, β=0 with zero-init filmGen regardless of moodInfluence", () => {
    const rng = mulberry32(7);
    const filmGen = makeFilmGen(rng, "zero"); // W and b all zero
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM, 5);
    for (const scale of [0, 0.25, 0.5, 1]) {
      const r = forwardFilm(filmGen, cond, embedding, scale);
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        expect(r.gamma[i]).toBe(1);            // tanh(0) = 0 → γ = 1
        expect(Math.abs(r.beta[i])).toBe(0);   // tanh(0) = 0 → β = 0 (signed-zero safe)
        expect(r.filmEmbedding[i]).toBe(embedding[i]);
      }
    }
  });
});

describe("forwardFilm — γ/β bounds at full influence", () => {
  it("γ ∈ [0.9, 1.1], β ∈ [-0.1, 0.1] for any weights and cond", () => {
    // Stress-test with high-magnitude filmGen weights and extreme
    // conds — `tanh` is bounded ±1 so γ/β must stay in their
    // documented envelopes regardless of how wild the raw output
    // gets.
    const rng = mulberry32(123);
    // Manually inflate filmGen.W so raw output is large.
    const filmGen = makeFilmGen(rng, "he");
    for (let i = 0; i < filmGen.W.length; i++) filmGen.W[i] *= 50;
    for (let i = 0; i < filmGen.b.length; i++) filmGen.b[i] = (rng() * 2 - 1) * 50;
    for (let trial = 0; trial < 20; trial++) {
      const cond = randVector(rng, COND_DIM, 5);
      const embedding = randVector(rng, EMBEDDING_DIM, 5);
      const r = forwardFilm(filmGen, cond, embedding, 1);
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        expect(r.gamma[i]).toBeGreaterThanOrEqual(0.9 - 1e-7);
        expect(r.gamma[i]).toBeLessThanOrEqual(1.1 + 1e-7);
        expect(r.beta[i]).toBeGreaterThanOrEqual(-0.1 - 1e-7);
        expect(r.beta[i]).toBeLessThanOrEqual(0.1 + 1e-7);
      }
    }
  });

  it("γ stays in [1 - 0.1·s, 1 + 0.1·s] across the influence ramp", () => {
    const rng = mulberry32(7777);
    const filmGen = makeFilmGen(rng, "he");
    // Saturate raw output so tanh ≈ ±1 — then γ/β land at the bounds.
    for (let i = 0; i < filmGen.W.length; i++) filmGen.W[i] *= 50;
    const cond = randVector(rng, COND_DIM, 3);
    const embedding = randVector(rng, EMBEDDING_DIM, 1);
    for (const scale of [0, 0.25, 0.5, 0.75, 1]) {
      const r = forwardFilm(filmGen, cond, embedding, scale);
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        expect(r.gamma[i]).toBeGreaterThanOrEqual(1 - 0.1 * scale - 1e-6);
        expect(r.gamma[i]).toBeLessThanOrEqual(1 + 0.1 * scale + 1e-6);
        expect(Math.abs(r.beta[i])).toBeLessThanOrEqual(0.1 * scale + 1e-6);
      }
    }
  });
});

describe("forwardFilm — affine application", () => {
  it("filmEmbedding[i] = γ[i] · embedding[i] + β[i]", () => {
    const rng = mulberry32(2026);
    const filmGen = makeFilmGen(rng, "small");
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM, 2);
    const r = forwardFilm(filmGen, cond, embedding, 1);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const expected = r.gamma[i] * embedding[i] + r.beta[i];
      expect(r.filmEmbedding[i]).toBeCloseTo(expected, 6);
    }
  });
});

describe("backwardFilm — numerical Jacobian agreement", () => {
  it("matches finite-difference dW within 1e-4 on a small fixture", () => {
    // Build a deterministic fixture: small dims so the Jacobian is
    // cheap to compute. Use a synthetic upstream gradient and
    // verify that the analytic dW agrees with the finite-difference
    // estimate.
    const rng = mulberry32(0xdeadbeef);
    const filmGen = makeFilmGen(rng, "small");
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM);
    const dFilmEmbedding = randVector(rng, EMBEDDING_DIM);
    const scale = 0.7;

    // Forward + analytic backward.
    const fwd = forwardFilm(filmGen, cond, embedding, scale);
    const bw = backwardFilm(
      filmGen,
      cond,
      embedding,
      fwd.gamma,
      fwd.beta,
      dFilmEmbedding,
      scale,
    );

    // Loss = sum(filmEmbedding · dFilmEmbedding) — chosen so
    // dLoss/dFilmEmbedding = dFilmEmbedding (matches what we
    // pass into backward).
    function lossOf(fg: Layer): number {
      const r = forwardFilm(fg, cond, embedding, scale);
      let s = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) s += r.filmEmbedding[i] * dFilmEmbedding[i];
      return s;
    }

    // Sample a handful of W positions for the FD check — full
    // matrix is 96 entries which is fine, but the test would be
    // slow if we did it on every commit. Spot-check a strided
    // subset to keep CI fast.
    const eps = 1e-3;
    const checkIndices: number[] = [];
    for (let i = 0; i < filmGen.W.length; i += 7) checkIndices.push(i);
    for (const idx of checkIndices) {
      const orig = filmGen.W[idx];
      filmGen.W[idx] = orig + eps;
      const lp = lossOf(filmGen);
      filmGen.W[idx] = orig - eps;
      const lm = lossOf(filmGen);
      filmGen.W[idx] = orig;
      const fdGrad = (lp - lm) / (2 * eps);
      expect(bw.dW[idx]).toBeCloseTo(fdGrad, 4);
    }
    // Also spot-check a few bias entries.
    for (let i = 0; i < filmGen.b.length; i += 5) {
      const orig = filmGen.b[i];
      filmGen.b[i] = orig + eps;
      const lp = lossOf(filmGen);
      filmGen.b[i] = orig - eps;
      const lm = lossOf(filmGen);
      filmGen.b[i] = orig;
      const fdGrad = (lp - lm) / (2 * eps);
      expect(bw.db[i]).toBeCloseTo(fdGrad, 4);
    }
    // And the propagated dEmbedding — these should equal γ.
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const expected = fwd.gamma[i] * dFilmEmbedding[i];
      expect(bw.dEmbedding[i]).toBeCloseTo(expected, 6);
    }
  });
});

describe("backwardFilm — small-`s` Jacobian agreement", () => {
  it("matches finite-difference dW within 1e-4 at scale=0.05", () => {
    // The inverse-tanh derivation is `tγ = (γ - 1) · inv` where
    // `inv = 1 / (0.1·s)`. At small `s` the multiplier `inv` grows
    // — at s=0.05, inv=200; γ stays near 1 so `(γ-1)` is tiny and
    // float roundoff on the recovered `tγ` is the concern. The
    // Jacobian point at s=0.05 confirms numerical stability inside
    // the persona-loader's validated [0, 1] range without going so
    // small that the inverse mapping degenerates (caller-side
    // `s === 0` short-circuit covers the fully-degenerate regime
    // separately).
    const rng = mulberry32(0xfaad);
    const filmGen = makeFilmGen(rng, "small");
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM);
    const dFilmEmbedding = randVector(rng, EMBEDDING_DIM);
    const scale = 0.05;
    const fwd = forwardFilm(filmGen, cond, embedding, scale);
    const bw = backwardFilm(
      filmGen,
      cond,
      embedding,
      fwd.gamma,
      fwd.beta,
      dFilmEmbedding,
      scale,
    );
    function lossOf(fg: Layer): number {
      const r = forwardFilm(fg, cond, embedding, scale);
      let s = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) s += r.filmEmbedding[i] * dFilmEmbedding[i];
      return s;
    }
    // Spot-check a strided subset. eps=1e-3 matches the s=0.7
    // test; smaller `s` doesn't shrink the FD step appreciably
    // because the loss-gradient and the eps both scale with `s`.
    // Tolerance bumped to 3-decimal because Float32 rounding on
    // the inverse `(γ-1)·inv` (with `inv` = 200 at s=0.05) costs
    // ~ulp/0.0005 of precision per dim — still well under any
    // operating threshold.
    const eps = 1e-3;
    for (let idx = 0; idx < filmGen.W.length; idx += 7) {
      const orig = filmGen.W[idx];
      filmGen.W[idx] = orig + eps;
      const lp = lossOf(filmGen);
      filmGen.W[idx] = orig - eps;
      const lm = lossOf(filmGen);
      filmGen.W[idx] = orig;
      const fdGrad = (lp - lm) / (2 * eps);
      expect(bw.dW[idx]).toBeCloseTo(fdGrad, 3);
    }
  });
});

describe("forwardFilm — FilmScratch round-trip aliasing", () => {
  it("scratch is safe to reuse: forward → backward → forward → backward over the same buffers", () => {
    // The FilmScratch contract is "caller must not invoke the next
    // forward into the same scratch until backward has consumed γ/β
    // from the previous forward." `WorkerCore.runMinibatchStep`
    // respects this by sequencing forward → backward inside the
    // same loop iteration. Pin the contract here independently of
    // the runner so a future change can't silently break it.
    const rng = mulberry32(0xa11a5);
    const filmGen = makeFilmGen(rng, "small");
    const scratch = createFilmScratch(EMBEDDING_DIM);

    // First forward + backward. Snapshot fwd1.gamma BEFORE the
    // second forward overwrites scratch — the contract under test
    // is "bw1's outputs are owned arrays unaffected by scratch
    // reuse," but the gamma reference inside fwd1 IS the scratch
    // view and DOES become stale after fwd2.
    const cond1 = randVector(rng, COND_DIM);
    const emb1 = randVector(rng, EMBEDDING_DIM);
    const dF1 = randVector(rng, EMBEDDING_DIM);
    const fwd1 = forwardFilm(filmGen, cond1, emb1, 0.5, scratch);
    const gamma1Snapshot = new Float32Array(fwd1.gamma);
    const bw1 = backwardFilm(filmGen, cond1, emb1, fwd1.gamma, fwd1.beta, dF1, 0.5);
    const bw1dEmbeddingSnapshot = new Float32Array(bw1.dEmbedding);

    // Second forward + backward into the SAME scratch.
    const cond2 = randVector(rng, COND_DIM);
    const emb2 = randVector(rng, EMBEDDING_DIM);
    const dF2 = randVector(rng, EMBEDDING_DIM);
    const fwd2 = forwardFilm(filmGen, cond2, emb2, 0.5, scratch);
    const bw2 = backwardFilm(filmGen, cond2, emb2, fwd2.gamma, fwd2.beta, dF2, 0.5);

    // bw1's owned outputs are unchanged by the second pass — the
    // contract. Compare bw1's dEmbedding against the gamma
    // SNAPSHOT (taken before scratch was reused) since bw1's
    // `dEmbedding[i] = γ1[i] * dF1[i]` was computed at first-pass
    // time. This pins that backwardFilm allocates its return
    // values rather than aliasing scratch.
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(bw1.dEmbedding[i]).toBe(bw1dEmbeddingSnapshot[i]);
      expect(bw1.dEmbedding[i]).toBeCloseTo(gamma1Snapshot[i] * dF1[i], 6);
    }
    // bw2 reads the second pass's γ.
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(bw2.dEmbedding[i]).toBeCloseTo(fwd2.gamma[i] * dF2[i], 6);
    }
    // Reference-equality: scratch arrays alias fwd2's view (the
    // second pass wrote into them) — fwd1's view is now stale,
    // exactly as the contract documents. Pinning the aliasing
    // direction here means a future refactor that accidentally
    // copy-on-write the scratch (e.g. with `.slice()`) trips the
    // test.
    expect(fwd2.gamma).toBe(scratch.gamma);
    expect(fwd2.beta).toBe(scratch.beta);
    expect(fwd2.filmEmbedding).toBe(scratch.filmEmbedding);
    expect(fwd2.rawOutput).toBe(scratch.rawOutput);
  });
});

describe("backwardFilm — zero scale produces zero filmGen gradient", () => {
  it("at scale=0, dW and db are all zero (no learning when inert)", () => {
    const rng = mulberry32(91011);
    const filmGen = makeFilmGen(rng, "he");
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM);
    const dFilmEmbedding = randVector(rng, EMBEDDING_DIM);
    const fwd = forwardFilm(filmGen, cond, embedding, 0);
    const bw = backwardFilm(
      filmGen,
      cond,
      embedding,
      fwd.gamma,
      fwd.beta,
      dFilmEmbedding,
      0,
    );
    for (let i = 0; i < bw.dW.length; i++) expect(bw.dW[i]).toBe(0);
    for (let i = 0; i < bw.db.length; i++) expect(bw.db[i]).toBe(0);
    // dEmbedding at scale=0 short-circuits to a fresh zero buffer
    // (caller is supposed to skip backward at scale=0 anyway, and
    // the inverse-mapping derivation would NaN). Asserting dEmbedding
    // is identically zero is the right contract — if a future
    // refactor accidentally calls backwardFilm at scale=0 it now
    // fails closed (no gradient contribution) instead of injecting
    // arbitrary numbers into the trunk's backward.
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(bw.dEmbedding[i]).toBe(0);
    }
  });
});

describe("backwardFilm — does not propagate gradient into cond", () => {
  it("function signature returns only dW, db, dEmbedding (no dCond)", () => {
    // This is a structural assertion baked into the type system —
    // mood is not a trainable parameter, so the function signature
    // does not expose a dCond return. If a future refactor adds it,
    // this test fails to compile, which is the goal: a stop_gradient
    // contract enforced at the type boundary.
    const rng = mulberry32(1);
    const filmGen = makeFilmGen(rng, "small");
    const cond = randVector(rng, COND_DIM);
    const embedding = randVector(rng, EMBEDDING_DIM);
    const dFilmEmbedding = randVector(rng, EMBEDDING_DIM);
    const fwd = forwardFilm(filmGen, cond, embedding, 0.5);
    const bw = backwardFilm(filmGen, cond, embedding, fwd.gamma, fwd.beta, dFilmEmbedding, 0.5);
    // Only the three documented channels are present.
    expect(Object.keys(bw).sort()).toEqual(["dEmbedding", "dW", "db"]);
  });
});

describe("forwardFilm — outDim invariant", () => {
  it("throws when filmGen.outDim != 2 * embeddingDim", () => {
    const wrong: Layer = {
      inDim: COND_DIM,
      outDim: EMBEDDING_DIM, // wrong — should be 2·EMBEDDING_DIM
      W: new Float32Array(EMBEDDING_DIM * COND_DIM),
      b: new Float32Array(EMBEDDING_DIM),
    };
    const cond = new Float32Array(COND_DIM);
    const embedding = new Float32Array(EMBEDDING_DIM);
    expect(() => forwardFilm(wrong, cond, embedding, 1)).toThrow();
  });
});

describe("forwardLinear smoke — used by FiLM", () => {
  it("forwardLinear is unchanged (regression check for dim assertion)", () => {
    const layer = createLayer(COND_DIM, 2 * EMBEDDING_DIM, "small");
    const x = new Float32Array(COND_DIM);
    const y = forwardLinear(layer, x);
    expect(y.length).toBe(2 * EMBEDDING_DIM);
  });
});
