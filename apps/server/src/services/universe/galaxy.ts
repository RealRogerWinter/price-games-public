/**
 * Galaxy layout computation for Product Universe.
 *
 * Computes 3D positions for products based on their similarity scores
 * and categories, producing a navigable "starfield" visualization.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUGalaxyNode } from "@price-game/shared";

/**
 * Compute galaxy positions for all enriched products.
 *
 * Uses a deterministic layout where:
 * - Categories form clusters at fixed angular positions
 * - Products within a cluster are spread by price range
 * - Z-axis encodes recency of enrichment
 *
 * @param db - Database instance.
 * @param spread - Spread radius for the galaxy (default 100).
 */
export function computeGalaxyPositions(db: DatabaseType, spread: number = 100): void {
  const products = db.prepare(
    `SELECT id, category, price_cents, pu_enriched_at FROM products
     WHERE pu_enriched = 1 AND is_active = 1
     ORDER BY category, price_cents`
  ).all() as { id: number; category: string | null; price_cents: number; pu_enriched_at: string | null }[];

  if (products.length === 0) return;

  // Assign categories to angular positions
  const categories = [...new Set(products.map((p) => p.category || "Other"))];
  const categoryAngles = new Map<string, number>();
  categories.forEach((cat, i) => {
    categoryAngles.set(cat, (i / categories.length) * Math.PI * 2);
  });

  // Price normalization
  const prices = products.map((p) => p.price_cents);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO pu_galaxy_positions (product_id, x, y, z, cluster)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const cat = p.category || "Other";
      const angle = categoryAngles.get(cat) || 0;
      const clusterIndex = categories.indexOf(cat);

      // Radial distance based on price (cheaper = closer to center)
      const priceNorm = (p.price_cents - minPrice) / priceRange;
      const radius = spread * 0.2 + priceNorm * spread * 0.6;

      // Add jitter within cluster
      const jitterAngle = angle + (Math.sin(p.id * 137.508) * 0.3);
      const jitterRadius = radius + (Math.cos(p.id * 73.13) * spread * 0.1);

      const x = Math.cos(jitterAngle) * jitterRadius;
      const y = Math.sin(jitterAngle) * jitterRadius;
      const z = (Math.sin(p.id * 43.77) * spread * 0.3);

      upsert.run(p.id, x, y, z, clusterIndex);
    }
  })();
}

/**
 * Get galaxy data for visualization.
 *
 * @param db - Database instance.
 * @param limit - Max nodes to return (default 5000).
 * @returns Array of galaxy nodes.
 */
export function getGalaxyData(db: DatabaseType, limit: number = 5000): PUGalaxyNode[] {
  const rows = db.prepare(
    `SELECT gp.product_id, gp.x, gp.y, gp.z, gp.cluster,
            p.title, p.category, p.pu_enriched
     FROM pu_galaxy_positions gp
     JOIN products p ON p.id = gp.product_id
     WHERE p.is_active = 1
     ORDER BY gp.cluster, p.title
     LIMIT ?`
  ).all(limit) as any[];

  return rows.map((r: any) => ({
    productId: r.product_id,
    title: r.title,
    category: r.category,
    x: r.x,
    y: r.y,
    z: r.z,
    cluster: r.cluster,
    enriched: !!r.pu_enriched,
  }));
}

/**
 * Get galaxy data centered on a specific product with its neighbors.
 *
 * @param db - Database instance.
 * @param productId - Center product ID.
 * @param limit - Max neighbor nodes (default 50).
 * @returns Array of galaxy nodes.
 */
export function getGalaxyForProduct(db: DatabaseType, productId: number, limit: number = 50): PUGalaxyNode[] {
  // Get the center product
  const center = db.prepare(
    `SELECT gp.product_id, gp.x, gp.y, gp.z, gp.cluster,
            p.title, p.category, p.pu_enriched
     FROM pu_galaxy_positions gp
     JOIN products p ON p.id = gp.product_id
     WHERE gp.product_id = ?`
  ).get(productId) as any;

  if (!center) return [];

  // Get similar products
  const neighbors = db.prepare(
    `SELECT gp.product_id, gp.x, gp.y, gp.z, gp.cluster,
            p.title, p.category, p.pu_enriched
     FROM pu_product_similarity ps
     JOIN pu_galaxy_positions gp ON gp.product_id = ps.product_id_b
     JOIN products p ON p.id = ps.product_id_b
     WHERE ps.product_id_a = ? AND p.is_active = 1
     ORDER BY ps.score DESC
     LIMIT ?`
  ).all(productId, limit) as any[];

  return [center, ...neighbors].map((r: any) => ({
    productId: r.product_id,
    title: r.title,
    category: r.category,
    x: r.x,
    y: r.y,
    z: r.z,
    cluster: r.cluster,
    enriched: !!r.pu_enriched,
  }));
}
