/**
 * Analytics v2 query service for the new `/admin/analytics` dashboard.
 *
 * Every query here hits the pre-aggregated `analytics_hourly` table or the
 * bounded `analytics_sessions` / `visitor_profile` tables. The raw `events`
 * log is never full-scanned, which keeps dashboards fast even as the event
 * store grows toward the 90-day retention ceiling.
 *
 * Filter semantics:
 *  - `range` — trailing window in milliseconds (7, 28, or 90 days).
 *  - `audience` — "all" | "anon" | "loggedIn".
 *  - `deviceType` — "all" | "desktop" | "mobile" | "tablet".
 *
 * All queries exclude bot traffic (`is_bot = 0`) by default.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  ADMIN_TIMEZONE,
  tzDateString,
  enumerateDaysInRange,
} from "@price-game/shared";

export type Audience = "all" | "anon" | "loggedIn";
export type DeviceFilter = "all" | "desktop" | "mobile" | "tablet";

export interface FilterInput {
  rangeDays: number;
  audience?: Audience;
  deviceType?: DeviceFilter;
  /**
   * IANA timezone identifier used to bucket daily / heatmap series. Defaults
   * to {@link ADMIN_TIMEZONE} (PST) when omitted. Per-request overridable
   * via `?tz=` on the route.
   */
  timeZone?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Build a WHERE fragment + param set constraining analytics_hourly rows by
 * the given filter. Used by all timeseries queries. Returns an object suitable
 * for splat into `database.prepare(...).all(...)`.
 *
 * @param filter - Filter input (rangeDays required; others optional).
 * @param now - Epoch ms (exposed for test determinism).
 */
function hourlyWhere(filter: FilterInput, now: number): { where: string; params: unknown[] } {
  const since = now - filter.rangeDays * DAY_MS;
  const clauses: string[] = ["hour_bucket >= ?"];
  const params: unknown[] = [since];
  if (filter.audience === "anon") clauses.push("is_logged_in = 0");
  if (filter.audience === "loggedIn") clauses.push("is_logged_in = 1");
  if (filter.deviceType && filter.deviceType !== "all") {
    clauses.push("device_type = ?");
    params.push(filter.deviceType);
  }
  return { where: clauses.join(" AND "), params };
}

/** Overview KPI numbers returned by {@link getOverview}. */
export interface OverviewKpis {
  dau: number;
  wau: number;
  mau: number;
  sessions: number;
  newSessions: number;
  returningSessions: number;
  engagementRate: number;
  avgGamesPerSession: number;
  pctLoggedIn: number;
  gamesStarted: number;
  gamesCompleted: number;
  signups: number;
  logins: number;
  bouncedSessions: number;
  /** Change vs prior window of the same length. Null if no prior data. */
  sessionsDelta: number | null;
  /** "Right now" signal — sessions whose last_event_at is in the last 5 min. */
  liveVisitors: number;
}

/**
 * Overview KPI card data. Everything here is derived from the rollup table
 * so the query stays O(hours × partitions). At 24-hour buckets × 4 dims
 * (device, logged-in, country, acquisition) this is never more than a few
 * thousand rows even at the 90-day horizon.
 *
 * @param db - Database instance.
 * @param filter - Filter input; `rangeDays` is required.
 * @param now - Epoch ms (exposed for tests).
 * @returns OverviewKpis object.
 */
export function getOverview(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): OverviewKpis {
  const { where, params } = hourlyWhere(filter, now);

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(sessions), 0)           AS sessions,
         COALESCE(SUM(new_sessions), 0)       AS new_sessions,
         COALESCE(SUM(bounced_sessions), 0)   AS bounced_sessions,
         COALESCE(SUM(page_views), 0)         AS page_views,
         COALESCE(SUM(games_started), 0)      AS games_started,
         COALESCE(SUM(games_completed), 0)    AS games_completed,
         COALESCE(SUM(signups), 0)            AS signups,
         COALESCE(SUM(logins), 0)             AS logins,
         COALESCE(SUM(CASE WHEN is_logged_in = 1 THEN sessions ELSE 0 END), 0) AS logged_in_sessions
       FROM analytics_hourly
       WHERE ${where}`,
    )
    .get(...params) as Record<string, number>;

  // DAU / WAU / MAU from distinct visitor_ids over rolling windows. These
  // hit analytics_sessions (bounded by started_at) rather than the events
  // table, so cost is O(sessions in the window).
  const dau = distinctVisitors(db, now - DAY_MS, now, filter);
  const wau = distinctVisitors(db, now - 7 * DAY_MS, now, filter);
  const mau = distinctVisitors(db, now - 30 * DAY_MS, now, filter);

  // Prior-window comparison for sessions delta. Prior window ends exactly
  // at the current window's start (exclusive) so the shared `hour_bucket`
  // boundary isn't counted in both windows. `hourlyWhere` uses `>= since`
  // for the current window, so the prior window's upper bound is
  // `since - 1` to avoid the overlap the review flagged.
  const priorWindowStart = now - 2 * filter.rangeDays * DAY_MS;
  const priorWindowEnd = now - filter.rangeDays * DAY_MS - 1;
  const priorClauses: string[] = ["hour_bucket BETWEEN ? AND ?"];
  const priorParams: unknown[] = [priorWindowStart, priorWindowEnd];
  if (filter.audience === "anon") priorClauses.push("is_logged_in = 0");
  if (filter.audience === "loggedIn") priorClauses.push("is_logged_in = 1");
  if (filter.deviceType && filter.deviceType !== "all") {
    priorClauses.push("device_type = ?");
    priorParams.push(filter.deviceType);
  }
  const prior = db
    .prepare(
      `SELECT COALESCE(SUM(sessions), 0) AS sessions
         FROM analytics_hourly
        WHERE ${priorClauses.join(" AND ")}`,
    )
    .get(...priorParams) as { sessions: number };
  const sessionsDelta = prior.sessions > 0
    ? (row.sessions - prior.sessions) / prior.sessions
    : null;

  // Live visitors: distinct visitor_id in analytics_sessions active in the
  // last 5 min (last_event_at >= now - 5min).
  const liveRow = db
    .prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS n
         FROM analytics_sessions
        WHERE last_event_at >= ?
          AND is_bot = 0`,
    )
    .get(now - 5 * 60 * 1000) as { n: number };

  return {
    dau,
    wau,
    mau,
    sessions: row.sessions,
    newSessions: row.new_sessions,
    returningSessions: row.sessions - row.new_sessions,
    engagementRate:
      row.sessions > 0 ? (row.sessions - row.bounced_sessions) / row.sessions : 0,
    avgGamesPerSession:
      row.sessions > 0 ? row.games_started / row.sessions : 0,
    pctLoggedIn: row.sessions > 0 ? row.logged_in_sessions / row.sessions : 0,
    gamesStarted: row.games_started,
    gamesCompleted: row.games_completed,
    signups: row.signups,
    logins: row.logins,
    bouncedSessions: row.bounced_sessions,
    sessionsDelta,
    liveVisitors: liveRow.n,
  };
}

function distinctVisitors(
  db: DatabaseType,
  start: number,
  end: number,
  filter: FilterInput,
): number {
  const clauses: string[] = ["started_at BETWEEN ? AND ?", "is_bot = 0"];
  const params: unknown[] = [start, end];
  if (filter.audience === "anon") clauses.push("user_id IS NULL");
  if (filter.audience === "loggedIn") clauses.push("user_id IS NOT NULL");
  if (filter.deviceType && filter.deviceType !== "all") {
    clauses.push("device_type = ?");
    params.push(filter.deviceType);
  }
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS n
         FROM analytics_sessions
        WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params) as { n: number };
  return row.n;
}

/** Shape of a single daily bucket returned by {@link getDailyTimeseries}. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD in the requested timezone
  sessions: number;
  newSessions: number;
  gamesStarted: number;
  gamesCompleted: number;
  engagedSessions: number;
  loggedInSessions: number;
}

/**
 * Zero-filled daily timeseries for the Overview tab chart.
 *
 * Buckets by calendar day in `filter.timeZone` (defaults to PST via
 * `ADMIN_TIMEZONE`). Previously bucketed by UTC `strftime`, which meant a
 * play at e.g. 11pm Pacific landed in the *next* UTC date — the chart
 * would visually shift the daily curve forward by ~7-8 hours and any
 * "yesterday vs today" comparison was off-by-one for west-coast traffic.
 *
 * @param db - Database instance.
 * @param filter - Filter input (includes `timeZone`).
 * @param now - Epoch ms.
 * @returns Array of `rangeDays + 1` daily points in the requested timezone.
 */
export function getDailyTimeseries(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): DailyPoint[] {
  const { where, params } = hourlyWhere(filter, now);
  // Aggregate per hour-bucket and bucket-format in JS using the requested
  // tz. Going through SQLite's strftime would force UTC since SQLite has
  // no IANA-zone formatter — `'localtime'` reads $TZ which is unreliable
  // in containerized prod, and we'd still need to round-trip the rollup
  // unique-key (which is UTC ms) anyway.
  const rows = db
    .prepare(
      `SELECT
         hour_bucket,
         SUM(sessions) AS sessions,
         SUM(new_sessions) AS new_sessions,
         SUM(games_started) AS games_started,
         SUM(games_completed) AS games_completed,
         SUM(sessions) - SUM(bounced_sessions) AS engaged_sessions,
         SUM(CASE WHEN is_logged_in = 1 THEN sessions ELSE 0 END) AS logged_in_sessions
       FROM analytics_hourly
       WHERE ${where}
       GROUP BY hour_bucket`,
    )
    .all(...params) as Array<{
    hour_bucket: number;
    sessions: number;
    new_sessions: number;
    games_started: number;
    games_completed: number;
    engaged_sessions: number;
    logged_in_sessions: number;
  }>;

  // Bucket each hour into its tz-local date and accumulate.
  const tz = filter.timeZone ?? ADMIN_TIMEZONE;
  const acc = new Map<string, DailyPoint>();
  for (const r of rows) {
    const key = tzDateString(new Date(r.hour_bucket).toISOString(), tz);
    if (!key) continue;
    const prev = acc.get(key);
    if (prev) {
      prev.sessions += r.sessions;
      prev.newSessions += r.new_sessions;
      prev.gamesStarted += r.games_started;
      prev.gamesCompleted += r.games_completed;
      prev.engagedSessions += r.engaged_sessions;
      prev.loggedInSessions += r.logged_in_sessions;
    } else {
      acc.set(key, {
        date: key,
        sessions: r.sessions,
        newSessions: r.new_sessions,
        gamesStarted: r.games_started,
        gamesCompleted: r.games_completed,
        engagedSessions: r.engaged_sessions,
        loggedInSessions: r.logged_in_sessions,
      });
    }
  }

  // Zero-fill `rangeDays + 1` consecutive tz-local dates so the chart
  // renders a continuous line even on sparse days. Anchor the end at
  // today-in-tz to prevent off-by-one when `now` straddles UTC midnight.
  const end = new Date(now);
  const start = new Date(now - filter.rangeDays * 24 * 60 * 60 * 1000);
  const dates = enumerateDaysInRange(start, end, tz);
  return dates.map(
    (date) =>
      acc.get(date) ?? {
        date,
        sessions: 0,
        newSessions: 0,
        gamesStarted: 0,
        gamesCompleted: 0,
        engagedSessions: 0,
        loggedInSessions: 0,
      },
  );
}

/** Shape of an acquisition source breakdown row. */
export interface AcquisitionSourceRow {
  source: string;
  sessions: number;
  newSessions: number;
  signups: number;
  gamesCompleted: number;
  engagementRate: number;
}

/**
 * Sessions and conversion metrics by acquisition source (paid, organic,
 * social, email, referral, direct, unknown). Drives the Acquisition tab.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getAcquisitionSources(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): AcquisitionSourceRow[] {
  const { where, params } = hourlyWhere(filter, now);
  const rows = db
    .prepare(
      `SELECT
         acquisition_source AS source,
         SUM(sessions) AS sessions,
         SUM(new_sessions) AS new_sessions,
         SUM(signups) AS signups,
         SUM(games_completed) AS games_completed,
         SUM(bounced_sessions) AS bounced
       FROM analytics_hourly
       WHERE ${where}
       GROUP BY acquisition_source
       ORDER BY sessions DESC`,
    )
    .all(...params) as Array<{
    source: string;
    sessions: number;
    new_sessions: number;
    signups: number;
    games_completed: number;
    bounced: number;
  }>;
  return rows.map((r) => ({
    source: r.source,
    sessions: r.sessions,
    newSessions: r.new_sessions,
    signups: r.signups,
    gamesCompleted: r.games_completed,
    engagementRate: r.sessions > 0 ? (r.sessions - r.bounced) / r.sessions : 0,
  }));
}

/** One row in the UTM-tag performance report. `utm_tags.id` is TEXT in
 * the schema, so `tagId` is a string — the admin UI links to
 * `/admin/utm-tags/:id`, so it's passed through verbatim. */
export interface UtmTagPerformanceRow {
  tagId: string;
  name: string;
  utmSource: string;
  utmCampaign: string | null;
  clickCount: number;
  sessions: number;
  signups: number;
  gamesCompleted: number;
  engagementRate: number;
}

/**
 * Join `utm_tags` (admin-configured campaigns) to `analytics_sessions`
 * so marketing can see which tags actually produce engaged users — a
 * major upgrade from the pre-existing click-count-only view.
 *
 * Cohort match: exact 3-tuple `(utm_source, utm_medium, utm_campaign)`
 * with NULL-aware equality — a tag whose `utm_medium` is NULL only
 * matches sessions whose `entry_utm_medium` is also NULL, NOT sessions
 * with any medium. This mirrors the user-side cohort fix from PR #246
 * (`fix(utm): use exact-match cohort, fix funnel double-counting`) so
 * a "reddit" broad tag stops counting sessions that belong to a
 * narrower "reddit + cpc + giveaway" sibling.
 *
 * Documented asymmetry: session-side cohort is a 3-tuple because
 * `analytics_sessions` does not carry `entry_utm_content`/`entry_utm_term`
 * (a v2 schema migration). The user-side cohort in `getUtmTagStats` is a
 * full 5-tuple. In practice the 3-tuple is sufficient for the leaderboard
 * because admin tags rarely differ only on content/term.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getUtmTagPerformance(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): UtmTagPerformanceRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  // NULL-aware equality: SQLite's `IS` returns true for NULL=NULL.
  // Using `IS` keeps the JOIN one expression per column and matches the
  // semantics of `buildAliasCohortWhere` in `utmTags.ts` (exact-tuple).
  const rows = db
    .prepare(
      `SELECT
         t.id             AS tag_id,
         t.name           AS name,
         t.utm_source     AS utm_source,
         t.utm_campaign   AS utm_campaign,
         t.click_count    AS click_count,
         COUNT(s.id)      AS sessions,
         SUM(s.signup_occurred) AS signups,
         SUM(s.games_completed) AS games_completed,
         SUM(COALESCE(s.bounced, 0)) AS bounced
       FROM utm_tags t
       LEFT JOIN analytics_sessions s
              ON s.entry_utm_source = t.utm_source
             AND s.entry_utm_medium IS t.utm_medium
             AND s.entry_utm_campaign IS t.utm_campaign
             AND s.is_bot = 0
             AND s.started_at >= ?
       GROUP BY t.id
       ORDER BY sessions DESC, click_count DESC`,
    )
    .all(since) as Array<{
    tag_id: number;
    name: string;
    utm_source: string;
    utm_campaign: string | null;
    click_count: number;
    sessions: number;
    signups: number | null;
    games_completed: number | null;
    bounced: number | null;
  }>;
  return rows.map((r) => {
    const sessions = r.sessions ?? 0;
    const bounced = r.bounced ?? 0;
    return {
      tagId: String(r.tag_id),
      name: r.name,
      utmSource: r.utm_source,
      utmCampaign: r.utm_campaign,
      clickCount: r.click_count,
      sessions,
      signups: r.signups ?? 0,
      gamesCompleted: r.games_completed ?? 0,
      engagementRate: sessions > 0 ? (sessions - bounced) / sessions : 0,
    };
  });
}

/** Shape of a top-path row for the Engagement tab. */
export interface TopPathRow {
  path: string;
  entrySessions: number;
  exitSessions: number;
}

/**
 * Top entry/exit paths for the Engagement tab. Uses `analytics_sessions` —
 * the bounded session view keeps this cheap compared to scanning raw events.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param limit - Max rows to return (default 20).
 * @param now - Epoch ms.
 */
export function getTopPaths(
  db: DatabaseType,
  filter: FilterInput,
  limit: number = 20,
  now: number = Date.now(),
): TopPathRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  const entryClauses: string[] = ["started_at >= ?", "is_bot = 0", "entry_path IS NOT NULL"];
  const entryParams: unknown[] = [since];
  if (filter.audience === "anon") entryClauses.push("user_id IS NULL");
  if (filter.audience === "loggedIn") entryClauses.push("user_id IS NOT NULL");

  const entryRows = db
    .prepare(
      `SELECT entry_path AS path, COUNT(*) AS n
         FROM analytics_sessions
        WHERE ${entryClauses.join(" AND ")}
        GROUP BY entry_path
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(...entryParams, limit) as { path: string; n: number }[];

  // Exit path is null until the session closes. We include only closed
  // sessions here so "exit" is meaningful.
  const exitClauses: string[] = ["started_at >= ?", "is_bot = 0", "exit_path IS NOT NULL", "ended_at IS NOT NULL"];
  const exitParams: unknown[] = [since];
  if (filter.audience === "anon") exitClauses.push("user_id IS NULL");
  if (filter.audience === "loggedIn") exitClauses.push("user_id IS NOT NULL");
  const exitRows = db
    .prepare(
      `SELECT exit_path AS path, COUNT(*) AS n
         FROM analytics_sessions
        WHERE ${exitClauses.join(" AND ")}
        GROUP BY exit_path
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(...exitParams, limit) as { path: string; n: number }[];

  const byPath = new Map<string, TopPathRow>();
  for (const r of entryRows) {
    byPath.set(r.path, { path: r.path, entrySessions: r.n, exitSessions: 0 });
  }
  for (const r of exitRows) {
    const existing = byPath.get(r.path);
    if (existing) existing.exitSessions = r.n;
    else byPath.set(r.path, { path: r.path, entrySessions: 0, exitSessions: r.n });
  }
  return Array.from(byPath.values()).sort(
    (a, b) => b.entrySessions + b.exitSessions - (a.entrySessions + a.exitSessions),
  );
}

/** Games-per-session histogram bucket. */
export interface GamesPerSessionBucket {
  /** Lower bound inclusive; bucket label e.g. "0", "1", "2", "3-5", "6+". */
  bucket: string;
  sessions: number;
}

/**
 * Histogram of games-per-session for the Engagement tab. Drives the primary
 * "stickiness" chart — how many users play more than one game in a single
 * sitting.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getGamesPerSession(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): GamesPerSessionBucket[] {
  const since = now - filter.rangeDays * DAY_MS;
  const clauses: string[] = ["started_at >= ?", "is_bot = 0"];
  const params: unknown[] = [since];
  if (filter.audience === "anon") clauses.push("user_id IS NULL");
  if (filter.audience === "loggedIn") clauses.push("user_id IS NOT NULL");
  if (filter.deviceType && filter.deviceType !== "all") {
    clauses.push("device_type = ?");
    params.push(filter.deviceType);
  }
  const rows = db
    .prepare(
      `SELECT games_started AS g, COUNT(*) AS n
         FROM analytics_sessions
        WHERE ${clauses.join(" AND ")}
        GROUP BY games_started`,
    )
    .all(...params) as { g: number; n: number }[];

  const buckets: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2": 0,
    "3-5": 0,
    "6+": 0,
  };
  for (const r of rows) {
    if (r.g <= 0) buckets["0"] += r.n;
    else if (r.g === 1) buckets["1"] += r.n;
    else if (r.g === 2) buckets["2"] += r.n;
    else if (r.g <= 5) buckets["3-5"] += r.n;
    else buckets["6+"] += r.n;
  }
  return Object.entries(buckets).map(([bucket, sessions]) => ({ bucket, sessions }));
}

/** Hour-of-day × day-of-week heatmap cell (one row per hour bucket). */
export interface HeatmapCell {
  dayOfWeek: number; // 0=Sun
  hourOfDay: number; // 0-23
  sessions: number;
}

/**
 * 7×24 heatmap of sessions by weekday and hour-of-day, computed in
 * `filter.timeZone` (defaults to PST). Previously bucketed in UTC, which
 * meant a Pacific-evening peak appeared on the next-day's row of the
 * heatmap and the "when do users play" answer was wrong by ~7-8 hours.
 *
 * SQLite has no IANA-zone formatter (`strftime`'s `'localtime'` reads
 * `$TZ` which isn't reliable in containerized prod), so we fetch raw
 * hour buckets + counts and compute dow/hod in JS via Intl.DateTimeFormat.
 *
 * @param db - Database instance.
 * @param filter - Filter input (includes `timeZone`).
 * @param now - Epoch ms.
 */
export function getHourlyHeatmap(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): HeatmapCell[] {
  const { where, params } = hourlyWhere(filter, now);
  const rows = db
    .prepare(
      `SELECT hour_bucket, SUM(sessions) AS sessions
         FROM analytics_hourly
        WHERE ${where}
        GROUP BY hour_bucket`,
    )
    .all(...params) as Array<{ hour_bucket: number; sessions: number }>;

  const tz = filter.timeZone ?? ADMIN_TIMEZONE;
  // Cache one Intl.DateTimeFormat per timezone — constructing per row is
  // unnecessarily expensive when scanning hundreds of buckets.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  // Sun=0, Mon=1, ... Sat=6 (matches the legacy SQLite %w convention).
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const acc = new Map<string, number>();
  for (const r of rows) {
    const parts = fmt.formatToParts(new Date(r.hour_bucket));
    let dow = -1;
    let hod = -1;
    for (const p of parts) {
      if (p.type === "weekday") {
        // Modern Node + en-US returns "Sun"/"Mon"/.../"Sat", but trim and
        // slice defensively so a runtime locale change ("Sun.", "Sunday")
        // doesn't silently drop rows from the heatmap. The first three
        // characters of the canonical English short-day names are unique.
        const key = p.value.replace(/[^A-Za-z]/g, "").slice(0, 3);
        const cap = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
        dow = dowMap[cap] ?? -1;
      }
      if (p.type === "hour") {
        // Intl returns "24" for midnight in some locales; coerce to 0.
        const h = Number(p.value);
        hod = Number.isFinite(h) ? h % 24 : -1;
      }
    }
    if (dow < 0 || hod < 0) continue;
    const key = `${dow}|${hod}`;
    acc.set(key, (acc.get(key) ?? 0) + r.sessions);
  }

  // Zero-fill the full 7×24 grid.
  const result: HeatmapCell[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      result.push({
        dayOfWeek: d,
        hourOfDay: h,
        sessions: acc.get(`${d}|${h}`) ?? 0,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Granular breakdowns — bring the v1 dashboard's mode + SP/MP visibility into
// v2, plus expose the new join_source dimension and share-link funnel that
// PR 205's instrumentation made possible.
//
// These queries read the `events` table directly because the rollup grain
// (hour × device × loggedIn × country × utm) doesn't carry game_mode or
// join_source. Synthetic events are INCLUDED for headline count metrics
// (mode breakdown) since the backfill writes them with the same shape;
// EXCLUDED for funnel queries because synthetic data lacks the intermediate
// page_viewed / mp_room_joined steps and would silently suppress
// drop-off rates.
// ---------------------------------------------------------------------------

/** One row in the games-by-mode-breakdown daily series. */
export interface GamesByModeRow {
  date: string;
  mode: string;
  /** Either `single`, `multiplayer`, or `daily` — partitions a row's mode count. */
  variant: "single" | "multiplayer" | "daily";
  count: number;
}

/**
 * Daily series of completed games partitioned by `(mode, variant)`. Variants:
 *   - `single`     — `game_completed` events
 *   - `multiplayer`— `mp_game_completed` events
 *   - `daily`      — `daily_completed` events
 *
 * Game mode comes from `properties.game_mode` (set on every emission site).
 * Includes synthetic events so the historical chart looks continuous.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getGamesByModeBreakdown(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): GamesByModeRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  const tz = filter.timeZone ?? ADMIN_TIMEZONE;

  // SQL-side group-by on (event_name, mode, hour_bucket). We bucket to the
  // hour in SQL and re-bucket to tz-local date in JS — bucketing to the
  // day in SQL would force UTC since SQLite has no IANA-zone formatter,
  // and the hour grain stays small enough to walk in JS. A 90-day window
  // is at most 90×24 = 2160 hour groups × ~10 modes × 3 variants ≈ 65k
  // rows — well below the no-LIMIT cap and bounded for any future range.
  const variantsCase =
    "CASE event_name " +
    "WHEN 'game_completed' THEN 'single' " +
    "WHEN 'mp_game_completed' THEN 'multiplayer' " +
    "WHEN 'daily_completed' THEN 'daily' END";

  // Daily plays emit BOTH the underlying completion event (`game_completed`
  // for SP, `mp_game_completed` for MP) AND a `daily_completed` semantic
  // marker. Without dedup the chart double-counts every daily play (once
  // under single/multiplayer, once under daily) which broke parity with
  // the Overview-tab `gamesStarted` KPI (sourced from the rollup, where
  // daily_completed is excluded from the underlying game-complete count).
  //
  // Pairing keys differ by path:
  //   - SP daily: same `game_session_id` on both events. game_session_id is
  //     unique per play, so this is a tight join.
  //   - MP daily: (`mp_room_code`, `visitor_id`) PLUS a tight time-window
  //     guard. mp_game_completed has no game_session_id; mp_room_code is
  //     reused across "Play Again" runs in the same room. daily_completed
  //     fires only on the first play of the day (gated by `daily_plays`
  //     unique constraint upstream), so a naive room+visitor join would
  //     drop every subsequent Play Again as if it were a daily duplicate.
  //     The 60s window is wider than the ms-scale gap between paired events
  //     (both fire from the same endRound() handler) and tighter than the
  //     minimum spacing between two MP completions in the same room (a 5+
  //     round game with 30s+ rounds takes minutes), so it dedupes paired
  //     events without false positives across sequential games.
  //
  // Synthetic backfill writes only `daily_completed` (no paired completion
  // event), so the EXISTS clause never matches synthetic rows and the
  // historical period stays continuous.
  const MP_PAIR_WINDOW_MS = 60 * 1000;
  const rows = db
    .prepare(
      `SELECT
         ((ts_server / ?) * ?) AS hour_bucket,
         ${variantsCase} AS variant,
         COALESCE(game_mode, 'unknown') AS mode,
         COUNT(*) AS count
       FROM events e
       WHERE e.ts_server >= ?
         AND e.event_name IN ('game_completed', 'mp_game_completed', 'daily_completed')
         AND e.is_bot = 0
         AND NOT (
           e.event_name IN ('game_completed', 'mp_game_completed')
           AND EXISTS (
             SELECT 1 FROM events d
              WHERE d.event_name = 'daily_completed'
                AND (
                  (e.event_name = 'game_completed'
                   AND e.game_session_id IS NOT NULL
                   AND d.game_session_id = e.game_session_id)
                  OR
                  (e.event_name = 'mp_game_completed'
                   AND e.mp_room_code IS NOT NULL
                   AND d.mp_room_code = e.mp_room_code
                   AND d.visitor_id = e.visitor_id
                   AND ABS(d.ts_server - e.ts_server) < ?)
                )
           )
         )
       GROUP BY hour_bucket, variant, mode`,
    )
    .all(HOUR_MS, HOUR_MS, since, MP_PAIR_WINDOW_MS) as Array<{
      hour_bucket: number;
      variant: GamesByModeRow["variant"];
      mode: string;
      count: number;
    }>;

  // Re-bucket from hour to tz-local date in JS. A single tz-local day
  // collapses across multiple hour rows, especially around the day
  // boundary in the requested timezone.
  const acc = new Map<string, GamesByModeRow>();
  for (const r of rows) {
    if (!r.variant) continue; // CASE returned NULL for an event_name we don't recognize — skip.
    const date = tzDateString(new Date(r.hour_bucket).toISOString(), tz);
    if (!date) continue;
    const key = `${date}|${r.mode}|${r.variant}`;
    const prev = acc.get(key);
    if (prev) prev.count += r.count;
    else acc.set(key, { date, mode: r.mode, variant: r.variant, count: r.count });
  }
  return Array.from(acc.values()).sort((a, b) =>
    a.date === b.date
      ? a.variant === b.variant
        ? a.mode.localeCompare(b.mode)
        : a.variant.localeCompare(b.variant)
      : a.date.localeCompare(b.date),
  );
}

/** One row in the daily unique-players + total-games series. */
export interface GamesDailyUniqueRow {
  date: string;
  uniquePlayers: number;
  totalGames: number;
}

/**
 * Daily series of `(uniquePlayers, totalGames)` for the Games tab. Reuses
 * the same dedup rules as {@link getGamesByModeBreakdown} so a daily play
 * counts as one game (not double-counted as both single+daily). Unique
 * players are visitor-id-distinct per tz-local day, NOT summable across
 * days — overlapping days share visitors. Synthetic events are included
 * for the totalGames count so the historical line stays continuous; the
 * synthetic backfill writes synthesized visitor_ids drawn from a small
 * pool, so the unique-players line for the synthetic period is a lower
 * bound rather than a true reach number, but visibly tracks the live data.
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getGamesDailyUniques(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): GamesDailyUniqueRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  const tz = filter.timeZone ?? ADMIN_TIMEZONE;

  // SQL groups by (visitor_id, hour_bucket) — collapses repeated plays from
  // the same visitor in the same hour into one row carrying the play count.
  // The per-hour grain stays small (≤ 24 × range × distinct-visitors-per-hour)
  // so JS can afford to walk it for the per-day Set accumulation.
  //
  // Dedup matches `getGamesByModeBreakdown` exactly so the unique-players
  // overlay tracks the same totals the variant chart shows. See that
  // function's comment for the rationale behind the 60s MP pairing window.
  const MP_PAIR_WINDOW_MS = 60 * 1000;
  const rows = db
    .prepare(
      `SELECT
         visitor_id,
         ((ts_server / ?) * ?) AS hour_bucket,
         COUNT(*) AS games
       FROM events e
       WHERE e.ts_server >= ?
         AND e.event_name IN ('game_completed', 'mp_game_completed', 'daily_completed')
         AND e.is_bot = 0
         AND NOT (
           e.event_name IN ('game_completed', 'mp_game_completed')
           AND EXISTS (
             SELECT 1 FROM events d
              WHERE d.event_name = 'daily_completed'
                AND (
                  (e.event_name = 'game_completed'
                   AND e.game_session_id IS NOT NULL
                   AND d.game_session_id = e.game_session_id)
                  OR
                  (e.event_name = 'mp_game_completed'
                   AND e.mp_room_code IS NOT NULL
                   AND d.mp_room_code = e.mp_room_code
                   AND d.visitor_id = e.visitor_id
                   AND ABS(d.ts_server - e.ts_server) < ?)
                )
           )
         )
       GROUP BY visitor_id, hour_bucket`,
    )
    .all(HOUR_MS, HOUR_MS, since, MP_PAIR_WINDOW_MS) as Array<{
      visitor_id: string;
      hour_bucket: number;
      games: number;
    }>;

  const acc = new Map<string, { visitors: Set<string>; total: number }>();
  for (const r of rows) {
    const date = tzDateString(new Date(r.hour_bucket).toISOString(), tz);
    if (!date) continue;
    let entry = acc.get(date);
    if (!entry) {
      entry = { visitors: new Set(), total: 0 };
      acc.set(date, entry);
    }
    entry.visitors.add(r.visitor_id);
    entry.total += r.games;
  }

  // Zero-fill to keep the chart continuous on sparse days. Same anchor
  // logic as getDailyTimeseries — anchor the end at today-in-tz.
  const end = new Date(now);
  const start = new Date(now - filter.rangeDays * DAY_MS);
  const dates = enumerateDaysInRange(start, end, tz);
  return dates.map((date) => {
    const entry = acc.get(date);
    return {
      date,
      uniquePlayers: entry?.visitors.size ?? 0,
      totalGames: entry?.total ?? 0,
    };
  });
}

/** One row in the start-source breakdown. */
export interface StartSourceRow {
  source: string;
  starts: number;
}

/**
 * Game-start breakdown by `properties.start_source` across SP and MP. Counts
 * `game_started` and `mp_game_started` events whose start_source matches one
 * of the canonical buckets (homepage / game-browser / quickplay /
 * room-creation / mp-invite); rows whose property is absent or unrecognized
 * collapse into `unknown`. Synthetic events excluded — the backfill predates
 * the start_source column and would skew the bucket distribution toward
 * "unknown".
 *
 * @param db - Database instance.
 * @param filter - Filter input.
 * @param now - Epoch ms.
 */
export function getStartSourceBreakdown(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): StartSourceRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  // Only emit canonical bucket names. The write-time `asStartSource()` gate
  // already rejects unknown strings on the SP path, but defensive: any future
  // bypass (a new emission site forgetting to validate, a manually inserted
  // event row) collapses into `unknown` rather than leaking raw property
  // strings to admin clients.
  const rows = db
    .prepare(
      `SELECT
         CASE json_extract(properties, '$.start_source')
           WHEN 'homepage' THEN 'homepage'
           WHEN 'game-browser' THEN 'game-browser'
           WHEN 'quickplay' THEN 'quickplay'
           WHEN 'room-creation' THEN 'room-creation'
           WHEN 'mp-invite' THEN 'mp-invite'
           ELSE 'unknown'
         END AS source,
         COUNT(*) AS starts
       FROM events
       WHERE event_name IN ('game_started', 'mp_game_started')
         AND ts_server >= ?
         AND is_bot = 0
         AND is_synthetic = 0
       GROUP BY source
       ORDER BY starts DESC`,
    )
    .all(since) as Array<{ source: string; starts: number }>;
  return rows;
}

/** One row in the join-source breakdown. */
export interface JoinSourceRow {
  source: string;
  joins: number;
}

/**
 * Multiplayer-arrival breakdown by `join_source` (share_link / browser /
 * quickplay / create). Counts `mp_room_joined` events whose
 * `properties.join_source` matches each canonical bucket. Excludes
 * synthetic — the backfill doesn't synthesize join events.
 */
export function getJoinSourceBreakdown(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): JoinSourceRow[] {
  const since = now - filter.rangeDays * DAY_MS;
  const rows = db
    .prepare(
      `SELECT
         COALESCE(json_extract(properties, '$.join_source'), 'unknown') AS source,
         COUNT(*) AS joins
       FROM events
       WHERE event_name = 'mp_room_joined'
         AND ts_server >= ?
         AND is_bot = 0
         AND is_synthetic = 0
       GROUP BY source
       ORDER BY joins DESC`,
    )
    .all(since) as Array<{ source: string; joins: number }>;
  return rows;
}

/** Share-link funnel result with per-step counts and conversion rates. */
export interface ShareLinkFunnelResult {
  copied: number;       // share_clicked events
  hostCopied: number;
  playerCopied: number;
  visitedRoomLink: number; // page_viewed events with mp_room_code
  joinedViaShareLink: number; // mp_room_joined with join_source='share_link'
  completedAfterShareLink: number; // mp_game_completed for visitors who joined via share_link
}

/**
 * End-to-end share-link funnel: copy → click → join → complete. Each step
 * counts distinct events / visitors so dashboards can compute drop-off
 * rates. Excludes synthetic — the backfill has no intermediate
 * page_viewed events for historical share clicks.
 */
export function getShareLinkFunnel(
  db: DatabaseType,
  filter: FilterInput,
  now: number = Date.now(),
): ShareLinkFunnelResult {
  const since = now - filter.rangeDays * DAY_MS;

  const copyAgg = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN json_extract(properties, '$.role') = 'host' THEN 1 ELSE 0 END) AS host,
         SUM(CASE WHEN json_extract(properties, '$.role') = 'player' THEN 1 ELSE 0 END) AS player
       FROM events
       WHERE event_name = 'share_clicked'
         AND ts_server >= ?
         AND is_bot = 0
         AND is_synthetic = 0`,
    )
    .get(since) as { total: number; host: number; player: number };

  // Room-link page views: a `page_viewed` whose path is `/<roomCode>` AND
  // resolves to a real `mp_rooms.code`. The previous GLOB-only match
  // accepted 6+ char single-segment paths and inflated the funnel with
  // routes like `/profile`, `/leaderboard`, `/settings`. Verifying the
  // path against `mp_rooms.code` (length-8 = leading `/` + nanoid(7))
  // eliminates the false positives without depending on a frontend
  // route inventory that drifts.
  const visited = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM events
          WHERE event_name = 'page_viewed'
            AND LENGTH(path) = 8
            AND EXISTS (
              SELECT 1 FROM mp_rooms WHERE code = SUBSTR(path, 2)
            )
            AND ts_server >= ?
            AND is_bot = 0
            AND is_synthetic = 0`,
      )
      .get(since) as { n: number }
  ).n;

  const joined = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM events
          WHERE event_name = 'mp_room_joined'
            AND json_extract(properties, '$.join_source') = 'share_link'
            AND ts_server >= ?
            AND is_bot = 0
            AND is_synthetic = 0`,
      )
      .get(since) as { n: number }
  ).n;

  // Completions whose visitor's prior mp_room_joined event in the window
  // was tagged share_link. Sub-select keeps the join cheap.
  const completed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM events e
          WHERE e.event_name = 'mp_game_completed'
            AND e.ts_server >= ?
            AND e.is_bot = 0
            AND e.is_synthetic = 0
            AND EXISTS (
              SELECT 1 FROM events j
               WHERE j.event_name = 'mp_room_joined'
                 AND j.visitor_id = e.visitor_id
                 AND j.mp_room_code = e.mp_room_code
                 AND json_extract(j.properties, '$.join_source') = 'share_link'
                 AND j.ts_server >= ?
                 AND j.ts_server <= e.ts_server
            )`,
      )
      .get(since, since) as { n: number }
  ).n;

  return {
    copied: copyAgg.total,
    hostCopied: copyAgg.host,
    playerCopied: copyAgg.player,
    visitedRoomLink: visited,
    joinedViaShareLink: joined,
    completedAfterShareLink: completed,
  };
}
