/**
 * Pure functions for detecting product data from structured markup on any e-commerce page.
 *
 * Extracts product information from JSON-LD, Open Graph meta tags, and microdata.
 * No DOM access — all inputs are pre-extracted strings/objects.
 *
 * NOTE: This file intentionally does NOT import from ./scraper to avoid creating a
 * shared dependency between content script and popup entry points. Rollup would extract
 * shared code into a separate chunk, which breaks content scripts (they run as plain
 * scripts, not ES modules, and cannot use `import` statements). The two small helper
 * functions (cleanTitle, parsePriceToCents) are inlined below.
 */

/** Decode common HTML entities in a string. */
function decodeHtmlEntities(str: string): string {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&nbsp;": " " };
  return str.replace(/&(?:#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (m) => entities[m] ?? m);
}

/** Clean a product title by trimming whitespace and decoding HTML entities. */
function cleanTitle(raw: string): string {
  return decodeHtmlEntities(raw.trim());
}

/** Parse a price string to cents. Returns null if invalid or out of range ($1-$10,000). */
function parsePriceToCents(str: string): number | null {
  // Take only the first price if a range is given (e.g. "$12.99 - $19.99")
  const first = str.split(/\s*[-–—]\s*/)[0];
  const cleaned = first.replace(/[^0-9.]/g, "");
  const dollars = parseFloat(cleaned);
  if (isNaN(dollars) || dollars < 1 || dollars > 10000) return null;
  return Math.round(dollars * 100);
}

/** Check that a URL uses http: or https: scheme. */
function isSafeImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Product data detected from any e-commerce page's structured markup. */
export interface GenericProduct {
  title: string | null;
  priceCents: number | null;
  currency: string | null;
  imageUrl: string | null;
  brand: string | null;
  url: string | null;
  source: "json-ld" | "opengraph" | "microdata" | null;
}

/**
 * Extract product data from JSON-LD script contents.
 *
 * Handles top-level `@type: "Product"`, `@graph` arrays, and arrays of objects.
 *
 * @param scripts - Array of textContent from `<script type="application/ld+json">` elements.
 * @returns GenericProduct if a Product type is found, null otherwise.
 */
export function extractFromJsonLd(scripts: string[]): GenericProduct | null {
  for (const raw of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const product = findProductInJsonLd(parsed);
    if (product) return product;
  }
  return null;
}

/** Recursively find a Product object in parsed JSON-LD data. */
function findProductInJsonLd(data: unknown): GenericProduct | null {
  if (!data || typeof data !== "object") return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findProductInJsonLd(item);
      if (result) return result;
    }
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Check @graph arrays
  if (Array.isArray(obj["@graph"])) {
    for (const item of obj["@graph"]) {
      const result = findProductInJsonLd(item);
      if (result) return result;
    }
  }

  // Check if this object is a Product
  const type = obj["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
    return extractProductFromJsonLdObject(obj);
  }

  return null;
}

/** Extract GenericProduct fields from a JSON-LD Product object. */
function extractProductFromJsonLdObject(obj: Record<string, unknown>): GenericProduct | null {
  const title = typeof obj.name === "string" ? cleanTitle(obj.name) : null;
  if (!title) return null;

  // Image: string or array (take first), validated to http(s) only
  let imageUrl: string | null = null;
  const rawImage = typeof obj.image === "string" ? obj.image : (Array.isArray(obj.image) && typeof obj.image[0] === "string" ? obj.image[0] : null);
  if (rawImage && isSafeImageUrl(rawImage)) {
    imageUrl = rawImage;
  }

  // Brand: object with .name or plain string, capped at 200 chars
  let brand: string | null = null;
  if (obj.brand && typeof obj.brand === "object" && "name" in (obj.brand as Record<string, unknown>)) {
    brand = String((obj.brand as Record<string, unknown>).name).slice(0, 200);
  } else if (typeof obj.brand === "string") {
    brand = obj.brand.slice(0, 200);
  }

  // Offers: single object or array (take first)
  let priceCents: number | null = null;
  let currency: string | null = null;
  const offers = obj.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (offer && typeof offer === "object") {
    const o = offer as Record<string, unknown>;
    const priceStr = String(o.price ?? o.lowPrice ?? "");
    if (priceStr) {
      priceCents = parsePriceToCents(priceStr);
    }
    if (typeof o.priceCurrency === "string") {
      currency = o.priceCurrency.slice(0, 10);
    }
  }

  const url = typeof obj.url === "string" ? obj.url : null;

  return { title, priceCents, currency, imageUrl, brand, url, source: "json-ld" };
}

/**
 * Extract product data from Open Graph meta tags.
 *
 * Requires at least `og:title` to return a result.
 *
 * @param metaTags - Array of {property, content} from OG/product meta tags.
 * @returns GenericProduct if og:title is present, null otherwise.
 */
export function extractFromOpenGraph(metaTags: { property: string; content: string }[]): GenericProduct | null {
  const map = new Map<string, string>();
  for (const tag of metaTags) {
    map.set(tag.property, tag.content);
  }

  const title = map.get("og:title");
  if (!title) return null;

  const rawImage = map.get("og:image") || null;
  const imageUrl = rawImage && isSafeImageUrl(rawImage) ? rawImage : null;
  const url = map.get("og:url") || null;
  const rawBrand = map.get("product:brand") || null;
  const brand = rawBrand ? rawBrand.slice(0, 200) : null;

  const priceStr = map.get("og:price:amount") || map.get("product:price:amount") || null;
  const priceCents = priceStr ? parsePriceToCents(priceStr) : null;
  const rawCurrency = map.get("og:price:currency") || map.get("product:price:currency") || null;
  const currency = rawCurrency ? rawCurrency.slice(0, 10) : null;

  return { title: cleanTitle(title), priceCents, currency, imageUrl, brand, url, source: "opengraph" };
}

/**
 * Extract product data from microdata (schema.org/Product itemtype).
 *
 * @param items - Array of microdata items with type and flattened properties.
 * @returns GenericProduct if a schema.org/Product item is found, null otherwise.
 */
export function extractFromMicrodata(items: { type: string; properties: Record<string, string> }[]): GenericProduct | null {
  const product = items.find((item) => item.type.includes("schema.org/Product"));
  if (!product) return null;

  const props = product.properties;
  const title = props.name ? cleanTitle(props.name) : null;
  if (!title) return null;

  const priceCents = props.price ? parsePriceToCents(props.price) : null;
  const rawImage = props.image || null;
  const imageUrl = rawImage && isSafeImageUrl(rawImage) ? rawImage : null;
  const brand = props.brand ? props.brand.slice(0, 200) : null;

  return { title, priceCents, currency: null, imageUrl, brand, url: null, source: "microdata" };
}

/**
 * Detect a product from page structured data with priority: JSON-LD > Open Graph > microdata.
 *
 * @param jsonLdScripts - textContent of JSON-LD script elements.
 * @param metaTags - Open Graph / product meta tags.
 * @param microdataItems - Microdata items from the page.
 * @returns The first GenericProduct found with at least a title, or null.
 */
export function detectProduct(
  jsonLdScripts: string[],
  metaTags: { property: string; content: string }[],
  microdataItems: { type: string; properties: Record<string, string> }[],
): GenericProduct | null {
  return extractFromJsonLd(jsonLdScripts) || extractFromOpenGraph(metaTags) || extractFromMicrodata(microdataItems) || null;
}

/** Noise words to strip when building an Amazon search query. */
const NOISE_WORDS = new Set(["buy", "sale", "official", "free", "shipping", "new", "best", "cheap", "deal", "shop", "online", "store"]);

/**
 * Build an Amazon search query from a detected product.
 *
 * Combines brand + title (if brand isn't already in the title), strips noise words,
 * and truncates to ~80 characters / ~8 words.
 *
 * @param product - The detected product.
 * @returns A search query string suitable for Amazon's search bar.
 */
export function buildAmazonSearchQuery(product: GenericProduct): string {
  let query = "";

  const title = product.title ? cleanTitle(product.title) : "";

  // Prepend brand if not already in the title
  if (product.brand && title && !title.toLowerCase().includes(product.brand.toLowerCase())) {
    query = product.brand + " " + title;
  } else {
    query = title;
  }

  // Strip special characters (keep alphanumeric, spaces, hyphens)
  query = query.replace(/[^\w\s-]/g, " ");

  // Remove noise words
  const words = query
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w.toLowerCase()));

  // Truncate to ~8 words
  const truncated = words.slice(0, 8);

  // Join and truncate to ~80 chars
  return truncated.join(" ").slice(0, 80).trim();
}
