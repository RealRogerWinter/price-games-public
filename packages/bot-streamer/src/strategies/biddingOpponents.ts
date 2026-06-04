/**
 * Per-room online opponent posterior — Phase 3d.2.
 *
 * In a Quick Play bidding game the same 3 NPC opponents persist for
 * all 5 rounds. Each NPC is sampled (server-side, at room creation)
 * from a per-difficulty archetype mixture in
 * `apps/server/src/services/botPersonality.ts`. Their per-round bids
 * follow a log-Gaussian-mixture noise model around the true price.
 *
 * After each round we observe `(bid, actualPrice)` per opponent. The
 * residual `r = log(bid / actualPrice)` is a noisy sample of that
 * opponent's bias + sigma. We maintain a discrete posterior over the
 * 6 known archetypes and update it via Bayes after each round.
 *
 * The archetype params are duplicated from the server's
 * `BASE_PERSONALITIES` table — duplication is the right call here
 * because:
 *   1. The streamer-bot package is independently typechecked + built;
 *      a cross-import to `apps/server` would couple their build trees.
 *   2. The values are stable contract (changing them on the server
 *      would change the NPC behavior the streamer-bot is calibrated
 *      against — both files would update together regardless).
 *   3. The dependency direction matters: `apps/server` is the source
 *      of truth, this file mirrors it. A future test pins the values
 *      against the server's table.
 *
 * The tracker is per-game-scoped (room): instantiate at room enter,
 * `noteBid` on each `bid_placed` after that round's reveal, and
 * dispose on `game_over`.
 */

import type { BotDifficulty } from "@price-game/shared";

/** 6-state archetype label — mirrors `apps/server` BotArchetype. */
export type BotArchetype =
  | "expert"
  | "overbidder"
  | "lowballer"
  | "average-joe"
  | "wild-card"
  | "anchored";

const ARCHETYPES: ReadonlyArray<BotArchetype> = [
  "expert",
  "overbidder",
  "lowballer",
  "average-joe",
  "wild-card",
  "anchored",
];

/**
 * Per-archetype `(bias, σ_close)` table. Mirrors `BASE_PERSONALITIES`
 * in `apps/server/src/services/botPersonality.ts`. Bias is the
 * multiplicative log-mean; sigma is the close-component log-stddev.
 * The mixture's moderate + wild components get folded into a noise
 * floor in the likelihood (`SIGMA_FLOOR`) since the close component
 * is what dominates the posterior weight.
 */
const ARCHETYPE_PARAMS: Record<BotArchetype, { bias: number; sigma: number }> = {
  expert: { bias: 0.0, sigma: 0.08 },
  overbidder: { bias: 0.15, sigma: 0.15 },
  lowballer: { bias: -0.18, sigma: 0.18 },
  "average-joe": { bias: 0.05, sigma: 0.28 },
  "wild-card": { bias: 0.0, sigma: 0.60 },
  anchored: { bias: 0.0, sigma: 0.20 },
};

/**
 * Per-difficulty prior weights. Mirrors `ARCHETYPE_WEIGHTS` in the
 * server file. NPCs in a Quick Play room are drawn from these
 * weights; the tracker uses the same prior so round-1 likelihoods
 * have a sensible baseline.
 */
const ARCHETYPE_PRIOR: Record<BotDifficulty, Record<BotArchetype, number>> = {
  hard: {
    expert: 0.50,
    "average-joe": 0.20,
    overbidder: 0.15,
    lowballer: 0.10,
    anchored: 0.05,
    "wild-card": 0.00,
  },
  medium: {
    expert: 0.20,
    "average-joe": 0.30,
    overbidder: 0.20,
    lowballer: 0.15,
    anchored: 0.10,
    "wild-card": 0.05,
  },
  easy: {
    expert: 0.05,
    "average-joe": 0.25,
    overbidder: 0.15,
    lowballer: 0.15,
    anchored: 0.15,
    "wild-card": 0.25,
  },
};

/**
 * Lower bound on per-archetype σ used in the likelihood. Without a
 * floor, a wild-card archetype's σ=0.60 dominates so completely that
 * a single noisy bid resolves the posterior and we lose the
 * opportunity to update further. 0.10 is enough headroom that the
 * close component's likelihood doesn't go to zero on a tail draw.
 */
const SIGMA_FLOOR = 0.10;

/**
 * Posterior σ-floor (Phase 3d.2 panel guidance, "neuroscience PhD"):
 * after enough samples the posterior σ_estimate can drift
 * arbitrarily small, leading to over-confident bids that over-bid
 * on the next outlier. The floor caps how tight the posterior gets.
 */
const POSTERIOR_SIGMA_FLOOR = 0.15;

/** Internal per-opponent state. */
interface SlotState {
  /** Posterior over the 6 archetypes (sums to 1). */
  probs: Float32Array;
  /** Number of (bid, actual) observations folded in. */
  observed: number;
}

export interface OpponentSnapshot {
  playerId: string;
  archetypeProbs: ReadonlyArray<number>;
  /** Most-likely archetype (argmax). */
  topArchetype: BotArchetype;
  /** Posterior-weighted mean of archetype σ, floored at POSTERIOR_SIGMA_FLOOR. */
  estimatedSigma: number;
  /** Posterior-weighted mean of archetype bias. */
  estimatedBias: number;
  /** Number of observations folded in. */
  observed: number;
}

/**
 * Per-room online tracker over the 3 NPC opponents.
 *
 * Construct with the room's difficulty — that picks the prior. Then:
 *   - `noteBid({ playerId, bidCents, actualCents })` after each
 *     round's reveal updates the posterior.
 *   - `snapshot()` returns the current posteriors for the bidding
 *     decoder's Monte-Carlo simulation.
 */
export class OpponentTracker {
  private readonly slots = new Map<string, SlotState>();
  private readonly priorVec: Float32Array;

  constructor(public readonly difficulty: BotDifficulty = "medium") {
    const w = ARCHETYPE_PRIOR[difficulty] ?? ARCHETYPE_PRIOR.medium;
    this.priorVec = new Float32Array(ARCHETYPES.length);
    let s = 0;
    for (let i = 0; i < ARCHETYPES.length; i++) {
      this.priorVec[i] = Math.max(w[ARCHETYPES[i]] ?? 0, 1e-6);
      s += this.priorVec[i];
    }
    if (s > 0) {
      for (let i = 0; i < ARCHETYPES.length; i++) this.priorVec[i] /= s;
    }
  }

  /** True if we've never seen this opponent (for snapshot fallback). */
  private ensureSlot(playerId: string): SlotState {
    const existing = this.slots.get(playerId);
    if (existing) return existing;
    const fresh: SlotState = {
      probs: new Float32Array(this.priorVec),
      observed: 0,
    };
    this.slots.set(playerId, fresh);
    return fresh;
  }

  /**
   * Fold an observed (bid, actualPrice) pair into this opponent's
   * posterior. Idempotent only if the same (playerId, round) is
   * never noted twice — the caller (driver) is expected to enforce
   * this.
   */
  noteBid(args: { playerId: string; bidCents: number; actualCents: number }): void {
    const { playerId, bidCents, actualCents } = args;
    if (
      !Number.isFinite(bidCents)
      || !Number.isFinite(actualCents)
      || bidCents <= 0
      || actualCents <= 0
    ) {
      return;
    }
    const slot = this.ensureSlot(playerId);
    const r = Math.log(bidCents / actualCents);
    if (!Number.isFinite(r)) return;
    // Likelihood under each archetype: Gaussian PDF with mean=bias,
    // sigma=max(σ_arch, SIGMA_FLOOR). Drop the constant prefactor
    // since we renormalise.
    const post = new Float32Array(ARCHETYPES.length);
    let sum = 0;
    for (let a = 0; a < ARCHETYPES.length; a++) {
      const params = ARCHETYPE_PARAMS[ARCHETYPES[a]];
      const sigma = Math.max(params.sigma, SIGMA_FLOOR);
      const z = (r - params.bias) / sigma;
      const lik = Math.exp(-0.5 * z * z) / sigma;
      post[a] = slot.probs[a] * lik;
      sum += post[a];
    }
    if (sum <= 0 || !Number.isFinite(sum)) {
      // Pathological — likelihoods all zero (e.g. residual far in the
      // tail of every archetype). Keep the prior, increment observed.
      slot.observed += 1;
      return;
    }
    for (let a = 0; a < ARCHETYPES.length; a++) slot.probs[a] = post[a] / sum;
    slot.observed += 1;
  }

  /** Snapshot of the current per-opponent posteriors. */
  snapshot(playerIds: ReadonlyArray<string>): OpponentSnapshot[] {
    const out: OpponentSnapshot[] = [];
    for (const pid of playerIds) {
      const slot = this.ensureSlot(pid);
      let bestIdx = 0;
      let muSigma = 0;
      let muBias = 0;
      for (let a = 0; a < ARCHETYPES.length; a++) {
        if (slot.probs[a] > slot.probs[bestIdx]) bestIdx = a;
        const params = ARCHETYPE_PARAMS[ARCHETYPES[a]];
        muSigma += slot.probs[a] * params.sigma;
        muBias += slot.probs[a] * params.bias;
      }
      out.push({
        playerId: pid,
        archetypeProbs: Array.from(slot.probs),
        topArchetype: ARCHETYPES[bestIdx],
        estimatedSigma: Math.max(muSigma, POSTERIOR_SIGMA_FLOOR),
        estimatedBias: muBias,
        observed: slot.observed,
      });
    }
    return out;
  }

  /** Reset all posteriors back to the per-difficulty prior. */
  reset(): void {
    this.slots.clear();
  }
}

export const __opponentTrackerInternals = {
  ARCHETYPES,
  ARCHETYPE_PARAMS,
  ARCHETYPE_PRIOR,
  SIGMA_FLOOR,
  POSTERIOR_SIGMA_FLOOR,
};
