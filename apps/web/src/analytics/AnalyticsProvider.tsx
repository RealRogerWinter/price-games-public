/**
 * Root-level provider for the client analytics pipeline.
 *
 * Mounts inside `<BrowserRouter>` so that {@link usePageViewTracking} can
 * subscribe to location changes via `useLocation()`. Initializes the beacon
 * sender on mount, tears down on unmount, and exposes a no-op API when
 * the user has DNT / Sec-GPC enabled — the child components never need to
 * check; they just call `useTrackEvent()` unconditionally.
 *
 * Also wires web-vitals reporting: LCP, CLS, INP, TTFB arrive as
 * `performance_metric_reported` events so dashboards can surface field
 * performance without a separate RUM vendor.
 */

import React, { useEffect } from "react";
import { initBeacon, enqueue } from "./beacon";
import { usePageViewTracking } from "./usePageViewTracking";
import { ANALYTICS_EVENTS } from "./types";

interface Props {
  children: React.ReactNode;
}

/**
 * Provider component. Renders its children unchanged; side effect is
 * installing the beacon pipeline for the duration of the subtree.
 */
export function AnalyticsProvider({ children }: Props): React.ReactElement {
  useEffect(() => {
    const teardown = initBeacon();
    void wireWebVitals();
    return teardown;
  }, []);

  // Attach page-view tracking to route changes.
  usePageViewTracking();

  return <>{children}</>;
}

async function wireWebVitals(): Promise<void> {
  try {
    const { onLCP, onCLS, onINP, onTTFB } = await import("web-vitals");
    const report = (name: string) => (metric: { value: number; rating?: string }) => {
      enqueue({
        name: ANALYTICS_EVENTS.PERFORMANCE_METRIC_REPORTED,
        category: "system",
        path: typeof window !== "undefined" ? window.location.pathname : "/",
        properties: {
          metric: name,
          value: Math.round(metric.value),
          rating: metric.rating ?? null,
        },
      });
    };
    onLCP(report("LCP"));
    onCLS(report("CLS"));
    onINP(report("INP"));
    onTTFB(report("TTFB"));
  } catch {
    // web-vitals not available in this environment (SSR / test) — ignore.
  }
}
