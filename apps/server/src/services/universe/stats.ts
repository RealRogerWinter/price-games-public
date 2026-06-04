/**
 * Public stats service for Product Universe.
 *
 * Returns aggregate counts for the knowledge graph.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUStats } from "@price-game/shared";

/**
 * Get public stats for the Product Universe.
 *
 * @param db - Database instance.
 * @returns Aggregate statistics.
 */
export function getStats(db: DatabaseType): PUStats {
  const totalProducts = (db.prepare(
    "SELECT COUNT(*) as cnt FROM products WHERE is_active = 1"
  ).get() as { cnt: number }).cnt;

  const enrichedProducts = (db.prepare(
    "SELECT COUNT(*) as cnt FROM products WHERE pu_enriched = 1 AND is_active = 1"
  ).get() as { cnt: number }).cnt;

  const totalMaterials = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pu_materials"
  ).get() as { cnt: number }).cnt;

  const totalCompanies = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pu_companies"
  ).get() as { cnt: number }).cnt;

  const totalLocations = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pu_locations"
  ).get() as { cnt: number }).cnt;

  const totalSupplyChainNodes = (db.prepare(
    "SELECT COUNT(*) as cnt FROM pu_supply_chain_nodes"
  ).get() as { cnt: number }).cnt;

  return {
    totalProducts,
    enrichedProducts,
    totalMaterials,
    totalCompanies,
    totalLocations,
    totalSupplyChainNodes,
  };
}
