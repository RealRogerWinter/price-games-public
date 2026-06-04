import type { UserRankHistoryDay } from "@price-game/shared";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

const GRID_COLOR = "#2a2a4a";
const LABEL_COLOR = "#666";
const TOOLTIP_BG = "#1a1a2e";
const TOOLTIP_BORDER = "#f6c90e";
const TOOLTIP_TEXT = "#e0e0e0";
const LINE_COLOR = "#f6c90e";

interface RankHistoryChartProps {
  history: UserRankHistoryDay[];
  days: number;
  onChangeDays: (days: number) => void;
}

/**
 * Chart showing the user's leaderboard rank over time.
 * Y-axis is inverted so rank #1 appears at the top.
 */
export default function RankHistoryChart({
  history,
  days,
  onChangeDays,
}: RankHistoryChartProps) {
  const rawChartData = history.map((d) => ({
    label: d.date.slice(5), // "MM-DD"
    rank: d.rank,
    totalPlayers: d.totalPlayers,
  }));

  // Recharts cannot draw an area/line with only one point — the path has
  // zero length and the chart renders empty. When we only have a single
  // historical entry, seed a synthetic "Start" entry with the same rank so
  // the chart renders a flat line that still communicates the value.
  const chartData =
    rawChartData.length === 1
      ? [
          { label: "Start", rank: rawChartData[0].rank, totalPlayers: rawChartData[0].totalPlayers },
          rawChartData[0],
        ]
      : rawChartData;

  const labelStep = Math.max(1, Math.floor(chartData.length / 8));

  return (
    <div className="gh-chart-section">
      <div className="gh-chart-header">
        <span className="gh-chart-title">Leaderboard Position</span>
        <div className="gh-range-btns">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={`gh-range-btn ${days === d ? "gh-range-btn-active" : ""}`}
              onClick={() => onChangeDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="area-chart-empty" data-testid="rank-chart-empty">
          No rank history yet — play a game to start tracking!
        </div>
      ) : (
        <div className="area-chart-container" data-testid="rank-chart">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <CartesianGrid
                stroke={GRID_COLOR}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fill: LABEL_COLOR, fontSize: 10 }}
                interval={labelStep - 1}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                reversed
                tick={{ fill: LABEL_COLOR, fontSize: 10 }}
                tickFormatter={(v: number) => `#${v}`}
                axisLine={false}
                tickLine={false}
                width={48}
                allowDecimals={false}
                // Pad the Y domain by 1 on both sides so a flat-rank
                // series (e.g. "stayed at #7 all week", or the synthetic
                // two-point rendering for a single-entry history) sits
                // mid-chart instead of collapsing to the edge. Floor at
                // rank 1 so the "top of the leaderboard" anchor is
                // preserved.
                domain={[
                  (dataMin: number) => Math.max(1, dataMin - 1),
                  (dataMax: number) => dataMax + 1,
                ]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: TOOLTIP_BG,
                  border: `1px solid ${TOOLTIP_BORDER}`,
                  borderRadius: 4,
                  color: TOOLTIP_TEXT,
                  fontSize: 12,
                }}
                formatter={(value: unknown, _name: unknown, entry: unknown) => {
                  const tp = (entry as { payload?: { totalPlayers?: number } })?.payload?.totalPlayers;
                  return [`#${value}${tp ? ` of ${tp}` : ""}`, "Rank"];
                }}
                labelFormatter={(label: unknown) => String(label)}
              />
              <Area
                type="monotone"
                dataKey="rank"
                stroke={LINE_COLOR}
                fill={LINE_COLOR}
                fillOpacity={0.1}
                strokeWidth={2}
                // Only show permanent dots for the single-point case (where
                // we synthesise a "Start" point to give Recharts something
                // to draw). Multi-point series stay clean — dots only
                // appear on hover via activeDot.
                dot={
                  rawChartData.length === 1
                    ? { r: 4, fill: LINE_COLOR, stroke: "#fff", strokeWidth: 1 }
                    : false
                }
                activeDot={{
                  r: 5,
                  fill: LINE_COLOR,
                  stroke: "#fff",
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
