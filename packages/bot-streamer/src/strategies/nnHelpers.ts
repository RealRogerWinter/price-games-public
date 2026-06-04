/**
 * Strategy-side helpers for consuming the learning bridge's prediction.
 *
 * Strategies call these instead of duplicating the "use NN if present,
 * else heuristic" branch logic in every file. Strategies that need a
 * τ-quantile shift (closest / riser / budget-builder / bidding) call
 * `quantileBidCents`; the rest use `centerCents` + `effectiveSpread`.
 *
 * The helpers are intentionally tolerant — if `ctx.nnPrediction` is
 * null, they fall back to the heuristic estimator with no warning.
 */

import { estimatePriceCents } from "../heuristics/priceEstimator";
import type { Product } from "@price-game/shared";
import type { StrategyContext } from "./types";

/**
 * Resolve the centerpoint price (in cents) for a strategy's candidate
 * generation. Priority:
 *   1. `ctx.thompsonDraw`         — when set AND `product` is the primary
 *      product on the round (not a peer in a multi-product comparison;
 *      the caller signals "this is the primary" by passing the product
 *      whose id matches `ctx.nnPrediction.rankPredictions[0]?.id` OR
 *      by passing no `nnPrediction.rankPredictions`).
 *   2. `ctx.nnPrediction.rankPredictions[i].predictedCents` — when the
 *      product matches a per-item rank prediction, use that.
 *   3. `ctx.nnPrediction.predictedCents` — for the primary product when
 *      no rank table is present.
 *   4. Heuristic estimator (fallback).
 *
 * Without the rank-prediction lookup, multi-product strategies (e.g.
 * comparison's per-product fallback) would collapse to a single shared
 * centerpoint because `thompsonDraw` is one cents value for the round.
 *
 * @param product  Product to price.
 * @param ctx      StrategyContext.
 * @param noise    Heuristic noise (only used in fallback path).
 */
export function centerCents(
  product: Pick<Product, "title" | "category" | "description"> & { id?: number },
  ctx: StrategyContext,
  noise = 0,
): number {
  // Per-item rank prediction wins for multi-product modes.
  const ranked = ctx.nnPrediction?.rankPredictions?.find(
    (r) => product.id !== undefined && r.id === product.id,
  );
  if (ranked && Number.isFinite(ranked.predictedCents)) {
    return Math.max(1, Math.round(ranked.predictedCents));
  }
  if (ctx.thompsonDraw !== undefined && Number.isFinite(ctx.thompsonDraw) && ctx.thompsonDraw > 0) {
    return Math.max(1, Math.round(ctx.thompsonDraw));
  }
  if (ctx.nnPrediction && Number.isFinite(ctx.nnPrediction.predictedCents)) {
    return Math.max(1, Math.round(ctx.nnPrediction.predictedCents));
  }
  return estimatePriceCents(product, { rng: ctx.rng, noise });
}

/**
 * Effective spread multiplier — exploration mode widens it.
 *
 * @param baseSpread Base log-space spread (e.g. 0.06 for classic).
 * @param ctx        StrategyContext (reads `exploration`).
 */
export function effectiveSpread(baseSpread: number, ctx: StrategyContext): number {
  return ctx.exploration ? baseSpread * 2 : baseSpread;
}

/**
 * Compute a τ-quantile bid `μ − τ·σ` (in cents). For modes that punish
 * "going over" — closest, riser, budget-builder, single-player bidding.
 * Falls back to `factor × center` when no NN sigma is available.
 *
 * @param product Product to price.
 * @param ctx     StrategyContext.
 * @param tau     Quantile coefficient (0.4 per plan).
 * @param fallbackFactor When NN absent, scale center by this factor.
 */
export function quantileBidCents(
  product: Pick<Product, "title" | "category" | "description">,
  ctx: StrategyContext,
  tau: number,
  fallbackFactor: number,
): number {
  const center = centerCents(product, ctx);
  if (ctx.nnPrediction && Number.isFinite(ctx.nnPrediction.predictedSigmaCents)) {
    const cap = ctx.nnPrediction.predictedCents * 0.5; // hard floor at 50%
    const shift = Math.min(ctx.nnPrediction.predictedSigmaCents * tau, cap);
    return Math.max(1, Math.round(center - shift));
  }
  return Math.max(1, Math.round(center * fallbackFactor));
}
