import { useEffect, useState } from "react";
import type { PendingBuff } from "@price-game/shared";
import "../../styles/multiplayer.css";
import buffIcon from "../../assets/multiplayer/buff-icon.webp";

/**
 * Small chip rendered in the lobby header. Two states:
 *
 *   - When no buff is pending or active: "Invite a friend → +25% next match"
 *   - When the host has an active buff (just earned, or carryover from a
 *     previous match): "Bonus active — +X% × N matches"
 *
 * Reads /api/users/me/buffs once on mount + again whenever `refreshKey`
 * changes so the lobby can prompt a refresh after the post-match earn
 * propagates from the server.
 */
export interface InviteRewardBadgeProps {
  /** Bumping this triggers a re-fetch of /me/buffs. */
  refreshKey?: unknown;
  /**
   * Compact mode renders only the active-bonus chip and stays silent when
   * no buff is active. Used on surfaces (e.g. the home page) where the
   * full invite-prompt banner would be too prominent — only show "+25%
   * Bonus active" when there's something to celebrate.
   */
  compact?: boolean;
}

export default function InviteRewardBadge({ refreshKey, compact }: InviteRewardBadgeProps) {
  const [buffs, setBuffs] = useState<PendingBuff[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/users/me/buffs", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setBuffs([]);
          return;
        }
        const data = (await res.json()) as { active?: PendingBuff[] };
        // Defensive: legacy or mocked responses may omit `active`. Always
        // store an array to avoid `undefined.find` at render time.
        if (!cancelled) setBuffs(Array.isArray(data?.active) ? data.active : []);
      })
      .catch(() => {
        if (!cancelled) setBuffs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!Array.isArray(buffs)) return null; // loading — render nothing rather than flash

  const top = buffs.find((b) => b.matchesRemaining > 0);
  if (top) {
    const pct = Math.round((top.multiplier - 1) * 100);
    return (
      <span
        className="invite-reward-badge invite-reward-badge-active"
        data-testid="invite-reward-badge"
      >
        <img src={buffIcon} alt="" className="invite-reward-badge-icon" aria-hidden="true" />
        Bonus active · +{pct}% · {top.matchesRemaining}{" "}
        {top.matchesRemaining === 1 ? "match" : "matches"} left
      </span>
    );
  }

  // Compact mode hides the full invite-prompt banner — only the active
  // chip above is shown. Render nothing here when no buff is active.
  if (compact) return null;

  return (
    <div className="invite-reward-card" data-testid="invite-reward-badge">
      <img src={buffIcon} alt="" className="invite-reward-card-icon" aria-hidden="true" />
      <div className="invite-reward-card-text">
        <p className="invite-reward-card-title">Invite a friend</p>
        <p className="invite-reward-card-body">
          Earn <strong>25% more points</strong> on your next three matches when they join and play.
        </p>
      </div>
    </div>
  );
}
