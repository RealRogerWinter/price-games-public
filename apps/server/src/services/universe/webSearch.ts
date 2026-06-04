/**
 * Web search abstraction with caching for Product Universe.
 *
 * Wraps Brave Search API with a 7-day SQLite cache to avoid
 * redundant lookups. Falls back to empty results when no API key
 * is configured or on error.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { config } from "../../config";

/** A web search result entry. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Build targeted search queries for a given enrichment step.
 *
 * @param productTitle - The product title.
 * @param manufacturer - The product manufacturer (may be null).
 * @param step - The enrichment step (e.g. "materials", "supply_chain", "history").
 * @returns Array of 2-3 search query strings.
 */
export function buildSearchQueries(
  productTitle: string,
  manufacturer: string | null,
  step: string,
): string[] {
  const product = manufacturer ? `${manufacturer} ${productTitle}` : productTitle;

  switch (step) {
    case "materials":
      return [
        `${product} materials composition`,
        `what is ${productTitle} made of`,
      ];
    case "supply_chain":
      return [
        `${product} supply chain manufacturing`,
        `${product} where is it made factory`,
      ];
    case "company":
      return [
        `${product} company information`,
        `${manufacturer || productTitle} company overview founded`,
      ];
    case "history":
      return [
        `${productTitle} invention history origin`,
        `${productTitle} history evolution`,
        manufacturer ? `${manufacturer} ${productTitle} product history` : `${productTitle} product timeline`,
      ];
    default:
      return [`${product} ${step}`];
  }
}

/**
 * Search for information about a topic, returning cached results if available.
 *
 * Uses the Brave Search API when a key is configured. Returns empty results
 * gracefully when no key is set or on API error.
 *
 * @param db - Database instance.
 * @param query - Search query string.
 * @param cacheTtlMs - Cache TTL in milliseconds (default 7 days).
 * @returns Array of search results.
 */
export async function searchWeb(
  db: DatabaseType,
  query: string,
  cacheTtlMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<WebSearchResult[]> {
  // Check cache first
  const cached = db.prepare(
    "SELECT result_json FROM pu_search_cache WHERE query = ? AND expires_at > datetime('now')"
  ).get(query) as { result_json: string } | undefined;

  if (cached) {
    return JSON.parse(cached.result_json);
  }

  // No API key — graceful no-op
  if (!config.puBraveSearchApiKey) {
    return [];
  }

  try {
    const limit = config.puSearchResultsPerQuery;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": config.puBraveSearchApiKey,
      },
    });

    if (!response.ok) {
      console.error(`[PU] Brave Search API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const body = await response.json() as {
      web?: { results?: { title: string; url: string; description: string }[] };
    };

    const results: WebSearchResult[] = (body.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));

    cacheSearchResults(db, query, results, cacheTtlMs);

    return results;
  } catch (err) {
    console.error("[PU] Web search error:", err);
    return [];
  }
}

/**
 * Store search results in the cache.
 *
 * @param db - Database instance.
 * @param query - The search query.
 * @param results - Results to cache.
 * @param cacheTtlMs - Cache TTL in milliseconds.
 */
export function cacheSearchResults(
  db: DatabaseType,
  query: string,
  results: WebSearchResult[],
  cacheTtlMs: number = 7 * 24 * 60 * 60 * 1000,
): void {
  const expiresAt = new Date(Date.now() + cacheTtlMs).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO pu_search_cache (query, result_json, cached_at, expires_at)
     VALUES (?, ?, datetime('now'), ?)`
  ).run(query, JSON.stringify(results), expiresAt);
}

/**
 * Clear expired cache entries.
 *
 * @param db - Database instance.
 * @returns Number of entries deleted.
 */
export function clearExpiredCache(db: DatabaseType): number {
  const info = db.prepare("DELETE FROM pu_search_cache WHERE expires_at <= datetime('now')").run();
  return info.changes;
}
