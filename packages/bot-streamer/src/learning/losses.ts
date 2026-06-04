/**
 * Differentiable loss primitives for the streamer-bot multi-task NN.
 *
 * Each function returns BOTH the scalar loss AND the gradient(s) so the
 * caller (worker.ts) doesn't need an autograd library. Gradients are
 * returned as plain numbers / Float32Arrays — no allocations beyond
 * what's structurally required.
 *
 * - {@link smoothL1}     — Huber loss for robust regression. Used
 *                          historically for the price head; kept here
 *                          for tests and potential future use.
 * - {@link betaNLL}      — Seitzer 2022 β-Negative-Log-Likelihood for a
 *                          gaussian (μ, σ²). β=0.5 down-weights highly
 *                          uncertain samples, mitigating the runaway
 *                          σ collapse that vanilla NLL exhibits.
 * - {@link softmaxCE}    — Standard softmax cross-entropy with
 *                          label smoothing.
 * - {@link sigmoidBCE}   — Binary cross-entropy for the pairwise head.
 *
 * All gradients have been derived analytically and cross-checked
 * numerically (see losses.test.ts).
 */

/**
 * Smooth-L1 (Huber) loss.
 *
 *   loss(r) = 0.5·r²/δ        if |r| < δ
 *           = |r| − 0.5·δ     otherwise
 *
 * @param pred   Prediction.
 * @param target Ground truth.
 * @param delta  Transition point. Defaults to 1.
 * @returns loss value and dLoss/dPred.
 */
export function smoothL1(pred: number, target: number, delta = 1): { loss: number; grad: number } {
  const r = pred - target;
  const ar = Math.abs(r);
  if (ar < delta) {
    return { loss: 0.5 * r * r / delta, grad: r / delta };
  }
  return { loss: ar - 0.5 * delta, grad: Math.sign(r) };
}

/**
 * β-NLL loss for a 1-d gaussian — Seitzer et al. 2022 ("On the Pitfalls
 * of Heteroscedastic Uncertainty Estimation with Probabilistic Neural
 * Networks").
 *
 * Plain NLL: L = 0.5·(log σ² + (μ − y)² / σ²).
 * β-NLL:    L = stop_grad((σ²)^β) · L_NLL_per_sample.
 *
 * Why stop_grad: differentiating through (σ²)^β introduces a self-
 * amplifying β·log σ² term in the σ-gradient, which produces a runaway
 * loop where bad fits inflate σ instead of improving μ, and σ then
 * collapses to 0 / explodes to ∞. Seitzer's whole point is that the
 * prefactor *re-weights gradients* without participating in autograd —
 * we mirror that by computing the gradient analytically as if the
 * prefactor were a constant. Production prior to 2026-05 omitted this
 * stop_grad and lost a 14-hour training run to a NaN storm at round
 * ~530.
 *
 * To keep the head's training stable we clamp `predLogSigma2` to
 * `[-4, 4]` upstream; here we trust the caller.
 *
 * Gradients (with stop_grad on (σ²)^β):
 *   dL/dμ      = (σ²)^β · (μ − y) / σ²
 *   dL/dlogσ² = (σ²)^β · ½·(1 − (μ − y)²/σ²)
 *
 * The reported `loss` value still includes the prefactor (so the
 * scalar's magnitude tracks Seitzer's β-NLL), but the gradients
 * propagated upstream are the stop_grad form.
 *
 * @param predMu        Predicted mean.
 * @param predLogSigma2 Predicted log σ² (clamped by caller).
 * @param target        Ground truth.
 * @param beta          Mixing coefficient (0=plain NLL, 1=mean-only).
 *                      The plan uses 0.5.
 */
export function betaNLL(
  predMu: number,
  predLogSigma2: number,
  target: number,
  beta: number,
): { loss: number; gradMu: number; gradLogSigma2: number } {
  const sigma2 = Math.exp(predLogSigma2);
  const r = predMu - target;
  const r2OverSigma2 = (r * r) / sigma2;
  const lossPerSample = 0.5 * (predLogSigma2 + r2OverSigma2);
  const betaPow = Math.pow(sigma2, beta);
  const loss = betaPow * lossPerSample;
  // Stop_grad on (σ²)^β: treat betaPow as a detached constant when
  // computing gradients, so neither chain-rule term is added back in.
  const gradMu = betaPow * (r / sigma2);
  const gradLogSigma2 = 0.5 * betaPow * (1 - r2OverSigma2);
  return { loss, gradMu, gradLogSigma2 };
}

/**
 * Softmax cross-entropy with label smoothing.
 *
 *   p = softmax(logits)
 *   smoothed[c] = (1 − ε) · 1[c=y] + ε / K
 *   L = −Σ_c smoothed[c] · log p[c]
 *   dL/dlogits[c] = p[c] − smoothed[c]
 *
 * @param logits        Float32Array of length K.
 * @param target        Class index (integer in [0, K)).
 * @param labelSmoothing ε in [0, 1). 0 = no smoothing.
 * @returns loss + dL/dlogits.
 */
export function softmaxCE(
  logits: Float32Array,
  target: number,
  labelSmoothing: number,
): { loss: number; grad: Float32Array } {
  const K = logits.length;
  let maxL = -Infinity;
  for (let i = 0; i < K; i++) if (logits[i] > maxL) maxL = logits[i];
  let z = 0;
  const exps = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const e = Math.exp(logits[i] - maxL);
    exps[i] = e;
    z += e;
  }
  const probs = new Float32Array(K);
  for (let i = 0; i < K; i++) probs[i] = exps[i] / z;

  const eps = labelSmoothing;
  const smoothedTarget = 1 - eps + eps / K;
  const smoothedOther = eps / K;

  let loss = 0;
  for (let i = 0; i < K; i++) {
    const t = i === target ? smoothedTarget : smoothedOther;
    loss -= t * Math.log(Math.max(probs[i], 1e-12));
  }
  const grad = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const t = i === target ? smoothedTarget : smoothedOther;
    grad[i] = probs[i] - t;
  }
  return { loss, grad };
}

/**
 * Softmax cross-entropy with **ordinal smoothing on a log-price grid**.
 *
 * Given a sorted catalog of canonical prices, missing the target index
 * by ±1 in the catalog is dramatically less wrong than missing by ±10
 * — but plain one-hot CE treats every wrong class identically. Ordinal
 * smoothing places probability mass on neighbouring classes weighted
 * by their log-price distance from the target, so the gradient
 * encourages "close-but-not-exact" predictions instead of
 * pathologically over-confident wrong ones.
 *
 *   smoothed[i] ∝ exp(-((logP[i] − logP[target]) / τ)²)
 *
 * τ controls the smoothing bandwidth — set to log(1.15) the band
 * covers prices within ~15% of the target as having meaningful mass,
 * which matches typical real-world price-prediction tolerances.
 *
 * Gradient is the standard softmax-CE form: `softmax(logits) − smoothed`.
 *
 * @param logits     Float32Array of length K (== catalog size).
 * @param target     Catalog index in [0, K).
 * @param logPrices  Pre-computed natural log of each catalog price.
 * @param tau        Smoothing bandwidth in log-cents. Must be > 0.
 * @returns loss + dL/dlogits + the smoothed label distribution.
 */
export function ordinalSmoothedCE(
  logits: Float32Array,
  target: number,
  logPrices: ReadonlyArray<number>,
  tau: number,
  opts?: {
    /**
     * Catalog prices in cents — index-aligned with `logits` and
     * `logPrices` (i.e. `this.priceCatalog.prices`). Required when
     * `priceRangeCents` is set. Renamed from a more generic name so
     * future callers don't accidentally pass a sliced or alternate
     * array; the contract is "the same catalog the head was trained
     * against."
     */
    catalogPrices?: ReadonlyArray<number>;
    /** When set, restrict the loss to in-range catalog classes. */
    priceRangeCents?: { readonly min: number; readonly max: number };
  },
): { loss: number; grad: Float32Array; smoothed: Float32Array } {
  const K = logits.length;
  if (K !== logPrices.length) {
    throw new Error(`ordinalSmoothedCE: logits.length=${K} != logPrices.length=${logPrices.length}`);
  }
  if (tau <= 0) {
    throw new Error(`ordinalSmoothedCE: tau must be > 0, got ${tau}`);
  }

  // Phase 2 train-time action mask. When the round had a visible
  // bound (slider min/max, riser cap), restrict the loss to the
  // catalog classes that fall in `[min, max]`. The smoothing kernel
  // is masked AFTER exp + before normalisation so probability mass
  // doesn't leak to invalid neighbours; the softmax probs are masked
  // post-softmax. Both reductions are equivalent to masking logits
  // to `-Infinity` upstream — the gradient `probs - smoothed` is
  // 0 on out-of-range classes (both terms zero) so the model never
  // spends gradient on classes the decoder will refuse anyway.
  // Defensive: if the target itself is out-of-range or no classes
  // are in range, fall through to unmasked (the bound is wrong; we
  // shouldn't degrade learning over a probably-buggy payload).
  const mask = new Uint8Array(K);
  let maskActive = false;
  if (opts?.priceRangeCents && opts?.catalogPrices) {
    if (opts.catalogPrices.length !== K) {
      throw new Error(
        `ordinalSmoothedCE: catalogPrices.length=${opts.catalogPrices.length} != logits.length=${K}`,
      );
    }
    const { min, max } = opts.priceRangeCents;
    let inRange = 0;
    for (let i = 0; i < K; i++) {
      const inRng = opts.catalogPrices[i] >= min && opts.catalogPrices[i] <= max ? 1 : 0;
      mask[i] = inRng;
      inRange += inRng;
    }
    maskActive = inRange >= 1 && mask[target] === 1;
  }

  // Build the smoothed target distribution. Numerically-stable
  // computation: subtract the max squared-z before exp.
  const targetLog = logPrices[target];
  const tauSq = tau * tau;
  const negZSq = new Float32Array(K);
  let maxNegZSq = -Infinity;
  for (let i = 0; i < K; i++) {
    const dz = logPrices[i] - targetLog;
    const v = -(dz * dz) / tauSq;
    negZSq[i] = v;
    if (v > maxNegZSq) maxNegZSq = v;
  }
  let zSum = 0;
  const smoothed = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const e = Math.exp(negZSq[i] - maxNegZSq);
    smoothed[i] = maskActive && !mask[i] ? 0 : e;
    zSum += smoothed[i];
  }
  if (zSum > 0) {
    for (let i = 0; i < K; i++) smoothed[i] /= zSum;
  } else {
    // Should be unreachable when maskActive is true (target was checked),
    // but guard anyway: collapse to a one-hot at target.
    smoothed.fill(0);
    smoothed[target] = 1;
  }

  // Softmax over logits + cross-entropy under the smoothed labels.
  let maxL = -Infinity;
  for (let i = 0; i < K; i++) if (logits[i] > maxL) maxL = logits[i];
  let logitZ = 0;
  const probs = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const e = Math.exp(logits[i] - maxL);
    probs[i] = e;
    logitZ += e;
  }
  for (let i = 0; i < K; i++) probs[i] /= logitZ;

  // Mask-and-renormalise the probs so out-of-range classes contribute
  // zero gradient. Keep the path identical when `maskActive=false` —
  // the unmasked behaviour is bit-identical to the pre-Phase-2 form.
  if (maskActive) {
    let pSum = 0;
    for (let i = 0; i < K; i++) {
      if (!mask[i]) probs[i] = 0;
      pSum += probs[i];
    }
    if (pSum > 0) {
      for (let i = 0; i < K; i++) probs[i] /= pSum;
    }
  }

  let loss = 0;
  const grad = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    loss -= smoothed[i] * Math.log(Math.max(probs[i], 1e-12));
    grad[i] = probs[i] - smoothed[i];
  }
  return { loss, grad, smoothed };
}

/** Numerically-stable softmax — exposed for visualisation. */
export function softmax(logits: Float32Array): Float32Array {
  let maxL = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > maxL) maxL = logits[i];
  let z = 0;
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - maxL);
    out[i] = e;
    z += e;
  }
  for (let i = 0; i < out.length; i++) out[i] /= z;
  return out;
}

/**
 * Sigmoid binary cross-entropy.
 *
 *   p = 1 / (1 + e^−x)
 *   L = −[y · log p + (1−y) · log(1−p)]
 *   dL/dx = p − y
 *
 * @param logit Pre-sigmoid score.
 * @param target 0 or 1.
 */
export function sigmoidBCE(logit: number, target: 0 | 1): { loss: number; grad: number } {
  // Numerically-stable formulation: log(1 + e^x) − target·x.
  const stable = Math.max(logit, 0) - logit * target + Math.log(1 + Math.exp(-Math.abs(logit)));
  const p = 1 / (1 + Math.exp(-logit));
  return { loss: stable, grad: p - target };
}

/**
 * Pairwise margin loss (Phase 3c).
 *
 *   L = max(0, margin − scoreCorrect + scoreIncorrect)
 *
 * Used by the price-match round-coherent training step to push the
 * (product, true-target) score above the (product, wrong-target)
 * score by at least `margin`. Zero gradient when the margin is
 * already satisfied — the head only learns from violations.
 *
 * Returns:
 *   - `loss`         the margin violation, or 0 when satisfied.
 *   - `dCorrect`     dL/dscoreCorrect    (−1 on violation, else 0).
 *   - `dIncorrect`   dL/dscoreIncorrect  (+1 on violation, else 0).
 *
 * @param scoreCorrect    Head score for the (product, true-target) pair.
 * @param scoreIncorrect  Head score for the (product, wrong-target) pair.
 * @param margin          Required score gap; typical 0.5.
 */
export function pairwiseMarginLoss(
  scoreCorrect: number,
  scoreIncorrect: number,
  margin: number,
): { loss: number; dCorrect: number; dIncorrect: number } {
  const violation = margin - scoreCorrect + scoreIncorrect;
  if (violation <= 0) return { loss: 0, dCorrect: 0, dIncorrect: 0 };
  return { loss: violation, dCorrect: -1, dIncorrect: 1 };
}

/**
 * Pinball / quantile-regression loss at quantile τ ∈ (0, 1).
 *
 *   L(pred, target) = max(τ · (target − pred), (1 − τ) · (pred − target))
 *
 * Equivalently `(target − pred) · τ` when target ≥ pred, else
 * `(pred − target) · (1 − τ)`. Minimizing this trains `pred` to track
 * the τ-quantile of the conditional distribution of target.
 *
 * τ = 0.4 (Phase 3d.2 default) gives a calibrated lower-quantile
 * "safe bid" — the model learns to under-predict by ~40% of the
 * cumulative residual mass, which is what closest-without-going-over
 * actually rewards (overbids score 0). Symmetric losses like β-NLL
 * give a symmetric posterior whose mean is biased above the optimal
 * bid.
 *
 * @param pred   Predicted quantile.
 * @param target Observed value.
 * @param tau    Quantile in (0, 1). Caller should clamp to a sane
 *               range; non-finite or out-of-range falls back to median
 *               (τ = 0.5) so the head still trains rather than NaN'ing.
 * @returns      `loss` and `grad = dL/dpred`.
 */
export function pinballLoss(
  pred: number,
  target: number,
  tau: number,
): { loss: number; grad: number } {
  if (!Number.isFinite(pred) || !Number.isFinite(target)) {
    return { loss: 0, grad: 0 };
  }
  const t = Number.isFinite(tau) && tau > 0 && tau < 1 ? tau : 0.5;
  const diff = target - pred;
  if (diff >= 0) {
    // Under-prediction: gradient pushes pred up at rate τ.
    return { loss: t * diff, grad: -t };
  }
  // Over-prediction: gradient pushes pred down at rate (1 - τ).
  return { loss: (t - 1) * diff, grad: 1 - t };
}
