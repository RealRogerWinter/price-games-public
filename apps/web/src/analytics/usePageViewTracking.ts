/**
 * Auto-fire `page_viewed` events on React Router location changes.
 *
 * The initial mount does NOT fire — the server-side middleware has
 * already captured the initial HTML request as a page_viewed event, so
 * firing here too would double-count. A 150ms debounce also absorbs
 * StrictMode double-renders in development and intermediate redirects
 * where `useLocation` may flash through a transient URL.
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { enqueue } from "./beacon";
import { ANALYTICS_EVENTS } from "./types";

/**
 * Hook: subscribes to route changes and fires one `page_viewed` per
 * settled path. Must be called from inside a `<BrowserRouter>`.
 */
export function usePageViewTracking(): void {
  const location = useLocation();
  const initialMount = useRef(true);
  const lastPath = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      lastPath.current = location.pathname + location.search;
      return;
    }

    const fullPath = location.pathname + location.search;
    if (fullPath === lastPath.current) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      lastPath.current = fullPath;
      enqueue({
        name: ANALYTICS_EVENTS.PAGE_VIEWED,
        category: "page",
        path: fullPath,
      });
    }, 150);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [location]);
}
