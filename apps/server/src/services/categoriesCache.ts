import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Minimum number of active products a category must contain to appear in
 * the selector. Hides sparse/dud buckets that would make for a thin round
 * pool. Was previously inlined in routes/game.ts; lives here now since the
 * cache is the only consumer.
 */
const MIN_CATEGORY_PRODUCTS = 15;

/**
 * In-process TTL cache for the active product-category lists. The
 * underlying queries are read-mostly (categories change only when an admin
 * creates/edits/archives/restores a product) but were called on every
 * `/api/game/categories` GET, every `/api/game/start` POST (validation),
 * and every multiplayer `room:create` (also validation). PR1 perf F4
 * caches the result for 60s and invalidates on admin product mutations.
 *
 * Process-local — multiple server replicas would each maintain their own
 * cache. That's fine: an admin product change picks up on the next TTL
 * expiry per replica (≤60s) which is well within UX tolerance for what is
 * effectively a categorization metadata read.
 */

const TTL_MS = 60_000;

type WithCount = { name: string; count: number };

let validNamesCache: { value: Set<string>; expiresAt: number } | null = null;
let withCountsCache: { value: WithCount[]; expiresAt: number } | null = null;

/**
 * Names of categories with at least one active product. Used by hot-path
 * validation in single-player game start and multiplayer room create.
 */
export function getValidCategoryNames(db: DatabaseType): Set<string> {
  const now = Date.now();
  if (validNamesCache && validNamesCache.expiresAt > now) {
    return validNamesCache.value;
  }
  const rows = db
    .prepare("SELECT DISTINCT category FROM products WHERE is_active = 1")
    .all() as { category: string | null }[];
  const set = new Set<string>();
  for (const r of rows) {
    if (r.category) set.add(r.category);
  }
  validNamesCache = { value: set, expiresAt: now + TTL_MS };
  return set;
}

/**
 * Categories with their active product count, filtered to those that have
 * at least `MIN_CATEGORY_PRODUCTS` to be selectable. Drives the
 * `/api/game/categories` listing.
 */
export function getCategoriesWithCounts(db: DatabaseType): WithCount[] {
  const now = Date.now();
  if (withCountsCache && withCountsCache.expiresAt > now) {
    return withCountsCache.value;
  }
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) as count
         FROM products
        WHERE is_active = 1
          AND category IS NOT NULL
          AND TRIM(category) != ''
        GROUP BY category
       HAVING COUNT(*) >= ?
        ORDER BY category`,
    )
    .all(MIN_CATEGORY_PRODUCTS) as { category: string; count: number }[];
  const value = rows.map((r) => ({ name: r.category, count: r.count }));
  withCountsCache = { value, expiresAt: now + TTL_MS };
  return value;
}

/**
 * Drop both cached values. Call from admin code paths that mutate the
 * `products` table (create/update/archive/restore) so the next read sees
 * fresh data. Cheap — invalidates pointers, doesn't query.
 */
export function invalidateCategoriesCache(): void {
  validNamesCache = null;
  withCountsCache = null;
}
