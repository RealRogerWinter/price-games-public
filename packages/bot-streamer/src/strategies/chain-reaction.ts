/**
 * Chain Reaction — pairwise more/less guesses across a product chain.
 * NN-aware via `ctx.nnPrediction.rankPredictions`.
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

export const chainReactionStrategy: ModeStrategy = {
  mode: "chain-reaction",
  candidates(round, ctx = {}) {
    const products = round.products ?? [];
    if (products.length < 2) {
      throw new Error("chainReactionStrategy: need at least 2 products");
    }
    const estimates = products.map((p) => itemCents(p, ctx));

    const guesses: ("more" | "less")[] = [];
    let mostUncertainIdx = -1;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let i = 1; i < estimates.length; i++) {
      const prev = estimates[i - 1];
      const curr = estimates[i];
      guesses.push(curr > prev ? "more" : "less");
      const gap = Math.abs(curr - prev) / Math.max(prev, 1);
      if (gap < smallestGap) {
        smallestGap = gap;
        mostUncertainIdx = i - 1;
      }
    }

    const flippedGuesses = [...guesses];
    if (mostUncertainIdx >= 0) {
      flippedGuesses[mostUncertainIdx] =
        flippedGuesses[mostUncertainIdx] === "more" ? "less" : "more";
    }

    const flipScore = ctx.exploration ? 0.75 : 0.55;
    return [
      {
        payload: { chainGuesses: guesses } satisfies GuessData,
        score: 1.0,
        rationale: "Pairwise more/less comparisons on per-item estimates.",
      },
      {
        payload: { chainGuesses: flippedGuesses } satisfies GuessData,
        score: flipScore,
        rationale: `Same chain, flipping the closest pair (link ${mostUncertainIdx + 1}) — mimics human wobble on tight calls.`,
      },
    ] satisfies StrategyCandidate[];
  },
};
