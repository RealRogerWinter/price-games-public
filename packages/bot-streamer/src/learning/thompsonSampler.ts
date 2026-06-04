/**
 * Thompson sampling utilities for the streamer-bot.
 *
 * - {@link thompsonDraw}    — sample a candidate price from the predicted
 *                             posterior `N(μ, (k·σ)²)`. With `k=1.5` per
 *                             the plan, this widens the spread a bit
 *                             beyond the calibrated σ to encourage
 *                             exploration on uncertain rounds.
 *
 * - {@link adaptiveEpsilon} — compute the effective ε for the wider
 *                             exploration spread:
 *
 *      ε = clamp(0.05 + 0.4·sigmoid(σ_pred − σ_calibrated_median)
 *                + 0.15·(category_entropy > 3.0),
 *                floor, 0.5)
 *
 *   where `floor` decays linearly `0.1 → epsilonFloorEnd` over the
 *   first `epsilonDecayRounds` rounds.
 *
 * Both functions are pure — they take an injected RNG so tests and
 * the worker can be deterministic.
 */

/**
 * Draw a Thompson sample from a 1-d gaussian.
 *
 * @param mu       Predicted mean.
 * @param sigma    Predicted standard deviation.
 * @param k        Spread multiplier; default 1.5 per plan.
 * @param rng      U[0,1) RNG.
 */
export function thompsonDraw(
  mu: number,
  sigma: number,
  k: number,
  rng: () => number = Math.random,
): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + k * sigma * z;
}

export interface AdaptiveEpsilonInput {
  sigmaPred: number;
  sigmaCalibratedMedian: number;
  categoryEntropy: number;
  round: number;
  epsilonFloorStart: number;
  epsilonFloorEnd: number;
  epsilonDecayRounds: number;
  /** Hard ceiling. Defaults to 0.5. */
  epsilonCeiling?: number;
  /**
   * Optional per-mode exploration multiplier. Modes that already have
   * wide-spread strategies (closest, riser, budget-builder, single-
   * player bidding — all τ=0.4 quantile shift modes per the plan)
   * benefit less from epsilon exploration; halving their effective
   * ε keeps the bot from chasing exploration draws on rounds where
   * the strategy is already cautious. Defaults to 1.0.
   */
  modeMultiplier?: number;
}

/** Per-mode multiplier on the computed ε. Modes whose strategies
 * already use τ-quantile shifts get 0.5; others stay at 1.0.
 * Keys must match the canonical GameMode strings in shared/types.ts. */
export const MODE_EPSILON_MULTIPLIER: Record<string, number> = {
  "closest-without-going-over": 0.5,
  riser: 0.5,
  "budget-builder": 0.5,
  bidding: 0.5,
};

/**
 * Compute the effective ε for exploration. Pure function; output is
 * deterministic given the input fields.
 */
export function adaptiveEpsilon(input: AdaptiveEpsilonInput): number {
  const ceiling = input.epsilonCeiling ?? 0.5;
  const sigDiff = input.sigmaPred - input.sigmaCalibratedMedian;
  const sigmoid = 1 / (1 + Math.exp(-sigDiff));
  const entBonus = input.categoryEntropy > 3.0 ? 0.15 : 0;
  const raw = 0.05 + 0.4 * sigmoid + entBonus;
  // Floor anneals linearly from start → end over decayRounds.
  const decay = input.epsilonDecayRounds > 0
    ? Math.min(input.round / input.epsilonDecayRounds, 1)
    : 1;
  const floor = input.epsilonFloorStart + (input.epsilonFloorEnd - input.epsilonFloorStart) * decay;
  const clamped = Math.max(floor, Math.min(ceiling, raw));
  // Per-mode multiplier applies AFTER the floor — operators have
  // explicitly asked for the bot to keep some baseline exploration
  // even on quantile-shift modes, so we never push ε below 1/2 the
  // floor.
  const mult = input.modeMultiplier ?? 1.0;
  return Math.max(floor * 0.5, clamped * mult);
}

/** Helper for the strategy layer: τ-quantile shift μ − τ·σ. */
export function quantileShift(mu: number, sigma: number, tau: number): number {
  return mu - tau * sigma;
}
