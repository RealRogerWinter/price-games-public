/**
 * WorkerCore — the actual learning logic, separated from the
 * worker_threads message-loop wrapper so it can be unit-tested
 * synchronously.
 *
 * Responsibilities:
 *   - Owns the network (trunk + priceClassHead), optimizer, normalizer,
 *     replay buffer, teaching moments, OOD blender, persistence, NDJSON
 *     logger, golden eval, brand-tier table.
 *   - Implements `predict(req)` and `update(req)` synchronously.
 *   - Tracks the round counter, accuracy dots, per-round losses, and
 *     trunk gradient norms.
 *   - Handles snapshot scheduling, NaN-guard rollback, and heartbeat
 *     statistics.
 *
 * As of 2026-05-06 (PR #4) the network is single-task — the
 * canonical-prices classifier — and the multi-task auxiliary heads
 * (β-NLL price, sigmoid-BCE pair, softmax-CE category/tier, viz) and
 * their associated GradVac-lite + uncertainty-weighting plumbing have
 * been ripped. Old multi-task snapshots auto-archive on next start
 * via the existing arch-hash mismatch path.
 *
 * The class deliberately doesn't import worker_threads — the wrapper in
 * worker.ts handles that. This keeps WorkerCore unit-testable.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { archHash, DEFAULT_ARCH_HASH } from "./archHash";
import { estimatePriceCents } from "../heuristics/priceEstimator";
import { AdamW, type AdamWOptions } from "./adamw";
import { BrandTierTable } from "./brandTierTable";
import { extractFeatures, FEATURE_NAMES } from "./featureExtractor";
import { GoldenEvalSet } from "./goldenEval";
import {
  applyReluMaskInPlace,
  backwardFilm,
  backwardLinear,
  backwardLogPrice,
  backwardPairLogit,
  backwardPinballQ40,
  backwardSquashedReg,
  checkFinite,
  adaptiveClipGradientsInPlace,
  clipGradientsInPlace,
  createFilmScratch,
  createNetwork,
  type FilmScratch,
  flattenParams,
  forwardFilm,
  forwardLinear,
  forwardLogPrice,
  forwardPairLogit,
  forwardPinballQ40,
  forwardSquashedReg,
  forwardTrunk,
  iterParamBuffers,
  loadFlatParams,
  pairLogitScalarFeatures,
  paramCount,
  reluMask,
  type Network,
} from "./mlp";
import {
  betaNLL,
  ordinalSmoothedCE,
  pinballLoss,
  sigmoidBCE,
  smoothL1,
  softmax,
} from "./losses";
import {
  BIDDING_INIT_LOG_SIGMA2,
  FIXED_PHASE_ROUNDS,
  FIXED_TASK_WEIGHTS,
  MIN_TASK_OBSERVATIONS,
  TASK_INDEX,
  UncertaintyWeights,
} from "./uncertaintyWeighting";
import { arousalGainFor, signedCreditGain } from "../persona/moodScale";
import { NdjsonLogger } from "./ndjsonLogger";
import { Normalizer } from "./normalizer";
import { OODBlender } from "./oodBlender";
import { LearningPersistence } from "./persistence";
import { buildDefaultCatalog, type PriceCatalog } from "./priceCatalog";
import { StratifiedReplay } from "./replayBuffer";
import { TeachingMoments } from "./teachingMoments";
import {
  CATEGORY_BUCKETS,
  EMBEDDING_DIM,
  FEATURE_DIM,
  GAME_MODE_ORDER,
  type LearningHealthBlock,
  MODEL_SPEC,
  NUM_ACTIVE_TASKS,
  NUM_GAME_MODES,
  type PredictReq,
  type PredictRes,
  type Sample,
  TRUNK_HIDDEN_DIM,
  type UpdateReq,
  type VisualTick,
} from "./types";
import { adaptiveEpsilon, MODE_EPSILON_MULTIPLIER, thompsonDraw } from "./thompsonSampler";
import { tryWarmStartFromArchive } from "./warmStart";
import { buildTick, encodeTick } from "./visualState";

/**
 * Phase 3c: gradient + per-task-loss extras produced by the round-
 * coherent training step and folded into the per-sample minibatch
 * step's accumulators on the final inner step.
 *
 *   - `grads[i]` matches `iterParamBuffers` order, same shape as
 *     `runMinibatchStep`'s internal per-buffer accumulator.
 *   - `perTaskLossSum[t]` and `perTaskCount[t]` follow `TASK_INDEX`
 *     conventions; downstream K&G observation accounting reads them.
 */
interface RoundCoherentExtras {
  grads: Float32Array[];
  perTaskLossSum: Float32Array;
  perTaskCount: Int32Array;
}

/** Tunable knobs — env-driven overrides happen in worker.ts. */
export interface WorkerCoreOptions {
  dataDir: string;
  snapshotInterval: number;
  replayCapacity: number;
  /** Capacity of the recent FIFO ring (Phase 1 stratified replay). */
  replayRecentCapacity: number;
  /** Fraction of each minibatch drawn from the recent ring (Phase 1). */
  replayRecentSampleFraction: number;
  /** Recent-ring uniform-mixin (typically 0.5 — much higher than per-mode). */
  replayRecentUniformFraction: number;
  perAlpha: number;
  perBetaStart: number;
  perBetaEnd: number;
  perBetaAnnealRounds: number;
  perUniformFraction: number;
  maxPerRoundInBatch: number;
  batchSize: number;
  stepsPerRound: number;
  /** AdamW hyperparams. */
  adamw: AdamWOptions;
  teachingMomentRecoveryPct: number;
  teachingMomentReplayMult: number;
  teachingMomentDecayRounds: number;
  teachingCapacity: number;
  /** Adaptive ε floor schedule. */
  epsilonFloorStart: number;
  epsilonFloorEnd: number;
  epsilonDecayRounds: number;
  /**
   * FiLM mood-conditioning gate. 0 → FiLM forward is skipped on
   * every predict / train step (provably identity, no params learn);
   * 1 → full bounded modulation (γ ∈ [0.9, 1.1], β ∈ [-0.1, 0.1]).
   * Out-of-range is clamped silently. Threaded through from
   * `PersonaProfile.moodInfluence`; the worker default matches the
   * persona default (1 — live) so a test that constructs
   * `new WorkerCore({ dataDir })` without specifying this exercises
   * the same code path as production. Tests that need the inert
   * baseline pass `moodInfluence: 0` explicitly.
   */
  moodInfluence: number;
  /**
   * Phase 3e.3: AGC clipping parameter. Each parameter buffer's grad
   * is clipped by `min(1, agcLambda * ||W|| / ||g||)` before the
   * global L2 clip. 0 disables AGC entirely (fall back to global L2
   * clip alone — pre-3e.3 behaviour). Default {@link AGC_LAMBDA_DEFAULT}
   * = 0.1, env-overridable via `NN_AGC_LAMBDA_OVERRIDE`. Tests that
   * specifically exercise the divergence-rollback gate pass 0 to
   * keep AGC out of the pipeline.
   */
  agcLambda: number;
  /** Random seed (deterministic tests; default Math.random). */
  rng?: () => number;
}

const DEFAULT_OPTS: WorkerCoreOptions = {
  dataDir: "/var/streamer/data",
  snapshotInterval: 100,
  // Phase 1 stratified replay: `replayCapacity` is now the per-mode
  // bucket capacity (one bucket per game mode, lazily created). Recent
  // FIFO ring is sized separately at `replayRecentCapacity`. Total
  // capacity grows with the number of active modes; for the bot's 5-6
  // active modes that's ≈ 256·5 + 512 ≈ 1800 (was a flat 512).
  replayCapacity: 256,
  replayRecentCapacity: 512,
  replayRecentSampleFraction: 0.25,
  replayRecentUniformFraction: 0.5,
  perAlpha: 0.5,
  perBetaStart: 0.4,
  perBetaEnd: 1.0,
  perBetaAnnealRounds: 5000,
  perUniformFraction: 0.2,
  maxPerRoundInBatch: 2,
  batchSize: 16,
  stepsPerRound: 6,
  adamw: {
    lr: 1e-3,
    beta1: 0.9,
    // Phase 1: 0.99 → 0.999. With 0.99, v̂ has an effective window of
    // ~100 steps; after a grad spike `√v̂` jumps and suppresses the
    // next ~100 steps then decays out and the next spike re-amplifies.
    // 0.999 (window ~1000) smooths the v̂ response so spikes are
    // absorbed instead of triggering oscillation.
    beta2: 0.999,
    eps: 1e-8,
    // Phase 3e.1: 1e-4 → 0. With Phase 3d.1's tight clip (0.3) WD's
    // deterministic per-step shrink (`lr · wd · θ`) was small but
    // non-zero against an effectively-zero clipped-grad signal,
    // producing slow drift toward zero on heads whose gradient was
    // chronically clip-saturated (priceClass 103-class softmax in
    // particular). With Phase 3e.1's 3.0 ceiling the optimiser
    // signal returns to "Adam-shaped" magnitude, so re-introducing
    // a small WD makes sense again — but we ship 0 first to isolate
    // the optimiser-unblock effect and avoid two simultaneous
    // changes muddying the post-deploy MAE trajectory.
    // TODO(claude, 2026-05-10): restore weightDecay to 1e-5 once 3e.1's
    // clip relaxation has stabilised in prod for 24h+ (no NaN-storm freeze
    // events, goldenMAE non-regressing). See PR #340.
    weightDecay: 0,
    warmupRounds: 200,
    warmupStartLr: 1e-4,
  },
  // Phase 1 dial fixes — partial. `replayMultiplier` 3 → 2 and per-step
  // `drawForReplay` 4 → 1 stop teaching moments from monopolising 20-25%
  // of every minibatch.
  //
  // `recoveryPct` is left at 0.05 pending Phase 3. The trigger compares
  // `Math.abs(lossThisRound) ≤ recoveryPct` against per-sample
  // ordinal-smoothed CE, whose floor is ~1-2 nats due to the smoothing
  // kernel — so any value < 1 (including the previous 0.05 and the
  // initially-proposed 0.5) is unreachable. PR #310's review surfaced
  // this. The honest fix needs the loss formulation to change first
  // (Phase 3 introduces specialised per-task heads and replaces the
  // single 103-way classifier as the primary classic-mode head), so
  // the recoveryPct semantics will be redefined together with the
  // new loss surface. Until then teaching moments are effectively
  // dormant — better than the previous false-confidence at 18%
  // trigger rate driven by stale residual-era dynamics.
  teachingMomentRecoveryPct: 0.05,
  teachingMomentReplayMult: 2,
  teachingMomentDecayRounds: 50,
  teachingCapacity: 32,
  epsilonFloorStart: 0.1,
  epsilonFloorEnd: 0.03,
  epsilonDecayRounds: 10000,
  // Match the persona-level default — see `PersonaProfile.moodInfluence`
  // in `persona/profile.ts`. Tests needing the inert baseline pass
  // `moodInfluence: 0` explicitly (the kill-switch contract test in
  // `workerCoreFilm.test.ts` does exactly this).
  moodInfluence: 1,
  // Phase 3e.3 AGC default — placeholder here (`AGC_LAMBDA` const is
  // initialised after this object due to dependency ordering).
  // `withDefaults()` below applies the resolved env-aware value.
  // Tests pass `agcLambda: 0` to disable.
  agcLambda: 0,
};

/**
 * Global L2-norm cap on the post-backward gradient buffers, applied
 * before each Adam step. Tightened 5 → 1 on 2026-05-06 after a
 * 14-hour training run diverged with the looser bound: even with the
 * NaN-storm freeze, the priceHead weights had drifted ~17 orders of
 * magnitude before the freeze caught it. Tightened 1.0 → 0.5 in
 * Phase 1 of the NN recovery plan after the post-clip grad-norm
 * telemetry (Phase 0) confirmed unit-norm was thrashing trunk
 * weights. Tightened again 0.5 → 0.3 in Phase 3d.1 as cheap
 * insurance against distribution-shift events.
 *
 * **Phase 3e.1: 0.3 → 3.0.** The 3-reviewer NN debate (see plan at
 * `~/.claude/plans/taut-unblocking-trunk.md`) showed that 0.3 was
 * binding on 100% of post-reset minibatch steps — every Adam update
 * was a fixed-magnitude unit vector, not a calibrated step. Effective
 * LR was being attenuated by a factor of 100-1000× depending on the
 * round's pre-clip norm. The new 3.0 ceiling lets healthy steps pass
 * unclipped (see `DIVERGENCE_GRAD_NORM_THRESHOLD` below for the
 * canonical pre-clip distribution: typical p95 50-300, peaks under
 * 1k), so most steps are still clipped but Adam's `m̂/√v̂`
 * normalisation gets to do its job on the magnitude before the cap
 * kicks in.
 *
 * **The post-#319 root-cause fix is still in place.** PR #322's
 * `applyHasPairRoleZeroInit` (one-shot zero-init of trunk[0] column
 * 49 + its Adam state) addressed the actual generator of the post-
 * #319 grad-explosion class. The 0.3 clip was symptomatic insurance
 * paired with that root-cause fix; the new 3.0 ceiling assumes the
 * root-cause fix continues to hold. If a *new* class of divergence
 * appears in production, prefer chasing the generator over re-tightening
 * the clip — see `largestNormBuffer` / `largestRMSBuffer` telemetry
 * for first-look diagnostics.
 *
 * Layered safety nets (in order of trip latency):
 *  - Per-step rollback at `DIVERGENCE_GRAD_NORM_THRESHOLD` (1e5;
 *    `NN_DIVERGENCE_THRESHOLD_OVERRIDE=5e3` recommended for 3e.1's
 *    first 1000 rounds in prod) — fires within one minibatch.
 *  - NaN-storm freeze at 10/hr (`NN_NAN_STORM_THRESHOLD=5` recommended
 *    for 3e.1's first 24h in prod) — fires within ~5 rollbacks.
 *  - goldenEval regression gate (Phase 3e.0, 1.2× median-of-5) — fires
 *    at the next snapshot, ~30-40 min wide.
 *
 * Exported only for `phase3e1_constants.test.ts`'s clip-semantics
 * regression test. Production reads of post-clip behaviour should
 * use `gradNormPostClipP95` from the worker heartbeat.
 */
export const MAX_GRAD_NORM = 3.0;

/**
 * Phase 3e.3 — AGC clipping parameter.
 *
 * Adaptive Gradient Clipping (Brock et al. 2021) clips each parameter
 * buffer's gradient by `min(1, lambda * ||W|| / ||g||)`. The threshold
 * scales with the parameter's own L2 norm — healthy buffers pass
 * unclipped while only outliers get throttled.
 *
 * 0.1 is the default starting point. Brock's paper used 0.01–0.16
 * across different ResNet variants; for this small MLP with pre-clip
 * aggregate norms in the 80–100 range, 0.1 lets most buffers through
 * while still throttling whichever buffer is dominating the aggregate.
 *
 * Env override: `NN_AGC_LAMBDA_OVERRIDE` for ops-time tuning without
 * a redeploy. Set to 0 to disable AGC entirely (fall back to the
 * global L2 clip alone — the pre-3e.3 behaviour).
 *
 * Tests can also override per-instance via `WorkerCoreOptions.agcLambda`
 * (`agcLambda: 0` keeps AGC out of the pipeline so tests targeting the
 * divergence-rollback gate aren't masked).
 */
export const AGC_LAMBDA_DEFAULT = 0.1;
function resolveAgcLambda(): number {
  const raw = process.env.NN_AGC_LAMBDA_OVERRIDE;
  if (raw === undefined || raw === "") return AGC_LAMBDA_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return AGC_LAMBDA_DEFAULT;
  return v;
}
export const AGC_LAMBDA = resolveAgcLambda();

/**
 * Phase 3e.3 (B2 fix from review #343): build the AGC bias-skip
 * index set from a network's `iterParamBuffers` order. iterParamBuffers
 * yields W and b alternately for every layer (`[W, b, W, b, ...]`),
 * so every odd index is a bias. Brock 2021 §3.2 explicitly exempts
 * bias terms from AGC (zero-init biases would otherwise have
 * vanishingly tight per-buffer thresholds). Caller passes the result
 * to `adaptiveClipGradientsInPlace`'s `skipIndices` arg.
 */
function buildAgcSkipIndices(network: Network): ReadonlySet<number> {
  const skip = new Set<number>();
  let i = 0;
  for (const _ of iterParamBuffers(network)) {
    if (i % 2 === 1) skip.add(i);
    i += 1;
  }
  return skip;
}

/**
 * Threshold above which a per-step pre-clip grad norm is logged as a
 * divergence event in NDJSON. Observability-only in Phase 0 — the
 * existing rollback gate fires on weight-NaN, which clipping prevents.
 * Phase 1 of the NN recovery plan extends rollback to also act on this
 * signal. 1e5 is well above any healthy training norm we've seen on
 * this network (typical p95 is 50-300, peaks under 1k) and well below
 * the float32 representation cap, so events are rare-but-not-spurious.
 */
const DIVERGENCE_GRAD_NORM_THRESHOLD_DEFAULT = 1e5;
/**
 * Phase 3d.2: env-gated override for the divergence threshold.
 * `NN_DIVERGENCE_THRESHOLD_OVERRIDE` lets operators tighten this
 * temporarily during the post-deploy stabilisation window without
 * a redeploy. Empty / non-finite / non-positive falls through to
 * the default. The plan recommends 5e3 for the first 1000 rounds.
 */
function readDivergenceThreshold(): number {
  const raw = process.env.NN_DIVERGENCE_THRESHOLD_OVERRIDE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DIVERGENCE_GRAD_NORM_THRESHOLD_DEFAULT;
}
const DIVERGENCE_GRAD_NORM_THRESHOLD = readDivergenceThreshold();
const SCHEMA_VERSION_HEADER = 1;
/**
 * Threshold count of NaN rollbacks within 1 hour that flips the
 * freeze. Phase 3d.2: env-gated via `NN_NAN_STORM_THRESHOLD` so
 * operators can tighten this for the first 24h post-deploy. Default
 * 10; plan recommends 5 for the first 24h.
 */
const NAN_STORM_THRESHOLD_DEFAULT = 10;
function readNanStormThreshold(): number {
  const raw = process.env.NN_NAN_STORM_THRESHOLD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)
    ? parsed
    : NAN_STORM_THRESHOLD_DEFAULT;
}
const NAN_STORM_THRESHOLD = readNanStormThreshold();
const NAN_STORM_WINDOW_MS = 60 * 60 * 1000;
/**
 * Smoothing bandwidth for the ordinal-CE loss on the catalog. log(1.15)
 * means a price 15% off the target gets ~37% of the on-target probability
 * mass under the Gaussian smoother — close enough that the gradient
 * still rewards "approximately right" predictions, far enough that
 * catastrophically wrong ones (10×, 100×) get effectively 0.
 */
const ORDINAL_CE_TAU = Math.log(1.15);

/**
 * Param-buffer indices. Order matches `iterParamBuffers` in mlp.ts —
 * change there REQUIRES change here.
 *
 * v2 (Phase 3d.2): priceMatchPair (4 buffers) + budgetSelect (4
 * buffers) removed; pinballQ40 (2 buffers) appended. Net −6.
 */
const GRAD_IDX = {
  trunk0W: 0,
  trunk0b: 1,
  trunk1W: 2,
  trunk1b: 3,
  priceClassW: 4,
  priceClassb: 5,
  filmGenW: 6,
  filmGenb: 7,
  logPriceW: 8,
  logPriceb: 9,
  pairLogitW: 10,
  pairLogitb: 11,
  squashedRegW: 12,
  squashedRegb: 13,
  pinballQ40W: 14,
  pinballQ40b: 15,
} as const;

/**
 * Buffer names matching the order of `iterParamBuffers` in mlp.ts.
 * Used by the NaN-guard to identify which block first failed
 * `checkFinite` so an operator can tell a FiLM-NaN ("cond went
 * wild") from a priceClass-NaN ("catalog/embedding pathology")
 * from a trunk-NaN ("feature normaliser issue") in the logs. Keep
 * synchronised with `iterParamBuffers` and `GRAD_IDX`.
 */
const PARAM_BUFFER_NAMES = [
  "trunk0W",
  "trunk0b",
  "trunk1W",
  "trunk1b",
  "priceClassW",
  "priceClassb",
  "filmGenW",
  "filmGenb",
  "logPriceW",
  "logPriceb",
  "pairLogitW",
  "pairLogitb",
  "squashedRegW",
  "squashedRegb",
  "pinballQ40W",
  "pinballQ40b",
] as const;

/**
 * Walk every parameter buffer and return the name of the one with the
 * largest L2 norm. Used in the grad-explosion rollback log so the
 * operator can tell *which* head/trunk drove the spike — analogous to
 * the `firstNonFiniteName` aid for the param-NaN branch.
 */
function largestNormBuffer(network: ReturnType<typeof createNetwork>): string {
  let bestName: string = PARAM_BUFFER_NAMES[0];
  let bestNorm = -1;
  let i = 0;
  for (const buf of iterParamBuffers(network)) {
    let s = 0;
    for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
    if (s > bestNorm) {
      bestNorm = s;
      bestName = PARAM_BUFFER_NAMES[i] ?? `buf[${i}]`;
    }
    i += 1;
  }
  return bestName;
}

/**
 * Phase 3d.1: per-buffer root-mean-square diagnostic. Raw L2 norm
 * biases toward whichever buffer is largest by parameter count
 * (`trunk0W` is 3968 floats; `priceClassb` is 103). Reporting
 * `‖g‖ / √numel` lets operators tell "trunk0W is genuinely diverging"
 * from "trunk0W is mathematically the largest because it's the
 * largest tensor". Used alongside {@link largestNormBuffer} in the
 * grad-explosion rollback log.
 */
function largestRMSBuffer(network: ReturnType<typeof createNetwork>): string {
  let bestName: string = PARAM_BUFFER_NAMES[0];
  let bestRMS = -1;
  let i = 0;
  for (const buf of iterParamBuffers(network)) {
    if (buf.length === 0) {
      i += 1;
      continue;
    }
    let s = 0;
    for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
    const rms = Math.sqrt(s / buf.length);
    if (rms > bestRMS) {
      bestRMS = rms;
      bestName = PARAM_BUFFER_NAMES[i] ?? `buf[${i}]`;
    }
    i += 1;
  }
  return bestName;
}

/**
 * Multiplier on the median-of-last-N accepted golden MAEs that
 * triggers the snapshot regression gate. The gate refuses to write
 * if the current MAE > median × this factor, OR if the current MAE
 * is non-finite.
 *
 * Phase 3e.0 tightened this 2.0 → 1.2 (20% regression budget) and
 * pivoted the baseline from "last single accepted MAE" to "median of
 * last 5". Pre-3e.0 a single bad-but-just-under-2× snapshot inflated
 * the baseline forever; the median anchor stays robust to those
 * single-step outliers without being so strict that normal training
 * noise trips it.
 */
const SNAPSHOT_MAE_REGRESSION_FACTOR = 1.2;
/**
 * How many recent accepted MAEs to track for the median baseline. A
 * window of 5 means a single bad snapshot can't shift the gate's
 * anchor; it takes 3 in a row to actually move the median. Worker-
 * restart resets the ring to a single sample (the on-restart MAE).
 */
export const SNAPSHOT_MAE_BASELINE_WINDOW = 5;

/**
 * Median of a numeric array (numeric sort, even-length midpoint).
 * Empty input → NaN; the caller is expected to gate on `length > 0`
 * before reading the result. Exported for the gate's unit tests.
 */
export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
/** Disk-pressure thresholds: stop NDJSON at 80%, snapshots at 90%. */
const DISK_PRESSURE_NDJSON = 0.8;
const DISK_PRESSURE_SNAPSHOT = 0.9;

/**
 * Phase 3e.0: how many rounds the head-starvation watchdog waits
 * before flagging a head as starved. Below this round count an empty
 * tasksObserved counter doesn't yet imply a bug — bidding rounds in
 * particular may not have been routed yet. After the grace period a
 * still-zero count is a strong signal of a data-path regression.
 */
const HEAD_STARVATION_WARMUP_ROUNDS = 300;

/**
 * Build a 3-d FiLM conditioning vector from a mood snapshot.
 *
 *   cond = [vibe / 3, morale, clamp(streak, -5, 5) / 5]
 *
 * Each entry lands in [-1, 1] under normal mood ranges, which keeps
 * filmGen's tanh-bounded output well-conditioned. `streak` is
 * optional — training samples (`Sample.mood`) never carry one; the
 * predict path (`PredictReq.mood`) always does. Absent streak →
 * 0, leaving the groove channel inert for replayed samples by
 * design.
 *
 * Phase 3e.2: dropped the cond[3..5] round-context tail
 * (`log(budgetCents+1)/12`, `log(maxPriceCapCents+1)/12`,
 * `clamp(productCount, 0, 30)/10`). Those numerics are already in
 * the trunk's engineered feature block, so feeding them through
 * FiLM was double-encoding. The `roundCtx` parameter is removed.
 *
 * NaN/Infinity in `vibe` or `morale` would otherwise propagate
 * through the FiLM forward and rollback to a misleading
 * `firstNonFiniteName` (the trunk goes non-finite first because the
 * NaN flows through it). Snap to 0 defensively — the upstream
 * caller (the runner's mood reducer + persistence) never produces
 * non-finite values, but a corrupted on-disk snapshot or future
 * bug in mood-source plumbing would otherwise mis-attribute the
 * NaN-rollback log.
 */
function moodToCond(
  mood: {
    readonly vibe: number;
    readonly morale: number;
    readonly streak?: number;
  },
): Float32Array {
  const cond = new Float32Array(MODEL_SPEC.condDim);
  cond[0] = Number.isFinite(mood.vibe) ? mood.vibe / 3 : 0;
  cond[1] = Number.isFinite(mood.morale) ? mood.morale : 0;
  cond[2] = mood.streak !== undefined && Number.isFinite(mood.streak)
    ? Math.max(-5, Math.min(5, mood.streak)) / 5
    : 0;
  return cond;
}

/** Build an effective options object from a partial. */
export function withDefaults(opts: Partial<WorkerCoreOptions> = {}): WorkerCoreOptions {
  return {
    ...DEFAULT_OPTS,
    ...opts,
    adamw: { ...DEFAULT_OPTS.adamw, ...(opts.adamw ?? {}) },
    // Phase 3e.3: explicit override at the end so caller's `agcLambda:
    // 0` (test) wins, and absence falls back to the env-resolved
    // module const (production).
    agcLambda: opts.agcLambda ?? AGC_LAMBDA,
  };
}

/** RingBuffer-ish for sliding statistics. */
class Ring<T = number> {
  readonly cap: number;
  private buf: T[] = [];
  constructor(cap: number) {
    this.cap = cap;
  }
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  toArray(): T[] {
    return [...this.buf];
  }
  size(): number {
    return this.buf.length;
  }
}

/** Numeric variant — used for losses + grad norms. */
class NumericRing extends Ring<number> {
  /**
   * Drop non-finite values silently. A single Infinity or NaN poisons
   * every subsequent p95/p90 call (sort puts NaN at the end on most
   * V8 versions and pushes the percentile slot). Reviewers flagged
   * this on PR #309 as a Phase 1 prerequisite for the rollback gate
   * extension that consumes these signals downstream.
   */
  override push(v: number): void {
    if (!Number.isFinite(v)) return;
    super.push(v);
  }
  p95(): number {
    const arr = this.toArray();
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.95)] ?? s[s.length - 1];
  }
  p90(): number {
    const arr = this.toArray();
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.9)] ?? s[s.length - 1];
  }
  /**
   * Phase 3e.3: low-tail percentile for AGC's `minScale` ring.
   * p5 surfaces the WORST per-buffer compression AGC has applied
   * recently — values below ~0.3 indicate over-clipping.
   */
  p5(): number {
    const arr = this.toArray();
    if (arr.length === 0) return 1;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.05)] ?? s[0];
  }
}

/**
 * In-memory snapshot used by the NaN guard. Captures every mutable
 * structure that materially participates in training so a NaN
 * rollback restores deterministic prior behavior.
 *
 * Captured:
 *   - network params (the proximate NaN target)
 *   - optimizer state (Adam moments)
 *   - normalizer running stats (a NaN sample would otherwise corrupt μ/σ)
 *   - OOD blender per-category running stats
 *   - teaching-moments buffer
 *   - replay buffer (so the offending sample doesn't keep re-NaN-ing)
 *   - prevRoundLossByProduct map (drives teaching-moment trigger)
 *
 * Intentionally NOT captured:
 *   - round counter / nanRollbacks counter / round log: telemetry only;
 *     rolling them back would create gaps in the per-round log + lose
 *     the rollback-rate signal.
 *   - gradNormRing: pure observability ring (p95 estimate); a single
 *     rollback episode shifts the percentile by at most one bin and
 *     the impact decays across the next ~100 observations.
 */
interface InMemorySnapshot {
  params: Float32Array;
  optimizerState: Buffer;
  normalizer: Buffer;
  ood: Buffer;
  teaching: Buffer;
  replay: Buffer;
  prevRoundLossByProduct: Array<[number, number]>;
}

/**
 * Lightweight category-bucket helper. Phase 3a: bucket 0 is reserved
 * as the "unseen / fallback" slot. Real categories hash into [1, N).
 * The OOD blender's per-category running stats live in bucket 0 only
 * for products whose category lookup misses (empty string, undefined),
 * which keeps stats clean — pre-Phase-3a, hash collisions with bucket
 * 0 silently corrupted the stats for whatever real category had
 * collided, masquerading as OOD signal.
 */
function categoryBucket(category: string, buckets: number = CATEGORY_BUCKETS): number {
  const s = category.toLowerCase().trim();
  if (s.length === 0) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Hash into [1, buckets) so bucket 0 is reserved.
  const usable = Math.max(1, buckets - 1);
  return 1 + ((h >>> 0) % usable);
}

/** Map a brand tier id to its display string. */
function tierName(t: 0 | 1 | 2): "budget" | "mid" | "premium" {
  return t === 0 ? "budget" : t === 1 ? "mid" : "premium";
}

/** Heuristic price wrapper — re-exported for tests. */
export function heuristicCents(product: { title: string; category: string; description?: string }): number {
  return estimatePriceCents({
    title: product.title,
    category: product.category,
    description: product.description ?? "",
  });
}

/**
 * Map a game round outcome onto the broadcast accuracy bucket. The
 * "Last 10 Guesses" panel renders one dot per round, coloured off this
 * mapping so it tracks what viewers actually saw the game score:
 *   - "correct"   → green ("within10")
 *   - "partial"   → amber ("within25")
 *   - "incorrect" → red ("miss")
 * Exported for tests.
 */
export function outcomeToBucket(
  outcome: "correct" | "partial" | "incorrect",
): "within10" | "within25" | "miss" {
  if (outcome === "correct") return "within10";
  if (outcome === "partial") return "within25";
  return "miss";
}


/**
 * The core learning class. Plain methods you can drive from a test or
 * a worker_threads shim.
 */
export class WorkerCore {
  readonly opts: WorkerCoreOptions;
  network: Network;
  optimizer: AdamW;
  normalizer: Normalizer;
  replay: StratifiedReplay;
  teaching: TeachingMoments;
  /**
   * OOD blender — kept (PR #4) only as the source of per-category
   * price-distribution stats consumed by adaptiveEpsilon's exploration
   * schedule. The pre-PR-4 `blendMu()` mu-correction path is gone
   * (it only made sense for the regression head, which is gone).
   */
  ood: OODBlender;
  /**
   * Phase 3b Kendall&Gal uncertainty weighting state. Per-task σ²
   * unfreezes after FIXED_PHASE_ROUNDS and a per-task minimum
   * observations gate. Persisted via the snapshot's
   * `uncertainty_weights` BLOB column; resets at archHash mismatch.
   */
  uncertainty: UncertaintyWeights;
  goldenEval: GoldenEvalSet;
  brandTiers: BrandTierTable;
  persistence: LearningPersistence | null = null;
  ndjson: NdjsonLogger | null = null;
  /**
   * Canonical-prices catalog — the discrete output space of the
   * priceClass head. Built at construction (default catalog) and
   * exposed as readonly so tests can introspect it. A future commit
   * may extend this from observations during init().
   */
  readonly priceCatalog: PriceCatalog = buildDefaultCatalog();
  /**
   * Caller-owned scratch for {@link forwardFilm} and {@link backwardFilm}
   * — allocated once, re-used across every minibatch step and every
   * `predict()` call. Aligns the FiLM block with the trunk's "no
   * GC pressure in the hot path" pattern documented at the top of
   * `mlp.ts`. Sized for `MODEL_SPEC.embeddingDim` so an archHash
   * change that touches the embedding dim auto-mismatches via the
   * existing snapshot guard rather than by allocating a too-small
   * buffer here.
   */
  private readonly filmScratch: FilmScratch = createFilmScratch(MODEL_SPEC.embeddingDim);

  /**
   * Runtime invariant: catalog length must match the head's output
   * dim. If a future change drifts these (extend catalog without
   * bumping PRICE_CLASS_K, or vice versa), every minibatch step would
   * throw inside ordinalSmoothedCE — better to fail loudly at startup.
   * Computed once at module load via the IIFE.
   */
  private static readonly _catalogInvariant: true = (() => {
    const catK = buildDefaultCatalog().K;
    if (catK !== MODEL_SPEC.priceClassK) {
      throw new Error(
        `priceCatalog.K (${catK}) !== MODEL_SPEC.priceClassK (${MODEL_SPEC.priceClassK}); ` +
        `update PRICE_CLASS_K in types.ts to match the catalog length.`,
      );
    }
    return true as const;
  })();

  /** Round counter — increments on every update(). */
  round = 0;
  /**
   * Round counter at which the current arch's training began.
   * `adaptiveEpsilon`'s decay schedule uses `round - decayAnchorRound`
   * so that an archHash bump (model reset) starts the exploration
   * decay over from full-floor — the new model is random and needs
   * more exploration than the previous arch's late life. Set to 0 on
   * fresh start, on archMismatch load, and on `resetLearning()`. Same
   * arch reload preserves the anchor (the old model continues from
   * where it left off).
   */
  private decayAnchorRound = 0;
  lastSnapshotRound = 0;
  /** ms-epoch of the last successful snapshot — drives the snapshot-age alarm. */
  lastSnapshotAt = 0;
  nanRollbacks = 0;
  staleResponses = 0;
  lastPredictAt = 0;
  workerStartedAt = Date.now();
  goldenMAE: number | null = null;
  /**
   * Golden MAE at the time of the most-recent accepted saveSnapshot.
   * Exposed for tests / introspection; the regression gate consumes
   * the median of {@link recentAcceptedMAEs} instead, so this is now
   * a tail observation, not the gate's baseline.
   */
  private acceptedSnapshotMAE: number | null = null;
  /**
   * Last {@link SNAPSHOT_MAE_BASELINE_WINDOW} accepted golden MAEs.
   * Median of this ring is the regression gate's baseline (Phase 3e.0).
   * Worker restart re-seeds it to a single sample via the on-restart
   * recompute, so the gate becomes "tight" only once enough successful
   * saves have accumulated.
   */
  private recentAcceptedMAEs: number[] = [];
  /** Round counter at the time of the last accepted snapshot — exposed for tests. */
  private acceptedSnapshotRound = 0;
  /** Refusal counter for the regression gate. Surfaced via /healthz. */
  private goldenRegressionRollbacks = 0;
  /**
   * Round-counter floor before the next snapshot attempt is allowed.
   * Bumped to `round + snapshotInterval` on each gate refusal so the
   * (expensive) golden eval doesn't run every round while the model is
   * stuck at a regressed state. Without this rate-limit the trigger
   * `round - lastSnapshotRound >= snapshotInterval` keeps firing every
   * round once the threshold is crossed.
   */
  private nextSnapshotRetryRound = 0;
  /** Roundtripable in-memory snapshot — used for NaN guard rollback. */
  private lastGoodSnapshot: InMemorySnapshot | null = null;
  private pendingSnapshot = false;
  /**
   * Sliding 1-hour ring of NaN-rollback timestamps (ms epoch). When
   * the ring's count exceeds NAN_STORM_THRESHOLD we freeze the model
   * and force `degraded:'nan_storm'` on the next heartbeat — the bot
   * keeps playing, but on heuristic only.
   */
  private nanRollbackEpochs: number[] = [];
  /** True while the NaN-storm freeze is active. */
  private frozen = false;
  /** Most recent disk-pressure read — see {@link checkDiskPressure}. */
  private lastDiskUsedRatio = 0;
  /** Rolling DB-write durations for dbWriteLatencyP95Ms. */
  private dbWriteLatencyRing = new NumericRing(64);

  /** Last 50 round losses (sparkline). */
  recentLosses = new NumericRing(50);
  /** Last 10 accuracy buckets (RecentAccuracy panel). */
  recentAccuracy = new Ring<"within10" | "within25" | "miss">(10);
  /** Global gradient norms for gradNormP95 telemetry. */
  private gradNormRing = new NumericRing(128);
  /**
   * Post-clip gradient norms — equal to `min(preClip, MAX_GRAD_NORM)`.
   * Logged separately so the SQLite signal can distinguish "raw grad
   * spike from a noisy loss surface" (`gradNormRing.p95()`) from "Adam
   * actually took a destabilising step" (`gradNormPostClipRing.p95()`).
   * Without this split, all post-clip steps look identical at the
   * cap and we lose the ability to diagnose divergence.
   */
  private gradNormPostClipRing = new NumericRing(128);
  /**
   * Phase 3e.3: per-step count of buffers whose gradient was clipped
   * by AGC. p95 surfaced via /healthz so an operator can tell whether
   * AGC is actually firing (most steps should clip 0–2 of 14 buffers
   * under normal training; consistently high counts signal a tuning
   * problem with `AGC_LAMBDA`).
   */
  private agcClipsRing = new NumericRing(128);
  /**
   * Phase 3e.3: smallest scale factor applied to any buffer per step
   * (1.0 if AGC didn't fire). p5 — the EXTREME tail — is the operator-
   * facing metric: "what's the worst per-buffer compression AGC has
   * applied recently?". Values below ~0.3 indicate sustained over-
   * clipping that suggests AGC_LAMBDA is too tight.
   */
  private agcMinScaleRing = new NumericRing(128);
  /**
   * Phase 3e.3 (B2 fix from review #343): index set of buffers AGC
   * should NOT clip. Brock 2021 §3.2 explicitly exempts bias terms
   * (zero-init means tiny ||W|| → epsParam-floored threshold crushes
   * every nontrivial gradient). For our network, every odd index in
   * `iterParamBuffers` is a bias (W, b, W, b, ...). Built once at
   * init from the running network's iterator order so it stays
   * correct across future arch changes.
   */
  private agcSkipIndices: ReadonlySet<number> = new Set();
  /**
   * Per-product previous-round losses for the teaching-moment trigger.
   * LRU-bounded by 2× replay capacity so a 24/7 run with high product
   * churn can't grow this map without bound.
   */
  private prevRoundLossByProduct = new Map<number, number>();
  /** Most-active neuron history per layer (last 2 rounds). */
  private mostActiveTrail: Array<[number, number]> = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  private mostActivePrev: number[] = [0, 0, 0];

  /**
   * Snapshot of the most recent {@link predict} call — feeds
   * {@link buildVisualBuffer} so the broadcast tick reflects real model
   * state instead of zeros. `null` until the first predict runs.
   */
  private lastPredict: {
    trunkHidden: Float32Array;
    embedding: Float32Array;
    predictedCents: number;
    predictedSigmaCents: number;
    embedding2d: [number, number];
    topFeatures: Array<{ name: string; contribution: number }>;
    /** Top-5 catalog candidates from the active classifier — surfaced to the visual tick. */
    priceCandidates: Array<{ cents: number; prob: number }>;
  } | null = null;

  /**
   * Whether the most recent {@link update} call triggered a teaching
   * moment. Surfaced through the next visual tick so the panel paints
   * its "aha" pulse. Cleared (set to `false`) on each subsequent
   * non-triggering update so the pulse only fires once.
   */
  private lastTeachingTriggered = false;

  /**
   * Stable, deterministic set of weight edges to surface in every
   * visual tick. Each edge is `(fromLayer, fromIdx) → (toLayer, toIdx)`
   * picked once at construction so the panel draws the *same* edges
   * each round (only their weight values change as training proceeds).
   * Without stable indices the entire edge map would shuffle each
   * round and viewers would see a strobing mess instead of weights
   * settling.
   */
  private readonly weightSampleIndices: ReadonlyArray<{
    fromLayer: 0 | 1;
    fromIdx: number;
    toLayer: 1 | 2;
    toIdx: number;
  }> = (() => {
    const out: Array<{ fromLayer: 0 | 1; fromIdx: number; toLayer: 1 | 2; toIdx: number }> = [];
    const N = 32; // edges per layer transition; ~64 total stays cheap to draw
    // Layer 0 → 1 (input → trunk hidden). Coprime strides scatter the
    // (in,out) pairs across the matrix without an RNG.
    for (let k = 0; k < N; k++) {
      out.push({
        fromLayer: 0,
        fromIdx: (k * 7 + 3) % FEATURE_DIM,
        toLayer: 1,
        toIdx: (k * 5 + 1) % TRUNK_HIDDEN_DIM,
      });
    }
    // Layer 1 → 2 (trunk hidden → embedding).
    for (let k = 0; k < N; k++) {
      out.push({
        fromLayer: 1,
        fromIdx: (k * 11 + 2) % TRUNK_HIDDEN_DIM,
        toLayer: 2,
        toIdx: (k * 3 + 1) % EMBEDDING_DIM,
      });
    }
    return out;
  })();

  /** Public arch hash (must match persistence.archHash). */
  readonly archHash: string;

  constructor(partial: Partial<WorkerCoreOptions> = {}) {
    this.opts = withDefaults(partial);
    this.archHash = archHash();
    this.network = createNetwork(this.opts.rng);
    this.optimizer = new AdamW(this.opts.adamw);
    this.optimizer.bind(Array.from(iterParamBuffers(this.network)).map((b) => b.length));
    this.agcSkipIndices = buildAgcSkipIndices(this.network);
    this.normalizer = new Normalizer({
      dim: FEATURE_DIM,
      beta: 0.99,
      // Phase 1: 32 → 200. The 124-d feature vector needs many more
      // observations to produce stable running stats; 32 was burning
      // through warmup inside the first round of multi-product modes
      // (5–15 samples per round) and seeding the normalizer with
      // unstable mean/var.
      warmupSamples: 200,
      eps: 1e-8,
    });
    this.replay = new StratifiedReplay({
      recentCapacity: this.opts.replayRecentCapacity,
      perModeCapacity: this.opts.replayCapacity,
      recentSampleFraction: this.opts.replayRecentSampleFraction,
      recentUniformFraction: this.opts.replayRecentUniformFraction,
      alpha: this.opts.perAlpha,
      betaStart: this.opts.perBetaStart,
      betaEnd: this.opts.perBetaEnd,
      betaAnnealRounds: this.opts.perBetaAnnealRounds,
      perModeUniformFraction: this.opts.perUniformFraction,
      maxPerRoundInBatch: this.opts.maxPerRoundInBatch,
    });
    this.teaching = new TeachingMoments({
      capacity: this.opts.teachingCapacity,
      recoveryPct: this.opts.teachingMomentRecoveryPct,
      replayMultiplier: this.opts.teachingMomentReplayMult,
      decayRounds: this.opts.teachingMomentDecayRounds,
    });
    this.ood = new OODBlender();
    this.uncertainty = new UncertaintyWeights();
    this.goldenEval = new GoldenEvalSet([]);
    this.brandTiers = new BrandTierTable();
  }

  /**
   * Override the data directory after construction. Used by the
   * worker_threads shim where the dataDir is delivered in the `init`
   * message rather than at construction.
   */
  setDataDir(dataDir: string): void {
    (this.opts as { dataDir: string }).dataDir = dataDir;
  }

  /** Open persistence, NDJSON logger, golden eval, brand-tier table. Idempotent. */
  async init(): Promise<{ loadedSnapshotRound: number | null; archMismatch: boolean }> {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    this.persistence = await LearningPersistence.open({
      dataDir: this.opts.dataDir,
      archHashOverride: this.archHash,
    });
    this.ndjson = new NdjsonLogger({
      dir: path.join(this.opts.dataDir, "round-logs"),
      pruneOlderThanDays: 14,
      flushEvery: 32,
    });
    await this.ndjson.start();
    this.goldenEval = await GoldenEvalSet.load(this.opts.dataDir);
    this.brandTiers = await BrandTierTable.load(this.opts.dataDir);

    const loaded = this.persistence.loadLatestSnapshot();
    if (!loaded) {
      // Phase 3b: when the load returned null AND there's data in the
      // archive table (loadLatestSnapshot moves arch-mismatched rows
      // there), the archHash bump just rotated old weights out. Try
      // a warm-start so the new arch's compatible buffers (trunk +
      // priceClassHead + filmGen) inherit the previous arch's
      // training instead of restarting from random init. The new
      // Phase 3b heads stay at random init.
      const ws = tryWarmStartFromArchive(this.persistence, this.network);
      if (ws.warmStarted) {
        // eslint-disable-next-line no-console
        console.info(
          `[learning] warm-start from archived round ${ws.archivedRound}: ${ws.bytesCopied} bytes copied`,
        );
        // Re-bind optimizer in case the network's buffer count changed
        // (idempotent — bind is a no-op when sizes already match).
        this.optimizer.bind(Array.from(iterParamBuffers(this.network)).map((b) => b.length));
      } else if (ws.reason && ws.reason !== "no archived snapshot") {
        // eslint-disable-next-line no-console
        console.info(`[learning] warm-start skipped: ${ws.reason}`);
      }
      // archMismatch reports whether an arch-mismatch event was
      // detected (i.e. the archive contained a row), not whether
      // warm-start succeeded. ws.archivedRound !== null is the
      // canonical signal that a row existed.
      // Phase 3d.1: also run on the no-snapshot / warm-start path so
      // a fresh network starts with column 49 zeroed too. With v
      // all-zero on a freshly-bound optimizer, the migration's
      // detection condition matches; the column-zero write replaces
      // the random He values with zero, which is benign.
      this.maybeApplyHasPairRoleZeroInit();
      return { loadedSnapshotRound: null, archMismatch: ws.archivedRound !== null };
    }
    if (loaded.archHash !== this.archHash) {
      // archiveAll already invoked by persistence on mismatch.
      this.maybeApplyHasPairRoleZeroInit();
      return { loadedSnapshotRound: null, archMismatch: true };
    }
    // Verify the param-buffer length before loading anything else. A
    // shape mismatch here means someone bumped MODEL_SPEC without
    // bumping archHash — refuse to load any auxiliary state because it
    // would be inconsistent with the freshly-initialised network.
    const flat = new Float32Array(loaded.weights.byteLength / 4);
    Buffer.from(loaded.weights).copy(
      Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength),
    );
    if (flat.length !== paramCount(this.network)) {
      // archiveAll moves the mismatched row out of `nn_snapshots` and
      // we restart from fresh init weights + zeroed auxiliary state.
      this.persistence.archiveAll();
      this.maybeApplyHasPairRoleZeroInit();
      return { loadedSnapshotRound: null, archMismatch: true };
    }
    loadFlatParams(this.network, flat);
    // Track whether optimizer state was reset on this load. The
    // Phase 3d.1 hasPairRole zero-init migration relies on
    // `secondMoments[0]` being all-zero at column 49 to detect
    // legacy snapshots. A corrupt optimizer blob falls through to
    // a fresh-bound AdamW which trivially satisfies that detection
    // — but the loaded weights might already have a trained column
    // 49, and zero-initing them would wipe legitimate training
    // state. Guard the migration in the catch path.
    let optimizerWasReset = false;
    try {
      this.optimizer = AdamW.deserialize(loaded.optimizerState, this.opts.adamw);
    } catch {
      // Optimizer state is best-effort — fresh start is acceptable.
      this.optimizer = new AdamW(this.opts.adamw);
      this.optimizer.bind(Array.from(iterParamBuffers(this.network)).map((b) => b.length));
      optimizerWasReset = true;
    }
    try {
      this.normalizer = Normalizer.deserialize(loaded.featureNorm, this.normalizer.opts);
    } catch {
      /* keep default */
    }
    try {
      this.replay = StratifiedReplay.deserialize(loaded.replayBuffer, this.replay.opts);
    } catch (err) {
      // Phase 1 changed the on-disk format from flat PER to stratified
      // two-tier (`SRPL` magic). Pre-Phase-1 snapshots throw on the
      // magic-prefix check; we keep the empty default and let the buffer
      // fill naturally over the next ~1 day at the bot's ~3 rounds/min
      // cadence. Phase 3's archHash bump invalidates everything anyway.
      // Logged so a *real* deserialize bug (not the expected format
      // change) is visible rather than swallowed.
      // eslint-disable-next-line no-console
      console.warn(`[learning] replay-buffer deserialize fell back to empty: ${(err as Error).message}`);
    }
    try {
      this.teaching = TeachingMoments.deserialize(loaded.teachingMoments, this.teaching.opts);
    } catch {
      /* keep default */
    }
    try {
      this.ood = OODBlender.deserialize(loaded.oodBlender);
    } catch {
      /* keep default */
    }
    // Phase 3b: restore Kendall&Gal uncertainty weighting state. The
    // snapshot column was kept through PR #4 as vestigial — Phase 3b
    // re-uses it. Pre-3b snapshots wrote an empty Buffer; the
    // deserialize falls through to a fresh instance for any corrupt
    // / wrong-size payload, which matches the cold-start semantics
    // we want for a recovered snapshot.
    try {
      this.uncertainty = UncertaintyWeights.deserialize(loaded.uncertaintyWeights);
    } catch {
      this.uncertainty = new UncertaintyWeights();
    }
    this.round = loaded.round;
    this.lastSnapshotRound = loaded.round;
    // Seed the regression-gate baseline from the just-loaded weights —
    // without this, the very first snapshot post-restart was always
    // accepted regardless of how badly the loaded weights performed,
    // which defeats the load-bearing recovery property the gate is
    // supposed to provide. evaluateMAE returns null when the golden
    // set is empty (no baseline to anchor on), Infinity when the loaded
    // weights are already broken — in the latter case we leave the
    // baseline null too so the next non-broken snapshot can establish
    // a fresh anchor instead of the gate being permanently stuck.
    const restartMAE = this.recomputeGoldenMAE();
    if (restartMAE !== null && Number.isFinite(restartMAE)) {
      this.acceptedSnapshotMAE = restartMAE;
      this.acceptedSnapshotRound = loaded.round;
      // Re-seed the median ring with the on-restart MAE; the gate
      // becomes tight again only once 3+ successful saves accumulate.
      this.recentAcceptedMAEs = [restartMAE];
    }
    // Phase 3d.1: one-shot migration for the hasPairRole feature
    // column. See `maybeApplyHasPairRoleZeroInit` for rationale.
    // Skipped when the optimizer state was reset above — a corrupt
    // optimizer blob trivially satisfies the migration's "v all
    // zero" detection, but the loaded weights might already have
    // a trained column 49 we shouldn't wipe.
    if (!optimizerWasReset) {
      this.maybeApplyHasPairRoleZeroInit();
    }
    return { loadedSnapshotRound: loaded.round, archMismatch: false };
  }

  /**
   * Phase 3d.1: one-shot migration for the `hasPairRole` feature
   * column.
   *
   * Pre-PR-#319 the trunk trained for 1500+ rounds with
   * `hasPairRole=0` always. Because `dW[h, 49] = dHidden[h] · 0 = 0`,
   * column 49 of `trunk[0].W` (the input column for `hasPairRole`)
   * never received a single gradient update — it still holds the
   * He-init random values from `createNetwork`, and Adam's `m`/`v`
   * second-moment buffers for those weights are exactly zero.
   *
   * PR #319 began passing `hasPairRole=1` on 2-product binary
   * rounds. Flipping the bit then injects a random projection from
   * the never-trained column into every downstream activation, which
   * destabilised the trunk's ReLU boundaries and produced 47 grad-
   * explosion rollbacks in 9.4 hours of live operation.
   *
   * This migration zero-initialises the column instead. With
   * `W[:, 49] = 0`, the contribution `W[:, 49] · 1 = 0` matches the
   * long-standing behaviour `W[:, 49] · 0 = 0`, so there's no
   * sudden distribution shift on the trunk's first layer. From that
   * fixed point Adam will discover what the column should be as the
   * head trains, building up `m`/`v` from a clean slate.
   *
   * Detection: any snapshot whose `secondMoments[0]` is exactly zero
   * across all 32 rows at column 49 has never trained the column
   * and qualifies for the migration. A fresh init also satisfies
   * this (`v` is zero-allocated by `AdamW.bind`), and zeroing the
   * column on a freshly-He-init network is a benign overwrite of
   * random values that would otherwise reach the same fixed point
   * via gradient flow eventually.
   */
  private maybeApplyHasPairRoleZeroInit(): void {
    const trunk0 = this.network.trunk[0];
    const W = trunk0.W; // length outDim * inDim
    let mv: { m: Float32Array; v: Float32Array };
    try {
      mv = this.optimizer.getMomentBuffers(0);
    } catch {
      return; // optimizer not bound yet — should not happen at this point
    }
    const { m, v } = mv;
    const inDim = trunk0.inDim;
    const outDim = trunk0.outDim;
    const PAIR_ROLE_COL = 49;
    if (PAIR_ROLE_COL >= inDim) return;
    let allVZero = true;
    for (let h = 0; h < outDim; h++) {
      if (v[h * inDim + PAIR_ROLE_COL] !== 0) {
        allVZero = false;
        break;
      }
    }
    if (!allVZero) return; // already migrated, or column has training history
    for (let h = 0; h < outDim; h++) {
      const idx = h * inDim + PAIR_ROLE_COL;
      W[idx] = 0;
      m[idx] = 0;
      v[idx] = 0;
    }
    // Best-effort log so an operator tailing the container's stdout
    // can confirm the migration ran. Keep it terse — this fires at
    // most once per worker init.
    // eslint-disable-next-line no-console
    console.log(`[learning] Phase 3d.1: zero-init trunk[0].W column ${PAIR_ROLE_COL} (hasPairRole) on ${outDim} rows`);
  }

  /**
   * Build the round-context features carried in the engineered-feature
   * tail: productCount, pair-other-heuristic, budget, target-price
   * stats. Pre-PR-4 the budget + targetPrices fields were scaffolded
   * but never populated; PR #4 plumbs them through PredictReq from
   * the driver.
   */
  private deriveRoundContext(req: PredictReq): {
    productCount?: number;
    pairOtherCents?: number;
    budgetCents?: number;
    targetPricesCents?: ReadonlyArray<number>;
  } {
    const productCount = req.rankProducts?.length ?? (req.pairProducts ? 2 : 1);
    let pairOtherCents: number | undefined;
    if (req.pairProducts && req.pairProducts.length === 2) {
      const other = req.pairProducts[0].id === req.product.id
        ? req.pairProducts[1]
        : req.pairProducts[0];
      pairOtherCents = heuristicCents(other);
    }
    const budgetCents = req.budgetCents !== undefined && Number.isFinite(req.budgetCents) && req.budgetCents > 0
      ? req.budgetCents
      : undefined;
    const targetPricesCents = req.targetPricesCents && req.targetPricesCents.length > 0
      ? req.targetPricesCents.filter((p) => Number.isFinite(p) && p > 0)
      : undefined;
    return { productCount, pairOtherCents, budgetCents, targetPricesCents };
  }

  /** Normalised feature extraction. */
  private extract(req: {
    product: PredictReq["product"];
    mode: PredictReq["mode"];
    referencePrice?: number;
    hasPairRole?: boolean;
    roundContext?: import("./featureExtractor").RoundContext;
    brandTier?: import("./types").BrandTier;
    priceRangeCents?: { readonly min: number; readonly max: number };
    maxPriceCapCents?: number;
  }): {
    features: Float32Array;
    featuresNorm: Float32Array;
    heuristicCents: number;
    modeIdx: number;
    categoryId: number;
  } {
    const features = extractFeatures(req);
    // Phase 2: predict() must NOT mutate normalizer state. The previous
    // observe-on-predict path saw only the primary product per round,
    // so in multi-product modes (5-15 products) only 1/N contributed
    // to running stats while N/N landed in update(). The fix relocates
    // observe() into the per-sample loop in update() (~line 1097) so
    // train- and predict-time feature distributions agree.
    const featuresNorm = this.normalizer.normalize(features);
    const heuristic = heuristicCents(req.product);
    const modeIdx = GAME_MODE_ORDER.indexOf(req.mode);
    return {
      features,
      featuresNorm,
      heuristicCents: heuristic,
      modeIdx,
      categoryId: categoryBucket(req.product.category),
    };
  }

  /**
   * Forward through the priceClassHead and snap-resolve the catalog
   * price + dispersion-derived sigma. Returns:
   *   - predictedCents:      catalog[argmax(softmax(logits))]
   *   - predictedSigmaCents: sqrt(Σ p_i (price_i − E[price])²) — i.e.
   *                          the std of the catalog under the softmax
   *                          distribution. A confident model collapses
   *                          mass on a single bucket → small sigma; an
   *                          uncertain model spreads → big sigma.
   *   - probs:               softmax over the catalog (kept for the
   *                          visual tick + top-K display in PR #3).
   * Public so tests can assert against it without going through predict().
   */
  /**
   * Forward through the priceClassHead and snap-resolve the catalog.
   *
   * @param embedding         Trunk output (16-d).
   * @param cond              Optional FiLM cond vector. Skipped when
   *                          undefined OR `moodInfluence === 0`.
   * @param priceRangeCents   Optional decode-time mask bounds. Phase 2.
   * @param categoryId        Optional OOD bucket id. Phase 4: when
   *                          supplied, the head's softmax is blended
   *                          with the per-category Gaussian prior
   *                          using weight `tanh(n/20)`; cold-start
   *                          categories tilt toward the prior.
   * @returns predictedCents (catalog argmax of the blended+masked
   *          distribution), predictedSigmaCents (catalog spread under
   *          that distribution), probs (the final blended+masked
   *          distribution — what argmax was taken over), headProbs
   *          (the unblended head softmax — used by the caller for
   *          adaptiveEpsilon's entropy proxy so cold-start exploration
   *          tracks head uncertainty, NOT the artificially-peaked
   *          prior-dominated blend), topClassIdx.
   */
  predictFromPriceClassHead(
    embedding: Float32Array,
    cond?: Float32Array,
    priceRangeCents?: { readonly min: number; readonly max: number },
    categoryId?: number,
  ): {
    predictedCents: number;
    predictedSigmaCents: number;
    probs: Float32Array;
    headProbs: Float32Array;
    topClassIdx: number;
  } {
    // FiLM is skipped when cond is undefined OR the worker was
    // constructed with moodInfluence === 0. Either condition makes
    // the head's input bit-identical to the bare embedding (the
    // "inert-by-default" invariant) — see forwardFilm's identity-at-
    // scale-zero proof in mlp.ts.
    // Reuse the worker-owned `filmScratch` — single-threaded
    // worker, predict and update never overlap, so the scratch is
    // safe to share across both call sites.
    const headInput = (cond !== undefined && this.opts.moodInfluence > 0)
      ? forwardFilm(this.network.filmGen, cond, embedding, this.opts.moodInfluence, this.filmScratch).filmEmbedding
      : embedding;
    const logits = forwardLinear(this.network.priceClassHead, headInput);
    // If the head is producing non-finite logits the model is broken
    // (NaN-storm in progress, weights diverged, etc.). Returning NaN
    // here lets the snapshot regression gate's MAE check trip on
    // Infinity instead of silently snapping to a catalog price that
    // happens to be class index 0 — which would mask the breakage.
    for (let i = 0; i < logits.length; i++) {
      if (!Number.isFinite(logits[i])) {
        return {
          predictedCents: Number.NaN,
          predictedSigmaCents: Number.NaN,
          probs: new Float32Array(logits.length),
          headProbs: new Float32Array(logits.length),
          topClassIdx: 0,
        };
      }
    }
    const headProbs = softmax(logits);
    // Start `probs` as a copy so head uncertainty stays available
    // separately from the blended/masked distribution that drives
    // argmax. Caller uses headProbs for adaptiveEpsilon's entropy
    // proxy — cold-start should explore MORE, not less, but the
    // blend's peaked-prior would suppress exploration if we fed it
    // the blended entropy (PR #313 reviewer caught this).
    const probs = new Float32Array(headProbs);

    // Phase 4: blend the head softmax with the per-category Gaussian
    // prior over the catalog, weighted by `tanh(n/20)` — for
    // unfamiliar categories (n < 5) almost the full weight goes to
    // the prior, by n=60 the head dominates. Without this, cold-start
    // budget-builder products classify essentially randomly (1/103)
    // because the head has zero signal for never-seen categories.
    // Blends BEFORE the priceRange mask so the mask still applies to
    // the blended distribution.
    if (categoryId !== undefined) {
      const wNN = this.ood.blendWeightNN(categoryId);
      if (wNN < 1) {
        const prior = this.ood.priorOverCatalog(
          categoryId,
          this.priceCatalog.logPrices,
        );
        const wPrior = 1 - wNN;
        for (let i = 0; i < probs.length; i++) {
          probs[i] = wNN * probs[i] + wPrior * prior[i];
        }
      }
    }

    // Phase 2 decode-time action mask. When the round had a visible
    // bound (slider min/max, riser cap), zero out catalog classes
    // outside the range and renormalise before argmax/mean/var. This
    // prevents the bot from guessing a price the player can plainly
    // see is invalid. When all classes are masked (range doesn't
    // overlap the catalog) we fall through to unmasked — better an
    // out-of-range guess than no guess at all.
    if (priceRangeCents) {
      const { min, max } = priceRangeCents;
      // Snapshot the unmasked probs first so the fall-through path is
      // a real fall-through and not "argmax-of-zeros = class 0". PR
      // #311 reviewer caught the original implementation silently
      // collapsing to the cheapest catalog price (49¢) on degenerate
      // bounds, which would surface as a meaningless guess.
      const unmasked = new Float32Array(probs);
      let pSum = 0;
      for (let i = 0; i < probs.length; i++) {
        const inRange = this.priceCatalog.prices[i] >= min
          && this.priceCatalog.prices[i] <= max;
        if (!inRange) probs[i] = 0;
        pSum += probs[i];
      }
      if (pSum > 0) {
        for (let i = 0; i < probs.length; i++) probs[i] /= pSum;
      } else {
        // Mask zeroed everything (range doesn't overlap any catalog
        // class). Restore the unmasked softmax so argmax still
        // produces a meaningful guess.
        for (let i = 0; i < probs.length; i++) probs[i] = unmasked[i];
      }
    }

    let topClassIdx = 0;
    let topProb = probs[0];
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > topProb) {
        topProb = probs[i];
        topClassIdx = i;
      }
    }
    const predictedCents = this.priceCatalog.prices[topClassIdx];
    let mean = 0;
    for (let i = 0; i < probs.length; i++) mean += probs[i] * this.priceCatalog.prices[i];
    let variance = 0;
    for (let i = 0; i < probs.length; i++) {
      const d = this.priceCatalog.prices[i] - mean;
      variance += probs[i] * d * d;
    }
    const predictedSigmaCents = Math.max(1, Math.round(Math.sqrt(variance)));
    return { predictedCents, predictedSigmaCents, probs, headProbs, topClassIdx };
  }

  /**
   * Run inference for a single round. Pure — does not mutate the
   * network. Updates the lastPredictAt timestamp + the most-active
   * trail (cosmetic state for visual ticks).
   */
  predict(req: PredictReq): PredictRes {
    const t0 = Date.now();
    this.lastPredictAt = t0;
    // Round-context — productCount, pair-other-heuristic, budget,
    // target-price stats — derived once and threaded through every
    // feature-extraction call in this predict so the trunk sees the
    // same round-level signal for the primary product, the pair-other,
    // and every rank product.
    const roundContext = this.deriveRoundContext(req);
    // Phase 3a: brand-tier lookup at predict time so the trunk sees
    // the brand-tier one-hot. Same key as the update-time path
    // (asin → title fallback, lowercased + trimmed) — Phase 2's bug
    // fix made this lookup actually return signal. Use `has()` so the
    // one-hot is all-zeros for unknown brands; otherwise unknown
    // products would silently encode identically to mid-tier ones
    // (BrandTierTable.lookup defaults to 1=mid for misses).
    const predictAsin = (req.product as { asin?: string }).asin;
    const predictBrandKey = (predictAsin ?? req.product.title ?? "").toLowerCase().trim();
    const predictBrandTier = this.brandTiers.has(predictBrandKey)
      ? this.brandTiers.lookup(predictBrandKey)
      : undefined;
    const { featuresNorm, categoryId } = this.extract({
      ...req,
      roundContext,
      brandTier: predictBrandTier,
      // Phase 3a bound features in the trunk, alongside the Phase 2
      // decoder mask. Same fields the decoder uses, so the trunk
      // learns to anticipate the mask.
      priceRangeCents: req.priceRangeCents,
      maxPriceCapCents: req.maxPriceCapCents,
      // Phase 3c follow-up. The per-sample train path now sets
      // `hasPairRole: true` on each sample of a 2-product binary
      // round (comparison / 2-product higher-lower) to match the
      // pair forward path's `predictPairAIsCorrectProb`. The main
      // predict path must mirror that for the singleton heads
      // (priceClass / logPrice / squashedReg), otherwise the
      // trunk gets shaped against `hasPairRole=1` features at
      // train but reads `hasPairRole=0` features at predict —
      // a smaller but real new skew on those auxiliary heads.
      hasPairRole: Boolean(req.pairProducts && req.pairProducts.length === 2),
    });
    const ta = forwardTrunk(this.network, featuresNorm);

    // FiLM cond. Phase 3e.2: condDim slimmed 6 → 3, dropping the
    // round-context tail (log_budget, log_cap, productCount were
    // already in the trunk's engineered feature block, so feeding
    // them through FiLM was double-encoding). When moodInfluence > 0
    // we build cond from mood; when moodInfluence === 0 FiLM is
    // skipped via the bare-embedding path.
    // Phase 3d.2 (post-review fix): on bidding rounds, build cond
    // as a zero vector so FiLM is identity at the bid commitment
    // moment. Mood-driven tilt on a one-sided loss (overbid → 0)
    // is a textbook regret amplifier (game-theory PhD finding from
    // the consensus panel). Mood still drives the trunk for
    // priceClass + classic + HL + comparison decisions, plus
    // exploration ε and narrator selection — only the bidding
    // decision quantile sees an identity FiLM.
    const cond = req.mode === "bidding"
      ? new Float32Array(MODEL_SPEC.condDim)
      : (this.opts.moodInfluence > 0
        ? moodToCond(req.mood ?? { vibe: 0, morale: 0, streak: 0 })
        : undefined);

    // Single-task active path: classify into the canonical-prices
    // catalog. predictedCents is a real retail price like $8.99.
    // Phase 2: pass the per-product priceRange (or riser cap, encoded
    // as `{min: 0, max: cap}`) so the decoder masks out-of-range
    // catalog classes before argmax.
    const primaryRange = req.priceRangeCents ?? (
      req.maxPriceCapCents !== undefined && req.maxPriceCapCents > 0
        ? { min: 0, max: req.maxPriceCapCents }
        : undefined
    );
    // Phase 4: pass categoryId so the decode path blends with the
    // per-category Gaussian prior for cold-start categories.
    const classification = this.predictFromPriceClassHead(
      ta.embedding,
      cond,
      primaryRange,
      categoryId,
    );
    // Phase 3b: for single-product modes with a price range, the
    // squashed-regression head is the PRIMARY decision signal. Its
    // continuous output is feasible by construction, sidestepping
    // the catalog-snap calibration drift that hurts continuous
    // sliders (classic, closest, riser). The priceClassHead survives
    // as auxiliary trunk-shaper + BeliefCard top-K provider.
    const useSquashedReg =
      (req.mode === "classic"
        || req.mode === "closest-without-going-over"
        || req.mode === "riser")
      && primaryRange !== undefined;
    let predictedCents: number;
    let predictedSigmaCents: number;
    if (useSquashedReg) {
      const sr = forwardSquashedReg(this.network.squashedRegressionHead, ta.embedding, primaryRange);
      // The squashed-reg head learns the slider's continuous
      // truth; the priceClassHead's catalog-snap argmax is what
      // we previously used. We average them weighted by the
      // priceClass head's confidence (top-prob) so a confident
      // catalog match nudges the squashed estimate toward the
      // canonical price (e.g. when the game shows a clean $9.99
      // and the model has learned that one well), but a low-
      // confidence catalog argmax doesn't drag the continuous
      // estimate toward an arbitrary canonical price.
      const catTopProb = classification.probs[classification.topClassIdx] ?? 0;
      const blendW = Math.min(0.5, Math.max(0, catTopProb - 0.2));
      predictedCents = Math.round(
        (1 - blendW) * sr.predictedCents + blendW * classification.predictedCents,
      );
      // Sigma: keep the priceClass-derived spread as the primary
      // uncertainty signal (calibrated against the catalog) but
      // floor at a fraction of the range so the broadcast UI
      // never shows a misleadingly tight band on rounds where
      // the head is actually uncertain.
      const rangeWidth = primaryRange.max - primaryRange.min;
      predictedSigmaCents = Math.max(
        classification.predictedSigmaCents,
        Math.round(rangeWidth * 0.05),
      );
    } else {
      predictedCents = classification.predictedCents;
      predictedSigmaCents = classification.predictedSigmaCents;
    }

    // Top features by |contribution to embedding L2|. Cheap heuristic:
    // contribution_i = sum_j |W2[j,i]| · features[i]. Survived the PR-4
    // cleanup because the broadcast UX still surfaces "what tokens is
    // the bot keying on" via the BeliefCard's prettyFeatureName path.
    const contributions = new Float32Array(featuresNorm.length);
    for (let i = 0; i < featuresNorm.length; i++) {
      let s = 0;
      for (let h = 0; h < TRUNK_HIDDEN_DIM; h++) {
        s += Math.abs(this.network.trunk[0].W[h * featuresNorm.length + i]);
      }
      contributions[i] = s * Math.abs(featuresNorm[i]);
    }
    const indexed = Array.from(contributions).map((v, i) => ({ name: FEATURE_NAMES[i], contribution: v }));
    indexed.sort((a, b) => b.contribution - a.contribution);
    const topFeatures = indexed.slice(0, 5);

    // Model-uncertainty proxy for adaptiveEpsilon: normalised softmax
    // entropy of the classifier output. log(K) is the maximum entropy
    // (uniform softmax); divide to get a value in [0, 1]. Replaces the
    // pre-PR-4 regression-head sigma (which had no meaning post-cleanup).
    // Pair this with a fixed `sigmaCalibratedMedian = 0.5` (midpoint of
    // the normalised range) so the sigDiff = uncertainty − typical
    // semantic in adaptiveEpsilon stays interpretable.
    // Phase 4: feed the UNBLENDED head softmax to the entropy proxy.
    // The blended distribution is artificially peaked toward the
    // per-category prior on cold-start categories; using its entropy
    // would suppress exploration exactly when more is needed (new
    // category = head has zero signal = should EXPLORE more, not less).
    // Pre-Phase-4 the blend didn't exist, so `classification.probs`
    // and `classification.headProbs` were identical.
    const sigmaProxy = classifierEntropyNormalised(classification.headProbs);

    const explorationDraw = thompsonDraw(predictedCents, predictedSigmaCents, 1.5, this.opts.rng);
    const eps = this.adaptiveEpsilon(sigmaProxy, this.ood.entropyAt(categoryId), req.mode);

    // Most-active trail update — cosmetic.
    this.updateMostActive(featuresNorm, ta.hidden, ta.embedding);

    // Phase 3b binary-mode signal. When the runner sent
    // pairProducts (set for higher-lower / comparison), forward
    // BOTH products through the trunk and run pairLogitHead on
    // [emb_A; emb_B]. `sigmoid(logit) = P(pairProducts[0] is
    // higher / correct)`. Cost: one extra trunk-forward over what
    // predict() was already doing for `req.product`. Skipped on the
    // singleton path so non-pair modes pay nothing.
    let pairAIsCorrectProb: number | undefined;
    if (req.pairProducts && req.pairProducts.length === 2) {
      pairAIsCorrectProb = this.predictPairAIsCorrectProb(req, roundContext);
    }

    // Phase 3d.2 bidding-mode signals. Surface the squashedReg μ/σ on
    // log-residual + the pinballQ40 lower-quantile so the bidding
    // decoder has a calibrated price posterior AND a quantile-loss
    // safety floor. Both are no-ops on non-bidding modes; cost is
    // 2 tiny linear forwards on bidding rounds only.
    let squashedRegression: { mu: number; sigma: number } | undefined;
    let pinballQ40LogResidual: number | undefined;
    if (req.mode === "bidding") {
      // Phase 3d.2 (post-review fix): the bidding decoder needs μ
      // in log-RESIDUAL units (`log(actualCents / heuristic)`), not
      // log-cents. The squashedReg head is trained on bounded
      // single-product modes only and emits `raw` in
      // `log(predictedCents) − log(100)` units when bounds are
      // absent — that's silently mis-calibrated by `log(heuristic / 100)`
      // for bidding products. The cleanest source of a calibrated μ
      // is the priceClass head: `predictedCents` is the catalog
      // argmax for the round; `log(predictedCents / heuristic)` is
      // the desired residual exactly.
      const heuristicForBid = heuristicCents(req.product);
      const mu = predictedCents > 0 && heuristicForBid > 0
        ? Math.log(predictedCents / Math.max(heuristicForBid, 1))
        : 0;
      // Posterior sigma in log-residual units. Map sigmaProxy
      // (normalised classifier entropy ∈ [0, 1]) to a reasonable
      // log-residual spread: 0.1 (very confident) → 0.6 (uniform).
      const sigma = 0.1 + 0.5 * Math.max(0, Math.min(1, sigmaProxy));
      squashedRegression = { mu, sigma };
      // pinballQ40: trained under pinball loss on `targetLogResidual`
      // (see runMinibatchStep — the bidding-only K&G slot is fed the
      // residual target directly). Strategy uses heuristic·exp(q40)
      // as a calibrated safe-bid floor.
      const q40 = forwardPinballQ40(this.network.pinballQ40Head, ta.embedding);
      pinballQ40LogResidual = Number.isFinite(q40) ? q40 : 0;
    }

    let rankPredictions: Array<{ id: number; predictedCents: number; sigma: number }> | undefined;
    if (req.rankProducts && req.rankProducts.length > 0) {
      rankPredictions = req.rankProducts.map((p, idx) => {
        // Phase 2: per-rank-product priceRange when supplied. Falls
        // back to the round-level cap (riser) so multi-product modes
        // with a shared upper bound still benefit.
        const rng = req.rankPriceRangesCents?.[idx]
          ?? (req.maxPriceCapCents !== undefined && req.maxPriceCapCents > 0
            ? { min: 0, max: req.maxPriceCapCents }
            : undefined);
        // Phase 3a: brand-tier lookup per rank-product so the trunk
        // sees brand-tier signal for each ranked candidate. has()-gate
        // matches the primary-product path — unknown brands → all-zero
        // one-hot, not a silent collapse onto the mid tier.
        const rAsin = (p as { asin?: string }).asin;
        const rBrandKey = (rAsin ?? p.title ?? "").toLowerCase().trim();
        const rBrandTier = this.brandTiers.has(rBrandKey)
          ? this.brandTiers.lookup(rBrandKey)
          : undefined;
        const rCategoryId = categoryBucket(p.category);
        const f = extractFeatures({
          mode: req.mode,
          product: p,
          referencePrice: req.referencePrice,
          roundContext,
          brandTier: rBrandTier,
          priceRangeCents: rng,
          maxPriceCapCents: req.maxPriceCapCents,
        });
        const n = this.normalizer.normalize(f);
        const t = forwardTrunk(this.network, n);
        // Phase 4: pass per-rank-product categoryId so each rank
        // candidate gets its own OOD-prior blend.
        const c = this.predictFromPriceClassHead(t.embedding, cond, rng, rCategoryId);
        return { id: p.id, predictedCents: c.predictedCents, sigma: c.predictedSigmaCents };
      });
    }

    // Top-5 catalog candidates from the classifier. Returns [] when
    // logits are non-finite, signalling broken-network state to
    // downstream consumers.
    const priceCandidates = topKCatalogCandidates(classification.probs, this.priceCatalog, 5);

    // 2-d viz coordinate sourced from the first two embedding dims (no
    // separate viz head post-PR-4). The broadcast EmbeddingScatter
    // panel just needs *some* 2-d projection of the trunk's belief —
    // taking dims 0/1 of the 16-d embedding works; the panel auto-
    // ranges its axes from observed values.
    const embedding2d: [number, number] = [ta.embedding[0], ta.embedding[1]];

    // Cache for the next visual tick. Float32Arrays are cheap to keep
    // around (≤200 numbers each); they're held until the next predict
    // overwrites them.
    this.lastPredict = {
      trunkHidden: ta.hidden,
      embedding: ta.embedding,
      predictedCents,
      predictedSigmaCents,
      embedding2d,
      topFeatures,
      priceCandidates,
    };

    return {
      roundId: req.roundId,
      predictedCents,
      predictedSigmaCents,
      embedding2d,
      topFeatures,
      rankPredictions,
      priceCandidates,
      ageMs: Date.now() - t0,
      explorationDraw,
      epsilon: eps,
      pairAIsCorrectProb,
      squashedRegression,
      pinballQ40LogResidual,
    };
  }

  /**
   * Phase 3b helper: forward both pair products through the trunk
   * and the pair-logit head, returning `sigmoid(logit) = P(A is
   * higher / correct)` where `A === req.pairProducts[0]`.
   *
   * The convention is documented on `PredictRes.pairAIsCorrectProb`.
   * Strategy code consumes this as the *direct* decision signal —
   * preferred over comparing two `predictedCents` values that both
   * pass through the masked-softmax decoder, which has its own
   * calibration noise.
   *
   * Pure (does not mutate the network or `lastPredictAt`). Round
   * context must already have been derived for the predict call so
   * the per-product feature extractions all see the same numerics.
   */
  private predictPairAIsCorrectProb(
    req: PredictReq,
    roundContext: ReturnType<WorkerCore["deriveRoundContext"]>,
  ): number {
    const [a, b] = req.pairProducts as [PredictReq["product"], PredictReq["product"]];
    // Brand-tier lookup matches predict()'s primary-product path so
    // both pair embeddings see the same feature pipeline. has()-gate
    // means unknown brands map to all-zero brand-tier one-hot — same
    // as predict(req.product).
    const lookupTier = (p: PredictReq["product"]) => {
      const asin = (p as { asin?: string }).asin;
      const key = (asin ?? p.title ?? "").toLowerCase().trim();
      return this.brandTiers.has(key) ? this.brandTiers.lookup(key) : undefined;
    };
    const fA = extractFeatures({
      mode: req.mode,
      product: a,
      referencePrice: req.referencePrice,
      roundContext,
      brandTier: lookupTier(a),
      // Per-pair-product priceRange when the runner sent
      // rankPriceRangesCents (rare in pair modes); otherwise fall
      // through to the round-level priceRangeCents which the runner
      // sets to the primary product's range.
      priceRangeCents: req.priceRangeCents,
      maxPriceCapCents: req.maxPriceCapCents,
      hasPairRole: true,
    });
    const fB = extractFeatures({
      mode: req.mode,
      product: b,
      referencePrice: req.referencePrice,
      roundContext,
      brandTier: lookupTier(b),
      priceRangeCents: req.priceRangeCents,
      maxPriceCapCents: req.maxPriceCapCents,
      hasPairRole: true,
    });
    const nA = this.normalizer.normalize(fA);
    const nB = this.normalizer.normalize(fB);
    const tA = forwardTrunk(this.network, nA);
    const tB = forwardTrunk(this.network, nB);
    // Phase 3e.2: derive the 3 stop-gradient scalar features from
    // per-product priceClass argmax. Bare-embedding + UNMASKED
    // (no FiLM, no category prior, no range mask) — the train path
    // (`computeRoundCoherentPairLogit`) doesn't have access to a
    // per-pair-product range either, and the round-level
    // `req.priceRangeCents` is the PRIMARY product's range; applying
    // it to product B can mask out catalog classes B legitimately
    // predicts. Unmasked-on-both keeps train and predict symmetric
    // and avoids per-pair-product range plumbing.
    const cA = this.predictFromPriceClassHead(tA.embedding);
    const cB = this.predictFromPriceClassHead(tB.embedding);
    const scalars = pairLogitScalarFeatures(cA.predictedCents, cB.predictedCents);
    const { logit } = forwardPairLogit(
      this.network.pairLogitHead,
      tA.embedding,
      tB.embedding,
      scalars,
    );
    if (!Number.isFinite(logit)) return 0.5;
    return 1 / (1 + Math.exp(-logit));
  }

  /**
   * Apply one round's update — extracts samples from `revealedSamples`,
   * pushes them into the replay, runs `stepsPerRound` minibatch updates,
   * computes the per-task losses, runs the NaN guard, schedules a
   * snapshot, and emits an NDJSON row.
   */
  update(req: UpdateReq): {
    ok: boolean;
    loss: number;
    nanRollback: boolean;
    snapshotRound?: number;
    teachingMomentTriggered: boolean;
    /**
     * Phase 3c: per-task loss array from the final inner step,
     * indexed by {@link TASK_INDEX}. Slots for tasks that didn't
     * fire this round are 0 — useful for tests / observability to
     * verify the round-coherent step dispatched correctly. Null
     * when the round was skipped (NaN-storm freeze, empty buffer).
     */
    perTaskLosses?: ReadonlyArray<number>;
  } {
    this.round += 1;
    // Round-context for the training samples — productCount derived
    // from the revealed-samples count; pair-other heuristic populated
    // when exactly two products were revealed. Phase 2: budget /
    // target-prices / max-price-cap are now plumbed end-to-end via
    // {@link UpdateReq}, so train-time RoundContext matches what the
    // predict path saw — fixing a textbook train/test skew that pinned
    // those feature dims at 0 during training and at the real value
    // at decode.
    const updateProductCount = req.revealedSamples.length;
    const newSamples: Sample[] = [];
    for (let rIdx = 0; rIdx < req.revealedSamples.length; rIdx++) {
      const r = req.revealedSamples[rIdx];
      if (!Number.isFinite(r.actualCents) || r.actualCents <= 0) continue;
      const heur = heuristicCents(r.product);
      const target = Math.log(r.actualCents / Math.max(heur, 1));
      let pairOtherCents: number | undefined;
      if (req.revealedSamples.length === 2) {
        const otherR = req.revealedSamples[1 - rIdx];
        pairOtherCents = heuristicCents(otherR.product);
      }
      // Phase 3a: compute brand-tier BEFORE extractFeatures so the
      // trunk sees the brand-tier one-hot. has()-gated so unknown
      // brands yield an all-zero one-hot; same gating as predict.
      // Note `brandTier` (BrandTier) is also stored on the Sample for
      // backwards-compat — the Sample.brandTier always falls back to
      // mid (1) per the existing contract used by older code paths;
      // the Phase 3a feature one-hot uses the gated value instead.
      const asin = (r.product as { asin?: string }).asin;
      const brandKey = (asin ?? r.product.title ?? "").toLowerCase().trim();
      const brandTier = this.brandTiers.lookup(brandKey);
      const featureBrandTier = this.brandTiers.has(brandKey) ? brandTier : undefined;
      const features = extractFeatures({
        mode: r.mode,
        product: r.product,
        roundContext: {
          productCount: updateProductCount,
          pairOtherCents,
          // Phase 2: round-level constraints from UpdateReq. Same
          // shape predict() sees, so the trunk's round-context
          // features (and any future masking-aware features) get
          // the same input at train and predict time.
          budgetCents: req.budgetCents,
          targetPricesCents: req.targetPricesCents,
        },
        brandTier: featureBrandTier,
        // Phase 3a bound features at train time. Persisted on the
        // Sample (Phase 2) so the train and predict-time feature
        // vectors agree.
        priceRangeCents: r.priceRangeCents,
        maxPriceCapCents: req.maxPriceCapCents,
        // Phase 3c follow-up. Predict-time `predictPairAIsCorrectProb`
        // calls extractFeatures with `hasPairRole: true` for both
        // products in a 2-product binary round (comparison /
        // higher-lower). Pre-fix the train path didn't pass it, so
        // the pairLogit head's gradients shaped the trunk against
        // `hasPairRole=0` features while predict read the
        // `hasPairRole=1` slot — train/test skew that silently
        // wasted every gradient step. Mirror predict here so the
        // head's training actually improves predict-time accuracy.
        hasPairRole: req.revealedSamples.length === 2
          && (r.mode === "comparison" || r.mode === "higher-lower"),
      });
      // Phase 2: observe per-sample (not per-predict) so multi-product
      // modes contribute every product to the running stats. See
      // comment at extract() for the train/predict-distribution-skew
      // rationale.
      this.normalizer.observe(features);
      const categoryId = r.categoryId ?? categoryBucket(r.product.category);
      const sample: Sample = {
        features,
        targetLogResidual: target,
        actualCents: r.actualCents,
        heuristicCents: heur,
        categoryId,
        brandTier,
        mode: r.mode,
        productId: (r.product as { id?: number }).id ?? 0,
        roundId: req.roundId,
        recordedAtRound: this.round,
        // Stamp the bot's current mood (vibe + morale only — streak
        // is a round-level signal that doesn't generalise to a
        // historical training sample). Absent when the runner hasn't
        // started shipping mood; treated as identity FiLM at train
        // time. Kept on the Sample so future minibatches that draw
        // this sample apply FiLM under the mood it was observed in.
        mood: req.mood !== undefined
          ? { vibe: req.mood.vibe, morale: req.mood.morale }
          : undefined,
        // Phase 2: persist the bounds the player saw at predict time.
        // Train-time CE masking restricts the loss / smoothing kernel
        // to in-range catalog classes, matching what the decoder's
        // argmax mask did at predict.
        priceRangeCents: r.priceRangeCents,
        // Phase 3a: snapshot the round-context numerics so train-time
        // FiLM cond reproduces what predict() saw. Otherwise the
        // cond[3..5] block is zero at train and non-zero at predict —
        // the FiLM head would learn to ignore them.
        roundContextSnapshot: {
          budgetCents: req.budgetCents,
          maxPriceCapCents: req.maxPriceCapCents,
          productCount: updateProductCount,
        },
        // Phase 3d.2: persist the bidding-turn snapshot the runner
        // saw at predict time. Used by train-time forward to populate
        // the 5 bidding-context feature dims. Only populated for
        // bidding rounds; absent on every other mode.
        biddingContext: r.biddingContext,
      };
      newSamples.push(sample);
      this.replay.push(sample, 1.0);
      this.ood.observe(categoryId, r.actualCents);
    }

    if (this.replay.size() === 0) {
      // Nothing to train on yet.
      this.recentLosses.push(0);
      this.lastTeachingTriggered = false;
      return { ok: true, loss: 0, nanRollback: false, teachingMomentTriggered: false };
    }
    if (this.frozen) {
      // NaN storm: skip training entirely. We still log the round and
      // run the disk-pressure check so the operator's /healthz signal
      // stays current, and we re-evaluate the storm window so the
      // freeze automatically thaws once the rate drops back to safe.
      const now = Date.now();
      const windowStart = now - NAN_STORM_WINDOW_MS;
      while (
        this.nanRollbackEpochs.length > 0
        && this.nanRollbackEpochs[0] < windowStart
      ) {
        this.nanRollbackEpochs.shift();
      }
      if (this.nanRollbackEpochs.length <= NAN_STORM_THRESHOLD) {
        this.frozen = false;
      }
      this.recentLosses.push(0);
      if (newSamples.length > 0) {
        this.recentAccuracy.push(outcomeToBucket(req.outcome));
      }
      void this.ndjson?.write({
        ts: now,
        round: this.round,
        mode: req.primaryMode,
        outcome: req.outcome,
        loss: 0,
        bufferSize: this.replay.size(),
        nanRollback: false,
        frozen: true,
      });
      this.lastTeachingTriggered = false;
      return { ok: true, loss: 0, nanRollback: false, teachingMomentTriggered: false };
    }

    // Save a rollback point before any param mutation.
    this.captureRollbackSnapshot();

    let totalLoss = 0;
    let teachingTriggered = false;
    let lastBatchPriorities: { indices: number[]; values: Float32Array } | null = null;
    let lastPerTaskLosses: Float32Array | null = null;
    const rng = this.opts.rng ?? Math.random;
    // Divergence-event aggregation: track the worst per-step pre-clip
    // grad norm and whether any step's totalLoss went non-finite. We
    // emit at most one ndjson event per round so a 6-step round can't
    // produce 6 duplicate events. The signal is purely observational
    // — the rollback gate (param-NaN check below) is unchanged. Phase 1
    // of the recovery plan extends the gate to act on these signals.
    let maxStepGradNormPreClip = 0;
    let stepLossNonFinite = false;

    // Phase 3c: K&G multipliers for the round-coherent step. Same
    // derivation `runMinibatchStep` does internally — stable across
    // the whole `update()` call because `this.round` doesn't change
    // and `this.uncertainty.tasksObserved` only mutates after the
    // last step. Computed once and passed to
    // {@link computeRoundCoherentExtras}, which folds into the per-
    // sample step's accumulators on the FINAL inner step.
    const roundCoherentKgMul = new Float32Array(NUM_ACTIVE_TASKS);
    for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
      const observed = this.uncertainty.tasksObserved[t];
      const useKG =
        this.round >= FIXED_PHASE_ROUNDS && observed >= MIN_TASK_OBSERVATIONS;
      if (useKG) {
        const sigma2 = Math.exp(this.uncertainty.logSigma2[t]);
        roundCoherentKgMul[t] = 1 / (2 * sigma2);
      } else {
        roundCoherentKgMul[t] = FIXED_TASK_WEIGHTS[t];
      }
    }

    for (let step = 0; step < this.opts.stepsPerRound; step++) {
      const batch = this.replay.sample(this.opts.batchSize, this.round, rng);
      // Mix-in teaching moments every step.
      // Phase 1: 4 → 1. With drawForReplay=4 and stepsPerRound=6, every
      // round was mixing 24 teaching draws into ~96 replay samples —
      // 25% over-weighting of edge cases. Dropped to 1 per step (=6/round
      // total) so teaching moments stay influential without crowding out
      // typical-sample learning.
      const tmDraws = this.teaching.drawForReplay(this.round, 1, rng);
      const samples: Sample[] = [...batch.samples, ...tmDraws];
      const isWeights = new Float32Array(samples.length);
      isWeights.set(batch.isWeights, 0);
      for (let k = batch.isWeights.length; k < isWeights.length; k++) isWeights[k] = 1;

      // Phase 3c: round-coherent extras run once per round, on the
      // final inner step only. Multiplicity matches the round itself
      // (one set of just-revealed samples per `update()`), so re-
      // running on every inner step would over-weight them.
      const isFinalStep = step === this.opts.stepsPerRound - 1;
      const roundCoherentExtras = isFinalStep
        ? this.computeRoundCoherentExtras(newSamples, req, roundCoherentKgMul)
        : undefined;

      const stepResult = this.runMinibatchStep(samples, isWeights, step, roundCoherentExtras);
      totalLoss += stepResult.totalLoss;
      lastBatchPriorities = { indices: batch.indices, values: stepResult.priorities };
      if (stepResult.teachingTriggered) teachingTriggered = true;
      // Phase 3b: keep the most-recent step's per-task array. The
      // round-level NDJSON / nn_round_log captures one row per
      // round, so we just take the last step (representative of
      // the converged within-round state).
      lastPerTaskLosses = stepResult.perTaskLosses;
      // NaN-aware aggregation. `>` returns false for NaN, so a NaN
      // gradient with a finite loss would silently miss the divergence
      // event. Treat any non-finite per-step grad as worst-case so the
      // event fires; record `Infinity` so the ndjson reader can tell
      // them apart from large-but-finite spikes.
      if (!Number.isFinite(stepResult.gradNormPreClip)) {
        maxStepGradNormPreClip = Number.POSITIVE_INFINITY;
      } else if (stepResult.gradNormPreClip > maxStepGradNormPreClip) {
        maxStepGradNormPreClip = stepResult.gradNormPreClip;
      }
      if (!Number.isFinite(stepResult.totalLoss)) stepLossNonFinite = true;
    }

    if (lastBatchPriorities) {
      this.replay.updatePriorities(
        lastBatchPriorities.indices,
        lastBatchPriorities.values.subarray(0, lastBatchPriorities.indices.length),
      );
    }

    // NaN guard. Three trigger conditions, in priority order:
    //   1. Any param buffer is non-finite (the original gate, which
    //      essentially never fired because clipping at 0.5 keeps
    //      weights finite even under noisy grads).
    //   2. A step's pre-clip grad norm exceeded
    //      DIVERGENCE_GRAD_NORM_THRESHOLD (1e5). Phase 0 instrumented
    //      this signal; Phase 1 extends rollback to act on it.
    //   3. A step's totalLoss went non-finite. Same source.
    //
    // Identifying which buffer first failed `checkFinite` is the
    // difference between a 5-minute debug ("filmGen-NaN means cond
    // went wild") and a 5-hour debug (whole network is suspect).
    // The names array is kept in sync with `iterParamBuffers` and
    // `GRAD_IDX` above.
    let nanRollback = false;
    let allFinite = true;
    let firstNonFiniteName = "";
    let bufIdx = 0;
    for (const buf of iterParamBuffers(this.network)) {
      if (!checkFinite(buf)) {
        allFinite = false;
        firstNonFiniteName = PARAM_BUFFER_NAMES[bufIdx] ?? `buf[${bufIdx}]`;
        break;
      }
      bufIdx += 1;
    }
    const gradExploded = maxStepGradNormPreClip > DIVERGENCE_GRAD_NORM_THRESHOLD;
    const lossNonFinite = stepLossNonFinite;
    const shouldRollback = !allFinite || gradExploded || lossNonFinite;
    if (shouldRollback) {
      // Phase 1 extends the gate. Keep the "first failing buffer:" prefix
      // when the param-finite check tripped (existing logs/tests grep for
      // it); add the new conditions as appended context. Reviewer (PR
      // #310) asked the grad-explosion branch to also surface the most-
      // affected buffer for parity with the param-NaN debug aid — we
      // probe by computing per-buffer L2 and reporting the worst.
      const reason = !allFinite
        ? `non-finite values detected — rolling back. first failing buffer: ${firstNonFiniteName}`
        : gradExploded
          ? `grad-explosion — rolling back. preClipNorm=${maxStepGradNormPreClip.toExponential(2)} (threshold ${DIVERGENCE_GRAD_NORM_THRESHOLD.toExponential(0)}); largest-norm buffer: ${largestNormBuffer(this.network)}; largest-RMS buffer: ${largestRMSBuffer(this.network)}`
          : `loss non-finite — rolling back.`;
      // eslint-disable-next-line no-console
      console.error(`[learning] ${reason}`);
      this.restoreRollbackSnapshot();
      this.nanRollbacks += 1;
      nanRollback = true;
      // NaN-storm detection — record the rollback timestamp and check
      // whether we've crossed the threshold inside the rolling window.
      // Once frozen, the bot continues serving predict() (still on
      // restored params) but skips Adam steps in subsequent updates
      // until the rate falls back below threshold.
      const now = Date.now();
      this.nanRollbackEpochs.push(now);
      const windowStart = now - NAN_STORM_WINDOW_MS;
      while (
        this.nanRollbackEpochs.length > 0
        && this.nanRollbackEpochs[0] < windowStart
      ) {
        this.nanRollbackEpochs.shift();
      }
      if (this.nanRollbackEpochs.length > NAN_STORM_THRESHOLD) {
        this.frozen = true;
      }
    }

    // Per-round telemetry.
    const avgLoss = totalLoss / Math.max(1, this.opts.stepsPerRound);
    this.recentLosses.push(avgLoss);
    // Round-level accuracy. The "Last 10 Guesses" panel renders one dot
    // per round, keyed off the game's actual outcome — not a re-derived
    // per-product price-class argmax. The previous per-sample bucket
    // logic re-ran predictFromPriceClassHead AFTER the optimizer step
    // and compared its catalog argmax to each individual product's
    // actualCents; that diverged from the game's mode-specific win
    // condition (e.g., comparison mode is binary by product ID, not by
    // per-product price accuracy), so a round the game scored "correct"
    // could still surface red dots if the post-update re-prediction was
    // off by >10% on either product. Sourcing from req.outcome makes
    // the panel reflect what viewers actually saw.
    if (newSamples.length > 0) {
      this.recentAccuracy.push(outcomeToBucket(req.outcome));
    }

    // Snapshot scheduling. The retry-round floor (`nextSnapshotRetryRound`)
    // throttles repeated attempts after a regression-gate refusal so the
    // golden eval doesn't run every round while the model is stuck.
    let snapshotRound: number | undefined;
    if (
      !nanRollback
      && this.round - this.lastSnapshotRound >= this.opts.snapshotInterval
      && this.round >= this.nextSnapshotRetryRound
    ) {
      this.pendingSnapshot = true;
    }
    if (this.pendingSnapshot && Date.now() - this.lastPredictAt > 2000) {
      this.snapshotNow();
      snapshotRound = this.round;
    }

    // Divergence event — emitted at most once per round when EITHER a
    // step's pre-clip grad norm crossed `DIVERGENCE_GRAD_NORM_THRESHOLD`
    // (raw backward-pass blowup) OR a step's totalLoss went non-finite
    // (NaN/Inf in the loss path). Observability-only in Phase 0; the
    // existing param-NaN rollback gate is unchanged. Phase 1 of the
    // recovery plan extends the rollback gate to also act on these
    // signals so divergence triggers a snapshot revert rather than
    // being merely logged.
    if (
      maxStepGradNormPreClip > DIVERGENCE_GRAD_NORM_THRESHOLD
      || stepLossNonFinite
    ) {
      void this.ndjson?.write({
        ts: Date.now(),
        type: "divergence_event",
        round: this.round,
        mode: req.primaryMode,
        outcome: req.outcome,
        maxStepGradNormPreClip,
        stepLossNonFinite,
        avgLoss,
        gradNormP95: this.gradNormRing.p95(),
        gradNormPostClipP95: this.gradNormPostClipRing.p95(),
      });
    }

    // Phase 3b: drive K&G state once per ROUND (not per-step). The
    // minibatch loop above ran stepsPerRound back-to-back; calling
    // applyGradient + noteRoundObserved inside that loop would
    // inflate the per-task observation counter and σ² evolution by
    // ~stepsPerRound, breaking the MIN_TASK_OBSERVATIONS gate.
    if (lastPerTaskLosses) {
      const taskMask = new Uint8Array(NUM_ACTIVE_TASKS);
      for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
        if (lastPerTaskLosses[t] > 0 && Number.isFinite(lastPerTaskLosses[t])) {
          taskMask[t] = 1;
        }
      }
      const combine = this.uncertainty.combine(lastPerTaskLosses, taskMask, {
        round: this.round,
      });
      // SGD step on logSigma2 with 0.1× the optimizer's effective lr —
      // K&G evolves slowly relative to the head weights.
      const lr = this.optimizer.effectiveLr(Math.max(1, this.optimizer.step_count)) * 0.1;
      const scaledGrad = new Float32Array(NUM_ACTIVE_TASKS);
      for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
        scaledGrad[t] = combine.dLogSigma2[t] * lr;
      }
      this.uncertainty.applyGradient(scaledGrad);
      this.uncertainty.noteRoundObserved(taskMask);
    }

    // NDJSON log (best-effort).
    void this.ndjson?.write({
      ts: Date.now(),
      round: this.round,
      mode: req.primaryMode,
      outcome: req.outcome,
      loss: avgLoss,
      bufferSize: this.replay.size(),
      nanRollback,
      teachingTriggered,
    });
    this.persistence?.logRound({
      round: this.round,
      mode: req.primaryMode,
      outcome: req.outcome,
      loss: avgLoss,
      gradNorm: this.gradNormRing.p95(),
      gradNormPostClip: this.gradNormPostClipRing.p95(),
      // Phase 3d.2 per-task array. Indices match TASK_INDEX:
      //   0 pairLogit, 1 squashedReg, 2 pinballQ40,
      //   3 priceClass, 4 logPrice
      perTaskLosses: lastPerTaskLosses
        ? Array.from(lastPerTaskLosses)
        : null,
    });

    // Surface the trigger to the next visual tick. Reset on the next
    // non-triggering update so the panel's "aha" pulse fires once.
    this.lastTeachingTriggered = teachingTriggered;

    return {
      ok: true,
      loss: avgLoss,
      nanRollback,
      snapshotRound,
      teachingMomentTriggered: teachingTriggered,
      perTaskLosses: lastPerTaskLosses ? Array.from(lastPerTaskLosses) : undefined,
    };
  }

  /**
   * Run one Adam step over a minibatch — single-task ordinal CE on the
   * priceClassHead. Forward through the trunk, classify into the
   * canonical-prices catalog, backprop, accumulate gradients, clip,
   * step Adam. Per-sample loss is the ordinal-smoothed CE itself,
   * which drives both the replay-buffer priority and the teaching-
   * moment trigger.
   *
   * The `step` parameter is unused (it drove GradVac-lite's every-8th
   * head-drop in pre-PR-4 multi-task training) but we keep it in the
   * signature for call-site compat.
   */
  private runMinibatchStep(
    samples: Sample[],
    isWeights: Float32Array,
    _step: number,
    extras?: RoundCoherentExtras,
  ): {
    totalLoss: number;
    priorities: Float32Array;
    teachingTriggered: boolean;
    /** Pre-clip global L2 grad norm for this step (the raw backward signal). */
    gradNormPreClip: number;
    /**
     * Phase 3b: per-task minibatch loss array (length NUM_ACTIVE_TASKS),
     * indexed by {@link TASK_INDEX}. Slots for tasks that didn't fire
     * this minibatch are 0 (and the combine-mask is 0 for them).
     */
    perTaskLosses: Float32Array;
  } {
    if (samples.length === 0) {
      // Precondition: caller (`update()`) only invokes
      // `runMinibatchStep` after pushing the just-revealed samples
      // into the replay buffer, so `samples` from a non-empty buffer
      // is never empty in production. If `extras` is non-null on this
      // branch we drop the round-coherent gradients silently — the
      // contract is that the caller has already validated samples.
      // Documented here so a future caller doesn't blunder into a
      // silent gradient-loss bug.
      return {
        totalLoss: 0,
        priorities: new Float32Array(0),
        teachingTriggered: false,
        gradNormPreClip: 0,
        perTaskLosses: new Float32Array(NUM_ACTIVE_TASKS),
      };
    }
    // Allocate per-buffer gradient accumulators (in iterParamBuffers
    // order — covers trunk + priceClassHead + filmGen + Phase 3b
    // heads).
    const paramBufs = Array.from(iterParamBuffers(this.network));
    const grads = paramBufs.map((b) => new Float32Array(b.length));
    const sampleLosses = new Float32Array(samples.length);
    // Phase 3b: per-task accumulator (running sum across the
    // minibatch; divided by counts at the end).
    const perTaskLossSum = new Float32Array(NUM_ACTIVE_TASKS);
    const perTaskCount = new Int32Array(NUM_ACTIVE_TASKS);
    // K&G grad multipliers for THIS minibatch — derived once from
    // per-task means so the chain rule below scales each task's
    // gradients consistently. We don't yet know the means, so:
    // pass 1 computes per-task losses + raw gradients; we then use
    // the running mean to derive K&G multipliers and scale grads.
    // Implementation: accumulate raw per-task gradients into
    // task-segregated buffers, scale at the end. For simplicity in
    // this shipping cut, we instead use the FIXED-PHASE multipliers
    // directly during accumulation. The K&G phase still uses fixed
    // weights for round < FIXED_PHASE_ROUNDS (≥2000); after that we
    // use the prior round's σ² (read from `this.uncertainty`) which
    // is a 1-step-stale estimate — acceptable since σ² changes
    // slowly. This keeps the minibatch step single-pass.

    const moodInfluenceLocal = this.opts.moodInfluence;

    // Phase 3b K&G multipliers, computed ONCE per minibatch step
    // (was: once per sample inside the loop). The values depend on
    // `this.round` (constant across the step) and
    // `this.uncertainty.tasksObserved` (the K&G state evolves only
    // at the end of `update()`, never inside this function), so a
    // single pre-loop computation is consistent with the per-round
    // accounting fix above.
    const kgMul = new Float32Array(NUM_ACTIVE_TASKS);
    for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
      const observed = this.uncertainty.tasksObserved[t];
      const useKG =
        this.round >= FIXED_PHASE_ROUNDS && observed >= MIN_TASK_OBSERVATIONS;
      if (useKG) {
        const sigma2 = Math.exp(this.uncertainty.logSigma2[t]);
        kgMul[t] = 1 / (2 * sigma2);
      } else {
        kgMul[t] = FIXED_TASK_WEIGHTS[t];
      }
    }

    for (let s = 0; s < samples.length; s++) {
      const sample = samples[s];
      const moodActiveForSample = moodInfluenceLocal > 0 && sample.mood !== undefined;
      // Per-sample arousal-gated importance bias. Multiplies the
      // existing `isWeights[s]` (priority-replay correction) — the
      // combined `w` rides through `scaleClone(ord.grad, w)` so all
      // downstream gradients inherit the boost without any further
      // wiring. Applies symmetrically in vibe sign (GANE — Mather &
      // Sutherland 2011).
      const arousalGain = moodActiveForSample
        ? arousalGainFor(sample.mood!.vibe, moodInfluenceLocal)
        : 1;
      // Use stored `features` (raw); normalise here so the running stats stay live.
      const xNorm = this.normalizer.normalize(sample.features);
      const ta = forwardTrunk(this.network, xNorm);

      // FiLM cond — skipped when the worker is running with
      // `moodInfluence === 0`. Phase 3a: when moodInfluence > 0 we
      // ALWAYS build cond (using a neutral mood fallback for legacy
      // replays without mood) so train-time mirrors predict-time —
      // predict() builds cond unconditionally with a neutral fallback
      // when moodInfluence > 0 because cond[3..5] (round-context
      // numerics) are useful even with neutral mood. Pre-Phase-3a we
      // gated on `sample.mood !== undefined`, which created an
      // asymmetric distribution shift on the head input. PR #312's
      // reviewer caught this.
      // `roundContextSnapshot` may be absent on pre-Phase-3a samples
      // (the field was added in this PR); undefined → cond[3..5]
      // zeroes out, same as a fresh predict with no round context.
      // Phase 3d.2: bidding samples train under identity FiLM —
      // symmetric with the predict-time zero-cond branch so the
      // head learns a mood-invariant bidding posterior.
      const moodForFilm = sample.mood ?? { vibe: 0, morale: 0, streak: 0 };
      const condForFilm = sample.mode === "bidding"
        ? new Float32Array(MODEL_SPEC.condDim)
        : moodInfluenceLocal > 0
        ? moodToCond(moodForFilm)
        : undefined;
      const filmFwd = condForFilm !== undefined
        ? forwardFilm(
            this.network.filmGen,
            condForFilm,
            ta.embedding,
            moodInfluenceLocal,
            this.filmScratch,
          )
        : null;
      const headInput = filmFwd !== null ? filmFwd.filmEmbedding : ta.embedding;

      // Forward through priceClassHead, compute ordinal-smoothed CE.
      // Target index = snap-resolve from the actual cents (cheap; the
      // catalog is fixed).
      const targetClassIdx = this.priceCatalog.snap(sample.actualCents);
      const classLogits = forwardLinear(this.network.priceClassHead, headInput);
      // Signed prediction error for the Eldar-Niv mood-congruent
      // credit gain. Computed from the model's CURRENT belief about
      // this sample (argmax of post-FiLM-if-active head logits;
      // softmax-equivalent because softmax is monotonic) so a
      // sample replayed multiple times sees its current PE, not a
      // stale one. Convention: positive PE means the model
      // under-predicted (actual > predicted) — interpreted as
      // "good news" for an optimistic bot since reality exceeded
      // its expectation. Negative PE means over-predicted. Bounded
      // [-1, 1] by the `max(actual, predicted)` denominator —
      // `signedCreditGain` re-clamps defensively. NaN/Infinity in
      // `classLogits` (mid-divergence, before the rollback gate
      // fires below) falls through to predClassIdx=0 because NaN
      // comparisons return false and we initialised predTopProb to
      // -Infinity — the resulting `peSigned` is finite and the
      // training step still produces a controlled gradient. The
      // explicit Number.isFinite check after the loop makes that
      // invariant local rather than implicit-by-init.
      let predClassIdx = 0;
      let predTopProb = -Infinity;
      for (let i = 0; i < classLogits.length; i++) {
        const v = classLogits[i];
        if (Number.isFinite(v) && v > predTopProb) {
          predTopProb = v;
          predClassIdx = i;
        }
      }
      const predictedCentsForSample = this.priceCatalog.prices[predClassIdx];
      const peDenom = Math.max(sample.actualCents, predictedCentsForSample);
      const peSigned = peDenom > 0
        ? (sample.actualCents - predictedCentsForSample) / peDenom
        : 0;
      // Eldar-Niv mood-congruent credit gain. Composed multiplica-
      // tively with `arousalGain` so both GANE (memory consolidation)
      // and Eldar-Niv (mood-as-momentum) operate. Bound:
      //   total ∈ [arousalGain · 0.79, arousalGain · 1.21]
      //         ⊆ [0.79, 1.27 · 1.21] ≈ [0.79, 1.54] at full influence.
      const credGain = moodActiveForSample
        ? signedCreditGain(sample.mood!.vibe, peSigned, moodInfluenceLocal)
        : 1;
      const w = isWeights[s] * arousalGain * credGain;
      // Phase 2 train-time action mask. When the sample carried a
      // visible bound at predict time (slider min/max, riser cap),
      // restrict CE to the in-range catalog classes. Without this the
      // trainer pushes mass toward out-of-range classes that the
      // decoder's argmax mask refuses, creating calibration drift.
      const ord = ordinalSmoothedCE(
        classLogits,
        targetClassIdx,
        this.priceCatalog.logPrices,
        ORDINAL_CE_TAU,
        sample.priceRangeCents
          ? {
              catalogPrices: this.priceCatalog.prices,
              priceRangeCents: sample.priceRangeCents,
            }
          : undefined,
      );
      sampleLosses[s] = ord.loss;

      // Phase 3b K&G multipliers — pre-computed above and stable
      // for the whole step.
      const priceClassMul = kgMul[TASK_INDEX.priceClass];

      // Backward: priceClassHead → (FiLM if active) → trunk[1] →
      // ReLU mask → trunk[0]. The head's input is `headInput`
      // (whatever forward used), not `ta.embedding`, otherwise dW
      // would be computed against the wrong activations.
      const dClassLogits = scaleClone(ord.grad, w * priceClassMul);
      const bwHead = backwardLinear(this.network.priceClassHead, headInput, dClassLogits);
      addInto(grads[GRAD_IDX.priceClassW], bwHead.dW);
      addInto(grads[GRAD_IDX.priceClassb], bwHead.db);

      // Per-task accumulator for priceClass.
      perTaskLossSum[TASK_INDEX.priceClass] += ord.loss;
      perTaskCount[TASK_INDEX.priceClass] += 1;

      // Phase 3b auxiliary: logPrice Gaussian-NLL on log(actualCents).
      // Fixed K&G weight 0.1 (auxiliary). Backward feeds dEmbedding
      // back into the trunk via the head's Linear backward. The
      // logPrice head reads the *bare* trunk embedding (no FiLM) —
      // FiLM is reserved for the priceClass decision path. This
      // matches predict-time behaviour.
      const logActual = Math.log(Math.max(1, sample.actualCents));
      const lp = forwardLogPrice(this.network.logPriceHead, ta.embedding);
      const nll = betaNLL(lp.mu, lp.logVar, logActual, 0); // beta=0 ⇒ plain Gaussian NLL
      const logPriceMul = kgMul[TASK_INDEX.logPrice];
      // Suppress saturated-clamp gradients on both μ and log σ² so a
      // runaway weight that drives the head into clamp territory
      // doesn't keep accumulating gradient through a hard ceiling.
      const dMu = lp.muClamped ? 0 : nll.gradMu * w * logPriceMul;
      const dLogVar = lp.logVarClamped ? 0 : nll.gradLogSigma2 * w * logPriceMul;
      const bwLogPrice = backwardLogPrice(this.network.logPriceHead, ta.embedding, dMu, dLogVar);
      addInto(grads[GRAD_IDX.logPriceW], bwLogPrice.dW);
      addInto(grads[GRAD_IDX.logPriceb], bwLogPrice.db);
      perTaskLossSum[TASK_INDEX.logPrice] += nll.loss;
      perTaskCount[TASK_INDEX.logPrice] += 1;
      // Add the embedding-side gradient onto a side accumulator for
      // the trunk backward path below — handled jointly with
      // priceClass + (when applicable) squashedReg.
      const dEmbAux = new Float32Array(EMBEDDING_DIM);
      addInto(dEmbAux, bwLogPrice.dEmb);

      // Phase 3b auxiliary: squashedReg Huber on the cents-scale
      // residual, when the sample carried a priceRange and is in
      // the modes that route through this head. Trains the new
      // primary head used by predict() for classic/closest/riser.
      if (
        sample.priceRangeCents
        && (sample.mode === "classic"
          || sample.mode === "closest-without-going-over"
          || sample.mode === "riser")
      ) {
        const sr = forwardSquashedReg(
          this.network.squashedRegressionHead,
          ta.embedding,
          sample.priceRangeCents,
        );
        // Huber on (predicted - actual) / 100 (dollars-scale so
        // gradient magnitude is sane regardless of cents).
        const hub = smoothL1(sr.predictedCents / 100, sample.actualCents / 100, 1);
        // dL/dpredictedCents = grad · (1/100)
        const sqRegMul = kgMul[TASK_INDEX.squashedReg];
        const dPred = (hub.grad / 100) * w * sqRegMul;
        const bwSr = backwardSquashedReg(
          this.network.squashedRegressionHead,
          ta.embedding,
          sr.raw,
          dPred,
          sample.priceRangeCents,
        );
        addInto(grads[GRAD_IDX.squashedRegW], bwSr.dW);
        addInto(grads[GRAD_IDX.squashedRegb], bwSr.db);
        addInto(dEmbAux, bwSr.dEmb);
        perTaskLossSum[TASK_INDEX.squashedReg] += hub.loss;
        perTaskCount[TASK_INDEX.squashedReg] += 1;
      }

      // Phase 3d.2: pinballQ40 head training. Active only on bidding
      // samples whose `targetLogResidual` is finite. Trains the head
      // to predict the q40 of `log(actualCents/heuristic)` so the
      // bidding decoder's safety floor is calibrated.
      if (
        sample.mode === "bidding"
        && Number.isFinite(sample.targetLogResidual)
      ) {
        const q40 = forwardPinballQ40(this.network.pinballQ40Head, ta.embedding);
        const pin = pinballLoss(q40, sample.targetLogResidual, 0.4);
        const pinMul = kgMul[TASK_INDEX.pinballQ40];
        const dQ40 = pin.grad * w * pinMul;
        const bwQ = backwardPinballQ40(this.network.pinballQ40Head, ta.embedding, dQ40);
        addInto(grads[GRAD_IDX.pinballQ40W], bwQ.dW);
        addInto(grads[GRAD_IDX.pinballQ40b], bwQ.db);
        addInto(dEmbAux, bwQ.dEmb);
        perTaskLossSum[TASK_INDEX.pinballQ40] += pin.loss;
        perTaskCount[TASK_INDEX.pinballQ40] += 1;
      }

      let dEmbedding: Float32Array;
      if (filmFwd !== null && condForFilm !== undefined) {
        // backwardFilm now consumes γ and β directly (no `rawOutput`)
        // — it derives `tanh(raw)` from the inverse mapping
        // `(γ-1)/(0.1·s)` and `β/(0.1·s)`, saving 32 `Math.tanh` calls
        // per backward. Caller-owned `filmScratch` aliases the same
        // arrays, so γ/β here are the buffers `forwardFilm` just
        // wrote into — read-only until the next forward overwrites them.
        const bwFilm = backwardFilm(
          this.network.filmGen,
          condForFilm,
          ta.embedding,
          filmFwd.gamma,
          filmFwd.beta,
          bwHead.dx,
          moodInfluenceLocal,
        );
        addInto(grads[GRAD_IDX.filmGenW], bwFilm.dW);
        addInto(grads[GRAD_IDX.filmGenb], bwFilm.db);
        dEmbedding = bwFilm.dEmbedding;
      } else {
        dEmbedding = bwHead.dx;
      }
      // Phase 3b: auxiliary heads (logPrice, squashedReg) read the
      // BARE trunk embedding (FiLM is priceClass-only), so their
      // dEmb contributions add directly to dEmbedding.
      addInto(dEmbedding, dEmbAux);

      const bwTrunkB = backwardLinear(this.network.trunk[1], ta.hidden, dEmbedding);
      addInto(grads[GRAD_IDX.trunk1W], bwTrunkB.dW);
      addInto(grads[GRAD_IDX.trunk1b], bwTrunkB.db);

      const mask = reluMask(ta.hiddenLinear);
      const dHiddenLinear = applyReluMaskInPlace(bwTrunkB.dx, mask);

      const bwTrunkA = backwardLinear(this.network.trunk[0], xNorm, dHiddenLinear);
      addInto(grads[GRAD_IDX.trunk0W], bwTrunkA.dW);
      addInto(grads[GRAD_IDX.trunk0b], bwTrunkA.db);
    }

    // Mean per-sample priceClass loss for back-compat reporting +
    // teaching-moment thresholds (sampleLosses[] tracks the
    // priceClass loss specifically, since that's what drives PER
    // priorities — the auxiliary heads' losses live in `perTaskLossSum`).
    let totalLoss = 0;
    for (let s = 0; s < samples.length; s++) totalLoss += sampleLosses[s];
    totalLoss /= Math.max(1, samples.length);

    // Phase 3b: K&G σ² update is intentionally NOT performed per
    // minibatch step here. With `stepsPerRound > 1`, calling
    // `applyGradient` and `noteRoundObserved` per-step would inflate
    // the per-task observation counter and σ² evolution by the
    // step multiplier (typically 6×) — breaking the
    // {@link MIN_TASK_OBSERVATIONS} gate semantics. The caller
    // (`update()`) drives K&G state forward exactly once per round
    // via the per-task losses returned to it.

    // Phase 3c: fold the round-coherent step's gradients + per-task
    // losses into this step's accumulators before clipping. Caller
    // (`update()`) only passes `extras` on the FINAL inner step so
    // round-coherent training fires once per round (matches the
    // multiplicity of just-revealed samples; running it on every
    // inner step would over-weight the round's own samples).
    if (extras) {
      for (let i = 0; i < grads.length; i++) {
        addInto(grads[i], extras.grads[i]);
      }
      for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
        perTaskLossSum[t] += extras.perTaskLossSum[t];
        perTaskCount[t] += extras.perTaskCount[t];
      }
    }

    // Phase 3e.3: BEFORE AGC, capture the raw aggregate gradient L2
    // norm. This is the signal the divergence-rollback gate (1e5
    // threshold) must see — without it, AGC absorbs catastrophic
    // grad explosions at the buffer level and the gate becomes
    // dead code (B1 from #343 review). Also preserves
    // `gradNormP95`'s pre-3e.3 semantics (raw pre-clip aggregate
    // magnitude) for operator dashboards (S3).
    let preAgcSumSq = 0;
    for (const g of grads) {
      for (let i = 0; i < g.length; i++) preAgcSumSq += g[i] * g[i];
    }
    const preAgcNorm = Math.sqrt(preAgcSumSq);
    this.gradNormRing.push(preAgcNorm);

    // Phase 3e.3: per-buffer adaptive gradient clipping (AGC) runs
    // before the global L2 clip. Each W buffer's gradient is
    // independently clipped by `lambda * ||W|| / ||g||` — healthy
    // buffers pass through while only buffers with disproportionate
    // gradient magnitude get throttled. Biases are exempt (B2 fix
    // from #343 review; Brock 2021 §3.2: "we found AGC unnecessary,
    // and indeed often harmful, on ... the affine parameters [bias
    // terms] of any layers"). The skip-indices set is built from
    // the iterator structure — every odd index in iterParamBuffers
    // is a bias. `agcLambda <= 0` disables AGC entirely.
    let agcResult: { numClipped: number; minScale: number } = { numClipped: 0, minScale: 1 };
    if (this.opts.agcLambda > 0) {
      agcResult = adaptiveClipGradientsInPlace(
        paramBufs,
        grads,
        this.opts.agcLambda,
        undefined,
        undefined,
        this.agcSkipIndices,
      );
    }
    this.agcClipsRing.push(agcResult.numClipped);
    this.agcMinScaleRing.push(agcResult.minScale);

    // Global gradient clipping AFTER AGC — final safety net for
    // catastrophic divergence within a single buffer that AGC
    // somehow let through (e.g. lambda misconfigured). The norm
    // returned here is POST-AGC; gradNormPostClipRing reflects
    // "what Adam actually stepped with."
    const postAgcAndGlobalNorm = clipGradientsInPlace(grads, MAX_GRAD_NORM);
    this.gradNormPostClipRing.push(Math.min(postAgcAndGlobalNorm, MAX_GRAD_NORM));

    // Adam step.
    this.optimizer.beginStep();
    for (let i = 0; i < paramBufs.length; i++) {
      this.optimizer.stepBuffer(i, paramBufs[i], grads[i]);
    }

    // Per-sample priority for the prioritized-replay buffer = the
    // ordinal-CE loss itself. Bigger losses get re-sampled more often.
    const priorities = new Float32Array(samples.length);
    for (let s = 0; s < samples.length; s++) priorities[s] = sampleLosses[s];

    // Teaching-moment trigger evaluation — uses the per-sample loss.
    // The prev-loss map is LRU-bounded at 2× replay capacity so a flood
    // of unique product ids can't grow it without bound.
    const prevLossCap = this.opts.replayCapacity * 2;
    let teachingTriggered = false;
    const p90 = percentile(sampleLosses, 0.9);
    for (let s = 0; s < samples.length; s++) {
      const sample = samples[s];
      const prevLoss = this.prevRoundLossByProduct.get(sample.productId) ?? 0;
      const wasHigh = prevLoss > p90 * 0.8;
      if (
        this.teaching.observe(sample, sampleLosses[s], p90, wasHigh, this.round)
      ) {
        teachingTriggered = true;
      }
      // Re-insert refreshes the key's position to most-recently-used.
      if (this.prevRoundLossByProduct.has(sample.productId)) {
        this.prevRoundLossByProduct.delete(sample.productId);
      }
      this.prevRoundLossByProduct.set(sample.productId, sampleLosses[s]);
      // Evict the oldest entry when over the cap. Map preserves
      // insertion order, so the first key is the LRU.
      if (this.prevRoundLossByProduct.size > prevLossCap) {
        const oldest = this.prevRoundLossByProduct.keys().next().value;
        if (oldest !== undefined) this.prevRoundLossByProduct.delete(oldest);
      }
    }

    // Phase 3b: per-task minibatch averages.
    //
    // The mean is `lossSum / count` per task, but the *unit* of
    // count differs by task — picked to keep K&G's σ² estimate on
    // a comparable scale across tasks once per-slot σ² unfreezes.
    // What gets written into `nn_round_log.per_task_losses`:
    //
    //   priceClass    — mean per-sample CE loss   (count == samples seen)
    //   logPrice      — mean per-sample NLL loss  (count == samples seen)
    //   squashedReg   — mean per-bounded-sample Huber loss
    //   pairLogit     — mean per-pair BCE         (count == 1 per round)
    //   pinballQ40    — mean per-bidding-sample pinball-q40 loss
    //                   (count == # bidding samples this round)
    //
    // Slots that didn't fire this minibatch have count==0 and
    // value==0; the K&G `combine` mask skips them so they don't
    // distort σ². See `uncertaintyWeighting.ts:combine`.
    const perTaskLosses = new Float32Array(NUM_ACTIVE_TASKS);
    for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
      perTaskLosses[t] = perTaskCount[t] > 0 ? perTaskLossSum[t] / perTaskCount[t] : 0;
    }

    return { totalLoss, priorities, teachingTriggered, gradNormPreClip: preAgcNorm, perTaskLosses };
  }

  /**
   * Phase 3c: build the round-coherent gradient + per-task-loss
   * extras to fold into the final inner step's accumulators.
   *
   * Dispatches by the just-revealed samples' mode to one of three
   * head-specific helpers:
   *   - `comparison` / `higher-lower` with exactly 2 samples
   *      → {@link computeRoundCoherentPairLogit}
   *   - `price-match`   → {@link computeRoundCoherentPriceMatch}
   *   - `budget-builder` → {@link computeRoundCoherentBudgetSelect}
   * Other modes return all-zero extras (the per-sample step covers
   * them already).
   *
   * The dispatch reads the per-sample `mode` rather than
   * `req.primaryMode` — they normally agree, but in mixed-mode plans
   * the runner can re-tag the round and the per-sample label is the
   * authoritative one (this is how the per-sample step routes
   * squashedReg too).
   *
   * Returns extras matching `iterParamBuffers` order; all-zero on a
   * non-dispatching mode so the caller can fold unconditionally.
   */
  private computeRoundCoherentExtras(
    newSamples: Sample[],
    req: UpdateReq,
    kgMul: Float32Array,
  ): RoundCoherentExtras | undefined {
    if (newSamples.length === 0) return undefined;
    const sampleMode = newSamples[0].mode;
    const dispatches =
      (sampleMode === "comparison" || sampleMode === "higher-lower")
      && newSamples.length === 2;
    if (!dispatches) return undefined;
    // Allocate accumulators only when a head dispatch will fire.
    // Single-product / non-3c modes (the majority of rounds) skip
    // the allocation + fold-in entirely.
    const paramBufs = Array.from(iterParamBuffers(this.network));
    const extras: RoundCoherentExtras = {
      grads: paramBufs.map((b) => new Float32Array(b.length)),
      perTaskLossSum: new Float32Array(NUM_ACTIVE_TASKS),
      perTaskCount: new Int32Array(NUM_ACTIVE_TASKS),
    };
    this.computeRoundCoherentPairLogit(newSamples, kgMul, extras);
    return extras;
  }

  /**
   * Phase 3c pairLogit head training (binary comparison rounds).
   *
   * Two trunk forwards (one per product), one pairLogit forward on
   * the concatenated bare embeddings, sigmoid-BCE against the
   * "actualCents[A] > actualCents[B]" target, then backward through
   * the head + each trunk forward. Bare embeddings (no FiLM) match
   * the predict-time path in {@link predictPairAIsCorrectProb}.
   *
   * Mutates `extras.grads`, `extras.perTaskLossSum`,
   * `extras.perTaskCount`. Caller passes the same K&G multipliers
   * the per-sample step computed for the round so the chain-rule
   * scaling is consistent.
   */
  private computeRoundCoherentPairLogit(
    newSamples: Sample[],
    kgMul: Float32Array,
    extras: RoundCoherentExtras,
  ): void {
    const a = newSamples[0];
    const b = newSamples[1];
    if (
      !Number.isFinite(a.actualCents)
      || a.actualCents <= 0
      || !Number.isFinite(b.actualCents)
      || b.actualCents <= 0
    ) {
      return;
    }
    const xA = this.normalizer.normalize(a.features);
    const xB = this.normalizer.normalize(b.features);
    const tA = forwardTrunk(this.network, xA);
    const tB = forwardTrunk(this.network, xB);
    // Phase 3e.2: stop-gradient scalar features from per-product
    // priceClass argmax. Bare-embedding path mirrors the predict-side
    // helper in `predictPairAIsCorrectProb` so train and predict
    // produce coherent pair-head inputs.
    const cA = this.predictFromPriceClassHead(tA.embedding);
    const cB = this.predictFromPriceClassHead(tB.embedding);
    const scalars = pairLogitScalarFeatures(cA.predictedCents, cB.predictedCents);
    const fwd = forwardPairLogit(
      this.network.pairLogitHead,
      tA.embedding,
      tB.embedding,
      scalars,
    );
    if (!Number.isFinite(fwd.logit)) return;
    const target: 0 | 1 = a.actualCents > b.actualCents ? 1 : 0;
    const { loss, grad: gradLogit } = sigmoidBCE(fwd.logit, target);
    const mul = kgMul[TASK_INDEX.pairLogit];
    const bw = backwardPairLogit(this.network.pairLogitHead, fwd.concat, gradLogit * mul);
    addInto(extras.grads[GRAD_IDX.pairLogitW], bw.dW);
    addInto(extras.grads[GRAD_IDX.pairLogitb], bw.db);
    this.backwardTrunkInto(xA, tA, bw.dEmbA, extras.grads);
    this.backwardTrunkInto(xB, tB, bw.dEmbB, extras.grads);
    extras.perTaskLossSum[TASK_INDEX.pairLogit] += loss;
    extras.perTaskCount[TASK_INDEX.pairLogit] += 1;
  }

  /**
   * Phase 3c trunk-backward helper. Accumulates trunk0 / trunk1
   * weight + bias gradients into the round-coherent extras given
   * the trunk's forward intermediates and the per-sample dEmb. Used
   * by the round-coherent helpers which run the trunk N times per
   * round.
   *
   * The trunk has shape `(featureDim → trunkHiddenDim → embeddingDim)`
   * with a ReLU between the two linear layers. Backward chain:
   *   dHiddenLinear = ReLU'(hiddenLinear) ⊙ trunk1.backward(dEmb)
   *   trunk0 receives `dHiddenLinear` against the normalised input.
   */
  private backwardTrunkInto(
    xNorm: Float32Array,
    ta: { hidden: Float32Array; hiddenLinear: Float32Array; embedding: Float32Array },
    dEmb: Float32Array,
    grads: Float32Array[],
  ): void {
    const bwTrunkB = backwardLinear(this.network.trunk[1], ta.hidden, dEmb);
    addInto(grads[GRAD_IDX.trunk1W], bwTrunkB.dW);
    addInto(grads[GRAD_IDX.trunk1b], bwTrunkB.db);
    const mask = reluMask(ta.hiddenLinear);
    const dHiddenLinear = applyReluMaskInPlace(bwTrunkB.dx, mask);
    const bwTrunkA = backwardLinear(this.network.trunk[0], xNorm, dHiddenLinear);
    addInto(grads[GRAD_IDX.trunk0W], bwTrunkA.dW);
    addInto(grads[GRAD_IDX.trunk0b], bwTrunkA.db);
  }

  /**
   * Capture every mutable training structure for NaN rollback. Skipping
   * any of these would let an adversarial sample-flood permanently drift
   * the auxiliary state on each rollback cycle. See {@link InMemorySnapshot}
   * for the full capture / non-capture rationale.
   */
  private captureRollbackSnapshot(): void {
    this.lastGoodSnapshot = {
      params: flattenParams(this.network),
      optimizerState: this.optimizer.serialize(),
      normalizer: this.normalizer.serialize(),
      ood: this.ood.serialize(),
      teaching: this.teaching.serialize(),
      replay: this.replay.serialize(),
      prevRoundLossByProduct: Array.from(this.prevRoundLossByProduct.entries()),
    };
  }

  /** Restore every captured structure from the snapshot. */
  private restoreRollbackSnapshot(): void {
    if (!this.lastGoodSnapshot) return;
    loadFlatParams(this.network, this.lastGoodSnapshot.params);
    try {
      this.optimizer = AdamW.deserialize(this.lastGoodSnapshot.optimizerState, this.opts.adamw);
    } catch {
      this.optimizer = new AdamW(this.opts.adamw);
      this.optimizer.bind(Array.from(iterParamBuffers(this.network)).map((b) => b.length));
    }
    try {
      this.normalizer = Normalizer.deserialize(this.lastGoodSnapshot.normalizer, this.normalizer.opts);
    } catch {
      /* keep current normalizer rather than reset stats wholesale */
    }
    try {
      this.ood = OODBlender.deserialize(this.lastGoodSnapshot.ood);
    } catch {
      /* keep current */
    }
    try {
      this.teaching = TeachingMoments.deserialize(this.lastGoodSnapshot.teaching, this.teaching.opts);
    } catch {
      /* keep current */
    }
    try {
      this.replay = StratifiedReplay.deserialize(this.lastGoodSnapshot.replay, this.replay.opts);
    } catch {
      /* keep current */
    }
    this.prevRoundLossByProduct = new Map(this.lastGoodSnapshot.prevRoundLossByProduct);
  }

  /**
   * Persist current state synchronously. Caller decides idle-window
   * timing. Skipped silently when disk pressure is ≥
   * `DISK_PRESSURE_SNAPSHOT` so a near-full volume can't be wedged
   * worse by snapshot writes; the write-latency p95 is recorded for
   * /healthz observability.
   */
  snapshotNow(): void {
    if (!this.persistence) return;
    if (this.lastDiskUsedRatio >= DISK_PRESSURE_SNAPSHOT) {
      // Disk too full — skip the write; lastSnapshotRound stays put
      // so the snapshot-age alarm correctly trips on /healthz.
      return;
    }
    // Golden-MAE regression gate. Prevents persisting weights that
    // would degrade the bot — the load-bearing recovery property is
    // "after a divergence, restarting the worker reloads a working
    // model". Without this gate, the round-530 NaN-storm divergence
    // wrote 14 hours of corrupt weights to disk that survived every
    // restart. Skipped when the golden set is empty (no signal) or on
    // the very first snapshot (no baseline). recomputeGoldenMAE()
    // calls predict() per entry, which mutates lastPredictAt — that
    // value drives the snapshot scheduler's 2 s idle-window heuristic,
    // so stash/restore around the call.
    const savedLastPredictAt = this.lastPredictAt;
    const currentMAE = this.recomputeGoldenMAE();
    this.lastPredictAt = savedLastPredictAt;
    // Phase 3e.0: gate baseline is the median of the last
    // SNAPSHOT_MAE_BASELINE_WINDOW accepted MAEs, not the single
    // most-recent one. Floors at 1 cent so a degenerate golden seed
    // scoring MAE=0 doesn't soft-lock the gate (anything > 0 × 1.2 = 0
    // would trip).
    const baselineMAE = this.recentAcceptedMAEs.length > 0
      ? median(this.recentAcceptedMAEs)
      : null;
    if (
      currentMAE !== null
      && baselineMAE !== null
      && (
        !Number.isFinite(currentMAE)
        || currentMAE > Math.max(baselineMAE, 1) * SNAPSHOT_MAE_REGRESSION_FACTOR
      )
    ) {
      this.goldenRegressionRollbacks += 1;
      // Clear pendingSnapshot + push back the next allowed retry by one
      // snapshotInterval, so the scheduler doesn't busy-loop the
      // (expensive) golden eval every round while the model is stuck.
      // lastSnapshotRound stays put so the snapshot-age alarm continues
      // to trip.
      this.pendingSnapshot = false;
      this.nextSnapshotRetryRound = this.round + this.opts.snapshotInterval;
      return;
    }
    const t0 = Date.now();
    this.persistence.saveSnapshot({
      round: this.round,
      weights: Buffer.from(flattenParams(this.network).buffer),
      optimizerState: this.optimizer.serialize(),
      featureNorm: this.normalizer.serialize(),
      replayBuffer: this.replay.serialize(),
      teachingMoments: this.teaching.serialize(),
      oodBlender: this.ood.serialize(),
      // Phase 3b: K&G state. Pre-3b PR #4 wrote an empty buffer here;
      // deserialize falls through to a fresh instance on any
      // unparseable payload, so back-compat is preserved.
      uncertaintyWeights: this.uncertainty.serialize(),
    });
    this.dbWriteLatencyRing.push(Date.now() - t0);
    this.persistence.pruneSnapshots(3);
    // Prune round-log rows older than 14 days — matches the NDJSON
    // rotation window. Without this the table grows unbounded across
    // months of 24/7 operation.
    try {
      this.persistence.pruneRoundLog(14);
    } catch {
      /* prune failure is non-fatal; retry next snapshot */
    }
    try {
      this.persistence.walCheckpointTruncate();
    } catch {
      /* checkpoint failure is non-fatal; will retry next snapshot */
    }
    this.lastSnapshotRound = this.round;
    this.lastSnapshotAt = Date.now();
    this.pendingSnapshot = false;
    // Anchor the regression-gate baseline on the just-persisted weights.
    // currentMAE is null when the golden set is empty — leave the
    // baseline null so the gate stays a no-op for empty configs.
    if (currentMAE !== null && Number.isFinite(currentMAE)) {
      this.acceptedSnapshotMAE = currentMAE;
      this.acceptedSnapshotRound = this.round;
      this.recentAcceptedMAEs.push(currentMAE);
      if (this.recentAcceptedMAEs.length > SNAPSHOT_MAE_BASELINE_WINDOW) {
        this.recentAcceptedMAEs.shift();
      }
    }
  }

  /** MAE recorded at the last successfully-persisted snapshot, or null. */
  lastAcceptedSnapshotMAE(): number | null {
    return this.acceptedSnapshotMAE;
  }

  /** Round counter at the last successfully-persisted snapshot. */
  lastAcceptedSnapshotRound(): number {
    return this.acceptedSnapshotRound;
  }

  /**
   * Probe disk usage and update internal state. Polls
   * `NdjsonLogger.diskUsedRatio` so the worker doesn't shell out
   * unnecessarily — at ≥80% we set the NDJSON logger blocked +
   * surface `degraded:'disk'`; at ≥90% snapshots also stop. The
   * NDJSON logger is silently un-blocked when pressure drops back.
   */
  async checkDiskPressure(): Promise<void> {
    try {
      const ratio = await NdjsonLogger.diskUsedRatio(this.opts.dataDir);
      this.lastDiskUsedRatio = ratio;
      if (this.ndjson) {
        this.ndjson.setBlocked(ratio >= DISK_PRESSURE_NDJSON);
      }
    } catch {
      /* disk probe failure is non-fatal; leave state unchanged */
    }
  }

  /**
   * Build the heartbeat health block. Caller can pass an external
   * degraded reason (e.g. the bridge supplies `worker_dead` when the
   * heartbeat timer hasn't ticked) which overrides the worker's own
   * resolution. Otherwise the worker chooses based on its internal
   * state: `nan_storm` while frozen, `disk` while pressure ≥ NDJSON
   * threshold, false otherwise.
   */
  health(degraded?: LearningHealthBlock["degraded"]): LearningHealthBlock {
    const resolvedDegraded: LearningHealthBlock["degraded"] = degraded !== undefined
      ? degraded
      : this.frozen
        ? "nan_storm"
        : this.lastDiskUsedRatio >= DISK_PRESSURE_NDJSON
          ? "disk"
          : false;
    return {
      enabled: true,
      mode: "active",
      lastSnapshotRound: this.lastSnapshotRound,
      nanRollbacks: this.nanRollbacks,
      // JSON.stringify(Infinity) === "null", which would silently lose
      // the "model is broken" signal — `goldenRegressionRollbacks` is
      // the canonical broken-model signal, but we still keep the
      // numeric MAE finite for human consumption.
      goldenMAE: this.goldenMAE !== null && Number.isFinite(this.goldenMAE)
        ? this.goldenMAE
        : null,
      staleResponses: this.staleResponses,
      workerHeartbeatMs: Date.now() - this.workerStartedAt,
      bufferSize: this.replay.size(),
      teachingMomentsCount: this.teaching.size(),
      modelVersion: `${SCHEMA_VERSION_HEADER}@${this.archHash.slice(0, 8)}`,
      degraded: resolvedDegraded,
      gradNormP95: this.gradNormRing.p95(),
      gradNormPostClipP95: this.gradNormPostClipRing.p95(),
      snapshotAgeMs: this.snapshotAgeMs(),
      dbWriteLatencyP95Ms: this.dbWriteLatencyP95Ms(),
      diskUsedRatio: this.lastDiskUsedRatio,
      frozen: this.frozen,
      goldenRegressionRollbacks: this.goldenRegressionRollbacks,
      perTaskObservations: Array.from(this.uncertainty.tasksObserved),
      starvedTasks: this.computeStarvedTasks(),
      agcClipsP95: this.agcClipsRing.p95(),
      agcMinScaleP5: this.agcMinScaleRing.p5(),
    };
  }

  /**
   * Phase 3e.0: head-starvation watchdog. Returns the names of any
   * registered head whose `tasksObserved` is 0 after the warmup
   * grace period (`HEAD_STARVATION_WARMUP_ROUNDS`). Empty during
   * warmup or when every head has fired at least once.
   *
   * The warmup gate matters: in the first ~hundreds of rounds an
   * un-fired head doesn't yet imply a bug — bidding rounds in
   * particular may not have been routed at all. After the grace
   * period a still-zero count is a strong signal of an upstream
   * data-path regression (the precedent: PR #322's pinballQ40 head
   * receiving zero training signal for 2,260 rounds while the worker
   * happily ran).
   */
  private computeStarvedTasks(): string[] {
    if (this.round < HEAD_STARVATION_WARMUP_ROUNDS) return [];
    const starved: string[] = [];
    for (const [name, idx] of Object.entries(TASK_INDEX)) {
      if (this.uncertainty.tasksObserved[idx as number] === 0) {
        starved.push(name);
      }
    }
    return starved;
  }

  /** Snapshot age in ms (since the last successful saveSnapshot). */
  snapshotAgeMs(): number {
    if (this.lastSnapshotAt === 0) return 0;
    return Date.now() - this.lastSnapshotAt;
  }

  /** Rolling p95 of recent saveSnapshot durations (ms). */
  dbWriteLatencyP95Ms(): number {
    return this.dbWriteLatencyRing.p95();
  }

  /** True iff the NN is currently frozen due to NaN-storm. */
  isFrozen(): boolean {
    return this.frozen;
  }

  /** Disk-used ratio (0..1) from the last poll. Read by /healthz alarm wiring. */
  diskUsedRatio(): number {
    return this.lastDiskUsedRatio;
  }

  /**
   * Reset the learning state — archives the current snapshot, zeros
   * every mutable structure, and starts fresh from random init. Used
   * by the operator's `/api/streamer/reset-learning` admin endpoint
   * when the model has wedged itself badly enough that rollback can't
   * recover (e.g. an arch-hash mismatch we no longer want to keep).
   */
  async resetLearning(): Promise<void> {
    if (this.persistence) {
      try {
        this.persistence.archiveAll();
      } catch {
        /* archive failure is non-fatal; we still want to reset in-memory */
      }
    }
    this.network = createNetwork(this.opts.rng);
    this.optimizer = new AdamW(this.opts.adamw);
    this.optimizer.bind(Array.from(iterParamBuffers(this.network)).map((b) => b.length));
    this.agcSkipIndices = buildAgcSkipIndices(this.network);
    this.normalizer = new Normalizer({
      dim: FEATURE_DIM,
      beta: 0.99,
      // Phase 1: 32 → 200. The 124-d feature vector needs many more
      // observations to produce stable running stats; 32 was burning
      // through warmup inside the first round of multi-product modes
      // (5–15 samples per round) and seeding the normalizer with
      // unstable mean/var.
      warmupSamples: 200,
      eps: 1e-8,
    });
    this.replay = new StratifiedReplay({
      recentCapacity: this.opts.replayRecentCapacity,
      perModeCapacity: this.opts.replayCapacity,
      recentSampleFraction: this.opts.replayRecentSampleFraction,
      recentUniformFraction: this.opts.replayRecentUniformFraction,
      alpha: this.opts.perAlpha,
      betaStart: this.opts.perBetaStart,
      betaEnd: this.opts.perBetaEnd,
      betaAnnealRounds: this.opts.perBetaAnnealRounds,
      perModeUniformFraction: this.opts.perUniformFraction,
      maxPerRoundInBatch: this.opts.maxPerRoundInBatch,
    });
    this.teaching = new TeachingMoments({
      capacity: this.opts.teachingCapacity,
      recoveryPct: this.opts.teachingMomentRecoveryPct,
      replayMultiplier: this.opts.teachingMomentReplayMult,
      decayRounds: this.opts.teachingMomentDecayRounds,
    });
    this.ood = new OODBlender();
    this.uncertainty = new UncertaintyWeights();
    this.round = 0;
    this.decayAnchorRound = 0;
    this.lastSnapshotRound = 0;
    this.lastSnapshotAt = 0;
    this.nanRollbacks = 0;
    this.staleResponses = 0;
    this.frozen = false;
    this.nanRollbackEpochs = [];
    this.recentLosses = new NumericRing(50);
    this.recentAccuracy = new Ring<"within10" | "within25" | "miss">(10);
    this.gradNormRing = new NumericRing(128);
    this.gradNormPostClipRing = new NumericRing(128);
    this.agcClipsRing = new NumericRing(128);
    this.agcMinScaleRing = new NumericRing(128);
    this.prevRoundLossByProduct = new Map();
    this.dbWriteLatencyRing = new NumericRing(64);
    this.lastGoodSnapshot = null;
    // Telemetry rings the reviewer flagged as missed in the original
    // resetLearning. The most-active trail drives the visualisation;
    // it should start cold from a fresh model. goldenMAE is recomputed
    // lazily by the snapshot path, but resetting it avoids a misleading
    // "stale MAE for a network that no longer exists" between reset
    // and the next snapshot.
    this.mostActiveTrail = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    this.mostActivePrev = [0, 0, 0];
    this.goldenMAE = null;
    // Regression gate: clearing the baseline so the first post-reset
    // snapshot establishes a fresh anchor instead of being compared
    // against the old (now-irrelevant) one.
    this.acceptedSnapshotMAE = null;
    this.acceptedSnapshotRound = 0;
    this.recentAcceptedMAEs = [];
    this.goldenRegressionRollbacks = 0;
    this.nextSnapshotRetryRound = 0;
  }

  /**
   * Build a Visual tick Buffer (encoded JSON) reflecting the most
   * recent {@link predict} call. Before any predict runs the tick is
   * the zero/idle shape — the broadcast panels render their
   * "Calibrating…" copy in that state.
   */
  buildVisualBuffer(roundId: string): Buffer {
    const last = this.recentLosses.toArray();
    const acc = this.recentAccuracy.toArray();
    const mostActiveByLayer = this.mostActiveTrail.map((t, i) => ({
      idx: this.mostActivePrev[i],
      trail: t,
    }));
    const health = this.buildVisualHealth();

    const lp = this.lastPredict;
    if (!lp) {
      // No prediction has run yet — emit an idle tick so the panels
      // render their pre-data placeholder copy ("Calibrating…", $0,
      // empty dots) consistently.
      const tick = buildTick({
        roundId,
        phase: "result",
        trunkHidden: new Float32Array(TRUNK_HIDDEN_DIM),
        embedding: new Float32Array(EMBEDDING_DIM),
        recentLosses: last,
        recentAccuracy: acc,
        predictionCents: 0,
        predictionSigmaCents: 0,
        vizCoord: [0, 0],
        topFeatures: [],
        teachingMomentTriggered: false,
        mostActiveByLayer,
        weightSamples: [],
        health,
      });
      return encodeTick(tick);
    }

    // Sample weights from the deterministic edge set so the panel
    // draws stable connections whose intensity changes as training
    // progresses. Layer 0→1 uses trunk[0]; layer 1→2 uses trunk[1].
    const weightSamples = this.weightSampleIndices.map((e) => {
      const layer = this.network.trunk[e.fromLayer];
      const w = layer.W[e.toIdx * layer.inDim + e.fromIdx];
      return { ...e, weight: w };
    });

    const tick = buildTick({
      roundId,
      phase: "result",
      trunkHidden: lp.trunkHidden,
      embedding: lp.embedding,
      recentLosses: last,
      recentAccuracy: acc,
      predictionCents: lp.predictedCents,
      predictionSigmaCents: lp.predictedSigmaCents,
      vizCoord: lp.embedding2d,
      topFeatures: lp.topFeatures,
      teachingMomentTriggered: this.lastTeachingTriggered,
      mostActiveByLayer,
      weightSamples,
      priceCandidates: lp.priceCandidates,
      health,
    });
    return encodeTick(tick);
  }

  /**
   * Snapshot of training/health counters embedded on every VisualTick
   * so the Neural Debug HUD can render the "training" column without
   * a separate relay. These mirror the heartbeat fields exposed via
   * /healthz; we duplicate per-tick because the HUD wants per-round
   * resolution rather than the heartbeat's ~500ms cadence.
   */
  private buildVisualHealth(): VisualTick["health"] {
    const losses = this.recentLosses.toArray();
    const lastLoss = losses.length > 0 ? losses[losses.length - 1] : null;
    return {
      round: this.round,
      loss: lastLoss !== null && Number.isFinite(lastLoss) ? lastLoss : null,
      gradNormP95: this.gradNormRing.p95(),
      learningRate: this.optimizer.effectiveLr(this.optimizer.step_count),
      warmupStep: this.optimizer.step_count,
      warmupTotal: this.optimizer.opts.warmupRounds,
      bufferSize: this.replay.size(),
      bufferCapacity: this.replay.capacity(),
      batchSize: this.opts.batchSize,
      stepsPerRound: this.opts.stepsPerRound,
      goldenMAE: this.goldenMAE !== null && Number.isFinite(this.goldenMAE)
        ? this.goldenMAE
        : null,
      snapshotAgeMs: this.snapshotAgeMs(),
      teachingMomentsCount: this.teaching.size(),
      nanRollbacks: this.nanRollbacks,
      frozen: this.frozen,
    };
  }

  /**
   * Compute golden MAE — used by the snapshot regression gate
   * (`SNAPSHOT_MAE_REGRESSION_FACTOR`) and the /healthz block.
   *
   * Mood is deliberately NOT passed into the golden predict path.
   * Golden MAE is a stable trunk + head baseline — "is the
   * underlying model still as good as it was at the last accepted
   * snapshot, regardless of the bot's current emotional arc?" —
   * so feeding mood would let `filmGen.b` drift quietly contaminate
   * the regression measurement (the baseline would shift with
   * mood-conditioned bias). The bare-embedding path keeps the
   * gate orthogonal to mood; live predicts at runtime still flow
   * through FiLM as designed. A mood-conditioned eval suite is a
   * separate concern that belongs alongside the counterfactual
   * test, not in the regression gate.
   *
   * **Limitation (Phase 3e.0):** entries with mode `comparison` are
   * passed to `predict()` with no `pairProducts`, so the pairLogit
   * head is not exercised by the golden eval. Likewise `bidding`
   * entries don't carry the round shape that triggers pinballQ40.
   * The MAE the gate consumes is therefore measuring trunk +
   * priceClass + squashedReg only, and only catches regressions
   * that surface through `predictedCents`. The head-starvation
   * watchdog (`starvedTasks`) is the complementary signal that
   * catches the heads this gate can't see.
   */
  recomputeGoldenMAE(): number | null {
    if (this.goldenEval.entries.length === 0) return null;
    const mae = this.goldenEval.evaluateMAE((entry) => {
      const res = this.predict({
        roundId: "golden",
        mode: entry.mode,
        product: entry.product,
        referencePrice: entry.referencePrice,
        // Intentionally no `mood` field — see method docstring.
      });
      return res.predictedCents;
    });
    this.goldenMAE = mae;
    return mae;
  }

  /**
   * Adaptive ε for the strategy layer — exposed via predict.
   *
   * Post-PR-4 `sigmaPred` is the classifier's normalised softmax
   * entropy in [0, 1] (see `classifierEntropyNormalised` in predict()).
   * The pre-PR-4 sigma was log-residual units from the regression
   * head, fed alongside `OODBlender.medianCalibratedSigma()` which
   * returns log-residual units too — that pairing was unit-coherent.
   * Now that sigmaPred is a normalised entropy, we pair it with the
   * fixed midpoint 0.5 instead of the OOD median (which is in stale
   * units post-cleanup): sigDiff = uncertainty − typical → positive
   * when the classifier is more spread than half-saturated, negative
   * when more peaked. Picked to match the original semantic without
   * re-tuning epsilon's sigmoid offset.
   */
  adaptiveEpsilon(sigmaPred: number, categoryEntropy: number, mode?: string): number {
    return adaptiveEpsilon({
      sigmaPred,
      sigmaCalibratedMedian: 0.5,
      categoryEntropy,
      // `round - decayAnchorRound` so archHash resets restart the
      // exploration-decay schedule from full-floor — see comment on
      // `decayAnchorRound` field for rationale.
      round: Math.max(0, this.round - this.decayAnchorRound),
      epsilonFloorStart: this.opts.epsilonFloorStart,
      epsilonFloorEnd: this.opts.epsilonFloorEnd,
      epsilonDecayRounds: this.opts.epsilonDecayRounds,
      modeMultiplier: mode ? MODE_EPSILON_MULTIPLIER[mode] ?? 1.0 : 1.0,
    });
  }

  /** Cleanup on shutdown. */
  async shutdown(): Promise<void> {
    try {
      this.snapshotNow();
    } catch {
      /* best-effort */
    }
    await this.ndjson?.stop();
    this.persistence?.close();
  }

  // ---- internal helpers ----
  private updateMostActive(input: Float32Array, hidden: Float32Array, embedding: Float32Array): void {
    const layers = [input, hidden, embedding];
    for (let l = 0; l < 3; l++) {
      let max = -Infinity;
      let idx = 0;
      const layer = layers[l];
      for (let i = 0; i < layer.length; i++) {
        if (layer[i] > max) {
          max = layer[i];
          idx = i;
        }
      }
      this.mostActiveTrail[l] = [this.mostActivePrev[l], this.mostActiveTrail[l][0]];
      this.mostActivePrev[l] = idx;
    }
  }

}

/**
 * Shannon entropy of `probs`, normalised to [0, 1] by dividing by
 * log(K). Used as the "model-uncertainty" proxy fed into
 * adaptiveEpsilon — a uniform softmax (the cold-start state) returns
 * 1.0; a one-hot collapse returns 0. Returns 0 if probs is empty,
 * non-finite, or all-zero.
 */
export function classifierEntropyNormalised(probs: Float32Array): number {
  if (probs.length === 0) return 0;
  let h = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!Number.isFinite(p) || p <= 0) continue;
    h -= p * Math.log(p);
  }
  const denom = Math.log(probs.length);
  if (denom <= 0) return 0;
  const norm = h / denom;
  if (!Number.isFinite(norm)) return 0;
  return Math.max(0, Math.min(1, norm));
}

/**
 * Pick the top-K (cents, prob) pairs from a softmax over the price
 * catalog, sorted by probability descending. Returns at most `k`
 * entries; fewer if the catalog is smaller. Returns an empty array
 * when the probs are non-finite (broken-network state).
 */
export function topKCatalogCandidates(
  probs: Float32Array,
  catalog: PriceCatalog,
  k: number,
): Array<{ cents: number; prob: number }> {
  if (probs.length === 0) return [];
  const indexed: Array<{ idx: number; prob: number }> = [];
  for (let i = 0; i < probs.length; i++) {
    if (!Number.isFinite(probs[i])) return [];
    indexed.push({ idx: i, prob: probs[i] });
  }
  indexed.sort((a, b) => b.prob - a.prob);
  const out: Array<{ cents: number; prob: number }> = [];
  for (let i = 0; i < Math.min(k, indexed.length); i++) {
    out.push({ cents: catalog.prices[indexed[i].idx], prob: indexed[i].prob });
  }
  return out;
}

function addInto(dst: Float32Array, src: Float32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i];
}

function scaleClone(src: Float32Array, w: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] * w;
  return out;
}

function percentile(buf: Float32Array, q: number): number {
  if (buf.length === 0) return 0;
  const arr = Array.from(buf).sort((a, b) => a - b);
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
}
