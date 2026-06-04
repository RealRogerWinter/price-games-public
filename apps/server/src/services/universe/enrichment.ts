/**
 * Product enrichment service for Product Universe.
 *
 * Orchestrates AI-powered extraction of materials, supply chain,
 * and company data for products. Called by the job processor when
 * enrichment jobs are dequeued. Integrates web search for source
 * grounding and confidence validation.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { AIProvider } from "../ai/types";
import { buildMaterialsPrompt, buildSupplyChainPrompt, buildCompanyPrompt, buildHistoryPrompt } from "../ai/prompts";
import { materialExtractionSchema, supplyChainExtractionSchema, companyExtractionSchema, historyExtractionSchema } from "../ai/schemas";
import { upsertSource } from "./sourceTracker";
import { searchWeb, buildSearchQueries } from "./webSearch";
import type { WebSearchResult } from "./webSearch";
import { config } from "../../config";

/** Validate that a URL uses http/https scheme. */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Collect web search results for an enrichment step, deduplicating by URL.
 *
 * @param db - Database instance.
 * @param productTitle - Product title for query building.
 * @param manufacturer - Manufacturer name (may be null).
 * @param step - Enrichment step name.
 * @returns Deduplicated array of search results.
 */
async function collectSearchResults(
  db: DatabaseType,
  productTitle: string,
  manufacturer: string | null,
  step: string,
): Promise<WebSearchResult[]> {
  const queries = buildSearchQueries(productTitle, manufacturer, step);
  const allQueryResults = await Promise.all(queries.map((q) => searchWeb(db, q)));
  const allResults: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const results of allQueryResults) {
    for (const r of results) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        allResults.push(r);
      }
    }
  }

  return allResults;
}

/**
 * Upsert sources for search results and build a sourceId map by index.
 *
 * @param db - Database instance.
 * @param searchResults - Search results to register as sources.
 * @returns Map from 0-based index to source ID.
 */
function registerSources(db: DatabaseType, searchResults: WebSearchResult[]): Map<number, number> {
  const sourceMap = new Map<number, number>();
  for (let i = 0; i < searchResults.length; i++) {
    if (!isSafeUrl(searchResults[i].url)) continue;
    const sourceId = upsertSource(db, searchResults[i].url, searchResults[i].title);
    sourceMap.set(i, sourceId);
  }
  return sourceMap;
}

/**
 * Validate confidence: if AI says "high" but sourceIndex is null, downgrade to "low".
 *
 * @param confidence - AI-reported confidence.
 * @param sourceIndex - Source index (null means AI-only).
 * @returns Validated confidence level.
 */
function validateConfidence(
  confidence: string | undefined,
  sourceIndex: number | null | undefined,
): "high" | "medium" | "low" {
  const c = confidence ?? "low";
  if (c === "high" && (sourceIndex == null)) return "low";
  if (c !== "high" && c !== "medium" && c !== "low") return "low";
  return c as "high" | "medium" | "low";
}

/**
 * Enrich a product with material data via AI extraction.
 *
 * @param db - Database instance.
 * @param ai - AI provider.
 * @param productId - The product to enrich.
 */
export async function enrichMaterials(
  db: DatabaseType,
  ai: AIProvider,
  productId: number,
): Promise<void> {
  const product = db.prepare(
    "SELECT title, description, manufacturer FROM products WHERE id = ?"
  ).get(productId) as { title: string; description: string | null; manufacturer: string | null } | undefined;

  if (!product) return;

  const searchResults = await collectSearchResults(db, product.title, product.manufacturer, "materials");
  const sourceMap = registerSources(db, searchResults);

  const messages = buildMaterialsPrompt(product.title, product.description, product.manufacturer, searchResults);
  const result = await ai.generateStructured<{
    materials: {
      name: string;
      category: string;
      percentage?: number | null;
      description?: string;
      sourceIndex?: number | null;
      confidence?: string;
    }[];
    summary: string;
  }>(messages, materialExtractionSchema);

  const aiSourceId = upsertSource(db, `ai:materials:${productId}`, `AI material extraction for ${product.title}`);

  const upsertMaterial = db.prepare(
    "INSERT OR IGNORE INTO pu_materials (name, category, description) VALUES (?, ?, ?)"
  );
  const getMaterialId = db.prepare("SELECT id FROM pu_materials WHERE name = ?");
  const insertLink = db.prepare(
    `INSERT OR REPLACE INTO pu_product_materials (product_id, material_id, percentage, confidence, source_id)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    for (const mat of result.data.materials) {
      upsertMaterial.run(mat.name, mat.category, mat.description || null);
      const row = getMaterialId.get(mat.name) as { id: number };
      const confidence = validateConfidence(mat.confidence, mat.sourceIndex);
      const sourceId = mat.sourceIndex != null && sourceMap.has(mat.sourceIndex)
        ? sourceMap.get(mat.sourceIndex)!
        : aiSourceId;
      insertLink.run(productId, row.id, mat.percentage ?? null, confidence, sourceId);
    }

    db.prepare(
      "UPDATE products SET pu_summary = ?, pu_enriched = 1, pu_enriched_at = datetime('now') WHERE id = ?"
    ).run(result.data.summary, productId);
  })();
}

/**
 * Enrich a product with supply chain data via AI extraction.
 *
 * @param db - Database instance.
 * @param ai - AI provider.
 * @param productId - The product to enrich.
 */
export async function enrichSupplyChain(
  db: DatabaseType,
  ai: AIProvider,
  productId: number,
): Promise<void> {
  const product = db.prepare(
    "SELECT title, manufacturer FROM products WHERE id = ?"
  ).get(productId) as { title: string; manufacturer: string | null } | undefined;

  if (!product) return;

  const materials = db.prepare(
    `SELECT m.name FROM pu_product_materials pm
     JOIN pu_materials m ON m.id = pm.material_id
     WHERE pm.product_id = ?`
  ).all(productId) as { name: string }[];

  const searchResults = await collectSearchResults(db, product.title, product.manufacturer, "supply_chain");
  const sourceMap = registerSources(db, searchResults);

  const messages = buildSupplyChainPrompt(
    product.title,
    product.manufacturer,
    materials.map((m) => m.name),
    searchResults,
  );

  const result = await ai.generateStructured<{
    nodes: {
      nodeType: string;
      companyName?: string | null;
      locationName?: string | null;
      country?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      description: string;
      sourceIndex?: number | null;
      confidence?: string;
    }[];
  }>(messages, supplyChainExtractionSchema);

  const aiSourceId = upsertSource(db, `ai:supply_chain:${productId}`, `AI supply chain extraction for ${product.title}`);

  const upsertCompany = db.prepare("INSERT OR IGNORE INTO pu_companies (name) VALUES (?)");
  const getCompanyId = db.prepare("SELECT id FROM pu_companies WHERE name = ?");
  const insertLocation = db.prepare(
    "INSERT INTO pu_locations (name, country, latitude, longitude) VALUES (?, ?, ?, ?)"
  );
  const insertNode = db.prepare(
    `INSERT INTO pu_supply_chain_nodes (product_id, node_type, company_id, location_id, description, order_index, confidence, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertProductCompany = db.prepare(
    `INSERT OR IGNORE INTO pu_product_companies (product_id, company_id, role, confidence, source_id)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    // Clear existing nodes for this product
    db.prepare("DELETE FROM pu_supply_chain_nodes WHERE product_id = ?").run(productId);

    for (let i = 0; i < result.data.nodes.length; i++) {
      const node = result.data.nodes[i];

      let companyId: number | null = null;
      if (node.companyName) {
        upsertCompany.run(node.companyName);
        const row = getCompanyId.get(node.companyName) as { id: number };
        companyId = row.id;
      }

      let locationId: number | null = null;
      if (node.locationName && node.country) {
        const locInfo = insertLocation.run(
          node.locationName,
          node.country,
          node.latitude ?? null,
          node.longitude ?? null,
        );
        locationId = Number(locInfo.lastInsertRowid);
      }

      const confidence = validateConfidence(node.confidence, node.sourceIndex);
      const sourceId = node.sourceIndex != null && sourceMap.has(node.sourceIndex)
        ? sourceMap.get(node.sourceIndex)!
        : aiSourceId;

      insertNode.run(productId, node.nodeType, companyId, locationId, node.description, i, confidence, sourceId);

      // Link company to product via pu_product_companies
      if (companyId) {
        insertProductCompany.run(productId, companyId, node.nodeType, confidence, sourceId);
      }
    }
  })();
}

/**
 * Enrich company data via AI extraction.
 *
 * @param db - Database instance.
 * @param ai - AI provider.
 * @param companyId - The company to enrich.
 */
export async function enrichCompany(
  db: DatabaseType,
  ai: AIProvider,
  companyId: number,
): Promise<void> {
  const company = db.prepare("SELECT name FROM pu_companies WHERE id = ?").get(companyId) as { name: string } | undefined;
  if (!company) return;

  const searchResults = await collectSearchResults(db, company.name, null, "company");
  const sourceMap = registerSources(db, searchResults);

  const messages = buildCompanyPrompt(company.name, searchResults);
  const result = await ai.generateStructured<{
    name: string;
    description: string;
    website?: string | null;
    foundedYear?: number | null;
    headquarters?: string | null;
    employeeCount?: number | null;
    revenue?: string | null;
    relationships?: { companyName: string; relationshipType: string }[];
    sourceIndex?: number | null;
    confidence?: string;
  }>(messages, companyExtractionSchema);

  const confidence = validateConfidence(result.data.confidence, result.data.sourceIndex);
  const sourceId = result.data.sourceIndex != null && sourceMap.has(result.data.sourceIndex)
    ? sourceMap.get(result.data.sourceIndex)!
    : upsertSource(db, `ai:company:${companyId}`, `AI company extraction for ${company.name}`);

  const upsertRelatedCompany = db.prepare("INSERT OR IGNORE INTO pu_companies (name) VALUES (?)");
  const getCompanyIdByName = db.prepare("SELECT id FROM pu_companies WHERE name = ?");
  const insertRelationship = db.prepare(
    `INSERT OR IGNORE INTO pu_company_relationships (company_id, related_company_id, relationship_type, confidence, source_id)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    db.prepare(
      `UPDATE pu_companies SET description = ?, website = ?, founded_year = ?,
       headquarters = ?, employee_count = ?, revenue = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      result.data.description,
      result.data.website ?? null,
      result.data.foundedYear ?? null,
      result.data.headquarters ?? null,
      result.data.employeeCount ?? null,
      result.data.revenue ?? null,
      companyId,
    );

    if (result.data.relationships) {
      for (const rel of result.data.relationships) {
        upsertRelatedCompany.run(rel.companyName);
        const row = getCompanyIdByName.get(rel.companyName) as { id: number };
        insertRelationship.run(companyId, row.id, rel.relationshipType, confidence, sourceId);
      }
    }
  })();
}

/**
 * Enrich a product with historical data via AI extraction.
 *
 * Uses the research model (Opus) for deeper analysis. Stores structured
 * history JSON in the products.pu_history column.
 *
 * @param db - Database instance.
 * @param ai - AI provider.
 * @param productId - The product to enrich.
 */
export async function enrichHistory(
  db: DatabaseType,
  ai: AIProvider,
  productId: number,
): Promise<void> {
  const product = db.prepare(
    "SELECT title, manufacturer, category FROM products WHERE id = ?"
  ).get(productId) as { title: string; manufacturer: string | null; category: string | null } | undefined;

  if (!product) return;

  // Gather context from prior enrichment steps
  const materialNames = (db.prepare(
    `SELECT m.name FROM pu_product_materials pm
     JOIN pu_materials m ON m.id = pm.material_id
     WHERE pm.product_id = ?`
  ).all(productId) as { name: string }[]).map((r) => r.name);

  const companyNames = (db.prepare(
    `SELECT c.name FROM pu_product_companies pc
     JOIN pu_companies c ON c.id = pc.company_id
     WHERE pc.product_id = ?`
  ).all(productId) as { name: string }[]).map((r) => r.name);

  const searchResults = await collectSearchResults(db, product.title, product.manufacturer, "history");
  const sourceMap = registerSources(db, searchResults);

  const messages = buildHistoryPrompt(product.title, product.manufacturer, product.category, searchResults);

  const result = await ai.generateStructured<{
    narrative: string;
    inventionYear?: number | null;
    inventor?: string | null;
    predecessors?: string[];
    milestones?: { year: number; event: string; sourceIndex?: number | null }[];
  }>(messages, historyExtractionSchema, { model: config.puResearchModel });

  // Build history JSON with embedded source URLs
  const milestones = (result.data.milestones ?? []).map((m) => {
    let sourceUrl: string | null = null;
    let sourceTitle: string | null = null;
    if (m.sourceIndex != null && m.sourceIndex < searchResults.length) {
      sourceUrl = searchResults[m.sourceIndex].url;
      sourceTitle = searchResults[m.sourceIndex].title;
    }
    return { year: m.year, event: m.event, sourceUrl, sourceTitle };
  });

  // Collect source URLs used
  const sources = searchResults.map((r) => ({ url: r.url, title: r.title }));

  const historyJson = JSON.stringify({
    narrative: result.data.narrative,
    inventionYear: result.data.inventionYear ?? null,
    inventor: result.data.inventor ?? null,
    predecessors: result.data.predecessors ?? [],
    milestones,
    sources,
    context: {
      materials: materialNames,
      companies: companyNames,
    },
  });

  db.prepare("UPDATE products SET pu_history = ? WHERE id = ?").run(historyJson, productId);
}
