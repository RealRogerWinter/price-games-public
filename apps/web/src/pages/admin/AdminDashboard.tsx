/**
 * Admin Dashboard — high-level "what's happening today" view.
 *
 * Replaces the legacy v1 analytics dashboard (lots of widgets reading from
 * gameplay tables directly with multiple correctness bugs) with a focused
 * surface backed by the v2 events stream:
 *
 *   1. Combined activity chart (single / multiplayer / daily over time) —
 *      same data as Insights → Games tab. Reads from the synthetic-aware
 *      v2 endpoint so the historical period is continuous. Variant + mode
 *      filters scope the chart client-side to "show me daily plays in
 *      Comparison" or similar drill-downs without re-fetching.
 *   2. Unique-players overlay — secondary line on the activity chart
 *      sourced from `/games-daily-uniques` so the dashboard shows reach
 *      next to volume, not just "is volume going up".
 *   3. Active multiplayer rooms — live ops view. NOT analytics-stream data
 *      since "what's running right now" doesn't fit the events rollup
 *      model; queried directly from `mp_rooms` like before.
 *   4. Link to the full Insights surface for deeper breakdowns.
 *
 * v1's per-mode bar, score distribution, daily registrations, top players,
 * popular categories, retention KPIs, and date-drill-down all moved into
 * the appropriate Insights tabs. They're not duplicated here — Insights is
 * the single source of truth for analytics; this page is the "headline"
 * surface and the Active Rooms ops widget.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { getActiveRooms } from "../../api/adminClient";
import type { AnalyticsActiveRoom } from "@price-game/shared";

type Range = "7d" | "28d" | "90d";

interface GamesByModeRow {
  date: string;
  mode: string;
  variant: "single" | "multiplayer" | "daily";
  count: number;
}

interface GamesDailyUniqueRow {
  date: string;
  uniquePlayers: number;
  totalGames: number;
}

type VariantFilter = "all" | GamesByModeRow["variant"];
type ModeFilter = string;

const VARIANT_COLOR: Record<GamesByModeRow["variant"], string> = {
  single: "#4c78a8",
  multiplayer: "#f58518",
  daily: "#54a24b",
};

export default function AdminDashboard() {
  const [range, setRange] = useState<Range>("28d");
  const [variantFilter, setVariantFilter] = useState<VariantFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [activity, setActivity] = useState<GamesByModeRow[]>([]);
  const [dailyUniques, setDailyUniques] = useState<GamesDailyUniqueRow[]>([]);
  const [activeRooms, setActiveRooms] = useState<AnalyticsActiveRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/admin/analytics/v2/games-by-mode?range=${range}`, {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`games-by-mode → HTTP ${r.status}`);
        return r.json() as Promise<GamesByModeRow[]>;
      }),
      fetch(`/api/admin/analytics/v2/games-daily-uniques?range=${range}`, {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`games-daily-uniques → HTTP ${r.status}`);
        return r.json() as Promise<GamesDailyUniqueRow[]>;
      }),
      getActiveRooms(),
    ])
      .then(([rows, uniques, rooms]) => {
        setActivity(rows);
        setDailyUniques(uniques);
        setActiveRooms(rooms);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => setLoading(false));
  }, [range]);

  // Auto-refresh active rooms every 30s while the page is open. The
  // combined chart re-fetches only on range change since rollup data
  // updates at most every 10 minutes.
  useEffect(() => {
    const interval = setInterval(() => {
      getActiveRooms().then(setActiveRooms).catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Mode dropdown surfaces only modes present in the current window so a
  // 7d view doesn't list a mode that's only seen activity in 90d.
  const availableModes = useMemo(
    () => Array.from(new Set(activity.map((r) => r.mode))).sort(),
    [activity],
  );

  if (loading) return <div className="admin-loading" data-testid="dashboard-loading">Loading…</div>;
  if (error) return <div className="admin-error" data-testid="dashboard-error">{error}</div>;

  const filtered = filterRows(activity, variantFilter, modeFilter);
  const variantSeries = pivotByVariant(filtered, dailyUniques);

  return (
    <div className="admin-dashboard" data-testid="admin-dashboard">
      <div className="admin-dashboard-header">
        <h1 className="admin-page-title">Dashboard</h1>
        <div className="admin-dashboard-actions">
          <label className="admin-filter">
            <span>Range</span>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as Range)}
              data-testid="dashboard-range"
            >
              <option value="7d">Last 7 days</option>
              <option value="28d">Last 28 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </label>
          <label className="admin-filter">
            <span>Game type</span>
            <select
              value={variantFilter}
              onChange={(e) => setVariantFilter(e.target.value as VariantFilter)}
              data-testid="dashboard-variant"
            >
              <option value="all">All</option>
              <option value="single">Single-player</option>
              <option value="multiplayer">Multiplayer</option>
              <option value="daily">Daily</option>
            </select>
          </label>
          <label className="admin-filter">
            <span>Mode</span>
            <select
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value)}
              data-testid="dashboard-mode"
            >
              <option value="all">All modes</option>
              {availableModes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <Link to="/admin/analytics" className="admin-link" data-testid="dashboard-insights-link">
            View detailed analytics →
          </Link>
        </div>
      </div>

      <div className="admin-analytics-chart">
        <h2>Games completed (single / multiplayer / daily, PST)</h2>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={variantSeries} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
            <Tooltip
              labelFormatter={(label) => `Date (PST): ${label}`}
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? ""),
              ]}
            />
            <Legend />
            {(variantFilter === "all" || variantFilter === "single") && (
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="single"
                name="Single-player"
                stackId="1"
                stroke={VARIANT_COLOR.single}
                fill={VARIANT_COLOR.single}
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            )}
            {(variantFilter === "all" || variantFilter === "multiplayer") && (
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="multiplayer"
                name="Multiplayer"
                stackId="1"
                stroke={VARIANT_COLOR.multiplayer}
                fill={VARIANT_COLOR.multiplayer}
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            )}
            {(variantFilter === "all" || variantFilter === "daily") && (
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="daily"
                name="Daily"
                stackId="1"
                stroke={VARIANT_COLOR.daily}
                fill={VARIANT_COLOR.daily}
                fillOpacity={0.5}
                isAnimationActive={false}
              />
            )}
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="uniquePlayers"
              name="Unique players"
              stroke="#222222"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-table">
        <h2>Active multiplayer rooms ({activeRooms.length})</h2>
        {activeRooms.length === 0 ? (
          <p className="admin-empty">No active rooms right now.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Mode</th>
                <th>Status</th>
                <th className="num">Players</th>
                <th className="num">Round</th>
              </tr>
            </thead>
            <tbody>
              {activeRooms.map((r) => (
                <tr key={r.code} data-testid={`active-room-${r.code}`}>
                  <td><code>{r.code}</code></td>
                  <td>{r.gameMode}</td>
                  <td>{r.status}</td>
                  <td className="num">{r.playerCount}</td>
                  <td className="num">
                    {r.currentRound} / {r.totalRounds}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Apply the variant + mode filter to the raw per-day rows. */
function filterRows(
  rows: GamesByModeRow[],
  variant: VariantFilter,
  mode: ModeFilter,
): GamesByModeRow[] {
  if (variant === "all" && mode === "all") return rows;
  return rows.filter(
    (r) => (variant === "all" || r.variant === variant) && (mode === "all" || r.mode === mode),
  );
}

/**
 * Reshape the v2 games-by-mode rows into chart-shaped data: one entry
 * per date with one column per variant summed across all modes, plus the
 * unique-players overlay value joined by date. Mirrors the same helper in
 * GamesTab — kept inline here to avoid a shared util for a 25-line function.
 */
function pivotByVariant(
  rows: GamesByModeRow[],
  uniques: GamesDailyUniqueRow[],
): Array<{
  date: string;
  single: number;
  multiplayer: number;
  daily: number;
  uniquePlayers: number;
}> {
  const acc = new Map<
    string,
    { date: string; single: number; multiplayer: number; daily: number; uniquePlayers: number }
  >();
  for (const u of uniques) {
    acc.set(u.date, {
      date: u.date,
      single: 0,
      multiplayer: 0,
      daily: 0,
      uniquePlayers: u.uniquePlayers,
    });
  }
  for (const r of rows) {
    let entry = acc.get(r.date);
    if (!entry) {
      entry = { date: r.date, single: 0, multiplayer: 0, daily: 0, uniquePlayers: 0 };
      acc.set(r.date, entry);
    }
    entry[r.variant] += r.count;
  }
  return Array.from(acc.values()).sort((a, b) => a.date.localeCompare(b.date));
}
