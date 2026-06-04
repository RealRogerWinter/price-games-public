/**
 * Lightweight analytics anomaly detector.
 *
 * Runs on demand from `/api/admin/analytics/v2/anomalies` and surfaces
 * two classes of signal on the admin Overview tab:
 *
 *  - **Engagement-rate drop**: today's engagement rate is <80% of last
 *    week's same-day rate (WoW change < -20%).
 *  - **Session-volume spike/drop**: today's sessions are outside
 *    ±3 standard deviations of the trailing 14-day mean.
 *
 * Deliberately simple. No background worker, no state machine, no
 * incident tracker. The dashboard renders whatever the latest call
 * returns; alerts vanish as soon as the underlying metric recovers.
 */

import type { Database as DatabaseType } from "better-sqlite3";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Severity tier. */
export type AnomalySeverity = "info" | "warning" | "critical";

/** One anomaly row. */
export interface AnomalyAlert {
  id: string;
  severity: AnomalySeverity;
  title: string;
  detail: string;
  /** Value-now (raw), for the UI to show a number. */
  valueNow: number;
  /** Baseline the comparison was against. */
  valueBaseline: number;
  /** Signed percentage change vs baseline, or null when baseline=0. */
  pctChange: number | null;
}

/**
 * Run all detectors and return whatever triggered. Empty array = all
 * clear; the admin banner hides when nothing fires.
 *
 * @param db - Database.
 * @param now - Epoch ms (exposed for tests).
 */
export function detectAnomalies(
  db: DatabaseType,
  now: number = Date.now(),
): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];

  const engagement = checkEngagementDrop(db, now);
  if (engagement) alerts.push(engagement);

  const volume = checkVolumeAnomaly(db, now);
  if (volume) alerts.push(volume);

  return alerts;
}

/**
 * Compare today-so-far's engagement rate against the same hours of the
 * day 7 days ago. Fires when today is <80% of last-week's baseline
 * (>20% relative drop), as long as both windows have ≥20 sessions.
 */
function checkEngagementDrop(
  db: DatabaseType,
  now: number,
): AnomalyAlert | null {
  const startOfDay = dayBoundary(now);
  const dayAgoStart = startOfDay - 7 * DAY_MS;
  const dayAgoEnd = dayAgoStart + (now - startOfDay);

  const today = engagementInWindow(db, startOfDay, now);
  const baseline = engagementInWindow(db, dayAgoStart, dayAgoEnd);

  if (today.sessions < 20 || baseline.sessions < 20) return null;
  if (baseline.rate <= 0) return null;

  const pctChange = (today.rate - baseline.rate) / baseline.rate;
  if (pctChange > -0.2) return null;

  return {
    id: "engagement-drop",
    severity: pctChange < -0.4 ? "critical" : "warning",
    title: "Engagement rate down week-over-week",
    detail:
      `Today's engagement rate is ${(today.rate * 100).toFixed(1)}% ` +
      `vs ${(baseline.rate * 100).toFixed(1)}% same-window last week ` +
      `(${(pctChange * 100).toFixed(1)}%).`,
    valueNow: today.rate,
    valueBaseline: baseline.rate,
    pctChange,
  };
}

function engagementInWindow(
  db: DatabaseType,
  from: number,
  to: number,
): { sessions: number; rate: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(sessions), 0) AS sessions,
         COALESCE(SUM(bounced_sessions), 0) AS bounced
       FROM analytics_hourly
       WHERE hour_bucket BETWEEN ? AND ?`,
    )
    .get(from, to) as { sessions: number; bounced: number };
  return {
    sessions: row.sessions,
    rate: row.sessions > 0 ? (row.sessions - row.bounced) / row.sessions : 0,
  };
}

/**
 * Flag today's session count when it's outside ±3σ of the trailing
 * 14-day distribution. Both directions are reported:
 *  - spike > +3σ → `info`   (probably a good thing, worth a look)
 *  - drop < −3σ → `warning` (could indicate outage)
 *
 * The baseline uses the same hours-elapsed window from each of the
 * prior 14 days as the current day — i.e. if it's 10am UTC now, we
 * compare "0-10am today" against "0-10am on each of the last 14 days".
 * This prevents a false `volume-drop` every morning UTC when today-so-far
 * is compared against full prior days.
 *
 * A minimum-hours-elapsed gate (MIN_HOURS_FOR_VOLUME_CHECK) also avoids
 * firing on the first few minutes after midnight when the comparison
 * window is too narrow to be meaningful.
 */
const MIN_HOURS_FOR_VOLUME_CHECK = 2;

function checkVolumeAnomaly(
  db: DatabaseType,
  now: number,
): AnomalyAlert | null {
  const startOfDay = dayBoundary(now);
  const hoursElapsed = (now - startOfDay) / (60 * 60 * 1000);
  if (hoursElapsed < MIN_HOURS_FOR_VOLUME_CHECK) return null;

  const windowMs = now - startOfDay;

  // For each of the prior 14 days, sum sessions in the same
  // hours-elapsed window starting from that day's midnight. Skips
  // today itself — the current day is the value we're testing.
  const baseline: number[] = [];
  const stmt = db.prepare(
    `SELECT COALESCE(SUM(sessions), 0) AS sessions
       FROM analytics_hourly
      WHERE hour_bucket BETWEEN ? AND ?`,
  );
  for (let i = 1; i <= 14; i++) {
    const priorStart = startOfDay - i * DAY_MS;
    const priorEnd = priorStart + windowMs;
    const row = stmt.get(priorStart, priorEnd) as { sessions: number };
    baseline.push(row.sessions);
  }

  // Discard zero-valued prior days (likely pre-launch or outage days)
  // so they don't drag the mean down and inflate z for today.
  const values = baseline.filter((n) => n > 0);
  if (values.length < 7) return null;

  const mean = values.reduce((s, n) => s + n, 0) / values.length;
  const variance =
    values.reduce((s, n) => s + (n - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;

  const today = (stmt.get(startOfDay, now) as { sessions: number }).sessions;

  const z = (today - mean) / sd;
  if (Math.abs(z) < 3) return null;

  const isDrop = z < 0;
  const pctChange = mean > 0 ? (today - mean) / mean : null;

  return {
    id: isDrop ? "volume-drop" : "volume-spike",
    severity: isDrop ? "warning" : "info",
    title: isDrop ? "Session volume drop" : "Session volume spike",
    detail:
      `Today's sessions (${today.toLocaleString()}) is ${z.toFixed(1)}σ ` +
      `${isDrop ? "below" : "above"} the 14-day mean ` +
      `(${mean.toFixed(0)} ± ${sd.toFixed(0)}).`,
    valueNow: today,
    valueBaseline: mean,
    pctChange,
  };
}

function dayBoundary(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
