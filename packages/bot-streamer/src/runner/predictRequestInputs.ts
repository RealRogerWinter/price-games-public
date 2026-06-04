/**
 * Pure helpers for shaping the learning bridge's predict-request
 * inputs. Extracted from `playwrightDriver.ts` so the rank/pair
 * derivation can be unit-tested directly.
 */

import type { ProductLite } from "../learning/types";

interface ProductLikeIn {
  readonly id: number;
  readonly title: string;
  readonly category: string;
  readonly description?: string;
  readonly imageUrl?: string;
}

/**
 * Reduce a server `Product` to the worker-thread-safe `ProductLite`.
 * Only the fields the worker reads — id/title/category and the
 * descriptive blurbs — survive.
 */
export function toProductLite(p: ProductLikeIn): ProductLite {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    description: p.description,
    imageUrl: p.imageUrl,
  };
}

export interface RankAndPair {
  /** The pair-logit head's binary input. Set only when length === 2. */
  pair: [ProductLite, ProductLite] | undefined;
  /**
   * Per-product rank inputs. Set whenever there are at least 2
   * products — including the 2-product comparison case. Pre-3e.0
   * this gated on `length > 2` only, which left comparison rounds
   * without per-product rank predictions and collapsed the
   * strategy's fallback path onto a single shared centerpoint.
   */
  rank: ProductLite[] | undefined;
}

/**
 * Derive the (pairProducts, rankProducts) inputs for the learning
 * bridge's predict request from a multi-product round.
 *
 * @param products The round's products, or undefined for single-product modes.
 */
export function deriveRankAndPair(
  products: ReadonlyArray<ProductLikeIn> | undefined,
): RankAndPair {
  if (!products || products.length < 2) {
    return { pair: undefined, rank: undefined };
  }
  const lite = products.map(toProductLite);
  const pair = products.length === 2 ? ([lite[0], lite[1]] as [ProductLite, ProductLite]) : undefined;
  return { pair, rank: lite };
}
