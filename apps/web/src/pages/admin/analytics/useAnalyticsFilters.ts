/**
 * URL-backed filter state for the analytics dashboard.
 *
 * Filters (range, audience, device) live in `URLSearchParams` so every view
 * is a shareable link: `/admin/analytics/overview?range=28d&audience=anon`
 * reproduces the exact state on any browser. The hook reads the current
 * params, normalizes invalid values to their defaults, and returns a
 * stable `updateFilter()` helper that writes back via `setSearchParams`.
 */

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  AnalyticsAudience,
  AnalyticsDevice,
  AnalyticsFilters,
  AnalyticsRange,
} from "./types";

const VALID_RANGES: readonly AnalyticsRange[] = ["1d", "7d", "28d", "90d"];
const VALID_AUDIENCES: readonly AnalyticsAudience[] = ["all", "anon", "loggedIn"];
const VALID_DEVICES: readonly AnalyticsDevice[] = ["all", "desktop", "mobile", "tablet"];

function readParam<T extends string>(
  value: string | null,
  valid: readonly T[],
  fallback: T,
): T {
  return value && (valid as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Hook that surfaces analytics filter state + a setter. Behaves like React
 * state but is backed by the URL's search params so links carry the view.
 *
 * @returns { filters, updateFilter }
 */
export function useAnalyticsFilters(): {
  filters: AnalyticsFilters;
  updateFilter: <K extends keyof AnalyticsFilters>(key: K, value: AnalyticsFilters[K]) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<AnalyticsFilters>(() => ({
    range: readParam(searchParams.get("range"), VALID_RANGES, "7d"),
    audience: readParam(searchParams.get("audience"), VALID_AUDIENCES, "all"),
    device: readParam(searchParams.get("device"), VALID_DEVICES, "all"),
  }), [searchParams]);

  const updateFilter = useCallback(
    <K extends keyof AnalyticsFilters>(key: K, value: AnalyticsFilters[K]): void => {
      const next = new URLSearchParams(searchParams);
      // Omit the default so the URL stays clean when a filter is untouched.
      const defaults: AnalyticsFilters = { range: "7d", audience: "all", device: "all" };
      if (value === defaults[key]) next.delete(key);
      else next.set(key, value as string);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  return { filters, updateFilter };
}
