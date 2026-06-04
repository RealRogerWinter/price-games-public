/**
 * Source tracking service for Product Universe.
 *
 * Records where data comes from (URLs) so every fact in the knowledge
 * graph is traceable. Sources are referenced via source_id FK.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Insert or retrieve a source URL.
 *
 * @param db - Database instance.
 * @param url - Source URL.
 * @param title - Optional page title.
 * @returns The source ID.
 */
export function upsertSource(db: DatabaseType, url: string, title?: string | null): number {
  db.prepare(
    "INSERT OR IGNORE INTO pu_sources (url, title) VALUES (?, ?)"
  ).run(url, title ?? null);
  const row = db.prepare("SELECT id FROM pu_sources WHERE url = ?").get(url) as { id: number };
  return row.id;
}

/**
 * Get a source by ID.
 *
 * @param db - Database instance.
 * @param id - Source ID.
 * @returns The source record or undefined.
 */
export function getSource(db: DatabaseType, id: number) {
  return db.prepare("SELECT * FROM pu_sources WHERE id = ?").get(id) as {
    id: number;
    url: string;
    title: string | null;
    fetched_at: string;
    content_hash: string | null;
  } | undefined;
}
