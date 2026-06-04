/**
 * Summary card generator for Product Universe.
 *
 * Generates AI-powered summary cards for products based on their
 * enrichment data. Cards cover overview, materials, supply chain,
 * company info, sustainability, and history.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUSummaryCard, PUSource } from "@price-game/shared";
import type { AIProvider } from "../ai/types";
import { buildSummaryCardsPrompt } from "../ai/prompts";
import { summaryCardsSchema } from "../ai/schemas";
import type { WebSearchResult } from "./webSearch";

/**
 * Generate summary cards for a product.
 *
 * If AI is available, generates fresh cards. Otherwise returns
 * basic cards from existing enrichment data.
 *
 * @param db - Database instance.
 * @param productId - Product ID.
 * @param ai - AI provider (optional — returns basic cards without it).
 * @returns Array of summary cards.
 */
export async function generateSummaryCards(
  db: DatabaseType,
  productId: number,
  ai?: AIProvider | null,
): Promise<PUSummaryCard[]> {
  const product = db.prepare(
    "SELECT title, description, manufacturer, pu_summary FROM products WHERE id = ?"
  ).get(productId) as {
    title: string;
    description: string | null;
    manufacturer: string | null;
    pu_summary: string | null;
  } | undefined;

  if (!product) return [];

  // Get related data
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

  // Gather sources used for this product to pass as context
  const sourceRows = db.prepare(
    `SELECT DISTINCT s.url, s.title FROM pu_sources s
     WHERE s.id IN (
       SELECT source_id FROM pu_product_materials WHERE product_id = ? AND source_id IS NOT NULL
       UNION
       SELECT source_id FROM pu_supply_chain_nodes WHERE product_id = ? AND source_id IS NOT NULL
     )`
  ).all(productId, productId) as { url: string; title: string | null }[];

  const searchResults: WebSearchResult[] = sourceRows
    .filter((s) => !s.url.startsWith("ai:"))
    .map((s) => ({ title: s.title || s.url, url: s.url, snippet: "" }));

  // Use AI if available
  if (ai) {
    try {
      const messages = buildSummaryCardsPrompt(
        product.title,
        product.description,
        product.manufacturer,
        materialNames,
        companyNames,
        searchResults,
      );
      const result = await ai.generateStructured<{ cards: PUSummaryCard[] }>(
        messages,
        summaryCardsSchema,
      );
      return result.data.cards;
    } catch (err) {
      console.error("[PU] AI card generation failed, falling back to basic cards:", err);
    }
  }

  // Fallback: basic cards from existing data
  const cards: PUSummaryCard[] = [];

  cards.push({
    title: product.title,
    content: product.pu_summary || product.description || "No description available.",
    category: "overview",
    icon: "📦",
  });

  if (materialNames.length > 0) {
    cards.push({
      title: "Materials",
      content: `Made from: ${materialNames.join(", ")}.`,
      category: "materials",
      icon: "🧱",
    });
  }

  if (product.manufacturer) {
    cards.push({
      title: "Manufacturer",
      content: `Manufactured by ${product.manufacturer}.`,
      category: "company",
      icon: "🏭",
    });
  }

  return cards;
}
