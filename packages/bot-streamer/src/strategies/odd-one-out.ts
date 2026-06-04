/**
 * Odd One Out — pick the product whose price tier differs from its
 * peers. NN-aware via `ctx.nnPrediction.rankPredictions`.
 */

import { estimatePriceCents } from "../heuristics/priceEstimator";
import type { GuessData } from "@price-game/shared";
import type { ModeStrategy, StrategyCandidate, StrategyContext } from "./types";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function meanAbsDeviation(values: number[], from: number): number {
  if (values.length === 0) return 1;
  const sum = values.reduce((acc, v) => acc + Math.abs(v - from), 0);
  return Math.max(1, sum / values.length);
}

function itemCents(
  product: { id: number; title: string; category: string; description?: string },
  ctx: StrategyContext,
): number {
  const ranked = ctx.nnPrediction?.rankPredictions?.find((r) => r.id === product.id);
  if (ranked) return ranked.predictedCents;
  return estimatePriceCents({ ...product, description: product.description ?? "" }, { rng: ctx.rng, noise: 0.04 });
}

export const oddOneOutStrategy: ModeStrategy = {
  mode: "odd-one-out",
  candidates(round, ctx = {}) {
    const products = round.products ?? [];
    if (products.length < 3) {
      throw new Error("oddOneOutStrategy: need at least 3 products");
    }
    const estimates = products.map((p) => ({
      id: p.id,
      title: p.title,
      cents: itemCents(p, ctx),
    }));
    const m = median(estimates.map((e) => e.cents));
    const mad = meanAbsDeviation(estimates.map((e) => e.cents), m);

    const ranked = estimates
      .map((e) => ({ ...e, z: Math.abs(e.cents - m) / mad }))
      .sort((a, b) => b.z - a.z);

    return ranked.map<StrategyCandidate>((entry, idx) => ({
      payload: { guessedProductId: entry.id } satisfies GuessData,
      score: ctx.exploration ? Math.max(0.05, 1 / (idx + 1) * 0.85) : 1 / (idx + 1),
      rationale: `${entry.title}: estimate ${(entry.cents / 100).toFixed(2)}, z=${entry.z.toFixed(2)} from median.`,
    }));
  },
};
