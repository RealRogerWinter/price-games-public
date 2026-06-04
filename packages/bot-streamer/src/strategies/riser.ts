/**
 * Riser — a price counter ticks up; the bot stops it before the real
 * price. Going over scores zero, so the safe play is to stop at a
 * conservative fraction of the estimate. NN-aware: τ=0.4 quantile
 * shift when the NN gave a sigma; else heuristic-based jitter.
 */

import { gaussian } from "../realism/timing";
import type { GuessData } from "@price-game/shared";
import type { ModeStrategy, StrategyCandidate } from "./types";
import { centerCents, quantileBidCents } from "./nnHelpers";

const STRATEGY_NOISE = 0.04;
const TAU = 0.4;

export const riserStrategy: ModeStrategy = {
  mode: "riser",
  candidates(round, ctx = {}) {
    if (!round.product) {
      throw new Error("riserStrategy: round missing product");
    }
    const rng = ctx.rng ?? Math.random;
    const max = round.maxPriceCents ?? Number.POSITIVE_INFINITY;
    const center = Math.min(max, centerCents(round.product, ctx, STRATEGY_NOISE));
    const primaryStop = Math.min(
      max,
      quantileBidCents(round.product, ctx, TAU, 0.92),
    );

    const variants: Array<{ cents: number; score: number; rationale: string }> = [
      { cents: primaryStop, score: 1.0, rationale: "μ − 0.4σ — conservative under-bid." },
      { cents: Math.min(max, Math.round(center * 0.85)), score: 0.7, rationale: "Stop earlier — safer if the estimate is over." },
      { cents: Math.min(max, Math.round(center * 0.97)), score: 0.5, rationale: "Stop later — riskier; better score on a tight estimate." },
    ];

    return variants.map<StrategyCandidate>(({ cents, score, rationale }) => {
      const jitter = 1 + gaussian(0, 0.02, rng);
      const stop = Math.max(1, Math.min(max, Math.round(cents * jitter)));
      return {
        payload: { stoppedPriceCents: stop } satisfies GuessData,
        score: ctx.exploration ? Math.max(0.05, score * 0.85) : score,
        rationale,
      };
    });
  },
};
