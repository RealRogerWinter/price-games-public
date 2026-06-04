/**
 * Manufacturer extraction module.
 *
 * Extracts manufacturer/brand names from product titles using a combination
 * of a known-brands dictionary, alias mapping, and heuristic first-word
 * extraction. Designed to handle the 125 seed products and future scraped
 * products.
 *
 * @module extract-manufacturers
 */

import type { ManufacturerExtraction, ProductRow, Confidence } from "./types";

/**
 * Multi-word brand names that must be matched before single-word extraction.
 * Sorted longest-first so "Amazon Basics" matches before "Amazon".
 */
export const MULTI_WORD_BRANDS: string[] = [
  "Amazon Basics",
  "Black Diamond",
  "CAP Barbell",
  "Exploding Kittens",
  "Fit Simplify",
  "Hasbro Gaming",
  "Holy Stone",
  "Hydro Flask",
  "Instant Pot",
  "Iron Flask",
  "La Roche-Posay",
  "Magna-Tiles",
  "Mighty Patch",
  "Our Place",
  "Paula's Choice",
  "Sushi Go",
  "Te-Rich",
  "TETON Sports",
  "The North Face",
].sort((a, b) => b.length - a.length);

/**
 * Single-word brand names recognized with high confidence.
 * Includes all brands found in the seed product data.
 */
export const SINGLE_WORD_BRANDS: string[] = [
  "Amazon",
  "Apple",
  "Aquaphor",
  "Aveeno",
  "BalanceFrom",
  "Bioderma",
  "Bose",
  "Bowflex",
  "Brita",
  "CeraVe",
  "Cetaphil",
  "Coleman",
  "Corsair",
  "COSORI",
  "COSRX",
  "Crest",
  "Cuisinart",
  "Dove",
  "Dyson",
  "EltaMD",
  "Ember",
  "Etekcity",
  "FLYBIRD",
  "Gaiam",
  "GoSports",
  "Hydro",
  "KitchenAid",
  "Klymit",
  "Keurig",
  "Kryptonite",
  "LEGO",
  "LifeStraw",
  "Lodge",
  "Logitech",
  "Manduka",
  "Neutrogena",
  "Ninja",
  "Nintendo",
  "Oral-B",
  "Osprey",
  "Owala",
  "OXO",
  "PlayStation",
  "Ravensburger",
  "Razer",
  "REVLON",
  "Sabrent",
  "Samsung",
  "Sensodyne",
  "SKLZ",
  "Sony",
  "Speedo",
  "Stanley",
  "T-fal",
  "Thayers",
  "ThinkFun",
  "ThermoWorks",
  "TriggerPoint",
  "Victorinox",
  "Vitamix",
  "Waterpik",
  "Wusthof",
  "YETI",
];

/**
 * Combined list of all known brands (multi-word + single-word).
 * Used for external checks (e.g., tests).
 */
export const KNOWN_BRANDS: string[] = [
  ...MULTI_WORD_BRANDS,
  ...SINGLE_WORD_BRANDS,
];

/**
 * Aliases that map sub-brands or product lines to their parent company.
 * The key is the name found in the title; the value is the canonical manufacturer.
 */
export const BRAND_ALIASES: Record<string, string> = {
  "Amazon Basics": "Amazon",
  "Amazon Echo": "Amazon",
  "Echo": "Amazon",
  "Echo Dot": "Amazon",
  "Echo Show": "Amazon",
  "Fire TV": "Amazon",
  "PlayStation": "Sony",
  "Hasbro Gaming": "Hasbro",
  "Sushi Go": "Gamewright",
  "Pandemic": "Z-Man Games",
  "Risk": "Hasbro",
  "Monopoly": "Hasbro",
  "CATAN": "Catan Studio",
};

/**
 * Canonical casing for brands that appear in ALL-CAPS in titles.
 * If not in this map, the original casing from the title is preserved.
 */
const CANONICAL_CASE: Record<string, string> = {
  samsung: "Samsung",
  revlon: "Revlon",
};

/**
 * Extract a manufacturer/brand name from a single product title.
 *
 * Strategy:
 * 1. Check for multi-word brand matches (longest first)
 * 2. Check for single-word brand matches
 * 3. Fall back to first word of the title (low confidence)
 *
 * @param title - Product title string.
 * @returns Object with manufacturer name and confidence level.
 */
export function extractManufacturer(
  title: string
): { manufacturer: string; confidence: Confidence } {
  const trimmed = title.trim();

  // 1. Check multi-word brands (longest first, already sorted)
  for (const brand of MULTI_WORD_BRANDS) {
    if (trimmed.startsWith(brand) || trimmed.toLowerCase().startsWith(brand.toLowerCase())) {
      const resolved = BRAND_ALIASES[brand] ?? brand;
      return { manufacturer: resolved, confidence: "high" };
    }
  }

  // 2. Check aliases not already covered by MULTI_WORD_BRANDS
  const multiWordSet = new Set(MULTI_WORD_BRANDS.map((b) => b.toLowerCase()));
  for (const [alias, canonical] of Object.entries(BRAND_ALIASES)) {
    if (multiWordSet.has(alias.toLowerCase())) continue;
    if (trimmed.startsWith(alias) || trimmed.toLowerCase().startsWith(alias.toLowerCase())) {
      return { manufacturer: canonical, confidence: "high" };
    }
  }

  // 3. Check single-word known brands
  for (const brand of SINGLE_WORD_BRANDS) {
    const lower = brand.toLowerCase();
    // Match at start of title, followed by space or end
    if (
      trimmed.startsWith(brand + " ") ||
      trimmed.toLowerCase().startsWith(lower + " ") ||
      trimmed === brand ||
      trimmed.toLowerCase() === lower
    ) {
      // Resolve alias if needed
      const resolved = BRAND_ALIASES[brand] ?? brand;
      // Apply canonical casing
      const canonical = CANONICAL_CASE[resolved.toLowerCase()] ?? resolved;
      return { manufacturer: canonical, confidence: "high" };
    }
  }

  // 4. Fallback: first word (or first hyphenated word) as low-confidence guess
  const firstWord = trimmed.split(/\s+/)[0];
  if (firstWord) {
    const canonical =
      CANONICAL_CASE[firstWord.toLowerCase()] ?? firstWord;
    return { manufacturer: canonical, confidence: "low" };
  }

  return { manufacturer: "Unknown", confidence: "low" };
}

/**
 * Extract manufacturers from a list of products.
 *
 * If a product already has a `manufacturer` field set, it is used directly
 * with high confidence. Otherwise, the manufacturer is extracted from the title.
 *
 * @param products - Array of product rows from the database.
 * @returns Array of ManufacturerExtraction results (one per product).
 */
export function extractManufacturersFromProducts(
  products: ProductRow[]
): ManufacturerExtraction[] {
  return products.map((product) => {
    // Use existing manufacturer field if present
    if (product.manufacturer) {
      return {
        productId: product.id,
        productTitle: product.title,
        asin: product.asin,
        manufacturer: product.manufacturer,
        confidence: "high" as Confidence,
      };
    }

    const { manufacturer, confidence } = extractManufacturer(product.title);
    return {
      productId: product.id,
      productTitle: product.title,
      asin: product.asin,
      manufacturer,
      confidence,
    };
  });
}

/**
 * Aggregate extractions into unique manufacturers with product counts.
 *
 * @param extractions - Array of ManufacturerExtraction results.
 * @returns Map of manufacturer name to product count.
 */
export function aggregateManufacturers(
  extractions: ManufacturerExtraction[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ext of extractions) {
    counts.set(ext.manufacturer, (counts.get(ext.manufacturer) ?? 0) + 1);
  }
  return counts;
}
