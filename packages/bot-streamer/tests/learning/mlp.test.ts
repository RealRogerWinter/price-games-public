import { describe, expect, it } from "vitest";
import {
  applyReluMaskInPlace,
  backwardLinear,
  backwardLogPrice,
  backwardPairLogit,
  backwardSquashedReg,
  checkFinite,
  clipGradientsInPlace,
  createLayer,
  createNetwork,
  flattenParams,
  forwardLinear,
  forwardLogPrice,
  forwardPairLogit,
  forwardSquashedReg,
  forwardTrunk,
  iterParamBuffers,
  LOG_PRICE_LOG_VAR_MAX,
  LOG_PRICE_LOG_VAR_MIN,
  loadFlatParams,
  paramCount,
  reluInPlace,
  reluMask,
} from "../../src/learning/mlp";
import {
  COND_DIM,
  EMBEDDING_DIM,
  FEATURE_DIM,
  PAIR_LOGIT_SCALAR_FEATURES,
  PRICE_CLASS_K,
  TRUNK_HIDDEN_DIM,
} from "../../src/learning/types";

/** Mulberry32 — tiny seeded RNG for reproducible tests. */
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

describe("createLayer", () => {
  it("produces He-scaled weights", () => {
    const rng = mulberry32(42);
    const layer = createLayer(100, 32, "he", rng);
    expect(layer.W.length).toBe(100 * 32);
    expect(layer.b.length).toBe(32);
    let mean = 0;
    let varSum = 0;
    for (let i = 0; i < layer.W.length; i++) mean += layer.W[i];
    mean /= layer.W.length;
    for (let i = 0; i < layer.W.length; i++) varSum += (layer.W[i] - mean) ** 2;
    const variance = varSum / layer.W.length;
    // He init for n=100: stddev = sqrt(2/100) ≈ 0.141; var ≈ 0.02. Allow ±50%.
    expect(variance).toBeGreaterThan(0.005);
    expect(variance).toBeLessThan(0.05);
  });

  it("produces scaled-id weights when shapes match", () => {
    const rng = mulberry32(1);
    const layer = createLayer(4, 4, "scaled-id", rng);
    expect(layer.W[0]).toBeGreaterThan(0.4); // diag ~ 0.5
    expect(layer.W[0]).toBeLessThan(0.6);
    expect(Math.abs(layer.W[1])).toBeLessThan(0.05); // off-diag near 0
  });

  it("zero init leaves W all zero", () => {
    const layer = createLayer(8, 4, "zero");
    for (let i = 0; i < layer.W.length; i++) expect(layer.W[i]).toBe(0);
  });
});

describe("createNetwork", () => {
  it("matches the documented param count", () => {
    const rng = mulberry32(7);
    const net = createNetwork(rng);
    // Phase-3e.2 network (HEAD_TOPOLOGY_VERSION 3):
    //   trunk:           FEATURE_DIM*TRUNK + TRUNK + TRUNK*EMB + EMB
    //   priceClassHead:  EMB*K + K
    //   filmGen:         COND_DIM*(2·EMB) + 2·EMB    (COND_DIM 6 → 3)
    //   logPriceHead:    EMB*2 + 2
    //   pairLogitHead:   (2·EMB + PAIR_LOGIT_SCALAR_FEATURES)*1 + 1
    //                                                 (input 32 → 35)
    //   squashedRegHead: EMB*1 + 1
    //   pinballQ40Head:  EMB*1 + 1
    const expected =
      FEATURE_DIM * TRUNK_HIDDEN_DIM + TRUNK_HIDDEN_DIM
      + TRUNK_HIDDEN_DIM * EMBEDDING_DIM + EMBEDDING_DIM
      + EMBEDDING_DIM * PRICE_CLASS_K + PRICE_CLASS_K
      + COND_DIM * (2 * EMBEDDING_DIM) + 2 * EMBEDDING_DIM
      + EMBEDDING_DIM * 2 + 2
      + (2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES) * 1 + 1
      + EMBEDDING_DIM * 1 + 1
      + EMBEDDING_DIM * 1 + 1;
    expect(paramCount(net)).toBe(expected);
  });
});

describe("forwardLinear", () => {
  it("computes Wx+b correctly", () => {
    const layer = createLayer(3, 2, "zero");
    layer.W.set([1, 2, 3, 4, 5, 6]); // row 0: [1,2,3], row 1: [4,5,6]
    layer.b.set([0.5, -0.5]);
    const x = new Float32Array([1, 2, 3]);
    const y = forwardLinear(layer, x);
    expect(y[0]).toBeCloseTo(1 + 4 + 9 + 0.5, 5);
    expect(y[1]).toBeCloseTo(4 + 10 + 18 - 0.5, 5);
  });

  it("rejects dim mismatch", () => {
    const layer = createLayer(3, 2, "zero");
    expect(() => forwardLinear(layer, new Float32Array(5))).toThrow();
  });
});

describe("ReLU helpers", () => {
  it("reluInPlace zeros negatives", () => {
    const x = new Float32Array([-1, 0, 0.5, 2]);
    reluInPlace(x);
    expect(Array.from(x)).toEqual([0, 0, 0.5, 2]);
  });

  it("reluMask is 1 only for strictly positive", () => {
    const x = new Float32Array([-1, 0, 0.5, 2]);
    const m = reluMask(x);
    expect(Array.from(m)).toEqual([0, 0, 1, 1]);
  });
});

describe("backwardLinear (numerical gradient check)", () => {
  it("matches finite differences for W and b", () => {
    const rng = mulberry32(13);
    const layer = createLayer(4, 3, "he", rng);
    const x = new Float32Array([0.3, -0.7, 0.1, 0.5]);
    const dy = new Float32Array([0.5, -0.2, 0.8]);
    const { dW, db } = backwardLinear(layer, x, dy);

    // Numerical gradient via finite differences on (dy · forward(x)).
    function loss(): number {
      const y = forwardLinear(layer, x);
      let s = 0;
      for (let i = 0; i < y.length; i++) s += dy[i] * y[i];
      return s;
    }
    const eps = 1e-3;
    for (let o = 0; o < layer.outDim; o++) {
      for (let i = 0; i < layer.inDim; i++) {
        const idx = o * layer.inDim + i;
        const orig = layer.W[idx];
        layer.W[idx] = orig + eps;
        const lp = loss();
        layer.W[idx] = orig - eps;
        const lm = loss();
        layer.W[idx] = orig;
        const num = (lp - lm) / (2 * eps);
        expect(Math.abs(num - dW[idx])).toBeLessThan(1e-3);
      }
    }
    for (let o = 0; o < layer.outDim; o++) {
      const orig = layer.b[o];
      layer.b[o] = orig + eps;
      const lp = loss();
      layer.b[o] = orig - eps;
      const lm = loss();
      layer.b[o] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - db[o])).toBeLessThan(1e-3);
    }
  });

  it("propagates dx correctly", () => {
    const rng = mulberry32(19);
    const layer = createLayer(3, 2, "he", rng);
    const x = new Float32Array([0.2, -0.5, 0.3]);
    const dy = new Float32Array([0.7, -0.3]);
    const { dx } = backwardLinear(layer, x, dy);
    function loss(): number {
      const y = forwardLinear(layer, x);
      return dy[0] * y[0] + dy[1] * y[1];
    }
    const eps = 1e-3;
    for (let i = 0; i < x.length; i++) {
      const orig = x[i];
      x[i] = orig + eps;
      const lp = loss();
      x[i] = orig - eps;
      const lm = loss();
      x[i] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - dx[i])).toBeLessThan(1e-3);
    }
  });
});

describe("forwardTrunk", () => {
  it("returns the right shapes", () => {
    const rng = mulberry32(5);
    const net = createNetwork(rng);
    const x = new Float32Array(FEATURE_DIM);
    for (let i = 0; i < x.length; i++) x[i] = (i % 7) * 0.05;
    const a = forwardTrunk(net, x);
    expect(a.hiddenLinear.length).toBe(TRUNK_HIDDEN_DIM);
    expect(a.hidden.length).toBe(TRUNK_HIDDEN_DIM);
    expect(a.embedding.length).toBe(EMBEDDING_DIM);
    // Hidden activation is non-negative after ReLU.
    for (let i = 0; i < a.hidden.length; i++) expect(a.hidden[i]).toBeGreaterThanOrEqual(0);
  });
});

describe("clipGradientsInPlace", () => {
  it("returns the original norm and scales when norm > maxNorm", () => {
    const a = new Float32Array([3, 4]); // norm 5
    const b = new Float32Array([0, 0]);
    const norm = clipGradientsInPlace([a, b], 1);
    expect(norm).toBeCloseTo(5, 5);
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(1, 5);
  });

  it("does not scale when norm <= maxNorm", () => {
    const a = new Float32Array([0.3, 0.4]); // norm 0.5
    const norm = clipGradientsInPlace([a], 1);
    expect(norm).toBeCloseTo(0.5, 5);
    expect(a[0]).toBeCloseTo(0.3, 5);
    expect(a[1]).toBeCloseTo(0.4, 5);
  });
});

describe("checkFinite", () => {
  it("flags NaN", () => {
    const a = new Float32Array([0.1, NaN, 0.3]);
    expect(checkFinite(a)).toBe(false);
  });
  it("flags +/- Inf", () => {
    const a = new Float32Array([1, Infinity, 0]);
    expect(checkFinite(a)).toBe(false);
    const b = new Float32Array([1, -Infinity, 0]);
    expect(checkFinite(b)).toBe(false);
  });
  it("ok on finite", () => {
    expect(checkFinite(new Float32Array([0, 0.5, -1.5]))).toBe(true);
  });
});

describe("flatten/load round-trip", () => {
  it("preserves every weight bit", () => {
    const rng = mulberry32(11);
    const net = createNetwork(rng);
    const flat = flattenParams(net);
    // Mutate and reload — every buffer should match the snapshot.
    const snapshot = new Float32Array(flat); // copy
    for (const buf of iterParamBuffers(net)) for (let i = 0; i < buf.length; i++) buf[i] = 0;
    loadFlatParams(net, snapshot);
    const flat2 = flattenParams(net);
    expect(flat2.length).toBe(flat.length);
    for (let i = 0; i < flat.length; i++) expect(flat2[i]).toBe(flat[i]);
  });
});

describe("applyReluMaskInPlace", () => {
  it("zeros gradients where mask is zero", () => {
    const dx = new Float32Array([0.5, 0.5, 0.5]);
    const m = new Float32Array([1, 0, 1]);
    applyReluMaskInPlace(dx, m);
    expect(Array.from(dx)).toEqual([0.5, 0, 0.5]);
  });
});

describe("forwardLogPrice", () => {
  it("returns mu, logVar, and a clamp signal", () => {
    const rng = mulberry32(31);
    const net = createNetwork(rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < emb.length; i++) emb[i] = (i % 5) * 0.05;
    const out = forwardLogPrice(net.logPriceHead, emb);
    expect(Number.isFinite(out.mu)).toBe(true);
    expect(out.logVar).toBeGreaterThanOrEqual(LOG_PRICE_LOG_VAR_MIN);
    expect(out.logVar).toBeLessThanOrEqual(LOG_PRICE_LOG_VAR_MAX);
  });

  it("clamps log σ² when raw output is out of range", () => {
    const head = createLayer(EMBEDDING_DIM, 2, "zero");
    head.b[1] = LOG_PRICE_LOG_VAR_MAX + 100; // huge bias on log σ²
    const emb = new Float32Array(EMBEDDING_DIM);
    const out = forwardLogPrice(head, emb);
    expect(out.logVar).toBe(LOG_PRICE_LOG_VAR_MAX);
    expect(out.logVarClamped).toBe(true);
  });

  it("rejects wrong head shape", () => {
    const headWrong = createLayer(EMBEDDING_DIM, 3, "zero");
    expect(() => forwardLogPrice(headWrong, new Float32Array(EMBEDDING_DIM))).toThrow();
  });
});

describe("forwardPairLogit", () => {
  it("returns a scalar logit + concat with 3 trailing scalar features (Phase 3e.2)", () => {
    const rng = mulberry32(41);
    const net = createNetwork(rng);
    const embA = new Float32Array(EMBEDDING_DIM);
    const embB = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      embA[i] = (i % 4) * 0.1;
      embB[i] = (i % 5) * -0.05;
    }
    const scalars: [number, number, number] = [0.5, -0.5, 1.0];
    const out = forwardPairLogit(net.pairLogitHead, embA, embB, scalars);
    expect(Number.isFinite(out.logit)).toBe(true);
    expect(out.concat.length).toBe(2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES);
    expect(Array.from(out.concat.subarray(0, EMBEDDING_DIM))).toEqual(Array.from(embA));
    expect(Array.from(out.concat.subarray(EMBEDDING_DIM, 2 * EMBEDDING_DIM))).toEqual(
      Array.from(embB),
    );
    expect(Array.from(out.concat.subarray(2 * EMBEDDING_DIM))).toEqual(scalars);
  });

  it("rejects shape mismatches", () => {
    const head = createLayer(2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES, 1, "small");
    const headWrong = createLayer(2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES, 2, "small");
    const embA = new Float32Array(EMBEDDING_DIM);
    const embB = new Float32Array(EMBEDDING_DIM - 1);
    const scalars: [number, number, number] = [0, 0, 0];
    expect(() =>
      forwardPairLogit(headWrong, embA, new Float32Array(EMBEDDING_DIM), scalars),
    ).toThrow();
    expect(() => forwardPairLogit(head, embA, embB, scalars)).toThrow();
    // Wrong scalar features length.
    expect(() =>
      forwardPairLogit(head, embA, new Float32Array(EMBEDDING_DIM), [1, 2] as unknown as [number, number, number]),
    ).toThrow();
  });
});

describe("backwardPairLogit (numerical gradient check)", () => {
  it("matches finite differences for W, b, dEmbA, dEmbB (scalar gradients are stop-gradient)", () => {
    const rng = mulberry32(43);
    const head = createLayer(2 * EMBEDDING_DIM + PAIR_LOGIT_SCALAR_FEATURES, 1, "small", rng);
    const embA = new Float32Array(EMBEDDING_DIM);
    const embB = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      embA[i] = ((i * 13) % 17) * 0.04 - 0.3;
      embB[i] = ((i * 11) % 19) * 0.05 + 0.1;
    }
    const scalars: [number, number, number] = [0.7, -0.3, 0.4];
    const dLogit = 0.6;
    const { concat } = forwardPairLogit(head, embA, embB, scalars);
    const { dW, db, dEmbA, dEmbB } = backwardPairLogit(head, concat, dLogit);

    function loss(): number {
      const out = forwardPairLogit(head, embA, embB, scalars);
      return dLogit * out.logit;
    }
    const eps = 1e-3;
    for (let o = 0; o < head.outDim; o++) {
      for (let i = 0; i < head.inDim; i++) {
        const idx = o * head.inDim + i;
        const orig = head.W[idx];
        head.W[idx] = orig + eps;
        const lp = loss();
        head.W[idx] = orig - eps;
        const lm = loss();
        head.W[idx] = orig;
        const num = (lp - lm) / (2 * eps);
        expect(Math.abs(num - dW[idx])).toBeLessThan(1e-3);
      }
    }
    for (let o = 0; o < head.outDim; o++) {
      const orig = head.b[o];
      head.b[o] = orig + eps;
      const lp = loss();
      head.b[o] = orig - eps;
      const lm = loss();
      head.b[o] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - db[o])).toBeLessThan(1e-3);
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const origA = embA[i];
      embA[i] = origA + eps;
      const lpA = loss();
      embA[i] = origA - eps;
      const lmA = loss();
      embA[i] = origA;
      const numA = (lpA - lmA) / (2 * eps);
      expect(Math.abs(numA - dEmbA[i])).toBeLessThan(1e-3);

      const origB = embB[i];
      embB[i] = origB + eps;
      const lpB = loss();
      embB[i] = origB - eps;
      const lmB = loss();
      embB[i] = origB;
      const numB = (lpB - lmB) / (2 * eps);
      expect(Math.abs(numB - dEmbB[i])).toBeLessThan(1e-3);
    }
  });
});

describe("forwardSquashedReg", () => {
  it("squashes to [min, max] when bounded", () => {
    const head = createLayer(EMBEDDING_DIM, 1, "zero");
    head.b[0] = 100; // huge raw → tanh saturates to ~1 → predicted ≈ max
    const emb = new Float32Array(EMBEDDING_DIM);
    const out = forwardSquashedReg(head, emb, { min: 200, max: 800 });
    expect(out.bounded).toBe(true);
    expect(out.predictedCents).toBeGreaterThan(799);
    expect(out.predictedCents).toBeLessThanOrEqual(800);

    // Negative raw → tanh ≈ -1 → predicted ≈ min.
    head.b[0] = -100;
    const out2 = forwardSquashedReg(head, emb, { min: 200, max: 800 });
    expect(out2.predictedCents).toBeLessThan(201);
    expect(out2.predictedCents).toBeGreaterThanOrEqual(200);

    // Zero raw → tanh = 0 → predicted = midpoint.
    head.b[0] = 0;
    const out3 = forwardSquashedReg(head, emb, { min: 200, max: 800 });
    expect(out3.predictedCents).toBeCloseTo(500, 0);
  });

  it("falls back to exp path when bounds are absent", () => {
    const head = createLayer(EMBEDDING_DIM, 1, "zero");
    head.b[0] = Math.log(50); // exp = 50, exp*100 = 5000
    const emb = new Float32Array(EMBEDDING_DIM);
    const out = forwardSquashedReg(head, emb);
    expect(out.bounded).toBe(false);
    expect(out.predictedCents).toBeCloseTo(5000, 0);
  });

  it("clamps the unbounded path to [1, 1_000_000] cents", () => {
    const head = createLayer(EMBEDDING_DIM, 1, "zero");
    head.b[0] = 100; // exp ≈ huge
    const emb = new Float32Array(EMBEDDING_DIM);
    const out = forwardSquashedReg(head, emb);
    expect(out.predictedCents).toBe(1_000_000);
  });
});

describe("backwardSquashedReg (numerical gradient check)", () => {
  it("matches finite differences on the bounded path", () => {
    const rng = mulberry32(53);
    const head = createLayer(EMBEDDING_DIM, 1, "small", rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] = ((i * 17) % 23) * 0.04 - 0.2;
    const bounds = { min: 100, max: 2000 };
    const dPred = 0.4;
    const fwd = forwardSquashedReg(head, emb, bounds);
    const { dW, db, dEmb } = backwardSquashedReg(head, emb, fwd.raw, dPred, bounds);

    function loss(): number {
      const f = forwardSquashedReg(head, emb, bounds);
      return dPred * f.predictedCents;
    }
    const eps = 1e-3;
    for (let o = 0; o < head.outDim; o++) {
      for (let i = 0; i < head.inDim; i++) {
        const idx = o * head.inDim + i;
        const orig = head.W[idx];
        head.W[idx] = orig + eps;
        const lp = loss();
        head.W[idx] = orig - eps;
        const lm = loss();
        head.W[idx] = orig;
        const num = (lp - lm) / (2 * eps);
        expect(Math.abs(num - dW[idx])).toBeLessThan(1e-2);
      }
    }
    for (let o = 0; o < head.outDim; o++) {
      const orig = head.b[o];
      head.b[o] = orig + eps;
      const lp = loss();
      head.b[o] = orig - eps;
      const lm = loss();
      head.b[o] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - db[o])).toBeLessThan(1e-2);
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      const orig = emb[i];
      emb[i] = orig + eps;
      const lp = loss();
      emb[i] = orig - eps;
      const lm = loss();
      emb[i] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - dEmb[i])).toBeLessThan(1e-2);
    }
  });

  it("matches finite differences on the unbounded path", () => {
    const rng = mulberry32(59);
    const head = createLayer(EMBEDDING_DIM, 1, "small", rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] = ((i * 7) % 13) * 0.03 - 0.15;
    const dPred = 0.2;
    const fwd = forwardSquashedReg(head, emb);
    expect(fwd.bounded).toBe(false);
    const { dW, db, dEmb } = backwardSquashedReg(head, emb, fwd.raw, dPred);

    function loss(): number {
      const f = forwardSquashedReg(head, emb);
      return dPred * f.predictedCents;
    }
    const eps = 1e-3;
    for (let o = 0; o < head.outDim; o++) {
      for (let i = 0; i < head.inDim; i++) {
        const idx = o * head.inDim + i;
        const orig = head.W[idx];
        head.W[idx] = orig + eps;
        const lp = loss();
        head.W[idx] = orig - eps;
        const lm = loss();
        head.W[idx] = orig;
        const num = (lp - lm) / (2 * eps);
        // Unbounded path uses exp, gradients can be larger; still within 5%.
        expect(Math.abs(num - dW[idx])).toBeLessThan(Math.max(1e-2, Math.abs(num) * 0.05));
      }
    }
    expect(db.length).toBe(1);
    expect(dEmb.length).toBe(EMBEDDING_DIM);
  });
});

// Phase 3d.2: forwardPriceMatchPair / backwardPriceMatchPair tests
// removed with the head itself.

// Phase 3d.2: aggregateEmbs / forwardBudgetSelect / backwardBudgetSelect
// tests removed with the head + helper themselves. New `forwardPinballQ40`
// + `backwardPinballQ40` tests live in tests/learning/pinballHead.test.ts.

describe("backwardLogPrice (numerical gradient check)", () => {
  it("matches finite differences for W, b, and emb", () => {
    const rng = mulberry32(37);
    const head = createLayer(EMBEDDING_DIM, 2, "small", rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < emb.length; i++) emb[i] = ((i * 7) % 11) * 0.03 - 0.1;
    const dMu = 0.7;
    const dLogVar = -0.4;

    const { dW, db, dEmb } = backwardLogPrice(head, emb, dMu, dLogVar);

    // Loss surrogate: dot the upstream gradients with raw outputs (the
    // BACKWARD function is for the unclamped Linear path; clamp behaviour
    // is the caller's responsibility, so we test the unclamped form by
    // bypassing forwardLogPrice and going through forwardLinear).
    function loss(): number {
      const y = forwardLinear(head, emb);
      return dMu * y[0] + dLogVar * y[1];
    }
    const eps = 1e-3;
    for (let o = 0; o < head.outDim; o++) {
      for (let i = 0; i < head.inDim; i++) {
        const idx = o * head.inDim + i;
        const orig = head.W[idx];
        head.W[idx] = orig + eps;
        const lp = loss();
        head.W[idx] = orig - eps;
        const lm = loss();
        head.W[idx] = orig;
        const num = (lp - lm) / (2 * eps);
        expect(Math.abs(num - dW[idx])).toBeLessThan(1e-3);
      }
    }
    for (let o = 0; o < head.outDim; o++) {
      const orig = head.b[o];
      head.b[o] = orig + eps;
      const lp = loss();
      head.b[o] = orig - eps;
      const lm = loss();
      head.b[o] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - db[o])).toBeLessThan(1e-3);
    }
    for (let i = 0; i < emb.length; i++) {
      const orig = emb[i];
      emb[i] = orig + eps;
      const lp = loss();
      emb[i] = orig - eps;
      const lm = loss();
      emb[i] = orig;
      const num = (lp - lm) / (2 * eps);
      expect(Math.abs(num - dEmb[i])).toBeLessThan(1e-3);
    }
  });
});
