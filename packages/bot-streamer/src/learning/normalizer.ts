/**
 * Per-feature EMA normaliser.
 *
 * Tracks running mean and variance of each input dimension via an
 * exponentially-weighted moving average (β=0.99 by default), then
 * normalises future inputs as `(x − μ) / (√var + ε)`.
 *
 * Why EMA + skip-update-when-cold: with very few samples the running
 * stats are noisy and would whip the inputs around. We skip the update
 * (and use the raw input) until we've seen ≥ 32 vectors — by then the
 * moving stats are roughly stable.
 */

export interface NormalizerOptions {
  dim: number;
  beta: number;             // EMA decay; 0.99 ≈ effective window 100
  warmupSamples: number;    // skip update + return raw until this many samples seen
  eps: number;              // numerical floor on variance
}

export class Normalizer {
  readonly opts: NormalizerOptions;
  /** Running mean per dim. */
  readonly mean: Float32Array;
  /** Running variance per dim. */
  readonly variance: Float32Array;
  count = 0;

  constructor(opts: NormalizerOptions) {
    this.opts = opts;
    this.mean = new Float32Array(opts.dim);
    this.variance = new Float32Array(opts.dim);
    // Init variance at 1 so the first normalise() doesn't produce
    // exploded values when called before any update.
    for (let i = 0; i < opts.dim; i++) this.variance[i] = 1;
  }

  /** Update running stats; no-op semantics during warmup are caller-controlled. */
  observe(x: Float32Array): void {
    if (x.length !== this.opts.dim) {
      throw new Error(`Normalizer.observe: dim mismatch ${x.length} != ${this.opts.dim}`);
    }
    this.count += 1;
    const beta = this.opts.beta;
    if (this.count === 1) {
      // Bootstrap with the first sample.
      this.mean.set(x);
      for (let i = 0; i < x.length; i++) this.variance[i] = 1;
      return;
    }
    for (let i = 0; i < x.length; i++) {
      const m = this.mean[i];
      const dx = x[i] - m;
      const newMean = beta * m + (1 - beta) * x[i];
      this.mean[i] = newMean;
      // Welford-ish EMA variance: track E[(x − μ)²] with the same β.
      const dx2 = dx * dx;
      this.variance[i] = beta * this.variance[i] + (1 - beta) * dx2;
    }
  }

  /** Apply normalisation. Returns a fresh Float32Array. */
  normalize(x: Float32Array): Float32Array {
    if (x.length !== this.opts.dim) {
      throw new Error(`Normalizer.normalize: dim mismatch ${x.length} != ${this.opts.dim}`);
    }
    const out = new Float32Array(x.length);
    if (this.count < this.opts.warmupSamples) {
      out.set(x);
      return out;
    }
    for (let i = 0; i < x.length; i++) {
      const sd = Math.sqrt(this.variance[i] + this.opts.eps);
      out[i] = (x[i] - this.mean[i]) / sd;
    }
    return out;
  }

  /** Serialize (count + mean + variance). */
  serialize(): Buffer {
    const total = 4 + this.mean.byteLength + this.variance.byteLength;
    const buf = Buffer.alloc(total);
    buf.writeInt32LE(this.count, 0);
    Buffer.from(this.mean.buffer, this.mean.byteOffset, this.mean.byteLength).copy(buf, 4);
    Buffer.from(
      this.variance.buffer,
      this.variance.byteOffset,
      this.variance.byteLength,
    ).copy(buf, 4 + this.mean.byteLength);
    return buf;
  }

  /** Deserialize (must match `dim`). */
  static deserialize(buf: Buffer, opts: NormalizerOptions): Normalizer {
    const n = new Normalizer(opts);
    n.count = buf.readInt32LE(0);
    Buffer.from(buf.buffer, buf.byteOffset + 4, opts.dim * 4).copy(
      Buffer.from(n.mean.buffer, n.mean.byteOffset, n.mean.byteLength),
    );
    Buffer.from(buf.buffer, buf.byteOffset + 4 + opts.dim * 4, opts.dim * 4).copy(
      Buffer.from(n.variance.buffer, n.variance.byteOffset, n.variance.byteLength),
    );
    return n;
  }
}
