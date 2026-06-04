/**
 * Classic mode — the bot is shown a single product and types a price
 * estimate. Strategy: use the NN's predicted center when available
 * (else heuristic), plus a small set of nearby candidates so the
 * softmax sampler can choose a slightly-off guess for stylistic
 * variety. ε-greedy widens the spread.
 */

import type { ModeStrategy, StrategyCandidate } from "./types";
import { centerCents, effectiveSpread } from "./nnHelpers";

const STRATEGY_NOISE = 0.06;

/**
 * Build candidates for a classic round. Returns the chosen estimate
 * plus four nearby variants (±5%, ±15%) so the engine has something
 * to sample over. NN-aware via {@link centerCents}.
 */
export const classicStrategy: ModeStrategy = {
  mode: "classic",
  candidates(round, ctx = {}) {
    if (!round.product) {
      throw new Error("classicStrategy: round missing product");
    }
    const estimate = centerCents(round.product, ctx, STRATEGY_NOISE);
    const spread = effectiveSpread(1, ctx);
    const variants: Array<{ factor: number; score: number; rationale: string }> = [
      { factor: 1.0, score: 1.0, rationale: "Center estimate." },
      { factor: 1 - 0.05 * spread, score: 0.7, rationale: "A touch under — cautious bid." },
      { factor: 1 + 0.05 * spread, score: 0.7, rationale: "A touch over — confident bid." },
      { factor: 1 - 0.15 * spread, score: 0.4, rationale: "Discounted estimate — assuming hidden value." },
      { factor: 1 + 0.2 * spread, score: 0.4, rationale: "Inflated estimate — premium tokens dominate." },
    ];
    return variants.map<StrategyCandidate>(({ factor, score, rationale }) => ({
      payload: { guessedPriceCents: Math.max(1, Math.round(estimate * factor)) },
      score,
      rationale,
    }));
  },
};
