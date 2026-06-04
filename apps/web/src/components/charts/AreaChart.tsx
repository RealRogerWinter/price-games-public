import { useState } from "react";

interface AreaChartProps {
  /** Data points with labels (e.g. dates) and numeric values. */
  data: { label: string; value: number }[];
  /** Optional secondary data overlay (e.g. player activity). */
  overlayData?: { label: string; value: number }[];
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
}

const PADDING = { top: 20, right: 16, bottom: 32, left: 48 };

/**
 * Reusable SVG area/line chart with optional overlay, grid lines, and hover tooltips.
 *
 * @param props - Chart configuration and data.
 * @returns SVG chart element.
 */
export default function AreaChart({
  data,
  overlayData,
  height = 200,
  color = "#4a9eff",
  overlayColor = "#2ed573",
  fillOpacity = 0.15,
  showGrid = true,
  formatValue = (v) => v.toLocaleString(),
}: AreaChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="area-chart-empty" data-testid="area-chart-empty">
        No data available
      </div>
    );
  }

  const viewWidth = 600;
  const viewHeight = height;
  const chartW = viewWidth - PADDING.left - PADDING.right;
  const chartH = viewHeight - PADDING.top - PADDING.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), ...(overlayData?.map((d) => d.value) ?? []), 1);
  const yTicks = 5;

  function x(i: number) {
    return PADDING.left + (i / Math.max(data.length - 1, 1)) * chartW;
  }
  function y(v: number) {
    return PADDING.top + chartH - (v / maxVal) * chartH;
  }

  // Build path strings
  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(data.length - 1).toFixed(1)},${(PADDING.top + chartH).toFixed(1)} L${x(0).toFixed(1)},${(PADDING.top + chartH).toFixed(1)} Z`;

  // Overlay uses its own x-scale if length differs from primary data
  let overlayPath = "";
  if (overlayData && overlayData.length > 0) {
    const ox = (i: number) => PADDING.left + (i / Math.max(overlayData!.length - 1, 1)) * chartW;
    overlayPath = overlayData.map((d, i) => `${i === 0 ? "M" : "L"}${ox(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  }

  // X-axis labels: show every Nth
  const labelStep = Math.max(1, Math.floor(data.length / 8));

  return (
    <div className="area-chart-container" data-testid="area-chart">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Area chart"
      >
        {/* Grid lines and Y labels */}
        {showGrid && Array.from({ length: yTicks + 1 }, (_, i) => {
          const val = (maxVal / yTicks) * (yTicks - i);
          const yy = y(val);
          return (
            <g key={i}>
              <line x1={PADDING.left} y1={yy} x2={viewWidth - PADDING.right} y2={yy} stroke="#2a2a4a" strokeWidth="1" />
              <text x={PADDING.left - 6} y={yy + 4} textAnchor="end" fill="#666" fontSize="10">
                {formatValue(Math.round(val))}
              </text>
            </g>
          );
        })}

        {/* Area fill */}
        <path d={areaPath} fill={color} opacity={fillOpacity} />

        {/* Primary line */}
        <path d={linePath} fill="none" stroke={color} strokeWidth="2" />

        {/* Overlay line */}
        {overlayPath && (
          <path d={overlayPath} fill="none" stroke={overlayColor} strokeWidth="2" strokeDasharray="4 2" />
        )}

        {/* X-axis labels */}
        {data.map((d, i) =>
          i % labelStep === 0 || i === data.length - 1 ? (
            <text
              key={i}
              x={x(i)}
              y={viewHeight - 4}
              textAnchor="middle"
              fill="#666"
              fontSize="10"
            >
              {d.label.length > 5 ? d.label.slice(-5) : d.label}
            </text>
          ) : null
        )}

        {/* Hover targets — invisible rect columns per data point */}
        {data.map((d, i) => {
          const colW = chartW / data.length;
          return (
            <rect
              key={i}
              x={x(i) - colW / 2}
              y={PADDING.top}
              width={colW}
              height={chartH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            />
          );
        })}

        {/* Hover indicator */}
        {hoverIdx !== null && (
          <>
            <circle cx={x(hoverIdx)} cy={y(data[hoverIdx].value)} r="4" fill={color} stroke="#fff" strokeWidth="2" />
            <rect
              x={x(hoverIdx) - 40}
              y={y(data[hoverIdx].value) - 28}
              width="80"
              height="20"
              rx="4"
              fill="#1a1a2e"
              stroke="#4a9eff"
              strokeWidth="1"
            />
            <text
              x={x(hoverIdx)}
              y={y(data[hoverIdx].value) - 14}
              textAnchor="middle"
              fill="#e0e0e0"
              fontSize="11"
              fontWeight="600"
            >
              {formatValue(data[hoverIdx].value)}
            </text>
            {overlayData && hoverIdx < overlayData.length && (
              <circle cx={x(hoverIdx)} cy={y(overlayData[hoverIdx].value)} r="4" fill={overlayColor} stroke="#fff" strokeWidth="2" />
            )}
          </>
        )}
      </svg>
    </div>
  );
}
