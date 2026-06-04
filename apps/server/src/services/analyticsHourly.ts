/**
 * Hourly pre-aggregation for analytics dashboards.
 *
 * Dashboards NEVER full-scan the `events` table directly — they read from
 * `analytics_hourly`, which is rebuilt for the last 48 hours on a cron.
 * The 48h window absorbs late-arriving events (client beacons from
 * suspended phones, etc.) without ever-expanding the rebuild scope.
 *
 * Rollup grain:
 *   (hour_bucket_utc_ms, device_type, is_logged_in, country, acquisition_source)
 *
 * `acquisition_source` is derived from `analytics_sessions.entry_utm_source`
 * + `entry_utm_medium` via {@link classifyAcquisition}, which classifies
 * into: "paid", "organic", "social", "email", "referral", "direct",
 * "unknown".
 */

import type { Database as DatabaseType } from "better-sqlite3";
import db from "../db";
import { config } from "../config";
import { classifyAcquisition } from "./eventLog";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-DB mutex. Each caller awaits the prior rebuild's completion
 * before starting its own. Keyed on the DatabaseType handle so
 * different DBs (e.g. parallel test fixtures) don't share a chain
 * with the production handle.
 *
 * Why this exists: rebuildHourlyRange does DELETE-then-aggregate.
 * If a second caller starts after the first's DELETE but before its
 * INSERT, the second sees an empty range and aggregates only the
 * second's window — the first's INSERT then blindly overwrites the
 * second's result for any overlapping bucket. The mutex serializes
 * callers so each rebuild observes a consistent input set.
 *
 * Implementation: a Promise chain. Each call replaces the chain with
 * `prev.then(() => doWork())`, so callers are dispatched in arrival
 * order and any thrown error in doWork is caught (so a failure in
 * one rebuild doesn't poison the chain forever).
 */
const rebuildChains = new WeakMap<DatabaseType, Promise<unknown>>();

/**
 * Test-only handle to the per-DB chain map. Exposed so stress tests
 * can inject artificial pauses / rejections into the chain to verify
 * the mutex semantics (serialization, error isolation) — better-sqlite3
 * is synchronous, so without an injected async boundary the mutex's
 * effect can't be observed in a unit test. Underscore prefix flags
 * the API contract: do not consume from production code.
 *
 * Explicit type annotation rather than inferred — without it tsc
 * emits TS4023 ("uses name 'BetterSqlite3.Database' from external
 * module ... but cannot be named") on declaration emit.
 */
export const __test_rebuildChains: WeakMap<DatabaseType, Promise<unknown>> =
  rebuildChains;

/**
 * Async rebuild — serializes concurrent callers via the per-DB mutex.
 * Callers from the cron, the admin trigger, or the test suite all
 * land here; whichever lost the race waits for the in-flight rebuild
 * to finish before starting its own.
 *
 * @param startBucket - First hour bucket (ms, inclusive).
 * @param endBucket - Last hour bucket (ms, inclusive).
 * @param database - Optional DB override.
 * @returns Count of rows written.
 */
export async function rebuildHourlyRangeAsync(
  startBucket: number,
  endBucket: number,
  database: DatabaseType = db,
): Promise<number> {
  const prev = rebuildChains.get(database) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      // Swallow — a prior caller's failure must not poison this one.
      // The original error has already surfaced to its caller.
    })
    .then(() => doRebuildHourlyRange(startBucket, endBucket, database));
  rebuildChains.set(database, next);
  return next;
}

/**
 * Rebuild the hourly rollup for a [startBucket, endBucket] range.
 * Both values are inclusive epoch-ms hour boundaries.
 *
 * Synchronous entry-point retained for callers who can guarantee no
 * concurrent invocation (e.g. unit tests that own their DB handle).
 * For any caller reachable from the cron OR an admin trigger OR
 * multi-test-runner concurrency, prefer {@link rebuildHourlyRangeAsync}.
 *
 * @param startBucket - First hour bucket (ms).
 * @param endBucket - Last hour bucket (ms).
 * @param database - Optional DB override.
 * @returns Count of rows written.
 */
export function rebuildHourlyRange(
  startBucket: number,
  endBucket: number,
  database: DatabaseType = db,
): number {
  return doRebuildHourlyRange(startBucket, endBucket, database);
}

function doRebuildHourlyRange(
  startBucket: number,
  endBucket: number,
  database: DatabaseType,
): number {
  if (startBucket > endBucket) return 0;

  // Wrap the entire DELETE + aggregate + INSERT in one transaction so
  // a reader between the DELETE and the INSERT can't see an empty
  // window. Without this, dashboards refreshed mid-rebuild would
  // briefly show zero counts. better-sqlite3's `.transaction()`
  // returns a function that runs its body atomically.
  let written = 0;
  const tx = database.transaction(() => {
    written = doRebuildHourlyRangeTransactional(startBucket, endBucket, database);
  });
  tx();
  return written;
}

function doRebuildHourlyRangeTransactional(
  startBucket: number,
  endBucket: number,
  database: DatabaseType,
): number {
  // Clear the range first so a re-run is idempotent.
  database
    .prepare(`DELETE FROM analytics_hourly WHERE hour_bucket BETWEEN ? AND ?`)
    .run(startBucket, endBucket);

  // Sessions aggregation: one row per session, counted in the bucket of
  // its started_at. A session that spans multiple hours still counts once
  // toward sessions/new_sessions; event-level counts come from the events
  // join below.
  const sessionRows = database
    .prepare(
      `SELECT ((started_at / ?) * ?) AS hour_bucket,
              device_type,
              CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END AS is_logged_in,
              COALESCE(country, 'unknown') AS country,
              entry_utm_source,
              entry_utm_medium,
              COUNT(*) AS sessions,
              SUM(CASE WHEN is_returning = 0 THEN 1 ELSE 0 END) AS new_sessions,
              SUM(COALESCE(bounced, 0)) AS bounced_sessions,
              SUM(event_count) AS events_count,
              SUM(page_view_count) AS page_views,
              SUM(games_started) AS games_started,
              SUM(games_completed) AS games_completed,
              SUM(signup_occurred) AS signups,
              SUM(login_occurred) AS logins
         FROM analytics_sessions
        WHERE started_at BETWEEN ? AND ?
          AND is_bot = 0
        GROUP BY hour_bucket, device_type, is_logged_in, country,
                 entry_utm_source, entry_utm_medium`,
    )
    .all(HOUR_MS, HOUR_MS, startBucket, endBucket + HOUR_MS - 1) as Array<{
    hour_bucket: number;
    device_type: string;
    is_logged_in: number;
    country: string;
    entry_utm_source: string | null;
    entry_utm_medium: string | null;
    sessions: number;
    new_sessions: number;
    bounced_sessions: number;
    events_count: number;
    page_views: number;
    games_started: number;
    games_completed: number;
    signups: number;
    logins: number;
  }>;

  // Synthetic-events aggregation: backfilled rows in the events table that
  // carry is_synthetic = 1. They have no analytics_sessions row (the
  // backfill script intentionally skips that to keep session/cohort/funnel
  // metrics clean), so they're invisible to the loop above. Aggregate them
  // separately and merge into the same rollup buckets so headline count
  // metrics (games_started / games_completed) still see them.
  //
  // Synthetic events have no real device_type / country / utm context, so
  // they bucket as ('unknown', is_logged_in, 'unknown', 'unknown'). When a
  // dashboard filters by device='desktop' or country='US', synthetic data
  // is correctly excluded by the filter — the unknown bucket is honest.
  // For SYNTHETIC events the rollup reads daily_completed directly because
  // the backfill writes ONLY daily_completed (not a parallel
  // game_completed/mp_game_completed) for daily plays — so the row-count is
  // one event per completion. For LIVE events the daily_completed marker
  // fires alongside the underlying game_completed / mp_game_completed
  // (which is what bumps analytics_sessions.games_completed in the
  // standard rollup path). The two paths never overlap on the same row,
  // so daily_completed appearing in the CASE here can't double-count
  // live data — synthetic events are filtered by is_synthetic = 1 below.
  const syntheticRows = database
    .prepare(
      `SELECT ((ts_server / ?) * ?) AS hour_bucket,
              CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END AS is_logged_in,
              SUM(CASE WHEN event_name IN ('game_started','mp_game_started','daily_started')
                       THEN 1 ELSE 0 END) AS games_started,
              SUM(CASE WHEN event_name IN ('game_completed','mp_game_completed','daily_completed')
                       THEN 1 ELSE 0 END) AS games_completed
         FROM events
        WHERE ts_server BETWEEN ? AND ?
          AND is_synthetic = 1
          AND is_bot = 0
        GROUP BY hour_bucket, is_logged_in`,
    )
    .all(HOUR_MS, HOUR_MS, startBucket, endBucket + HOUR_MS - 1) as Array<{
    hour_bucket: number;
    is_logged_in: number;
    games_started: number;
    games_completed: number;
  }>;

  if (sessionRows.length === 0 && syntheticRows.length === 0) return 0;

  const insert = database.prepare(
    `INSERT OR REPLACE INTO analytics_hourly (
       hour_bucket, device_type, is_logged_in, country, acquisition_source,
       sessions, new_sessions, bounced_sessions, events_count, page_views,
       games_started, games_completed, signups, logins
     ) VALUES (
       @hour, @device, @loggedIn, @country, @acq,
       @sessions, @newSessions, @bounced, @events, @pageViews,
       @gamesStarted, @gamesCompleted, @signups, @logins
     )`,
  );

  // Because acquisition_source is a classified bucket (not a raw utm_source),
  // multiple rows from the SQL group-by may collapse onto the same output
  // key. Sum them in-memory before writing.
  type AggKey = string;
  const agg = new Map<AggKey, {
    hour: number;
    device: string;
    loggedIn: number;
    country: string;
    acq: string;
    sessions: number;
    newSessions: number;
    bounced: number;
    events: number;
    pageViews: number;
    gamesStarted: number;
    gamesCompleted: number;
    signups: number;
    logins: number;
  }>();

  for (const row of sessionRows) {
    const acq = classifyAcquisition(row.entry_utm_source, row.entry_utm_medium);
    const key = `${row.hour_bucket}|${row.device_type}|${row.is_logged_in}|${row.country}|${acq}`;
    const prev = agg.get(key);
    if (prev) {
      prev.sessions += row.sessions;
      prev.newSessions += row.new_sessions;
      prev.bounced += row.bounced_sessions;
      prev.events += row.events_count;
      prev.pageViews += row.page_views;
      prev.gamesStarted += row.games_started;
      prev.gamesCompleted += row.games_completed;
      prev.signups += row.signups;
      prev.logins += row.logins;
    } else {
      agg.set(key, {
        hour: row.hour_bucket,
        device: row.device_type,
        loggedIn: row.is_logged_in,
        country: row.country,
        acq,
        sessions: row.sessions,
        newSessions: row.new_sessions,
        bounced: row.bounced_sessions,
        events: row.events_count,
        pageViews: row.page_views,
        gamesStarted: row.games_started,
        gamesCompleted: row.games_completed,
        signups: row.signups,
        logins: row.logins,
      });
    }
  }

  // Merge synthetic counts into the unknown/unknown/unknown bucket per
  // (hour, is_logged_in). Created on demand so rollups with no real session
  // data in the bucket still surface synthetic counts.
  for (const row of syntheticRows) {
    const key = `${row.hour_bucket}|unknown|${row.is_logged_in}|unknown|unknown`;
    const prev = agg.get(key);
    if (prev) {
      prev.gamesStarted += row.games_started;
      prev.gamesCompleted += row.games_completed;
    } else {
      agg.set(key, {
        hour: row.hour_bucket,
        device: "unknown",
        loggedIn: row.is_logged_in,
        country: "unknown",
        acq: "unknown",
        sessions: 0,
        newSessions: 0,
        bounced: 0,
        events: 0,
        pageViews: 0,
        gamesStarted: row.games_started,
        gamesCompleted: row.games_completed,
        signups: 0,
        logins: 0,
      });
    }
  }

  // No inner transaction — the whole rebuild runs inside the outer
  // doRebuildHourlyRange transaction wrapper for full DELETE+INSERT
  // atomicity.
  for (const entry of agg.values()) insert.run(entry);

  return agg.size;
}

/**
 * Rebuild the last 48 hours. Called on cron.
 *
 * Sync entry-point retained for callers (mostly tests) that own their
 * DB handle. Production cron uses the async variant below to serialize
 * concurrent rebuilds with admin-triggered ones.
 *
 * @param now - Epoch ms (exposed for tests).
 * @param database - Optional DB override.
 * @returns Count of rows written.
 */
export function rebuildRecentHourly(
  now: number = Date.now(),
  database: DatabaseType = db,
): number {
  const endBucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  const startBucket = endBucket - 48 * HOUR_MS;
  return rebuildHourlyRange(startBucket, endBucket, database);
}

/**
 * Async variant of {@link rebuildRecentHourly}. Routes through the
 * per-DB mutex so a cron tick that lands while an admin trigger is
 * mid-rebuild is queued behind it instead of racing.
 */
export async function rebuildRecentHourlyAsync(
  now: number = Date.now(),
  database: DatabaseType = db,
): Promise<number> {
  const endBucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  const startBucket = endBucket - 48 * HOUR_MS;
  return rebuildHourlyRangeAsync(startBucket, endBucket, database);
}

/**
 * Start the analytics_hourly rebuild cron.
 *
 * Uses the async/mutex variant so a tick that lands while another
 * tick is still running (rare but possible if a rebuild ever exceeds
 * the cron interval) is queued safely instead of corrupting state.
 *
 * @param database - Optional DB override.
 * @returns NodeJS.Timeout for the underlying setInterval.
 */
export function startAnalyticsHourlyJob(
  database: DatabaseType = db,
): NodeJS.Timeout {
  const handle = setInterval(() => {
    rebuildRecentHourlyAsync(Date.now(), database).catch((err) => {
      console.error("analytics_hourly rebuild failed:", err);
    });
  }, config.analyticsHourlyIntervalMs);
  handle.unref?.();
  return handle;
}
