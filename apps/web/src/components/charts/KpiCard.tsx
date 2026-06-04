interface KpiCardProps {
  /** Large display value. */
  value: string;
  /** Descriptive label below the value. */
  label: string;
  /** Optional percentage change (positive = up, negative = down). */
  delta?: number;
  /** Optional label for the delta (e.g. "vs prior period"). */
  deltaLabel?: string;
}

/**
 * KPI card displaying a metric value with optional trend indicator.
 *
 * @param props - Card value, label, and optional delta percentage.
 * @returns KPI card element.
 */
export default function KpiCard({ value, label, delta, deltaLabel }: KpiCardProps) {
  let deltaClass = "kpi-delta";
  let deltaArrow = "";
  if (delta !== undefined && delta !== 0) {
    if (delta > 0) {
      deltaClass += " kpi-delta-up";
      deltaArrow = "\u25B2"; // ▲
    } else {
      deltaClass += " kpi-delta-down";
      deltaArrow = "\u25BC"; // ▼
    }
  }

  return (
    <div className="admin-kpi-card" data-testid="kpi-card">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {delta !== undefined && (
        <div className={deltaClass} data-testid="kpi-delta">
          <span className="kpi-delta-arrow">{deltaArrow}</span>
          <span className="kpi-delta-pct">{Math.abs(delta).toFixed(1)}%</span>
          {deltaLabel && <span className="kpi-delta-label">{deltaLabel}</span>}
        </div>
      )}
    </div>
  );
}
