/**
 * Pure scraping/parsing functions for Amazon product data.
 *
 * These functions contain no DOM access or Chrome API calls, making them
 * fully testable in a Node.js environment.
 */

/**
 * Extract an ASIN from an Amazon product URL.
 *
 * @param url - Amazon URL (e.g. https://www.amazon.com/dp/B0TESTTEST)
 * @returns The 10-character ASIN, or null if not found.
 */
export function extractAsinFromUrl(url: string): string | null {
  const match = url.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

/**
 * Parse a price string to cents.
 *
 * @param str - Price string (e.g. "$1,299.99", "$29.99")
 * @returns Price in cents, or null if invalid or out of range ($1-$10,000).
 */
export function parsePriceToCents(str: string): number | null {
  const cleaned = str.replace(/[^0-9.]/g, "");
  const dollars = parseFloat(cleaned);
  if (isNaN(dollars) || dollars < 1 || dollars > 10000) return null;
  return Math.round(dollars * 100);
}

/**
 * Clean a product title by trimming whitespace and decoding HTML entities.
 *
 * @param raw - Raw title string.
 * @returns Cleaned title.
 */
export function cleanTitle(raw: string): string {
  return decodeHtmlEntities(raw.trim());
}

/**
 * Clean a manufacturer/brand string.
 *
 * Strips common Amazon patterns like "Visit the X Store" and "Brand: X".
 *
 * @param raw - Raw manufacturer string from Amazon.
 * @returns Cleaned manufacturer name.
 */
export function cleanManufacturer(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^Visit the\s+/i, "").replace(/\s+Store$/i, "");
  cleaned = cleaned.replace(/^Brand:\s*/i, "");
  return cleaned.trim();
}

/** Decode common HTML entities in a string. */
function decodeHtmlEntities(str: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&#x27;": "'",
    "&nbsp;": " ",
  };
  return str.replace(/&(?:#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match) => {
    return entities[match] ?? match;
  });
}

/** Known Amazon product categories mapped from breadcrumb text. */
const CATEGORY_MAP: Record<string, string> = {
  "Electronics": "Electronics",
  "Computers & Accessories": "Electronics",
  "Cell Phones & Accessories": "Electronics",
  "Camera & Photo": "Electronics",
  "Home & Kitchen": "Home & Kitchen",
  "Kitchen & Dining": "Home & Kitchen",
  "Home Improvement": "Home & Kitchen",
  "Tools & Home Improvement": "Tools & Home Improvement",
  "Sports & Outdoors": "Sports & Outdoors",
  "Exercise & Fitness": "Sports & Outdoors",
  "Toys & Games": "Toys & Games",
  "Beauty & Personal Care": "Beauty & Personal Care",
  "Health & Household": "Beauty & Personal Care",
  "Pet Supplies": "Pet Supplies",
  "Baby": "Baby & Kids",
  "Clothing, Shoes & Jewelry": "Clothing & Accessories",
  "Automotive": "Automotive",
  "Books": "Books",
  "Office Products": "Office Products",
  "Grocery & Gourmet Food": "Grocery",
  "Patio, Lawn & Garden": "Garden & Outdoor",
  "Musical Instruments": "Musical Instruments",
  "Industrial & Scientific": "Industrial",
  "Arts, Crafts & Sewing": "Arts & Crafts",
  "Appliances": "Appliances",
  "Video Games": "Video Games",
};

/**
 * Map a breadcrumb text to a known product category.
 *
 * @param breadcrumbs - Array of breadcrumb strings from Amazon.
 * @returns Best matching category, or null if no match.
 */
export function mapBreadcrumbsToCategory(breadcrumbs: string[]): string | null {
  for (const crumb of breadcrumbs) {
    const trimmed = crumb.trim();
    if (CATEGORY_MAP[trimmed]) return CATEGORY_MAP[trimmed];
  }
  return null;
}

/**
 * Upgrade an Amazon image URL to high resolution.
 *
 * @param url - Original Amazon image URL.
 * @returns URL upgraded to 1500px resolution.
 */
export function upgradeImageUrl(url: string): string {
  return url.replace(/\._[A-Z]{2}_[A-Z0-9_]+_\./, "._AC_SL1500_.");
}
