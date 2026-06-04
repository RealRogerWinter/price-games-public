/**
 * Week navigation bar for the daily admin dashboard.
 * Shows the date range of the current week with prev/next arrows and a Today button.
 */

import { addDays } from "@price-game/shared";

interface WeekNavigationBarProps {
  weekStart: string;
  currentDate: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  onToday: () => void;
}

/** Format YYYY-MM-DD as "Mon, Apr 6". */
function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Horizontal bar with prev/next arrows, the current week's date range,
 * and a "Today" button to jump back to the current week.
 */
export default function WeekNavigationBar({
  weekStart,
  currentDate,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onToday,
}: WeekNavigationBarProps) {
  const weekEnd = addDays(weekStart, 6);
  const isCurrentWeek = weekStart <= currentDate && currentDate <= weekEnd;

  return (
    <div className="daily-week-nav">
      <button
        className="daily-week-nav-btn"
        onClick={onPrev}
        disabled={!canPrev}
        aria-label="Previous week"
      >
        &#8249;
      </button>

      <div className="daily-week-nav-label">
        <span className="daily-week-nav-range">
          {formatShortDate(weekStart)} &mdash; {formatShortDate(weekEnd)}
        </span>
        {!isCurrentWeek && (
          <button className="daily-week-nav-today" onClick={onToday}>
            Today
          </button>
        )}
      </div>

      <button
        className="daily-week-nav-btn"
        onClick={onNext}
        disabled={!canNext}
        aria-label="Next week"
      >
        &#8250;
      </button>
    </div>
  );
}
