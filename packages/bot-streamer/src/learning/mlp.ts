/**
 * Hand-rolled MLP for the streamer-bot.
 *
 * Why hand-rolled: the network is tiny; a tensor-library dependency
 * would dwarf it on disk and add cold-start latency. Float32 arrays
 * + manual loops give us deterministic timing (<2 ms / round on one
 * core) and a serialisation format we control byte-for-byte.
 *
 * Layout (post-PR-4):
 *   trunk:           Linear(124→32) → ReLU → Linear(32→16)
 *   priceClassHead:  Linear(16→K)   softmax over canonical-prices catalog
 *
 * The pre-PR-4 multi-task heads (priceHead / pairHead / categoryHead /
 * tierHead / vizHead + per-mode biases) and their associated gradient
 * machinery have been removed; the trunk is now shaped purely by the
 * price-classification objective. archHash bumps so old multi-task
 * snapshots auto-archive on next start.
 *
 * Forward returns the activations needed by backward; backward computes
 * dW/db for each layer and propagates dx upstream. Gradient buffers are
 * allocated by the caller (workerCore) so they can be reused across
 * minibatch steps without GC pressure.
 *
 * He init for the ReLU layer; small-noise init for the linear
 * embedding layer + the classification head.
 */

import {
  COND_DIM,
  EMBEDDING_DIM,
  FEATURE_DIM,
  MODEL_SPEC,
  NUM_GAME_MODES,
  PAIR_LOGIT_SCALAR_FEATURES,
  TRUNK_HIDDEN_DIM,
} from "./types";

/** Single fully-connected layer. W is row-major: W[outIdx * inDim + inIdx]. */
export interface Layer {
  readonly inDim: number;
  readonly outDim: number;
  W: Float32Array;
  b: Float32Array;
}

/**
 * Network struct.
 *
 * Trunk (124→32→16) + priceClassHead (16→K) + filmGen (3→32) for
 * mood conditioning. The filmGen output splits into γ (16) and β
 * (16) with bounded `tanh`-gated magnitude so the FiLM modulation
 * `h_film = γ ⊙ h + β` is provably bounded (γ ∈ [1±0.1·scale],
 * β ∈ [±0.1·scale]) where scale = persona.moodInfluence ∈ [0, 1].
 *
 * Zero-initialised filmGen + tanh(0) = 0 ⇒ γ = 1, β = 0 at start,
 * so a freshly-initialised model is bit-equivalent to the pre-FiLM
 * baseline regardless of `moodInfluence`. As training progresses,
 * filmGen learns small mood-conditioned modulations from gradient
 * — bounded above by the `0.1·scale·tanh` envelope.
 */
export interface Network {
  trunk: [Layer, Layer]; // [124→32 ReLU, 32→16 linear]
  /**
   * Pre-Phase-3b sole head; in Phase 3b retained as auxiliary trunk-
   * shaper. 16→K softmax over the canonical-prices catalog.
   */
  priceClassHead: Layer;
  /**
   * FiLM generator: Linear(condDim → 2 · embeddingDim) producing
   * the raw scalars that feed `tanh`-bounded γ and β. Zero-init
   * means the network starts as the bare-trunk baseline regardless
   * of mood; filmGen learns small modulations from gradient.
   */
  filmGen: Layer;
  /**
   * Phase 3b auxiliary head: 16→2 producing `(μ, log σ²)` in
   * log-cents space. Trained under Gaussian NLL on `log(actualCents)`
   * for every revealed product across single-product modes; revives
   * the dead `thompsonSampler.ts` posterior path (PR #290 zeroed out
   * the variance signal). Fixed K&G weight 0.1.
   */
  logPriceHead: Layer;
  /**
   * Phase 3b primary head for **comparison** rounds (two-product
   * "more/less expensive"): Linear(2·embeddingDim → 1). Forward
   * consumes the concat `[emb_A; emb_B]`; `sigmoid(logit) = P(A
   * is more expensive than B)`. Trained under sigmoid-BCE on the
   * round's reveal.
   *
   * Higher-lower's payload is one product + a reference price (no
   * second product embedding) so it does NOT route through this
   * head — the strategy decides via the squashed-reg head's
   * predictedCents vs `referencePrice`. The plan's "binary modes"
   * grouping covered both modes conceptually, but only comparison
   * has the two-product structure this head needs.
   */
  pairLogitHead: Layer;
  /**
   * Phase 3b primary head for single-product modes with a known
   * price range (classic, closest-without-going-over, riser):
   * Linear(embeddingDim → 1). Output `raw` is squashed via tanh +
   * affine rescale to land in `[min, max]`, so the decoded
   * `predictedCents` is feasible by construction (no decoder mask
   * needed). Trained under Huber on `(predicted_cents −
   * actualCents) / 100`. The plan reviewer recommended this over
   * the masked-softmax-then-argmax decode for continuous-slider
   * modes — the integer catalog snap is a poor fit for a
   * continuous-priced game and the train-time logit mask creates
   * calibration drift we don't pay here.
   */
  squashedRegressionHead: Layer;
  /**
   * Phase 3d.2 bidding-only auxiliary head. Linear(embeddingDim → 1)
   * trained under pinball loss at τ=0.4 on `targetLogResidual` —
   * directly regresses a calibrated lower-quantile of
   * `log(actualCents/heuristic)` for the bidding mode. Used by the
   * bidding decoder as a robustness floor; if the simulator-driven
   * argmax bid is far above q40·exp(heuristic), the decoder snaps
   * to it. Keeping this as a small linear projection (not an
   * MLP) keeps the parameter footprint small and the gradient path
   * short — Phase 3d.1's grad explosions came from MLP heads with
   * unbounded variance outputs.
   */
  pinballQ40Head: Layer;
}

/**
 * Allocate a layer with the requested initialiser.
 *
 * @param inDim  Input dimension.
 * @param outDim Output dimension.
 * @param init   Initialiser kind:
 *                 - "he"        — He-normal (sqrt(2/inDim)) for ReLU layers.
 *                 - "scaled-id" — 0.5·I + N(0, 0.01); only valid when inDim===outDim.
 *                 - "zero-w-he-b" — weights zero (used for log σ² head).
 *                 - "small"     — N(0, 0.01); for output heads.
 * @param rng    RNG returning U[0,1). Defaults to Math.random.
 */
export function createLayer(
  inDim: number,
  outDim: number,
  init: "he" | "scaled-id" | "zero" | "small",
  rng: () => number = Math.random,
): Layer {
  const W = new Float32Array(outDim * inDim);
  const b = new Float32Array(outDim);
  if (init === "he") {
    const stddev = Math.sqrt(2 / inDim);
    for (let i = 0; i < W.length; i++) W[i] = sampleNormal(rng) * stddev;
  } else if (init === "scaled-id") {
    if (inDim !== outDim) throw new Error("scaled-id requires inDim === outDim");
    for (let o = 0; o < outDim; o++) {
      for (let i = 0; i < inDim; i++) {
        const idx = o * inDim + i;
        const noise = sampleNormal(rng) * 0.01;
        W[idx] = (o === i ? 0.5 : 0) + noise;
      }
    }
  } else if (init === "zero") {
    // W left at zero — used for the log σ² head so the model starts
    // homoscedastic and learns variance from data.
  } else {
    // "small"
    for (let i = 0; i < W.length; i++) W[i] = sampleNormal(rng) * 0.01;
  }
  return { inDim, outDim, W, b };
}

/** Box-Muller normal sample. */
function sampleNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Build a fresh Network with all layers initialised per the plan.
 *
 * @param rng Optional seeded RNG so tests get reproducible weights.
 */
export function createNetwork(rng: () => number = Math.random): Network {
  const trunkA = createLayer(MODEL_SPEC.featureDim, MODEL_SPEC.trunkHiddenDim, "he", rng);
  const trunkB = createLayer(MODEL_SPEC.trunkHiddenDim, MODEL_SPEC.embeddingDim, "small", rng);
  // The classification head: softmax over the canonical-prices catalog.
  // "small" init keeps the initial logits ≈ 0 so softmax starts uniform
  // and the model has the full first-batch gradient signal to lean on.
  const priceClassHead = createLayer(MODEL_SPEC.embeddingDim, MODEL_SPEC.priceClassK, "small", rng);
  // FiLM generator. "zero" init so γ = 1 + 0.1·s·tanh(0) = 1 and
  // β = 0.1·s·tanh(0) = 0 exactly at start — `forwardFilm` is the
  // identity transformation regardless of `moodInfluence` until
  // gradient nudges filmGen's weights away from zero.
  const filmGen = createLayer(MODEL_SPEC.condDim, 2 * MODEL_SPEC.embeddingDim, "zero", rng);
  // logPriceHead: small init so the initial μ ≈ 0 and log σ² ≈ 0
  // ⇒ σ² ≈ 1, the net starts homoscedastic and learns the variance
  // surface from data. Bias is in the small-init of `b` already
  // since `createLayer(..., "small")` only randomises W; b stays
  // zero — for log σ² that's the desired prior (σ² = 1).
  const logPriceHead = createLayer(MODEL_SPEC.embeddingDim, 2, "small", rng);
  // pairLogitHead: small init so the initial logit ≈ 0 ⇒
  // sigmoid(logit) = 0.5 ⇒ uninformed predictions until the head
  // learns. Phase 3e.2 (head topology v3): input is now
  // `(2·embeddingDim + PAIR_LOGIT_SCALAR_FEATURES → 1)`. The trailing
  // 3 inputs are stop-gradient log-price features from per-product
  // priceClass argmax — see PAIR_LOGIT_SCALAR_FEATURES doc in types.ts.
  const pairLogitHead = createLayer(
    2 * MODEL_SPEC.embeddingDim + PAIR_LOGIT_SCALAR_FEATURES,
    1,
    "small",
    rng,
  );
  // squashedRegressionHead: small init so raw ≈ 0 at start ⇒
  // tanh(raw) = 0 ⇒ predicted_cents = (min + max) / 2 (the range
  // midpoint). The model starts at the most uninformative-yet-
  // feasible guess for the round's bound.
  const squashedRegressionHead = createLayer(MODEL_SPEC.embeddingDim, 1, "small", rng);
  // pinballQ40Head (Phase 3d.2): single linear projection for the
  // bidding-only safe-bid quantile. "small" init so the head starts
  // at ≈ 0 ⇒ predicted q40-residual = 0 (i.e. q40 ≈ heuristic) until
  // the trunk learns the under-bid-bias direction. Only consumes
  // gradient on bidding samples (workerCore gates `taskMask`).
  const pinballQ40Head = createLayer(MODEL_SPEC.embeddingDim, 1, "small", rng);
  return {
    trunk: [trunkA, trunkB],
    priceClassHead,
    filmGen,
    logPriceHead,
    pairLogitHead,
    squashedRegressionHead,
    pinballQ40Head,
  };
}

/**
 * Linear forward: y = W · x + b. Allocates a fresh `out` buffer.
 *
 * @param layer Layer to apply.
 * @param x     Input vector of length `layer.inDim`.
 * @returns Output vector of length `layer.outDim`.
 */
export function forwardLinear(layer: Layer, x: Float32Array): Float32Array {
  if (x.length !== layer.inDim) {
    throw new Error(`forwardLinear: dim mismatch ${x.length} != ${layer.inDim}`);
  }
  const out = new Float32Array(layer.outDim);
  for (let o = 0; o < layer.outDim; o++) {
    let s = layer.b[o];
    const rowBase = o * layer.inDim;
    for (let i = 0; i < layer.inDim; i++) {
      s += layer.W[rowBase + i] * x[i];
    }
    out[o] = s;
  }
  return out;
}

/** In-place ReLU. Returns the same buffer. */
export function reluInPlace(x: Float32Array): Float32Array {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0) x[i] = 0;
  }
  return x;
}

/**
 * LeakyReLU slope used for the priceMatchPair head's L1 (Phase 3c
 * follow-up). 0.01 is the standard LeakyReLU slope; small enough
 * that the head's predict-time scores are essentially unchanged
 * for previously-active dims, large enough that previously-dead
 * dims contribute non-trivial gradient.
 *
 * **Backwards-compat note:** changing the activation does shift
 * predict-time scores on a freshly-loaded snapshot — for every L1
 * dim that was negative-pre-activation under plain ReLU,
 * `L2.score` now picks up an additional `0.01 · L2.W[k] · l1Linear[k]`
 * term per dim. The shift is small (~1% of the active-dim
 * contribution) and continuous, so existing trained signal is
 * preserved across the upgrade.
 */
export const LEAKY_RELU_SLOPE = 0.01;

/**
 * In-place LeakyReLU (`x > 0 ? x : slope * x`). Returns the same
 * buffer. Used by `forwardPriceMatchPair` to break the symmetry-
 * cancellation pathology that pinned the head's pairwise-margin
 * loss at the margin floor.
 */
export function leakyReluInPlace(x: Float32Array, slope: number): Float32Array {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0) x[i] = slope * x[i];
  }
  return x;
}

/** ReLU mask (1 if x > 0 else 0) — needed by backward. */
export function reluMask(x: Float32Array): Float32Array {
  const m = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) m[i] = x[i] > 0 ? 1 : 0;
  return m;
}

/** Forward through the trunk. Returns intermediate activations for backward. */
export interface TrunkActivations {
  /** trunkA pre-activation (before ReLU). */
  hiddenLinear: Float32Array;
  /** trunkA post-activation (after ReLU). */
  hidden: Float32Array;
  /** trunkB output = embedding. */
  embedding: Float32Array;
}

/**
 * Forward pass through the shared trunk.
 *
 * @param net Network.
 * @param x   Input feature vector.
 * @returns Intermediate activations needed for backward.
 */
export function forwardTrunk(net: Network, x: Float32Array): TrunkActivations {
  const hiddenLinear = forwardLinear(net.trunk[0], x);
  const hidden = reluInPlace(new Float32Array(hiddenLinear)); // copy then ReLU
  const embedding = forwardLinear(net.trunk[1], hidden);
  return { hiddenLinear, hidden, embedding };
}

/**
 * Linear backward. Given upstream gradient dy, compute dW, db, dx.
 *
 * **Accumulator contract:** the returned `dW`, `db`, and `dx` are
 * fresh `Float32Array`s. Callers that invoke this function multiple
 * times against the same parameter buffer (e.g. summing the
 * gradients from several samples in a minibatch) MUST accumulate
 * the returned arrays into their own buffers — typically via
 * `addInto(grads[idx], bw.dW)`. Calling `backwardLinear` twice and
 * relying on the second call to "extend" the first's `dW` would
 * silently lose the first call's contribution because each call
 * assigns into a freshly-zeroed array.
 *
 * @param layer Layer the forward used.
 * @param x     Input that was passed to forward.
 * @param dy    Upstream gradient w.r.t. y. Length === layer.outDim.
 * @returns dW (size W), db (size b), dx (size inDim) — each a fresh
 *          buffer; the caller must accumulate.
 */
export function backwardLinear(
  layer: Layer,
  x: Float32Array,
  dy: Float32Array,
): { dW: Float32Array; db: Float32Array; dx: Float32Array } {
  const dW = new Float32Array(layer.W.length);
  const db = new Float32Array(layer.b.length);
  const dx = new Float32Array(layer.inDim);
  for (let o = 0; o < layer.outDim; o++) {
    const dyo = dy[o];
    if (dyo === 0) continue;
    db[o] = dyo;
    const rowBase = o * layer.inDim;
    for (let i = 0; i < layer.inDim; i++) {
      dW[rowBase + i] = dyo * x[i];
      dx[i] += layer.W[rowBase + i] * dyo;
    }
  }
  return { dW, db, dx };
}

/** Multiply dx by the ReLU mask in-place. */
export function applyReluMaskInPlace(dx: Float32Array, mask: Float32Array): Float32Array {
  for (let i = 0; i < dx.length; i++) dx[i] *= mask[i];
  return dx;
}

/**
 * Compute the global L2 norm of a flat collection of gradient buffers,
 * scale them all by min(maxNorm/norm, 1) in-place, and return the
 * pre-clip norm so callers can record it.
 */
export function clipGradientsInPlace(grads: Float32Array[], maxNorm: number): number {
  let sumSq = 0;
  for (const g of grads) {
    for (let i = 0; i < g.length; i++) sumSq += g[i] * g[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > maxNorm && norm > 0) {
    const scale = maxNorm / norm;
    for (const g of grads) {
      for (let i = 0; i < g.length; i++) g[i] *= scale;
    }
  }
  return norm;
}

/**
 * Phase 3e.3 — Adaptive Gradient Clipping (AGC), Brock et al. 2021.
 *
 * Per-buffer rule: scale `g_i` by `min(1, lambda * max(||W_i||, eps_param)
 * / max(||g_i||, eps_grad))`. The threshold scales with the parameter's
 * own L2 norm, so a healthy buffer (||g|| << lambda * ||W||) passes
 * through unclipped while only buffers whose gradient magnitude is
 * disproportionate to their parameter magnitude get throttled.
 *
 * Why this matters here: post-3e.1 prod telemetry showed the global
 * L2 clip (`clipGradientsInPlace` with `MAX_GRAD_NORM=3.0`) binding on
 * 100% of post-reset minibatch steps because the AGGREGATE ||g|| across
 * all 14 buffers averages 80–100. The aggregate dominates a small
 * number of medium-norm buffers, but each individual buffer's gradient
 * is well-conditioned. AGC clips per-buffer, so the optimizer signal
 * passes through cleanly on the typical step and only fires when one
 * specific buffer is misbehaving.
 *
 * Layered usage: callers should run AGC FIRST (per-buffer), then the
 * global L2 clip as a final safety net for catastrophic divergence.
 *
 * @param params  Parameter buffers (read-only) used for per-buffer norm.
 * @param grads   Gradient buffers — mutated in place.
 * @param lambda  AGC clipping parameter. Brock used 0.01–0.16; we
 *                default to 0.1 in workerCore which lets most healthy
 *                buffers pass while throttling outliers.
 * @param epsParam Min effective param-norm denominator (Brock: 1e-3).
 *                 Prevents AGC from giving zero-init / very-small-norm
 *                 buffers a vanishingly tight threshold.
 * @param epsGrad  Min effective grad-norm denominator. Prevents
 *                 division by ~0 when the buffer has no gradient yet.
 * @returns       `numClipped`: count of buffers where AGC fired.
 *                `minScale`: smallest scale factor applied across all
 *                buffers (1.0 if nothing was clipped). Useful to track
 *                the worst-buffer compression in healthz.
 */
export function adaptiveClipGradientsInPlace(
  params: ReadonlyArray<Float32Array>,
  grads: Float32Array[],
  lambda: number,
  epsParam = 1e-3,
  epsGrad = 1e-6,
  skipIndices?: ReadonlySet<number>,
): { numClipped: number; minScale: number } {
  // S4 (review #343): reject negative / NaN / Infinity lambda. A
  // negative lambda flips gradient signs (threshold < 0 < gNorm so
  // every buffer gets a NEGATIVE-valued scale) — corrupts training
  // with no log. Cheap one-branch validation outside the hot loop.
  if (!Number.isFinite(lambda)) {
    throw new Error(`adaptiveClipGradientsInPlace: lambda must be finite (got ${lambda})`);
  }
  if (lambda < 0) {
    throw new Error(`adaptiveClipGradientsInPlace: lambda must be >= 0 (got ${lambda})`);
  }
  // S5 (review #343): lambda === 0 is a documented no-op contract.
  // Caller may guard `if (agcLambda > 0)` for hot-path skipping;
  // this branch handles direct calls in tests / future callers.
  if (lambda === 0) {
    return { numClipped: 0, minScale: 1 };
  }
  if (params.length !== grads.length) {
    throw new Error(
      `adaptiveClipGradientsInPlace: params.length ${params.length} != grads.length ${grads.length}`,
    );
  }
  let numClipped = 0;
  let minScale = 1;
  for (let i = 0; i < grads.length; i++) {
    // B2 fix (review #343): exempt biases / Brock's "final classifier
    // layer" pattern. Caller passes the index set; AGC skips them.
    if (skipIndices?.has(i)) continue;
    const p = params[i];
    const g = grads[i];
    if (p.length !== g.length) {
      throw new Error(
        `adaptiveClipGradientsInPlace: buffer ${i} param/grad length mismatch (${p.length} vs ${g.length})`,
      );
    }
    let pSq = 0;
    let gSq = 0;
    for (let k = 0; k < p.length; k++) {
      pSq += p[k] * p[k];
      gSq += g[k] * g[k];
    }
    const pNorm = Math.max(Math.sqrt(pSq), epsParam);
    const gNorm = Math.max(Math.sqrt(gSq), epsGrad);
    const threshold = lambda * pNorm;
    if (gNorm > threshold) {
      const scale = threshold / gNorm;
      for (let k = 0; k < g.length; k++) g[k] *= scale;
      numClipped += 1;
      if (scale < minScale) minScale = scale;
    }
  }
  return { numClipped, minScale };
}

/** True iff every value in the buffer is finite. */
export function checkFinite(arr: Float32Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Iterate over every Float32Array of weights/biases in a network.
 * Stable order:
 *   trunk[0].W, trunk[0].b, trunk[1].W, trunk[1].b,
 *   priceClassHead.W, priceClassHead.b,
 *   filmGen.W, filmGen.b,
 *   logPriceHead.W, logPriceHead.b,              (Phase 3b)
 *   pairLogitHead.W, pairLogitHead.b,            (Phase 3b)
 *   squashedRegressionHead.W, squashedRegressionHead.b, (Phase 3b)
 *   pinballQ40Head.W, pinballQ40Head.b           (Phase 3d.2)
 *
 * v2 (Phase 3d.2): priceMatchPair (4 buffers) and budgetSelect (4
 * buffers) are gone with the modes. pinballQ40Head appends 2 buffers
 * at the tail. The headTopologyVersion bump triggers archHash mismatch
 * so pre-3d.2 snapshots auto-archive on next start.
 */
export function* iterParamBuffers(net: Network): IterableIterator<Float32Array> {
  yield net.trunk[0].W;
  yield net.trunk[0].b;
  yield net.trunk[1].W;
  yield net.trunk[1].b;
  yield net.priceClassHead.W;
  yield net.priceClassHead.b;
  yield net.filmGen.W;
  yield net.filmGen.b;
  yield net.logPriceHead.W;
  yield net.logPriceHead.b;
  yield net.pairLogitHead.W;
  yield net.pairLogitHead.b;
  yield net.squashedRegressionHead.W;
  yield net.squashedRegressionHead.b;
  yield net.pinballQ40Head.W;
  yield net.pinballQ40Head.b;
}

/** Total parameter count — for tests + heartbeat. */
export function paramCount(net: Network): number {
  let n = 0;
  for (const buf of iterParamBuffers(net)) n += buf.length;
  return n;
}

/**
 * Concatenate every parameter buffer in iter order into a single
 * Float32Array. Used by the persistence layer.
 */
export function flattenParams(net: Network): Float32Array {
  const total = paramCount(net);
  const out = new Float32Array(total);
  let off = 0;
  for (const buf of iterParamBuffers(net)) {
    out.set(buf, off);
    off += buf.length;
  }
  return out;
}

/**
 * Inverse of {@link flattenParams}: copy a flat buffer back into the
 * network's param buffers in iter order. Validates total length.
 */
export function loadFlatParams(net: Network, flat: Float32Array): void {
  const total = paramCount(net);
  if (flat.length !== total) {
    throw new Error(`loadFlatParams: expected ${total} floats, got ${flat.length}`);
  }
  let off = 0;
  for (const buf of iterParamBuffers(net)) {
    buf.set(flat.subarray(off, off + buf.length));
    off += buf.length;
  }
}

/** Re-export commonly-used dims. */
export { COND_DIM, FEATURE_DIM, EMBEDDING_DIM, TRUNK_HIDDEN_DIM, NUM_GAME_MODES };

/* ---------------------------------------------------------------- *
 * Phase 3b — specialised heads                                     *
 * ---------------------------------------------------------------- */

/** Lower bound on log σ² emitted by {@link forwardLogPrice}. */
export const LOG_PRICE_LOG_VAR_MIN = -4;
/** Upper bound on log σ² emitted by {@link forwardLogPrice}. */
export const LOG_PRICE_LOG_VAR_MAX = 4;
/**
 * Clamp range for `μ` in log-cents space. Real product prices live
 * in `[1, 10⁶]` cents → `log(actualCents) ∈ [0, ~14]`; setting the
 * clamp to ±50 keeps the head's output well outside the realistic
 * range while preventing a runaway weight from pushing
 * `(μ − target)² / σ²` to +Infinity inside `betaNLL`. Caller should
 * suppress backward when the clamp fired.
 */
export const LOG_PRICE_MU_MIN = -50;
export const LOG_PRICE_MU_MAX = 50;

/** Forward output of the log-price head. */
export interface LogPriceForward {
  /** Predicted mean of log(actualCents), clamped to `[LOG_PRICE_MU_MIN, MAX]`. */
  mu: number;
  /** Predicted log σ², clamped to `[LOG_PRICE_LOG_VAR_MIN, MAX]`. */
  logVar: number;
  /** Whether the clamp was hit on μ (caller may suppress its grad). */
  muClamped: boolean;
  /** Whether the clamp was hit on log σ² (caller may suppress its grad). */
  logVarClamped: boolean;
  /** Pre-clamp raw output[1] — needed by backward to detect saturation. */
  rawLogVar: number;
}

/**
 * Forward through the log-price head.
 *
 * The head reads the trunk embedding (`emb`, length `embeddingDim`)
 * and emits a Gaussian over `log(actualCents)`. `μ` is the linear
 * output verbatim; `log σ²` is clamped to a finite window so the
 * variance is positive AND the BetaNLL gradient stays bounded
 * regardless of how far the head's raw output drifts.
 *
 * @param head Layer of shape (embeddingDim → 2). Slot 0 = μ; slot 1 = log σ².
 * @param emb  Trunk embedding.
 */
export function forwardLogPrice(head: Layer, emb: Float32Array): LogPriceForward {
  if (head.outDim !== 2) {
    throw new Error(`forwardLogPrice: head.outDim ${head.outDim} != 2`);
  }
  if (emb.length !== head.inDim) {
    throw new Error(`forwardLogPrice: emb.length ${emb.length} != head.inDim ${head.inDim}`);
  }
  const out = forwardLinear(head, emb);
  let mu = out[0];
  const rawLogVar = out[1];
  let logVar = rawLogVar;
  let logVarClamped = false;
  let muClamped = false;
  if (logVar < LOG_PRICE_LOG_VAR_MIN) {
    logVar = LOG_PRICE_LOG_VAR_MIN;
    logVarClamped = true;
  } else if (logVar > LOG_PRICE_LOG_VAR_MAX) {
    logVar = LOG_PRICE_LOG_VAR_MAX;
    logVarClamped = true;
  }
  if (mu < LOG_PRICE_MU_MIN) {
    mu = LOG_PRICE_MU_MIN;
    muClamped = true;
  } else if (mu > LOG_PRICE_MU_MAX) {
    mu = LOG_PRICE_MU_MAX;
    muClamped = true;
  }
  return { mu, logVar, muClamped, logVarClamped, rawLogVar };
}

/**
 * Backward through the log-price head.
 *
 * Given upstream gradients `dMu` and `dLogVar` (the latter w.r.t. the
 * pre-clamp raw output — clamping zeros the gradient through the
 * saturated end), compute weight gradients and the embedding-side
 * gradient that flows into the trunk.
 *
 * Note: when `logVarClamped` was true on forward, the chain rule
 * through the clamp says `dLogVar` is zero on the saturated side.
 * Callers can pass `dLogVar = 0` directly; this function honours
 * whatever they pass without re-checking clamp state, so callers who
 * want to apply the saturated-side gradient anyway (e.g. for soft
 * regularisation) retain control.
 *
 * @param head      Layer used in forward.
 * @param emb       Embedding that was passed to forward.
 * @param dMu       dL / dμ.
 * @param dLogVar   dL / d(rawLogVar).
 * @returns         dW, db, dEmb.
 */
export function backwardLogPrice(
  head: Layer,
  emb: Float32Array,
  dMu: number,
  dLogVar: number,
): { dW: Float32Array; db: Float32Array; dEmb: Float32Array } {
  const dy = new Float32Array(2);
  dy[0] = dMu;
  dy[1] = dLogVar;
  const bw = backwardLinear(head, emb, dy);
  return { dW: bw.dW, db: bw.db, dEmb: bw.dx };
}

/**
 * Forward through the pair-logit head.
 *
 * Reads two trunk embeddings + 3 stop-gradient scalar features and
 * emits a scalar logit such that `sigmoid(logit) = P(A is "higher" /
 * "correct")`. The order [emb_A; emb_B; scalars] is contractual, so
 * callers must always pass A first / B second to keep the decision
 * rule consistent.
 *
 * Phase 3e.2: layout of the concat:
 *   [0 .. D)         emb_A
 *   [D .. 2·D)       emb_B
 *   [2·D]            log(priceA / 1000) — normalised log-cents (A)
 *   [2·D + 1]        log(priceB / 1000) — same for B
 *   [2·D + 2]        log(priceA / priceB) — direct ratio anchor
 *
 * The scalars are inputs the head learns weights for; no gradient
 * flows back through them into priceClassHead — see backwardPairLogit
 * (the dx slots for indices 2·D..2·D+2 are discarded).
 *
 * Caller (workerCore) is responsible for computing the scalars from
 * per-product priceClassHead argmax via {@link pairLogitScalarFeatures}.
 *
 * @param head           Layer of shape `(2·D + PAIR_LOGIT_SCALAR_FEATURES → 1)`.
 * @param embA           Trunk embedding for product A.
 * @param embB           Trunk embedding for product B.
 * @param scalarFeatures Length-3: `[logA_norm, logB_norm, logRatio]`.
 * @returns Scalar logit and the concatenated input that backward needs.
 */
export function forwardPairLogit(
  head: Layer,
  embA: Float32Array,
  embB: Float32Array,
  scalarFeatures: ReadonlyArray<number>,
): { logit: number; concat: Float32Array } {
  if (head.outDim !== 1) {
    throw new Error(`forwardPairLogit: head.outDim ${head.outDim} != 1`);
  }
  const D = embA.length;
  if (embB.length !== D) {
    throw new Error(`forwardPairLogit: embB.length ${embB.length} != embA.length ${D}`);
  }
  if (scalarFeatures.length !== PAIR_LOGIT_SCALAR_FEATURES) {
    throw new Error(
      `forwardPairLogit: scalarFeatures.length ${scalarFeatures.length} != ${PAIR_LOGIT_SCALAR_FEATURES}`,
    );
  }
  if (head.inDim !== 2 * D + PAIR_LOGIT_SCALAR_FEATURES) {
    throw new Error(
      `forwardPairLogit: head.inDim ${head.inDim} != ${2 * D + PAIR_LOGIT_SCALAR_FEATURES} (= 2·embeddingDim + ${PAIR_LOGIT_SCALAR_FEATURES})`,
    );
  }
  const concat = new Float32Array(2 * D + PAIR_LOGIT_SCALAR_FEATURES);
  concat.set(embA, 0);
  concat.set(embB, D);
  for (let i = 0; i < PAIR_LOGIT_SCALAR_FEATURES; i++) {
    concat[2 * D + i] = scalarFeatures[i];
  }
  const out = forwardLinear(head, concat);
  return { logit: out[0], concat };
}

/**
 * Phase 3e.2 helper — derive the 3 stop-gradient scalar features
 * from per-product priceClass argmax (in cents).
 *
 * Normalisation:
 *   logA, logB: log(price / 1000)  → ~[-3, +3] for prices $0.50–$20k
 *   logRatio:  log(priceA / priceB) — un-normalised; values bounded by
 *              the catalog range so |log(ratio)| ≤ ~5 in practice.
 *
 * Both inputs floor at 1¢ to keep `Math.log` finite. Non-finite or
 * non-positive inputs default to 0 — matching the head's expected
 * "no-signal" condition (the scalar contributes no logit shift).
 */
export function pairLogitScalarFeatures(
  priceA_cents: number,
  priceB_cents: number,
): [number, number, number] {
  const a = Number.isFinite(priceA_cents) && priceA_cents > 0 ? priceA_cents : 1;
  const b = Number.isFinite(priceB_cents) && priceB_cents > 0 ? priceB_cents : 1;
  const logA = Math.log(a / 1000);
  const logB = Math.log(b / 1000);
  const logRatio = Math.log(a / b);
  return [logA, logB, logRatio];
}

/**
 * Backward through the pair-logit head.
 *
 * Splits the concat-input gradient back into per-embedding gradients
 * so each trunk forward pass receives its share. The trunk is run
 * twice in the predict path — backward must accumulate dEmbA and
 * dEmbB into the same trunk weight buffers (caller's responsibility).
 *
 * @param head    Layer used in forward.
 * @param concat  Concatenated `[emb_A; emb_B]` from forward.
 * @param dLogit  dL / dlogit. For sigmoid-BCE this is `sigmoid(logit) − target`.
 * @returns       dW, db, dEmbA, dEmbB.
 */
export function backwardPairLogit(
  head: Layer,
  concat: Float32Array,
  dLogit: number,
): { dW: Float32Array; db: Float32Array; dEmbA: Float32Array; dEmbB: Float32Array } {
  // Phase 3e.2: concat layout is `[embA; embB; 3 scalars]` so D
  // derives from the head's input shape, not concat.length / 2.
  const D = (concat.length - PAIR_LOGIT_SCALAR_FEATURES) / 2;
  const dy = new Float32Array(1);
  dy[0] = dLogit;
  const bw = backwardLinear(head, concat, dy);
  const dEmbA = new Float32Array(D);
  const dEmbB = new Float32Array(D);
  dEmbA.set(bw.dx.subarray(0, D));
  dEmbB.set(bw.dx.subarray(D, 2 * D));
  // bw.dx[2·D .. 2·D + PAIR_LOGIT_SCALAR_FEATURES] are the gradients
  // w.r.t. the scalar inputs — discarded by design (stop-gradient).
  // The pair head learns weights for the scalars (via dW) without
  // tugging priceClassHead via the inputs.
  return { dW: bw.dW, db: bw.db, dEmbA, dEmbB };
}

/**
 * Forward output of the squashed-regression head.
 *
 * `raw` is the linear output, retained so backward can compute the
 * tanh derivative without re-running forward. `predictedCents` is
 * the squashed value clamped to `[min, max]` when bounds are
 * supplied, or `exp(raw) * 100` clamped to `[1, 1_000_000]` cents
 * when no bounds are present (degenerate fallback for modes that
 * accidentally route here without a range).
 */
export interface SquashedRegressionForward {
  /** Linear output (un-squashed). */
  raw: number;
  /** Squashed cents prediction — feasible by construction with bounds. */
  predictedCents: number;
  /** Whether bounds were applied (vs the no-bounds exp fallback). */
  bounded: boolean;
}

/**
 * Forward through the squashed-regression head.
 *
 *   raw = Linear(emb)
 *   if bounds present:
 *     predicted_cents = min + (max − min) · (tanh(raw) + 1) / 2
 *   else:
 *     predicted_cents = clamp(exp(raw) · 100, 1, 1_000_000)
 *
 * The squashed branch is the primary path — every Phase 3b mode
 * that routes here ships its priceRangeCents (classic, closest)
 * or maxPriceCapCents (riser, encoded as `{min: 0, max: cap}`).
 *
 * @param head   Layer of shape (embeddingDim → 1).
 * @param emb    Trunk embedding.
 * @param bounds Optional `{min, max}` in cents. When absent the
 *               head falls back to the exp path; gradient is still
 *               well-defined but the dimensional units are off
 *               (log-cents vs cents) so callers should reserve the
 *               unbounded path for outright defensive use.
 */
export function forwardSquashedReg(
  head: Layer,
  emb: Float32Array,
  bounds?: { readonly min: number; readonly max: number },
): SquashedRegressionForward {
  if (head.outDim !== 1) {
    throw new Error(`forwardSquashedReg: head.outDim ${head.outDim} != 1`);
  }
  const out = forwardLinear(head, emb);
  const raw = out[0];
  if (bounds && bounds.max > bounds.min && bounds.max > 0) {
    const t = Math.tanh(raw);
    const predictedCents = bounds.min + (bounds.max - bounds.min) * (t + 1) / 2;
    return { raw, predictedCents, bounded: true };
  }
  // No bounds — exp fallback. Clamp to a sane cents range so
  // downstream code never sees Infinity / 0 cents.
  const predictedCents = Math.max(1, Math.min(1_000_000, Math.exp(raw) * 100));
  return { raw, predictedCents, bounded: false };
}

/**
 * Backward through the squashed-regression head.
 *
 * Caller computes `dL / d predictedCents` (e.g. Huber gradient on
 * `(predicted_cents − actualCents) / 100`, scaled back to the
 * cents space) and passes it in. We chain through the squash
 * derivative to get `dL / d raw`, then through the linear backward
 * to weight + embedding gradients.
 *
 *   d(predictedCents) / d(raw) = (max − min) / 2 · (1 − tanh²(raw))     bounded
 *                              = exp(raw) · 100                          unbounded
 *
 * @param head             Layer used in forward.
 * @param emb              Embedding that was passed to forward.
 * @param raw              `forward.raw` (linear output).
 * @param dPredictedCents  Upstream gradient w.r.t. predictedCents.
 * @param bounds           Same bounds passed to forward (or absent).
 * @returns                dW, db, dEmb.
 */
/**
 * DeepSets aggregator: sum-pool and elementwise-max-pool over a
 * collection of embedding vectors.
 *
 * @param embs Array of length-D embeddings (all same length).
 * @returns    `{ sumPool, maxPool, maxArgIdx }` — `sumPool[d] = Σ_i emb_i[d]`
 *             (NB: not mean-pool — gradient is identical across all
 *             entries, simpler to chain), `maxPool[d] = max_i emb_i[d]`,
 *             `maxArgIdx[d] = argmax_i emb_i[d]` (used by backward to
 *             route the max-pool gradient).
 */
/**
 * Phase 3d.2: forward through the pinballQ40 head — Linear(emb → 1).
 * Output is the predicted q40 quantile of `log(actualCents/heuristic)`
 * for the bidding mode. Trained under pinball loss (see
 * `losses.ts:pinballLoss`); the bidding decoder converts the output
 * to a safe-bid centerpoint via `heuristic · exp(q40)`.
 *
 * @param head pinballQ40Head Layer.
 * @param emb  Trunk embedding (post-FiLM).
 * @returns    Scalar q40 prediction.
 */
export function forwardPinballQ40(head: Layer, emb: Float32Array): number {
  const out = forwardLinear(head, emb);
  return out[0];
}

/**
 * Phase 3d.2: backward through the pinballQ40 head. Given
 * `dL/dq40`, returns weight gradients and the embedding-side
 * gradient. Caller is responsible for the chain-rule on the loss
 * itself (pinball: `dL/dq = (target < q ? -tau : 1 - tau)`).
 *
 * @param head   pinballQ40Head used in forward.
 * @param emb    Trunk embedding seen at forward.
 * @param dQ40   `dL/dq40`.
 * @returns      dW, db, and dEmb.
 */
export function backwardPinballQ40(
  head: Layer,
  emb: Float32Array,
  dQ40: number,
): { dW: Float32Array; db: Float32Array; dEmb: Float32Array } {
  const dy = new Float32Array(1);
  dy[0] = Number.isFinite(dQ40) ? dQ40 : 0;
  const bw = backwardLinear(head, emb, dy);
  return { dW: bw.dW, db: bw.db, dEmb: bw.dx };
}

export function backwardSquashedReg(
  head: Layer,
  emb: Float32Array,
  raw: number,
  dPredictedCents: number,
  bounds?: { readonly min: number; readonly max: number },
): { dW: Float32Array; db: Float32Array; dEmb: Float32Array } {
  let dRaw: number;
  // Defensive: a non-finite `raw` (from a NaN propagation that the
  // round-level rollback gate hasn't caught yet) would make `dRaw`
  // NaN below and poison the optimizer. Fail closed.
  if (!Number.isFinite(raw)) {
    dRaw = 0;
  } else if (bounds && bounds.max > bounds.min && bounds.max > 0) {
    const t = Math.tanh(raw);
    dRaw = dPredictedCents * (bounds.max - bounds.min) / 2 * (1 - t * t);
  } else {
    // d(exp(raw) · 100) / d(raw) = 100 · exp(raw). Skipped when the
    // forward clamped — gradient through a saturated clamp is 0.
    const e = Math.exp(raw);
    const cents = e * 100;
    if (cents <= 1 || cents >= 1_000_000) {
      dRaw = 0;
    } else {
      dRaw = dPredictedCents * 100 * e;
    }
  }
  const dy = new Float32Array(1);
  dy[0] = dRaw;
  const bw = backwardLinear(head, emb, dy);
  return { dW: bw.dW, db: bw.db, dEmb: bw.dx };
}

/**
 * Caller-owned scratch buffers for {@link forwardFilm} +
 * {@link backwardFilm}. The training hot path runs forward+backward
 * once per sample per minibatch step — at batch=64 stepsPerRound=6
 * that's ~384 calls per round. Without a scratch struct each call
 * allocates four `Float32Array(2·embeddingDim)` views, ~1.5KB/call,
 * ~0.5MB/round of GC churn. Allocating once and re-using fixes that
 * and aligns the FiLM block with the trunk's "gradient buffers
 * allocated by the caller" pattern documented at the top of this
 * file.
 *
 * Layout matches `forwardFilm`'s outDim convention: γ-driver in
 * `[0, D)` of `rawOutput`, β-driver in `[D, 2D)`. `gamma`, `beta`,
 * and `filmEmbedding` are length `D`; `rawOutput` is length `2D`.
 */
export interface FilmScratch {
  rawOutput: Float32Array;
  gamma: Float32Array;
  beta: Float32Array;
  filmEmbedding: Float32Array;
}

/**
 * Allocate a fresh {@link FilmScratch} sized for the network's FiLM
 * block. Call once per WorkerCore lifecycle and pass the same
 * instance into every {@link forwardFilm}/{@link backwardFilm}
 * call so the buffers are re-used across minibatch steps.
 *
 * @param embeddingDim Length of the trunk embedding vector
 *                     (matches filmGen.outDim / 2).
 */
export function createFilmScratch(embeddingDim: number): FilmScratch {
  return {
    rawOutput: new Float32Array(2 * embeddingDim),
    gamma: new Float32Array(embeddingDim),
    beta: new Float32Array(embeddingDim),
    filmEmbedding: new Float32Array(embeddingDim),
  };
}

/**
 * FiLM forward — bounded affine modulation of the trunk embedding.
 *
 *   raw      = filmGen.W · cond + filmGen.b              // 2D-vector
 *   γ[i]     = 1 + 0.1 · scale · tanh(raw[i])            // i ∈ [0, D)
 *   β[i]     = 0.1 · scale · tanh(raw[D + i])
 *   film[i]  = γ[i] · embedding[i] + β[i]
 *
 * Bounds. With `scale = moodInfluence ∈ [0, 1]`:
 *   γ ∈ [1 − 0.1·scale, 1 + 0.1·scale] ⊆ [0.9, 1.1]
 *   β ∈ [−0.1·scale, 0.1·scale]        ⊆ [−0.1, 0.1]
 *
 * Identity at scale = 0: every multiplier collapses to 0 ⇒ γ = 1,
 * β = 0 ⇒ film = embedding exactly. The caller can use this to
 * skip the entire forward path when `moodInfluence === 0`.
 *
 * Caller-owned scratch. Pass an optional `scratch` to re-use
 * buffers across minibatch steps; when omitted, fresh
 * `Float32Array`s are allocated (kept for the predict path / tests
 * where allocation is cheap and explicit).
 *
 * The returned object aliases `scratch` when provided — DO NOT
 * mutate the returned arrays after the call, or the next forward
 * pass will read stale values. {@link backwardFilm} reads the
 * `rawOutput` and `gamma` it returns, so make sure the next
 * forward into the same scratch happens AFTER backward completes.
 *
 * @param filmGen   Layer of shape (condDim → 2·embeddingDim).
 * @param cond      Conditioning vector of length condDim.
 * @param embedding Trunk output of length embeddingDim.
 * @param scale     `moodInfluence` ∈ [0, 1]; out-of-range is the
 *                  caller's bug — we clamp defensively to [0, 1].
 * @param scratch   Optional caller-owned buffers. Sizes must match
 *                  `embedding.length` for `gamma`/`beta`/`filmEmbedding`
 *                  and `2·embedding.length` for `rawOutput`.
 * @returns         Modulated embedding plus the activations needed
 *                  by {@link backwardFilm}. Aliases `scratch` when
 *                  provided.
 */
export function forwardFilm(
  filmGen: Layer,
  cond: Float32Array,
  embedding: Float32Array,
  scale: number,
  scratch?: FilmScratch,
): {
  filmEmbedding: Float32Array;
  gamma: Float32Array;
  beta: Float32Array;
  rawOutput: Float32Array;
} {
  const D = embedding.length;
  if (filmGen.outDim !== 2 * D) {
    throw new Error(
      `forwardFilm: filmGen.outDim ${filmGen.outDim} != 2 * embeddingDim ${D}`,
    );
  }
  const s = Math.max(0, Math.min(1, scale));
  // forwardLinear allocates its own `out` buffer; copy into scratch
  // when provided so the caller-owned aliasing contract holds for
  // ALL four returned buffers (rawOutput included).
  const linOut = forwardLinear(filmGen, cond);
  const rawOutput = scratch ? scratch.rawOutput : new Float32Array(2 * D);
  if (scratch) rawOutput.set(linOut);
  const gamma = scratch ? scratch.gamma : new Float32Array(D);
  const beta = scratch ? scratch.beta : new Float32Array(D);
  const filmEmbedding = scratch ? scratch.filmEmbedding : new Float32Array(D);
  for (let i = 0; i < D; i++) {
    const r = scratch ? rawOutput[i] : linOut[i];
    const rb = scratch ? rawOutput[D + i] : linOut[D + i];
    gamma[i] = 1 + 0.1 * s * Math.tanh(r);
    beta[i] = 0.1 * s * Math.tanh(rb);
    filmEmbedding[i] = gamma[i] * embedding[i] + beta[i];
  }
  return { filmEmbedding, gamma, beta, rawOutput };
}

/**
 * FiLM backward — chain rule through the saved γ/β and
 * `forwardLinear`.
 *
 * Given the upstream gradient w.r.t. `filmEmbedding` and the
 * activations stashed by {@link forwardFilm}, compute:
 *   - dW, db for filmGen (to feed into Adam)
 *   - d/d(embedding) (to feed back through trunk[1])
 *
 * The cond vector is treated as a constant input — gradients do
 * NOT flow back into mood (mood is bot state, not a trainable
 * parameter), which is the right semantics: filmGen learns how
 * mood should warp the embedding, but mood itself isn't optimised.
 *
 * Tanh derivative without recomputing tanh. Forward saved γ and
 * β; from the inverse mapping `tanh(raw) = (γ − 1) / (0.1·s)` and
 * `tanh(raw_β) = β / (0.1·s)` we can compute `1 − tanh²` directly
 * from γ/β, avoiding two `Math.tanh` calls per dim. Caller MUST
 * NOT invoke `backwardFilm` at `scale = 0` — the inverse mapping
 * is undefined there, and the FiLM forward was identity anyway,
 * so backward is structurally a no-op (filmGen.dW = 0). The runner
 * already short-circuits when `moodActiveForSample === false`,
 * which subsumes `scale = 0`.
 *
 * @param filmGen        FiLM layer used in forward.
 * @param cond           Conditioning vector that was passed to forward.
 * @param embedding      Trunk embedding that was passed to forward.
 * @param gamma          γ vector from forward (consumed for the
 *                       chain-rule `1 − tanh²` term).
 * @param beta           β vector from forward (same).
 * @param dFilmEmbedding Upstream gradient w.r.t. `filmEmbedding`.
 * @param scale          `moodInfluence` from forward; MUST be > 0.
 * @returns              `{ dW, db, dEmbedding }` — `dW`, `db` for the
 *                       filmGen optimizer step; `dEmbedding` for the
 *                       trunk[1] backward.
 */
export function backwardFilm(
  filmGen: Layer,
  cond: Float32Array,
  embedding: Float32Array,
  gamma: Float32Array,
  beta: Float32Array,
  dFilmEmbedding: Float32Array,
  scale: number,
): { dW: Float32Array; db: Float32Array; dEmbedding: Float32Array } {
  const D = embedding.length;
  const s = Math.max(0, Math.min(1, scale));
  if (s === 0) {
    // Defensive — caller is supposed to skip backward at scale=0.
    // Return zeros so a misuse fails closed (no spurious gradient
    // contribution) instead of NaN-ing on the inverse mapping.
    return {
      dW: new Float32Array(filmGen.W.length),
      db: new Float32Array(filmGen.b.length),
      dEmbedding: new Float32Array(D),
    };
  }
  const dEmbedding = new Float32Array(D);
  // dRaw is the upstream-gradient-w.r.t.-`raw` we feed into the
  // linear backward. Layout matches `forwardLinear`'s outDim
  // ordering: γ-driver in [0, D), β-driver in [D, 2D).
  const dRaw = new Float32Array(2 * D);
  const inv = 1 / (0.1 * s); // safe: s > 0 above
  for (let i = 0; i < D; i++) {
    const dF = dFilmEmbedding[i];
    // d(film[i])/d(embedding[i]) = γ[i].
    dEmbedding[i] = gamma[i] * dF;
    // tanh(raw_γ[i])     = (γ[i] - 1) · inv,  inv = 1 / (0.1·s)
    // tanh(raw_β[i])     = β[i]      · inv
    // d(γ[i])/d(raw[i])   = 0.1·s · (1 − tanh²(raw_γ))
    // d(β[i])/d(raw[D+i]) = 0.1·s · (1 − tanh²(raw_β))
    const tγ = (gamma[i] - 1) * inv;
    const tβ = beta[i] * inv;
    dRaw[i] = embedding[i] * dF * 0.1 * s * (1 - tγ * tγ);
    dRaw[D + i] = dF * 0.1 * s * (1 - tβ * tβ);
  }
  // d(raw)/d(filmGen.W, .b) via the standard linear backward. The
  // returned `dx` (gradient w.r.t. cond) is intentionally discarded —
  // mood isn't a trainable parameter, so propagating gradient into
  // it would be a noop and pollutes any downstream stop_gradient
  // logic if we ever add one.
  const bw = backwardLinear(filmGen, cond, dRaw);
  return { dW: bw.dW, db: bw.db, dEmbedding };
}
