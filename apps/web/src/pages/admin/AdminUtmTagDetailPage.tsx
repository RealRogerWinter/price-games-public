import { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  getUtmTag,
  getUtmTagStats,
  getUtmTagTimeSeries,
  getUtmTagComparison,
  type AdminUtmTag,
  type AdminUtmTagStats,
  type AdminUtmRange,
} from "../../api/adminClient";
import RechartsAreaChart, {
  type SeriesConfig,
} from "../../components/charts/RechartsAreaChart";

/**
 * Compute a percent string for a funnel step, or an em-dash when signups=0
 * (divide-by-zero avoidance).
 */
function formatPercent(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((value / total) * 100)}%`;
}

/**
 * Return a fractional bar width (0..1) for the visual funnel. Widths
 * scale against the maximum value in the funnel (top of the funnel =
 * 100% width) so the narrowing visual stays meaningful even when signups
 * are small. Returns 0 when the denominator is zero so empty funnels
 * render as thin lines instead of NaN widths.
 */
function barFraction(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0.04, value / max);
}

/** Format a 0..1 rate as a 1-decimal percent, or "—" for non-finite. */
function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

type RangeChoice = "lifetime" | AdminUtmRange;

const RANGE_OPTIONS: Array<{ value: RangeChoice; label: string }> = [
  { value: "lifetime", label: "Lifetime" },
  { value: "7d", label: "7d" },
  { value: "28d", label: "28d" },
  { value: "90d", label: "90d" },
];

/** Tableau-10 colors used by the time-series chart series. */
const SERIES_CONFIG: SeriesConfig[] = [
  { key: "sessions", color: "#54a24b", name: "Sessions", fillOpacity: 0.2 },
  { key: "signups", color: "#f58518", name: "Signups", fillOpacity: 0.4 },
  {
    key: "anonymousPlays",
    color: "#4a9eff",
    name: "Anonymous plays",
    fillOpacity: 0.15,
  },
];

/**
 * Outer wrapper — provides a per-mount React Query client. Mirrors the
 * AdminReferralsPage / AdminAnalytics / AdminUtmTagsPage pattern.
 */
export default function AdminUtmTagDetailPage() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            // No retry: a 404 here means the tag genuinely doesn't exist;
            // silently retrying just delays surfacing the error to the
            // operator (and breaks the existing test that asserts the
            // error banner renders on a single rejection).
            retry: false,
          },
        },
      }),
    [],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <Detail />
    </QueryClientProvider>
  );
}

/**
 * Per-tag drill-down: range filter, traffic-over-time chart, conversion
 * funnel (preserved), and a "this tag vs all-tags average" comparison
 * block. Test-ids on the funnel + tuple sections are kept stable for the
 * existing test suite.
 */
function Detail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState<RangeChoice>("28d");

  // Tag is fetched once and never changes per page; window changes only
  // affect the funnel/timeseries.
  const tagQuery = useQuery<AdminUtmTag>({
    queryKey: ["admin", "utm", "tag", id],
    queryFn: () => getUtmTag(id!),
    enabled: !!id,
  });

  // Stats: lifetime if range=lifetime, otherwise window-bound.
  const statsQuery = useQuery<AdminUtmTagStats>({
    queryKey: ["admin", "utm", "stats", id, range],
    queryFn: () =>
      getUtmTagStats(id!, range === "lifetime" ? undefined : range),
    enabled: !!id,
  });

  // Time series: only meaningful when a window is selected. For lifetime
  // we still render the chart card but with a placeholder (no infinite
  // series).
  const seriesRange: AdminUtmRange = range === "lifetime" ? "28d" : range;
  const seriesQuery = useQuery({
    queryKey: ["admin", "utm", "timeseries", id, seriesRange],
    queryFn: () => getUtmTagTimeSeries(id!, seriesRange),
    enabled: !!id,
  });

  // Comparison summary: drives the "vs all-tags average" block. Always
  // queried at the same window the user is viewing the funnel in, so
  // ratios are apples-to-apples. Origin is derived from THIS tag's
  // origin so a system-managed tag (origin_key !== null) compares
  // against the system cohort and an admin tag against the admin
  // cohort — apples-to-apples within each curatorial group, and the
  // tag is guaranteed to appear in the response (so the vs-avg block
  // doesn't silently disappear on system tags reachable via direct URL).
  const compareOrigin: "admin" | "system" = tagQuery.data?.originKey ? "system" : "admin";
  const comparisonQuery = useQuery({
    queryKey: ["admin", "utm", "comparison", { range: seriesRange, origin: compareOrigin }],
    queryFn: () =>
      getUtmTagComparison({ range: seriesRange, origin: compareOrigin }),
    enabled: !!id && !!tagQuery.data,
  });

  const loading =
    tagQuery.isLoading ||
    statsQuery.isLoading ||
    (range !== "lifetime" && seriesQuery.isLoading);
  const error = tagQuery.error || statsQuery.error;

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" data-testid="utm-tag-detail-loading">
          Loading UTM tag details…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-page">
        <div className="admin-page-header">
          <button
            className="admin-btn-cancel"
            onClick={() => navigate("/admin/utm-tags")}
            data-testid="utm-tag-detail-back"
          >
            ← Back to UTM Tags
          </button>
        </div>
        <div className="admin-error" data-testid="utm-tag-detail-error">
          {error instanceof Error ? error.message : "Failed to load UTM tag details"}
        </div>
      </div>
    );
  }

  const tag = tagQuery.data;
  const stats = statsQuery.data;
  if (!tag || !stats) return null;

  const signups = stats.signups;

  // Scale funnel bar widths. When the tag has a short code we want the
  // clicks row to be the widest (top of funnel); otherwise signups is the
  // top. Guarantee a non-zero denominator so bars still render in the
  // all-zero case.
  const funnelMax = stats.hasShortCode
    ? Math.max(stats.clicks, stats.anonymousPlays, stats.signups, 1)
    : Math.max(stats.anonymousPlays, stats.signups, 1);

  const conversionRate = stats.hasShortCode && stats.clicks > 0
    ? formatPercent(stats.signups, stats.clicks)
    : null;

  // === Time-series chart data ===
  // Adapted to the multiSeriesData shape RechartsAreaChart expects: each
  // point is { label, sessions, signups, anonymousPlays }.
  const seriesData = (seriesQuery.data ?? []).map((p) => ({
    label: p.date,
    sessions: p.sessions,
    signups: p.signups,
    anonymousPlays: p.anonymousPlays,
  }));

  // === vs-average comparison ===
  // Use this tag's row from the comparison response (so the metrics
  // already account for window + cohort) and the global summary CR.
  const myRow = comparisonQuery.data?.rows.find((r) => r.tagId === tag.id);
  const globalCr = comparisonQuery.data?.summary.globalConversionRate;

  return (
    <div className="admin-page admin-utm-page" data-testid="utm-tag-detail-page">
      <div className="admin-page-header utm-detail-header">
        <div className="utm-detail-breadcrumb">
          <button
            className="utm-detail-back"
            onClick={() => navigate("/admin/utm-tags")}
            data-testid="utm-tag-detail-back"
          >
            ← Back to UTM tags
          </button>
          <div className="utm-detail-title-row">
            <h2>{tag.name}</h2>
            <span className={`utm-status-pill utm-status-${tag.status}`}>
              {tag.status}
            </span>
          </div>
        </div>
      </div>

      {/* === Range pills === */}
      <div className="utm-toolbar utm-detail-toolbar" data-testid="utm-detail-toolbar">
        <div
          className="utm-filter-pills"
          role="radiogroup"
          aria-label="Time range"
          data-testid="utm-detail-range-pills"
        >
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={range === opt.value}
              className={`utm-filter-pill${range === opt.value ? " utm-filter-pill-active" : ""}`}
              onClick={() => setRange(opt.value)}
              data-testid={`utm-detail-range-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* === Summary KPI cards === */}
      <div className="utm-stats-grid utm-detail-summary" data-testid="utm-tag-detail-summary">
        {stats.hasShortCode && (
          <div className="utm-stat-card utm-stat-card-highlight">
            <div className="utm-stat-value">
              {stats.clicks.toLocaleString()}
            </div>
            <div className="utm-stat-label">Short-link clicks</div>
          </div>
        )}
        <div className="utm-stat-card utm-stat-card-accent">
          <div className="utm-stat-value">{stats.signups.toLocaleString()}</div>
          <div className="utm-stat-label">
            {range === "lifetime" ? "Attributed signups" : `Signups (${range})`}
          </div>
        </div>
        <div className="utm-stat-card">
          <div className="utm-stat-value">
            {stats.wonReward.toLocaleString()}
          </div>
          <div className="utm-stat-label">Rewards won</div>
        </div>
        {conversionRate && (
          <div className="utm-stat-card utm-stat-card-muted">
            <div className="utm-stat-value">{conversionRate}</div>
            <div className="utm-stat-label">Click → signup</div>
          </div>
        )}
      </div>

      {/* === Tuple / identity card === */}
      <section className="utm-detail-card">
        <header className="utm-detail-card-header">
          <h3>Preset</h3>
          <p>UTM tuple and destination that make up this tag.</p>
        </header>
        <dl className="admin-kv utm-detail-kv" data-testid="utm-tag-detail-tuple">
          <dt>Source</dt>
          <dd><code>{tag.utmSource}</code></dd>
          <dt>Medium</dt>
          <dd>{tag.utmMedium ? <code>{tag.utmMedium}</code> : <span className="utm-detail-muted">—</span>}</dd>
          <dt>Campaign</dt>
          <dd>{tag.utmCampaign ? <code>{tag.utmCampaign}</code> : <span className="utm-detail-muted">—</span>}</dd>
          <dt>Content</dt>
          <dd>{tag.utmContent ? <code>{tag.utmContent}</code> : <span className="utm-detail-muted">—</span>}</dd>
          <dt>Term</dt>
          <dd>{tag.utmTerm ? <code>{tag.utmTerm}</code> : <span className="utm-detail-muted">—</span>}</dd>
          <dt>Destination</dt>
          <dd><code>{tag.destinationUrl}</code></dd>
          <dt>Short URL</dt>
          <dd data-testid="utm-tag-detail-short-url">
            {tag.shortCode ? (
              <code className="utm-detail-short-code">/go/{tag.shortCode}</code>
            ) : (
              <span className="utm-detail-muted">—</span>
            )}
          </dd>
        </dl>
      </section>

      {/* === Time series chart === */}
      <section
        className="utm-detail-card utm-detail-timeseries"
        data-testid="utm-tag-detail-timeseries"
      >
        <header className="utm-detail-card-header">
          <h3>Traffic over time</h3>
          <p>
            Daily sessions, signups, and anonymous plays
            {range === "lifetime" ? " (last 28 days)" : ` (last ${range})`}.
            Today's bucket may be partial.
          </p>
        </header>
        {seriesQuery.isLoading ? (
          <div className="admin-loading">Loading series…</div>
        ) : seriesQuery.error ? (
          <div className="admin-error">Failed to load series.</div>
        ) : seriesData.length === 0 ? (
          <div className="admin-loading">
            No traffic recorded for this tag in the window.
          </div>
        ) : (
          <RechartsAreaChart
            data={[]}
            multiSeriesData={seriesData}
            seriesConfig={SERIES_CONFIG}
            height={260}
          />
        )}
      </section>

      {/* === This tag vs all-tags average === */}
      {myRow && globalCr !== undefined && (
        <section
          className="utm-detail-card utm-detail-vs-avg"
          data-testid="utm-tag-detail-vs-avg"
        >
          <header className="utm-detail-card-header">
            <h3>This tag vs all-tags average</h3>
            <p>
              Compares this tag's session→signup rate against the pooled
              average across all active admin tags in the same window.
              ★/▼ indicate non-overlapping 95% confidence intervals.
            </p>
          </header>
          <div className="utm-vs-avg-grid">
            <div className="utm-vs-avg-row">
              <div className="utm-vs-avg-label">Session → Signup</div>
              <div className="utm-vs-avg-this">
                {formatRate(myRow.conversionRate)}
                {myRow.isSignificantlyAboveAverage && (
                  <span className="utm-flag-good" title="Significantly above the all-tags average">
                    {" ★"}
                  </span>
                )}
                {myRow.isSignificantlyBelowAverage && (
                  <span className="utm-flag-bad" title="Significantly below the all-tags average">
                    {" ▼"}
                  </span>
                )}
                {myRow.isLowSample && (
                  <span
                    className="utm-flag-warn"
                    title={`Only ${myRow.sessions} sessions — interval too wide to be useful`}
                  >
                    {" ⚠"}
                  </span>
                )}
              </div>
              <div className="utm-vs-avg-baseline">avg {formatRate(globalCr)}</div>
            </div>
            <div className="utm-vs-avg-row">
              <div className="utm-vs-avg-label">Sessions in window</div>
              <div className="utm-vs-avg-this">{myRow.sessions.toLocaleString()}</div>
              <div className="utm-vs-avg-baseline">
                {comparisonQuery.data?.summary.totalSessions.toLocaleString()} total
              </div>
            </div>
            <div className="utm-vs-avg-row">
              <div className="utm-vs-avg-label">Signups in window</div>
              <div className="utm-vs-avg-this">{myRow.signups.toLocaleString()}</div>
              <div className="utm-vs-avg-baseline">
                {comparisonQuery.data?.summary.totalSignups.toLocaleString()} total
              </div>
            </div>
          </div>
          {!myRow.isLowSample && myRow.sessions > 0 && (
            <p className="admin-footnote">
              95% Wilson interval for this tag's CR:{" "}
              {formatRate(myRow.ciLow)}–{formatRate(myRow.ciHigh)}.
            </p>
          )}
        </section>
      )}

      {/* === Visual funnel === */}
      <section className="utm-detail-card">
        <header className="utm-detail-card-header">
          <h3>Conversion funnel</h3>
          <p>
            How attributed users move through the signup → play → giveaway →
            reward pipeline. Percentages are relative to signups.
          </p>
        </header>

        <div className="utm-funnel-bars" role="list">
          {stats.hasShortCode && (
            <div className="utm-funnel-stage" role="listitem">
              <div className="utm-funnel-stage-label">
                <span className="utm-funnel-stage-name">Clicks²</span>
                <span className="utm-funnel-stage-pct" data-testid="utm-funnel-clicks-pct">—</span>
              </div>
              <div className="utm-funnel-track">
                <div
                  className="utm-funnel-bar utm-funnel-bar-clicks"
                  style={{ width: `${barFraction(stats.clicks, funnelMax) * 100}%` }}
                >
                  <span className="utm-funnel-bar-value" data-testid="utm-funnel-clicks">
                    {stats.clicks.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="utm-funnel-stage" role="listitem">
            <div className="utm-funnel-stage-label">
              <span className="utm-funnel-stage-name">Anonymous plays³</span>
              <span
                className="utm-funnel-stage-pct"
                data-testid="utm-funnel-anon-plays-pct"
              >
                —
              </span>
            </div>
            <div className="utm-funnel-track">
              <div
                className="utm-funnel-bar utm-funnel-bar-played"
                style={{ width: `${barFraction(stats.anonymousPlays, funnelMax) * 100}%` }}
              >
                <span
                  className="utm-funnel-bar-value"
                  data-testid="utm-funnel-anon-plays"
                >
                  {stats.anonymousPlays.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="utm-funnel-stage" role="listitem">
            <div className="utm-funnel-stage-label">
              <span className="utm-funnel-stage-name">Signups</span>
              <span className="utm-funnel-stage-pct" data-testid="utm-funnel-signups-pct">
                {formatPercent(stats.signups, signups)}
              </span>
            </div>
            <div className="utm-funnel-track">
              <div
                className="utm-funnel-bar utm-funnel-bar-signups"
                style={{ width: `${barFraction(stats.signups, funnelMax) * 100}%` }}
              >
                <span className="utm-funnel-bar-value" data-testid="utm-funnel-signups">
                  {stats.signups.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="utm-funnel-stage" role="listitem">
            <div className="utm-funnel-stage-label">
              <span className="utm-funnel-stage-name">Played first game</span>
              <span className="utm-funnel-stage-pct" data-testid="utm-funnel-played-pct">
                {formatPercent(stats.playedFirstGame, signups)}
              </span>
            </div>
            <div className="utm-funnel-track">
              <div
                className="utm-funnel-bar utm-funnel-bar-played"
                style={{ width: `${barFraction(stats.playedFirstGame, funnelMax) * 100}%` }}
              >
                <span className="utm-funnel-bar-value" data-testid="utm-funnel-played">
                  {stats.playedFirstGame.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="utm-funnel-stage" role="listitem">
            <div className="utm-funnel-stage-label">
              <span className="utm-funnel-stage-name">Giveaway-eligible¹</span>
              <span className="utm-funnel-stage-pct" data-testid="utm-funnel-giveaway-pct">
                {formatPercent(stats.giveawayEligible, signups)}
              </span>
            </div>
            <div className="utm-funnel-track">
              <div
                className="utm-funnel-bar utm-funnel-bar-giveaway"
                style={{ width: `${barFraction(stats.giveawayEligible, funnelMax) * 100}%` }}
              >
                <span className="utm-funnel-bar-value" data-testid="utm-funnel-giveaway">
                  {stats.giveawayEligible.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="utm-funnel-stage" role="listitem">
            <div className="utm-funnel-stage-label">
              <span className="utm-funnel-stage-name">Won reward</span>
              <span className="utm-funnel-stage-pct" data-testid="utm-funnel-won-pct">
                {formatPercent(stats.wonReward, signups)}
              </span>
            </div>
            <div className="utm-funnel-track">
              <div
                className="utm-funnel-bar utm-funnel-bar-won"
                style={{ width: `${barFraction(stats.wonReward, funnelMax) * 100}%` }}
              >
                <span className="utm-funnel-bar-value" data-testid="utm-funnel-won">
                  {stats.wonReward.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>

        <p
          className="admin-footnote"
          data-testid="utm-funnel-threshold-note"
        >
          ¹ Giveaway-eligible = users whose lifetime score is ≥{" "}
          {stats.giveawayThreshold} points (the current value of{" "}
          <code>site_settings.promo_banner.giveawayMinPoints</code>).
        </p>
        {stats.hasShortCode && (
          <p
            className="admin-footnote"
            data-testid="utm-funnel-clicks-note"
          >
            ² Clicks are counted by the <code>/go/:code</code> redirect on
            each request; the counter is atomic and archived tags still
            accumulate clicks so old printed URLs keep working.
          </p>
        )}
        <p
          className="admin-footnote"
          data-testid="utm-funnel-anon-plays-note"
        >
          ³ Anonymous plays counts visitors who clicked a tracked link and
          completed at least one game without signing up (distinct by the
          <code>visitor_id</code> cookie). Visitors who later register move
          into the Signups row instead, so there is no double-counting.
        </p>
      </section>
    </div>
  );
}
