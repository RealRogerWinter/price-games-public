/**
 * GDPR / CCPA data-subject endpoints for the analytics pipeline.
 *
 * Two operations:
 *  - **Export**: produce a JSON dump of all analytics rows attributable to
 *    a user (via user_id OR via any visitor_id linked to that user through
 *    `visitor_aliases`). Safe to include in a right-to-access response.
 *  - **Forget**: delete all analytics rows for a user, cascading through
 *    `events`, `analytics_sessions`, `visitor_profile`, and
 *    `visitor_aliases`. Rollups already computed into `analytics_hourly`
 *    are NOT recomputed — the dashboards show aggregate counts forever,
 *    but no row can be tied back to the user.
 *
 * Both operations are idempotent.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Shape of the GDPR export JSON. */
export interface GdprExport {
  userId: string;
  exportedAt: string;
  visitors: string[];
  events: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  aliases: Record<string, unknown>[];
}

/**
 * Find every visitor_id associated with a user — the user's direct user_id
 * and every visitor_id merged via `visitor_aliases`. De-duped.
 *
 * @param database - Database instance.
 * @param userId - User id.
 * @returns Array of visitor UUIDs.
 */
export function getLinkedVisitorIds(
  database: DatabaseType,
  userId: string,
): string[] {
  const rows = database
    .prepare(
      `SELECT visitor_id FROM visitor_aliases WHERE user_id = ?
       UNION
       SELECT visitor_id FROM visitor_profile WHERE user_id = ?`,
    )
    .all(userId, userId) as { visitor_id: string }[];
  return rows.map((r) => r.visitor_id);
}

/**
 * Produce a full JSON export of all analytics rows for a user.
 *
 * @param database - Database instance.
 * @param userId - User id.
 * @returns Portable export object.
 */
export function exportGdprData(
  database: DatabaseType,
  userId: string,
): GdprExport {
  const visitors = getLinkedVisitorIds(database, userId);
  const placeholders = visitors.length > 0
    ? visitors.map(() => "?").join(",")
    : "''"; // empty placeholder, never matches

  const events = visitors.length
    ? (database
        .prepare(
          `SELECT * FROM events
            WHERE user_id = ? OR visitor_id IN (${placeholders})`,
        )
        .all(userId, ...visitors) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM events WHERE user_id = ?`)
        .all(userId) as Record<string, unknown>[]);

  const sessions = visitors.length
    ? (database
        .prepare(
          `SELECT * FROM analytics_sessions
            WHERE user_id = ? OR visitor_id IN (${placeholders})`,
        )
        .all(userId, ...visitors) as Record<string, unknown>[])
    : (database
        .prepare(`SELECT * FROM analytics_sessions WHERE user_id = ?`)
        .all(userId) as Record<string, unknown>[]);

  const profiles = visitors.length
    ? (database
        .prepare(
          `SELECT * FROM visitor_profile
            WHERE user_id = ? OR visitor_id IN (${placeholders})`,
        )
        .all(userId, ...visitors) as Record<string, unknown>[])
    : [];

  const aliases = database
    .prepare(`SELECT * FROM visitor_aliases WHERE user_id = ?`)
    .all(userId) as Record<string, unknown>[];

  return {
    userId,
    exportedAt: new Date().toISOString(),
    visitors,
    events,
    sessions,
    profiles,
    aliases,
  };
}

/**
 * Delete every analytics row attributable to a user — cascades through
 * events, analytics_sessions, visitor_profile, and visitor_aliases. Rollups
 * in analytics_hourly retain aggregate counts (un-traceable to the user).
 *
 * @param database - Database instance.
 * @param userId - User id.
 * @returns Delete counts per table.
 */
export function forgetGdprData(
  database: DatabaseType,
  userId: string,
): {
  events: number;
  sessions: number;
  profiles: number;
  aliases: number;
} {
  const visitors = getLinkedVisitorIds(database, userId);
  const placeholders = visitors.length > 0
    ? visitors.map(() => "?").join(",")
    : "''";

  const counts = { events: 0, sessions: 0, profiles: 0, aliases: 0 };

  const tx = database.transaction(() => {
    const eventsQuery = visitors.length
      ? database.prepare(
          `DELETE FROM events
            WHERE user_id = ? OR visitor_id IN (${placeholders})`,
        )
      : database.prepare(`DELETE FROM events WHERE user_id = ?`);
    const r1 = visitors.length
      ? eventsQuery.run(userId, ...visitors)
      : eventsQuery.run(userId);
    counts.events = r1.changes;

    const sessQuery = visitors.length
      ? database.prepare(
          `DELETE FROM analytics_sessions
            WHERE user_id = ? OR visitor_id IN (${placeholders})`,
        )
      : database.prepare(`DELETE FROM analytics_sessions WHERE user_id = ?`);
    const r2 = visitors.length
      ? sessQuery.run(userId, ...visitors)
      : sessQuery.run(userId);
    counts.sessions = r2.changes;

    if (visitors.length) {
      const profQuery = database.prepare(
        `DELETE FROM visitor_profile
          WHERE user_id = ? OR visitor_id IN (${placeholders})`,
      );
      counts.profiles = profQuery.run(userId, ...visitors).changes;
    }

    const aliasQuery = database.prepare(
      `DELETE FROM visitor_aliases WHERE user_id = ?`,
    );
    counts.aliases = aliasQuery.run(userId).changes;
  });
  tx();

  return counts;
}
