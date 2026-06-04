import { useEffect, useState } from "react";
import { getSocket } from "../api/socket";
import type { InviteRewardEarnedEvent, InviteWelcomeBonusEvent } from "@price-game/shared";

/**
 * Status of the most recent invite-reward event observed by this client.
 *
 * - `none`: no reward known
 * - `earned`: this client is the inviter; the joiner finished the trigger
 *   round and the +25% buff is queued for the inviter's next 3 matches
 * - `welcomed`: this client is the joiner; the welcome bonus (+10% × 1) is
 *   queued for their next match
 */
export type InviteRewardStatus = "none" | "earned" | "welcomed";

export interface UseInviteRewardResult {
  status: InviteRewardStatus;
  /** Current multiplier (1 if no reward, e.g. 1.25 for host earn). */
  multiplier: number;
  /** Matches remaining on the buff (server-decided). */
  matchesRemaining: number;
  /** Display name of the joiner who triggered the host earn. */
  joinerDisplayName: string | null;
  /** Reset status to 'none' (used after the toast is acknowledged). */
  dismiss: () => void;
}

/**
 * Subscribe to the two server-side reward events on the multiplayer socket
 * and expose the latest earn for UI consumers (lobby badge, post-match
 * card, global toast). Multiple consumers can call this safely — they each
 * register their own pair of listeners and unregister on unmount.
 */
export function useInviteReward(): UseInviteRewardResult {
  const [status, setStatus] = useState<InviteRewardStatus>("none");
  const [multiplier, setMultiplier] = useState(1);
  const [matchesRemaining, setMatchesRemaining] = useState(0);
  const [joinerDisplayName, setJoinerDisplayName] = useState<string | null>(null);

  useEffect(() => {
    const socket = getSocket();
    function handleEarned(payload: unknown) {
      const ev = payload as InviteRewardEarnedEvent;
      setStatus("earned");
      setMultiplier(ev.multiplier);
      setMatchesRemaining(ev.matchesRemaining);
      setJoinerDisplayName(ev.joinerDisplayName ?? null);
    }
    function handleWelcome(payload: unknown) {
      const ev = payload as InviteWelcomeBonusEvent;
      setStatus("welcomed");
      setMultiplier(ev.multiplier);
      setMatchesRemaining(ev.matchesRemaining);
      setJoinerDisplayName(null);
    }
    socket.on("invite:reward_earned", handleEarned);
    socket.on("invite:welcome_bonus", handleWelcome);
    return () => {
      socket.off("invite:reward_earned", handleEarned);
      socket.off("invite:welcome_bonus", handleWelcome);
    };
  }, []);

  return {
    status,
    multiplier,
    matchesRemaining,
    joinerDisplayName,
    dismiss: () => setStatus("none"),
  };
}
