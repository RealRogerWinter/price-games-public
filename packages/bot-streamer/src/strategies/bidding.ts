/**
 * Multiplayer Bidding War strategy — Phase 3d.2 rewrite.
 *
 * Delegates to the position-conditional decoder (`biddingDecoder.ts`)
 * which uses NN squashedReg posterior + pinballQ40 floor + per-room
 * opponent posteriors (`OpponentTracker`) to simulate expected
 * rank-score over a small candidate-bid grid. Returns the argmax
 * bid plus a one-shaped fallback variant for the softmax sampler.
 *
 * For single-player Bidding War (no `ctx.turn`) the strategy
 * degrades to a closest-style safe-bid pattern via
 * `singlePlayerBiddingStrategy` in `closest.ts` — kept registered
 * separately so the runner can pick the right enactor.
 */

import type { GuessData, RoundStartPayload } from "@price-game/shared";
import { estimatePriceCents } from "../heuristics/priceEstimator";
import { decideBid } from "./biddingDecoder";
import type { ModeStrategy, StrategyCandidate, StrategyContext } from "./types";

function biddingCandidates(
  round: RoundStartPayload,
  ctx: StrategyContext = {},
): StrategyCandidate[] {
  if (!round.product) {
    throw new Error("biddingStrategy: round missing product");
  }
  const turn = ctx.turn;
  const heuristicCents = estimatePriceCents(round.product, { rng: ctx.rng, noise: 0 });
  // Single-player bidding has no turn payload — fall back to a flat
  // safe quantile and let the runner pick singlePlayerBiddingEnactor.
  if (!turn) {
    const fallback = Math.max(1, Math.round(heuristicCents * 0.85));
    return [{
      payload: { bidCents: fallback } satisfies GuessData,
      score: 1.0,
      rationale: "Single-player bidding — heuristic × 0.85 (no turn context).",
    }];
  }

  // Phase 3d.2 security hardening: clamp the server-supplied
  // turn-payload arrays before they fan out into the Monte-Carlo
  // decoder loops. A buggy / malicious server sending
  // `previousBids.length = 10000` would otherwise blow the inner
  // loop to ~200M iterations per bidding turn (security review
  // HIGH finding). Quick Play tops out at 4 bidders, so 8 is a
  // generous defence-in-depth ceiling.
  const MAX_BIDDERS = 8;
  const safeTurnIdx = Number.isFinite(turn.turnIndex) && turn.turnIndex >= 0
    ? Math.min(turn.turnIndex, MAX_BIDDERS - 1)
    : 0;
  const safeTotalPlayers = Number.isFinite(turn.totalPlayers) && turn.totalPlayers > 0
    ? Math.min(turn.totalPlayers, MAX_BIDDERS)
    : 1;
  const safePrevBids = turn.previousBids.slice(0, MAX_BIDDERS).map((b) => b.bidCents);
  const safeOpponentPosteriors = (ctx.opponentPosteriors ?? []).slice(0, MAX_BIDDERS);

  const decision = decideBid({
    squashedRegression: ctx.nnPrediction?.squashedRegression,
    pinballQ40LogResidual: ctx.nnPrediction?.pinballQ40LogResidual,
    heuristicCents,
    turnIdx: safeTurnIdx,
    totalPlayers: safeTotalPlayers,
    previousBidsCents: safePrevBids,
    laterOpponents: safeOpponentPosteriors,
    competitiveness: ctx.competitiveness,
    rng: ctx.rng,
  });

  const variants: StrategyCandidate[] = [
    {
      payload: { bidCents: decision.bidCents } satisfies GuessData,
      score: ctx.exploration ? 0.85 : 1.0,
      rationale: decision.rationale,
    },
  ];
  // Surface a "safer-by-8%" runner-up for the softmax sampler so
  // ε-greedy rounds occasionally explore a more conservative bid.
  // Skip this when the chosen bid is already a $1 gambit — there's
  // no "safer" version of $1.
  if (decision.bidCents > 1) {
    const safer = Math.max(1, Math.round(decision.bidCents * 0.92));
    if (safer !== decision.bidCents) {
      variants.push({
        payload: { bidCents: safer } satisfies GuessData,
        score: 0.55,
        rationale: "Safer-by-8% variant — extra protection against over-going.",
      });
    }
  }
  return variants;
}

export const biddingStrategy: ModeStrategy = {
  mode: "bidding",
  candidates(round, ctx) {
    return biddingCandidates(round, ctx);
  },
};

export { biddingCandidates };
