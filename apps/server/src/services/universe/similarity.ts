/**
 * Product similarity computation for Product Universe.
 *
 * Computes composite similarity scores between enriched products
 * based on shared materials, categories, manufacturers, and price range.
 * Scores are precomputed and stored for fast retrieval.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Compute and store similarity scores between enriched products.
 *
 * Uses a composite scoring approach:
 * - Same category: +0.3
 * - Same manufacturer: +0.2
 * - Shared materials: +0.1 per shared material (up to 0.3)
 * - Price proximity: up to +0.2 (inversely proportional to price difference)
 *
 * @param db - Database instance.
 * @param productId - Product to compute similarities for.
 * @param limit - Maximum number of similar products to store (default 20).
 */
export function computeSimilarity(db: DatabaseType, productId: number, limit: number = 20): void {
  const product = db.prepare(
    "SELECT category, manufacturer, price_cents FROM products WHERE id = ?"
  ).get(productId) as { category: string | null; manufacturer: string | null; price_cents: number } | undefined;

  if (!product) return;

  // Get this product's materials
  const myMaterials = new Set(
    (db.prepare(
      "SELECT material_id FROM pu_product_materials WHERE product_id = ?"
    ).all(productId) as { material_id: number }[]).map((r) => r.material_id)
  );

  // Get other enriched products
  const others = db.prepare(
    `SELECT id, category, manufacturer, price_cents FROM products
     WHERE id != ? AND pu_enriched = 1 AND is_active = 1
     LIMIT 500`
  ).all(productId) as { id: number; category: string | null; manufacturer: string | null; price_cents: number }[];

  const scores: { productId: number; score: number; reason: string }[] = [];

  for (const other of others) {
    let score = 0;
    const reasons: string[] = [];

    // Category match
    if (product.category && product.category === other.category) {
      score += 0.3;
      reasons.push("same category");
    }

    // Manufacturer match
    if (product.manufacturer && product.manufacturer === other.manufacturer) {
      score += 0.2;
      reasons.push("same manufacturer");
    }

    // Shared materials
    const otherMaterials = (db.prepare(
      "SELECT material_id FROM pu_product_materials WHERE product_id = ?"
    ).all(other.id) as { material_id: number }[]).map((r) => r.material_id);

    const shared = otherMaterials.filter((m) => myMaterials.has(m)).length;
    if (shared > 0) {
      score += Math.min(shared * 0.1, 0.3);
      reasons.push(`${shared} shared material${shared > 1 ? "s" : ""}`);
    }

    // Price proximity (within 50% = full score, beyond = proportional)
    const priceDiff = Math.abs(product.price_cents - other.price_cents);
    const avgPrice = (product.price_cents + other.price_cents) / 2;
    if (avgPrice > 0) {
      const proximity = Math.max(0, 1 - priceDiff / avgPrice);
      score += proximity * 0.2;
      if (proximity > 0.5) reasons.push("similar price");
    }

    if (score > 0.1) {
      scores.push({ productId: other.id, score, reason: reasons.join(", ") });
    }
  }

  // Sort by score descending and keep top N
  scores.sort((a, b) => b.score - a.score);
  const topScores = scores.slice(0, limit);

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO pu_product_similarity (product_id_a, product_id_b, score, reason)
     VALUES (?, ?, ?, ?)`
  );

  db.transaction(() => {
    // Clear existing scores
    db.prepare("DELETE FROM pu_product_similarity WHERE product_id_a = ?").run(productId);

    for (const s of topScores) {
      upsert.run(productId, s.productId, s.score, s.reason);
    }
  })();
}

/**
 * Get similar products for a given product.
 *
 * @param db - Database instance.
 * @param productId - Product ID.
 * @param limit - Max results (default 10).
 * @returns Array of similar products with scores.
 */
export function getRelatedProducts(db: DatabaseType, productId: number, limit: number = 10) {
  return db.prepare(
    `SELECT related_id as id, score, reason,
            p.title, p.image_url, p.category, p.manufacturer
     FROM (
       SELECT product_id_b as related_id, score, reason FROM pu_product_similarity WHERE product_id_a = @pid
       UNION
       SELECT product_id_a as related_id, score, reason FROM pu_product_similarity WHERE product_id_b = @pid
     ) sub
     JOIN products p ON p.id = sub.related_id
     ORDER BY score DESC
     LIMIT @lim`
  ).all({ pid: productId, lim: limit }) as {
    id: number;
    score: number;
    reason: string | null;
    title: string;
    image_url: string | null;
    category: string | null;
    manufacturer: string | null;
  }[];
}
