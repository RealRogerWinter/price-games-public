/**
 * Comparison mode — two products are shown; the bot picks "more" or
 * "less" expensive depending on `round.question`. Strategy: when the
 * NN's pair head answered, use the sigmoid logit directly; otherwise
 * estimate each product's price (NN if available, else heuristic) and
 * pick the higher (or lower) accordingly.
 */

import type { ModeStrategy, StrategyCandidate } from "./types";
import { centerCents } from "./nnHelpers";

export const comparisonStrategy: ModeStrategy = {
  mode: "comparison",
  candidates(round, ctx = {}) {
    const products = round.products ?? [];
    if (products.length < 2) {
      throw new Error("comparisonStrategy: round missing products");
    }
    const wantsMostExpensive = round.question !== "least-expensive";
    // Phase 3b: when the NN's pair head answered, prefer it over the
    // per-product priceClassHead estimates — the head consumes both
    // embeddings jointly and was specifically trained for binary
    // comparison decisions, so its signal is more direct than running
    // each product's price prediction separately and comparing them.
    // Round payload guarantees `pairProducts[0]` corresponds to the
    // first element of `round.products`, so `pairAIsCorrectProb` is
    // `P(products[0] is higher / more expensive)`.
    const pHigh = ctx.nnPrediction?.pairAIsCorrectProb;
    if (
      products.length === 2 &&
      pHigh !== undefined &&
      Number.isFinite(pHigh)
    ) {
      // Fold the question's direction in: "least-expensive" inverts.
      const probFirstIsAnswer = wantsMostExpensive ? pHigh : 1 - pHigh;
      const margin = Math.abs(probFirstIsAnswer - 0.5) * 2; // [0, 1]
      const conf = ctx.exploration ? margin * 0.5 : margin;
      const firstIsAnswer = probFirstIsAnswer >= 0.5;
      const firstScore = firstIsAnswer ? 1 + conf : 1 - conf;
      const secondScore = !firstIsAnswer ? 1 + conf : 1 - conf;
      const ordered: StrategyCandidate[] = [
        {
          payload: { guessedProductId: products[0].id },
          score: firstScore,
          rationale: `${products[0].title}: pair-head P(${products[0].title} is ${
            wantsMostExpensive ? "most" : "least"
          }-expensive) = ${(probFirstIsAnswer * 100).toFixed(0)}%`,
        },
        {
          payload: { guessedProductId: products[1].id },
          score: secondScore,
          rationale: `${products[1].title}: pair-head P = ${(
            (1 - probFirstIsAnswer) *
            100
          ).toFixed(0)}%`,
        },
      ];
      ordered.sort((a, b) => b.score - a.score);
      return ordered;
    }
    // Fallback when pair-head signal is absent (NN unavailable, or
    // products.length > 2 — comparison rounds always have exactly 2
    // products in the current server, but defend against a future
    // change anyway): compare per-product estimates from the
    // priceClassHead's argmax (`rankPredictions`).
    const estimates = products.map((p) => ({
      id: p.id,
      title: p.title,
      cents: centerCents(p, ctx, 0.04),
    }));
    estimates.sort((a, b) =>
      wantsMostExpensive ? b.cents - a.cents : a.cents - b.cents,
    );
    const top = estimates[0];
    const bottom = estimates[estimates.length - 1];
    const denom = Math.max(top.cents, bottom.cents, 1);
    const gap = Math.abs(top.cents - bottom.cents) / denom;
    return estimates.map<StrategyCandidate>((e, idx) => ({
      payload: { guessedProductId: e.id },
      score: 1 - idx * (1 - Math.min(0.9, gap)),
      rationale: `${e.title}: estimated ${(e.cents / 100).toFixed(2)} (${
        wantsMostExpensive ? "most" : "least"
      }-expensive ranking pos ${idx + 1}).`,
    }));
  },
};
