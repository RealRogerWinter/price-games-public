/**
 * Acquisition tab — source breakdown + UTM tag performance.
 *
 * The source breakdown bar chart shows where traffic comes from at a coarse
 * level (paid / organic / social / email / referral / direct / unknown).
 * The UTM tag table below joins `utm_tags` to the new `analytics_sessions`
 * table so marketing can see which specific campaigns produce engaged
 * users, not just click volume.
 */

import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import { csvExportUrl, fetchAcquisition, fetchUtmTags } from "./analyticsApi";
import CsvButton from "./CsvButton";

export default function AcquisitionTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();

  const sources = useQuery({
    queryKey: ["analytics", "v2", "acquisition", filters],
    queryFn: () => fetchAcquisition(filters),
  });

  const utmTags = useQuery({
    queryKey: ["analytics", "v2", "utm-tags", filters],
    queryFn: () => fetchUtmTags(filters),
  });

  if (sources.isLoading || utmTags.isLoading) {
    return <div className="admin-loading" data-testid="acq-loading">Loading…</div>;
  }
  if (sources.error || utmTags.error) {
    return <div className="admin-error" data-testid="acq-error">Failed to load acquisition data.</div>;
  }

  return (
    <div className="admin-analytics-tab-content" data-testid="acquisition-tab">
      <div className="admin-analytics-chart">
        <h2>
          Sessions by acquisition source
          <CsvButton href={csvExportUrl("acquisition", filters)} filename="analytics-acquisition.csv" />
        </h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={sources.data!} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="source" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v, name) => [
                typeof v === "number" ? v.toLocaleString() : v,
                String(name ?? "Sessions"),
              ]}
              labelFormatter={(label) => `Source: ${label}`}
            />
            <Bar dataKey="sessions" name="Sessions" fill="#4c78a8" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="admin-analytics-table">
        <h2>
          UTM campaign performance
          <CsvButton href={csvExportUrl("utm-tags", filters)} filename="analytics-utm-tags.csv" />
        </h2>
        <p className="admin-footnote" data-testid="acq-utm-cohort-note">
          Sessions match each tag's <code>(utm_source, utm_medium, utm_campaign)</code>{" "}
          tuple exactly; a tag with <code>utm_medium</code> empty only matches sessions
          whose entry medium is also empty. If a tag's session count looks lower than
          you expect, check that the tag's medium / campaign exactly match the URL the
          campaign actually uses. See <a href="/admin/utm-tags">UTM Tags</a> for the
          full leaderboard with confidence intervals.
        </p>
        {utmTags.data!.length === 0 ? (
          <p className="admin-empty">No UTM tags configured. Create one in <a href="/admin/utm-tags">UTM Tags</a>.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Source</th>
                <th>Campaign</th>
                <th className="num">Clicks</th>
                <th className="num">Sessions</th>
                <th className="num">Signups</th>
                <th className="num">Games completed</th>
                <th className="num">Engagement</th>
              </tr>
            </thead>
            <tbody>
              {utmTags.data!.map((r) => (
                <tr key={r.tagId} data-testid={`utm-row-${r.tagId}`}>
                  <td><a href={`/admin/utm-tags/${r.tagId}`}>{r.name}</a></td>
                  <td>{r.utmSource}</td>
                  <td>{r.utmCampaign ?? "—"}</td>
                  <td className="num">{r.clickCount.toLocaleString()}</td>
                  <td className="num">{r.sessions.toLocaleString()}</td>
                  <td className="num">{r.signups.toLocaleString()}</td>
                  <td className="num">{r.gamesCompleted.toLocaleString()}</td>
                  <td className="num">{(r.engagementRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
