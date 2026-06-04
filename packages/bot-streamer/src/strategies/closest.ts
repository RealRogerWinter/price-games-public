/**
 * Closest-without-going-over mode (also reused for single-player Bidding
 * War in production — the server scores it the same way for that case).
 *
 * Strategy: humans learn quickly that going over scores zero, so they
 * bid below their estimate. The bot mirrors that — when the NN spoke,
 * we use the τ=0.4 lower-quantile of its predictive posterior; without
 * the NN we fall back to estimate × 0.85 with the same nearby
 * variants for stylistic variety.
 */

import type { GuessData } from "@price-game/shared";
import type { ModeStrategy, StrategyCandidate, StrategyContext } from "./types";
import { centerCents, quantileBidCents } from "./nnHelpers";

const STRATEGY_NOISE = 0.07;
const TAU = 0.4;

function closestCandidates(
  round: Parameters<ModeStrategy["candidates"]>[0],
  ctx: StrategyContext = {},
): StrategyCandidate[] {
  if (!round.product) {
    throw new Error("closestStrategy: round missing product");
  }
  const center = centerCents(round.product, ctx, STRATEGY_NOISE);
  const primaryBid = quantileBidCents(round.product, ctx, TAU, 0.85);
  const variants: Array<{ cents: number; score: number; rationale: string }> = [
    { cents: primaryBid, score: 1.0, rationale: `μ − ${TAU}σ — safe-bid pattern (humans avoid going over).` },
    { cents: Math.max(1, Math.round(center * 0.78)), score: 0.7, rationale: "Estimate × 0.78 — extra-safe under-bid." },
    { cents: Math.max(1, Math.round(center * 0.92)), score: 0.7, rationale: "Estimate × 0.92 — confident bid, accepts more 'went over' risk." },
    { cents: Math.max(1, Math.round(center * 0.65)), score: 0.4, rationale: "Estimate × 0.65 — very cautious; protects against premium-token inflation." },
  ];
  return variants.map<StrategyCandidate>(({ cents, score, rationale }) => ({
    payload: { guessedPriceCents: cents } satisfies GuessData,
    score: ctx.exploration ? Math.max(0.05, score * 0.85) : score,
    rationale,
  }));
}

export const closestStrategy: ModeStrategy = {
  mode: "closest-without-going-over",
  candidates: closestCandidates,
};

/**
 * Single-player Bidding War — same scoring rules as `closest`, just a
 * different game-mode tag. The dedicated multiplayer-bidding strategy
 * (with turn-aware bid amount logic) lives in `bidding.ts`.
 */
export const singlePlayerBiddingStrategy: ModeStrategy = {
  mode: "bidding",
  candidates: closestCandidates,
};
