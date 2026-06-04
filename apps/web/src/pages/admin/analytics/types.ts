/**
 * Client-side types for analytics v2 API responses. Kept in lockstep with
 * `apps/server/src/services/analyticsV2.ts`.
 */

export type AnalyticsRange = "1d" | "7d" | "28d" | "90d";
export type AnalyticsAudience = "all" | "anon" | "loggedIn";
export type AnalyticsDevice = "all" | "desktop" | "mobile" | "tablet";

export interface AnalyticsFilters {
  range: AnalyticsRange;
  audience: AnalyticsAudience;
  device: AnalyticsDevice;
}

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
  sessionsDelta: number | null;
  liveVisitors: number;
}

export interface DailyPoint {
  date: string;
  sessions: number;
  newSessions: number;
  gamesStarted: number;
  gamesCompleted: number;
  engagedSessions: number;
  loggedInSessions: number;
}

export interface AcquisitionSourceRow {
  source: string;
  sessions: number;
  newSessions: number;
  signups: number;
  gamesCompleted: number;
  engagementRate: number;
}

export interface UtmTagPerformanceRow {
  /** utm_tags.id is TEXT in the schema; treat as an opaque string. */
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

export interface TopPathRow {
  path: string;
  entrySessions: number;
  exitSessions: number;
}

export interface GamesPerSessionBucket {
  bucket: string;
  sessions: number;
}

export interface HeatmapCell {
  dayOfWeek: number;
  hourOfDay: number;
  sessions: number;
}

// === Phase 3: Retention + Funnels + Geo ===

export interface CohortCell {
  cohort: string;
  weekOffset: number;
  retained: number;
  cohortSize: number;
}

export interface CohortSummary {
  cohort: string;
  cohortSize: number;
  d1: number;
  d7: number;
  d30: number;
}

export interface RetentionSeriesPoint {
  cohort: string;
  daysSinceStart: number;
  retained: number;
  cohortSize: number;
}

export interface StickinessPoint {
  date: string;
  dau: number;
  mau: number;
  ratio: number;
}

export interface FunnelStepResult {
  step: number;
  label: string;
  visitors: number;
  conversionFromPrev: number | null;
  conversionFromStart: number;
}

export interface FunnelResult {
  id: string;
  name: string;
  description: string;
  steps: FunnelStepResult[];
}

export interface GeoCountryRow {
  country: string;
  sessions: number;
  engagedSessions: number;
  gamesCompleted: number;
  engagementRate: number;
}

export interface AnomalyAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  valueNow: number;
  valueBaseline: number;
  pctChange: number | null;
}

/**
 * One row in the games-by-mode breakdown daily series. The chart pivots on
 * `(date, mode, variant)`: same date/mode but different variant
 * (single/multiplayer/daily) appear as separate rows so a stacked area
 * chart can render them independently.
 */
export interface GamesByModeRow {
  date: string;
  mode: string;
  variant: "single" | "multiplayer" | "daily";
  count: number;
}

export interface JoinSourceRow {
  source: string;
  joins: number;
}

/** Daily series of unique players + total games for the Games tab overlay. */
export interface GamesDailyUniqueRow {
  date: string;
  uniquePlayers: number;
  totalGames: number;
}

/**
 * One row in the unified game-start-source breakdown. `source` is one of
 * the canonical {@link import("@price-game/shared").StartSource} buckets
 * (homepage / game-browser / quickplay / room-creation / mp-invite) or
 * `unknown` for events emitted before the column was wired up.
 */
export interface StartSourceRow {
  source: string;
  starts: number;
}

export interface ShareLinkFunnelResult {
  copied: number;
  hostCopied: number;
  playerCopied: number;
  visitedRoomLink: number;
  joinedViaShareLink: number;
  completedAfterShareLink: number;
}
