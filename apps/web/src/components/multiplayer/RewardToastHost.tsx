import { useEffect } from "react";
import { useInviteReward } from "../../hooks/useInviteReward";
import { getSocket } from "../../api/socket";
import type { InviteBuffConsumedEvent } from "@price-game/shared";
import "../../styles/multiplayer.css";

const AUTO_DISMISS_MS = 4500;
const BUFF_CONSUMED_KEY_PREFIX = "mp_buff_consumed:";

/**
 * Returns the sessionStorage key used to cache the most recent
 * `invite:buff_consumed` payload for a given roomCode. Exported so
 * MPResultsScreen can read the stash after mount.
 */
export function buffConsumedKey(roomCode: string): string {
  return BUFF_CONSUMED_KEY_PREFIX + roomCode;
}

/**
 * Mounted once at the app root. Listens for invite-reward events via
 * useInviteReward and renders a transient toast on the moment of earn.
 *
 * The toast is intentionally non-blocking: it never traps focus and can
 * be dismissed by the user. It auto-dismisses after AUTO_DISMISS_MS so it
 * doesn't pile up if multiple events fire (e.g. quick repeats during a
 * match wrap-up).
 */
export default function RewardToastHost() {
  const { status, multiplier, matchesRemaining, joinerDisplayName, dismiss } = useInviteReward();

  useEffect(() => {
    if (status === "none") return;
    const t = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [status, dismiss]);

  // Stash the most recent `invite:buff_consumed` per roomCode in
  // sessionStorage so MPResultsScreen — which mounts AFTER the server has
  // already emitted the event (buff_consumed precedes GAME_OVER) — can
  // still surface the buff math when the user lands on the results page.
  // Mounted at App-root via this host so the listener is alive throughout
  // the whole match, not just during a particular screen.
  useEffect(() => {
    const socket = getSocket();
    function onBuffConsumed(payload: unknown) {
      const ev = payload as InviteBuffConsumedEvent & { roomCode?: string };
      const code = ev.roomCode;
      if (!code) return;
      try {
        sessionStorage.setItem(buffConsumedKey(code), JSON.stringify(ev));
      } catch {
        // QuotaExceeded / private mode — silently drop. The chip just
        // won't render; not worth reporting to the user.
      }
    }
    socket.on("invite:buff_consumed", onBuffConsumed);
    return () => {
      socket.off("invite:buff_consumed", onBuffConsumed);
    };
  }, []);

  if (status === "none") return null;

  const pct = Math.round((multiplier - 1) * 100);
  const matchesLabel = matchesRemaining === 1 ? "next match" : `next ${matchesRemaining} matches`;

  return (
    <div className="reward-toast" role="status" aria-live="polite">
      <span className="reward-toast-icon" aria-hidden="true">⚡</span>
      <div className="reward-toast-text">
        {status === "earned" ? (
          <>
            <strong>Friendship Boost!</strong>{" "}
            {joinerDisplayName ? `${joinerDisplayName} joined your room.` : "A friend joined."}{" "}
            <span className="reward-toast-pct">+{pct}%</span> on your {matchesLabel}.
          </>
        ) : (
          <>
            <strong>Welcome bonus!</strong>{" "}
            <span className="reward-toast-pct">+{pct}%</span> on your {matchesLabel}.
          </>
        )}
      </div>
      <button
        type="button"
        className="reward-toast-close"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
