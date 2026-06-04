import { useEffect, useState } from "react";

/**
 * Status of the live-player-count probe. `loading` is the initial state
 * before the first fetch resolves; `live` once we have a fresh value;
 * `offline` if the request failed (so the UI can hide or fall back).
 */
export type LivePlayerCountStatus = "loading" | "live" | "offline";

/** How often to refetch when the tab is visible (ms). 15s feels live
 *  without spamming /api/mp/lobbies. */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * Hook that fetches the count of currently-public multiplayer lobbies for
 * social proof on the home page hero card and the /mp join screen.
 *
 * Polls every {@link REFRESH_INTERVAL_MS} while the tab is visible and
 * pauses while it's hidden — avoids burning bandwidth on tabs that are
 * backgrounded for hours. Re-fetches on visibility-change so the value
 * is fresh the moment the user returns. Network errors keep the last
 * known count and flip status to `offline` so the UI can fall back.
 *
 * @returns `{ count, status }` — count is 0 until the first fetch lands.
 */
export function useLivePlayerCount(): {
  count: number;
  status: LivePlayerCountStatus;
} {
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<LivePlayerCountStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    function fetchOnce(): void {
      const ac = new AbortController();
      // Each fetch gets its own AbortController so a long-running
      // request from a previous tick can be cancelled when the
      // component unmounts. Race-safe: `cancelled` plus the abort gate
      // any late-arriving response from clobbering fresher state.
      fetch("/api/mp/lobbies", { signal: ac.signal })
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setStatus("offline");
            return;
          }
          const data = (await res.json()) as { lobbies?: unknown[] };
          const list = Array.isArray(data.lobbies) ? data.lobbies : [];
          setCount(list.length);
          setStatus("live");
        })
        .catch((err) => {
          if (cancelled) return;
          // AbortError is expected on unmount; don't flip the status.
          if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") return;
          setStatus("offline");
        });
    }

    function startPolling(): void {
      if (interval !== null) return;
      fetchOnce(); // immediate
      interval = setInterval(fetchOnce, REFRESH_INTERVAL_MS);
    }

    function stopPolling(): void {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        // Refresh immediately when the user comes back, then resume
        // the timer.
        startPolling();
      } else {
        stopPolling();
      }
    }

    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return { count, status };
}
