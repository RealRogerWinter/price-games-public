/**
 * Position-conditional bidding decoder — Phase 3d.2.
 *
 * Replaces the previous one-size-fits-all "μ − 0.4σ" pattern with a
 * Monte-Carlo simulation that uses:
 *   1. The trunk's (μ, σ) on log-residual from `squashedRegression`.
 *   2. The pinball-q40 head's calibrated lower-quantile as a safety
 *      floor.
 *   3. Per-opponent archetype posteriors (`OpponentTracker`) to
 *      simulate opponents who haven't bid yet this round.
 *   4. Discrete position-aware candidate injection — the loss never
 *      teaches "clip the highest plausible standing bid by 1¢" or
 *      "$1 gambit", so we put both in the candidate grid and let
 *      simulation rank them.
 *
 * The decoder is split out of `bidding.ts` so it's unit-testable in
 * isolation against synthetic μ/σ + opponent posteriors.
 */

import { estimatePriceCents } from "../heuristics/priceEstimator";
import type { Product } from "@price-game/shared";
import type { OpponentPosterior } from "./types";

/**
 * Sample-bid model mirrors the server's `sampleBotBid` shape but is
 * pure-deterministic given an RNG. Used by the decoder's simulator
 * to emulate opponents who'll bid AFTER the bot (their bid hasn't
 * been observed yet, but we know their posterior over archetype).
 */
export interface SimulatorOpponent {
  /**
   * Multiplicative log-mean (positive ⇒ overbids on average).
   * Posterior-weighted across the archetype mix.
   */
  bias: number;
  /** Log-σ — posterior-weighted, floored. */
  sigma: number;
  /**
   * Multiplicative log-shade applied for bidding mode (rational
   * margin below estimate). Mirrors `personality.shadeFactor`'s
   * usage in `sampleBotBid` — applied to the close-component σ.
   */
  shadeFactor?: number;
}

export interface BiddingDecoderInput {
  /**
   * NN-derived posterior over actualPriceCents — log-Gaussian
   * parameters on the residual `log(actualCents / heuristic)`. The
   * decoder reconstructs cents via `heuristic · exp(N(μ, σ²))`.
   */
  squashedRegression?: { mu: number; sigma: number };
  /**
   * NN pinball-q40 prediction on the same log-residual (when
   * available). Decoder uses `heuristic · exp(q40)` as a safety
   * floor: if the simulator argmax sits far above this, fall back.
   */
  pinballQ40LogResidual?: number;
  /** Heuristic centerpoint. Always available; baseline when NN is null. */
  heuristicCents: number;
  /** Bot's turn position, 0-indexed. */
  turnIdx: number;
  /** Total bidders in this round. */
  totalPlayers: number;
  /** Standing bids placed before us this round (cents). */
  previousBidsCents: ReadonlyArray<number>;
  /**
   * Posteriors for the opponents who'll bid AFTER us this round
   * (length = totalPlayers - turnIdx - 1). The decoder simulates
   * their bids when scoring candidates.
   */
  laterOpponents: ReadonlyArray<OpponentPosterior>;
  /** competitiveness ∈ [0, 1] from persona env. Default 0.7. */
  competitiveness?: number;
  /** Optional RNG for deterministic tests. */
  rng?: () => number;
  /** Number of price draws per candidate. Default 256. */
  numPriceDraws?: number;
  /** Number of opponent-bid simulations per draw. Default 16. */
  numOpponentSims?: number;
}

export interface BiddingDecoderResult {
  bidCents: number;
  /** Position branch chosen (telemetry). */
  position: "first" | "middle" | "last";
  /** Plain-text reason — surfaced via TTS. */
  rationale: string;
  /** All candidates considered, with their expected scores. */
  scoredCandidates: Array<{ bidCents: number; expectedScore: number; tag: string }>;
  /** Expected score of the chosen bid. */
  chosenExpectedScore: number;
}

/**
 * Phase 3d.2 simplified scoreBidding — used inside the simulator.
 * Identical contract to `scoreBidding` in `@price-game/shared` but
 * specialised for the bot-vs-3-NPC case. Returns the bot's score
 * given its bid + the other 3 simulated bids.
 *
 * Closest-without-going-over with rank-scaled scaling:
 *   - over actual → 0
 *   - else rank by bid (ties = same rank); rank-table 1000/700/400/200
 *   - scaled by `(1 - pctOff)^2.5`; exact match adds +500
 */
function simulateOurScore(ourBid: number, ourActual: number, otherBids: ReadonlyArray<number>): number {
  if (ourBid > ourActual) return 0;
  const SCORE_TABLE = [1000, 700, 400, 200];
  const PROXIMITY_K = 2.5;
  const validBids = [ourBid, ...otherBids.filter((b) => b <= ourActual)];
  validBids.sort((a, b) => b - a);
  // Rank: ties share the highest rank.
  let rank = 0;
  let foundRank = -1;
  for (let i = 0; i < validBids.length; i++) {
    if (i > 0 && validBids[i] !== validBids[i - 1]) rank = i;
    if (foundRank === -1 && validBids[i] === ourBid) foundRank = rank;
  }
  if (foundRank === -1) return 0; // shouldn't happen — guard
  const baseScore = foundRank < SCORE_TABLE.length
    ? SCORE_TABLE[foundRank]
    : SCORE_TABLE[SCORE_TABLE.length - 1];
  const isExact = ourBid === ourActual;
  const pctOff = isExact ? 0 : (ourActual - ourBid) / ourActual;
  const proximityFactor = isExact ? 1 : Math.pow(Math.max(0, 1 - Math.min(pctOff, 1)), PROXIMITY_K);
  const scaledBase = Math.round(baseScore * proximityFactor);
  return scaledBase + (isExact ? 500 : 0);
}

/** Box-Muller standard-normal sample via a uniform RNG. */
function sampleNormal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample a bid from a single later-opponent's posterior. Mirrors the
 * server's `sampleBotBid` skeleton (log-Gaussian + shade) but skips
 * snap/clip/gambit — those are quickplay-room phenomena that don't
 * happen for opponents bidding after us in `turnIdx < n - 1`.
 */
function simulateOpponentBid(
  opp: { bias: number; sigma: number },
  actualCents: number,
  rng: () => number,
): number {
  const eps = opp.bias + opp.sigma * sampleNormal(rng);
  const raw = actualCents * Math.exp(eps);
  // Shade: use a default multiplicative log-shade of 0.4·σ to mirror
  // the expected `shadeFactor=0.6` ⋅ σ (most archetypes' default).
  const shadeLog = 0.4 * opp.sigma;
  const shaded = raw * Math.exp(-shadeLog);
  return Math.max(1, Math.round(shaded));
}

/** Convert NN log-residual prediction to cents under the heuristic. */
function logResidualToCents(logRes: number, heuristic: number): number {
  if (!Number.isFinite(logRes)) return heuristic;
  const cents = Math.round(heuristic * Math.exp(logRes));
  return Math.max(1, cents);
}

/**
 * Build the candidate-bid grid for a given position. Each entry is
 * tagged so telemetry can surface which option won.
 */
function buildCandidates(input: BiddingDecoderInput): Array<{ bidCents: number; tag: string }> {
  const { heuristicCents, squashedRegression, pinballQ40LogResidual, turnIdx, totalPlayers, previousBidsCents } = input;
  const competitiveness = clamp(input.competitiveness ?? 0.7, 0, 1);
  const isFirst = turnIdx === 0;
  const isLast = turnIdx === totalPlayers - 1;

  // μ in cents (NN if present, heuristic otherwise).
  const muCents = squashedRegression
    ? logResidualToCents(squashedRegression.mu, heuristicCents)
    : heuristicCents;
  const sigmaLog = squashedRegression?.sigma ?? 0.25;
  // Quantile-via-log helper. For Gaussian on log: q_τ = exp(μ + Φ⁻¹(τ)·σ).
  const qLog = (tau: number) => Math.max(1, Math.round(heuristicCents * Math.exp(
    (squashedRegression?.mu ?? 0) + zForQuantile(tau) * sigmaLog,
  )));

  // pinballQ40 cents — robustness floor. Fall back to qLog(0.4)
  // when the head hasn't surfaced one.
  const q40Cents = pinballQ40LogResidual !== undefined
    ? logResidualToCents(pinballQ40LogResidual, heuristicCents)
    : qLog(0.4);

  // Plausible standing bid. Cap at the round's likely upper bound
  // (μ × 1.05) so a wild over-bidder doesn't anchor us into a
  // suicide clip.
  const plausibleCeiling = muCents * 1.05;
  const plausibleStanding = previousBidsCents
    .filter((b) => b > 0 && b <= plausibleCeiling)
    .sort((a, b) => b - a);
  const highestPlausible = plausibleStanding[0];

  const out: Array<{ bidCents: number; tag: string }> = [];

  if (isFirst) {
    // First bidder — no info; quantile-anchor low to leave room for
    // bracket-undercuts. competitiveness pulls the centerpoint up.
    const tauLow = 0.25 + 0.10 * competitiveness;   // 0.25 .. 0.35
    const tauMid = 0.35 + 0.10 * competitiveness;   // 0.35 .. 0.45
    const tauHi = 0.45 + 0.05 * competitiveness;    // 0.45 .. 0.50
    out.push({ bidCents: qLog(tauLow), tag: "first_q_low" });
    out.push({ bidCents: qLog(tauMid), tag: "first_q_mid" });
    out.push({ bidCents: qLog(tauHi), tag: "first_q_hi" });
  } else if (isLast) {
    // Last bidder — strict-dominance position. Inject discrete
    // candidates the loss won't teach.
    if (highestPlausible !== undefined) {
      out.push({ bidCents: Math.max(1, highestPlausible + 1), tag: "clip_plus_1" });
    }
    out.push({ bidCents: 1, tag: "gambit_dollar_one" });
    out.push({ bidCents: q40Cents, tag: "pinball_q40" });
    out.push({ bidCents: qLog(0.50), tag: "q50" });
    out.push({ bidCents: Math.max(1, Math.round(muCents * 0.95)), tag: "mu_x_0.95" });
  } else {
    // Middle bidder — no clip-dominance, but standing bids constrain
    // the safe range.
    out.push({ bidCents: q40Cents, tag: "pinball_q40" });
    out.push({ bidCents: qLog(0.40 + 0.05 * competitiveness), tag: "q_mid" });
    if (highestPlausible !== undefined && highestPlausible < muCents) {
      // Undercut the standing leader by 1¢ if it's plausibly safe.
      out.push({ bidCents: Math.max(1, highestPlausible - 1), tag: "undercut_minus_1" });
    }
    out.push({ bidCents: Math.max(1, Math.round(muCents * 0.92)), tag: "mu_x_0.92" });
  }

  // Dedup + clamp.
  const seen = new Set<number>();
  const dedup: Array<{ bidCents: number; tag: string }> = [];
  for (const c of out) {
    const b = Math.max(1, Math.round(c.bidCents));
    if (seen.has(b)) continue;
    seen.add(b);
    dedup.push({ bidCents: b, tag: c.tag });
  }
  return dedup;
}

/**
 * Standard-Normal Φ⁻¹ (probit). 5-term rational approximation —
 * accurate to ~5 decimal places, enough for our quantile picks.
 */
function zForQuantile(p: number): number {
  const pp = clamp(p, 1e-6, 1 - 1e-6);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (pp < pLow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pp <= pHigh) {
    q = pp - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - pp));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Score one candidate bid by Monte-Carlo: sample N price draws from
 * the price posterior, simulate the later opponents' bids per draw,
 * and average our score.
 */
function scoreCandidate(
  candidate: number,
  input: BiddingDecoderInput,
  rng: () => number,
): number {
  const numPrice = input.numPriceDraws ?? 256;
  const numOppSims = input.numOpponentSims ?? 16;
  const heuristic = input.heuristicCents;
  const muLog = input.squashedRegression?.mu ?? 0;
  const sigmaLog = input.squashedRegression?.sigma ?? 0.25;
  const previous = input.previousBidsCents;
  let total = 0;
  let count = 0;
  for (let p = 0; p < numPrice; p++) {
    const eps = muLog + sigmaLog * sampleNormal(rng);
    const actual = Math.max(1, Math.round(heuristic * Math.exp(eps)));
    if (input.laterOpponents.length === 0) {
      // No simulation needed — score against just the standing bids.
      total += simulateOurScore(candidate, actual, previous);
      count += 1;
      continue;
    }
    for (let s = 0; s < numOppSims; s++) {
      const oppBids: number[] = [...previous];
      for (const opp of input.laterOpponents) {
        const oppBid = simulateOpponentBid(
          { bias: opp.estimatedBias, sigma: Math.max(opp.estimatedSigma, 0.05) },
          actual,
          rng,
        );
        oppBids.push(oppBid);
      }
      total += simulateOurScore(candidate, actual, oppBids);
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * Pick the bid maximising expected MP rank-score.
 */
export function decideBid(input: BiddingDecoderInput): BiddingDecoderResult {
  const rng = input.rng ?? Math.random;
  const turnIdx = Math.max(0, Math.floor(input.turnIdx));
  const totalPlayers = Math.max(1, Math.floor(input.totalPlayers));
  const isFirst = turnIdx === 0;
  const isLast = turnIdx === totalPlayers - 1;
  const position: "first" | "middle" | "last" = isFirst ? "first" : isLast ? "last" : "middle";

  const candidates = buildCandidates(input);
  if (candidates.length === 0) {
    return {
      bidCents: Math.max(1, Math.round(input.heuristicCents * 0.85)),
      position,
      rationale: "Decoder fallback: no candidates available; bid heuristic × 0.85.",
      scoredCandidates: [],
      chosenExpectedScore: 0,
    };
  }
  const scoredCandidates = candidates.map((c) => ({
    bidCents: c.bidCents,
    expectedScore: scoreCandidate(c.bidCents, input, rng),
    tag: c.tag,
  }));
  scoredCandidates.sort((a, b) => b.expectedScore - a.expectedScore);
  let best = scoredCandidates[0];

  // Pinball-q40 safety floor. If the chosen bid is well above the
  // calibrated lower-quantile AND we're not last-bidder clipping,
  // snap down.
  if (
    !isLast
    && input.pinballQ40LogResidual !== undefined
    && Number.isFinite(input.pinballQ40LogResidual)
  ) {
    const q40Cents = logResidualToCents(input.pinballQ40LogResidual, input.heuristicCents);
    if (best.bidCents > q40Cents * 1.10) {
      // Either clamp to q40 or pick the closest scored candidate ≤ q40·1.10
      const safe = scoredCandidates.find((c) => c.bidCents <= q40Cents * 1.10);
      if (safe) best = safe;
    }
  }

  const rationale = describeRationale(position, best.tag, best.bidCents, input);
  return {
    bidCents: best.bidCents,
    position,
    rationale,
    scoredCandidates,
    chosenExpectedScore: best.expectedScore,
  };
}

function describeRationale(
  position: "first" | "middle" | "last",
  tag: string,
  bidCents: number,
  input: BiddingDecoderInput,
): string {
  const dollars = (bidCents / 100).toFixed(2);
  const mu = input.squashedRegression?.mu ?? 0;
  const muCents = logResidualToCents(mu, input.heuristicCents);
  const muDollars = (muCents / 100).toFixed(2);
  switch (tag) {
    case "first_q_low":
    case "first_q_mid":
    case "first_q_hi":
      return `First bidder — quantile bid $${dollars} (μ≈$${muDollars}) leaves room for bracket-undercuts.`;
    case "clip_plus_1":
      return `Last bidder — clip the highest plausible standing bid by 1¢ at $${dollars}.`;
    case "gambit_dollar_one":
      return `Last bidder — $1 gambit; everyone else looks over-bid.`;
    case "pinball_q40":
      return `Pinball-q40 safe-bid floor at $${dollars}.`;
    case "q50":
      return `q50 of price posterior at $${dollars}.`;
    case "q_mid":
      return `Mid-quantile bid $${dollars} (μ≈$${muDollars}).`;
    case "undercut_minus_1":
      return `Middle bidder — undercut standing leader by 1¢ at $${dollars}.`;
    case "mu_x_0.92":
      return `μ × 0.92 = $${dollars}.`;
    case "mu_x_0.95":
      return `μ × 0.95 = $${dollars}.`;
    default:
      return `${position} bidder — $${dollars}.`;
  }
}

/** For tests. */
export function defaultHeuristicCents(
  product: Pick<Product, "title" | "category" | "description">,
): number {
  return estimatePriceCents(product, { rng: Math.random, noise: 0 });
}

export const __biddingDecoderInternals = {
  buildCandidates,
  scoreCandidate,
  simulateOpponentBid,
  simulateOurScore,
  zForQuantile,
};
