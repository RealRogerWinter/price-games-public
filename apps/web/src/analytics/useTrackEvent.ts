/**
 * Public hook for firing custom analytics events from any component.
 *
 * The returned function is stable across renders so it can be used in
 * dependency arrays without triggering re-subscriptions. Calls are
 * fire-and-forget: never throw, never await, never block render.
 *
 * When the user has DNT / Sec-GPC enabled, the hook returns a no-op
 * silently — callers don't need to branch.
 *
 * Do NOT use this hook to fire `page_viewed`. That is handled centrally
 * by {@link usePageViewTracking}.
 */

import { useCallback } from "react";
import { enqueue } from "./beacon";
import type { TrackPayload } from "./types";

/**
 * Hook: returns a tracker function. Example:
 *
 * ```tsx
 * const track = useTrackEvent();
 * <button onClick={() => track({ name: "share_clicked", category: "mp" })}>
 *   Share
 * </button>
 * ```
 */
export function useTrackEvent(): (payload: TrackPayload) => void {
  return useCallback((payload: TrackPayload) => {
    if (!payload?.name) return;
    enqueue({
      name: payload.name,
      category: payload.category ?? "custom",
      properties: payload.properties ?? undefined,
      path: typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "/",
    });
  }, []);
}
