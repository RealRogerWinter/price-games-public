/**
 * Daily challenge intro screen.
 *
 * Rendered when the player taps the hero card on the home page. Shows the
 * date, mode name, streak state, rule reminder, and a clear commitment
 * boundary ("your attempt begins on your first guess"). Opening this
 * screen is FREE — the attempt is only burned on the first guess
 * submission.
 */

import type { DailyStreak, DailyTodayResponse } from "@price-game/shared";

interface Props {
  today: DailyTodayResponse;
  streak: DailyStreak | null;
  onStart: () => void;
  onBack: () => void;
}

/**
 * Daily challenge intro page.
 *
 * @param today - Today's puzzle metadata (date, mode, modeName)
 * @param streak - The player's current streak snapshot; null if unknown
 * @param onStart - Called when the player taps "Start"
 * @param onBack - Called when the player taps "Back"
 */
export default function DailyIntroPage({ today, streak, onStart, onBack }: Props) {
  const isNewPlayer = !streak || (streak.current === 0 && streak.best === 0);

  return (
    <div className="page daily-intro-page">
      <div className="daily-intro-card">
        <p className="daily-intro-label">DAILY CHALLENGE</p>
        <h1 className="daily-intro-date">{formatDate(today.date)}</h1>

        <div className="daily-intro-mode">
          <span className="daily-intro-mode-label">Today's mode</span>
          <span className="daily-intro-mode-name">{today.modeName}</span>
        </div>

        <div className="daily-intro-streak">
          {isNewPlayer ? (
            <p className="daily-intro-streak-new">Start your streak</p>
          ) : (
            <>
              <p className="daily-intro-streak-current">
                <span className="daily-streak-flame">🔥</span> {streak.current} day{streak.current !== 1 ? "s" : ""}
              </p>
              {streak.best > streak.current && (
                <p className="daily-intro-streak-best">Best: {streak.best} days</p>
              )}
            </>
          )}
        </div>

        <p className="daily-intro-rules">
          {today.totalRounds} rounds of {today.modeName} — same puzzle for everyone today.
        </p>

        <p className="daily-intro-commit-notice">
          Your attempt begins when you make your first guess.
        </p>

        <div className="daily-intro-actions">
          <button className="btn btn-primary daily-intro-start" onClick={onStart}>
            Start
          </button>
          <button className="btn btn-secondary daily-intro-back" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
