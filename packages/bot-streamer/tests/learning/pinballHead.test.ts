import { describe, expect, it } from "vitest";
import {
  backwardPinballQ40,
  createLayer,
  forwardPinballQ40,
} from "../../src/learning/mlp";
import { pinballLoss } from "../../src/learning/losses";
import { EMBEDDING_DIM } from "../../src/learning/types";

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pinballLoss", () => {
  it("under-prediction (target > pred) yields a negative gradient at rate τ", () => {
    const { loss, grad } = pinballLoss(0.0, 0.5, 0.4);
    expect(loss).toBeCloseTo(0.4 * 0.5, 6);
    expect(grad).toBe(-0.4);
  });
  it("over-prediction (target < pred) yields a positive gradient at rate (1-τ)", () => {
    const { loss, grad } = pinballLoss(1.0, 0.5, 0.4);
    expect(loss).toBeCloseTo((1 - 0.4) * 0.5, 6);
    expect(grad).toBe(0.6);
  });
  it("τ=0.5 collapses to symmetric 0.5·|target − pred|", () => {
    const a = pinballLoss(0, 1, 0.5);
    const b = pinballLoss(1, 0, 0.5);
    expect(a.loss).toBeCloseTo(0.5);
    expect(b.loss).toBeCloseTo(0.5);
  });
  it("non-finite inputs return zero loss + zero grad (defensive)", () => {
    expect(pinballLoss(NaN, 0, 0.4)).toEqual({ loss: 0, grad: 0 });
    expect(pinballLoss(0, NaN, 0.4)).toEqual({ loss: 0, grad: 0 });
  });
  it("out-of-range τ falls back to median behavior (robustness)", () => {
    const a = pinballLoss(0, 1, 1.5);
    const b = pinballLoss(0, 1, 0.5);
    expect(a.loss).toBeCloseTo(b.loss, 6);
  });
});

describe("forwardPinballQ40", () => {
  it("returns a finite scalar for a well-shaped input", () => {
    const rng = mulberry32(11);
    const head = createLayer(EMBEDDING_DIM, 1, "small", rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] = (i % 5) * 0.1 - 0.2;
    const q = forwardPinballQ40(head, emb);
    expect(Number.isFinite(q)).toBe(true);
  });
});

describe("backwardPinballQ40 (numerical gradient check)", () => {
  it("matches finite differences for W, b, and dEmb", () => {
    const rng = mulberry32(13);
    const head = createLayer(EMBEDDING_DIM, 1, "small", rng);
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] = ((i * 7) % 11) * 0.04 - 0.2;
    const dQ40 = 0.7;
    const { dW, db, dEmb } = backwardPinballQ40(head, emb, dQ40);

    // Loss surrogate: dQ40 · q40
    function loss(): number {
      const q = forwardPinballQ40(head, emb);
      return dQ40 * q;
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

  it("non-finite dQ40 zeros the gradient (defensive)", () => {
    const head = createLayer(EMBEDDING_DIM, 1, "small", mulberry32(17));
    const emb = new Float32Array(EMBEDDING_DIM);
    const { dW, db, dEmb } = backwardPinballQ40(head, emb, NaN);
    for (const v of dW) expect(v).toBe(0);
    for (const v of db) expect(v).toBe(0);
    for (const v of dEmb) expect(v).toBe(0);
  });
});
