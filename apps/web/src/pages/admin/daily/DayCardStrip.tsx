/**
 * Seven-column grid of DayCards representing one week.
 */

import type { AdminDailyPuzzleRow, GameMode } from "@price-game/shared";
import DayCard from "./DayCard";

interface DayCardStripProps {
  rows: AdminDailyPuzzleRow[];
  currentDate: string;
  selectedDate: string | null;
  pendingDates: Set<string>;
  onSelectDate: (date: string) => void;
  onModeChange: (date: string, mode: GameMode) => void;
}

/**
 * Renders a horizontal strip of 7 day cards, one per day of the week.
 */
export default function DayCardStrip({
  rows,
  currentDate,
  selectedDate,
  pendingDates,
  onSelectDate,
  onModeChange,
}: DayCardStripProps) {
  return (
    <div className="daily-day-strip" data-testid="day-card-strip">
      {rows.map((row) => (
        <DayCard
          key={row.date}
          row={row}
          isToday={row.date === currentDate}
          isReadOnly={row.date < currentDate}
          isSelected={row.date === selectedDate}
          hasPendingChanges={pendingDates.has(row.date)}
          onSelect={onSelectDate}
          onModeChange={onModeChange}
        />
      ))}
    </div>
  );
}
