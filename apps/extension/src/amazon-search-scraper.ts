/**
 * Pure functions for scraping Amazon search results from the DOM.
 *
 * Designed to be injected into an Amazon search results page and extract
 * structured product data for matching against detected products.
 *
 * NOTE: This file intentionally does NOT import from ./scraper to avoid creating
 * a shared dependency between content script entry points. Rollup would extract
 * shared code into a separate chunk, which breaks content scripts (they run as
 * plain scripts, not ES modules, and cannot use `import` statements).
 */

/** Parse a price string to cents (inlined to avoid shared-module code splitting). */
function parsePriceToCents(str: string): number | null {
  // Take only the first price if a range is given (e.g. "$12.99 - $19.99")
  const first = str.split(/\s*[-–—]\s*/)[0];
  const cleaned = first.replace(/[^0-9.]/g, "");
  const dollars = parseFloat(cleaned);
  if (isNaN(dollars) || dollars < 1 || dollars > 10000) return null;
  return Math.round(dollars * 100);
}

/** A single Amazon search result with ASIN, title, price, image, and URL. */
export interface AmazonSearchResult {
  asin: string;
  title: string;
  priceCents: number | null;
  imageUrl: string | null;
  productUrl: string;
}

/** Maximum number of search results to return. */
const MAX_RESULTS = 10;

/** Pattern for valid 10-character ASINs. */
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * Scrape Amazon search results from the current page DOM.
 *
 * Queries elements with `[data-asin]`, extracts product data from each,
 * and returns up to 10 results with valid ASINs and titles. Uses multiple
 * fallback selectors for each field to handle Amazon's varied DOM structures.
 *
 * @returns Array of AmazonSearchResult objects.
 */
export function scrapeSearchResults(): AmazonSearchResult[] {
  const results: AmazonSearchResult[] = [];
  const seen = new Set<string>();
  const elements = document.querySelectorAll("[data-asin]");

  for (const el of elements) {
    if (results.length >= MAX_RESULTS) break;

    const asin = el.getAttribute("data-asin") || "";
    if (!ASIN_PATTERN.test(asin)) continue;
    if (seen.has(asin)) continue;
    seen.add(asin);

    // Title: use .a-text-normal first (the actual product name), then fall back
    let title: string | undefined;
    for (const sel of [
      "h2 .a-text-normal",
      '[data-cy="title-recipe"] .a-text-normal',
      "h2 a span",
      "h2 span",
    ]) {
      const titleEl = el.querySelector(sel);
      const text = titleEl?.textContent?.trim();
      // Skip very short strings (likely badges like "Sponsored")
      if (text && text.length > 5) { title = text; break; }
    }
    if (!title) continue;

    // Price: target the current/sale price, NOT the strikethrough/list price.
    // Amazon marks the current price with data-a-color="base" or without
    // data-a-strike="true". The strikethrough price has data-a-strike="true".
    let priceCents: number | null = null;
    for (const sel of [
      '.a-price:not([data-a-strike="true"]) > .a-offscreen',
      '.a-price[data-a-color="base"] > .a-offscreen',
      ".a-price > .a-offscreen",
    ]) {
      const priceEl = el.querySelector(sel);
      if (priceEl?.textContent) {
        priceCents = parsePriceToCents(priceEl.textContent);
        if (priceCents !== null) break;
      }
    }
    if (priceCents === null) {
      // Fallback: assemble from whole + fraction parts (skip strikethrough)
      const priceContainer = el.querySelector('.a-price:not([data-a-strike="true"])') || el.querySelector(".a-price");
      if (priceContainer) {
        const whole = priceContainer.querySelector(".a-price-whole")?.textContent?.replace(/[^0-9]/g, "");
        const fraction = priceContainer.querySelector(".a-price-fraction")?.textContent?.trim();
        if (whole) {
          priceCents = parsePriceToCents(`${whole}.${fraction || "00"}`);
        }
      }
    }

    // Image: try multiple selectors
    let imageUrl: string | null = null;
    for (const sel of ['img[src*="media-amazon"]', "img.s-image", ".s-product-image-container img"]) {
      const imgEl = el.querySelector(sel) as HTMLImageElement | null;
      if (imgEl?.src) {
        imageUrl = imgEl.src;
        break;
      }
    }

    // Product URL from link containing /dp/
    let productUrl = `https://www.amazon.com/dp/${asin}`;
    const linkEl = el.querySelector('a[href*="/dp/"]') as HTMLAnchorElement | null;
    if (linkEl?.href) {
      try {
        const url = new URL(linkEl.href, "https://www.amazon.com");
        productUrl = url.origin + url.pathname;
      } catch {
        // Use default URL
      }
    }

    results.push({ asin, title, priceCents, imageUrl, productUrl });
  }

  return results;
}
