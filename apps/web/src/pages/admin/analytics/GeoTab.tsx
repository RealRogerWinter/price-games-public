/**
 * Geo tab — country breakdown + lazy-loaded choropleth map.
 *
 * Country data comes from the CF-IPCountry header (Cloudflare edge geo);
 * see docs/ANALYTICS.md. The world map (`react-simple-maps`) is lazy-
 * loaded on this tab only so the main admin bundle stays small.
 */

import { Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalyticsFilters } from "./useAnalyticsFilters";
import { csvExportUrl, fetchGeoCountries } from "./analyticsApi";
import CsvButton from "./CsvButton";
import TabErrorBoundary from "./TabErrorBoundary";
import type { GeoCountryRow } from "./types";

const WorldMap = lazy(() => import("./WorldMap"));

export default function GeoTab(): React.ReactElement {
  const { filters } = useAnalyticsFilters();
  const countries = useQuery({
    queryKey: ["analytics", "v2", "geo-countries", filters],
    queryFn: () => fetchGeoCountries(filters),
  });

  if (countries.isLoading) {
    return <div className="admin-loading" data-testid="geo-loading">Loading…</div>;
  }
  if (countries.error) {
    return <div className="admin-error" data-testid="geo-error">Failed to load geo data.</div>;
  }

  const rows = countries.data!;
  const maxSessions = rows.reduce((m, r) => (r.sessions > m ? r.sessions : m), 0);

  return (
    <div className="admin-analytics-tab-content" data-testid="geo-tab">
      <div className="admin-analytics-chart">
        <h2>World map — sessions by country</h2>
        {/* Inner boundary — if the TopoJSON CDN is down or the map chunk
            fails to load, the rest of the Geo tab (the country table)
            still renders. */}
        <TabErrorBoundary>
          <Suspense fallback={<div className="admin-loading">Loading map…</div>}>
            <WorldMap countries={rows} />
          </Suspense>
        </TabErrorBoundary>
      </div>

      <div className="admin-analytics-table">
        <h2>
          Top countries
          <CsvButton href={csvExportUrl("geo", filters)} filename="analytics-geo.csv" />
        </h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Country</th>
              <th className="num">Sessions</th>
              <th className="num">Engaged</th>
              <th className="num">Engagement rate</th>
              <th className="num">Games completed</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 30).map((r) => (
              <tr key={r.country} data-testid={`geo-row-${r.country}`}>
                <td>
                  {r.country !== "unknown" && (
                    <span className="country-flag" aria-hidden>{flag(r.country)}</span>
                  )}
                  <span>{r.country}</span>
                </td>
                <td className="num">{r.sessions.toLocaleString()}</td>
                <td className="num">{r.engagedSessions.toLocaleString()}</td>
                <td className="num">{(r.engagementRate * 100).toFixed(1)}%</td>
                <td className="num">{r.gamesCompleted.toLocaleString()}</td>
                <td>
                  <ShareBar fraction={maxSessions > 0 ? r.sessions / maxSessions : 0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShareBar({ fraction }: { fraction: number }): React.ReactElement {
  return (
    <div className="geo-share-bar">
      <div
        className="geo-share-bar-fill"
        style={{ width: `${Math.max(2, fraction * 100)}%` }}
      />
    </div>
  );
}

/** Convert an ISO-2 country code to the regional-indicator flag emoji. */
function flag(iso2: string): string {
  if (iso2.length !== 2) return "";
  const base = 0x1F1E6 - "A".charCodeAt(0);
  return String.fromCodePoint(
    base + iso2.charCodeAt(0),
    base + iso2.charCodeAt(1),
  );
}

export type { GeoCountryRow };
