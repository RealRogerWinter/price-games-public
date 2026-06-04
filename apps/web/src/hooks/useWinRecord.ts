import { useEffect, useRef, useState } from "react";
import type { WinRecord } from "@price-game/shared";
import { userGetWinRecord } from "../api/userClient";

const STORAGE_KEY = "win_record_cache_v1";

/**
 * Custom event dispatched after a game completes so the HUD chip refreshes
 * without prop drilling. Game pages call `notifyWinRecordChanged()` to
 * trigger every mounted `useWinRecord` listener to refetch.
 */
const WIN_RECORD_EVENT = "winrecord:changed";

/**
 * Read the cached snapshot from sessionStorage, if any. Best-effort: any
 * parse error or storage exception falls through to a fresh fetch.
 */
function readCache(): WinRecord | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WinRecord> | null;
    if (!parsed) return null;
    if (
      typeof parsed.wins === "number" &&
      typeof parsed.losses === "number" &&
      typeof parsed.currentStreak === "number" &&
      typeof parsed.bestStreak === "number" &&
      typeof parsed.totalGames === "number"
    ) {
      return parsed as WinRecord;
    }
  } catch {
    // Fall through to fresh fetch.
  }
  return null;
}

function writeCache(record: WinRecord): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage disabled (Safari private mode, embedded webviews) — accept
    // the cache miss; fresh fetches will always work.
  }
}

/**
 * Notify every mounted instance of `useWinRecord` that the player's
 * lifetime W/L counters changed and they should refetch from the server.
 * Call after a game completes (SP submit response, MP results screen).
 */
export function notifyWinRecordChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WIN_RECORD_EVENT));
  }
}

/**
 * Returns the current viewer's lifetime W/L snapshot (logged-in or anon),
 * along with a `refresh()` callback. The snapshot updates automatically
 * after game completions via the `winrecord:changed` window event.
 *
 * Renders a sessionStorage-cached value on first paint when available so
 * the HUD chip doesn't pop in mid-page-load.
 */
export function useWinRecord(): {
  record: WinRecord | null;
  refresh: () => void;
} {
  const [record, setRecord] = useState<WinRecord | null>(() => readCache());
  // Each fetch increments this counter; only the response from the
  // latest issued fetch is allowed to write state. Stops a slow earlier
  // response from overwriting a faster later one when many
  // `winrecord:changed` events fire in close succession (e.g. a flurry
  // of round completions in a fast game).
  const fetchSeqRef = useRef(0);
  const unmountedRef = useRef(false);

  const fetchOnce = (): void => {
    const seq = ++fetchSeqRef.current;
    userGetWinRecord()
      .then((res) => {
        if (unmountedRef.current) return;
        if (seq !== fetchSeqRef.current) return; // a newer fetch superseded us
        setRecord(res.record);
        writeCache(res.record);
      })
      .catch(() => {
        // Network errors are non-critical; HUD chip stays on its last value.
      });
  };

  useEffect(() => {
    unmountedRef.current = false;
    fetchOnce();
    const onChanged = (): void => fetchOnce();
    window.addEventListener(WIN_RECORD_EVENT, onChanged);
    return () => {
      unmountedRef.current = true;
      window.removeEventListener(WIN_RECORD_EVENT, onChanged);
    };
    // Intentionally empty deps — fetchOnce is stable enough for this usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { record, refresh: fetchOnce };
}
