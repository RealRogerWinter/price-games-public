/**
 * ModeStrategy contract — every game-mode handler implements this.
 *
 * Strategies produce *candidates*, not single answers, so the engine
 * (in a follow-up PR) can softmax-sample with a temperature corresponding
 * to the bot's configured skill level. Strategies are pure functions
 * over (round, ctx); they don't talk to the network or the DOM.
 */

import type { BiddingTurnPayload, GameMode, GuessData, RoundStartPayload } from "@price-game/shared";
import type { ScoredCandidate } from "../realism/softmax";
import type { PredictRes } from "../learning/types";

/**
 * Phase 3d.2: per-opponent online posterior over NPC archetype.
 * Updated by `OpponentTracker` from observed (bid, actual) pairs
 * across the rounds of one game; used by the bidding decoder's
 * Monte-Carlo simulation. `archetypeProbs` carries one entry per
 * known archetype (length === 6 — see biddingOpponents.ts).
 * `estimatedSigma` and `estimatedBias` are precision-weighted
 * means under the posterior with a floor (see OpponentTracker).
 */
export interface OpponentPosterior {
  playerId: string;
  archetypeProbs: ReadonlyArray<number>;
  estimatedSigma: number;
  estimatedBias: number;
}

/**
 * Per-mode context passed to a strategy. Lets strategies inject
 * deterministic RNG for tests and (in future) read recent history for
 * mode-specific anchoring.
 */
export interface StrategyContext {
  /** Optional RNG. Defaults to Math.random. */
  rng?: () => number;
  /**
   * Neural-net prediction for the primary product, when the learning
   * bridge is enabled and answered within the staleness budget. Null
   * means the bot must fall back to the heuristic estimate.
   */
  nnPrediction?: PredictRes | null;
  /**
   * Thompson draw in cents — when present, the strategy uses it as
   * the centerpoint instead of the NN's μ. Surfaced from the NN
   * prediction's `explorationDraw` field.
   */
  thompsonDraw?: number;
  /** True on ε-greedy rounds — widens the strategy's candidate spread. */
  exploration?: boolean;
  /**
   * Phase 3d.2: latest `BiddingTurnPayload` from the observer. Set
   * only on bidding rounds. The bidding strategy reads turnIdx,
   * totalPlayers, and previousBids from this to choose its
   * position-conditional decoder branch.
   */
  turn?: BiddingTurnPayload;
  /**
   * Phase 3d.2: per-opponent archetype posteriors built up across
   * the rounds of the current game (room-scoped). Indexed by
   * playerId; the bidding decoder consumes these when simulating
   * opponents who haven't bid yet this round.
   */
  opponentPosteriors?: ReadonlyArray<OpponentPosterior>;
  /**
   * Phase 3d.2: competitiveness ∈ [0, 1] — separate from
   * persona.moodInfluence. Higher → more aggressive (lower-quantile
   * bid, more frequent clip plays, smaller σ-floor on opponent
   * simulator). 0.7 is the production default.
   */
  competitiveness?: number;
}

export type StrategyCandidate = ScoredCandidate<GuessData> & {
  /** Plain-text reason — surfaced via TTS when viewers hit !hint. */
  rationale: string;
};

export interface ModeStrategy {
  readonly mode: GameMode;
  /**
   * Return ranked candidates for this round. The first element should
   * be the strategy's best-guess; the engine may pick a lower-ranked
   * candidate when the bot's skill temperature is high.
   *
   * @param round Server-emitted round_start payload.
   * @param ctx See {@link StrategyContext}.
   * @returns Non-empty array of candidates.
   * @throws If the round payload is missing fields the strategy needs
   *         (e.g. classic without a product). Callers should fall back
   *         to a timeout-default rather than crash the lifecycle.
   */
  candidates(round: RoundStartPayload, ctx?: StrategyContext): StrategyCandidate[];
}
