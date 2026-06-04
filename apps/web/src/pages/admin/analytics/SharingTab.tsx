/**
 * Sharing tab — multiplayer share-link funnel.
 *
 * Surfaces the dimensions PR 205's share_clicked instrumentation made
 * possible: how many copies, host vs player split, click-throughs to the
 * /<roomCode> URL, joins via share_link, and game completions for those
 * joiners. Conversion rates are computed client-side off the raw counts.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LabelList,
} from "recharts";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import { fetchShareLinkFunnel } from "./analyticsApi";
import type { ShareLinkFunnelResult } from "./types";

export default function SharingTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();
  const funnel = useQuery({
    queryKey: ["analytics", "v2", "share-link-funnel", filters],
    queryFn: () => fetchShareLinkFunnel(filters),
  });

  if (funnel.isLoading) {
    return <div className="admin-loading" data-testid="sharing-loading">Loading…</div>;
  }
  if (funnel.error || !funnel.data) {
    return <div className="admin-error" data-testid="sharing-error">Failed to load share-link data.</div>;
  }

  const data = funnel.data;
  const steps = funnelSteps(data);
  const drops = stepDropOffs(steps);

  return (
    <div className="admin-analytics-tab-content" data-testid="sharing-tab">
      <div className="admin-analytics-chart">
        <h2>Share-link funnel</h2>
        <p className="admin-chart-caption">
          Copy → click → join → complete. Each step is computed from
          server-side events; synthetic backfilled rows are excluded
          since the intermediate page-view steps don't exist for them.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart
            data={steps}
            layout="vertical"
            margin={{ top: 16, right: 32, left: 80, bottom: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis type="number" tick={{ fontSize: 12 }} />
            <YAxis dataKey="step" type="category" tick={{ fontSize: 12 }} width={140} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Count"),
              ]}
            />
            <Bar dataKey="count" name="Count" fill="#4c78a8">
              <LabelList
                dataKey="count"
                position="right"
                formatter={(v: unknown) =>
                  typeof v === "number" ? v.toLocaleString() : String(v)
                }
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-table">
        <h2>Step-by-step conversion</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Step</th>
              <th className="num">Count</th>
              <th className="num">From previous</th>
              <th className="num">From copy</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={s.step} data-testid={`funnel-row-${i}`}>
                <td>{s.step}</td>
                <td className="num">{s.count.toLocaleString()}</td>
                <td className="num">{drops[i].fromPrev}</td>
                <td className="num">{drops[i].fromTop}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-analytics-table">
        <h2>Who copies the link?</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Role</th>
              <th className="num">Copies</th>
              <th className="num">Share of total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Host</td>
              <td className="num">{data.hostCopied.toLocaleString()}</td>
              <td className="num">{pct(data.hostCopied, data.copied)}</td>
            </tr>
            <tr>
              <td>Player (non-host)</td>
              <td className="num">{data.playerCopied.toLocaleString()}</td>
              <td className="num">{pct(data.playerCopied, data.copied)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FunnelStep {
  step: string;
  count: number;
}

function funnelSteps(data: ShareLinkFunnelResult): FunnelStep[] {
  return [
    { step: "Copy", count: data.copied },
    { step: "Visit /<roomCode>", count: data.visitedRoomLink },
    { step: "Join via share link", count: data.joinedViaShareLink },
    { step: "Complete a game", count: data.completedAfterShareLink },
  ];
}

function stepDropOffs(steps: FunnelStep[]): Array<{ fromPrev: string; fromTop: string }> {
  const top = steps[0]?.count ?? 0;
  return steps.map((s, i) => ({
    fromPrev: i === 0 ? "—" : pct(s.count, steps[i - 1].count),
    fromTop: i === 0 ? "—" : pct(s.count, top),
  }));
}

function pct(n: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${((n / denom) * 100).toFixed(1)}%`;
}
