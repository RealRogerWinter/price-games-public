/**
 * Retention tab — cohort curve overlay + D1/D7/D30 summary + stickiness trend.
 *
 * The primary chart is the retention-curve overlay: one line per weekly
 * cohort, X-axis = days since that cohort's first session, Y-axis = fraction
 * of the cohort still active. This is what a CEO actually wants to see —
 * are newer cohorts retaining better than older ones?
 *
 * Supplementary: the classic cohort triangle grid (shows raw retained
 * counts as a heatmap) and the DAU/MAU stickiness sparkline.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  AreaChart,
  Area,
} from "recharts";
import {
  csvExportUrl,
  fetchCohortRetention,
  fetchCohortSummary,
  fetchRetentionCurves,
  fetchStickiness,
} from "./analyticsApi";
import CsvButton from "./CsvButton";
import type { CohortCell, RetentionSeriesPoint } from "./types";

// Tableau-10 palette — color-blind safe. One color per visible cohort
// (newest first).
const COHORT_PALETTE = [
  "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2",
  "#eeca3b", "#b279a2", "#ff9da6", "#9d755d", "#bab0ac",
];

export default function RetentionTab(): React.ReactElement {
  const cohorts = useQuery({
    queryKey: ["analytics", "v2", "retention-cohorts"],
    queryFn: () => fetchCohortRetention(12, 12),
  });
  const summary = useQuery({
    queryKey: ["analytics", "v2", "retention-summary"],
    queryFn: () => fetchCohortSummary(12),
  });
  const curves = useQuery({
    queryKey: ["analytics", "v2", "retention-curves"],
    queryFn: () => fetchRetentionCurves(6, 30),
  });
  const stickiness = useQuery({
    queryKey: ["analytics", "v2", "retention-stickiness"],
    queryFn: () => fetchStickiness(28),
  });

  if (cohorts.isLoading || summary.isLoading || curves.isLoading || stickiness.isLoading) {
    return <div className="admin-loading" data-testid="retention-loading">Loading…</div>;
  }
  if (cohorts.error || summary.error || curves.error || stickiness.error) {
    return <div className="admin-error" data-testid="retention-error">Failed to load retention data.</div>;
  }

  return (
    <div className="admin-analytics-tab-content" data-testid="retention-tab">
      <div className="admin-analytics-chart">
        <h2>Retention curves (distinct visitors retained by day, per cohort)</h2>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart
            data={reshapeCurves(curves.data!)}
            margin={{ top: 16, right: 16, left: 0, bottom: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 12 }}
              label={{ value: "Days since first session", position: "insideBottom", offset: -4, fontSize: 11 }}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              domain={[0, 1]}
            />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? `${(v * 100).toFixed(1)}%` : v,
                // `name` here is the dataKey, which we set equal to the
                // cohort label on each <Line>. Surface it instead of the
                // blank label the chart was rendering before.
                String(name ?? "Retention"),
              ]}
              labelFormatter={(label) => `Day ${label} since first session`}
            />
            <Legend />
            {uniqueCohorts(curves.data!).map((cohort, i) => (
              <Line
                key={cohort}
                type="monotone"
                dataKey={cohort}
                name={cohort}
                stroke={COHORT_PALETTE[i % COHORT_PALETTE.length]}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-chart">
        <h2>DAU / MAU stickiness (%)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={stickiness.data!} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              tick={{ fontSize: 12 }}
              domain={[0, 1]}
            />
            <Tooltip
              formatter={(v) => [
                typeof v === "number" ? `${(v * 100).toFixed(1)}%` : v,
                "DAU / MAU",
              ]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <Area type="monotone" dataKey="ratio" stroke="#54a24b" fill="#54a24b" fillOpacity={0.2} name="DAU/MAU" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-table">
        <h2>
          D1 / D7 / D30 retention per cohort
          <CsvButton href={csvExportUrl("retention")} filename="analytics-retention.csv" />
        </h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Cohort</th>
              <th className="num">Cohort size</th>
              <th className="num">D1</th>
              <th className="num">D7</th>
              <th className="num">D30</th>
            </tr>
          </thead>
          <tbody>
            {summary.data!.map((r) => (
              <tr key={r.cohort} data-testid={`summary-row-${r.cohort}`}>
                <td>{r.cohort}</td>
                <td className="num">{r.cohortSize.toLocaleString()}</td>
                <td className="num">{pct(r.d1, r.cohortSize)}</td>
                <td className="num">{pct(r.d7, r.cohortSize)}</td>
                <td className="num">{pct(r.d30, r.cohortSize)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-analytics-table">
        <h2>Cohort triangle (weekly, retained visitors by weekOffset)</h2>
        <CohortTriangle cells={cohorts.data!} />
      </div>
    </div>
  );
}

function pct(n: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${n.toLocaleString()} (${((n / denom) * 100).toFixed(1)}%)`;
}

/** Collapse `RetentionSeriesPoint[]` into chart-shaped rows: one per day,
 * with one column per cohort. */
function reshapeCurves(
  points: RetentionSeriesPoint[],
): Array<Record<string, number | string>> {
  const byDay = new Map<number, Record<string, number | string>>();
  const maxDay = points.reduce((m, p) => (p.daysSinceStart > m ? p.daysSinceStart : m), 0);
  for (let d = 0; d <= maxDay; d++) byDay.set(d, { day: d });
  for (const p of points) {
    const row = byDay.get(p.daysSinceStart)!;
    // Normalize to [0,1] so all cohorts share the same y-axis scale.
    row[p.cohort] = p.cohortSize > 0 ? p.retained / p.cohortSize : 0;
  }
  return Array.from(byDay.values()).sort(
    (a, b) => (a.day as number) - (b.day as number),
  );
}

function uniqueCohorts(points: RetentionSeriesPoint[]): string[] {
  const set = new Set<string>();
  for (const p of points) set.add(p.cohort);
  return Array.from(set).sort().reverse(); // newest first
}

function CohortTriangle({ cells }: { cells: CohortCell[] }): React.ReactElement {
  // Group by cohort; for each cohort, a map weekOffset → retained.
  const cohortMap = new Map<string, { size: number; offsets: Map<number, number> }>();
  let maxOffset = 0;
  for (const c of cells) {
    let entry = cohortMap.get(c.cohort);
    if (!entry) {
      entry = { size: c.cohortSize, offsets: new Map() };
      cohortMap.set(c.cohort, entry);
    }
    entry.offsets.set(c.weekOffset, c.retained);
    if (c.weekOffset > maxOffset) maxOffset = c.weekOffset;
  }
  const sortedCohorts = Array.from(cohortMap.keys()).sort().reverse();

  return (
    <table className="admin-table cohort-triangle">
      <thead>
        <tr>
          <th>Cohort</th>
          <th className="num">Size</th>
          {Array.from({ length: maxOffset + 1 }, (_, i) => (
            <th key={i} className="num">W{i}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedCohorts.map((cohort) => {
          const entry = cohortMap.get(cohort)!;
          return (
            <tr key={cohort}>
              <td>{cohort}</td>
              <td className="num">{entry.size.toLocaleString()}</td>
              {Array.from({ length: maxOffset + 1 }, (_, i) => {
                const retained = entry.offsets.get(i);
                if (retained === undefined) return <td key={i} className="num cohort-cell-empty">—</td>;
                const rate = entry.size > 0 ? retained / entry.size : 0;
                return (
                  <td
                    key={i}
                    className="num cohort-cell"
                    style={{ backgroundColor: triangleColor(rate) }}
                    title={`${retained} / ${entry.size}`}
                  >
                    {Math.round(rate * 100)}%
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function triangleColor(rate: number): string {
  if (rate <= 0) return "transparent";
  const alpha = 0.15 + Math.min(1, rate) * 0.75;
  return `rgba(76, 120, 168, ${alpha.toFixed(3)})`;
}
