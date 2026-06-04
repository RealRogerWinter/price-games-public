/**
 * Prompt templates for Product Universe AI extraction.
 *
 * Each function returns an array of AI messages ready for the provider.
 */

import type { AIMessage } from "./types";
import type { WebSearchResult } from "../universe/webSearch";

const SYSTEM_CONTEXT = `You are a product research assistant. You analyze products and extract structured information about their materials, supply chains, manufacturing, and corporate relationships. Base your answers on well-known, publicly available information. When uncertain, indicate lower confidence rather than fabricating details.

When web search results are provided below, use them as primary sources and cite them by their [index] number. Set sourceIndex to the 0-based index of the source you relied on. If a claim is not supported by any provided source, set sourceIndex to null and confidence to "low". Only set confidence to "high" when a claim is directly supported by 2+ sources.`;

/**
 * Format search results as a numbered list for inclusion in prompts.
 *
 * @param searchResults - Web search results to format.
 * @returns Formatted string, or empty string if no results.
 */
function formatSearchResults(searchResults: WebSearchResult[]): string {
  if (searchResults.length === 0) return "";
  const lines = searchResults.map((r, i) => `[${i}] "${r.title}" (${r.url}) — ${r.snippet}`);
  return `\n\nWeb search results:\n${lines.join("\n")}`;
}

/**
 * Build prompt for extracting materials from a product.
 *
 * @param productTitle - The product title.
 * @param productDescription - The product description (may be null).
 * @param manufacturer - The product manufacturer (may be null).
 * @param searchResults - Optional web search results for grounding.
 * @returns AI message array for structured extraction.
 */
export function buildMaterialsPrompt(
  productTitle: string,
  productDescription: string | null,
  manufacturer: string | null,
  searchResults: WebSearchResult[] = [],
): AIMessage[] {
  const details = [
    `Product: ${productTitle}`,
    productDescription ? `Description: ${productDescription}` : null,
    manufacturer ? `Manufacturer: ${manufacturer}` : null,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: SYSTEM_CONTEXT },
    {
      role: "user",
      content: `Analyze the materials used in this product:\n\n${details}\n\nList the primary materials, their categories, and approximate percentages if known. Include a brief summary of the material composition.${formatSearchResults(searchResults)}`,
    },
  ];
}

/**
 * Build prompt for extracting supply chain information.
 *
 * @param productTitle - The product title.
 * @param manufacturer - The product manufacturer (may be null).
 * @param materials - Known materials (may be empty).
 * @param searchResults - Optional web search results for grounding.
 * @returns AI message array for structured extraction.
 */
export function buildSupplyChainPrompt(
  productTitle: string,
  manufacturer: string | null,
  materials: string[],
  searchResults: WebSearchResult[] = [],
): AIMessage[] {
  const details = [
    `Product: ${productTitle}`,
    manufacturer ? `Manufacturer: ${manufacturer}` : null,
    materials.length > 0 ? `Known materials: ${materials.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: SYSTEM_CONTEXT },
    {
      role: "user",
      content: `Map the supply chain for this product from raw materials to retail:\n\n${details}\n\nFor each stage, identify the type (raw_material, processing, manufacturing, assembly, distribution, retail), the company involved if known, and the geographic location with coordinates if possible.${formatSearchResults(searchResults)}`,
    },
  ];
}

/**
 * Build prompt for extracting company information.
 *
 * @param companyName - The company name.
 * @param searchResults - Optional web search results for grounding.
 * @returns AI message array for structured extraction.
 */
export function buildCompanyPrompt(
  companyName: string,
  searchResults: WebSearchResult[] = [],
): AIMessage[] {
  return [
    { role: "system", content: SYSTEM_CONTEXT },
    {
      role: "user",
      content: `Provide detailed information about the company "${companyName}". Include: description, website, founding year, headquarters location, approximate employee count, revenue, and notable corporate relationships (parent companies, subsidiaries, suppliers, partners).${formatSearchResults(searchResults)}`,
    },
  ];
}

/**
 * Build prompt for generating product summary cards.
 *
 * @param productTitle - The product title.
 * @param productDescription - The product description.
 * @param manufacturer - The manufacturer name.
 * @param materialNames - Known material names.
 * @param companyNames - Known related company names.
 * @param searchResults - Optional web search results for grounding.
 * @returns AI message array for structured extraction.
 */
export function buildSummaryCardsPrompt(
  productTitle: string,
  productDescription: string | null,
  manufacturer: string | null,
  materialNames: string[],
  companyNames: string[],
  searchResults: WebSearchResult[] = [],
): AIMessage[] {
  const details = [
    `Product: ${productTitle}`,
    productDescription ? `Description: ${productDescription}` : null,
    manufacturer ? `Manufacturer: ${manufacturer}` : null,
    materialNames.length > 0 ? `Materials: ${materialNames.join(", ")}` : null,
    companyNames.length > 0 ? `Related companies: ${companyNames.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: SYSTEM_CONTEXT },
    {
      role: "user",
      content: `Generate informative summary cards for this product:\n\n${details}\n\nCreate 3-6 cards covering different aspects: overview, materials, supply chain, company, sustainability, and history. Each card should have a title, 2-4 sentences of content, a category, and an emoji icon.${formatSearchResults(searchResults)}`,
    },
  ];
}

/**
 * Build prompt for researching product history.
 *
 * @param productTitle - The product title.
 * @param manufacturer - The product manufacturer (may be null).
 * @param category - The product category (may be null).
 * @param searchResults - Web search results for grounding.
 * @returns AI message array for structured extraction.
 */
export function buildHistoryPrompt(
  productTitle: string,
  manufacturer: string | null,
  category: string | null,
  searchResults: WebSearchResult[],
): AIMessage[] {
  const details = [
    `Product: ${productTitle}`,
    manufacturer ? `Manufacturer: ${manufacturer}` : null,
    category ? `Category: ${category}` : null,
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: SYSTEM_CONTEXT },
    {
      role: "user",
      content: `Research the history of this product:\n\n${details}\n\nProvide:\n- A narrative (2-4 paragraphs) covering the invention/origin of this product or product category\n- What products preceded it\n- Key milestones in the product's evolution\n- How the product category has evolved over time\n\nCite sources by index number where possible.${formatSearchResults(searchResults)}`,
    },
  ];
}
