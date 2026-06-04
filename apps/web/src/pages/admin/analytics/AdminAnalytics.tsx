/**
 * Admin analytics v2 dashboard shell.
 *
 * Renders a tab router for the six analytics tabs at
 * /admin/analytics/{overview,acquisition,engagement,retention,funnels,geo}.
 * The filter bar (range / audience / device) lives above the outlet and
 * persists across tab switches because the tabs share the same URL search
 * params via {@link useAnalyticsFilters}.
 *
 * React Query provides deduped caching across tabs — flipping back to a
 * just-viewed tab with the same filters is instant (served from cache),
 * while changing a filter invalidates all tabs cleanly.
 */

import { Suspense, lazy } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import TabErrorBoundary from "./TabErrorBoundary";
import AnomalyBanner from "./AnomalyBanner";
import type { AnalyticsFilters } from "./types";

const OverviewTab = lazy(() => import("./OverviewTab"));
const AcquisitionTab = lazy(() => import("./AcquisitionTab"));
const EngagementTab = lazy(() => import("./EngagementTab"));
const RetentionTab = lazy(() => import("./RetentionTab"));
const FunnelsTab = lazy(() => import("./FunnelsTab"));
const GeoTab = lazy(() => import("./GeoTab"));
const GamesTab = lazy(() => import("./GamesTab"));
const SharingTab = lazy(() => import("./SharingTab"));

// Module-scoped so the cache persists as the admin navigates around.
// Sitting outside the component avoids re-instantiation on re-render.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,       // aggregated data — 1 min before revalidation
      gcTime: 5 * 60_000,      // keep cached data around when tabs switch
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Absolute base path for every analytics URL. Kept as a single constant so
// the mount point lives in exactly one place — we already hit one bug where
// relative `<NavLink>` / `<Navigate>` targets compounded the URL.
const ANALYTICS_BASE = "/admin/analytics";
const DEFAULT_TAB_PATH = `${ANALYTICS_BASE}/overview`;

const TABS: Array<{ path: string; label: string }> = [
  { path: "overview", label: "Overview" },
  { path: "games", label: "Games" },
  { path: "acquisition", label: "Acquisition" },
  { path: "engagement", label: "Engagement" },
  { path: "retention", label: "Retention" },
  { path: "sharing", label: "Sharing" },
  { path: "funnels", label: "Funnels" },
  { path: "geo", label: "Geo" },
];

/**
 * Tab router + filter bar + React Query provider. Rendered inside
 * `AdminLayout` from `AdminApp.tsx`.
 */
export default function AdminAnalytics(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="admin-analytics" data-testid="admin-analytics">
        <h1 className="admin-page-title">Analytics (v2)</h1>
        <AnomalyBanner />
        <TabBar />
        <FilterBar />
        <TabErrorBoundary>
          <Suspense fallback={<div className="admin-loading">Loading tab…</div>}>
            <Routes>
              <Route index element={<Navigate to={DEFAULT_TAB_PATH} replace />} />
              <Route path="overview" element={<OverviewTab />} />
              <Route path="games" element={<GamesTab />} />
              <Route path="acquisition" element={<AcquisitionTab />} />
              <Route path="engagement" element={<EngagementTab />} />
              <Route path="retention" element={<RetentionTab />} />
              <Route path="sharing" element={<SharingTab />} />
              <Route path="funnels" element={<FunnelsTab />} />
              <Route path="geo" element={<GeoTab />} />
              <Route path="*" element={<Navigate to={DEFAULT_TAB_PATH} replace />} />
            </Routes>
          </Suspense>
        </TabErrorBoundary>
      </div>
    </QueryClientProvider>
  );
}

function TabBar(): React.ReactElement {
  // useLocation keeps the tab links reactive to filter changes — when the
  // user flips `?audience=anon`, all three tab targets pick it up without a
  // re-render of the whole shell. Reading `window.location.search` worked
  // but bypassed React Router's reactive model.
  const location = useLocation();
  return (
    <div className="admin-analytics-tabs" role="tablist">
      {TABS.map((t) => (
        <NavLink
          key={t.path}
          to={{ pathname: `${ANALYTICS_BASE}/${t.path}`, search: location.search }}
          end
          className={({ isActive }) =>
            `admin-analytics-tab ${isActive ? "active" : ""}`
          }
          data-testid={`analytics-tab-${t.path}`}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}

function FilterBar(): React.ReactElement {
  const { filters, updateFilter } = useAnalyticsFilters();

  return (
    <div className="admin-analytics-filters" data-testid="analytics-filters">
      <label className="admin-filter">
        <span>Range</span>
        <select
          value={filters.range}
          onChange={(e) => updateFilter("range", e.target.value as AnalyticsFilters["range"])}
          data-testid="filter-range"
        >
          <option value="1d">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="28d">Last 28 days</option>
          <option value="90d">Last 90 days</option>
        </select>
      </label>

      <label className="admin-filter">
        <span>Audience</span>
        <select
          value={filters.audience}
          onChange={(e) => updateFilter("audience", e.target.value as AnalyticsFilters["audience"])}
          data-testid="filter-audience"
        >
          <option value="all">All visitors</option>
          <option value="anon">Anonymous only</option>
          <option value="loggedIn">Logged-in only</option>
        </select>
      </label>

      <label className="admin-filter">
        <span>Device</span>
        <select
          value={filters.device}
          onChange={(e) => updateFilter("device", e.target.value as AnalyticsFilters["device"])}
          data-testid="filter-device"
        >
          <option value="all">All devices</option>
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
          <option value="tablet">Tablet</option>
        </select>
      </label>
    </div>
  );
}
