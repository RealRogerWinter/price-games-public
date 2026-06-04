import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface DataPoint {
  label: string;
  value: number;
}

/** Configuration for a single series in multi-series mode. */
export interface SeriesConfig {
  key: string;
  color: string;
  fillOpacity?: number;
  strokeDasharray?: string;
  name: string;
}

interface RechartsAreaChartProps {
  /** Data points with labels (e.g. dates) and numeric values. */
  data: DataPoint[];
  /** Optional secondary data overlay (e.g. player activity). */
  overlayData?: DataPoint[];
  /** Chart height in pixels. */
  height?: number;
  /** Primary line/fill color. */
  color?: string;
  /** Overlay line color. */
  overlayColor?: string;
  /** Fill opacity for area below the line. */
  fillOpacity?: number;
  /** Whether to show horizontal grid lines. */
  showGrid?: boolean;
  /** Custom value formatter for tooltips. */
  formatValue?: (v: number) => string;
  /** Callback when a data point is clicked (for drill-down). */
  onDataPointClick?: (label: string, value: number) => void;
  /** Multi-series dataset — when provided, used instead of data/overlayData. */
  multiSeriesData?: Record<string, string | number | undefined>[];
  /** Series configuration for multi-series mode. */
  seriesConfig?: SeriesConfig[];
  /** Tooltip label for the primary data series (default "Games"). */
  valueLabel?: string;
  /** Tooltip label for the overlay data series (default "Players"). */
  overlayLabel?: string;
}

/** Theme colors matching the admin dark theme. */
const GRID_COLOR = "#2a2a4a";
const LABEL_COLOR = "#666";
const TOOLTIP_BG = "#1a1a2e";
const TOOLTIP_BORDER = "#4a9eff";
const TOOLTIP_TEXT = "#e0e0e0";

/**
 * Area chart wrapper around Recharts with optional overlay data and click support.
 *
 * @param props - Chart configuration and data.
 * @returns Recharts-based area chart element.
 */
export default function RechartsAreaChart({
  data,
  overlayData,
  height = 220,
  color = "#4a9eff",
  overlayColor = "#2ed573",
  fillOpacity = 0.15,
  showGrid = true,
  formatValue = (v) => v.toLocaleString(),
  onDataPointClick,
  multiSeriesData,
  seriesConfig,
  valueLabel = "Games",
  overlayLabel = "Players",
}: RechartsAreaChartProps) {
  const useMultiSeries = multiSeriesData && seriesConfig && multiSeriesData.length > 0;

  if (!useMultiSeries && data.length === 0) {
    return (
      <div className="area-chart-empty" data-testid="area-chart-empty">
        No data available
      </div>
    );
  }

  // Merge primary and overlay data into a single dataset for Recharts
  const merged = useMultiSeries
    ? multiSeriesData
    : data.map((d, i) => ({
        label: d.label,
        value: d.value,
        overlay: overlayData && i < overlayData.length ? overlayData[i].value : undefined,
      }));

  const dataLength = useMultiSeries ? multiSeriesData.length : data.length;
  // Show every Nth label to avoid crowding
  const labelStep = Math.max(1, Math.floor(dataLength / 8));

  function handleClick(payload: Record<string, unknown> | null | undefined) {
    if (onDataPointClick && payload && typeof payload.label === "string") {
      onDataPointClick(payload.label, payload.value as number);
    }
  }

  // Build series name and color lookups for multi-series tooltip
  const seriesNameMap = new Map<string, string>();
  const seriesColorMap = new Map<string, string>();
  if (seriesConfig) {
    for (const s of seriesConfig) {
      seriesNameMap.set(s.key, s.name);
      seriesColorMap.set(s.key, s.color);
    }
  }

  return (
    <div className="area-chart-container" data-testid="area-chart">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={merged}
          onClick={(e: Record<string, unknown> | null) => {
            const ap = (e as { activePayload?: { payload: Record<string, unknown> }[] })?.activePayload;
            if (ap?.[0]) {
              handleClick(ap[0].payload);
            }
          }}
          style={{ cursor: onDataPointClick ? "pointer" : undefined }}
        >
          {showGrid && (
            <CartesianGrid
              stroke={GRID_COLOR}
              strokeDasharray="3 3"
              vertical={false}
            />
          )}
          <XAxis
            dataKey="label"
            tick={{ fill: LABEL_COLOR, fontSize: 10 }}
            // Only trim labels that look like YYYY-MM-DD dates (show MM-DD
            // instead). Anything else passes through untouched so non-date
            // labels (mode slugs, usernames, etc.) aren't silently mangled
            // by blind slice(-5).
            tickFormatter={(val: string) =>
              /^\d{4}-\d{2}-\d{2}$/.test(val) ? val.slice(5) : val
            }
            interval={labelStep - 1}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: LABEL_COLOR, fontSize: 10 }}
            tickFormatter={(val: number) => formatValue(val)}
            axisLine={false}
            tickLine={false}
            width={48}
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
            content={useMultiSeries ? (props: Record<string, unknown>) => {
              const { active, payload, label } = props as {
                active?: boolean;
                payload?: { dataKey: string; value: number }[];
                label?: string;
              };
              if (!active || !payload) return null;
              return (
                <div style={{
                  backgroundColor: TOOLTIP_BG,
                  border: `1px solid ${TOOLTIP_BORDER}`,
                  borderRadius: 4,
                  padding: "8px 12px",
                  fontSize: 12,
                }}>
                  <div style={{ color: TOOLTIP_TEXT, marginBottom: 4 }}>{label}</div>
                  {payload.map((entry) => {
                    const seriesColor = seriesColorMap.get(entry.dataKey) ?? TOOLTIP_TEXT;
                    const seriesName = seriesNameMap.get(entry.dataKey) ?? entry.dataKey;
                    if (entry.value == null) return null;
                    return (
                      <div key={entry.dataKey} style={{ color: seriesColor, padding: "1px 0" }}>
                        {seriesName}: {formatValue(Number(entry.value))}
                      </div>
                    );
                  })}
                </div>
              );
            } : undefined}
            formatter={useMultiSeries ? undefined : (value: unknown, name: unknown) => [
              formatValue(Number(value)),
              name === "value" ? valueLabel : overlayLabel,
            ]}
            labelFormatter={useMultiSeries ? undefined : (label: unknown) => String(label)}
          />
          {useMultiSeries ? (
            seriesConfig.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                fill={s.color}
                fillOpacity={s.fillOpacity ?? fillOpacity}
                strokeWidth={2}
                strokeDasharray={s.strokeDasharray}
                activeDot={{
                  r: 5,
                  fill: s.color,
                  stroke: "#fff",
                  strokeWidth: 2,
                }}
              />
            ))
          ) : (
            <>
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                fill={color}
                fillOpacity={fillOpacity}
                strokeWidth={2}
                activeDot={{
                  r: 5,
                  fill: color,
                  stroke: "#fff",
                  strokeWidth: 2,
                }}
              />
              {overlayData && overlayData.length > 0 && (
                <Area
                  type="monotone"
                  dataKey="overlay"
                  stroke={overlayColor}
                  fill="none"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  activeDot={{
                    r: 5,
                    fill: overlayColor,
                    stroke: "#fff",
                    strokeWidth: 2,
                  }}
                />
              )}
            </>
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
