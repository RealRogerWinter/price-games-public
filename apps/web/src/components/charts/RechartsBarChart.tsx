import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useState } from "react";

interface DataPoint {
  label: string;
  value: number;
  /** Completed count for stacked display. */
  completed?: number;
  /** In-progress count for stacked display. */
  inProgress?: number;
  /** Abandoned count for stacked display. */
  abandoned?: number;
}

interface RechartsBarChartProps {
  /** Data points with labels and numeric values. */
  data: DataPoint[];
  /** Bar color. */
  color?: string;
  /** Custom value formatter. */
  formatValue?: (v: number) => string;
  /** Callback when a bar is clicked. Receives the label of the clicked bar. */
  onBarClick?: (label: string) => void;
  /** Labels of bars that are currently selected (highlighted). */
  selectedLabels?: string[];
}

/** Theme colors matching the admin dark theme. */
const LABEL_COLOR = "#ccc";
const TOOLTIP_BG = "#1a1a2e";
const TOOLTIP_BORDER = "#4a9eff";
const TOOLTIP_TEXT = "#e0e0e0";

/**
 * Horizontal bar chart wrapper around Recharts.
 *
 * @param props - Chart configuration and data.
 * @returns Recharts-based horizontal bar chart element.
 */
export default function RechartsBarChart({
  data,
  color = "#4a9eff",
  formatValue = (v) => v.toLocaleString(),
  onBarClick,
  selectedLabels,
}: RechartsBarChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="hbar-chart-empty" data-testid="hbar-chart-empty">
        No data available
      </div>
    );
  }

  const hasStacked = data.some((d) => d.completed !== undefined);

  // For stacked mode, compute remaining (non-completed portion)
  const chartData = hasStacked
    ? data.map((d) => ({
        ...d,
        completedVal: d.completed ?? 0,
        remaining: Math.max(0, d.value - (d.completed ?? 0)),
      }))
    : data;

  const barHeight = 28;
  const gap = 6;
  const chartHeight = data.length * (barHeight + gap) + gap + 20;

  return (
    <div className="hbar-chart-container" data-testid="hbar-chart">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 0, right: 40, bottom: 0, left: 8 }}
        >
          <XAxis
            type="number"
            hide
          />
          <YAxis
            dataKey="label"
            type="category"
            tick={(props: Record<string, unknown>) => {
              const { x, y, payload } = props as { x: number; y: number; payload: { value: string } };
              const label = payload.value;
              const display = label.length > 18 ? label.slice(0, 16) + "..." : label;
              return (
                <text
                  x={x}
                  y={y}
                  dy={4}
                  textAnchor="end"
                  fill={LABEL_COLOR}
                  fontSize={12}
                  style={onBarClick ? { cursor: "pointer" } : undefined}
                  onClick={() => { if (onBarClick) onBarClick(label); }}
                >
                  {display}
                </text>
              );
            }}
            width={140}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: TOOLTIP_BG,
              border: `1px solid ${TOOLTIP_BORDER}`,
              borderRadius: 4,
              color: TOOLTIP_TEXT,
              fontSize: 12,
            }}
            itemStyle={{ color: TOOLTIP_TEXT }}
            labelStyle={{ color: TOOLTIP_TEXT }}
            content={hasStacked ? (props: Record<string, unknown>) => {
              const { active, payload } = props as {
                active?: boolean;
                payload?: { payload: { label: string; value: number; completedVal: number } }[];
              };
              if (!active || !payload?.[0]) return null;
              const entry = payload[0].payload;
              return (
                <div style={{
                  backgroundColor: TOOLTIP_BG,
                  border: `1px solid ${TOOLTIP_BORDER}`,
                  borderRadius: 4,
                  padding: "8px 12px",
                  fontSize: 12,
                }}>
                  <div style={{ color: TOOLTIP_TEXT, marginBottom: 4, fontWeight: 600 }}>{entry.label}</div>
                  <div style={{ color: TOOLTIP_TEXT, padding: "1px 0" }}>
                    Completed: {formatValue(entry.completedVal)} / Total: {formatValue(entry.value)}
                  </div>
                </div>
              );
            } : undefined}
            formatter={hasStacked ? undefined : (value: unknown) => [formatValue(Number(value)), "Count"]}
            cursor={false}
          />
          {hasStacked ? (
            <>
              <Bar
                dataKey="completedVal"
                stackId="stack"
                radius={[0, 0, 0, 0]}
                barSize={barHeight}
                fill={color}
                opacity={0.9}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={(_: unknown, index: number) => {
                  if (onBarClick && data[index]) onBarClick(data[index].label);
                }}
                style={onBarClick ? { cursor: "pointer" } : undefined}
              >
                {data.map((entry, index) => {
                  const isSelected = selectedLabels?.includes(entry.label);
                  const hasSelection = selectedLabels && selectedLabels.length > 0;
                  const baseOpacity = hasSelection ? (isSelected ? 1 : 0.35) : 0.9;
                  return (
                    <Cell
                      key={`cell-completed-${index}`}
                      fill={color}
                      opacity={hoverIdx === index ? 1 : baseOpacity}
                      onMouseEnter={() => setHoverIdx(index)}
                    />
                  );
                })}
              </Bar>
              <Bar
                dataKey="remaining"
                stackId="stack"
                radius={[0, 4, 4, 0]}
                barSize={barHeight}
                fill={color}
                opacity={0.3}
                label={{
                  position: "right",
                  fill: "#e0e0e0",
                  fontSize: 12,
                  fontWeight: 600,
                  formatter: ((v: unknown, _name: unknown, _props: unknown, idx: unknown) => {
                    // Show total on the outer (remaining) bar
                    const entry = data[Number(idx)];
                    return entry ? formatValue(entry.value) : formatValue(Number(v));
                  }) as unknown as undefined,
                }}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={(_: unknown, index: number) => {
                  if (onBarClick && data[index]) onBarClick(data[index].label);
                }}
                style={onBarClick ? { cursor: "pointer" } : undefined}
              >
                {data.map((entry, index) => {
                  const isSelected = selectedLabels?.includes(entry.label);
                  const hasSelection = selectedLabels && selectedLabels.length > 0;
                  const baseOpacity = hasSelection ? (isSelected ? 0.4 : 0.15) : 0.3;
                  return (
                    <Cell
                      key={`cell-remaining-${index}`}
                      fill={color}
                      opacity={hoverIdx === index ? 0.5 : baseOpacity}
                      onMouseEnter={() => setHoverIdx(index)}
                    />
                  );
                })}
              </Bar>
            </>
          ) : (
            <Bar
              dataKey="value"
              radius={[0, 4, 4, 0]}
              barSize={barHeight}
              label={{
                position: "right",
                fill: "#e0e0e0",
                fontSize: 12,
                fontWeight: 600,
                formatter: ((v: unknown) => formatValue(Number(v))) as unknown as undefined,
              }}
              onMouseLeave={() => setHoverIdx(null)}
              onClick={(_: unknown, index: number) => {
                if (onBarClick && data[index]) onBarClick(data[index].label);
              }}
              style={onBarClick ? { cursor: "pointer" } : undefined}
            >
              {data.map((entry, index) => {
                const isSelected = selectedLabels?.includes(entry.label);
                const hasSelection = selectedLabels && selectedLabels.length > 0;
                const baseOpacity = hasSelection ? (isSelected ? 1 : 0.35) : 0.8;
                return (
                  <Cell
                    key={`cell-${index}`}
                    fill={color}
                    opacity={hoverIdx === index ? 1 : baseOpacity}
                    onMouseEnter={() => setHoverIdx(index)}
                  />
                );
              })}
            </Bar>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
