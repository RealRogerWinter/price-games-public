/**
 * Admin Referrals analytics & insights dashboard.
 *
 * Surfaces referral-program performance to admins: KPI counters, a daily
 * created-vs-credited chart, the top-referrers leaderboard, and a
 * breakdown of rejection reasons. The dashboard is its own page (rather
 * than a v2 Insights tab) because it does not share the audience / device
 * filter axes — only a time-window selector applies.
 */

import { Fragment, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { AdminReferralRange, AdminReferredUser } from "@price-game/shared";
import {
  getReferralAnalyticsSummary,
  getReferralAnalyticsDaily,
  getReferralAnalyticsTopReferrers,
  getReferralAnalyticsRejections,
  getReferralAnalyticsByReferrer,
} from "../../api/adminClient";
import AvatarIcon from "../../components/multiplayer/AvatarIcon";

const RANGES: Array<{ value: AdminReferralRange; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "28d", label: "Last 28 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const TOP_LIMIT = 20;

export default function AdminReferralsPage(): React.ReactElement {
  // Per-mount QueryClient keeps cache scoped to this page — important so
  // test runs and back-navigation start with a clean slate.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
    [],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

function Dashboard(): React.ReactElement {
  const [range, setRange] = useState<AdminReferralRange>("28d");
  const [expandedReferrerId, setExpandedReferrerId] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ["referrals", "summary", range],
    queryFn: () => getReferralAnalyticsSummary(range),
  });
  const daily = useQuery({
    queryKey: ["referrals", "daily", range],
    queryFn: () => getReferralAnalyticsDaily(range),
  });
  const top = useQuery({
    queryKey: ["referrals", "top", range, TOP_LIMIT],
    queryFn: () => getReferralAnalyticsTopReferrers(range, TOP_LIMIT),
  });
  const rejections = useQuery({
    queryKey: ["referrals", "rejections", range],
    queryFn: () => getReferralAnalyticsRejections(range),
  });

  const totalRejected = (rejections.data ?? []).reduce((s, r) => s + r.count, 0);

  return (
    <div className="admin-dashboard" data-testid="admin-referrals-page">
      <div className="admin-dashboard-header">
        <h1>Referrals — Insights</h1>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as AdminReferralRange)}
          data-testid="referrals-range-select"
          style={{ padding: "8px 12px", background: "#16213e", border: "1px solid #2a2a4a", color: "#e0e0e0", borderRadius: 4 }}
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="kpi-grid">
        <Kpi testId="referrals-kpi-total" label="Total" value={summary.data?.total ?? 0} />
        <Kpi testId="referrals-kpi-credited" label="Credited" value={summary.data?.credited ?? 0} />
        <Kpi testId="referrals-kpi-pending" label="Pending" value={summary.data?.pending ?? 0} />
        <Kpi testId="referrals-kpi-rejected" label="Rejected" value={summary.data?.rejected ?? 0} />
        <Kpi
          testId="referrals-kpi-conversion"
          label="Conversion"
          value={`${((summary.data?.conversionRate ?? 0) * 100).toFixed(1)}%`}
          tooltip="Credited / Total"
        />
        <Kpi
          testId="referrals-kpi-unique"
          label="Unique referrers"
          value={summary.data?.uniqueReferrers ?? 0}
        />
      </div>

      <div className="admin-analytics-chart" data-testid="referrals-daily-chart">
        <h2>Created vs credited (daily)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={daily.data ?? []} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="created" name="Created" stroke="#4c78a8" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="credited" name="Credited" stroke="#54a24b" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-chart">
        <h2>Top referrers</h2>
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 8px 0" }}>
          Click a row to see which accounts that user referred.
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table" data-testid="referrals-leaderboard">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>#</th>
                <th>User</th>
                <th>Credited</th>
                <th>Pending</th>
                <th>Rejected</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(top.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "#666", padding: 16 }}>
                    No referrers in this window.
                  </td>
                </tr>
              ) : (
                (top.data ?? []).map((row, i) => {
                  const isExpanded = expandedReferrerId === row.userId;
                  return (
                    <Fragment key={row.userId}>
                      <tr
                        data-testid={`referrals-leaderboard-row-${row.userId}`}
                        onClick={() => setExpandedReferrerId(isExpanded ? null : row.userId)}
                        style={{ cursor: "pointer" }}
                        aria-expanded={isExpanded}
                      >
                        <td style={{ color: "#888", fontFamily: "monospace" }}>
                          {isExpanded ? "▼" : "▶"}
                        </td>
                        <td>{i + 1}</td>
                        <td>
                          <Link
                            to={`/admin/users/${row.userId}`}
                            style={{ color: "#4a9eff", display: "inline-flex", alignItems: "center", gap: 8 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {row.avatar && <AvatarIcon avatar={row.avatar} size={24} />}
                            <span>{row.username}</span>
                          </Link>
                        </td>
                        <td><strong>{row.credited}</strong></td>
                        <td>{row.pending}</td>
                        <td>{row.rejected}</td>
                        <td>{row.total}</td>
                      </tr>
                      {isExpanded && (
                        <tr data-testid={`referrals-leaderboard-detail-${row.userId}`}>
                          <td colSpan={7} style={{ background: "#0f1426", padding: 12 }}>
                            <ReferredUsersList referrerId={row.userId} range={range} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-analytics-chart">
        <h2>Rejection breakdown</h2>
        <div className="admin-table-wrap">
          <table className="admin-table" data-testid="referrals-rejections">
            <thead>
              <tr>
                <th>Reason</th>
                <th>Count</th>
                <th>% of rejected</th>
              </tr>
            </thead>
            <tbody>
              {(rejections.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ textAlign: "center", color: "#666", padding: 16 }}>
                    No rejections in this window.
                  </td>
                </tr>
              ) : (
                (rejections.data ?? []).map((r) => (
                  <tr key={r.reason} data-testid={`referrals-rejection-row-${r.reason}`}>
                    <td>{humanizeReason(r.reason)}</td>
                    <td>{r.count}</td>
                    <td>{totalRejected > 0 ? `${((r.count / totalRejected) * 100).toFixed(1)}%` : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: number | string;
  testId: string;
  tooltip?: string;
}): React.ReactElement {
  return (
    <div className="kpi-card" title={props.tooltip} data-testid={props.testId}>
      <div className="kpi-label">{props.label}</div>
      <div className="kpi-value">
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
    </div>
  );
}

/**
 * Drill-down panel showing the accounts a single referrer brought in.
 *
 * Lazy-loaded — the query only fires when a row is expanded. Reuses the
 * dashboard's range filter so the list matches what the leaderboard counted.
 */
function ReferredUsersList(props: { referrerId: string; range: AdminReferralRange }): React.ReactElement {
  const referred = useQuery({
    queryKey: ["referrals", "byReferrer", props.referrerId, props.range],
    queryFn: () => getReferralAnalyticsByReferrer(props.referrerId, props.range),
  });

  if (referred.isLoading) {
    return (
      <div data-testid={`referred-users-loading-${props.referrerId}`} style={{ color: "#888", padding: 8 }}>
        Loading referred accounts…
      </div>
    );
  }
  if (referred.isError) {
    return (
      <div data-testid={`referred-users-error-${props.referrerId}`} style={{ color: "#e57373", padding: 8 }}>
        Failed to load referred accounts.
      </div>
    );
  }
  const rows = referred.data ?? [];
  if (rows.length === 0) {
    return (
      <div data-testid={`referred-users-empty-${props.referrerId}`} style={{ color: "#888", padding: 8 }}>
        No referred accounts in this window.
      </div>
    );
  }
  return (
    <table className="admin-table" data-testid={`referred-users-table-${props.referrerId}`}>
      <thead>
        <tr>
          <th>User</th>
          <th>Status</th>
          <th>Reason</th>
          <th>Signed up</th>
          <th>Credited</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u: AdminReferredUser) => (
          <tr key={u.referralId} data-testid={`referred-user-row-${u.userId}`}>
            <td>
              <Link
                to={`/admin/users/${u.userId}`}
                style={{ color: "#4a9eff", display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                {u.avatar && <AvatarIcon avatar={u.avatar} size={20} />}
                <span>{u.username}</span>
              </Link>
            </td>
            <td>
              <StatusBadge status={u.status} />
            </td>
            <td>{u.status === "rejected" ? humanizeReason(u.rejectionReason ?? "unknown") : "—"}</td>
            <td>{formatDate(u.createdAt)}</td>
            <td>{u.creditedAt ? formatDate(u.creditedAt) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge(props: { status: "pending" | "credited" | "rejected" }): React.ReactElement {
  const colors: Record<string, { bg: string; fg: string }> = {
    credited: { bg: "#1f3d2a", fg: "#7fdc9a" },
    pending: { bg: "#3d361f", fg: "#dcc97f" },
    rejected: { bg: "#3d1f1f", fg: "#dc8a8a" },
  };
  const c = colors[props.status] ?? { bg: "#2a2a4a", fg: "#cccccc" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      background: c.bg,
      color: c.fg,
      fontSize: 12,
      fontWeight: 600,
      textTransform: "capitalize",
    }}>
      {props.status}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** Human-readable label for a `rejection_reason` enum value. */
function humanizeReason(reason: string): string {
  switch (reason) {
    case "ip_match":
      return "Same IP as referrer";
    case "disposable_email":
      return "Disposable email";
    case "unknown":
      return "Unknown";
    default:
      return reason;
  }
}
