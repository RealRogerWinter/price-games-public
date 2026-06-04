/**
 * AdamW optimizer with decoupled weight decay + linear warmup.
 *
 * Per-parameter state: first moment `m`, second moment `v`. Update:
 *   m  ← β1·m  + (1−β1)·g
 *   v  ← β2·v  + (1−β2)·g²
 *   m̂  = m / (1 − β1^t)
 *   v̂  = v / (1 − β2^t)
 *   p  ← p − lr_eff·(m̂ / (√v̂ + ε))            (gradient term)
 *   p  ← p − lr_eff·wd·p                       (weight decay; decoupled)
 *
 * `lr_eff` linearly warms from `warmupStartLr` up to `lr` over the
 * first `warmupRounds` steps.
 *
 * The optimizer holds NO references to network parameter arrays — the
 * caller passes them into {@link AdamW.step}. This keeps the optimizer
 * trivially serialisable: serialise(`m`s and `v`s) per param buffer and
 * the round counter.
 */

export interface AdamWOptions {
  lr: number;
  beta1: number;
  beta2: number;
  eps: number;
  weightDecay: number;
  warmupRounds: number;
  warmupStartLr: number;
}

export class AdamW {
  readonly opts: AdamWOptions;
  /** Adam first-moment buffers, one per param buffer. */
  private moments: Float32Array[] = [];
  /** Adam second-moment buffers, one per param buffer. */
  private secondMoments: Float32Array[] = [];
  /** Step count (= round number when called from worker). */
  step_count = 0;

  constructor(opts: AdamWOptions) {
    this.opts = opts;
  }

  /**
   * Allocate moment buffers matching the param shapes. Idempotent — if
   * already initialised the existing buffers are kept (they may have
   * been deserialised from disk).
   *
   * @param shapes Sizes of each param buffer in declaration order.
   */
  bind(shapes: number[]): void {
    if (this.moments.length === 0) {
      this.moments = shapes.map((n) => new Float32Array(n));
      this.secondMoments = shapes.map((n) => new Float32Array(n));
    } else {
      if (this.moments.length !== shapes.length) {
        throw new Error(`AdamW.bind: shape count mismatch (${this.moments.length} vs ${shapes.length})`);
      }
      for (let i = 0; i < shapes.length; i++) {
        if (this.moments[i].length !== shapes[i]) {
          throw new Error(`AdamW.bind: shape[${i}] mismatch (${this.moments[i].length} vs ${shapes[i]})`);
        }
      }
    }
  }

  /**
   * Effective learning rate at step `t` (1-based step counter).
   *
   * @param t Step number (1, 2, …).
   */
  effectiveLr(t: number): number {
    const { warmupRounds, warmupStartLr, lr } = this.opts;
    if (warmupRounds <= 0) return lr;
    if (t >= warmupRounds) return lr;
    const frac = t / warmupRounds;
    return warmupStartLr + (lr - warmupStartLr) * frac;
  }

  /**
   * Apply one Adam step to a single (param, grad) pair.
   *
   * @param paramBufIdx Index into the bound moment arrays.
   * @param params      Param buffer to update in-place.
   * @param grads       Gradient buffer (same length).
   */
  stepBuffer(paramBufIdx: number, params: Float32Array, grads: Float32Array): void {
    if (paramBufIdx >= this.moments.length) {
      throw new Error(`AdamW.stepBuffer: idx ${paramBufIdx} out of range (${this.moments.length})`);
    }
    const m = this.moments[paramBufIdx];
    const v = this.secondMoments[paramBufIdx];
    const { beta1, beta2, eps, weightDecay } = this.opts;
    const t = this.step_count;
    const biasCorr1 = 1 - Math.pow(beta1, t);
    const biasCorr2 = 1 - Math.pow(beta2, t);
    const lrEff = this.effectiveLr(t);
    for (let i = 0; i < params.length; i++) {
      const g = grads[i];
      m[i] = beta1 * m[i] + (1 - beta1) * g;
      v[i] = beta2 * v[i] + (1 - beta2) * g * g;
      const mhat = m[i] / biasCorr1;
      const vhat = v[i] / biasCorr2;
      // Decoupled weight decay: applied to params directly, not via grad.
      params[i] -= lrEff * (mhat / (Math.sqrt(vhat) + eps) + weightDecay * params[i]);
    }
  }

  /** Increment the step counter and call this once per parameter buffer. */
  beginStep(): void {
    this.step_count += 1;
  }

  /**
   * Phase 3d.1 escape hatch — direct access to a moment buffer for
   * one-shot migrations that need to inspect or zero specific
   * Adam state slots. Returns the live buffer; caller must treat
   * it as live state. Throws if `paramBufIdx` is out of range.
   *
   * Use sparingly — the rest of the codebase should go through
   * {@link stepBuffer}, {@link bind}, {@link serialize}.
   */
  getMomentBuffers(paramBufIdx: number): { m: Float32Array; v: Float32Array } {
    if (paramBufIdx < 0 || paramBufIdx >= this.moments.length) {
      throw new Error(
        `AdamW.getMomentBuffers: idx ${paramBufIdx} out of range (${this.moments.length})`,
      );
    }
    return { m: this.moments[paramBufIdx], v: this.secondMoments[paramBufIdx] };
  }

  /**
   * Serialize moment buffers + step counter into a single buffer.
   * Layout: int32 stepCount | int32 numBufs | (int32 size, [size] f32 m, [size] f32 v)+
   */
  serialize(): Buffer {
    let total = 4 + 4; // stepCount + numBufs
    for (const m of this.moments) total += 4 + m.byteLength * 2;
    const buf = Buffer.alloc(total);
    let off = 0;
    buf.writeInt32LE(this.step_count, off); off += 4;
    buf.writeInt32LE(this.moments.length, off); off += 4;
    for (let i = 0; i < this.moments.length; i++) {
      const m = this.moments[i];
      const v = this.secondMoments[i];
      buf.writeInt32LE(m.length, off); off += 4;
      Buffer.from(m.buffer, m.byteOffset, m.byteLength).copy(buf, off);
      off += m.byteLength;
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, off);
      off += v.byteLength;
    }
    return buf;
  }

  /** Inverse of {@link serialize}. */
  static deserialize(buf: Buffer, opts: AdamWOptions): AdamW {
    const adam = new AdamW(opts);
    let off = 0;
    adam.step_count = buf.readInt32LE(off); off += 4;
    const n = buf.readInt32LE(off); off += 4;
    for (let i = 0; i < n; i++) {
      const len = buf.readInt32LE(off); off += 4;
      const m = new Float32Array(len);
      Buffer.from(buf.buffer, buf.byteOffset + off, len * 4).copy(
        Buffer.from(m.buffer, m.byteOffset, m.byteLength),
      );
      off += len * 4;
      const v = new Float32Array(len);
      Buffer.from(buf.buffer, buf.byteOffset + off, len * 4).copy(
        Buffer.from(v.buffer, v.byteOffset, v.byteLength),
      );
      off += len * 4;
      adam.moments.push(m);
      adam.secondMoments.push(v);
    }
    return adam;
  }
}
