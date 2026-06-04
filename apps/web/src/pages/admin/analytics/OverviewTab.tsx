/**
 * Overview tab — KPI cards + daily trend chart.
 *
 * The one chart that matters on this tab is the daily sessions trend with
 * engaged-sessions overlay. KPI cards above surface DAU/WAU/MAU, engagement
 * rate, games-per-session, and the live-visitors "right now" badge so an
 * admin glancing at this page can answer "are we growing and are users
 * engaging" in under 5 seconds.
 */

import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import { csvExportUrl, fetchDaily, fetchOverview } from "./analyticsApi";
import { useLivePulse } from "./useLivePulse";
import CsvButton from "./CsvButton";
import { getReferralAnalyticsSummary } from "../../../api/adminClient";
import type { AdminReferralRange } from "@price-game/shared";

/** Map the v2 analytics range to a compatible referral range. */
function v2RangeToReferralRange(r: string): AdminReferralRange {
  if (r === "7d" || r === "28d" || r === "90d") return r;
  // 1d collapses to 7d — referral volume per day is too small to be meaningful.
  return "7d";
}

export default function OverviewTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();
  // Live pulse via the Socket.IO admin namespace. Prefer the pulse value
  // over the REST snapshot so the KPI stays fresh without refetches.
  const { pulse, connected } = useLivePulse();

  const overview = useQuery({
    queryKey: ["analytics", "v2", "overview", filters],
    queryFn: () => fetchOverview(filters),
  });

  const daily = useQuery({
    queryKey: ["analytics", "v2", "daily", filters],
    queryFn: () => fetchDaily(filters),
  });

  const referralRange = v2RangeToReferralRange(filters.range);
  const referrals = useQuery({
    queryKey: ["analytics", "referrals", "summary", referralRange],
    queryFn: () => getReferralAnalyticsSummary(referralRange),
  });

  if (overview.isLoading || daily.isLoading) {
    return <div className="admin-loading" data-testid="overview-loading">Loading…</div>;
  }
  if (overview.error || daily.error) {
    return <div className="admin-error" data-testid="overview-error">Failed to load analytics.</div>;
  }

  const k = overview.data!;
  const series = daily.data!;

  return (
    <div className="admin-analytics-tab-content" data-testid="overview-tab">
      <div className="kpi-grid">
        <Kpi label="DAU" value={k.dau} />
        <Kpi label="WAU" value={k.wau} />
        <Kpi label="MAU" value={k.mau} />
        <Kpi label="Sessions" value={k.sessions} delta={k.sessionsDelta} />
        <Kpi label="Engagement rate" value={pct(k.engagementRate)} tooltip="% of sessions with ≥1 game_started" />
        <Kpi label="Games / session" value={k.avgGamesPerSession.toFixed(2)} />
        <Kpi label="% logged-in" value={pct(k.pctLoggedIn)} />
        <Kpi
          label="Live visitors"
          value={pulse?.liveVisitors ?? k.liveVisitors}
          tooltip={
            connected
              ? "Active in last 5 min (live feed)"
              : "Active in last 5 min (snapshot — live feed unavailable)"
          }
          live={connected}
        />
        <Kpi
          label="Credited referrals"
          value={referrals.data?.credited ?? 0}
          tooltip="Referrals credited in this window. See /admin/referrals for breakdowns."
        />
      </div>

      {connected && pulse && pulse.recentEvents.length > 0 && (
        <div className="live-event-strip" data-testid="live-event-strip" aria-live="polite">
          <span className="live-event-label">
            <span className="kpi-live-dot" aria-hidden /> Last 10s
          </span>
          <span className="live-event-sessions">
            {pulse.sessionsStartedLastMinute} sessions in last 60s
          </span>
          <ul className="live-event-chips">
            {pulse.recentEvents.slice(0, 6).map((e) => (
              <li key={e.name} className="live-event-chip" data-testid={`live-event-${e.name}`}>
                <span className="live-event-chip-name">{e.name}</span>
                <span className="live-event-chip-count">{e.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="admin-analytics-chart">
        <h2>
          Sessions trend
          <CsvButton href={csvExportUrl("daily", filters)} filename="analytics-daily.csv" />
        </h2>
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={series} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              labelFormatter={(label) => `Date (PST): ${label}`}
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                name,
              ]}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="sessions"
              name="Sessions"
              stroke="#4c78a8"
              fill="#4c78a8"
              fillOpacity={0.25}
            />
            <Area
              type="monotone"
              dataKey="engagedSessions"
              name="Engaged (≥1 game)"
              stroke="#54a24b"
              fill="#54a24b"
              fillOpacity={0.25}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Kpi(props: { label: string; value: number | string; delta?: number | null; tooltip?: string; live?: boolean }): React.ReactElement {
  const deltaPct = typeof props.delta === "number" ? props.delta * 100 : null;
  const deltaCls = deltaPct == null ? "" : deltaPct >= 0 ? "positive" : "negative";
  return (
    <div className="kpi-card" title={props.tooltip}>
      <div className="kpi-label">{props.label}{props.live ? <span className="kpi-live-dot" /> : null}</div>
      <div className="kpi-value">
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      {deltaPct != null && (
        <div className={`kpi-delta ${deltaCls}`}>
          {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
