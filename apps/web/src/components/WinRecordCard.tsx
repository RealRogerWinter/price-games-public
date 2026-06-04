import { useEffect, useState } from "react";
import type { WinRecord, GameMode } from "@price-game/shared";
import { userGetWinRecord, type WinRecordByModeEntry } from "../api/userClient";
import { formatStreak, tierIcon } from "./Scoreboard";
import { getGameModeName } from "@price-game/shared";

/**
 * "Win Record" card on the My Scores page. Sibling to the existing
 * `StreakCard` (which tracks consecutive *days* played); copy is
 * deliberately distinct ("WIN RECORD" vs "DAILY STREAK") so the two
 * concepts don't get conflated.
 *
 * Sections:
 *   - Hero: signed current streak + tier icon + "Best: +N" badge
 *   - W·L counts and win-rate
 *   - Per-mode breakdown table (logged-in users only)
 */
export default function WinRecordCard() {
  const [record, setRecord] = useState<WinRecord | null>(null);
  const [byMode, setByMode] = useState<WinRecordByModeEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    userGetWinRecord("mode")
      .then((res) => {
        if (cancelled) return;
        setRecord(res.record);
        setByMode(res.byMode ?? []);
      })
      .catch(() => {
        // Ignore; the card just stays in its loading/empty state.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !record) {
    return (
      <div className="win-record-card win-record-card--loading" aria-busy="true">
        <span className="win-record-title">WIN RECORD</span>
        <span className="win-record-subtitle">Loading…</span>
      </div>
    );
  }

  const totalCounted = record.wins + record.losses;
  const winRate =
    totalCounted > 0 ? Math.round((record.wins / totalCounted) * 1000) / 10 : null;

  const empty = totalCounted === 0;
  const streakClass =
    record.currentStreak > 0
      ? "streak-positive"
      : record.currentStreak < 0
      ? "streak-negative"
      : "streak-neutral";

  return (
    <div className="win-record-card">
      <div className="win-record-header">
        <span className="win-record-title">WIN RECORD</span>
        <span className="win-record-subtitle">Across all games</span>
      </div>

      <div className="win-record-hero">
        <div className="win-record-streak-block">
          <span className={`win-record-streak ${streakClass}`}>
            {formatStreak(record.currentStreak)}
            {tierIcon(record.currentStreak)}
          </span>
          <span className="win-record-streak-label">
            {empty
              ? "Win your first game to start a streak"
              : record.currentStreak > 0
              ? "current win streak"
              : record.currentStreak < 0
              ? "current loss streak"
              : "no active streak"}
          </span>
        </div>
        {!empty && (
          <div className="win-record-totals">
            <div className="win-record-counts">
              <span className="win-record-w">{record.wins}W</span>
              <span className="win-record-divider">·</span>
              <span className="win-record-l">{record.losses}L</span>
              {winRate !== null ? (
                <span className="win-record-rate">{winRate}%</span>
              ) : null}
            </div>
            <div className="win-record-best">
              Best: {formatStreak(record.bestStreak)}
            </div>
          </div>
        )}
      </div>

      {byMode && byMode.length > 0 && (
        <div className="win-record-modes" role="table" aria-label="Win record by mode">
          <div className="win-record-modes-head" role="row">
            <span role="columnheader">Mode</span>
            <span role="columnheader">W</span>
            <span role="columnheader">L</span>
            <span role="columnheader">Win rate</span>
          </div>
          {byMode.map((m) => (
            <div className="win-record-modes-row" role="row" key={m.gameMode}>
              <span role="cell" className="win-record-mode-name">
                {getGameModeName(m.gameMode as GameMode)}
              </span>
              <span role="cell" className="win-record-w">{m.wins}</span>
              <span role="cell" className="win-record-l">{m.losses}</span>
              <span role="cell">{m.winRate === null ? "—" : `${m.winRate}%`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
