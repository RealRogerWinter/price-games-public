/**
 * Streak tracking card for the user profile page.
 *
 * Compact design: bold "STREAK" header with count, and a horizontal
 * scrollable strip of day icons showing completion status. Uses
 * kawaii shopping bag icons that evolve with streak length:
 *   - Missed: sad grey bag
 *   - Bronze (streak 1-6): happy brown bag
 *   - Silver (streak 7-13): excited silver bag with sparkles
 *   - Gold (streak 14-29): golden bag with crown
 *   - Diamond (streak 30+): rainbow gem-encrusted bag
 *   - Today (unplayed): golden price tag with "?"
 */

import { useState, useEffect, useRef } from "react";
import type { DailyStreak, DailyPlay } from "@price-game/shared";
import { fetchDailyToday, fetchDailyHistory, DailyDisabledError } from "../api/dailyClient";
import streakMissedImg from "../assets/streak-missed.webp";
import streakBronzeImg from "../assets/streak-bronze.webp";
import streakSilverImg from "../assets/streak-silver.webp";
import streakGoldImg from "../assets/streak-gold.webp";
import streakDiamondImg from "../assets/streak-diamond.webp";
import streakTodayImg from "../assets/streak-today.webp";

/** Days to fetch / display in the scrollable strip. */
const HISTORY_DAYS = 42;

/** Short weekday labels. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DayEntry {
  date: string;
  weekday: string;
  dayNum: number;
  played: boolean;
  score: number;
  isToday: boolean;
  isFuture: boolean;
  /** The streak-at-completion for this day, used to pick the icon tier. */
  streakAt: number;
}

/** Streak tier thresholds and display names. */
const TIERS = [
  { min: 30, icon: streakDiamondImg, name: "Diamond", color: "#c490ff" },
  { min: 14, icon: streakGoldImg, name: "Gold", color: "#f6c90e" },
  { min: 7, icon: streakSilverImg, name: "Silver", color: "#b8c9e0" },
  { min: 1, icon: streakBronzeImg, name: "Bronze", color: "#cd9b5a" },
] as const;

/**
 * Pick the icon for a played day based on what the streak was at completion.
 */
function getPlayedIcon(streakAt: number): string {
  for (const t of TIERS) {
    if (streakAt >= t.min) return t.icon;
  }
  return streakBronzeImg;
}

/** Get the tier display name for a streak value. */
function getTierName(streakAt: number): string {
  for (const t of TIERS) {
    if (streakAt >= t.min) return t.name;
  }
  return "Bronze";
}

/** Format a date string (YYYY-MM-DD) for display. */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Build a flat array of day entries for the strip, from oldest to newest.
 */
function buildDayStrip(plays: DailyPlay[], today: string): DayEntry[] {
  const playMap = new Map(plays.map((p) => [p.date, p]));
  const todayDate = new Date(today + "T00:00:00Z");
  const days: DayEntry[] = [];

  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(todayDate);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const play = playMap.get(dateStr);
    const isToday = dateStr === today;

    days.push({
      date: dateStr,
      weekday: WEEKDAYS[d.getUTCDay()],
      dayNum: d.getUTCDate(),
      played: !!play,
      score: play?.score ?? 0,
      isToday,
      isFuture: dateStr > today,
      streakAt: play?.streakAtCompletion ?? 0,
    });
  }
  return days;
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compact streak tracking card. Shows a bold streak count and a
 * horizontally scrollable strip of kawaii shopping bag icons.
 */
export default function StreakCard() {
  const [streak, setStreak] = useState<DailyStreak | null>(null);
  const [plays, setPlays] = useState<DailyPlay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [todayRes, historyRes] = await Promise.all([
          fetchDailyToday(),
          fetchDailyHistory(HISTORY_DAYS),
        ]);
        if (cancelled) return;
        setStreak(todayRes.streak ?? { current: 0, best: 0, lastDate: null });
        setPlays(historyRes.plays);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DailyDisabledError) {
          setDisabled(true);
        } else {
          setError("Could not load streak data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // Scroll to the end (today) when data loads
  useEffect(() => {
    if (!loading && stripRef.current) {
      stripRef.current.scrollLeft = stripRef.current.scrollWidth;
    }
  }, [loading, plays]);

  if (loading) {
    return (
      <div className="streak-card" data-testid="streak-card-loading">
        <div className="streak-card-skeleton" />
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="streak-card">
        <p className="streak-card-unavailable">Daily challenges are currently unavailable</p>
      </div>
    );
  }

  if (error || !streak) {
    return (
      <div className="streak-card">
        <p className="streak-card-error">{error ?? "Could not load streak data"}</p>
      </div>
    );
  }

  const today = getToday();
  const days = buildDayStrip(plays, today);
  const isBroken = streak.current === 0 && streak.best > 0;
  const isNew = streak.current === 0 && streak.best === 0;

  return (
    <div className="streak-card">
      {/* Header: STREAK count */}
      <div className="streak-card-hero">
        <div className="streak-card-info">
          <span className="streak-card-title" data-testid="streak-card-flame">DAILY STREAK</span>
          <span className="streak-card-count" data-testid="streak-card-count">{streak.current}</span>
          <span className="streak-card-label">day{streak.current !== 1 ? "s" : ""}</span>
        </div>
        <div className="streak-card-meta">
          {streak.best > streak.current && (
            <span className="streak-card-best">Best: {streak.best} days</span>
          )}
          {isNew && (
            <span className="streak-card-status streak-card-status--new">Play your first daily challenge to start a streak!</span>
          )}
          {isBroken && (
            <span className="streak-card-status streak-card-status--broken">Start a new streak!</span>
          )}
        </div>
      </div>

      {/* Day strip: horizontal scroll */}
      <div className="streak-card-strip" ref={stripRef}>
        {days.map((day) => {
          let icon: string;
          let alt: string;
          let tooltipLine1: string;
          let tooltipLine2: string;
          const dateLabel = formatDate(day.date);

          if (day.isFuture) {
            icon = streakMissedImg;
            alt = "Future";
            tooltipLine1 = dateLabel;
            tooltipLine2 = "Upcoming";
          } else if (day.isToday && !day.played) {
            icon = streakTodayImg;
            alt = "Today — play now!";
            tooltipLine1 = `${dateLabel} (Today)`;
            tooltipLine2 = "Play to continue your streak!";
          } else if (day.played) {
            const tierName = getTierName(day.streakAt);
            icon = getPlayedIcon(day.streakAt);
            alt = `Completed (${tierName})`;
            tooltipLine1 = `${dateLabel}${day.isToday ? " (Today)" : ""}`;
            tooltipLine2 = `${tierName} \u00B7 ${day.score.toLocaleString()} pts \u00B7 ${day.streakAt} day streak`;
          } else {
            icon = streakMissedImg;
            alt = "Missed";
            tooltipLine1 = dateLabel;
            tooltipLine2 = "No play \u2014 streak reset";
          }

          return (
            <div
              key={day.date}
              data-date={day.date}
              data-played={day.played || undefined}
              className={`streak-card-day${day.isToday ? " streak-card-day--today" : ""}${day.isFuture ? " streak-card-day--future" : ""}${day.played ? " streak-card-day--played" : ""}`}
            >
              <div className="streak-card-tooltip">
                <span className="streak-card-tooltip-date">{tooltipLine1}</span>
                <span className="streak-card-tooltip-detail">{tooltipLine2}</span>
              </div>
              <span className="streak-card-day-label">{day.weekday.slice(0, 1)}</span>
              <img
                className="streak-card-day-icon"
                src={icon}
                alt={alt}
                draggable={false}
              />
              <span className="streak-card-day-num">{day.dayNum}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
