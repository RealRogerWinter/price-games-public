import { useEffect, useState } from "react";
import type { DailyRecapResponse, ShareGridInput } from "@price-game/shared";
import { fetchDailyRecap } from "../../api/dailyClient";
import ShareModal from "../share/ShareModal";

interface Props {
  /** The date string the player just completed, e.g. "2026-04-11". */
  date: string;
  /** Display name to embed in the share card (null for anon/guests). */
  playerName: string | null;
  /** Closes the modal overlay. */
  onClose: () => void;
}

/**
 * Recap overlay for a completed daily challenge. Fetches a rich recap
 * payload (per-round scores + the exact products the player saw) and
 * renders a {@link ShareModal} with those round snapshots attached so the
 * share card shows real product titles, thumbnails, and Amazon affiliate
 * links — not just an emoji grid.
 *
 * The per-round products come from the deterministic, shared-across-users
 * `daily_puzzles` lineup joined with the player's `daily_plays` scores, so
 * no extra storage is required beyond what's already persisted.
 *
 * States:
 *   loading  — spinner while /api/daily/recap/:date resolves
 *   error    — friendly message + dismiss button (404 / 500 / network)
 *   ready    — defers to ShareModal with the derived ShareGridInput +
 *              roundSnapshots (which triggers the `/s/:id` short-URL mint
 *              so the card gets a shareable link)
 */
export default function DailyRecapModal({ date, playerName, onClose }: Props) {
  const [recap, setRecap] = useState<DailyRecapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDailyRecap(date)
      .then((res) => {
        if (cancelled) return;
        setRecap(res);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Map common cases to friendlier copy; otherwise surface the raw
        // message so the user at least knows *something* failed.
        if (/not_completed/.test(err.message)) {
          setError("No recap available — you haven't completed this daily yet.");
        } else if (/puzzle_missing/.test(err.message)) {
          setError("This daily's details are no longer available.");
        } else {
          setError(err.message || "Failed to load daily recap");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  if (loading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <p className="modal-loading">Loading your recap…</p>
        </div>
      </div>
    );
  }

  if (error || !recap) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <p className="modal-error">{error ?? "No recap available"}</p>
          <button className="btn btn-secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    );
  }

  const shareInput: ShareGridInput = {
    gameMode: recap.gameMode,
    modeName: recap.modeName,
    roundScores: recap.perRoundScores,
    totalScore: recap.totalScore,
    perRoundMax: recap.perRoundMax,
  };

  return (
    <ShareModal
      shareInput={shareInput}
      roundSnapshots={recap.rounds}
      playerName={playerName}
      onClose={onClose}
    />
  );
}
