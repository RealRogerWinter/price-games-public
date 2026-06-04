/**
 * Streamer-bot learning system — frozen types.
 *
 * The shapes here are the contract between the main thread (LearningBridge)
 * and the worker thread (worker.ts). Changing any of them in a way that
 * touches the on-disk SQLite schema MUST also bump SCHEMA_VERSION in
 * `persistence.ts` so old snapshots are archived rather than crashed on.
 *
 * The ModelSpec is the source of truth for layer dimensions. Every part
 * of the system that allocates Float32Arrays — initialisers, optimizer
 * state, replay buffer features — derives its size from this spec. The
 * archHash (see archHash.ts) is the canonical fingerprint: if it changes,
 * weights from disk are no longer compatible and get archived.
 *
 * Design rule: do not import this file from anywhere outside `learning/`
 * (including tests outside `tests/learning/`). Keeps the blast radius of
 * a spec change limited to the learning subsystem.
 */

import type { GameMode } from "@price-game/shared";

/** Number of game modes the bot plays. Used to size the per-mode bias. */
export const NUM_GAME_MODES = 12;

/** Stable, ordered list of the 12 game modes — drives one-hot indexing. */
export const GAME_MODE_ORDER: readonly GameMode[] = [
  "classic",
  "higher-lower",
  "comparison",
  "closest-without-going-over",
  "price-match",
  "riser",
  "odd-one-out",
  "market-basket",
  "sort-it-out",
  "budget-builder",
  "chain-reaction",
  "bidding",
] as const;

/** Number of category buckets the head predicts over. */
export const CATEGORY_BUCKETS = 30;

/** Number of brand-tier buckets (budget / mid / premium). */
export const BRAND_TIER_BUCKETS = 3;

/**
 * Engineered feature count. History:
 *   50 — original (heuristic prior + tokens + mode one-hot)
 *   60 — +10 round-context dims (2026-05-06)
 *   71 — +11 catalog-snap (2) + brand-tier one-hot (3) + bound (6)
 *        added in Phase 3a of the NN recovery plan.
 *   76 — +5 bidding-context dims (Phase 3d.2, 2026-05-09): residual_max,
 *        log_median, turn_idx_norm, is_last, has_prev_bids. Populated
 *        from RoundContext.biddingTurn when set, zero otherwise. Lets
 *        the trunk see "I'm bidding; here's what previous bidders did"
 *        without forking the price head.
 * The new 5 dims live at the tail of the engineered block, after the
 * Phase-3a block, before the bigrams. The pre-existing budget/target
 * round-context dims are kept and zeroed (PM/BB are out of rotation in
 * Phase 3d.2 but the dim positions stay so the trunk doesn't have to
 * relearn old features if those modes ever return).
 */
export const ENGINEERED_FEATURE_DIM = 76;
/** Number of round-context features at the tail of the engineered block. */
export const ROUND_CONTEXT_DIM = 10;
/** Number of Phase-3a feature dims (catalog-snap + brand-tier + bound). */
export const PHASE3A_FEATURE_DIM = 11;
/** Number of Phase-3d.2 bidding-context feature dims. */
export const BIDDING_FEATURE_DIM = 5;

/** Hashed-bigram feature count (signed Weinberger hash). */
export const HASHED_BIGRAM_DIM = 64;

/** Total input dimension to the trunk. */
export const FEATURE_DIM = ENGINEERED_FEATURE_DIM + HASHED_BIGRAM_DIM; // 124 (60 engineered + 64 hashed bigrams)

/** Trunk hidden dim (124 → 32 → 16). */
export const TRUNK_HIDDEN_DIM = 32;

/** Trunk output / embedding dim. */
export const EMBEDDING_DIM = 16;

/**
 * Mood-conditioning vector dimension.
 *
 * Phase 3e.2 (this file): **6 → 3**, dropping the round-context tail.
 *   [0]: vibe/3
 *   [1]: morale
 *   [2]: clamp(streak, -5, 5)/5
 *
 * Pre-3e.2 cond[3..5] were `[log(budgetCents+1)/12, log(maxPriceCapCents+1)/12,
 * clamp(productCount, 0, 30)/10]` — but those round-context numerics
 * are already in the trunk's engineered feature block (see
 * `featureExtractor.ts`'s round-context dims). Feeding them through
 * FiLM was double-encoding: same signal appears in trunk input and
 * in cond, doubling the parameter pressure for no information gain
 * and adding a NaN-trigger surface (PR #322's grad-explosion incident
 * propagated through FiLM). The slim keeps the unique mood signal
 * and removes the redundant numerics.
 */
export const COND_DIM = 3;

/**
 * Frozen architecture spec. Hashing this object produces the archHash
 * persisted with every snapshot. Layout-changing edits MUST be paired
 * with a SCHEMA_VERSION bump.
 *
 * Slimmed in PR #4 with the multi-task heads' removal: dropped
 * `categoryBuckets`, `tierBuckets`, `vizDim`, and `numTasks`. The
 * resulting hash differs from pre-PR-4, so old multi-task snapshots
 * auto-archive on next start via the existing arch-mismatch path.
 */
export interface ModelSpec {
  readonly featureDim: number;
  readonly trunkHiddenDim: number;
  readonly embeddingDim: number;
  readonly numModes: number;
  /**
   * Number of classes in the priceClass head's softmax — the size of
   * the canonical-prices catalog. K must be fixed at startup so the
   * head's W shape is stable across snapshots. Default matches the
   * hand-curated catalog in priceCatalog.ts.
   */
  readonly priceClassK: number;
  /**
   * Dimension of the mood-conditioning vector consumed by the FiLM
   * head. Phase 3e.2: 6 → 3, dropping the round-context tail.
   * Currently 3 — `[vibe/3, morale, clamp(streak, -5, 5)/5]` — the
   * bot's two-timescale valence + engagement. The round-shape
   * numerics that occupied the old tail (log_budget, log_cap,
   * productCount) are already in the trunk's engineered feature
   * block and were redundant in cond. See `COND_DIM`'s constant
   * docstring for the full rationale.
   */
  readonly condDim: number;
  /**
   * Phase 3b head topology version. Bumped whenever the set of heads
   * (priceClassHead + filmGen + new specialised heads) or their
   * shapes change. Adding new heads doesn't naturally change any
   * existing field in this spec — `headTopologyVersion` is the
   * dedicated knob that forces an archHash mismatch so old snapshots
   * auto-archive cleanly across head additions. Pre-Phase-3b is
   * implicitly version 0 (the field was absent); Phase 3b ships as
   * version 1.
   */
  readonly headTopologyVersion: number;
}

/**
 * Default priceClass-head output dimension. MUST equal the length of
 * the hand-curated catalog in priceCatalog.ts (currently 103).
 * WorkerCore.constructor asserts the invariant at startup so a drift
 * fails loudly rather than silently producing logits/catalog
 * mismatches deep in the training loop.
 *
 * Observation-extended catalogs may add entries up to MAX_K — when
 * that lands, the head output and the catalog must be re-aligned and
 * archHash bumped (the priceClassK in MODEL_SPEC is part of the hash,
 * so old snapshots auto-archive).
 */
export const PRICE_CLASS_K = 103;

/**
 * Current head-topology version.
 *
 * v1 — Phase 3b: pairLogit + squashedReg + priceMatchPair +
 *      budgetSelect + priceClass + logPrice (six K&G tasks).
 * v2 — Phase 3d.2: drop priceMatchPair + budgetSelect (modes removed);
 *      add pinballQ40Head (1-scalar quantile loss at τ=0.4, active only
 *      on bidding samples). Five K&G tasks total.
 * v3 — Phase 3e.2 (this file): pairLogit input shape change. Was
 *      `(2·embeddingDim → 1)`; now `(2·embeddingDim + PAIR_LOGIT_SCALAR_FEATURES → 1)`
 *      where the trailing 3 inputs are `[log(priceA), log(priceB),
 *      log(priceA / priceB)]` from the per-product priceClass argmax.
 *      The 3-reviewer NN debate found that comparison sat at 47.4%
 *      (chance) because the head was given only embeddings and had to
 *      re-derive "which is more expensive" from latent signal alone,
 *      while higher-lower (working at 63.2%) gets a reference-price
 *      scalar for free. Concurrent with v3: COND_DIM 6 → 3 (round-
 *      context tail dropped — see header). Both archHash inputs change,
 *      so v3 forces a single deliberate wipe; warm-start preserves
 *      compatible buffers (trunk + priceClassHead) but pairLogitHead
 *      and filmGen re-init from random.
 */
export const HEAD_TOPOLOGY_VERSION = 3;

/**
 * Phase 3e.2: number of scalar features appended to the pairLogit
 * head's input alongside the two trunk embeddings. Layout (after
 * `[embA; embB]`):
 *   [2·D + 0]: log(priceA_pred / 1000) — normalised log-cents for product A
 *   [2·D + 1]: log(priceB_pred / 1000) — same for B
 *   [2·D + 2]: log(priceA_pred / priceB_pred) — direct ratio anchor
 *
 * Both `priceA_pred` and `priceB_pred` come from the per-product
 * priceClassHead argmax (same path that populates `rankPredictions`).
 * They are stop-gradient inputs: the pairLogitHead's W learns weights
 * for them, but no gradient flows back through them into priceClassHead
 * (we don't want the comparison loss tugging the price classifier).
 */
export const PAIR_LOGIT_SCALAR_FEATURES = 3;

/**
 * Number of active per-task losses combined under Kendall&Gal
 * weighting. The order is fixed in `uncertaintyWeighting.ts` /
 * `workerCore.ts` and persisted in the snapshot's
 * `uncertainty_weights` BLOB; changing it requires a head-topology
 * bump.
 *
 * v2: 5 (pairLogit, squashedReg, pinballQ40, priceClass, logPrice).
 */
export const NUM_ACTIVE_TASKS = 5;

/** The single ModelSpec instance used everywhere. */
export const MODEL_SPEC: ModelSpec = Object.freeze({
  featureDim: FEATURE_DIM,
  trunkHiddenDim: TRUNK_HIDDEN_DIM,
  embeddingDim: EMBEDDING_DIM,
  numModes: NUM_GAME_MODES,
  priceClassK: PRICE_CLASS_K,
  condDim: COND_DIM,
  headTopologyVersion: HEAD_TOPOLOGY_VERSION,
});

/** Reduced product struct passed across the worker boundary. */
export interface ProductLite {
  id: number;
  title: string;
  category: string;
  description?: string;
  imageUrl?: string;
}

/** Brand-tier classification used as the auxiliary label. */
export type BrandTier = 0 | 1 | 2; // 0=budget, 1=mid, 2=premium

/** Replay buffer entry — one per revealed product. */
export interface Sample {
  features: Float32Array;
  /** Target = log(actualCents / heuristicCents); the price head learns the residual. */
  targetLogResidual: number;
  actualCents: number;
  heuristicCents: number;
  /** 0..CATEGORY_BUCKETS-1. */
  categoryId: number;
  brandTier: BrandTier;
  mode: GameMode;
  productId: number;
  /** Same `roundId` for every sample of a multi-product reveal — drives PER de-correlation. */
  roundId: string;
  /** Round counter when the sample was recorded. Used for teaching-moment expiry. */
  recordedAtRound: number;
  /**
   * Bounds the player saw at predict time, in cents — typically
   * sourced from the server's `Product.priceRange`, the riser
   * `maxPriceCents` cap (encoded as `{min: 0, max: cap}`), or the
   * classic-mode hint range. Persisted on the Sample so train-time
   * masking sees the same constraint the decoder applied. Absent for
   * modes/rounds that don't expose bounds (e.g. bidding).
   */
  priceRangeCents?: { readonly min: number; readonly max: number };
  /**
   * Phase 3a: round-level numerics carried into FiLM cond. Persisted
   * so train-time `moodToCond` produced an identical 6-d cond vector
   * to what predict() built.
   *
   * **Phase 3e.2: vestigial.** COND_DIM shrank 6 → 3, removing the
   * round-context tail entirely; `moodToCond` no longer reads this
   * field. Kept on the type + persisted by `replayBuffer.ts` for
   * back-compat with replay archives written pre-3e.2 — dropping
   * the field would require a replay-buffer schema bump that's not
   * worth it. New samples are still written with this field for
   * symmetry, but the value is read by nothing post-3e.2.
   */
  roundContextSnapshot?: {
    readonly budgetCents?: number;
    readonly maxPriceCapCents?: number;
    readonly productCount?: number;
  };
  /**
   * Bot mood at the time this sample was recorded — vibe + morale
   * only (streak is a round-level, not training-relevant signal).
   * Optional for back-compat with snapshots taken before the FiLM
   * head landed; the trainer treats absent mood as neutral
   * `(vibe = 0, morale = 0)`, which produces an identity FiLM
   * forward at runtime via the zero-initialised filmGen.
   */
  mood?: { readonly vibe: number; readonly morale: number };
  /**
   * Phase 3d.2: snapshot of `BiddingTurnPayload`-derived stats at
   * predict time. Persisted on bidding samples so the trunk's
   * train-time forward sees the same 5 bidding-context dims it saw
   * at predict time. Absent for non-bidding modes; the feature
   * extractor zero-fills the 5 dims when this is undefined.
   */
  biddingContext?: {
    readonly turnIdx: number;
    readonly totalPlayers: number;
    /** Cents — empty when first bidder. */
    readonly previousBidsCents: ReadonlyArray<number>;
  };
}

/** Single-product prediction request from the main thread. */
export interface PredictReq {
  roundId: string;
  mode: GameMode;
  product: ProductLite;
  referencePrice?: number;
  pairProducts?: [ProductLite, ProductLite];
  rankProducts?: ProductLite[];
  /**
   * Budget cap (cents) when the round has one — budget-builder is the
   * only mode that uses this. Threaded into the trunk's round-context
   * features so the model knows what total it's targeting.
   */
  budgetCents?: number;
  /**
   * Sorted-ascending list of target prices (cents) for price-match
   * rounds. Mean / min / max / span are encoded into round-context
   * features.
   */
  targetPricesCents?: ReadonlyArray<number>;
  /**
   * Per-product bounds the player sees on the slider/range — the
   * server emits `Product.priceRange` on every single-product round
   * (classic, closest, higher-lower, comparison) and per-element
   * for multi-product rounds (budget-builder, market-basket).
   * The decoder mask consumes this to refuse out-of-range catalog
   * classes; train-time masking uses it identically.
   */
  priceRangeCents?: { readonly min: number; readonly max: number };
  /**
   * Per-product bounds for `rankProducts` entries when the runner
   * is asking for a multi-product prediction (e.g. budget-builder).
   * Indices align with `rankProducts`; entries may be absent when
   * a particular product carries no range.
   */
  rankPriceRangesCents?: ReadonlyArray<{ readonly min: number; readonly max: number } | undefined>;
  /**
   * Riser-only one-sided price ceiling (cents). The "answer" is in
   * `[0, maxPriceCapCents]`. Plumbed separately from priceRangeCents
   * because riser doesn't expose a lower bound.
   */
  maxPriceCapCents?: number;
  /**
   * Bot mood snapshot at predict time. The worker builds the FiLM
   * cond vector from this when present; if undefined (or the worker
   * was constructed with `moodInfluence === 0`) the FiLM forward is
   * skipped entirely and the prediction path is identical to the
   * pre-FiLM baseline. Streak is included because it captures the
   * "in the groove" signal that the resolver promotes to `focused`.
   *
   * Phase 3d.2: ignored when `mode === "bidding"` — mood does not
   * modulate the bidding decision quantile (prospect-theory tilt on
   * a one-sided loss is a regret amplifier). The worker zero-fills
   * cond on bidding rounds.
   */
  mood?: {
    readonly vibe: number;
    readonly morale: number;
    readonly streak: number;
  };
  /**
   * Phase 3d.2: bidding-turn snapshot. Drives the 5 bidding-context
   * feature dims and is persisted onto the Sample for symmetric
   * train-time forward. Absent for non-bidding modes.
   */
  biddingTurn?: {
    readonly turnIdx: number;
    readonly totalPlayers: number;
    /** Cents — empty when first bidder. */
    readonly previousBidsCents: ReadonlyArray<number>;
  };
}

/**
 * Single-product prediction response from the worker.
 *
 * Slimmed in PR #4: muLogResidual / sigmaLogResidual / categoryProbs /
 * brandTierProbs / pairwiseLogit are gone with the multi-task heads.
 * The active classifier exposes its full output via priceCandidates.
 */
export interface PredictRes {
  roundId: string;
  /** Predicted price (catalog argmax) in cents — always a real retail price. */
  predictedCents: number;
  /** Spread of the catalog softmax (std of cents under the distribution). */
  predictedSigmaCents: number;
  /** 2-d projection of the trunk embedding (dims 0/1) — broadcast scatter only. */
  embedding2d: [number, number];
  /** Top contributing engineered features (descending |contribution|). */
  topFeatures: Array<{ name: string; contribution: number }>;
  /** Per-product ranked predictions when rankProducts is set. */
  rankPredictions?: Array<{ id: number; predictedCents: number; sigma: number }>;
  /**
   * Top-K canonical-prices catalog candidates from the priceClassHead
   * softmax, sorted by probability descending. Rendered by BeliefCard
   * as "$9.99 (62%) · $12.99 (18%) · $7.99 (9%)". `cents` is a snapped
   * catalog price; `prob` is in [0, 1]. Empty array signals "model is
   * broken" (NaN logits).
   */
  priceCandidates?: Array<{ cents: number; prob: number }>;
  /** Wallclock at response build time (ms). */
  ageMs: number;
  /** Thompson draw — sampled cents the strategy may use as its centerpoint. */
  explorationDraw?: number;
  /**
   * Adaptive ε for this round — the driver compares `Math.random()`
   * against this and toggles `StrategyContext.exploration` when below.
   * Computed inside the worker because it depends on per-category
   * running stats and the round counter.
   */
  epsilon?: number;
  /**
   * Phase 3b binary-mode signal. Present only when the predict
   * request carries `pairProducts` of length 2 — the runner sets
   * this for higher-lower and comparison rounds.
   *
   * Defined as `sigmoid(pairLogit)` where the pair-logit head
   * consumes `[emb(pairProducts[0]); emb(pairProducts[1])]`. The
   * convention is **"probability that pairProducts[0] is the
   * higher-priced / correct side"** — the runner's strategy code
   * picks the side accordingly. (For higher-lower the runner
   * additionally compares against `referencePrice`; the head's
   * signal is most directly useful for comparison mode.)
   *
   * Range `[0, 1]`. Absent for non-pair predicts.
   */
  pairAIsCorrectProb?: number;
  /**
   * Phase 3d.2 squashed-regression posterior on log(actualCents/heuristic).
   * Present on every single-product predict (classic, bidding). The
   * decoder converts (μ, σ) into a centerpoint via heuristic·exp(μ).
   * For bidding the strategy uses (μ, σ) plus opponent-bid context to
   * pick a bid via simulation.
   */
  squashedRegression?: { mu: number; sigma: number };
  /**
   * Phase 3d.2 pinball-q40 head output (bidding-only). Predicted
   * lower-quantile of log(actualCents/heuristic) at τ=0.4. Used by
   * the bidding decoder as a robustness floor: if simulator-driven
   * argmax diverges far above this, fall back to it. Absent when
   * `mode !== "bidding"` or the head is in its pre-warmup window.
   */
  pinballQ40LogResidual?: number;
}

/** Per-product reveal carried in an update message. */
export interface RevealedSample {
  product: ProductLite;
  actualCents: number;
  /** Optional explicit category bucket — defaults to mapping product.category. */
  categoryId?: number;
  mode: GameMode;
  /**
   * Bounds the player saw on this specific product at predict time
   * (cents). Persisted on the resulting {@link Sample} so train-time
   * masking restricts CE to the same in-range catalog classes the
   * decoder used at predict.
   */
  priceRangeCents?: { readonly min: number; readonly max: number };
  /**
   * Phase 3d.2: bidding-turn snapshot the bot saw at predict time.
   * Runner stamps this when `mode === "bidding"` so train-time
   * forward sees the same opponent-bid context as predict.
   */
  biddingContext?: {
    readonly turnIdx: number;
    readonly totalPlayers: number;
    readonly previousBidsCents: ReadonlyArray<number>;
  };
}

/** Update request from the main thread (fire-and-forget). */
export interface UpdateReq {
  roundId: string;
  revealedSamples: RevealedSample[];
  primaryMode: GameMode;
  /** What the bot actually submitted — kept for future calibration logs. */
  chosenGuess?: unknown;
  outcome: "correct" | "partial" | "incorrect";
  /**
   * Round-level constraints the player saw at predict time. Plumbed
   * separately from {@link RevealedSample.priceRangeCents} because
   * these are round-scope, not per-product. Persistence ensures that
   * every minibatch step that draws this round's samples builds an
   * identical RoundContext to what predict() saw — the existing
   * train-time RoundContext was always 0 for these fields, which is
   * a textbook train/test skew the model could never reconcile.
   */
  budgetCents?: number;
  targetPricesCents?: ReadonlyArray<number>;
  maxPriceCapCents?: number;
  /**
   * Bot mood at the moment this update was queued. The worker
   * stamps each new {@link Sample} added to the replay buffer with
   * this value (vibe + morale only) so future minibatch steps that
   * draw the sample apply FiLM + arousal-gated importance under
   * the mood the sample was actually observed in. Absent → treated
   * as neutral.
   */
  mood?: { readonly vibe: number; readonly morale: number };
}

/** Phase emitted in the visual tick. */
export type LearningPhase =
  | "idle"
  | "thinking"
  | "guessing"
  | "reveal"
  | "result";

/** Pre-encoded payload the worker emits for the broadcast overlay. */
export interface VisualTick {
  roundId: string;
  phase: LearningPhase;
  network: {
    layers: Array<{
      name: string;
      activations: number[];
      mostActiveIdx: number;
      mostActiveTrail: [number, number];
    }>;
    weightSamples: Array<{
      fromLayer: number;
      fromIdx: number;
      toLayer: number;
      toIdx: number;
      weight: number;
    }>;
    heroPath?: Array<{ layer: number; idx: number }>;
  };
  prediction: { cents: number; sigma: number };
  /**
   * Top-K canonical-prices catalog candidates from the priceClassHead
   * softmax, sorted by probability descending. Rendered by the
   * BeliefCard panel as "$9.99 (62%) · $12.99 (18%)". Empty array on
   * non-finite logits (NaN-storm state) so the panel can show a
   * "Calibrating…" copy instead of garbage. Optional for back-compat
   * with PR-2-era ticks that don't ship this field.
   */
  priceCandidates?: Array<{ cents: number; prob: number }>;
  /**
   * Belief block — slimmed in PR #4. The pre-cleanup category /
   * brand-tier softmaxes are gone with the heads that produced them;
   * only `topFeatures` + an optional pre-rendered worker `sentence`
   * remain. Sentence is now confidence-derived (top-prob + entropy)
   * instead of category-derived.
   */
  belief: {
    topFeatures: Array<{ name: string; contribution: number }>;
    sentence?: string;
  };
  embedding2d: { x: number; y: number };
  recentLosses: number[];
  recentAccuracy: Array<"within10" | "within25" | "miss">;
  teachingMoment: { triggered: boolean; productTitle?: string };
  /**
   * Optional training/health snapshot — feeds the Neural Debug HUD's
   * "training" column. Same numbers exposed via /healthz, but inlined
   * on every tick so the broadcast page doesn't need a second relay.
   * Optional for back-compat with PR-2-era ticks.
   */
  health?: {
    round: number;
    /** Last training loss (mean across the round's stepsPerRound steps); null when no update has run yet. */
    loss: number | null;
    /** Rolling p95 of grad norms over the recent training window. */
    gradNormP95: number;
    /** Effective LR at this step (post-warmup linear ramp). */
    learningRate: number;
    /** Adam step counter. Pair with warmupTotal to render warmup progress. */
    warmupStep: number;
    /** Total warmup steps configured (constant: 200 by default). */
    warmupTotal: number;
    bufferSize: number;
    bufferCapacity: number;
    batchSize: number;
    stepsPerRound: number;
    goldenMAE: number | null;
    /**
     * ms since the last successful saveSnapshot at the time this tick
     * was emitted. The HUD extrapolates "X s ago" off the local clock
     * so the value ticks up between tick deliveries.
     */
    snapshotAgeMs: number;
    teachingMomentsCount: number;
    nanRollbacks: number;
    frozen: boolean;
  };
  ageMs: number;
}

/** Health block exposed via /healthz. */
export interface LearningHealthBlock {
  enabled: boolean;
  mode: "off" | "shadow" | "active";
  lastSnapshotRound: number;
  nanRollbacks: number;
  goldenMAE: number | null;
  staleResponses: number;
  workerHeartbeatMs: number;
  bufferSize: number;
  teachingMomentsCount: number;
  modelVersion: string;
  /**
   * Operational degradation state:
   *   - false           — healthy
   *   - "worker_dead"   — heartbeat absent >30 s; bot continues on heuristic
   *                       (bridge auto-restarts the worker)
   *   - "nan_storm"     — >10 NaN rollbacks in 1 hour; NN frozen, heuristic-only
   *   - "schema_reset"  — first 50 rounds after an arch-hash mismatch (deferred)
   *   - "disk"          — disk usage ≥80%; NDJSON paused, snapshots stop at 90%
   */
  degraded: false | "disk" | "worker_dead" | "nan_storm" | "schema_reset";
  gradNormP95: number;
  /**
   * Post-clip equivalent of `gradNormP95` — `min(preClip, MAX_GRAD_NORM)`
   * per minibatch step. Distinguishes raw grad spikes from steps that
   * Adam actually applied at full magnitude.
   */
  gradNormPostClipP95: number;
  /** Snapshot age (ms since last successful saveSnapshot). */
  snapshotAgeMs: number;
  /** Rolling p95 of saveSnapshot durations (ms). */
  dbWriteLatencyP95Ms: number;
  /** Disk used ratio (0..1) from the last poll. */
  diskUsedRatio: number;
  /** True iff the NN is currently frozen by the NaN-storm guard. */
  frozen: boolean;
  /**
   * Count of snapshot writes refused by the regression gate (current
   * MAE > 1.2× median of last-N accepted MAEs, or non-finite). Increments
   * are a strong signal that training has destabilised — the persisted
   * weights remain at the last good state, so the bot can recover by
   * being restarted.
   */
  goldenRegressionRollbacks: number;
  /**
   * Phase 3e.0: per-task observation counts (cumulative, indexed by
   * `TASK_INDEX`). Used by the head-starvation watchdog to surface
   * tasks that have received zero training signal — e.g. when an
   * upstream data-path bug stops a mode from reporting samples
   * (see PR #322 fallout: pinballQ40 head was un-trained for 2,260
   * rounds because of an MP bidding placement bug).
   */
  perTaskObservations: ReadonlyArray<number>;
  /**
   * Phase 3e.0: starvation flag — non-empty array of TASK_INDEX names
   * for any registered head that has 0 observations after >300 rounds.
   * Empty when all heads have fired or warmup is incomplete. Operators
   * watch this to catch silent data-path regressions.
   */
  starvedTasks: ReadonlyArray<string>;
  /**
   * Phase 3e.3: AGC fired on this many buffers per step (p95 across the
   * recent window). Most healthy steps clip 0–2 of 14 buffers; sustained
   * high counts indicate `AGC_LAMBDA` is too tight for the current
   * gradient distribution.
   */
  agcClipsP95: number;
  /**
   * Phase 3e.3: smallest scale factor AGC has applied across all buffers
   * in the recent window (p5 — the worst per-buffer compression). 1.0
   * means AGC didn't fire; values below ~0.3 indicate sustained over-
   * clipping.
   */
  agcMinScaleP5: number;
}

/** Worker → Main message envelope. */
export type WorkerInbound =
  | { kind: "init"; dataDir: string; archHash: string }
  | ({ kind: "predict" } & PredictReq)
  | ({ kind: "update" } & UpdateReq)
  | { kind: "visual_request"; roundId: string }
  | { kind: "reset" }
  | { kind: "shutdown" };

/** Main → Worker message envelope. */
export type WorkerOutbound =
  | {
      kind: "ready";
      modelVersion: string;
      archHash: string;
      loadedSnapshotRound: number | null;
    }
  | ({ kind: "predict_response" } & PredictRes)
  | {
      kind: "update_response";
      roundId: string;
      ok: boolean;
      loss: number;
      nanRollback: boolean;
      snapshotRound?: number;
      teachingMomentTriggered: boolean;
    }
  | { kind: "visual_response"; roundId: string; tickBuffer: Buffer }
  | { kind: "shutdown_ack" }
  | { kind: "reset_ack" }
  | {
      kind: "heartbeat";
      round: number;
      bufferSize: number;
      goldenMAE: number | null;
      nanRollbacks: number;
      gradNormP95: number;
      gradNormPostClipP95: number;
      lastSnapshotRound: number;
      staleResponses: number;
      teachingMomentsCount: number;
      degraded: LearningHealthBlock["degraded"];
      /** Snapshot age (ms since last successful saveSnapshot). */
      snapshotAgeMs: number;
      /** Rolling p95 of saveSnapshot durations (ms). */
      dbWriteLatencyP95Ms: number;
      /** Disk used ratio (0..1) from the last poll. */
      diskUsedRatio: number;
      /** True iff the NN is currently frozen by the NaN-storm guard. */
      frozen: boolean;
      /** Cumulative count of snapshot writes refused by the regression gate. */
      goldenRegressionRollbacks: number;
      /**
       * Phase 3e.0: per-task observation counts (cumulative). Optional
       * for back-compat with worker builds that pre-date this field.
       */
      perTaskObservations?: ReadonlyArray<number>;
      /**
       * Phase 3e.0: registered heads with 0 observations after warmup.
       * Optional for back-compat with worker builds that pre-date this
       * field.
       */
      starvedTasks?: ReadonlyArray<string>;
      /** Phase 3e.3: AGC clip count p95 (optional for back-compat). */
      agcClipsP95?: number;
      /** Phase 3e.3: AGC min-scale p5 (optional for back-compat). */
      agcMinScaleP5?: number;
    }
  | { kind: "error"; code: string; msg: string };
