/**
 * Phase 3 analytics queries: retention cohorts, 9 pre-built funnels, and
 * country geo breakdown. Every query hits the bounded `analytics_sessions`
 * table (scoped by `started_at`) and/or the `events` log with a short
 * lookback window — the 90-day retention ceiling on raw events keeps the
 * funnel joins cheap even at full event volume.
 *
 * Retention semantics:
 *  - A **cohort** = the ISO week of a visitor's first recorded session
 *    (Monday-based `%Y-%W` from SQLite's strftime, UTC).
 *  - **Retained in week N** = the cohort had ≥1 session whose `started_at`
 *    falls in week N from cohort start. We count distinct visitor_ids per
 *    (cohort, N) so a single chatty visitor doesn't inflate the numerator.
 *  - **D1 / D7 / D30** = distinct visitors with a session in the first
 *    24/168/720 hours AFTER their cohort start, excluding the cohort
 *    session itself.
 *
 * Funnel semantics:
 *  - A funnel is a strict ordered sequence of event names per visitor. Step
 *    K's visitor count is the distinct visitors who completed steps 1..K
 *    in order, within the configured lookback window.
 *  - The result's per-step `visitors` is monotonically non-increasing.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { FilterInput } from "./analyticsV2";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One cell in the cohort retention triangle. */
export interface CohortCell {
  /** Cohort key — the Monday-date (YYYY-MM-DD) of the week the cohort's
   * first session fell in. Using a Monday-date instead of an ISO-week
   * label (e.g. "2026-W17") avoids the year-boundary ambiguity in
   * SQLite's `%W` formatter (which would split week 1 of 2026 across
   * "2025-52" and "2026-00"). Dates are unambiguous and still sort
   * lexicographically into the correct order. */
  cohort: string;
  /** Weeks since the cohort's starting week (0 = cohort week itself). */
  weekOffset: number;
  /** Distinct visitors retained in this (cohort, weekOffset). */
  retained: number;
  /** Total cohort size (redundant per row, but lets the UI compute rates). */
  cohortSize: number;
}

/** Single cohort summary row for the D1/D7/D30 side table. */
export interface CohortSummary {
  cohort: string;
  cohortSize: number;
  d1: number;
  d7: number;
  d30: number;
}

/** Retention curve overlay — one series per cohort. */
export interface RetentionSeriesPoint {
  cohort: string;
  daysSinceStart: number;
  retained: number;
  cohortSize: number;
}

/** DAU/MAU stickiness ratio over a window. */
export interface StickinessPoint {
  date: string;
  dau: number;
  mau: number;
  ratio: number;
}

/**
 * Compute weekly cohort retention as a triangle: one row per
 * (cohort, weekOffset) up to `maxWeeks` (default 12). Cohorts are
 * derived from the visitor's first session's ISO-week. Covers the
 * most recent `weeksBack` cohorts (default 12).
 *
 * @param db - Database instance.
 * @param weeksBack - How many weeks of cohorts to include.
 * @param maxWeeks - Max weekOffset per cohort row.
 * @param now - Epoch ms (exposed for tests).
 */
export function getCohortRetention(
  db: DatabaseType,
  weeksBack: number = 12,
  maxWeeks: number = 12,
  now: number = Date.now(),
): CohortCell[] {
  const since = now - (weeksBack + maxWeeks) * 7 * DAY_MS;
  // First-seen per visitor, bucketed to ISO-week. The cohort key uses
  // strftime('%Y-%W') for year-weeknumber; SQLite weeks are Monday-based
  // with '%W', which matches ISO week numbering (close enough at our
  // scale — day-1 of year is excluded from week 01 but we don't care).
  const rows = db
    .prepare(
      `WITH first_seen AS (
         SELECT visitor_id,
                MIN(started_at) AS first_at
           FROM analytics_sessions
          WHERE is_bot = 0
            AND started_at >= ?
          GROUP BY visitor_id
       ),
       sizes AS (
         SELECT strftime('%Y-%m-%d', ((first_at / 1000) - ((strftime('%w', first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch') AS cohort,
                COUNT(*) AS cohort_size
           FROM first_seen
          GROUP BY cohort
       ),
       retained AS (
         SELECT strftime('%Y-%m-%d', ((fs.first_at / 1000) - ((strftime('%w', fs.first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch') AS cohort,
                CAST((s.started_at - fs.first_at) / (7 * ?) AS INTEGER) AS week_offset,
                COUNT(DISTINCT s.visitor_id) AS retained
           FROM first_seen fs
           JOIN analytics_sessions s
             ON s.visitor_id = fs.visitor_id
            AND s.is_bot = 0
            AND s.started_at >= fs.first_at
          WHERE s.started_at <= fs.first_at + ? * ?
          GROUP BY cohort, week_offset
       )
       SELECT r.cohort, r.week_offset, r.retained, s.cohort_size
         FROM retained r
         JOIN sizes s ON s.cohort = r.cohort
        ORDER BY r.cohort DESC, r.week_offset ASC`,
    )
    .all(since, DAY_MS, maxWeeks, 7 * DAY_MS) as Array<{
    cohort: string;
    week_offset: number;
    retained: number;
    cohort_size: number;
  }>;
  return rows.map((r) => ({
    cohort: r.cohort,
    weekOffset: r.week_offset,
    retained: r.retained,
    cohortSize: r.cohort_size,
  }));
}

/**
 * D1 / D7 / D30 retention summary per cohort. Counts distinct visitors
 * who had any session in the first 1/7/30 days AFTER their cohort-start
 * session (exclusive).
 *
 * @param db - Database instance.
 * @param weeksBack - How many weekly cohorts back to include.
 * @param now - Epoch ms.
 */
export function getCohortSummary(
  db: DatabaseType,
  weeksBack: number = 12,
  now: number = Date.now(),
): CohortSummary[] {
  const since = now - weeksBack * 7 * DAY_MS - 30 * DAY_MS;
  // Fold the three previously-correlated EXISTS subqueries into a single
  // LEFT JOIN with conditional MAX aggregates: for each visitor we compute
  // three flags (d1 / d7 / d30) in one scan of analytics_sessions, then
  // roll up to the cohort. Cheaper than the prior O(cohorts × visitors × 3
  // subqueries) shape at any real scale.
  const rows = db
    .prepare(
      `WITH first_seen AS (
         SELECT visitor_id,
                MIN(started_at) AS first_at
           FROM analytics_sessions
          WHERE is_bot = 0
            AND started_at >= ?
          GROUP BY visitor_id
       ),
       flags AS (
         SELECT fs.visitor_id,
                fs.first_at,
                MAX(CASE
                      WHEN s.started_at >  fs.first_at
                       AND s.started_at <= fs.first_at + ?
                      THEN 1 ELSE 0 END) AS d1,
                MAX(CASE
                      WHEN s.started_at >  fs.first_at
                       AND s.started_at <= fs.first_at + ?
                      THEN 1 ELSE 0 END) AS d7,
                MAX(CASE
                      WHEN s.started_at >  fs.first_at
                       AND s.started_at <= fs.first_at + ?
                      THEN 1 ELSE 0 END) AS d30
           FROM first_seen fs
           LEFT JOIN analytics_sessions s
                  ON s.visitor_id = fs.visitor_id
                 AND s.is_bot = 0
          GROUP BY fs.visitor_id
       )
       SELECT strftime('%Y-%m-%d', ((first_at / 1000) - ((strftime('%w', first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch') AS cohort,
              COUNT(*) AS cohort_size,
              SUM(COALESCE(d1, 0)) AS d1,
              SUM(COALESCE(d7, 0)) AS d7,
              SUM(COALESCE(d30, 0)) AS d30
         FROM flags
        GROUP BY cohort
        ORDER BY cohort DESC`,
    )
    .all(since, DAY_MS, 7 * DAY_MS, 30 * DAY_MS) as Array<{
    cohort: string;
    cohort_size: number;
    d1: number;
    d7: number;
    d30: number;
  }>;
  return rows.map((r) => ({
    cohort: r.cohort,
    cohortSize: r.cohort_size,
    d1: r.d1,
    d7: r.d7,
    d30: r.d30,
  }));
}

/**
 * Retention curve overlay — for every cohort and every day-offset up to
 * `maxDays` (default 30), the distinct visitors retained on that day.
 * Drives the "lines per cohort" chart.
 *
 * @param db - Database instance.
 * @param weeksBack - How many cohorts to include.
 * @param maxDays - Max daysSinceStart per cohort row.
 * @param now - Epoch ms.
 */
export function getRetentionCurves(
  db: DatabaseType,
  weeksBack: number = 6,
  maxDays: number = 30,
  now: number = Date.now(),
): RetentionSeriesPoint[] {
  const since = now - (weeksBack * 7 + maxDays) * DAY_MS;
  const rows = db
    .prepare(
      `WITH first_seen AS (
         SELECT visitor_id,
                MIN(started_at) AS first_at
           FROM analytics_sessions
          WHERE is_bot = 0
            AND started_at >= ?
          GROUP BY visitor_id
       ),
       sizes AS (
         SELECT strftime('%Y-%m-%d', ((first_at / 1000) - ((strftime('%w', first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch') AS cohort,
                COUNT(*) AS cohort_size
           FROM first_seen
          GROUP BY cohort
       )
       SELECT strftime('%Y-%m-%d', ((fs.first_at / 1000) - ((strftime('%w', fs.first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch') AS cohort,
              CAST((s.started_at - fs.first_at) / ? AS INTEGER) AS day_offset,
              COUNT(DISTINCT s.visitor_id) AS retained,
              sz.cohort_size
         FROM first_seen fs
         JOIN analytics_sessions s
           ON s.visitor_id = fs.visitor_id
          AND s.is_bot = 0
          AND s.started_at >= fs.first_at
          AND s.started_at <= fs.first_at + ? * ?
         JOIN sizes sz ON sz.cohort = strftime('%Y-%m-%d', ((fs.first_at / 1000) - ((strftime('%w', fs.first_at / 1000, 'unixepoch') + 6) % 7) * 86400), 'unixepoch')
        GROUP BY cohort, day_offset
        ORDER BY cohort DESC, day_offset ASC`,
    )
    .all(since, DAY_MS, maxDays, DAY_MS) as Array<{
    cohort: string;
    day_offset: number;
    retained: number;
    cohort_size: number;
  }>;
  return rows.map((r) => ({
    cohort: r.cohort,
    daysSinceStart: r.day_offset,
    retained: r.retained,
    cohortSize: r.cohort_size,
  }));
}

/**
 * DAU/MAU stickiness ratio per day. Single number per day: fraction of
 * monthly actives who came back today. A healthy product sits at
 * 20–50%+ depending on category.
 *
 * @param db - Database instance.
 * @param rangeDays - Trailing window.
 * @param now - Epoch ms.
 */
export function getStickiness(
  db: DatabaseType,
  rangeDays: number = 28,
  now: number = Date.now(),
): StickinessPoint[] {
  const DAY = DAY_MS;
  const result: StickinessPoint[] = [];
  const endDay = new Date(now);
  endDay.setUTCHours(0, 0, 0, 0);

  const stmt = db.prepare(
    `SELECT COUNT(DISTINCT visitor_id) AS n
       FROM analytics_sessions
      WHERE is_bot = 0
        AND started_at BETWEEN ? AND ?`,
  );

  for (let i = rangeDays; i >= 0; i--) {
    const day = new Date(endDay);
    day.setUTCDate(endDay.getUTCDate() - i);
    const dayStart = day.getTime();
    const dauRow = stmt.get(dayStart, dayStart + DAY - 1) as { n: number };
    const mauRow = stmt.get(dayStart - 29 * DAY, dayStart + DAY - 1) as { n: number };
    const dau = dauRow.n;
    const mau = mauRow.n;
    result.push({
      date: day.toISOString().slice(0, 10),
      dau,
      mau,
      ratio: mau > 0 ? dau / mau : 0,
    });
  }
  return result;
}

// ================================================================
// Pre-built funnels
// ================================================================

/** Configuration of a single funnel step. */
export interface FunnelStep {
  /** Human-readable label shown in the UI. */
  label: string;
  /** Event name(s) that satisfy this step. If an array, any match counts. */
  eventNames: string | string[];
  /** Optional filter — only match events where this property equals this value. */
  propertyFilter?: { key: string; equals: string };
}

/** Definition of a pre-built funnel. */
export interface FunnelDefinition {
  id: string;
  name: string;
  description: string;
  steps: FunnelStep[];
  /** Lookback window in days. */
  windowDays: number;
}

/** Result row — one per step. */
export interface FunnelStepResult {
  step: number;
  label: string;
  visitors: number;
  conversionFromPrev: number | null;
  conversionFromStart: number;
}

/** Full funnel result including definition and per-step counts. */
export interface FunnelResult {
  id: string;
  name: string;
  description: string;
  steps: FunnelStepResult[];
}

/**
 * The nine pre-built funnels the business actually cares about.
 * See the plan doc for rationale; naming tracks the approved list.
 */
export const PREBUILT_FUNNELS: FunnelDefinition[] = [
  {
    id: "north-star",
    name: "North Star",
    description: "Landing → first game started → first game completed",
    windowDays: 28,
    steps: [
      { label: "Landed", eventNames: "page_viewed" },
      { label: "Started first game", eventNames: "game_started" },
      { label: "Completed first game", eventNames: "game_completed" },
    ],
  },
  {
    id: "first-taste",
    name: "First-Taste Stickiness",
    description: "Did users start a second game after completing one?",
    windowDays: 7,
    steps: [
      { label: "Completed a game", eventNames: "game_completed" },
      { label: "Started another", eventNames: "game_started" },
    ],
  },
  {
    id: "anon-to-signup",
    name: "Anon → Signup",
    description: "Anonymous game completion → account creation",
    windowDays: 28,
    steps: [
      { label: "Completed anon game", eventNames: "game_completed" },
      { label: "Signed up", eventNames: "user_signed_up" },
    ],
  },
  {
    id: "d1-d30-retention",
    name: "D1/D7/D30 Retention",
    description: "Signup → Day 1 return → Day 7 return → Day 30 return",
    windowDays: 60,
    steps: [
      { label: "Signed up", eventNames: "user_signed_up" },
      { label: "Day 1 return", eventNames: "session_started" },
      { label: "Day 7 return", eventNames: "session_started" },
      { label: "Day 30 return", eventNames: "session_started" },
    ],
  },
  {
    id: "mp-fill-rate",
    name: "Multiplayer Fill Rate",
    description: "Room created → 2nd player joined → game started → completed",
    windowDays: 14,
    steps: [
      { label: "Room created", eventNames: "mp_room_created" },
      { label: "2nd player joined", eventNames: "mp_room_joined" },
      { label: "Game started", eventNames: "mp_game_started" },
      { label: "Game completed", eventNames: "mp_game_completed" },
    ],
  },
  {
    id: "daily-viral",
    name: "Daily Viral Loop",
    description: "Daily viewed → started → completed → shared",
    windowDays: 7,
    steps: [
      { label: "Viewed daily", eventNames: "page_viewed" },
      { label: "Started daily", eventNames: "daily_started" },
      { label: "Completed daily", eventNames: "daily_completed" },
      { label: "Shared", eventNames: "daily_shared" },
    ],
  },
  {
    id: "reward-ux",
    name: "Reward UX",
    description: "Reward earned → reward claimed (unclaimed = UX bug)",
    windowDays: 28,
    steps: [
      { label: "Reward earned", eventNames: "reward_earned" },
      { label: "Reward claimed", eventNames: "reward_claimed" },
    ],
  },
  {
    id: "returning-engagement",
    name: "Returning Engagement",
    description: "Session (day 2+) → game started (do returning users actually play?)",
    windowDays: 14,
    steps: [
      { label: "Returning session", eventNames: "session_started" },
      { label: "Started a game", eventNames: "game_started" },
    ],
  },
  {
    id: "referral",
    name: "Referral Conversion",
    description: "Referral clicked → signed up → completed a game",
    windowDays: 14,
    steps: [
      { label: "Clicked referral", eventNames: "referral_clicked" },
      { label: "Signed up", eventNames: "referral_signed_up" },
      { label: "Completed first game", eventNames: "game_completed" },
    ],
  },
];

/**
 * Compute one pre-built funnel. Step K's visitors = distinct visitors who
 * completed steps 1..K in strict order within `windowDays`, i.e. with each
 * step's event timestamp ≥ the prior step's for that visitor.
 *
 * Implementation: iteratively narrow a "qualifying visitors" CTE. Each
 * step further constrains to visitors who had the required event AFTER
 * their prior-step timestamp. This is O(steps × (events-in-window)) for
 * the DISTINCT aggregates, cheap at our scale.
 *
 * @param db - Database instance.
 * @param def - Funnel definition.
 * @param now - Epoch ms.
 */
export function computeFunnel(
  db: DatabaseType,
  def: FunnelDefinition,
  now: number = Date.now(),
): FunnelResult {
  const since = now - def.windowDays * DAY_MS;

  // Step 1: distinct visitors whose first matching event appears in window.
  let qualifying: Map<string, number>;
  {
    const names = eventNameArray(def.steps[0].eventNames);
    const placeholders = names.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT visitor_id, MIN(ts_server) AS first_ts
           FROM events
          WHERE event_name IN (${placeholders})
            AND ts_server >= ?
            AND is_bot = 0
            AND is_synthetic = 0
          GROUP BY visitor_id`,
      )
      .all(...names, since) as { visitor_id: string; first_ts: number }[];
    qualifying = new Map(rows.map((r) => [r.visitor_id, r.first_ts]));
  }

  const stepCounts: number[] = [qualifying.size];

  for (let i = 1; i < def.steps.length; i++) {
    const names = eventNameArray(def.steps[i].eventNames);
    if (names.length === 0 || qualifying.size === 0) {
      stepCounts.push(0);
      qualifying = new Map();
      continue;
    }
    // Fetch ALL matching events (not just MIN per visitor) so we can
    // find each visitor's first event that lands AT OR AFTER their prior
    // step's timestamp. The earlier implementation used MIN(ts_server)
    // per visitor which wrongly discarded visitors whose step-N event
    // had any occurrence BEFORE the step-(N-1) timestamp — breaking
    // funnels whose steps share an event name (first-taste stickiness,
    // d1-d30-retention, returning-engagement, daily-viral).
    //
    // Also chunk the visitor_id IN-list to stay under SQLite's
    // SQLITE_MAX_VARIABLE_NUMBER (32,766 with better-sqlite3 defaults).
    // A 10K-visitor funnel + 10K IN-list is fine; chunking at 2000
    // keeps us comfortably under the cap for any realistic workload.
    const visitorIds = Array.from(qualifying.keys());
    const CHUNK = 2000;
    const next = new Map<string, number>();
    const namePlaceholders = names.map(() => "?").join(",");

    for (let c = 0; c < visitorIds.length; c += CHUNK) {
      const chunk = visitorIds.slice(c, c + CHUNK);
      const vidPlaceholders = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT visitor_id, ts_server
             FROM events
            WHERE event_name IN (${namePlaceholders})
              AND visitor_id IN (${vidPlaceholders})
              AND ts_server >= ?
              AND is_bot = 0
              AND is_synthetic = 0
            ORDER BY visitor_id ASC, ts_server ASC`,
        )
        .all(...names, ...chunk, since) as { visitor_id: string; ts_server: number }[];

      // Rows are ordered by (visitor_id, ts_server ASC); take the first
      // per visitor whose ts is >= their prior-step ts.
      for (const row of rows) {
        if (next.has(row.visitor_id)) continue; // already found earliest valid
        const priorTs = qualifying.get(row.visitor_id);
        if (priorTs !== undefined && row.ts_server >= priorTs) {
          next.set(row.visitor_id, row.ts_server);
        }
      }
    }
    stepCounts.push(next.size);
    qualifying = next;
  }

  const startCount = stepCounts[0] || 0;
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    steps: stepCounts.map((visitors, i) => ({
      step: i + 1,
      label: def.steps[i].label,
      visitors,
      conversionFromPrev:
        i === 0
          ? null
          : stepCounts[i - 1] > 0
            ? visitors / stepCounts[i - 1]
            : 0,
      conversionFromStart: startCount > 0 ? visitors / startCount : 0,
    })),
  };
}

function eventNameArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

/**
 * Compute every pre-built funnel. Used by the Funnels tab's main view.
 *
 * @param db - Database instance.
 * @param now - Epoch ms.
 */
export function computeAllFunnels(
  db: DatabaseType,
  now: number = Date.now(),
): FunnelResult[] {
  return PREBUILT_FUNNELS.map((def) => computeFunnel(db, def, now));
}

// ================================================================
// Geo
// ================================================================

/** One row in the country breakdown. */
export interface GeoCountryRow {
  country: string; // ISO-2, or "unknown"
  sessions: number;
  engagedSessions: number;
  gamesCompleted: number;
  engagementRate: number;
}

/**
 * Country-level breakdown of sessions + engagement. Backed by the
 * hourly rollup so it's cheap. `country` is CF-IPCountry (ISO-2).
 *
 * @param db - Database instance.
 * @param filter - Filter input (rangeDays honored; audience/device too).
 * @param now - Epoch ms.
 */
export function getGeoCountries(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): GeoCountryRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  const clauses: string[] = ["hour_bucket >= ?"];
  const params: unknown[] = [since];
  if (filter.audience === "anon") clauses.push("is_logged_in = 0");
  if (filter.audience === "loggedIn") clauses.push("is_logged_in = 1");
  if (filter.deviceType && filter.deviceType !== "all") {
    clauses.push("device_type = ?");
    params.push(filter.deviceType);
  }
  const rows = db
    .prepare(
      `SELECT country,
              COALESCE(SUM(sessions), 0)          AS sessions,
              COALESCE(SUM(sessions - bounced_sessions), 0) AS engaged,
              COALESCE(SUM(games_completed), 0)   AS games_completed
         FROM analytics_hourly
        WHERE ${clauses.join(" AND ")}
        GROUP BY country
        ORDER BY sessions DESC`,
    )
    .all(...params) as Array<{
    country: string;
    sessions: number;
    engaged: number;
    games_completed: number;
  }>;
  return rows.map((r) => ({
    country: r.country || "unknown",
    sessions: r.sessions,
    engagedSessions: r.engaged,
    gamesCompleted: r.games_completed,
    engagementRate: r.sessions > 0 ? r.engaged / r.sessions : 0,
  }));
}
