/**
 * Supply chain query service for Product Universe.
 *
 * Retrieves supply chain nodes with geographic coordinates
 * for map visualization.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Supply chain node with full location and company data for visualization. */
export interface SupplyChainMapNode {
  id: number;
  nodeType: string;
  description: string | null;
  orderIndex: number;
  confidence: string;
  company: { id: number; name: string; website: string | null } | null;
  location: {
    id: number;
    name: string;
    country: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
}

/**
 * Get supply chain nodes for a product with geographic data.
 *
 * @param db - Database instance.
 * @param productId - Product ID.
 * @returns Array of supply chain nodes with location and company info.
 */
export function getSupplyChain(db: DatabaseType, productId: number): SupplyChainMapNode[] {
  const rows = db.prepare(
    `SELECT scn.id, scn.node_type, scn.description, scn.order_index, scn.confidence,
            scn.company_id, c.name as company_name, c.website as company_website,
            scn.location_id, l.name as location_name, l.country, l.latitude, l.longitude,
            scn.source_id, s.url as source_url, s.title as source_title
     FROM pu_supply_chain_nodes scn
     LEFT JOIN pu_companies c ON c.id = scn.company_id
     LEFT JOIN pu_locations l ON l.id = scn.location_id
     LEFT JOIN pu_sources s ON s.id = scn.source_id
     WHERE scn.product_id = ?
     ORDER BY scn.order_index`
  ).all(productId) as {
    id: number; node_type: string; description: string | null; order_index: number;
    confidence: string; company_id: number | null; company_name: string | null;
    company_website: string | null; location_id: number | null; location_name: string | null;
    country: string | null; latitude: number | null; longitude: number | null;
    source_id: number | null; source_url: string | null; source_title: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    nodeType: r.node_type,
    description: r.description,
    orderIndex: r.order_index,
    confidence: r.confidence,
    company: r.company_id ? { id: r.company_id, name: r.company_name!, website: r.company_website } : null,
    location: r.location_id ? {
      id: r.location_id,
      name: r.location_name!,
      country: r.country!,
      latitude: r.latitude,
      longitude: r.longitude,
    } : null,
    sourceUrl: r.source_url && !r.source_url.startsWith("ai:") ? r.source_url : null,
    sourceTitle: r.source_title,
  }));
}

/**
 * Get materials for a product.
 *
 * @param db - Database instance.
 * @param productId - Product ID.
 * @returns Array of material details.
 */
export function getProductMaterials(db: DatabaseType, productId: number) {
  return db.prepare(
    `SELECT pm.percentage, pm.confidence,
            m.id, m.name, m.category, m.description, m.sustainability_score,
            s.url as source_url, s.title as source_title
     FROM pu_product_materials pm
     JOIN pu_materials m ON m.id = pm.material_id
     LEFT JOIN pu_sources s ON s.id = pm.source_id
     WHERE pm.product_id = ?
     ORDER BY pm.percentage DESC NULLS LAST`
  ).all(productId) as {
    percentage: number | null;
    confidence: string;
    id: number;
    name: string;
    category: string | null;
    description: string | null;
    sustainability_score: number | null;
    source_url: string | null;
    source_title: string | null;
  }[];
}
