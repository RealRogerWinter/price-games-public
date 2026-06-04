import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  listUtmTags,
  createUtmTag,
  updateUtmTag,
  setUtmTagStatus,
  deleteUtmTag,
  suggestShortCode,
  buildShortUrl,
  getUtmTagComparison,
  type AdminUtmTag,
  type AdminUtmTagInput,
  type AdminUtmTagStatus,
  type AdminUtmTagOriginFilter,
  type AdminUtmTagComparisonRow,
  type AdminUtmRange,
} from "../../api/adminClient";
import RechartsBarChart from "../../components/charts/RechartsBarChart";
import KpiCard from "../../components/charts/KpiCard";
import QrCodeModal from "./QrCodeModal";
import {
  getPublicSiteOrigin,
  getPublicSiteHost,
} from "../../utils/publicSiteOrigin";

type ModalView = "none" | "create" | "edit";
type StatusFilter = AdminUtmTagStatus | "all";
type SortColumn = "rank" | "sessions" | "signups" | "conversionRate" | "name";

/**
 * Build a client-side shareable URL for a UTM tag. Mirrors the
 * `buildTagUrl` helper in the server service: appends each non-empty
 * UTM field as a query param on the destination URL.
 */
function buildTagUrl(
  tag: Pick<
    AdminUtmTag,
    "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm" | "destinationUrl"
  >,
  baseUrl: string,
): string {
  try {
    const url = new URL(tag.destinationUrl, baseUrl);
    const setIfPresent = (key: string, value: string | null | undefined) => {
      if (value && value.length > 0) url.searchParams.set(key, value);
    };
    setIfPresent("utm_source", tag.utmSource);
    setIfPresent("utm_medium", tag.utmMedium);
    setIfPresent("utm_campaign", tag.utmCampaign);
    setIfPresent("utm_content", tag.utmContent);
    setIfPresent("utm_term", tag.utmTerm);
    return url.toString();
  } catch {
    return tag.destinationUrl;
  }
}

interface FormState {
  name: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  destinationUrl: string;
  shortCode: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  utmSource: "",
  utmMedium: "",
  utmCampaign: "",
  utmContent: "",
  utmTerm: "",
  destinationUrl: "/giveaway",
  shortCode: "",
};

const RANGE_OPTIONS: Array<{ value: AdminUtmRange; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "28d", label: "28d" },
  { value: "90d", label: "90d" },
];

/**
 * Format a Wilson interval (or any 0..1 rate) as a compact percent.
 * Returns "—" when the input is non-finite (e.g. 0/0).
 */
function formatPct(rate: number, digits = 1): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}

/** Wilson half-width as ±x.xpp text, rounded to 1 decimal. */
function formatHalfWidth(lo: number, hi: number): string {
  const half = ((hi - lo) / 2) * 100;
  return `±${half.toFixed(1)}pp`;
}

/**
 * Inline 7-bar SVG sparkline. Renders one fixed-width sparkline per row
 * — Recharts here would be overkill (a sparkline is essentially 7
 * rectangles).
 */
function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const width = 70;
  const height = 22;
  const step = width / Math.max(1, values.length);
  const barWidth = Math.max(2, step - 2);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`7-day signups (oldest to newest): ${values.join(", ")}`}
    >
      {values.map((v, i) => {
        const h = (v / max) * (height - 2);
        return (
          <rect
            key={i}
            x={i * step + 1}
            y={height - h - 1}
            width={barWidth}
            height={Math.max(1, h)}
            fill="#4a9eff"
            opacity={v === 0 ? 0.3 : 0.85}
          />
        );
      })}
    </svg>
  );
}

/**
 * Outer wrapper — provides a per-mount React Query client so cache state
 * is scoped to this page and back-navigation starts clean. Mirrors the
 * AdminReferralsPage / AdminAnalytics pattern.
 */
export default function AdminUtmTagsPage() {
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

/**
 * Inner dashboard: filter bar, KPI strip, hero leaderboard chart,
 * sortable leaderboard table, and the existing CRUD modal. Test-ids
 * are preserved from the prior list/card layout (e.g. utm-tag-edit-${id})
 * because the AdminUtmTagsPage test suite asserts them directly.
 */
function Dashboard() {
  const navigate = useNavigate();

  const [tags, setTags] = useState<AdminUtmTag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [originFilter, setOriginFilter] = useState<AdminUtmTagOriginFilter>("admin");
  const [range, setRange] = useState<AdminUtmRange>("28d");
  const [sortColumn, setSortColumn] = useState<SortColumn>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalView>("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [qrTag, setQrTag] = useState<AdminUtmTag | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // List query: drives the table (active / archived / all). useState/effect
  // pattern preserved so the existing test suite (which mocks listUtmTags
  // directly and asserts call arguments) continues to work without
  // restructuring.
  const fetchTags = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const result = await listUtmTags({ page, pageSize, status: statusFilter, origin: originFilter });
      setTags(result.tags);
      setTotal(result.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load UTM tags");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, originFilter]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  // Comparison query: drives the KPI strip + hero chart + per-row stats
  // overlays. Only fetches active tags under the current origin filter,
  // so the chart is meaningful only when statusFilter='active'. Other
  // filters render an empty-chart placeholder.
  const comparisonQuery = useQuery({
    queryKey: ["admin", "utm", "comparison", { range, origin: originFilter }],
    queryFn: () => getUtmTagComparison({ range, origin: originFilter }),
  });

  // Index comparison rows by tagId so the leaderboard table can pull stats
  // overlays in O(1) per row rather than rescanning the array.
  const comparisonByTagId = useMemo(() => {
    const map = new Map<string, AdminUtmTagComparisonRow>();
    if (comparisonQuery.data) {
      for (const r of comparisonQuery.data.rows) map.set(r.tagId, r);
    }
    return map;
  }, [comparisonQuery.data]);

  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();
  function showSuccess(message: string) {
    setSuccess(message);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
  }
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  // === Modal handlers ===

  function openCreateModal() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setModal("create");
  }

  function openEditModal(tag: AdminUtmTag) {
    setEditingId(tag.id);
    setForm({
      name: tag.name,
      utmSource: tag.utmSource,
      utmMedium: tag.utmMedium ?? "",
      utmCampaign: tag.utmCampaign ?? "",
      utmContent: tag.utmContent ?? "",
      utmTerm: tag.utmTerm ?? "",
      destinationUrl: tag.destinationUrl,
      shortCode: tag.shortCode ?? "",
    });
    setError(null);
    setModal("edit");
  }

  async function handleGenerateShortCode() {
    try {
      setError(null);
      const { code } = await suggestShortCode();
      setForm((f) => ({ ...f, shortCode: code }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to generate short code");
    }
  }

  function closeModal() {
    setModal("none");
    setEditingId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedShortCode = form.shortCode.trim();
    const payload: AdminUtmTagInput = {
      name: form.name,
      utmSource: form.utmSource,
      utmMedium: form.utmMedium || null,
      utmCampaign: form.utmCampaign || null,
      utmContent: form.utmContent || null,
      utmTerm: form.utmTerm || null,
      destinationUrl: form.destinationUrl,
      shortCode: trimmedShortCode.length > 0 ? trimmedShortCode : null,
    };
    try {
      setSubmitting(true);
      setError(null);
      if (modal === "edit" && editingId) {
        await updateUtmTag(editingId, payload);
        showSuccess("UTM tag updated");
      } else {
        await createUtmTag(payload);
        showSuccess("UTM tag created");
      }
      closeModal();
      await fetchTags();
      comparisonQuery.refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save UTM tag");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(tag: AdminUtmTag) {
    const next: AdminUtmTagStatus = tag.status === "active" ? "archived" : "active";
    try {
      setError(null);
      await setUtmTagStatus(tag.id, next);
      showSuccess(next === "archived" ? "UTM tag archived" : "UTM tag restored");
      await fetchTags();
      comparisonQuery.refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function handleDelete(tag: AdminUtmTag) {
    if (!confirm(`Delete UTM tag "${tag.name}"? This cannot be undone.`)) return;
    try {
      setError(null);
      await deleteUtmTag(tag.id);
      showSuccess("UTM tag deleted");
      await fetchTags();
      comparisonQuery.refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete UTM tag");
    }
  }

  async function handleCopyUrl(tag: AdminUtmTag) {
    const baseUrl = getPublicSiteOrigin();
    const shortUrl = buildShortUrl(tag, baseUrl);
    const url = shortUrl ?? buildTagUrl(tag, baseUrl);
    try {
      await navigator.clipboard.writeText(url);
      showSuccess(
        shortUrl ? "Short URL copied to clipboard" : "Link copied to clipboard",
      );
    } catch {
      setError("Failed to copy link. Your browser may not support clipboard access.");
    }
  }

  // === Sorting ===

  // Sort the visible rows. Default ("rank") preserves the comparison API's
  // Wilson-LB-desc order; user clicks switch to per-column sorting.
  const sortedTags = useMemo(() => {
    const list = [...tags];
    if (sortColumn === "rank") {
      const rankIndex = new Map<string, number>();
      if (comparisonQuery.data) {
        comparisonQuery.data.rows.forEach((r, i) => rankIndex.set(r.tagId, i));
      }
      list.sort((a, b) => {
        const ai = rankIndex.has(a.id) ? rankIndex.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const bi = rankIndex.has(b.id) ? rankIndex.get(b.id)! : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
      return list;
    }
    const dirSign = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const ca = comparisonByTagId.get(a.id);
      const cb = comparisonByTagId.get(b.id);
      let av: number | string;
      let bv: number | string;
      if (sortColumn === "name") {
        av = a.name;
        bv = b.name;
      } else if (sortColumn === "sessions") {
        av = ca?.sessions ?? 0;
        bv = cb?.sessions ?? 0;
      } else if (sortColumn === "signups") {
        av = ca?.signups ?? 0;
        bv = cb?.signups ?? 0;
      } else {
        av = ca?.conversionRate ?? 0;
        bv = cb?.conversionRate ?? 0;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dirSign;
      }
      return ((av as number) - (bv as number)) * dirSign;
    });
    return list;
  }, [tags, sortColumn, sortDir, comparisonByTagId, comparisonQuery.data]);

  function toggleSort(col: SortColumn) {
    if (col === "rank") {
      setSortColumn("rank");
      return;
    }
    if (sortColumn === col) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(col);
      setSortDir("desc");
    }
  }

  function sortIndicator(col: SortColumn): string {
    if (sortColumn !== col) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  // === Hero chart data ===
  // Only include tags that actually had traffic in the window. The
  // comparison endpoint returns every active tag (so the table can show
  // 0-row tags too), but the leaderboard chart should hide tags with
  // value=0 — otherwise the BarChart renders zero-width bars under the
  // YAxis labels and the section reads as "broken".
  const chartData = useMemo(() => {
    const rows = comparisonQuery.data?.rows ?? [];
    return [...rows]
      .filter((r) => r.sessions > 0)
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10)
      .map((r) => ({
        label: r.name,
        value: r.sessions,
        completed: r.signups,
      }));
  }, [comparisonQuery.data]);

  function handleBarClick(label: string) {
    const row = (comparisonQuery.data?.rows ?? []).find((r) => r.name === label);
    if (row) navigate(`/admin/utm-tags/${row.tagId}`);
  }

  // === Render ===

  const summary = comparisonQuery.data?.summary;
  const showHeroChart = statusFilter === "active";

  return (
    <div className="admin-page admin-utm-page" data-testid="admin-utm-tags-page">
      <div className="admin-page-header">
        <div className="admin-page-header-title">
          <h2>UTM Tags</h2>
          <p className="admin-page-subtitle">
            Manage tracking URLs and watch which campaigns convert.
          </p>
        </div>
        <button
          className="admin-btn-primary"
          onClick={openCreateModal}
          data-testid="utm-tags-add-button"
        >
          + New UTM tag
        </button>
      </div>

      {/* === Toolbar: range + status + origin === */}
      <div className="utm-toolbar" data-testid="utm-toolbar">
        <div
          className="utm-filter-pills"
          role="radiogroup"
          aria-label="Time range"
          data-testid="utm-range-pills"
        >
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={range === opt.value}
              className={`utm-filter-pill${range === opt.value ? " utm-filter-pill-active" : ""}`}
              onClick={() => setRange(opt.value)}
              data-testid={`utm-range-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div
          className="utm-filter-pills"
          role="radiogroup"
          aria-label="Filter tags by status"
          data-testid="utm-tags-filter-pills"
        >
          {(["active", "archived", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={statusFilter === value}
              className={`utm-filter-pill${
                statusFilter === value ? " utm-filter-pill-active" : ""
              }`}
              onClick={() => {
                setStatusFilter(value);
                setPage(1);
              }}
              data-testid={`utm-tags-filter-${value}`}
            >
              {value === "active"
                ? "Active"
                : value === "archived"
                ? "Archived"
                : "All"}
            </button>
          ))}
        </div>

        <div
          className="utm-filter-pills"
          role="radiogroup"
          aria-label="Filter tags by origin"
          data-testid="utm-tags-origin-pills"
        >
          {(["admin", "system", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={originFilter === value}
              className={`utm-filter-pill${
                originFilter === value ? " utm-filter-pill-active" : ""
              }`}
              onClick={() => {
                setOriginFilter(value);
                setPage(1);
              }}
              data-testid={`utm-tags-origin-${value}`}
            >
              {value === "admin"
                ? "Yours"
                : value === "system"
                ? "System origins"
                : "All origins"}
            </button>
          ))}
        </div>

        {/* Hidden legacy <select> kept for backward-compat with the existing
            `utm-tags-status-filter` test-id; pill changes mirror onto it. */}
        <select
          className="utm-filter-select-hidden"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
            setPage(1);
          }}
          data-testid="utm-tags-status-filter"
          aria-hidden="true"
          tabIndex={-1}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </div>

      {/* === KPI strip across all active tags in window === */}
      <div className="kpi-grid utm-summary-strip" data-testid="utm-summary-strip">
        <KpiCard
          value={summary ? summary.totalClicksLifetime.toLocaleString() : "—"}
          label="Clicks (lifetime)"
        />
        <KpiCard
          value={summary ? summary.totalSessions.toLocaleString() : "—"}
          label={`Sessions (${range})`}
        />
        <KpiCard
          value={summary ? summary.totalSignups.toLocaleString() : "—"}
          label={`Signups (${range})`}
        />
        <KpiCard
          value={summary ? formatPct(summary.globalConversionRate, 2) : "—"}
          label={
            summary && summary.totalSessions >= 30
              ? `Click→Signup ${formatHalfWidth(summary.globalConversionCi.lo, summary.globalConversionCi.hi)}`
              : "Click→Signup"
          }
        />
        <KpiCard
          value={summary ? summary.activeTagCount.toLocaleString() : "—"}
          label="Active tags"
        />
      </div>

      {/* === Hero leaderboard chart (active tags only) === */}
      {showHeroChart && (
        <section
          className="admin-analytics-chart utm-leaderboard-chart"
          data-testid="utm-leaderboard-chart"
        >
          <h2>Top tags by sessions ({range})</h2>
          {comparisonQuery.isLoading ? (
            <div className="admin-loading">Loading leaderboard…</div>
          ) : comparisonQuery.error ? (
            <div className="admin-error">Failed to load comparison data.</div>
          ) : chartData.length === 0 ? (
            <div className="admin-loading">
              No traffic for active tags in the last {range}.
            </div>
          ) : (
            <RechartsBarChart
              data={chartData}
              onBarClick={handleBarClick}
            />
          )}
          <p className="admin-footnote">
            Bar length = sessions; the inner darker segment is signups
            within those sessions. Click a bar to drill into the tag.
          </p>
        </section>
      )}

      {error && (
        <div className="admin-error" data-testid="utm-tags-error">
          {error}
        </div>
      )}
      {success && (
        <div className="admin-success" data-testid="utm-tags-success">
          {success}
        </div>
      )}

      {/* === Leaderboard table === */}
      {loading ? (
        <div className="admin-loading" data-testid="utm-tags-loading">
          Loading UTM tags…
        </div>
      ) : tags.length === 0 ? (
        <div className="utm-empty-state" data-testid="utm-tags-empty">
          <div className="utm-empty-icon" aria-hidden="true">
            🔗
          </div>
          <h3>No UTM tags yet</h3>
          <p>
            Create your first preset to start tracking campaign traffic.
            You'll get a shareable short URL and QR code for each tag.
          </p>
          <button
            type="button"
            className="admin-btn-primary"
            onClick={openCreateModal}
          >
            + New UTM tag
          </button>
        </div>
      ) : (
        <>
          <table className="admin-table utm-leaderboard-table" data-testid="utm-tags-table">
            <thead>
              <tr>
                <th
                  className="utm-th-sortable"
                  onClick={() => toggleSort("name")}
                  data-testid="utm-sort-name"
                >
                  Tag{sortIndicator("name")}
                </th>
                <th>Source / Campaign</th>
                <th
                  className="utm-th-sortable utm-th-numeric"
                  onClick={() => toggleSort("sessions")}
                  data-testid="utm-sort-sessions"
                >
                  Sessions{sortIndicator("sessions")}
                </th>
                <th
                  className="utm-th-sortable utm-th-numeric"
                  onClick={() => toggleSort("signups")}
                  data-testid="utm-sort-signups"
                >
                  Signups{sortIndicator("signups")}
                </th>
                <th
                  className="utm-th-sortable utm-th-numeric"
                  onClick={() => toggleSort("conversionRate")}
                  data-testid="utm-sort-cr"
                >
                  CR (95% CI){sortIndicator("conversionRate")}
                </th>
                <th className="utm-th-numeric">7d</th>
                <th>Short URL</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedTags.map((tag) => {
                const stats = comparisonByTagId.get(tag.id);
                const isArchived = tag.status === "archived";
                const longUrl = buildTagUrl(tag, getPublicSiteOrigin());
                return (
                  <tr
                    key={tag.id}
                    className={isArchived ? "utm-row-archived" : ""}
                    data-testid={`utm-tag-row-${tag.id}`}
                  >
                    <td>
                      <div className="utm-cell-name">
                        <strong>{tag.name}</strong>
                        {isArchived && (
                          <span className="utm-status-pill utm-status-archived">archived</span>
                        )}
                        {tag.originKey && (
                          <span
                            className="utm-status-pill"
                            title={`Auto-created for ${tag.originKey}`}
                            data-testid={`utm-tag-system-badge-${tag.id}`}
                          >
                            system
                          </span>
                        )}
                      </div>
                      <div className="utm-cell-url" data-testid={`utm-tag-url-${tag.id}`}>
                        {longUrl}
                      </div>
                    </td>
                    <td>
                      <div className="utm-cell-tuple">
                        <code>{tag.utmSource}</code>
                        {tag.utmMedium && <code>{tag.utmMedium}</code>}
                        {tag.utmCampaign && <code>{tag.utmCampaign}</code>}
                      </div>
                    </td>
                    <td className="utm-th-numeric">
                      {stats ? stats.sessions.toLocaleString() : "—"}
                    </td>
                    <td className="utm-th-numeric">
                      {stats ? stats.signups.toLocaleString() : "—"}
                    </td>
                    <td className="utm-th-numeric">
                      {stats ? (
                        <div className="utm-cell-cr">
                          <div>
                            {formatPct(stats.conversionRate)}
                            {stats.isSignificantlyAboveAverage && (
                              <span
                                className="utm-flag-good"
                                title="Significantly above the all-tags average"
                                data-testid={`utm-flag-above-${tag.id}`}
                              >
                                {" ★"}
                              </span>
                            )}
                            {stats.isSignificantlyBelowAverage && (
                              <span
                                className="utm-flag-bad"
                                title="Significantly below the all-tags average"
                                data-testid={`utm-flag-below-${tag.id}`}
                              >
                                {" ▼"}
                              </span>
                            )}
                            {stats.isLowSample && (
                              <span
                                className="utm-flag-warn"
                                title={`Only ${stats.sessions} sessions — interval too wide to be useful`}
                                data-testid={`utm-flag-lowsample-${tag.id}`}
                              >
                                {" ⚠"}
                              </span>
                            )}
                          </div>
                          {!stats.isLowSample && stats.sessions > 0 && (
                            <small className="utm-cell-ci">
                              {formatPct(stats.ciLow)}–{formatPct(stats.ciHigh)}
                            </small>
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="utm-th-numeric">
                      {stats ? <Sparkline values={stats.sparkline} /> : "—"}
                    </td>
                    <td>
                      <div
                        className="utm-cell-short-url"
                        data-testid={`utm-tag-short-url-${tag.id}`}
                      >
                        {tag.shortCode ? (
                          <code>
                            {getPublicSiteHost()}/go/{tag.shortCode}
                          </code>
                        ) : (
                          "—"
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="utm-cell-actions">
                        <button
                          type="button"
                          className="admin-btn-sm"
                          onClick={() => handleCopyUrl(tag)}
                          data-testid={`utm-tag-copy-${tag.id}`}
                          title={tag.shortCode ? "Copy short URL" : "Copy long URL"}
                        >
                          Copy
                        </button>
                        <button
                          type="button"
                          className="admin-btn-sm"
                          onClick={() => setQrTag(tag)}
                          data-testid={`utm-tag-qr-${tag.id}`}
                          title="Show QR code"
                        >
                          QR
                        </button>
                        <button
                          type="button"
                          className="admin-btn-sm"
                          onClick={() => navigate(`/admin/utm-tags/${tag.id}`)}
                          data-testid={`utm-tag-view-${tag.id}`}
                        >
                          View
                        </button>
                        {!tag.originKey && (
                          <>
                            <button
                              type="button"
                              className="admin-btn-sm"
                              onClick={() => openEditModal(tag)}
                              data-testid={`utm-tag-edit-${tag.id}`}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="admin-btn-sm"
                              onClick={() => handleToggleStatus(tag)}
                              data-testid={`utm-tag-archive-${tag.id}`}
                            >
                              {isArchived ? "Unarchive" : "Archive"}
                            </button>
                            <button
                              type="button"
                              className="admin-btn-sm admin-btn-sm-danger"
                              onClick={() => handleDelete(tag)}
                              data-testid={`utm-tag-delete-${tag.id}`}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="admin-pagination">
              <div className="admin-pagination-info">
                Page {page} of {totalPages} ({total} total)
              </div>
              <div className="admin-pagination-pages">
                <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  &lsaquo;
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  &rsaquo;
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {qrTag && (
        <QrCodeModal tag={qrTag} onClose={() => setQrTag(null)} />
      )}

      {modal !== "none" && (
        <div className="modal-overlay" onClick={closeModal}>
          <div
            className="modal-content utm-modal-content"
            onClick={(e) => e.stopPropagation()}
            data-testid={modal === "edit" ? "utm-tag-edit-modal" : "utm-tag-create-modal"}
          >
            <button className="modal-close" onClick={closeModal}>
              &times;
            </button>
            <div className="utm-modal-header">
              <h3 className="modal-title">
                {modal === "edit" ? "Edit UTM tag" : "New UTM tag"}
              </h3>
              <p className="utm-modal-subtitle">
                Tags are reusable presets for `utm_source` / `utm_medium` /
                `utm_campaign` / `utm_content` / `utm_term` attached to a
                destination URL. Give it a short code for a compact shareable
                link.
              </p>
            </div>
            <form
              className="utm-form"
              onSubmit={handleSubmit}
              data-testid="utm-tag-form"
            >
              <section className="utm-form-section">
                <header className="utm-form-section-header">
                  <h4>Identity</h4>
                  <p>Internal name that helps you find this tag later.</p>
                </header>
                <div className="utm-form-fields">
                  <label className="utm-form-field utm-form-field-full">
                    <span className="utm-form-label">
                      Name <span className="required">*</span>
                    </span>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      data-testid="utm-tag-form-name"
                      placeholder="e.g. Reddit Giveaway v1"
                      required
                    />
                  </label>
                </div>
              </section>

              <section className="utm-form-section">
                <header className="utm-form-section-header">
                  <h4>Tracking parameters</h4>
                  <p>
                    These become <code>utm_*</code> query params on every click.
                    Leave optional fields blank to match any value.
                  </p>
                </header>
                <div className="utm-form-fields utm-form-fields-grid">
                  <label className="utm-form-field">
                    <span className="utm-form-label">
                      Source <span className="required">*</span>
                    </span>
                    <input
                      type="text"
                      value={form.utmSource}
                      onChange={(e) => setForm({ ...form, utmSource: e.target.value })}
                      data-testid="utm-tag-form-source"
                      placeholder="reddit"
                      required
                    />
                  </label>
                  <label className="utm-form-field">
                    <span className="utm-form-label">Medium</span>
                    <input
                      type="text"
                      value={form.utmMedium}
                      onChange={(e) => setForm({ ...form, utmMedium: e.target.value })}
                      data-testid="utm-tag-form-medium"
                      placeholder="cpc"
                    />
                  </label>
                  <label className="utm-form-field">
                    <span className="utm-form-label">Campaign</span>
                    <input
                      type="text"
                      value={form.utmCampaign}
                      onChange={(e) => setForm({ ...form, utmCampaign: e.target.value })}
                      data-testid="utm-tag-form-campaign"
                      placeholder="giveaway_v1"
                    />
                  </label>
                  <label className="utm-form-field">
                    <span className="utm-form-label">Content</span>
                    <input
                      type="text"
                      value={form.utmContent}
                      onChange={(e) => setForm({ ...form, utmContent: e.target.value })}
                      data-testid="utm-tag-form-content"
                      placeholder="variant_a"
                    />
                  </label>
                  <label className="utm-form-field utm-form-field-full">
                    <span className="utm-form-label">Term</span>
                    <input
                      type="text"
                      value={form.utmTerm}
                      onChange={(e) => setForm({ ...form, utmTerm: e.target.value })}
                      data-testid="utm-tag-form-term"
                      placeholder="price comparison"
                    />
                  </label>
                </div>
              </section>

              <section className="utm-form-section">
                <header className="utm-form-section-header">
                  <h4>Destination</h4>
                  <p>
                    Where users land after clicking. Use a root-relative path
                    (e.g. <code>/giveaway</code>) or a full
                    <code> https://</code> URL.
                  </p>
                </header>
                <div className="utm-form-fields">
                  <label className="utm-form-field utm-form-field-full">
                    <span className="utm-form-label">
                      Destination URL <span className="required">*</span>
                    </span>
                    <input
                      type="text"
                      value={form.destinationUrl}
                      onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })}
                      data-testid="utm-tag-form-destination"
                      placeholder="/giveaway"
                      required
                    />
                  </label>
                </div>
              </section>

              <section className="utm-form-section">
                <header className="utm-form-section-header">
                  <h4>Short link (optional)</h4>
                  <p>
                    Generates a compact <code>/go/&lt;code&gt;</code> redirect
                    and lets you create a QR code. Leave blank to skip.
                  </p>
                </header>
                <div className="utm-form-fields">
                  <label className="utm-form-field utm-form-field-full">
                    <span className="utm-form-label">Short code</span>
                    <div className="utm-tag-form-short-code-row">
                      <input
                        type="text"
                        value={form.shortCode}
                        onChange={(e) => setForm({ ...form, shortCode: e.target.value })}
                        data-testid="utm-tag-form-short-code"
                        placeholder="e.g. reddit-gw-1"
                      />
                      <button
                        type="button"
                        className="admin-btn-sm"
                        onClick={handleGenerateShortCode}
                        data-testid="utm-tag-form-short-code-generate"
                      >
                        Generate
                      </button>
                    </div>
                    <small className="admin-help-text">
                      3–32 chars, lowercase letters, digits, and hyphens
                      only. Must not start or end with a hyphen.
                    </small>
                  </label>
                </div>
              </section>

              <div className="utm-form-actions">
                <button
                  type="button"
                  className="admin-btn-cancel"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-btn-primary"
                  disabled={submitting}
                >
                  {submitting ? "Saving…" : modal === "edit" ? "Save changes" : "Create tag"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
