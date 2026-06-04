/**
 * Out-of-distribution price-prior blender.
 *
 * Maintains per-category running stats over the log-actual-price seen
 * so far. At inference, blends the NN's μ_log_residual prediction
 * toward the heuristic prior with weight `1 − tanh(n_seen/20)`. So
 * for unfamiliar categories (n_seen < 5), almost the full weight goes
 * to the heuristic; once a category has been seen ≥ 60 times, the NN
 * effectively dominates.
 *
 * The class also tracks `(μ, σ)` of the running log-actual within each
 * category — exposed for visualization (the "Belief Card" speaks of
 * "category baseline") and for the Thompson sampler's calibration.
 */

import { CATEGORY_BUCKETS } from "./types";

export class OODBlender {
  /** Per-category sample count. */
  readonly counts: Int32Array;
  /** Per-category running mean of log(actualCents). */
  readonly meanLog: Float32Array;
  /** Per-category running variance of log(actualCents). */
  readonly varLog: Float32Array;

  constructor(buckets: number = CATEGORY_BUCKETS) {
    this.counts = new Int32Array(buckets);
    this.meanLog = new Float32Array(buckets);
    this.varLog = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) this.varLog[i] = 0.5; // sane default σ²
  }

  /** Welford's online algorithm — exact running mean + variance. */
  observe(categoryId: number, actualCents: number): void {
    if (categoryId < 0 || categoryId >= this.counts.length) return;
    if (!Number.isFinite(actualCents) || actualCents <= 0) return;
    const x = Math.log(actualCents);
    this.counts[categoryId] += 1;
    const n = this.counts[categoryId];
    const delta = x - this.meanLog[categoryId];
    this.meanLog[categoryId] += delta / n;
    const delta2 = x - this.meanLog[categoryId];
    if (n === 1) {
      this.varLog[categoryId] = 0;
    } else {
      const m2Prev = this.varLog[categoryId] * (n - 1);
      const m2 = m2Prev + delta * delta2;
      this.varLog[categoryId] = m2 / n;
    }
  }

  /**
   * Blend weight on the NN side: `tanh(n/20)`. So the heuristic gets
   * weight `1 − tanh(n/20)`. At n=0 → pure heuristic; n=20 → 76% NN;
   * n=60 → 99% NN.
   */
  blendWeightNN(categoryId: number): number {
    if (categoryId < 0 || categoryId >= this.counts.length) return 0;
    const n = this.counts[categoryId];
    return Math.tanh(n / 20);
  }

  /** Per-category category entropy (H = log(σ²)/2 + const) — used by adaptive ε. */
  entropyAt(categoryId: number): number {
    if (categoryId < 0 || categoryId >= this.counts.length) return 0;
    const variance = Math.max(this.varLog[categoryId], 1e-6);
    // Differential entropy of N(μ, σ²) up to constant: 0.5·ln(2πeσ²)
    return 0.5 * Math.log(2 * Math.PI * Math.E * variance);
  }

  /** Number of categories with ≥1 observation. */
  populatedCategories(): number {
    let n = 0;
    for (let i = 0; i < this.counts.length; i++) if (this.counts[i] > 0) n += 1;
    return n;
  }

  /**
   * Phase 4: build a Gaussian prior over the catalog log-prices for a
   * given category, normalised to a proper probability distribution.
   * Returns a Float32Array of length `catalogLogPrices.length`. Used
   * at predict time to blend the head's softmax with the per-category
   * baseline so cold-start categories don't classify essentially
   * randomly.
   *
   * Variance floor of `0.25` (≈σ=0.5 in log-space, ~65% spread per
   * category) prevents a single early observation from collapsing the
   * prior to a delta. When the category has zero observations we
   * return a flat (uniform) prior so the blend math is well-defined.
   */
  priorOverCatalog(
    categoryId: number,
    catalogLogPrices: ReadonlyArray<number>,
  ): Float32Array {
    const K = catalogLogPrices.length;
    const out = new Float32Array(K);
    if (categoryId < 0 || categoryId >= this.counts.length || this.counts[categoryId] === 0) {
      // Uniform prior — flat over all classes.
      const u = 1 / Math.max(1, K);
      for (let i = 0; i < K; i++) out[i] = u;
      return out;
    }
    const mu = this.meanLog[categoryId];
    const variance = Math.max(this.varLog[categoryId], 0.25);
    let zSum = 0;
    let maxL = -Infinity;
    // Numerically-stable log-sum-exp-then-renormalise.
    const logProbs = new Float32Array(K);
    for (let i = 0; i < K; i++) {
      const dz = catalogLogPrices[i] - mu;
      logProbs[i] = -(dz * dz) / (2 * variance);
      if (logProbs[i] > maxL) maxL = logProbs[i];
    }
    for (let i = 0; i < K; i++) {
      const e = Math.exp(logProbs[i] - maxL);
      out[i] = e;
      zSum += e;
    }
    if (zSum > 0) {
      for (let i = 0; i < K; i++) out[i] /= zSum;
    } else {
      const u = 1 / Math.max(1, K);
      for (let i = 0; i < K; i++) out[i] = u;
    }
    return out;
  }

  /** Median calibrated σ over populated categories — feeds adaptive ε. */
  medianCalibratedSigma(): number {
    const ps: number[] = [];
    for (let i = 0; i < this.counts.length; i++) {
      if (this.counts[i] > 0) ps.push(Math.sqrt(this.varLog[i]));
    }
    if (ps.length === 0) return 0.5;
    ps.sort((a, b) => a - b);
    return ps[Math.floor(ps.length / 2)];
  }

  serialize(): Buffer {
    const total = this.counts.byteLength + this.meanLog.byteLength + this.varLog.byteLength;
    const buf = Buffer.alloc(total);
    let off = 0;
    Buffer.from(this.counts.buffer, this.counts.byteOffset, this.counts.byteLength).copy(buf, off);
    off += this.counts.byteLength;
    Buffer.from(this.meanLog.buffer, this.meanLog.byteOffset, this.meanLog.byteLength).copy(buf, off);
    off += this.meanLog.byteLength;
    Buffer.from(this.varLog.buffer, this.varLog.byteOffset, this.varLog.byteLength).copy(buf, off);
    return buf;
  }

  static deserialize(buf: Buffer, buckets = CATEGORY_BUCKETS): OODBlender {
    const o = new OODBlender(buckets);
    let off = 0;
    Buffer.from(buf.buffer, buf.byteOffset + off, buckets * 4).copy(
      Buffer.from(o.counts.buffer, o.counts.byteOffset, o.counts.byteLength),
    );
    off += buckets * 4;
    Buffer.from(buf.buffer, buf.byteOffset + off, buckets * 4).copy(
      Buffer.from(o.meanLog.buffer, o.meanLog.byteOffset, o.meanLog.byteLength),
    );
    off += buckets * 4;
    Buffer.from(buf.buffer, buf.byteOffset + off, buckets * 4).copy(
      Buffer.from(o.varLog.buffer, o.varLog.byteOffset, o.varLog.byteLength),
    );
    return o;
  }
}
