/**
 * Games tab — daily mode breakdown + variant split (single / multiplayer /
 * daily) + multiplayer arrival source.
 *
 * Brings v1's combined chart back to v2 with the granularity the original
 * dashboard had. The variant split is the new headline: "how many games are
 * SP vs MP vs daily today" was previously invisible to v2 because the
 * rollup didn't carry game_mode. Now the chart reads directly from the
 * events table with synthetic events included so the historical period is
 * continuous.
 *
 * Variant + mode filters scope the daily chart client-side — the underlying
 * `games-by-mode` payload already carries both dimensions, so a server
 * round-trip on every dropdown change isn't needed.
 *
 * Unique-players overlay: a secondary line on the variant area chart shows
 * tz-local-day-distinct visitor count alongside the games-completed totals.
 * Sourced from `/games-daily-uniques`, which reuses the same daily-play
 * dedup so the lines line up.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import {
  fetchGamesByMode,
  fetchGamesDailyUniques,
  fetchJoinSource,
  fetchStartSource,
} from "./analyticsApi";
import type { GamesByModeRow, GamesDailyUniqueRow } from "./types";

type Variant = GamesByModeRow["variant"];
type VariantFilter = "all" | Variant;
type ModeFilter = string; // 'all' | actual mode strings

const VARIANT_COLOR: Record<Variant, string> = {
  single: "#4c78a8",
  multiplayer: "#f58518",
  daily: "#54a24b",
};

const SOURCE_COLOR: Record<string, string> = {
  share_link: "#e45756",
  browser: "#4c78a8",
  quickplay: "#f58518",
  create: "#54a24b",
  unknown: "#bab0ac",
};

const START_SOURCE_COLOR: Record<string, string> = {
  homepage: "#4c78a8",
  "game-browser": "#f58518",
  quickplay: "#54a24b",
  "room-creation": "#9b59b6",
  "mp-invite": "#e45756",
  unknown: "#bab0ac",
};

export default function GamesTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();
  const [variantFilter, setVariantFilter] = useState<VariantFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");

  const games = useQuery({
    queryKey: ["analytics", "v2", "games-by-mode", filters],
    queryFn: () => fetchGamesByMode(filters),
  });
  const joinSource = useQuery({
    queryKey: ["analytics", "v2", "join-source", filters],
    queryFn: () => fetchJoinSource(filters),
  });
  const startSource = useQuery({
    queryKey: ["analytics", "v2", "start-source", filters],
    queryFn: () => fetchStartSource(filters),
  });
  const dailyUniques = useQuery({
    queryKey: ["analytics", "v2", "games-daily-uniques", filters],
    queryFn: () => fetchGamesDailyUniques(filters),
  });

  // Distinct mode list from the data — the dropdown surfaces only modes
  // that actually appear in the window so admins don't pick a mode with
  // an empty chart. `useMemo` keyed on the data identity avoids
  // recomputing on unrelated re-renders.
  const availableModes = useMemo(() => {
    if (!games.data) return [];
    return Array.from(new Set(games.data.map((r) => r.mode))).sort();
  }, [games.data]);

  if (games.isLoading || joinSource.isLoading || startSource.isLoading || dailyUniques.isLoading) {
    return <div className="admin-loading" data-testid="games-loading">Loading…</div>;
  }
  if (games.error || joinSource.error || startSource.error || dailyUniques.error) {
    return <div className="admin-error" data-testid="games-error">Failed to load games data.</div>;
  }

  const filtered = filterRows(games.data!, variantFilter, modeFilter);
  const variantSeries = pivotByVariant(filtered, dailyUniques.data!);
  const modeSeries = aggregateByMode(filtered);

  return (
    <div className="admin-analytics-tab-content" data-testid="games-tab">
      <div className="admin-analytics-chart">
        <div className="admin-analytics-chart-header">
          <h2>Games completed by variant (single / multiplayer / daily, PST)</h2>
          <div className="admin-analytics-chart-filters">
            <label className="admin-filter">
              <span>Game type</span>
              <select
                value={variantFilter}
                onChange={(e) => setVariantFilter(e.target.value as VariantFilter)}
                data-testid="games-variant-filter"
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
                data-testid="games-mode-filter"
              >
                <option value="all">All modes</option>
                {availableModes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
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

      <div className="admin-analytics-chart">
        <h2>Games completed by mode (rolling window)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={modeSeries} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="mode" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Games"),
              ]}
              labelFormatter={(label) => `Mode: ${label}`}
            />
            <Bar dataKey="count" name="Games completed" fill="#4c78a8" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-chart">
        <h2>Game starts by source (single + multiplayer)</h2>
        <p className="admin-chart-caption">
          Where games are originating — homepage taps vs. the dedicated game
          browser, plus MP arrivals via quickplay, room creation, or share
          links. Synthetic backfill is excluded; events with no source bucket
          collapse into "unknown".
        </p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={startSource.data!} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="source" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Starts"),
              ]}
              labelFormatter={(label) => `Source: ${label}`}
            />
            <Bar
              dataKey="starts"
              name="Starts"
              fill="#4c78a8"
              isAnimationActive={false}
              shape={(props: unknown) => {
                const p = props as { x: number; y: number; width: number; height: number; payload: { source: string } };
                const fill = START_SOURCE_COLOR[p.payload.source] ?? START_SOURCE_COLOR.unknown;
                return <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={fill} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-chart">
        <h2>Multiplayer arrivals by source</h2>
        <p className="admin-chart-caption">
          How players are getting into rooms — share-link landings vs. lobby
          browser, quickplay matchmaking, and direct room creation.
        </p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={joinSource.data!} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="source" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Joins"),
              ]}
              labelFormatter={(label) => `Source: ${label}`}
            />
            <Bar
              dataKey="joins"
              name="Joins"
              fill="#4c78a8"
              isAnimationActive={false}
              shape={(props: unknown) => {
                // Per-bar coloring keyed on source so the share_link bar
                // jumps out visually. Recharts' Bar accepts a custom shape.
                const p = props as { x: number; y: number; width: number; height: number; payload: { source: string } };
                const fill = SOURCE_COLOR[p.payload.source] ?? SOURCE_COLOR.unknown;
                return <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={fill} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
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
 * Reshape filtered `[{date, mode, variant, count}]` into chart rows keyed
 * by date with one column per variant. Joins in the unique-players series
 * by date so the secondary line aligns to the same x-ticks. The
 * unique-players line intentionally ignores the variant/mode filter — its
 * value is always the day's overall reach (filtering distinct visitors by
 * variant/mode would understate reach when a player did both).
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
  // Seed the map from the uniques series so days with zero filtered games
  // still render the unique-players line.
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

/**
 * Collapse `[{date, mode, variant, count}]` into total-per-mode rows for
 * the bar chart (no time dimension — sum across the whole window).
 */
function aggregateByMode(rows: GamesByModeRow[]): Array<{ mode: string; count: number }> {
  const aggregate = new Map<string, number>();
  for (const r of rows) aggregate.set(r.mode, (aggregate.get(r.mode) ?? 0) + r.count);
  return Array.from(aggregate.entries())
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => b.count - a.count);
}
