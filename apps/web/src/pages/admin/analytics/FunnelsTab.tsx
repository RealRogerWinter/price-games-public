/**
 * Funnels tab — renders all 9 pre-built funnels.
 *
 * Each funnel is a horizontal bar chart where each step shows absolute
 * visitors + % from start + drop-off from the previous step. Drop-off
 * annotations are the thing PMs will stare at.
 *
 * No self-serve builder (per the approved plan): 9 curated funnels that
 * answer the business questions cost less to ship and are more useful in
 * practice than a generic UI.
 */

import { useQuery } from "@tanstack/react-query";
import { csvExportUrl, fetchAllFunnels } from "./analyticsApi";
import CsvButton from "./CsvButton";
import type { FunnelResult, FunnelStepResult } from "./types";

export default function FunnelsTab(): React.ReactElement {
  const funnels = useQuery({
    queryKey: ["analytics", "v2", "funnels"],
    queryFn: fetchAllFunnels,
  });

  if (funnels.isLoading) {
    return <div className="admin-loading" data-testid="funnels-loading">Loading…</div>;
  }
  if (funnels.error) {
    return <div className="admin-error" data-testid="funnels-error">Failed to load funnels.</div>;
  }

  return (
    <div className="admin-analytics-tab-content" data-testid="funnels-tab">
      <div className="admin-analytics-chart" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#9aa0a6", fontSize: "0.85rem" }}>
          {funnels.data!.length} pre-built funnels
        </span>
        <CsvButton href={csvExportUrl("funnels")} filename="analytics-funnels.csv" />
      </div>
      {funnels.data!.map((f) => (
        <FunnelCard key={f.id} funnel={f} />
      ))}
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: FunnelResult }): React.ReactElement {
  const start = funnel.steps[0]?.visitors ?? 0;
  return (
    <div className="admin-analytics-chart funnel-card" data-testid={`funnel-${funnel.id}`}>
      <h2>{funnel.name}</h2>
      <p className="funnel-desc">{funnel.description}</p>
      {start === 0 ? (
        <p className="admin-empty">No data yet in this funnel's window.</p>
      ) : (
        <div className="funnel-steps">
          {funnel.steps.map((s, i) => (
            <FunnelStepRow
              key={s.step}
              step={s}
              widthPct={(s.visitors / start) * 100}
              previous={i > 0 ? funnel.steps[i - 1] : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FunnelStepRow({
  step,
  widthPct,
  previous,
}: {
  step: FunnelStepResult;
  widthPct: number;
  previous: FunnelStepResult | null;
}): React.ReactElement {
  const dropoff = previous
    ? previous.visitors - step.visitors
    : null;
  const dropoffPct = previous && previous.visitors > 0
    ? (dropoff! / previous.visitors) * 100
    : null;
  return (
    <div className="funnel-step" data-testid={`funnel-step-${step.step}`}>
      <div className="funnel-step-label">
        <span className="funnel-step-num">{step.step}.</span>
        <span>{step.label}</span>
      </div>
      <div className="funnel-step-bar-container">
        <div
          className="funnel-step-bar"
          style={{ width: `${Math.max(0.5, widthPct)}%` }}
        />
        <div className="funnel-step-stats">
          <strong>{step.visitors.toLocaleString()}</strong>
          <span className="funnel-step-pct">
            {(step.conversionFromStart * 100).toFixed(1)}% of start
          </span>
          {dropoff !== null && dropoff > 0 && (
            <span className="funnel-step-dropoff">
              −{dropoff.toLocaleString()} ({dropoffPct!.toFixed(1)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
