/**
 * Product search service for Product Universe.
 *
 * Searches existing products in the database and triggers enrichment
 * jobs for products that haven't been processed yet.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUSearchResult } from "@price-game/shared";
import { queueEnrichmentJob } from "./jobProcessor";

/**
 * Search products by title or category, triggering enrichment for unenriched results.
 *
 * @param db - Database instance.
 * @param query - Search query string.
 * @param limit - Max results to return (default 20).
 * @returns Search results with enrichment status.
 */
export function searchProducts(
  db: DatabaseType,
  query: string,
  limit: number = 20,
): PUSearchResult {
  const escaped = query.replace(/[%_\\]/g, "\\$&");
  const searchTerm = `%${escaped}%`;
  const rows = db.prepare(
    `SELECT id, title, image_url, category, manufacturer, pu_enriched
     FROM products
     WHERE is_active = 1 AND (title LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\')
     ORDER BY pu_enriched DESC, title ASC
     LIMIT ?`
  ).all(searchTerm, searchTerm, searchTerm, limit) as {
    id: number;
    title: string;
    image_url: string | null;
    category: string | null;
    manufacturer: string | null;
    pu_enriched: number;
  }[];

  const total = db.prepare(
    `SELECT COUNT(*) as cnt FROM products
     WHERE is_active = 1 AND (title LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\')`
  ).get(searchTerm, searchTerm, searchTerm) as { cnt: number };

  // Queue enrichment for unenriched products
  let enrichmentTriggered = false;
  for (const row of rows) {
    if (!row.pu_enriched) {
      queueEnrichmentJob(db, row.id, null, "enrich_materials");
      enrichmentTriggered = true;
    }
  }

  return {
    products: rows.map((r) => ({
      id: r.id,
      title: r.title,
      imageUrl: r.image_url,
      category: r.category,
      manufacturer: r.manufacturer,
      enriched: !!r.pu_enriched,
    })),
    total: total.cnt,
    enrichmentTriggered,
  };
}

/**
 * Get full product detail with enrichment data.
 *
 * @param db - Database instance.
 * @param productId - Product ID.
 * @returns Product detail or null if not found.
 */
export function getProductDetail(db: DatabaseType, productId: number) {
  const product = db.prepare(
    `SELECT id, title, image_url, description, price_cents, category, manufacturer,
            pu_enriched, pu_enriched_at, pu_summary, pu_history
     FROM products WHERE id = ?`
  ).get(productId) as {
    id: number;
    title: string;
    image_url: string | null;
    description: string | null;
    price_cents: number;
    category: string | null;
    manufacturer: string | null;
    pu_enriched: number;
    pu_enriched_at: string | null;
    pu_summary: string | null;
    pu_history: string | null;
  } | undefined;

  if (!product) return null;

  // Get materials with source info
  const materials = db.prepare(
    `SELECT pm.product_id, pm.material_id, pm.percentage, pm.confidence, pm.source_id,
            m.name, m.category, m.description,
            s.url as source_url, s.title as source_title, s.fetched_at as source_fetched_at, s.content_hash as source_content_hash
     FROM pu_product_materials pm
     JOIN pu_materials m ON m.id = pm.material_id
     LEFT JOIN pu_sources s ON s.id = pm.source_id
     WHERE pm.product_id = ?`
  ).all(productId) as {
    product_id: number;
    material_id: number;
    percentage: number | null;
    confidence: string;
    source_id: number | null;
    name: string;
    category: string | null;
    description: string | null;
    source_url: string | null;
    source_title: string | null;
    source_fetched_at: string | null;
    source_content_hash: string | null;
  }[];

  // Get companies
  const companies = db.prepare(
    `SELECT pc.product_id, pc.company_id, pc.role, pc.confidence, pc.source_id,
            c.name, c.description, c.website, c.logo_url, c.founded_year,
            c.headquarters, c.employee_count, c.revenue, c.created_at, c.updated_at,
            s.url as source_url, s.title as source_title
     FROM pu_product_companies pc
     JOIN pu_companies c ON c.id = pc.company_id
     LEFT JOIN pu_sources s ON s.id = pc.source_id
     WHERE pc.product_id = ?`
  ).all(productId) as {
    product_id: number; company_id: number; role: string; confidence: string; source_id: number | null;
    name: string; description: string | null; website: string | null; logo_url: string | null;
    founded_year: number | null; headquarters: string | null; employee_count: number | null;
    revenue: string | null; created_at: string; updated_at: string;
    source_url: string | null; source_title: string | null;
  }[];

  // Get supply chain
  const supplyChain = db.prepare(
    `SELECT scn.*,
            c.name as company_name, c.description as company_desc, c.website as company_website,
            l.name as location_name, l.country, l.latitude, l.longitude
     FROM pu_supply_chain_nodes scn
     LEFT JOIN pu_companies c ON c.id = scn.company_id
     LEFT JOIN pu_locations l ON l.id = scn.location_id
     WHERE scn.product_id = ?
     ORDER BY scn.order_index`
  ).all(productId) as {
    id: number; product_id: number; node_type: string; company_id: number | null;
    location_id: number | null; description: string; order_index: number;
    confidence: string; source_id: number | null;
    company_name: string | null; company_desc: string | null; company_website: string | null;
    location_name: string | null; country: string | null; latitude: number | null; longitude: number | null;
  }[];

  // Queue enrichment if not yet enriched
  if (!product.pu_enriched) {
    queueEnrichmentJob(db, productId, null, "enrich_materials");
  }

  // Collect all unique source_ids and hydrate
  const sourceIds = new Set<number>();
  for (const m of materials) { if (m.source_id) sourceIds.add(m.source_id); }
  for (const c of companies) { if (c.source_id) sourceIds.add(c.source_id); }
  for (const n of supplyChain) { if (n.source_id) sourceIds.add(n.source_id); }

  const sourcesArr: { id: number; url: string; title: string | null; fetchedAt: string; contentHash: string | null }[] = [];
  if (sourceIds.size > 0) {
    const placeholders = [...sourceIds].map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, url, title, fetched_at, content_hash FROM pu_sources WHERE id IN (${placeholders})`
    ).all(...sourceIds) as { id: number; url: string; title: string | null; fetched_at: string; content_hash: string | null }[];
    for (const r of rows) {
      sourcesArr.push({ id: r.id, url: r.url, title: r.title, fetchedAt: r.fetched_at, contentHash: r.content_hash });
    }
  }

  // Parse pu_history as JSON with fallback for legacy string data
  let parsedHistory: string | null = product.pu_history;
  if (product.pu_history) {
    try {
      const parsed = JSON.parse(product.pu_history);
      parsedHistory = product.pu_history; // Keep as JSON string — frontend will parse
    } catch {
      // Legacy string data — wrap as narrative JSON
      parsedHistory = JSON.stringify({ narrative: product.pu_history, sources: [] });
    }
  }

  return {
    id: product.id,
    title: product.title,
    imageUrl: product.image_url,
    description: product.description,
    priceCents: product.price_cents,
    category: product.category,
    manufacturer: product.manufacturer,
    puEnriched: !!product.pu_enriched,
    puEnrichedAt: product.pu_enriched_at,
    puSummary: product.pu_summary,
    puHistory: parsedHistory,
    materials: materials.map((m) => ({
      productId: m.product_id,
      materialId: m.material_id,
      percentage: m.percentage,
      confidence: m.confidence as any,
      sourceId: m.source_id,
      material: { name: m.name, category: m.category, description: m.description },
      source: m.source_url ? { id: m.source_id!, url: m.source_url, title: m.source_title, fetchedAt: m.source_fetched_at!, contentHash: m.source_content_hash } : undefined,
    })),
    companies: companies.map((c) => ({
      productId: c.product_id,
      companyId: c.company_id,
      role: c.role,
      confidence: c.confidence,
      sourceId: c.source_id,
      sourceUrl: c.source_url && !c.source_url.startsWith("ai:") ? c.source_url : null,
      sourceTitle: c.source_title,
      company: {
        id: c.company_id,
        name: c.name,
        description: c.description,
        website: c.website,
        logoUrl: c.logo_url,
        foundedYear: c.founded_year,
        headquarters: c.headquarters,
        employeeCount: c.employee_count,
        revenue: c.revenue,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      },
    })),
    supplyChain: supplyChain.map((n) => ({
      id: n.id,
      productId: n.product_id,
      nodeType: n.node_type,
      companyId: n.company_id,
      locationId: n.location_id,
      description: n.description,
      orderIndex: n.order_index,
      confidence: n.confidence,
      sourceId: n.source_id,
      company: n.company_name ? { id: n.company_id, name: n.company_name, description: n.company_desc, website: n.company_website } : undefined,
      location: n.location_name ? { id: n.location_id, name: n.location_name, country: n.country, latitude: n.latitude, longitude: n.longitude } : undefined,
    })),
    sources: sourcesArr,
  };
}
