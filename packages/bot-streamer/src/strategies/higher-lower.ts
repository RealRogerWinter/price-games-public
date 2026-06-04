/**
 * Higher-Lower mode — the bot sees a reference price and a product.
 * Strategy: estimate the product's true price (NN if available, else
 * heuristic) and compare to the reference. The highest-scoring
 * candidate is whichever direction the estimate lands on; the
 * runner-up gets weight proportional to how close the estimate is to
 * the reference (a coin-flip when the gap is small).
 */

import type { ModeStrategy, StrategyCandidate } from "./types";
import { centerCents } from "./nnHelpers";

export const higherLowerStrategy: ModeStrategy = {
  mode: "higher-lower",
  candidates(round, ctx = {}) {
    if (!round.product) {
      throw new Error("higherLowerStrategy: round missing product");
    }
    if (round.referencePrice === undefined) {
      throw new Error("higherLowerStrategy: round missing referencePrice");
    }
    const estimate = centerCents(round.product, ctx, 0.05);
    const ref = round.referencePrice;
    // Confidence: how far the estimate is from the reference, scaled
    // by the reference itself. 0 → coin flip. ~1 → strong signal.
    const gap = Math.abs(estimate - ref) / Math.max(ref, 1);
    const baseConf = Math.min(1, gap * 5);
    // Exploration mode → soften confidence so the loser candidate has
    // a bigger slice of the softmax.
    const confidence = ctx.exploration ? baseConf * 0.5 : baseConf;
    const higherScore = estimate > ref ? 1 + confidence : 1 - confidence;
    const lowerScore = estimate <= ref ? 1 + confidence : 1 - confidence;
    // Note (Phase 3b): higher-lower has one product + a reference
    // price, NOT two products, so the pair-logit head doesn't apply
    // here — we rely on the squashed-reg head's continuous estimate
    // (via centerCents) compared to `referencePrice`. The pair head
    // is comparison-only.
    const rationale = `Estimated ${(estimate / 100).toFixed(2)} vs reference ${(ref / 100).toFixed(2)}.`;
    const candidates: StrategyCandidate[] = [
      { payload: { guess: "higher" }, score: higherScore, rationale },
      { payload: { guess: "lower" }, score: lowerScore, rationale },
    ];
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  },
};
