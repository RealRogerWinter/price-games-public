/**
 * Engagement tab — games-per-session histogram + hour × day heatmap + top paths.
 *
 * Answers "how deeply do users engage once they arrive" (games/session),
 * "when are they playing" (heatmap), and "what do they look at" (top paths).
 */

import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import { csvExportUrl, fetchGamesPerSession, fetchHeatmap, fetchPaths } from "./analyticsApi";
import CsvButton from "./CsvButton";
import type { HeatmapCell } from "./types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function EngagementTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();

  const gps = useQuery({
    queryKey: ["analytics", "v2", "games-per-session", filters],
    queryFn: () => fetchGamesPerSession(filters),
  });
  const heatmap = useQuery({
    queryKey: ["analytics", "v2", "heatmap", filters],
    queryFn: () => fetchHeatmap(filters),
  });
  const paths = useQuery({
    queryKey: ["analytics", "v2", "paths", filters],
    queryFn: () => fetchPaths(filters, 20),
  });

  if (gps.isLoading || heatmap.isLoading || paths.isLoading) {
    return <div className="admin-loading" data-testid="engagement-loading">Loading…</div>;
  }
  if (gps.error || heatmap.error || paths.error) {
    return <div className="admin-error" data-testid="engagement-error">Failed to load engagement data.</div>;
  }

  return (
    <div className="admin-analytics-tab-content" data-testid="engagement-tab">
      <div className="admin-analytics-chart">
        <h2>Games per session</h2>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={gps.data!} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Sessions"),
              ]}
              labelFormatter={(label) => `Games per session: ${label}`}
            />
            <Bar dataKey="sessions" name="Sessions" fill="#54a24b" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-chart">
        <h2>When users play (sessions by hour × weekday, PST)</h2>
        <Heatmap data={heatmap.data!} />
      </div>

      <div className="admin-analytics-table">
        <h2>
          Top paths
          <CsvButton href={csvExportUrl("paths", filters, { limit: 500 })} filename="analytics-paths.csv" />
        </h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Path</th>
              <th className="num">Entry sessions</th>
              <th className="num">Exit sessions</th>
            </tr>
          </thead>
          <tbody>
            {paths.data!.map((r) => (
              <tr key={r.path} data-testid={`path-row-${r.path}`}>
                <td><code>{r.path}</code></td>
                <td className="num">{r.entrySessions.toLocaleString()}</td>
                <td className="num">{r.exitSessions.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Heatmap({ data }: { data: HeatmapCell[] }): React.ReactElement {
  const max = data.reduce((m, c) => (c.sessions > m ? c.sessions : m), 0);
  // Group into a 7-row × 24-col matrix for rendering.
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of data) grid[c.dayOfWeek][c.hourOfDay] = c.sessions;

  return (
    <div className="heatmap" data-testid="heatmap">
      <div className="heatmap-row heatmap-header">
        <div className="heatmap-day-label" />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="heatmap-hour-label">
            {h % 3 === 0 ? h : ""}
          </div>
        ))}
      </div>
      {grid.map((row, dow) => (
        <div key={dow} className="heatmap-row">
          <div className="heatmap-day-label">{DAY_NAMES[dow]}</div>
          {row.map((v, h) => (
            <div
              key={h}
              className="heatmap-cell"
              title={`${DAY_NAMES[dow]} ${h}:00 — ${v} sessions`}
              style={{
                backgroundColor: heatColor(v, max),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function heatColor(value: number, max: number): string {
  if (max === 0 || value === 0) return "var(--surface-2, #1f232b)";
  const t = Math.min(1, value / max);
  // Blue scale; color-blind-friendly enough at this small sample.
  const alpha = 0.15 + t * 0.85;
  return `rgba(76, 120, 168, ${alpha.toFixed(3)})`;
}
