/**
 * Periodic session closeout sweep.
 *
 * Sessions are kept open in `analytics_sessions` (ended_at IS NULL) for as
 * long as the visitor remains active. This service runs on a cron and
 * closes any session whose `last_event_at` is older than the idle cutoff
 * (30 min default, 4 h if the visitor has ever played a game), or whose
 * total duration exceeds the absolute cap.
 *
 * On closeout:
 *  - `ended_at` is set to `last_event_at` (NOT `Date.now()` — we don't
 *    invent activity the visitor didn't have).
 *  - `bounced` is computed: games_started == 0 AND (duration < 30s OR
 *    page_view_count <= 1).
 *  - `visitor_profile.last_session_bounced` is mirrored for fast dashboard
 *    queries.
 *  - `visitor_profile.current_session_id` is cleared so the next event
 *    from this visitor opens a fresh session.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import db from "../db";
import { config } from "../config";
import { pruneBotVelocity } from "./botDetection";

/** Threshold below which a non-playing session is considered a bounce. */
const BOUNCE_DURATION_MS = 30 * 1000;

/**
 * Scan for stale open sessions and close them. Safe to call repeatedly.
 *
 * @param now - Epoch ms (exposed for tests).
 * @param database - Optional DB override.
 * @returns Count of sessions closed in this sweep.
 */
export function closeoutStaleSessions(
  now: number = Date.now(),
  database: DatabaseType = db,
): number {
  const idleMs = config.sessionIdleMs;
  const activeIdleMs = config.sessionActiveGameIdleMs;
  const absCapMs = config.sessionAbsoluteCapMs;

  // Join to visitor_profile.ever_played so we apply the right idle window
  // per-visitor. A visitor who has ever played a game gets the 4h idle
  // extension (to cover slow MP lobbies); other visitors get the 30-min
  // idle. Absolute 4h cap applies to everyone.
  const rows = database
    .prepare(
      `SELECT s.id, s.started_at, s.last_event_at, s.games_started,
              s.page_view_count, s.user_id, s.visitor_id,
              COALESCE(vp.ever_played, 0) AS ever_played
         FROM analytics_sessions s
         LEFT JOIN visitor_profile vp ON s.visitor_id = vp.visitor_id
        WHERE s.ended_at IS NULL
          AND (
               (vp.ever_played = 1 AND ? - s.last_event_at > ?)
            OR (COALESCE(vp.ever_played, 0) = 0 AND ? - s.last_event_at > ?)
            OR (? - s.started_at > ?)
          )`,
    )
    .all(now, activeIdleMs, now, idleMs, now, absCapMs) as Array<{
    id: string;
    started_at: number;
    last_event_at: number;
    games_started: number;
    page_view_count: number;
    user_id: string | null;
    visitor_id: string;
    ever_played: number;
  }>;

  if (rows.length === 0) {
    pruneBotVelocity(now);
    return 0;
  }

  const updateSession = database.prepare(
    `UPDATE analytics_sessions
        SET ended_at = ?,
            bounced = ?
      WHERE id = ? AND ended_at IS NULL`,
  );
  const updateProfile = database.prepare(
    `UPDATE visitor_profile
        SET current_session_id = NULL,
            current_session_started = NULL,
            last_session_bounced = ?,
            total_time_ms = total_time_ms + ?
      WHERE visitor_id = ? AND current_session_id = ?`,
  );
  const updateUser = database.prepare(
    `UPDATE users
        SET total_sessions = total_sessions + 1,
            last_session_at = ?
      WHERE id = ?`,
  );

  let closed = 0;
  const tx = database.transaction((closeTs: number) => {
    for (const row of rows) {
      const duration = row.last_event_at - row.started_at;
      const bounced =
        row.games_started === 0 &&
        (duration < BOUNCE_DURATION_MS || row.page_view_count <= 1)
          ? 1
          : 0;
      updateSession.run(row.last_event_at, bounced, row.id);
      updateProfile.run(bounced, duration, row.visitor_id, row.id);
      if (row.user_id) {
        updateUser.run(row.last_event_at, row.user_id);
      }
      closed++;
    }
    void closeTs;
  });
  tx(now);

  pruneBotVelocity(now);
  return closed;
}

/**
 * Purge raw events older than the configured retention window.
 *
 * @param now - Epoch ms (exposed for tests).
 * @param database - Optional DB override.
 * @returns Count of rows deleted.
 */
export function purgeOldEvents(
  now: number = Date.now(),
  database: DatabaseType = db,
): number {
  const cutoff = now - config.eventRetentionDays * 24 * 60 * 60 * 1000;
  const result = database
    .prepare(`DELETE FROM events WHERE ts_server < ?`)
    .run(cutoff);
  return result.changes;
}

/**
 * Start the closeout cron. The caller owns the returned interval handle
 * (e.g. to clear during test teardown or on SIGTERM).
 *
 * @param database - Optional DB override.
 * @returns NodeJS.Timeout for the underlying setInterval.
 */
export function startSessionCloseout(
  database: DatabaseType = db,
): NodeJS.Timeout {
  const handle = setInterval(() => {
    try {
      closeoutStaleSessions(Date.now(), database);
    } catch (err) {
      console.error("Session closeout failed:", err);
    }
  }, config.sessionCloseoutIntervalMs);
  // Don't block process exit on this timer.
  handle.unref?.();
  return handle;
}

/**
 * Start the nightly retention purge. Once a day is enough for a 90-day
 * retention window — the delete fires once and the DB autovacuums under WAL.
 *
 * @param database - Optional DB override.
 * @returns NodeJS.Timeout for the underlying setInterval.
 */
export function startEventRetentionPurge(
  database: DatabaseType = db,
): NodeJS.Timeout {
  const handle = setInterval(() => {
    try {
      const deleted = purgeOldEvents(Date.now(), database);
      if (deleted > 0) {
        console.log(`Analytics retention: purged ${deleted} events`);
      }
    } catch (err) {
      console.error("Event retention purge failed:", err);
    }
  }, 24 * 60 * 60 * 1000);
  handle.unref?.();
  return handle;
}
