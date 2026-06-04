/**
 * Ghost-username reservation helper.
 *
 * Ghost usernames are globally reserved across the site:
 *  - Real users cannot register a username matching an existing ghost.
 *  - Anonymous players cannot pick one as their MP display name.
 *  - PR #194's bot-name generators (botNames + autoLobby/nameGenerator)
 *    must not produce one when generating in-room display names.
 *
 * This module is the single source of truth for the "is this a ghost name?"
 * check. The full ghost-username set is cached in-memory with a 60s TTL
 * to keep the hot path cheap; mutations through the admin API call
 * {@link invalidateReservedNamesCache} so newly-created or deleted ghost
 * names take effect immediately rather than on the next TTL tick.
 *
 * Invariant: the cache stores `username_normalized` values (lowercased,
 * trimmed). All comparisons are case-insensitive.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Cache TTL (ms). 60 seconds — short enough that an admin-just-created
 *  name is reserved for any signup/anon-flow within a minute, even when a
 *  bug bypasses the explicit invalidation hook. */
const CACHE_TTL_MS = 60 * 1000;

let cachedSet: Set<string> | null = null;
let cachedAt = 0;

/**
 * Force the next call to {@link isReservedByGhost} to re-read the DB.
 * Call this from any path that mutates `ghost_users` (bulk-create, patch,
 * delete) so the change is visible without waiting for the TTL.
 */
export function invalidateReservedNamesCache(): void {
  cachedSet = null;
  cachedAt = 0;
}

function loadCache(db: DatabaseType): Set<string> {
  const rows = db
    .prepare("SELECT username_normalized FROM ghost_users")
    .all() as { username_normalized: string }[];
  return new Set(rows.map((r) => r.username_normalized));
}

/**
 * Check whether `name` collides with an existing ghost username.
 *
 * Case-insensitive; trims whitespace. Empty/whitespace-only inputs always
 * return false (they fail other validation upstream).
 *
 * @param db - Database instance.
 * @param name - Untrusted candidate name.
 */
export function isReservedByGhost(db: DatabaseType, name: string): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const now = Date.now();
  if (!cachedSet || now - cachedAt > CACHE_TTL_MS) {
    cachedSet = loadCache(db);
    cachedAt = now;
  }
  return cachedSet.has(normalized);
}
