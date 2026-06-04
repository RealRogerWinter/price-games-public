/**
 * Kendall & Gal (2018) homoscedastic uncertainty weighting for the
 * streamer-bot's multi-task NN. Resurrected for Phase 3b after PR #290
 * deleted the pre-Phase-3 implementation alongside the multi-task
 * heads.
 *
 * Background. With multiple per-task losses `L_t` summed naïvely
 * (`L = Σ L_t`), tasks whose loss has larger natural magnitude
 * dominate the gradient regardless of how informative they are. K&G
 * frame each task's loss as the negative log-likelihood of an
 * independent Gaussian with task-specific variance σ²_t and let σ²_t
 * be a learnable parameter:
 *
 *   L = Σ_t [ L_t / (2 σ²_t)  +  ½ log σ²_t ]
 *
 * The `½ log σ²_t` regularises σ² away from infinity (which would
 * trivially zero the loss); the `1/(2 σ²)` factor lets the model
 * down-weight tasks whose loss is structurally noisy. We
 * parameterise `s_t = log σ²_t` directly to keep σ² positive and
 * make the gradient well-behaved.
 *
 * Stability mitigations from the Phase 1 reviewer.
 *   * For the first {@link FIXED_PHASE_ROUNDS} rounds, K&G is *frozen*
 *     and the combine path uses hand-picked fixed weights. With sparse
 *     per-mode coverage early on, K&G's σ² updates are too noisy to be
 *     trustworthy and tend to drive auxiliary heads' weights to
 *     extremes before the trunk has any signal at all.
 *   * After the fixed phase ends, σ² unfreezes — but each task's σ²
 *     stays at its fixed-phase value until that task has fired in at
 *     least {@link MIN_TASK_OBSERVATIONS} rounds. A task that fires
 *     only when one mode rotates through (price-match shows up
 *     ~10% of the time live) never gets enough updates to converge
 *     before this gate clears.
 *
 * Persistence. The class round-trips via `serialize` / `deserialize`
 * — `logSigma2`, `tasksObserved`, and `roundsObserved` are written
 * into the `nn_snapshots.uncertainty_weights` BLOB so a worker
 * restart resumes at the same K&G state. Format is a Float32Array
 * header (`numTasks`, `roundsObserved`) followed by `numTasks`
 * floats of `logSigma2` and `numTasks` int32s of `tasksObserved`.
 *
 * The numerical-gradient cross-check lives in
 * `tests/learning/uncertaintyWeighting.test.ts`.
 */

import { NUM_ACTIVE_TASKS } from "./types";

/**
 * Stable index of each per-task loss within the K&G slot vector.
 *
 * Order is contractual — `serialize` writes `logSigma2` in this order
 * and `deserialize` reads it back the same way. Adding a task
 * requires bumping {@link NUM_ACTIVE_TASKS} AND
 * {@link ModelSpec.headTopologyVersion} so old snapshots auto-archive
 * cleanly via the archHash mismatch path.
 *
 * v2 (Phase 3d.2): drop priceMatchPair + budgetSelect (modes removed),
 * add pinballQ40 (bidding-only quantile loss at τ=0.4). Renumbered
 * to keep the kept tasks compact:
 *
 *   0 — pairLogit       (higher-lower, comparison)
 *   1 — squashedReg     (classic, bidding)
 *   2 — pinballQ40      (bidding only — robustness floor for the decoder)
 *   3 — priceClass      (auxiliary 103-way softmax; primary across all modes)
 *   4 — logPrice        (auxiliary Gaussian NLL on log-cents)
 */
export const TASK_INDEX = Object.freeze({
  pairLogit: 0,
  squashedReg: 1,
  pinballQ40: 2,
  priceClass: 3,
  logPrice: 4,
} as const);

export type TaskName = keyof typeof TASK_INDEX;

/**
 * Initial fixed-phase weights. Each slot's value is load-bearing —
 * keep this rationale block in sync if the values change.
 *
 *  - **pairLogit (1.0)**: parity with pre-3b's gradient magnitude on
 *    comparison rounds. Below 1.0 the head wouldn't track its own
 *    BCE signal at the rate the trunk needs to discriminate ordinal
 *    pairs; above 1.0 the head's grad swamps priceClass on the
 *    minority of rounds where both fire.
 *  - **squashedReg (1.0)**: parity with pre-3b on classic + bidding
 *    rounds. Continuous regression on log-cents, so 1.0 is roughly
 *    half of priceClass's pre-demotion contribution per sample.
 *  - **pinballQ40 (0.3)**: Phase 3d.2 ramp protection. Bidding rounds
 *    are a minority of rotation; the head's grad magnitude at first
 *    touch is bounded by residual log-cents (typically |Lt| < 1).
 *    Pairing 0.3 with `BIDDING_INIT_LOG_SIGMA2=2.0` makes the slot
 *    contribute ~0.02 in the first 100 minibatches — the same
 *    ramp-to-full-influence-only-after-MIN_TASK_OBSERVATIONS pattern
 *    PR #322 used for pairLogit.
 *  - **priceClass (0.4)**: **Phase 3e.1: 1.0 → 0.4.** The 3-reviewer
 *    NN debate (`~/.claude/plans/taut-unblocking-trunk.md`) found that
 *    priceClass alone was producing ~50-65% of the trunk's gradient
 *    mass — a 103-way softmax with tiny init that the optimiser
 *    couldn't sharpen because the 0.3 clip was binding. Demoting frees
 *    trunk-gradient budget for pair / squashedReg / pinballQ40 (the
 *    heads modes actually consume). The head stays in the network:
 *    BeliefCard, the bidding centerpoint, and the comparison fallback
 *    all read its argmax. Logically priceClass becomes a regularising
 *    auxiliary, not the primary trunk-shaping objective.
 *  - **logPrice (0.1)**: auxiliary calibration objective on every
 *    sample, additive to whichever primary head fires. Kept low so
 *    its always-on signal doesn't dominate the per-mode primaries.
 *
 * Once the fixed phase ends (FIXED_PHASE_ROUNDS=500 post-3e.1) the
 * K&G formula takes over and `logSigma2` starts at 0 (σ² = 1).
 */
export const FIXED_TASK_WEIGHTS: ReadonlyArray<number> = [
  1.0, // pairLogit
  1.0, // squashedReg
  // Phase 3d.2: pinballQ40 starts at 0.3 fixed weight. Bidding rounds
  // are a minority of the rotation; the head's gradient magnitude at
  // first touch is bounded by the residual log-cents (typically |Lt|
  // < 1) — pairing 0.3 with the high-init logSigma2 (see
  // BIDDING_INIT_LOG_SIGMA2 below) means the slot effectively
  // contributes ~0.02 to the first 100 minibatches. That's the same
  // protection Phase 3d.1 used for pairLogit: ramp to full influence
  // only after MIN_TASK_OBSERVATIONS clears.
  0.3, // pinballQ40 — bidding-only safe-bid quantile
  0.4, // priceClass — Phase 3e.1: demoted from 1.0; see header comment
  0.1, // logPrice — auxiliary on every sample
];

/**
 * Phase 3d.2: initial `logSigma2` for the new pinballQ40 slot.
 * σ² = e^2 ≈ 7.4 → first-touch combine multiplier 1/(2σ²) ≈ 0.07.
 * Initialising high mirrors the protection added in PR #322 for the
 * grad-explosion-prone heads — the slot un-freezes naturally as
 * tasksObserved climbs and the K&G branch starts driving logSigma2
 * down toward the data's actual noise floor.
 *
 * Constructor uses this only on a *fresh* instance (no snapshot to
 * deserialize); resumed states keep their persisted value.
 */
export const BIDDING_INIT_LOG_SIGMA2 = 2.0;

/**
 * Number of total rounds (per the worker's `round` counter) before the
 * fixed-phase weights yield to learnable K&G σ². Below this the
 * combine path uses {@link FIXED_TASK_WEIGHTS} verbatim and σ²
 * gradient is suppressed.
 *
 * Phase 3d.2 (v2): 2000 → 3000 to give K&G slots more margin before
 * σ² started moving on partly-empty replay buckets after the archHash
 * wipe.
 *
 * Phase 3e.1: **3000 → 500**. The 3000-round phase had never actually
 * completed in any production model lineage — every architectural PR
 * wiped before round 3000, so K&G uncertainty weighting had been
 * effectively dead code for the entire history of the system. The
 * fixed weights `[1, 1, 0.3, 1, 0.1]` were also clearly miscalibrated
 * (priceClass dominated trunk-gradient flow at ~50-65% of mass).
 * Lowering the phase to 500 lets K&G start adapting weights once the
 * `MIN_TASK_OBSERVATIONS=100` per-task gate accumulates enough
 * samples per head — which it does well within 500 rounds at the
 * 130-150 rounds/hr cadence we see in prod.
 */
export const FIXED_PHASE_ROUNDS = 500;

/**
 * Per-task minimum-rounds-before-engages gate. A task that has fired
 * fewer than this many rounds keeps its σ² frozen at the fixed-phase
 * value (logSigma2 = 0 ⇒ σ² = 1) regardless of round counter. This
 * avoids the case where a rare mode (price-match shows ~10% live) has
 * its σ² jerked around by a handful of noisy gradients.
 */
export const MIN_TASK_OBSERVATIONS = 100;

/** Bounds on log σ² — clamped after every update to avoid runaway. */
export const LOG_SIGMA2_MIN = -4;
export const LOG_SIGMA2_MAX = 4;

/** Header size of the serialised blob (numTasks + roundsObserved). */
const HEADER_FLOATS = 2;

/**
 * Combined-loss output. `loss` is the scalar to backpropagate;
 * `gradPerTask` are the multipliers that should scale each task's
 * upstream gradient (a task's `dL/d(params)` chain-rule starts from
 * `gradPerTask[t] · dLossPerTask[t]/d(params)`); `dLogSigma2` is the
 * gradient w.r.t. each task's log σ² that the caller applies to the
 * Adam-managed slot vector.
 */
export interface CombineResult {
  /** Combined scalar loss. */
  loss: number;
  /**
   * Per-task scaling factor on the upstream gradient. For the K&G
   * branch this is `1 / (2 · σ²_t)`; for the fixed-phase branch this
   * is the hand-picked weight `w_t`. Length === numTasks; entries for
   * tasks not in `taskMask` are 0.
   */
  gradPerTask: Float32Array;
  /**
   * `dL / d log σ²_t` per task. Used by the Adam optimizer to step
   * `logSigma2`. 0 for tasks that didn't fire (`taskMask[t] === 0`)
   * AND for tasks frozen by the fixed-phase or min-observations
   * gates — those slots see no gradient and don't move.
   */
  dLogSigma2: Float32Array;
}

/** Optional opts for {@link UncertaintyWeights.combine}. */
export interface CombineOpts {
  /**
   * The current global round counter from {@link WorkerCore}. Drives
   * the fixed-phase gate. Required — a missing/0 round defaults to
   * fixed-phase, which is the safe behaviour during tests.
   */
  round: number;
}

/**
 * Per-task uncertainty weighting (Kendall & Gal 2018).
 *
 * Slot vector size is fixed at construction (matches
 * {@link NUM_ACTIVE_TASKS}). The class is mutated in-place by
 * {@link applyGradient} after the optimizer has computed the K&G
 * step.
 */
export class UncertaintyWeights {
  /** Number of per-task slots. Stable for the lifetime of the class. */
  readonly numTasks: number;
  /** `log σ²` per task. Adam steps this via {@link applyGradient}. */
  readonly logSigma2: Float32Array;
  /** Cumulative count of rounds in which each task fired. */
  readonly tasksObserved: Int32Array;
  /** Cumulative count of all rounds the class has seen `combine`. */
  roundsObserved: number;

  /**
   * Construct fresh K&G state. All `logSigma2` start at 0 (σ² = 1)
   * and `tasksObserved` at 0; pass {@link deserialize} a snapshot
   * blob to resume from disk instead.
   *
   * @param numTasks Slot count — must equal {@link NUM_ACTIVE_TASKS}.
   */
  constructor(numTasks: number = NUM_ACTIVE_TASKS) {
    if (numTasks !== NUM_ACTIVE_TASKS) {
      throw new Error(
        `UncertaintyWeights: numTasks=${numTasks} != NUM_ACTIVE_TASKS=${NUM_ACTIVE_TASKS}`,
      );
    }
    this.numTasks = numTasks;
    this.logSigma2 = new Float32Array(numTasks);
    // Phase 3d.2: pinballQ40 starts σ²≈7.4 so the head's first-touch
    // gradient is heavily down-weighted while the trunk is still
    // building a price prior on bidding samples. Other slots stay at
    // 0 (σ² = 1) so existing modes keep pre-3d.2 behavior.
    this.logSigma2[TASK_INDEX.pinballQ40] = BIDDING_INIT_LOG_SIGMA2;
    this.tasksObserved = new Int32Array(numTasks);
    this.roundsObserved = 0;
  }

  /**
   * Combine per-task losses into a single scalar with per-task
   * gradient multipliers.
   *
   * Behaviour depends on round-counter and per-task observation
   * counts (see class-level docstring):
   *
   *   - Fixed phase (round < {@link FIXED_PHASE_ROUNDS}): use
   *     {@link FIXED_TASK_WEIGHTS}. `dLogSigma2` is all-zero so K&G
   *     state doesn't move while signal is sparse.
   *   - K&G phase: per task `t` that has fired ≥
   *     {@link MIN_TASK_OBSERVATIONS} rounds, use
   *     `1/(2 σ²_t) · L_t + ½ log σ²_t`. Tasks below the gate keep
   *     fixed weights and frozen σ² regardless of phase.
   *
   * `taskMask[t] === 0` means that task DID NOT FIRE this round —
   * its loss contributes 0 to the combined scalar, its
   * `gradPerTask` slot is 0, and its observation counter is NOT
   * incremented. (`tasksObserved` only updates on real firings.)
   *
   * @param losses    Float32Array of length numTasks. Per-task scalar
   *                  losses for THIS round/minibatch. Slots for
   *                  inactive tasks should be 0 (and `taskMask` 0).
   * @param taskMask  Uint8Array of length numTasks. 1 = task fired
   *                  this round; 0 = inactive.
   * @param opts      `round` for the fixed-phase gate.
   * @returns         {@link CombineResult}.
   */
  combine(losses: Float32Array, taskMask: Uint8Array, opts: CombineOpts): CombineResult {
    if (losses.length !== this.numTasks) {
      throw new Error(`combine: losses.length=${losses.length} != numTasks=${this.numTasks}`);
    }
    if (taskMask.length !== this.numTasks) {
      throw new Error(`combine: taskMask.length=${taskMask.length} != numTasks=${this.numTasks}`);
    }
    const gradPerTask = new Float32Array(this.numTasks);
    const dLogSigma2 = new Float32Array(this.numTasks);
    let combined = 0;
    const fixedPhase = opts.round < FIXED_PHASE_ROUNDS;
    for (let t = 0; t < this.numTasks; t++) {
      if (taskMask[t] === 0) continue;
      const Lt = losses[t];
      // Defensive: a non-finite per-task loss (e.g. from a degenerate
      // forward not yet caught by the round's NaN-rollback gate)
      // would propagate through the K&G arithmetic into `logSigma2[t]`,
      // which the clamp does NOT heal — `Math.max/min` on NaN returns
      // NaN. Once a task slot's `logSigma2` is NaN, every subsequent
      // combine call for that task emits NaN gradients/multipliers,
      // poisoning the slot until snapshot reload. Skip the slot
      // entirely instead — same semantics as `taskMask[t] === 0`.
      if (!Number.isFinite(Lt)) continue;
      const observed = this.tasksObserved[t];
      const useKG = !fixedPhase && observed >= MIN_TASK_OBSERVATIONS;
      if (!useKG) {
        // Fixed-weight branch. logSigma2 left untouched.
        const w = FIXED_TASK_WEIGHTS[t];
        combined += w * Lt;
        gradPerTask[t] = w;
        // dLogSigma2[t] = 0 — K&G slot frozen.
      } else {
        // K&G branch.
        const s = this.logSigma2[t]; // log σ²
        const sigma2 = Math.exp(s);
        const invHalfSigma2 = 1 / (2 * sigma2);
        // L = L_t / (2σ²) + ½·log σ²
        combined += invHalfSigma2 * Lt + 0.5 * s;
        gradPerTask[t] = invHalfSigma2;
        // d/ds of [L_t / (2 e^s) + ½·s] = −L_t / (2 e^s) + ½
        //                              = ½ − L_t · invHalfSigma2
        dLogSigma2[t] = 0.5 - invHalfSigma2 * Lt;
      }
    }
    return { loss: combined, gradPerTask, dLogSigma2 };
  }

  /**
   * Apply a learning-rate-scaled gradient step to `logSigma2`.
   *
   * `dLogSigma2` is the value returned from {@link combine}; the
   * caller is expected to have already scaled it by the chosen
   * learning rate (typically the same lr Adam uses on net params,
   * sometimes 0.1× — kept caller-side so this class doesn't have an
   * Adam dependency). Each slot is clamped to
   * `[LOG_SIGMA2_MIN, LOG_SIGMA2_MAX]` after the step.
   *
   * @param scaledGradLogSigma2 Pre-scaled gradient per task slot.
   */
  applyGradient(scaledGradLogSigma2: Float32Array): void {
    if (scaledGradLogSigma2.length !== this.numTasks) {
      throw new Error(
        `applyGradient: length=${scaledGradLogSigma2.length} != numTasks=${this.numTasks}`,
      );
    }
    for (let t = 0; t < this.numTasks; t++) {
      const next = this.logSigma2[t] - scaledGradLogSigma2[t];
      // `Math.max(MIN, Math.min(MAX, NaN)) === NaN` — the clamp does
      // not heal a non-finite step. Skip the update so the slot stays
      // at its prior (still finite) value. Combined with the
      // non-finite `Lt` guard in {@link combine}, NaN gradients can't
      // pin a task slot's σ² to NaN for the rest of the session.
      if (!Number.isFinite(next)) continue;
      this.logSigma2[t] = Math.max(LOG_SIGMA2_MIN, Math.min(LOG_SIGMA2_MAX, next));
    }
  }

  /**
   * Increment per-task observation counters and the global round
   * counter. Call once per round AFTER combine — sequencing matters
   * for the {@link MIN_TASK_OBSERVATIONS} gate (combine uses the
   * pre-increment count so the gate transitions cleanly).
   */
  noteRoundObserved(taskMask: Uint8Array): void {
    if (taskMask.length !== this.numTasks) {
      throw new Error(
        `noteRoundObserved: taskMask.length=${taskMask.length} != numTasks=${this.numTasks}`,
      );
    }
    this.roundsObserved += 1;
    for (let t = 0; t < this.numTasks; t++) {
      if (taskMask[t] !== 0) this.tasksObserved[t] += 1;
    }
  }

  /**
   * Serialize state into a Buffer suitable for the snapshot's
   * `uncertainty_weights` BLOB column.
   *
   * Layout (little-endian, all 32-bit):
   *   [0]   float32  numTasks (sentinel; on load mismatch ⇒ reset)
   *   [1]   uint32   roundsObserved
   *   [2 .. 2+numTasks)               float32  logSigma2[t]
   *   [2+numTasks .. 2+2·numTasks)    int32    tasksObserved[t]
   */
  serialize(): Buffer {
    const totalFloats = HEADER_FLOATS + 2 * this.numTasks;
    const flat = new Float32Array(totalFloats);
    flat[0] = this.numTasks;
    // Reuse the second header slot as a uint32 — bitcast via the
    // underlying ArrayBuffer's Uint32 view so the value is stored
    // exactly.
    const u32 = new Uint32Array(flat.buffer, flat.byteOffset, flat.length);
    u32[1] = this.roundsObserved >>> 0;
    flat.set(this.logSigma2, HEADER_FLOATS);
    // Pack tasksObserved as int32 in the trailing slots — same bit
    // pattern via the int32 view.
    const i32 = new Int32Array(flat.buffer, flat.byteOffset, flat.length);
    for (let t = 0; t < this.numTasks; t++) {
      i32[HEADER_FLOATS + this.numTasks + t] = this.tasksObserved[t];
    }
    return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  }

  /**
   * Inverse of {@link serialize}. On any inconsistency (wrong size,
   * numTasks mismatch with current spec) returns a fresh instance —
   * the class is meant to survive corruption gracefully because
   * losing K&G state just resets the per-task weights to fixed-phase
   * values, which is the same as a cold start.
   */
  static deserialize(buf: Buffer): UncertaintyWeights {
    const out = new UncertaintyWeights();
    if (!buf || buf.length === 0) return out;
    const expectedBytes = (HEADER_FLOATS + 2 * NUM_ACTIVE_TASKS) * 4;
    if (buf.length !== expectedBytes) return out;
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const i32 = new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    if (flat[0] !== NUM_ACTIVE_TASKS) return out;
    out.roundsObserved = u32[1];
    for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
      const s = flat[HEADER_FLOATS + t];
      // Defensive: clamp on load. A persisted out-of-range value
      // would otherwise destabilise the very first combine call.
      out.logSigma2[t] = Number.isFinite(s)
        ? Math.max(LOG_SIGMA2_MIN, Math.min(LOG_SIGMA2_MAX, s))
        : 0;
      const obs = i32[HEADER_FLOATS + NUM_ACTIVE_TASKS + t];
      out.tasksObserved[t] = obs >= 0 ? obs : 0;
    }
    return out;
  }
}
