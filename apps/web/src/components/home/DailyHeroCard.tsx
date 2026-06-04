/**
 * Daily Challenge card — rendered as the first item in the mode grid.
 *
 * Same size as regular mode cards but with an iridescent rainbow sheen
 * overlay, animated glow border, and a subtle floating animation. Features
 * a custom kawaii shopping bag graphic and a prominent streak indicator.
 *
 * Visual states:
 *   loading    — skeleton placeholder
 *   available  — iridescent card, mode disclosure, "Play" CTA
 *   first-ever — same as available + "NEW" badge
 *   completed  — desaturated, streak, countdown, "Tap to recap"
 *   unavailable — not rendered at all (caller skips rendering)
 *   error      — generic retry placeholder
 */

import { useEffect, useState } from "react";
import type { DailyStreak, DailyTodayResponse } from "@price-game/shared";
import { msUntilNextUtcMidnight } from "@price-game/shared";
import dailyChallengeImg from "../../assets/daily-challenge.webp";
import dailyTrophyImg from "../../assets/daily-trophy.svg";
import streakBronzeImg from "../../assets/streak-bronze.webp";
import streakSilverImg from "../../assets/streak-silver.webp";
import streakGoldImg from "../../assets/streak-gold.webp";
import streakDiamondImg from "../../assets/streak-diamond.webp";
import streakMissedImg from "../../assets/streak-missed.webp";
import streakTodayImg from "../../assets/streak-today.webp";

export type DailyCardState =
  | "loading"
  | "available"
  | "completed"
  | "first-ever"
  | "unavailable"
  | "error";

interface Props {
  today: DailyTodayResponse | null;
  streak: DailyStreak | null;
  state: DailyCardState;
  onClick: () => void;
}

/** Pick the bag icon for a streak value. */
function getStreakIcon(streakAt: number): string {
  if (streakAt >= 30) return streakDiamondImg;
  if (streakAt >= 14) return streakGoldImg;
  if (streakAt >= 7) return streakSilverImg;
  if (streakAt >= 1) return streakBronzeImg;
  return streakMissedImg;
}

/** Get a short weekday label for a date string. */
function weekdayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return ["S", "M", "T", "W", "T", "F", "S"][d.getUTCDay()];
}

/** Build the last 3 days of streak data from the current streak info. */
function buildRecentDays(streak: DailyStreak | null, todayPlayed: boolean) {
  const today = new Date();
  const days: { date: string; label: string; icon: string; isToday: boolean }[] = [];

  for (let i = 2; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const isToday = i === 0;

    if (isToday && !todayPlayed) {
      days.push({ date: dateStr, label: weekdayLabel(dateStr), icon: streakTodayImg, isToday });
    } else if (isToday && todayPlayed) {
      days.push({ date: dateStr, label: weekdayLabel(dateStr), icon: getStreakIcon(streak?.current ?? 1), isToday });
    } else {
      // Past day: if streak covers it, it was played
      const daysAgo = i;
      const streakCovers = streak && streak.current >= daysAgo + (todayPlayed ? 1 : 0);
      if (streakCovers) {
        // Approximate the streak-at-completion for this past day
        const streakAt = Math.max(1, (streak?.current ?? 1) - daysAgo + (todayPlayed ? 0 : -1));
        days.push({ date: dateStr, label: weekdayLabel(dateStr), icon: getStreakIcon(streakAt), isToday });
      } else {
        days.push({ date: dateStr, label: weekdayLabel(dateStr), icon: streakMissedImg, isToday });
      }
    }
  }
  return days;
}

/** Get an encouraging message based on streak state. */
function getStreakMessage(streak: DailyStreak | null, todayPlayed: boolean): string {
  if (!streak || streak.current === 0) {
    return todayPlayed ? "Nice start!" : "Start a streak!";
  }
  if (todayPlayed) {
    if (streak.current >= 7) return `${streak.current}-day streak! On fire!`;
    return `${streak.current}-day streak!`;
  }
  return `${streak.current}-day streak — keep it going!`;
}

/**
 * Mini streak indicator showing the last 3 days with bag icons.
 * Sits above the daily hero card content.
 *
 * When `showCountdown` is true, a live "Next in Xh Ym" countdown replaces
 * the encouragement message — used in the completed state so the player
 * still sees useful information (when the next daily unlocks) even though
 * the tile itself is greyed out.
 */
function MiniStreak({
  streak,
  todayPlayed,
  showCountdown,
}: {
  streak: DailyStreak | null;
  todayPlayed: boolean;
  showCountdown?: boolean;
}) {
  const days = buildRecentDays(streak, todayPlayed);
  const message = getStreakMessage(streak, todayPlayed);

  return (
    <div className="daily-mini-streak">
      <div className="daily-mini-streak-days">
        {days.map((day) => (
          <div key={day.date} className={`daily-mini-streak-day${day.isToday ? " daily-mini-streak-day--today" : ""}`}>
            <span className="daily-mini-streak-label">{day.label}</span>
            <img className="daily-mini-streak-icon" src={day.icon} alt="" draggable={false} />
          </div>
        ))}
      </div>
      {showCountdown ? (
        <MiniStreakCountdown />
      ) : (
        <span className="daily-mini-streak-msg">{message}</span>
      )}
    </div>
  );
}

/** Live countdown rendered inside the mini streak bubble. */
function MiniStreakCountdown() {
  const [ms, setMs] = useState(() => msUntilNextUtcMidnight(new Date()));

  useEffect(() => {
    const id = setInterval(() => {
      setMs(msUntilNextUtcMidnight(new Date()));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return (
    <span className="daily-mini-streak-msg daily-mini-streak-msg--countdown">
      Next in {hours}h {minutes}m
    </span>
  );
}

/**
 * Home-page card for the daily challenge. Fits in the mode grid alongside
 * other game mode cards, but has an animated iridescent sheen overlay and
 * glowing border.
 *
 * @param today - Today's daily metadata (null during loading/unavailable)
 * @param streak - Current user streak (null during loading)
 * @param state - Visual state
 * @param onClick - Fires on tap; behaviour depends on state (start vs recap)
 */
export default function DailyHeroCard({ today, streak, state, onClick }: Props) {
  if (state === "unavailable") return null;

  const hasStreak = streak && streak.current > 0 && state !== "loading";
  const isCompleted = state === "completed";

  return (
    <button
      className={`daily-hero daily-hero-${state}`}
      onClick={onClick}
      disabled={state === "loading"}
      data-testid="daily-hero-card"
    >
      {/* Animated iridescent sheen overlay */}
      <div className="daily-hero-sheen" aria-hidden="true" />

      {/* Mini streak indicator — last 3 days */}
      {state !== "loading" && state !== "error" && (
        <MiniStreak streak={streak} todayPlayed={isCompleted} showCountdown={isCompleted} />
      )}

      <div className="daily-hero-icon">
        <img
          className="daily-hero-bag-img"
          src={isCompleted ? dailyTrophyImg : dailyChallengeImg}
          alt=""
          draggable={false}
        />
        {hasStreak && (
          <span className="daily-hero-streak">{streak.current}</span>
        )}
      </div>

      <div className="daily-hero-header">
        <span className="daily-hero-label">Daily Challenge</span>
        {state === "first-ever" && <span className="daily-hero-badge">NEW</span>}
      </div>

      {state === "loading" && (
        <p className="daily-hero-desc">Loading...</p>
      )}

      {state === "error" && (
        <p className="daily-hero-desc">Could not load</p>
      )}

      {(state === "available" || state === "first-ever") && today && (
        <>
          <p className="daily-hero-desc">
            <span className="daily-hero-mode">{today.modeName}</span> &middot; {today.totalRounds} rounds
          </p>
          <span className="daily-hero-cta">Play</span>
        </>
      )}

      {isCompleted && today && (
        <>
          <p className="daily-hero-completed-label">Completed</p>
          {streak && streak.current > 0 && (
            <p className="daily-hero-streak-text">
              {streak.current === 1
                ? "1 day streak"
                : `${streak.current} day streak!`}
            </p>
          )}
          <span className="daily-hero-cta daily-hero-cta-recap">Recap</span>
        </>
      )}
    </button>
  );
}
