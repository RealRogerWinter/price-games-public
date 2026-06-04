import { useEffect, useRef, useState } from "react";
import { useWinRecord } from "../hooks/useWinRecord";

interface ScoreboardProps {
  currentRound: number;
  totalRounds: number;
  score: number;
}

/**
 * Compact round + score + win-record strip rendered above every game's
 * play surface. Player identity is surfaced separately by the IdentityCard
 * (single player) or PlayerStatusBar (multiplayer).
 *
 * The W/L/Streak chip auto-refreshes via the `winrecord:changed` window
 * event dispatched after each game completes (see `useWinRecord`).
 *
 * @param currentRound - 1-indexed current round number.
 * @param totalRounds - Total rounds in the session.
 * @param score - Current cumulative score.
 */
export default function Scoreboard({
  currentRound,
  totalRounds,
  score,
}: ScoreboardProps) {
  const { record } = useWinRecord();

  return (
    <div
      className="scoreboard"
      aria-live="polite"
      aria-label={`Round ${currentRound} of ${totalRounds}, Score: ${score}`}
    >
      <div className="scoreboard-item">
        <span className="scoreboard-label">Round</span>
        <span className="scoreboard-value">
          {currentRound} / {totalRounds}
        </span>
      </div>
      <div className="scoreboard-item">
        <span className="scoreboard-label">Score</span>
        <span className="scoreboard-value score-highlight">{score}</span>
      </div>
      {record ? <StreakPills record={record} /> : null}
    </div>
  );
}

interface StreakPillsProps {
  record: { wins: number; losses: number; currentStreak: number; bestStreak: number };
}

/**
 * Three glass-style pills (Wins / Losses / Streak) that sit alongside
 * Round + Score in the active-game header. Each pill is its own
 * surface — `backdrop-filter` blur over a tinted gradient, with a
 * 1-px translucent border and an inset top highlight for the "liquid"
 * depth effect.
 *
 * The streak pill animates on value transitions:
 *   - `streakWin` when the streak grows by +1
 *   - `streakLoss` when the streak grows by -1
 *   - `streakFlip` overrides both when the sign crosses zero
 *
 * Reduced-motion users get color-only transitions via CSS media query.
 */
function StreakPills({ record }: StreakPillsProps) {
  const previousRef = useRef<number | null>(null);
  const [animClass, setAnimClass] = useState<string>("");

  useEffect(() => {
    const prev = previousRef.current;
    if (prev !== null && prev !== record.currentStreak) {
      const signChanged =
        (prev >= 0 && record.currentStreak < 0) ||
        (prev < 0 && record.currentStreak >= 0);
      const next = signChanged
        ? "is-flip"
        : record.currentStreak > prev
        ? "is-win"
        : "is-loss";
      setAnimClass(next);
      const timeout = window.setTimeout(() => setAnimClass(""), 500);
      previousRef.current = record.currentStreak;
      return () => window.clearTimeout(timeout);
    }
    previousRef.current = record.currentStreak;
  }, [record.currentStreak]);

  const streakClass =
    record.currentStreak > 0
      ? "streak-positive"
      : record.currentStreak < 0
      ? "streak-negative"
      : "streak-neutral";

  return (
    <div
      className="win-pills"
      role="group"
      aria-label={`Win record: ${record.wins} wins, ${record.losses} losses, current streak ${record.currentStreak}`}
    >
      <div className="win-pill win-pill--wins">
        <span className="win-pill-label">Wins</span>
        <span className="win-pill-value">{record.wins}</span>
      </div>
      <div className="win-pill win-pill--losses">
        <span className="win-pill-label">Losses</span>
        <span className="win-pill-value">{record.losses}</span>
      </div>
      <div className={`win-pill win-pill--streak ${streakClass}`}>
        <span className="win-pill-label">Streak</span>
        <span className={`win-pill-value win-pill-streak-num ${animClass}`}>
          {formatStreak(record.currentStreak)}
          {tierIcon(record.currentStreak)}
        </span>
      </div>
    </div>
  );
}

/**
 * Format a signed streak for display. Returns `+5`, `-3`, or `0`.
 * Capped at +999 / -999 to keep the chip width bounded.
 */
export function formatStreak(streak: number): string {
  if (streak === 0) return "0";
  const clamped = Math.max(-999, Math.min(999, streak));
  return clamped > 0 ? `+${clamped}` : String(clamped);
}

/**
 * Decide which milestone icon to surface alongside a positive streak.
 * Negative and zero streaks deliberately get no icon — visible loss
 * iconography felt punishing in UX review.
 */
export function tierIcon(streak: number): string {
  if (streak >= 15) return " 💎";
  if (streak >= 7) return " ⚡";
  if (streak >= 3) return " 🔥";
  return "";
}
