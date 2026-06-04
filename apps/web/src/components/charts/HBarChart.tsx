import { useState } from "react";

interface HBarChartProps {
  /** Data points with labels and numeric values. */
  data: { label: string; value: number }[];
  /** Bar color. */
  color?: string;
  /** Custom value formatter. */
  formatValue?: (v: number) => string;
}

/**
 * Horizontal bar chart rendered as SVG with labels, values, and hover highlight.
 *
 * @param props - Chart configuration and data.
 * @returns SVG horizontal bar chart element.
 */
export default function HBarChart({
  data,
  color = "#4a9eff",
  formatValue = (v) => v.toLocaleString(),
}: HBarChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="hbar-chart-empty" data-testid="hbar-chart-empty">
        No data available
      </div>
    );
  }

  const barHeight = 28;
  const gap = 6;
  const labelWidth = 140;
  const valueWidth = 60;
  const viewWidth = 500;
  const barAreaWidth = viewWidth - labelWidth - valueWidth - 16;
  const viewHeight = data.length * (barHeight + gap) + gap;
  const maxVal = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="hbar-chart-container" data-testid="hbar-chart">
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Horizontal bar chart"
      >
        {data.map((d, i) => {
          const yy = gap + i * (barHeight + gap);
          const barW = (d.value / maxVal) * barAreaWidth;
          const isHovered = hoverIdx === i;
          return (
            <g
              key={d.label}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <text
                x={labelWidth - 8}
                y={yy + barHeight / 2 + 4}
                textAnchor="end"
                fill={isHovered ? "#fff" : "#ccc"}
                fontSize="12"
              >
                {d.label.length > 18 ? d.label.slice(0, 16) + "..." : d.label}
              </text>
              <rect
                x={labelWidth}
                y={yy}
                width={Math.max(barW, 2)}
                height={barHeight}
                rx="4"
                fill={color}
                opacity={isHovered ? 1 : 0.8}
              />
              <text
                x={labelWidth + barAreaWidth + 8}
                y={yy + barHeight / 2 + 4}
                textAnchor="start"
                fill="#e0e0e0"
                fontSize="12"
                fontWeight="600"
              >
                {formatValue(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
