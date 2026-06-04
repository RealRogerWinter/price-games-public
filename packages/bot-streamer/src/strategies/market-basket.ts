/**
 * Market Basket — sum per-item estimates and submit that as the guess.
 * NN-aware: uses `ctx.nnPrediction.rankPredictions` per item when
 * present; falls back to heuristic.
 */

import { estimatePriceCents } from "../heuristics/priceEstimator";
import type { GuessData } from "@price-game/shared";
import type { ModeStrategy, StrategyCandidate, StrategyContext } from "./types";

function itemCents(
  product: { id: number; title: string; category: string; description?: string },
  ctx: StrategyContext,
): number {
  const ranked = ctx.nnPrediction?.rankPredictions?.find((r) => r.id === product.id);
  if (ranked) return ranked.predictedCents;
  return estimatePriceCents({ ...product, description: product.description ?? "" }, { rng: ctx.rng, noise: 0.05 });
}

export const marketBasketStrategy: ModeStrategy = {
  mode: "market-basket",
  candidates(round, ctx = {}) {
    const products = round.products ?? [];
    if (products.length === 0) {
      throw new Error("marketBasketStrategy: round missing products");
    }
    let total = 0;
    for (const p of products) {
      total += itemCents(p, ctx);
    }

    const spread = ctx.exploration ? 1.4 : 1.0;
    const variants: Array<{ factor: number; score: number; rationale: string }> = [
      { factor: 1.0, score: 1.0, rationale: "Sum of per-item estimates." },
      { factor: 1 - 0.1 * spread, score: 0.6, rationale: "Sum × 0.9 — assumes the basket leans cheap." },
      { factor: 1 + 0.1 * spread, score: 0.6, rationale: "Sum × 1.1 — assumes the basket leans premium." },
    ];
    return variants.map<StrategyCandidate>(({ factor, score, rationale }) => ({
      payload: { guessedTotalCents: Math.max(1, Math.round(total * factor)) } satisfies GuessData,
      score,
      rationale,
    }));
  },
};
