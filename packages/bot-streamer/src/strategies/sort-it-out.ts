/**
 * Sort It Out — order products cheapest to priciest. NN-aware: uses
 * `ctx.nnPrediction.rankPredictions` when present; else heuristic.
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
  return estimatePriceCents({ ...product, description: product.description ?? "" }, { rng: ctx.rng, noise: 0.04 });
}

export const sortItOutStrategy: ModeStrategy = {
  mode: "sort-it-out",
  candidates(round, ctx = {}) {
    const products = round.products ?? [];
    if (products.length < 2) {
      throw new Error("sortItOutStrategy: need at least 2 products");
    }
    const rng = ctx.rng ?? Math.random;

    const ranked = products
      .map((p) => ({ id: p.id, estimate: itemCents(p, ctx) }))
      .sort((a, b) => a.estimate - b.estimate);

    const optimalOrder = ranked.map((r) => r.id);
    const swappedOrder = [...optimalOrder];
    if (swappedOrder.length >= 2) {
      const swapStart = Math.floor(rng() * (swappedOrder.length - 1));
      [swappedOrder[swapStart], swappedOrder[swapStart + 1]] = [
        swappedOrder[swapStart + 1],
        swappedOrder[swapStart],
      ];
    }

    const swapScore = ctx.exploration ? 0.7 : 0.5;
    return [
      {
        payload: { submittedOrder: optimalOrder } satisfies GuessData,
        score: 1.0,
        rationale: "Sorted ascending by estimated price.",
      },
      {
        payload: { submittedOrder: swappedOrder } satisfies GuessData,
        score: swapScore,
        rationale: "Sorted ascending with one adjacent swap — humans frequently miss a mid-pair.",
      },
    ] satisfies StrategyCandidate[];
  },
};
