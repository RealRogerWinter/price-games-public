/**
 * A single day card in the weekly strip.
 * Shows the date, game mode (editable for future days), status badge, and summary stats.
 */

import type { AdminDailyPuzzleRow, GameMode } from "@price-game/shared";
import { DAILY_ADMIN_ALLOWED_MODES, getGameModeName } from "@price-game/shared";

interface DayCardProps {
  row: AdminDailyPuzzleRow;
  isToday: boolean;
  isReadOnly: boolean;
  isSelected: boolean;
  hasPendingChanges: boolean;
  onSelect: (date: string) => void;
  onModeChange: (date: string, mode: GameMode) => void;
}

/** Short day name from YYYY-MM-DD. */
function getDayName(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** Format as "Apr 6". */
function getShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Individual day card displaying date, mode, and status. Clicking selects it
 * to reveal the round detail panel below.
 */
export default function DayCard({
  row,
  isToday,
  isReadOnly,
  isSelected,
  hasPendingChanges,
  onSelect,
  onModeChange,
}: DayCardProps) {
  const classNames = [
    "daily-day-card",
    isToday && "daily-day-card--today",
    isSelected && "daily-day-card--selected",
    isReadOnly && "daily-day-card--readonly",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classNames}
      onClick={() => onSelect(row.date)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(row.date);
      }}
      data-testid={`day-card-${row.date}`}
    >
      <div className="daily-day-card-header">
        <span className="daily-day-name">{getDayName(row.date)}</span>
        <span className="daily-day-date">{getShortDate(row.date)}</span>
        {isToday && <span className="daily-today-badge">Today</span>}
      </div>

      <div className="daily-day-card-mode">
        {isReadOnly ? (
          <span className="daily-mode-badge">{getGameModeName(row.gameMode)}</span>
        ) : (
          <select
            className="daily-mode-select"
            value={row.gameMode}
            onChange={(e) => {
              e.stopPropagation();
              onModeChange(row.date, e.target.value as GameMode);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {DAILY_ADMIN_ALLOWED_MODES.map((m) => (
              <option key={m} value={m}>
                {getGameModeName(m)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="daily-day-card-footer">
        <span
          className={`daily-status-badge ${
            row.isManualOverride ? "daily-status-manual" : "daily-status-auto"
          }`}
        >
          {row.isManualOverride ? "Manual" : "Auto"}
        </span>
        {hasPendingChanges && (
          <span className="daily-status-badge daily-status-pending">Unsaved</span>
        )}
        {row.playCount > 0 && (
          <span className="daily-play-count">{row.playCount} plays</span>
        )}
      </div>

      <div className="daily-day-card-products">
        {row.productIds.length > 0
          ? `${row.productIds.length} products`
          : "No products"}
      </div>
    </div>
  );
}
