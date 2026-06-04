/**
 * Prioritized Experience Replay buffer (Schaul 2016) with two extras:
 *
 *   1. **roundId de-correlation** — at most `maxPerRoundInBatch` samples
 *      with the same roundId in any minibatch. Multi-product modes
 *      otherwise produce 5–15 entries per round that share the trunk's
 *      view of the round, which collapses the effective minibatch.
 *
 *   2. **uniform-mixin fraction** — `uniformFraction` (default 0.2) of
 *      the minibatch is sampled uniformly to keep the buffer's tails
 *      from starving when priorities concentrate.
 *
 * Priority of sample i is `(|residual_i| + 0.5·BCE_pair_i)^α`. Importance
 * sampling weights `w_i = (N · P(i))^−β` are computed and exposed; the
 * caller multiplies per-sample loss by `w_i / max(w)`.
 *
 * The buffer is a ring: when at capacity, new pushes overwrite the
 * oldest slot (FIFO eviction). Priorities for fresh entries default to
 * the current max so they're guaranteed at least one replay.
 */

import { type Sample } from "./types";

export interface PERBufferOptions {
  capacity: number;
  alpha: number;
  betaStart: number;
  betaEnd: number;
  betaAnnealRounds: number;
  uniformFraction: number;
  maxPerRoundInBatch: number;
}

export class PrioritizedReplay {
  readonly opts: PERBufferOptions;
  /** Slot storage. */
  private slots: (Sample | null)[];
  /** Priority^α for each slot. */
  private priorities: Float32Array;
  /** Write cursor (FIFO). */
  private cursor = 0;
  /** Number of filled slots (≤ capacity). */
  private filled = 0;
  /** Tracked max priority^α so new entries land at the front. */
  private maxPriority = 1.0;

  constructor(opts: PERBufferOptions) {
    if (opts.capacity <= 0) throw new Error("PrioritizedReplay: capacity must be > 0");
    this.opts = opts;
    this.slots = new Array<Sample | null>(opts.capacity).fill(null);
    this.priorities = new Float32Array(opts.capacity);
  }

  size(): number {
    return this.filled;
  }

  capacity(): number {
    return this.opts.capacity;
  }

  /** Push a sample. Optional explicit priority; defaults to current max. */
  push(s: Sample, priority?: number): void {
    const p = priority ?? Math.max(this.maxPriority, 1e-6);
    const pAlpha = Math.pow(p, this.opts.alpha);
    this.slots[this.cursor] = s;
    this.priorities[this.cursor] = pAlpha;
    if (pAlpha > this.maxPriority) this.maxPriority = pAlpha;
    this.cursor = (this.cursor + 1) % this.opts.capacity;
    if (this.filled < this.opts.capacity) this.filled += 1;
  }

  /**
   * Beta annealing schedule. Linearly interpolates `betaStart → betaEnd`
   * over `betaAnnealRounds` rounds, capped at `betaEnd`.
   */
  effectiveBeta(round: number): number {
    const { betaStart, betaEnd, betaAnnealRounds } = this.opts;
    if (betaAnnealRounds <= 0) return betaEnd;
    const frac = Math.min(round / betaAnnealRounds, 1);
    return betaStart + (betaEnd - betaStart) * frac;
  }

  /**
   * Draw `n` samples for a minibatch.
   *
   * @param n            Minibatch size.
   * @param round        Current round (used for β anneal).
   * @param rng          U[0,1) RNG.
   * @returns samples + IS weights + indices (for priority update).
   */
  sample(
    n: number,
    round: number,
    rng: () => number,
  ): { samples: Sample[]; isWeights: Float32Array; indices: number[] } {
    if (this.filled === 0) {
      return { samples: [], isWeights: new Float32Array(0), indices: [] };
    }
    const beta = this.effectiveBeta(round);
    const out: Sample[] = [];
    const isW = new Float32Array(n);
    const indices: number[] = [];
    const perRound = new Map<string, number>();
    const uniformQuota = Math.max(0, Math.round(n * this.opts.uniformFraction));
    let uniformDrawn = 0;

    // Total of priority^α over filled slots — needed for IS-weight denominator.
    let totalPAlpha = 0;
    for (let i = 0; i < this.filled; i++) totalPAlpha += this.priorities[i];

    let attempts = 0;
    const maxAttempts = n * 8;
    while (out.length < n && attempts < maxAttempts) {
      attempts += 1;
      const drawUniform = uniformDrawn < uniformQuota;
      let pickedIdx: number;
      if (drawUniform) {
        pickedIdx = Math.floor(rng() * this.filled);
      } else if (totalPAlpha <= 0) {
        pickedIdx = Math.floor(rng() * this.filled);
      } else {
        // Linear scan — buffer is small (<=512), no need for sumtree.
        let r = rng() * totalPAlpha;
        pickedIdx = 0;
        for (let i = 0; i < this.filled; i++) {
          r -= this.priorities[i];
          if (r <= 0) {
            pickedIdx = i;
            break;
          }
        }
      }
      const s = this.slots[pickedIdx];
      if (!s) continue;
      const seen = perRound.get(s.roundId) ?? 0;
      if (seen >= this.opts.maxPerRoundInBatch) continue;
      perRound.set(s.roundId, seen + 1);

      const pAlpha = this.priorities[pickedIdx];
      const pProb = totalPAlpha > 0 ? pAlpha / totalPAlpha : 1 / this.filled;
      const w = Math.pow(this.filled * pProb, -beta);
      out.push(s);
      isW[out.length - 1] = w;
      indices.push(pickedIdx);
      if (drawUniform) uniformDrawn += 1;
    }

    // Normalise IS weights by max so the largest weight = 1.
    let maxW = 0;
    for (let i = 0; i < out.length; i++) if (isW[i] > maxW) maxW = isW[i];
    if (maxW > 0) {
      for (let i = 0; i < out.length; i++) isW[i] /= maxW;
    }

    return { samples: out, isWeights: isW.subarray(0, out.length), indices };
  }

  /** Update priorities after a step. */
  updatePriorities(indices: number[], newPriorities: Float32Array): void {
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const p = Math.max(newPriorities[i], 1e-6);
      const pAlpha = Math.pow(p, this.opts.alpha);
      this.priorities[idx] = pAlpha;
      if (pAlpha > this.maxPriority) this.maxPriority = pAlpha;
    }
  }

  /**
   * Serialize buffer state. Format:
   *   int32 cursor | int32 filled | int32 capacity |
   *   priorities (capacity·f32) | for each filled slot: featuresLen·f32, then JSON-encoded sample meta.
   *
   * The sample-meta encoding is verbose JSON for forward-compat — we
   * accept the byte-cost (≈300 B/sample × 512 = 150 KB max).
   */
  serialize(): Buffer {
    const capacity = this.opts.capacity;
    const header = Buffer.alloc(12);
    header.writeInt32LE(this.cursor, 0);
    header.writeInt32LE(this.filled, 4);
    header.writeInt32LE(capacity, 8);
    const priBuf = Buffer.from(this.priorities.buffer, this.priorities.byteOffset, this.priorities.byteLength);
    // Per-slot blob: features-length f32 + meta JSON.
    const blobs: Buffer[] = [];
    for (let i = 0; i < capacity; i++) {
      const s = this.slots[i];
      if (!s) {
        blobs.push(Buffer.from([0, 0, 0, 0])); // featuresLen=0 marker
        continue;
      }
      const flen = Buffer.alloc(4);
      flen.writeInt32LE(s.features.length, 0);
      const fbuf = Buffer.from(s.features.buffer, s.features.byteOffset, s.features.byteLength);
      const meta = JSON.stringify({
        targetLogResidual: s.targetLogResidual,
        actualCents: s.actualCents,
        heuristicCents: s.heuristicCents,
        categoryId: s.categoryId,
        brandTier: s.brandTier,
        mode: s.mode,
        productId: s.productId,
        roundId: s.roundId,
        recordedAtRound: s.recordedAtRound,
        // Mood snapshot when the sample was recorded — vibe + morale
        // only; streak isn't on Sample. Optional; old replays
        // serialised before mood-conditioned training existed are
        // restored with `mood = undefined`, which makes the FiLM /
        // arousal-gating path skip cleanly. Persisting this is what
        // makes `workerCore.runMinibatchStep`'s "draw the sample
        // under the mood it was observed in" contract survive a
        // worker restart or NaN-rollback.
        mood: s.mood,
        // Phase 2: bound the player saw at predict time. Without this
        // round-trip, restored samples would lose the bound and the
        // train-time CE mask would skip on them — recreating exactly
        // the train/predict asymmetry Phase 2 fixed.
        priceRangeCents: s.priceRangeCents,
        // Phase 3a: round-context numerics for FiLM cond[3..5].
        // PR #312's reviewer caught the original implementation
        // dropping this — restored samples would have all-zero
        // round-context cond at train while predict had the real
        // values, undoing the snapshot's intent.
        roundContextSnapshot: s.roundContextSnapshot,
        // Phase 3d.2: bidding-turn snapshot. Persisted so train-time
        // forward sees the same opponent-bid context as predict.
        biddingContext: s.biddingContext,
      });
      const metaBuf = Buffer.from(meta, "utf8");
      const mlen = Buffer.alloc(4);
      mlen.writeInt32LE(metaBuf.length, 0);
      blobs.push(Buffer.concat([flen, fbuf, mlen, metaBuf]));
    }
    return Buffer.concat([header, priBuf, ...blobs]);
  }

  /** Inverse of {@link serialize}. */
  static deserialize(buf: Buffer, opts: PERBufferOptions): PrioritizedReplay {
    const r = new PrioritizedReplay(opts);
    r.cursor = buf.readInt32LE(0);
    r.filled = buf.readInt32LE(4);
    const capacity = buf.readInt32LE(8);
    if (capacity !== opts.capacity) {
      throw new Error(`PrioritizedReplay.deserialize: capacity mismatch ${capacity} vs ${opts.capacity}`);
    }
    let off = 12;
    Buffer.from(buf.buffer, buf.byteOffset + off, capacity * 4).copy(
      Buffer.from(r.priorities.buffer, r.priorities.byteOffset, r.priorities.byteLength),
    );
    off += capacity * 4;
    for (let i = 0; i < capacity; i++) {
      const flen = buf.readInt32LE(off); off += 4;
      if (flen === 0) {
        r.slots[i] = null;
        continue;
      }
      const features = new Float32Array(flen);
      Buffer.from(buf.buffer, buf.byteOffset + off, flen * 4).copy(
        Buffer.from(features.buffer, features.byteOffset, features.byteLength),
      );
      off += flen * 4;
      const mlen = buf.readInt32LE(off); off += 4;
      const meta = JSON.parse(buf.subarray(off, off + mlen).toString("utf8"));
      off += mlen;
      r.slots[i] = {
        features,
        targetLogResidual: meta.targetLogResidual,
        actualCents: meta.actualCents,
        heuristicCents: meta.heuristicCents,
        categoryId: meta.categoryId,
        brandTier: meta.brandTier,
        mode: meta.mode,
        productId: meta.productId,
        roundId: meta.roundId,
        recordedAtRound: meta.recordedAtRound,
        // Old snapshots predate the `mood` field — `meta.mood` is
        // `undefined`, which is the correct value (FiLM skip-path).
        // Defensively narrow to undefined when fields are missing
        // to avoid carrying `{vibe:NaN,morale:NaN}` into the
        // training loop on a malformed snapshot.
        mood: (meta.mood
          && typeof meta.mood.vibe === "number"
          && typeof meta.mood.morale === "number"
          && Number.isFinite(meta.mood.vibe)
          && Number.isFinite(meta.mood.morale))
          ? { vibe: meta.mood.vibe, morale: meta.mood.morale }
          : undefined,
        priceRangeCents: (meta.priceRangeCents
          && typeof meta.priceRangeCents.min === "number"
          && typeof meta.priceRangeCents.max === "number"
          && Number.isFinite(meta.priceRangeCents.min)
          && Number.isFinite(meta.priceRangeCents.max)
          && meta.priceRangeCents.max >= meta.priceRangeCents.min)
          ? { min: meta.priceRangeCents.min, max: meta.priceRangeCents.max }
          : undefined,
        roundContextSnapshot: meta.roundContextSnapshot && typeof meta.roundContextSnapshot === "object"
          ? {
              budgetCents: typeof meta.roundContextSnapshot.budgetCents === "number"
                && Number.isFinite(meta.roundContextSnapshot.budgetCents)
                ? meta.roundContextSnapshot.budgetCents : undefined,
              maxPriceCapCents: typeof meta.roundContextSnapshot.maxPriceCapCents === "number"
                && Number.isFinite(meta.roundContextSnapshot.maxPriceCapCents)
                ? meta.roundContextSnapshot.maxPriceCapCents : undefined,
              productCount: typeof meta.roundContextSnapshot.productCount === "number"
                && Number.isFinite(meta.roundContextSnapshot.productCount)
                ? meta.roundContextSnapshot.productCount : undefined,
            }
          : undefined,
        // Phase 3d.2: bidding-turn snapshot. Restored only when the
        // shape is well-formed; missing or malformed → undefined,
        // which makes the feature extractor zero-fill the 5
        // bidding-context dims. Pre-3d.2 snapshots are auto-archived
        // by the headTopologyVersion bump, so this branch only fires
        // for newly-written replays.
        biddingContext: meta.biddingContext
          && typeof meta.biddingContext.turnIdx === "number"
          && Number.isInteger(meta.biddingContext.turnIdx)
          && meta.biddingContext.turnIdx >= 0
          && typeof meta.biddingContext.totalPlayers === "number"
          && Number.isInteger(meta.biddingContext.totalPlayers)
          && meta.biddingContext.totalPlayers > 0
          && Array.isArray(meta.biddingContext.previousBidsCents)
          && meta.biddingContext.previousBidsCents.length <= 8
          && meta.biddingContext.previousBidsCents.every(
            (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0,
          )
          ? {
              turnIdx: meta.biddingContext.turnIdx,
              totalPlayers: meta.biddingContext.totalPlayers,
              previousBidsCents: (meta.biddingContext.previousBidsCents as number[]).slice(),
            }
          : undefined,
      };
    }
    // Recompute maxPriority.
    let m = 0;
    for (let i = 0; i < r.filled; i++) if (r.priorities[i] > m) m = r.priorities[i];
    r.maxPriority = Math.max(m, 1.0);
    return r;
  }
}

/**
 * Two-tier stratified replay buffer (Phase 1 of the NN recovery plan).
 *
 *   1. **Recent ring** — fixed-capacity FIFO of the most-recent samples,
 *      sampled with high uniform-mixin (defaults to 0.5). Captures
 *      whatever the streamer is currently showing so the model can adapt
 *      fast to mode/product distribution shifts.
 *   2. **Per-mode reservoir** — one {@link PrioritizedReplay} bucket per
 *      game mode, created lazily on first push of that mode. Anti-
 *      starvation is structural: a dominant mode cannot evict samples
 *      from rare-mode buckets.
 *
 * Sample composition per minibatch: `recentSampleFraction` from the
 * recent ring; the remainder distributed uniformly across active per-
 * mode buckets (each active mode contributes 1/N of the stratified
 * portion regardless of its bucket size). This is the explicit anti-
 * starvation goal — `budget-builder` (rare) gets the same minibatch
 * weight as `higher-lower` (frequent) when both are present.
 *
 * Public surface matches {@link PrioritizedReplay} so workerCore can
 * use either interchangeably. Internally indices are encoded as
 * `bucketId * INDEX_STRIDE + localIdx` where `bucketId === 0` means
 * the recent ring and `bucketId >= 1` indexes into `modeOrder`.
 */

/** Capacity headroom per per-mode bucket — well above the planned cap. */
const STRATIFIED_INDEX_STRIDE = 65536;

export interface StratifiedReplayOptions {
  /** Capacity of the recent FIFO ring. */
  recentCapacity: number;
  /** Capacity of each per-mode reservoir. */
  perModeCapacity: number;
  /** Fraction of each minibatch drawn from the recent ring (0-1). */
  recentSampleFraction: number;
  /** Per-mode-bucket PER alpha. */
  alpha: number;
  betaStart: number;
  betaEnd: number;
  betaAnnealRounds: number;
  /** Per-mode-bucket uniform-mixin fraction. */
  perModeUniformFraction: number;
  /** Recent-ring uniform-mixin fraction (typically high — 0.5). */
  recentUniformFraction: number;
  /** Cap on same-roundId samples per minibatch (de-correlation). */
  maxPerRoundInBatch: number;
}

export class StratifiedReplay {
  readonly opts: StratifiedReplayOptions;
  private readonly recent: PrioritizedReplay;
  private readonly perMode = new Map<string, PrioritizedReplay>();
  /** Stable bucket-id assignment — index in this array + 1 = bucketId. */
  private readonly modeOrder: string[] = [];

  constructor(opts: StratifiedReplayOptions) {
    if (opts.recentCapacity <= 0 || opts.perModeCapacity <= 0) {
      throw new Error("StratifiedReplay: capacities must be > 0");
    }
    if (opts.perModeCapacity >= STRATIFIED_INDEX_STRIDE) {
      throw new Error(
        `StratifiedReplay: perModeCapacity ${opts.perModeCapacity} >= STRATIFIED_INDEX_STRIDE ${STRATIFIED_INDEX_STRIDE}`,
      );
    }
    this.opts = opts;
    this.recent = new PrioritizedReplay({
      capacity: opts.recentCapacity,
      alpha: opts.alpha,
      betaStart: opts.betaStart,
      betaEnd: opts.betaEnd,
      betaAnnealRounds: opts.betaAnnealRounds,
      uniformFraction: opts.recentUniformFraction,
      maxPerRoundInBatch: opts.maxPerRoundInBatch,
    });
  }

  size(): number {
    let n = this.recent.size();
    for (const b of this.perMode.values()) n += b.size();
    return n;
  }

  /**
   * Total capacity across both tiers, for telemetry. Grows as new modes
   * appear because per-mode buckets are created lazily.
   */
  capacity(): number {
    return this.opts.recentCapacity + this.modeOrder.length * this.opts.perModeCapacity;
  }

  push(s: Sample, priority?: number): void {
    this.recent.push(s, priority);
    let mb = this.perMode.get(s.mode);
    if (!mb) {
      mb = new PrioritizedReplay({
        capacity: this.opts.perModeCapacity,
        alpha: this.opts.alpha,
        betaStart: this.opts.betaStart,
        betaEnd: this.opts.betaEnd,
        betaAnnealRounds: this.opts.betaAnnealRounds,
        uniformFraction: this.opts.perModeUniformFraction,
        maxPerRoundInBatch: this.opts.maxPerRoundInBatch,
      });
      this.perMode.set(s.mode, mb);
      this.modeOrder.push(s.mode);
    }
    mb.push(s, priority);
  }

  sample(
    n: number,
    round: number,
    rng: () => number,
  ): { samples: Sample[]; isWeights: Float32Array; indices: number[] } {
    if (this.size() === 0) {
      return { samples: [], isWeights: new Float32Array(0), indices: [] };
    }
    const out: Sample[] = [];
    const isW: number[] = [];
    const indices: number[] = [];

    const targetRecent = Math.max(0, Math.min(n, Math.round(n * this.opts.recentSampleFraction)));
    const targetStratified = n - targetRecent;

    // Recent tier — bucketId = 0.
    if (targetRecent > 0 && this.recent.size() > 0) {
      const r = this.recent.sample(targetRecent, round, rng);
      for (let i = 0; i < r.samples.length; i++) {
        out.push(r.samples[i]);
        isW.push(r.isWeights[i]);
        indices.push(this.encodeIdx(0, r.indices[i]));
      }
    }

    // Stratified tier — distribute uniformly across active modes.
    // Phase 3d.2: cap the bidding bucket's stratified take so a
    // quickplay_bidding rotation that fills only the bidding bucket
    // (with PM/BB gone there are 4 active modes total) can't starve
    // the retained modes' samples in the recent ring. The cap is
    // active only when bidding is the sole active mode AND `n >= 4`
    // — both conditions naturally hold during warmup. With 4 active
    // modes and equal partition the cap is moot.
    const activeModes: string[] = [];
    for (const m of this.modeOrder) {
      if ((this.perMode.get(m)?.size() ?? 0) > 0) activeModes.push(m);
    }
    const onlyBidding = activeModes.length === 1 && activeModes[0] === "bidding";
    const biddingStratifiedCap = onlyBidding ? Math.max(1, Math.floor(n * 0.4)) : Number.POSITIVE_INFINITY;
    if (activeModes.length > 0 && targetStratified > 0) {
      const perMode = Math.floor(targetStratified / activeModes.length);
      const remainder = targetStratified - perMode * activeModes.length;
      for (let mi = 0; mi < activeModes.length; mi++) {
        const mode = activeModes[mi];
        let take = perMode + (mi < remainder ? 1 : 0);
        if (mode === "bidding" && take > biddingStratifiedCap) take = biddingStratifiedCap;
        if (take === 0) continue;
        const buf = this.perMode.get(mode)!;
        const bucketId = this.modeOrder.indexOf(mode) + 1;
        const r = buf.sample(take, round, rng);
        for (let i = 0; i < r.samples.length; i++) {
          out.push(r.samples[i]);
          isW.push(r.isWeights[i]);
          indices.push(this.encodeIdx(bucketId, r.indices[i]));
        }
      }
    }

    return {
      samples: out,
      isWeights: Float32Array.from(isW),
      indices,
    };
  }

  updatePriorities(indices: number[], priorities: Float32Array): void {
    // Group by bucket so each underlying PER receives one batched update.
    const grouped = new Map<number, { idx: number[]; pri: number[] }>();
    for (let i = 0; i < indices.length; i++) {
      const { bucket, local } = this.decodeIdx(indices[i]);
      let g = grouped.get(bucket);
      if (!g) {
        g = { idx: [], pri: [] };
        grouped.set(bucket, g);
      }
      g.idx.push(local);
      g.pri.push(priorities[i]);
    }
    for (const [bucket, g] of grouped) {
      const buf = this.bucketFor(bucket);
      if (!buf) continue;
      buf.updatePriorities(g.idx, Float32Array.from(g.pri));
    }
  }

  private encodeIdx(bucket: number, local: number): number {
    return bucket * STRATIFIED_INDEX_STRIDE + local;
  }
  private decodeIdx(combined: number): { bucket: number; local: number } {
    return {
      bucket: Math.floor(combined / STRATIFIED_INDEX_STRIDE),
      local: combined % STRATIFIED_INDEX_STRIDE,
    };
  }
  private bucketFor(bucket: number): PrioritizedReplay | null {
    if (bucket === 0) return this.recent;
    const mode = this.modeOrder[bucket - 1];
    return mode ? this.perMode.get(mode) ?? null : null;
  }

  /**
   * Serialize. Format: 4-byte magic `"SRPL"` | int32 numModes |
   * for each mode: int32 nameLen | utf-8 name | recent-blob length-prefixed
   * | each per-mode blob length-prefixed. Sub-buffers use the existing
   * {@link PrioritizedReplay.serialize} format.
   */
  serialize(): Buffer {
    const magic = Buffer.from("SRPL");
    const nm = Buffer.alloc(4);
    nm.writeInt32LE(this.modeOrder.length, 0);
    const modeBlobs: Buffer[] = [];
    for (const mode of this.modeOrder) {
      const nameBuf = Buffer.from(mode, "utf8");
      const nameLen = Buffer.alloc(4);
      nameLen.writeInt32LE(nameBuf.length, 0);
      modeBlobs.push(nameLen, nameBuf);
    }
    const recentBlob = this.recent.serialize();
    const recentLen = Buffer.alloc(4);
    recentLen.writeInt32LE(recentBlob.length, 0);
    const perModeBlobs: Buffer[] = [];
    for (const mode of this.modeOrder) {
      const buf = this.perMode.get(mode)!;
      const b = buf.serialize();
      const len = Buffer.alloc(4);
      len.writeInt32LE(b.length, 0);
      perModeBlobs.push(len, b);
    }
    return Buffer.concat([magic, nm, ...modeBlobs, recentLen, recentBlob, ...perModeBlobs]);
  }

  /**
   * Inverse of {@link serialize}. Throws on a non-`"SRPL"` magic prefix
   * — old PER-only snapshots fall through to the caller, which rebuilds
   * an empty StratifiedReplay (the buffer fills naturally within a
   * day at the bot's ~3 rounds/min cadence).
   */
  static deserialize(buf: Buffer, opts: StratifiedReplayOptions): StratifiedReplay {
    const magic = buf.subarray(0, 4).toString("ascii");
    if (magic !== "SRPL") {
      throw new Error(`StratifiedReplay.deserialize: bad magic '${magic}', expected SRPL`);
    }
    const r = new StratifiedReplay(opts);
    let off = 4;
    const numModes = buf.readInt32LE(off); off += 4;
    const modeNames: string[] = [];
    for (let i = 0; i < numModes; i++) {
      const nameLen = buf.readInt32LE(off); off += 4;
      const name = buf.subarray(off, off + nameLen).toString("utf8");
      off += nameLen;
      modeNames.push(name);
    }
    const recentLen = buf.readInt32LE(off); off += 4;
    const recentSub = buf.subarray(off, off + recentLen);
    off += recentLen;
    const recentDeserialized = PrioritizedReplay.deserialize(recentSub, {
      capacity: opts.recentCapacity,
      alpha: opts.alpha,
      betaStart: opts.betaStart,
      betaEnd: opts.betaEnd,
      betaAnnealRounds: opts.betaAnnealRounds,
      uniformFraction: opts.recentUniformFraction,
      maxPerRoundInBatch: opts.maxPerRoundInBatch,
    });
    (r as unknown as { recent: PrioritizedReplay }).recent = recentDeserialized;
    for (const name of modeNames) {
      const len = buf.readInt32LE(off); off += 4;
      const sub = buf.subarray(off, off + len);
      off += len;
      const buckOpts = {
        capacity: opts.perModeCapacity,
        alpha: opts.alpha,
        betaStart: opts.betaStart,
        betaEnd: opts.betaEnd,
        betaAnnealRounds: opts.betaAnnealRounds,
        uniformFraction: opts.perModeUniformFraction,
        maxPerRoundInBatch: opts.maxPerRoundInBatch,
      };
      const bucket = PrioritizedReplay.deserialize(sub, buckOpts);
      r.perMode.set(name, bucket);
      r.modeOrder.push(name);
    }
    return r;
  }
}
