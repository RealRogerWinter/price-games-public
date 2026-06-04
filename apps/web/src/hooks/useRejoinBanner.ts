import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { getPlayerSession, clearPlayerSession } from "../api/socket";

/**
 * Time the location must remain stable before we re-validate the saved
 * session against the server. A short debounce avoids hammering
 * `/api/mp/room/...` when the user is rapidly bouncing between pages
 * (e.g., back/forward through history).
 */
const REVALIDATE_DEBOUNCE_MS = 250;

export interface RejoinInfo {
  roomCode: string;
  status: string;
}

/**
 * Watches the saved multiplayer session and resolves it into a
 * `RejoinInfo` whenever the player has an active room they could
 * return to. Re-evaluates on every `useLocation()` change so the
 * banner appears as soon as the user lands back on home after leaving
 * a game (the previous mount-only effect missed this and required a
 * full refresh to see the banner).
 *
 * `clear()` removes both the local state and the persisted MP session
 * — used by the dismiss button on the banner.
 *
 * Validation against the server short-circuits when there's no saved
 * session, so the steady-state cost on home is one localStorage read
 * per navigation. With a saved session we issue at most one
 * `/api/mp/room/{code}` per debounced location change.
 */
export function useRejoinBanner(): {
  rejoinInfo: RejoinInfo | null;
  clear: () => void;
} {
  const location = useLocation();
  const [rejoinInfo, setRejoinInfo] = useState<RejoinInfo | null>(null);
  // Latest checked roomCode so an in-flight response for an older
  // session doesn't clobber state if the user just dismissed it.
  const lastCheckedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const debounceTimer = setTimeout(() => {
      const saved = getPlayerSession();
      if (cancelled) return;
      if (!saved) {
        // No session → make sure stale banner state is cleared.
        setRejoinInfo((prev) => (prev ? null : prev));
        lastCheckedRef.current = null;
        return;
      }
      const checkedCode = saved.roomCode;
      lastCheckedRef.current = checkedCode;

      fetch(`/api/mp/room/${saved.roomCode}`)
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error("Room not found");
        })
        .then((room) => {
          if (cancelled) return;
          // Drop the response if the user dismissed (or rejoined and a
          // newer effect run took over) between request and ack.
          if (lastCheckedRef.current !== checkedCode) return;
          if (room.status !== "finished") {
            setRejoinInfo({ roomCode: saved.roomCode, status: room.status });
          } else {
            const current = getPlayerSession();
            if (current?.roomCode === checkedCode) {
              clearPlayerSession();
            }
            setRejoinInfo(null);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (lastCheckedRef.current !== checkedCode) return;
          // Room no longer exists — only clear if session still refers
          // to the same room we just checked.
          const current = getPlayerSession();
          if (current?.roomCode === checkedCode) {
            clearPlayerSession();
          }
          setRejoinInfo(null);
        });
    }, REVALIDATE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [location.pathname]);

  /**
   * Dismiss the banner and forget the saved session entirely. Bumps
   * `lastCheckedRef` so any racing in-flight response is dropped.
   */
  function clear(): void {
    lastCheckedRef.current = null;
    clearPlayerSession();
    setRejoinInfo(null);
  }

  return { rejoinInfo, clear };
}
