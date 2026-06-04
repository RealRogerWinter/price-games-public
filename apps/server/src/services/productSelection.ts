import db from "../db";
import { UserFacingError } from "./errors";

interface SelectedProduct {
  id: number;
  price_cents: number;
}

export function selectProducts(count: number, categories?: string[]): SelectedProduct[] {
  const now = new Date().toISOString();
  let products: SelectedProduct[];

  if (categories && categories.length > 0) {
    const placeholders = categories.map(() => "?").join(", ");
    products = db
      .prepare(
        `SELECT id, price_cents FROM products WHERE is_active = 1 AND category IN (${placeholders})
         ORDER BY CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END, last_used_at ASC, RANDOM() LIMIT ?`
      )
      .all(...categories, count) as SelectedProduct[];
  } else {
    products = db
      .prepare(
        `SELECT id, price_cents FROM products WHERE is_active = 1
         ORDER BY CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END, last_used_at ASC, RANDOM() LIMIT ?`
      )
      .all(count) as SelectedProduct[];
  }

  if (products.length < count) {
    throw new UserFacingError(`Not enough active products. Need ${count}, have ${products.length}.`);
  }

  // Mark selected products as recently used
  const updateLastUsed = db.prepare("UPDATE products SET last_used_at = ? WHERE id = ?");
  const markUsed = db.transaction(() => {
    for (const p of products) {
      updateLastUsed.run(now, p.id);
    }
  });
  markUsed();

  return products;
}

/**
 * For comparison mode: ensures each consecutive pair of products has distinct prices.
 * If a pair has the same price, replaces one product with a different-priced alternative.
 */
export function ensureComparisonPairsDistinct(
  products: SelectedProduct[],
  pairSize: number,
  categories?: string[]
): SelectedProduct[] {
  const now = new Date().toISOString();
  const result = [...products];
  const usedIds = new Set(result.map((p) => p.id));

  for (let i = 0; i < result.length; i += pairSize) {
    const pair = result.slice(i, i + pairSize);
    if (pair.length < 2) continue;

    // Check if all products in the pair share the same price
    const allSamePrice = pair.every((p) => p.price_cents === pair[0].price_cents);
    if (!allSamePrice) continue;

    // Find a replacement for the second product in the pair
    const excludeIds = [...usedIds];
    const targetPrice = pair[0].price_cents;
    const replacement = findProductWithDifferentPrice(targetPrice, excludeIds, categories);

    if (replacement) {
      usedIds.delete(result[i + 1].id);
      usedIds.add(replacement.id);
      result[i + 1] = replacement;

      // Mark replacement as used
      db.prepare("UPDATE products SET last_used_at = ? WHERE id = ?").run(now, replacement.id);
    }
  }

  return result;
}

function findProductWithDifferentPrice(
  excludePrice: number,
  excludeIds: number[],
  categories?: string[]
): SelectedProduct | null {
  const idPlaceholders = excludeIds.map(() => "?").join(", ");

  let query: string;
  let params: any[];

  if (categories && categories.length > 0) {
    const catPlaceholders = categories.map(() => "?").join(", ");
    query = `SELECT id, price_cents FROM products
             WHERE is_active = 1 AND price_cents != ? AND category IN (${catPlaceholders})
             ${excludeIds.length > 0 ? `AND id NOT IN (${idPlaceholders})` : ""}
             ORDER BY RANDOM() LIMIT 1`;
    params = [excludePrice, ...categories, ...excludeIds];
  } else {
    query = `SELECT id, price_cents FROM products
             WHERE is_active = 1 AND price_cents != ?
             ${excludeIds.length > 0 ? `AND id NOT IN (${idPlaceholders})` : ""}
             ORDER BY RANDOM() LIMIT 1`;
    params = [excludePrice, ...excludeIds];
  }

  return (db.prepare(query).get(...params) as SelectedProduct) || null;
}
