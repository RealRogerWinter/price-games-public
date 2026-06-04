/**
 * Shared product mapping utilities.
 *
 * Converts database product rows into API-facing product objects.
 * Used by both single-player gameEngine and multiplayerEngine.
 */

import db from "../db";
import type { Product, ProductWithPrice } from "@price-game/shared";
import { amazonProductUrl } from "@price-game/shared";

/** Raw product row from the database. */
export interface DbProduct {
  id: number;
  asin: string;
  title: string;
  image_url: string;
  description: string;
  price_cents: number;
  category: string;
}

/**
 * Compute a plausible price range for a product (used as slider bounds in the UI).
 *
 * @param priceCents - The actual price in cents.
 * @returns Object with min and max bounds in cents, snapped to a step size.
 */
export function computePriceRange(priceCents: number): { min: number; max: number } {
  const min = Math.max(50, Math.round(priceCents * 0.25));
  const rawMax = Math.round(priceCents * 3.5);
  const max = Math.max(min, rawMax);
  const step = max <= 5000 ? 50 : max <= 50000 ? 100 : 500;
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
  };
}

/**
 * Convert a DB product row to an API-facing Product (no price exposed).
 *
 * @param row - Database product row.
 * @returns Product with image URL, Amazon link, and computed price range.
 */
export function toProduct(row: DbProduct): Product & { priceRange: { min: number; max: number } } {
  return {
    id: row.id,
    title: row.title,
    imageUrl: `/api/image/${row.id}`,
    description: row.description,
    category: row.category,
    amazonUrl: row.asin ? amazonProductUrl(row.asin) : undefined,
    priceRange: computePriceRange(row.price_cents),
  };
}

/**
 * Convert a DB product row to an API-facing ProductWithPrice (price included).
 *
 * Phase 3e.4: now also includes `priceRange` (matching {@link toProduct}).
 * Reveal payloads — sent in classic / higher-lower / comparison / closest /
 * riser result bodies — flow through this function. The streamer-bot's
 * `extractRevealedSamples` (`packages/bot-streamer/src/runner/playwrightDriver.ts`)
 * reads `p.priceRange` to populate `RevealedSample.priceRangeCents`,
 * which gates the squashed-regression head's training. Without `priceRange`
 * here, every revealed sample ended up with `priceRangeCents=undefined`
 * and the squashedReg head's train-side gate never fired — the head was
 * starved of training signal across all production rounds (surfaced by
 * the Phase 3e.0 head-starvation watchdog as `starvedTasks: ["squashedReg"]`).
 *
 * Verified live post-deploy by inspecting the streamer's
 * `perTaskObservations[squashedReg]` going non-zero on the next
 * batch of classic-mode reveals after the new app image rolls out.
 *
 * @param row - Database product row.
 * @returns Product with all fields including priceCents AND priceRange.
 */
export function toProductWithPrice(row: DbProduct): ProductWithPrice {
  return {
    id: row.id,
    title: row.title,
    imageUrl: `/api/image/${row.id}`,
    description: row.description,
    category: row.category,
    amazonUrl: row.asin ? amazonProductUrl(row.asin) : undefined,
    priceCents: row.price_cents,
    priceRange: computePriceRange(row.price_cents),
  };
}

/**
 * Fetch multiple products by ID in a single query, eliminating N+1 queries.
 *
 * @param ids - Array of product IDs to fetch.
 * @returns Map from product ID to DbProduct row.
 */
export function getProductsByIds(ids: number[]): Map<number, DbProduct> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).all(...ids) as DbProduct[];
  return new Map(rows.map(r => [r.id, r]));
}

/**
 * Fetch products by IDs and convert to API-facing Product objects (no price).
 *
 * Preserves the ordering of the input IDs. Filters out any IDs that do not
 * resolve to a valid product row.
 *
 * @param ids - Array of product IDs to fetch.
 * @param cache - Optional pre-fetched product map to avoid redundant DB queries.
 * @returns Array of Products in the same order as the input IDs.
 */
export function getProductsForRound(ids: number[], cache?: Map<number, DbProduct>): (Product & { priceRange: { min: number; max: number } })[] {
  const productMap = cache ?? getProductsByIds(ids);
  return ids
    .map((id) => { const row = productMap.get(id); return row ? toProduct(row) : null; })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

/**
 * Fetch products by IDs and convert to API-facing ProductWithPrice objects.
 *
 * Preserves the ordering of the input IDs. Filters out any IDs that do not
 * resolve to a valid product row.
 *
 * @param ids - Array of product IDs to fetch.
 * @param cache - Optional pre-fetched product map to avoid redundant DB queries.
 * @returns Array of ProductWithPrice in the same order as the input IDs.
 */
export function getProductsWithPriceForRound(ids: number[], cache?: Map<number, DbProduct>): ProductWithPrice[] {
  const productMap = cache ?? getProductsByIds(ids);
  return ids
    .map((id) => { const row = productMap.get(id); return row ? toProductWithPrice(row) : null; })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

/**
 * Generate a reference price for Higher/Lower mode.
 *
 * Offsets the actual price by 15-45% in a random direction,
 * ensuring the reference is always at least 100 cents ($1.00).
 *
 * @param actualPrice - The actual product price in cents.
 * @returns A reference price in cents.
 */
export function generateReferencePrice(actualPrice: number): number {
  const pctOffset = 0.15 + Math.random() * 0.30;
  const direction = Math.random() < 0.5 ? 1 : -1;
  const reference = Math.round(actualPrice * (1 + direction * pctOffset));
  return Math.max(100, reference);
}
