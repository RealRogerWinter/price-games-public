/**
 * Image proxy service.
 *
 * Serves product images by fetching them from their stored URLs.
 * Falls back to scraping a live image URL from Amazon if the stored
 * URL is missing or returns a placeholder.
 *
 * @module imageProxy
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Database as DatabaseType } from "better-sqlite3";

// Async variant of execFile so a cold 10s scrape does not block the Node event loop.
// Blocking the loop was causing concurrent image requests to serialize, pushing
// p99 latency past iOS Safari's HTTP/2 stream-stall threshold (~8-10s) where the
// client sends RST_STREAM without firing an `error` event on the <img>.
const execFileAsync = promisify(execFile);

const ALLOWED_IMAGE_DOMAINS = new Set([
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "images-eu.ssl-images-amazon.com",
  "ecx.images-amazon.com",
  "images.amazon.com",
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function isAllowedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_IMAGE_DOMAINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isImageContentType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** LRU-bounded cache for scraped image URLs (ASIN -> real image URL). */
class ImageUrlCache {
  private cache = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize: number = 5000) {
    this.maxSize = maxSize;
  }

  get(asin: string): string | undefined {
    return this.cache.get(asin);
  }

  has(asin: string): boolean {
    return this.cache.has(asin);
  }

  set(asin: string, url: string): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(asin, url);
  }
}

const imageUrlCache = new ImageUrlCache();

/** M3 fix: cache ASINs that failed to scrape to avoid repeated curl calls. */
const failedScrapeCache = new Map<string, number>();
const FAILED_SCRAPE_TTL_MS = 60 * 60 * 1000; // 1 hour

function hasRecentlyFailedScrape(asin: string): boolean {
  const failedAt = failedScrapeCache.get(asin);
  if (!failedAt) return false;
  if (Date.now() - failedAt > FAILED_SCRAPE_TTL_MS) {
    failedScrapeCache.delete(asin);
    return false;
  }
  return true;
}

/** Strict ASIN format: 10 alphanumeric characters. */
const ASIN_REGEX = /^[A-Z0-9]{10}$/i;

/**
 * Scrape a real image URL from an Amazon product page.
 *
 * Uses curl via promisified execFile (array args, no shell) to avoid command
 * injection. Runs asynchronously so a slow upstream scrape does not block the
 * Node event loop for other concurrent requests.
 *
 * @param asin - Amazon Standard Identification Number.
 * @returns The scraped image URL, or null if scraping failed.
 */
async function scrapeImageUrl(asin: string): Promise<string | null> {
  if (!ASIN_REGEX.test(asin)) return null;
  if (hasRecentlyFailedScrape(asin)) return null;

  try {
    const { stdout: html } = await execFileAsync("curl", [
      "-s", "-L", "--max-time", "10",
      "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "-H", "Accept: text/html",
      "-H", "Accept-Language: en-US,en;q=0.9",
      "-H", "Accept-Encoding: identity",
      "-H", "Sec-Fetch-Dest: document",
      "-H", "Sec-Fetch-Mode: navigate",
      "-H", "Sec-Fetch-Site: none",
      "-b", "session-id=000-0000000-0000000",
      `https://www.amazon.com/dp/${asin}`,
    ], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });

    const hiRes = html.match(/"hiRes":"(https:\/\/[^"]+)"/);
    if (hiRes && isAllowedImageUrl(hiRes[1])) return hiRes[1];
    const large = html.match(/"large":"(https:\/\/[^"]+)"/);
    if (large && isAllowedImageUrl(large[1])) return large[1];
    const og = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
    if (og && isAllowedImageUrl(og[1])) return og[1];
    failedScrapeCache.set(asin, Date.now());
    return null;
  } catch {
    failedScrapeCache.set(asin, Date.now());
    return null;
  }
}

/**
 * Fetch a product image, optionally scraping a fresh URL from Amazon.
 *
 * Tries the stored image_url first. If the response is a tiny placeholder (<1KB),
 * attempts to scrape the real image from Amazon's product page.
 *
 * @param productId - The product ID to fetch the image for.
 * @param db - Database instance.
 * @returns Object with buffer, contentType, and cacheability, or null if not found.
 */
export async function fetchProductImage(
  productId: string,
  db: DatabaseType
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const row = db
    .prepare("SELECT image_url, asin FROM products WHERE id = ?")
    .get(productId) as { image_url: string; asin: string } | undefined;

  if (!row) return null;

  let imageUrl = row.image_url;

  // Check cache for a scraped URL
  if (row.asin && imageUrlCache.has(row.asin)) {
    imageUrl = imageUrlCache.get(row.asin)!;
  }

  // If no image URL stored (or empty), scrape one from Amazon
  if (!imageUrl && row.asin) {
    const realUrl = await scrapeImageUrl(row.asin);
    if (realUrl) {
      imageUrl = realUrl;
      imageUrlCache.set(row.asin, realUrl);
      db.prepare("UPDATE products SET image_url = ? WHERE asin = ?").run(realUrl, row.asin);
    }
  }

  if (!imageUrl || !isAllowedImageUrl(imageUrl)) return null;

  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) return null;

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) return null;

  // If image is tiny (<1KB), it's likely a placeholder — try scraping the real image
  if (buffer.length < 1000 && row.asin && !imageUrlCache.has(row.asin)) {
    const realUrl = await scrapeImageUrl(row.asin);
    if (realUrl) {
      imageUrlCache.set(row.asin, realUrl);
      db.prepare("UPDATE products SET image_url = ? WHERE asin = ?").run(realUrl, row.asin);
      const realResponse = await fetch(realUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (realResponse.ok) {
        const realContentLength = Number(realResponse.headers.get("content-length") || 0);
        if (realContentLength <= MAX_IMAGE_BYTES) {
          const realBuffer = Buffer.from(await realResponse.arrayBuffer());
          if (realBuffer.length <= MAX_IMAGE_BYTES) {
            const ct = realResponse.headers.get("content-type") || "image/jpeg";
            return { buffer: realBuffer, contentType: isImageContentType(ct) ? ct : "image/jpeg" };
          }
        }
      }
    }
  }

  const ct = response.headers.get("content-type") || "image/jpeg";
  return { buffer, contentType: isImageContentType(ct) ? ct : "image/jpeg" };
}
