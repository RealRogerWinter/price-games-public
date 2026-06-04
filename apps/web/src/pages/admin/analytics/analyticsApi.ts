/**
 * Thin fetch wrappers around the /api/admin/analytics/v2/* endpoints.
 *
 * Uses `credentials: "include"` so the admin session cookie is sent. Errors
 * surface as rejected promises via `throw new Error(...)` so React Query's
 * default retry / error UI kicks in.
 */

import type {
  AcquisitionSourceRow,
  AnalyticsFilters,
  AnomalyAlert,
  CohortCell,
  CohortSummary,
  DailyPoint,
  FunnelResult,
  GamesByModeRow,
  GamesDailyUniqueRow,
  GamesPerSessionBucket,
  GeoCountryRow,
  HeatmapCell,
  JoinSourceRow,
  OverviewKpis,
  RetentionSeriesPoint,
  ShareLinkFunnelResult,
  StartSourceRow,
  StickinessPoint,
  TopPathRow,
  UtmTagPerformanceRow,
} from "./types";

const BASE = "/api/admin/analytics/v2";

function buildQuery(filters: AnalyticsFilters, extra?: Record<string, string | number>): string {
  const p = new URLSearchParams();
  // Only send non-default values so the URL and network tab stay readable.
  // The server's `parseV2Filter` treats missing params as defaults.
  if (filters.range !== "7d") p.set("range", filters.range);
  if (filters.audience !== "all") p.set("audience", filters.audience);
  if (filters.device !== "all") p.set("device", filters.device);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  }
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Fetch Overview tab KPI cards. */
export function fetchOverview(filters: AnalyticsFilters): Promise<OverviewKpis> {
  return get<OverviewKpis>(`${BASE}/overview${buildQuery(filters)}`);
}

/** Fetch zero-filled daily series for the Overview chart. */
export function fetchDaily(filters: AnalyticsFilters): Promise<DailyPoint[]> {
  return get<DailyPoint[]>(`${BASE}/daily${buildQuery(filters)}`);
}

/** Fetch acquisition source breakdown (paid / organic / social / etc.). */
export function fetchAcquisition(filters: AnalyticsFilters): Promise<AcquisitionSourceRow[]> {
  return get<AcquisitionSourceRow[]>(`${BASE}/acquisition${buildQuery(filters)}`);
}

/** Fetch UTM tag performance report. */
export function fetchUtmTags(filters: AnalyticsFilters): Promise<UtmTagPerformanceRow[]> {
  return get<UtmTagPerformanceRow[]>(`${BASE}/utm-tags${buildQuery(filters)}`);
}

/** Fetch top entry/exit paths. */
export function fetchPaths(filters: AnalyticsFilters, limit = 20): Promise<TopPathRow[]> {
  return get<TopPathRow[]>(`${BASE}/paths${buildQuery(filters, { limit })}`);
}

/** Fetch games-per-session histogram. */
export function fetchGamesPerSession(filters: AnalyticsFilters): Promise<GamesPerSessionBucket[]> {
  return get<GamesPerSessionBucket[]>(`${BASE}/games-per-session${buildQuery(filters)}`);
}

/** Fetch cohort retention triangle (weekly cohorts × weeks-since-first-session). */
export function fetchCohortRetention(weeks = 12, maxWeeks = 12): Promise<CohortCell[]> {
  return get<CohortCell[]>(`${BASE}/retention/cohorts?weeks=${weeks}&maxWeeks=${maxWeeks}`);
}

/** Fetch D1/D7/D30 retention summary per cohort. */
export function fetchCohortSummary(weeks = 12): Promise<CohortSummary[]> {
  return get<CohortSummary[]>(`${BASE}/retention/summary?weeks=${weeks}`);
}

/** Fetch retention curves (one series per cohort, daily points). */
export function fetchRetentionCurves(weeks = 6, maxDays = 30): Promise<RetentionSeriesPoint[]> {
  return get<RetentionSeriesPoint[]>(`${BASE}/retention/curves?weeks=${weeks}&maxDays=${maxDays}`);
}

/** Fetch DAU/MAU stickiness trend. */
export function fetchStickiness(days = 28): Promise<StickinessPoint[]> {
  return get<StickinessPoint[]>(`${BASE}/retention/stickiness?days=${days}`);
}

/** Fetch all 9 pre-built funnels in one call. */
export function fetchAllFunnels(): Promise<FunnelResult[]> {
  return get<FunnelResult[]>(`${BASE}/funnels`);
}

/** Fetch a single pre-built funnel by id. */
export function fetchFunnel(id: string): Promise<FunnelResult> {
  return get<FunnelResult>(`${BASE}/funnels/${encodeURIComponent(id)}`);
}

/** Fetch country-level geo breakdown. */
export function fetchGeoCountries(filters: AnalyticsFilters): Promise<GeoCountryRow[]> {
  return get<GeoCountryRow[]>(`${BASE}/geo/countries${buildQuery(filters)}`);
}

/** Fetch hour-of-day × day-of-week heatmap. */
export function fetchHeatmap(filters: AnalyticsFilters): Promise<HeatmapCell[]> {
  return get<HeatmapCell[]>(`${BASE}/heatmap${buildQuery(filters)}`);
}

/** Fetch active analytics anomalies. Empty array means "all clear". */
export function fetchAnomalies(): Promise<AnomalyAlert[]> {
  return get<AnomalyAlert[]>(`${BASE}/anomalies`);
}

/** Fetch the daily games-by-mode breakdown for the Games tab. */
export function fetchGamesByMode(filters: AnalyticsFilters): Promise<GamesByModeRow[]> {
  return get<GamesByModeRow[]>(`${BASE}/games-by-mode${buildQuery(filters)}`);
}

/** Fetch the multiplayer join-source distribution for the Games tab. */
export function fetchJoinSource(filters: AnalyticsFilters): Promise<JoinSourceRow[]> {
  return get<JoinSourceRow[]>(`${BASE}/join-source${buildQuery(filters)}`);
}

/** Fetch the unified game-start-source distribution (SP + MP) for the Games tab. */
export function fetchStartSource(filters: AnalyticsFilters): Promise<StartSourceRow[]> {
  return get<StartSourceRow[]>(`${BASE}/start-source${buildQuery(filters)}`);
}

/** Fetch the daily unique-players + total-games series for the Games tab overlay. */
export function fetchGamesDailyUniques(
  filters: AnalyticsFilters,
): Promise<GamesDailyUniqueRow[]> {
  return get<GamesDailyUniqueRow[]>(`${BASE}/games-daily-uniques${buildQuery(filters)}`);
}

/** Fetch the end-to-end share-link funnel for the Sharing tab. */
export function fetchShareLinkFunnel(
  filters: AnalyticsFilters,
): Promise<ShareLinkFunnelResult> {
  return get<ShareLinkFunnelResult>(`${BASE}/share-link-funnel${buildQuery(filters)}`);
}

/**
 * Build the URL for a CSV export endpoint. Callers use this in an
 * `<a download>` or programmatic navigation to trigger the browser's
 * download flow with the admin session cookie intact.
 */
export function csvExportUrl(
  kind:
    | "daily"
    | "acquisition"
    | "utm-tags"
    | "paths"
    | "geo"
    | "retention"
    | "funnels",
  filters?: AnalyticsFilters,
  extra?: Record<string, string | number>,
): string {
  const q = filters ? buildQuery(filters, extra) : "";
  return `${BASE}/export/${kind}.csv${q}`;
}
