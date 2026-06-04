/**
 * Teaching Moments buffer — the streamer-bot's "aha" mechanic.
 *
 * Tracks samples that previously had loss > p90 *and* later resolved
 * within `recoveryPct` of the actual price. Such "recoveries" replay
 * `replayMultiplier`× extra over the next `decayRounds` rounds, and a
 * one-shot `triggered` flag is forwarded to the broadcast overlay so
 * viewers see an explicit "I just learned this!" indicator.
 *
 * Inspired by Forgetting Events (Toneva 2019) — but inverted for
 * entertainment value: the goal is producing visible, watchable
 * moments, not optimal sample weighting.
 */

import type { Sample } from "./types";

export interface TeachingMomentEntry {
  sample: Sample;
  recordedAtRound: number;
  /** Replays remaining (counts down on each draw). */
  replaysRemaining: number;
  /** Beyond this round the entry is dropped. */
  decayUntilRound: number;
}

export interface TeachingMomentsOptions {
  capacity: number;
  /** ≤ this fractional residual counts as a recovery. */
  recoveryPct: number;
  /** Per-recovery extra replays. */
  replayMultiplier: number;
  /** How many rounds an entry persists after creation. */
  decayRounds: number;
}

export class TeachingMoments {
  readonly opts: TeachingMomentsOptions;
  private entries: TeachingMomentEntry[] = [];

  constructor(opts: TeachingMomentsOptions) {
    this.opts = opts;
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Observe a sample post-update.
   *
   * @param sample          The sample after the update step.
   * @param lossThisRound   The current per-sample loss (for triggering).
   * @param p90Loss         The 90th-percentile loss across this update's
   *                        minibatch. The sample qualifies as a teaching
   *                        moment when its previous-round loss was above
   *                        this AND its current residual is within
   *                        `recoveryPct`.
   * @param wasPreviouslyHighLoss Caller-supplied flag — see worker.ts
   *                              for how it's tracked.
   * @param currentRound     Round counter.
   * @returns true if a moment was added (= `triggered` flag).
   */
  observe(
    sample: Sample,
    lossThisRound: number,
    _p90Loss: number,
    wasPreviouslyHighLoss: boolean,
    currentRound: number,
  ): boolean {
    if (!wasPreviouslyHighLoss) return false;
    // Recovery test: `|lossThisRound| ≤ recoveryPct`. The original
    // semantics (pre-PR-#282) were "log-residual ≤ 5% factor", but the
    // loss path was switched to ordinal-smoothed CE without re-tuning
    // this trigger. The CE floor is ≥ ~1 nat (smoothing-kernel entropy)
    // so any sub-1 recoveryPct is unreachable. Documented here so the
    // next reader understands why the trigger appears dormant; Phase 3
    // of the NN recovery plan reformulates the loss surface and will
    // restore meaningful teaching-moment semantics in the same change.
    const recovered = Math.abs(lossThisRound) <= this.opts.recoveryPct;
    if (!recovered) return false;
    const entry: TeachingMomentEntry = {
      sample,
      recordedAtRound: currentRound,
      replaysRemaining: this.opts.replayMultiplier,
      decayUntilRound: currentRound + this.opts.decayRounds,
    };
    this.entries.push(entry);
    if (this.entries.length > this.opts.capacity) {
      // Drop the oldest entry.
      this.entries.shift();
    }
    return true;
  }

  /**
   * Draw up to `n` samples from the teaching-moments buffer for replay.
   * Decrements `replaysRemaining` for each. Drops entries whose
   * `replaysRemaining` reaches zero or whose `decayUntilRound` has
   * passed.
   *
   * @param currentRound Round counter (drives expiry).
   * @param n            Maximum number of samples to draw.
   * @param rng          U[0,1) RNG.
   */
  drawForReplay(currentRound: number, n: number, rng: () => number): Sample[] {
    // Drop expired entries first.
    this.entries = this.entries.filter((e) => e.decayUntilRound >= currentRound && e.replaysRemaining > 0);
    if (this.entries.length === 0 || n <= 0) return [];
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) {
      if (this.entries.length === 0) break;
      const pick = Math.floor(rng() * this.entries.length);
      const entry = this.entries[pick];
      out.push(entry.sample);
      entry.replaysRemaining -= 1;
      if (entry.replaysRemaining <= 0) {
        this.entries.splice(pick, 1);
      }
    }
    return out;
  }

  /** JSON-encode buffer state. Compact since bounded to ~32 entries × ~700 B = ~22 KB. */
  serialize(): Buffer {
    const json = JSON.stringify(
      this.entries.map((e) => ({
        sample: {
          features: Array.from(e.sample.features),
          targetLogResidual: e.sample.targetLogResidual,
          actualCents: e.sample.actualCents,
          heuristicCents: e.sample.heuristicCents,
          categoryId: e.sample.categoryId,
          brandTier: e.sample.brandTier,
          mode: e.sample.mode,
          productId: e.sample.productId,
          roundId: e.sample.roundId,
          recordedAtRound: e.sample.recordedAtRound,
        },
        recordedAtRound: e.recordedAtRound,
        replaysRemaining: e.replaysRemaining,
        decayUntilRound: e.decayUntilRound,
      })),
    );
    return Buffer.from(json, "utf8");
  }

  static deserialize(buf: Buffer, opts: TeachingMomentsOptions): TeachingMoments {
    const tm = new TeachingMoments(opts);
    const parsed = JSON.parse(buf.toString("utf8")) as Array<{
      sample: TeachingMomentEntry["sample"] & { features: number[] };
      recordedAtRound: number;
      replaysRemaining: number;
      decayUntilRound: number;
    }>;
    tm.entries = parsed.map((p) => ({
      sample: { ...p.sample, features: new Float32Array(p.sample.features) },
      recordedAtRound: p.recordedAtRound,
      replaysRemaining: p.replaysRemaining,
      decayUntilRound: p.decayUntilRound,
    }));
    return tm;
  }
}
