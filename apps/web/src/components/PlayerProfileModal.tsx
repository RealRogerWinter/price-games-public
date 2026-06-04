import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { PublicPlayerProfile, UserScoreHistoryDay, PublicGameHistoryEntry } from "@price-game/shared";
import { getPublicProfile, getPublicScoreHistory, getPublicGameHistory } from "../api/client";
import { GAME_MODES } from "@price-game/shared";
import RechartsAreaChart from "./charts/RechartsAreaChart";
import RechartsBarChart from "./charts/RechartsBarChart";
import KpiCard from "./charts/KpiCard";
import AvatarIcon from "./multiplayer/AvatarIcon";

const MODE_LABEL_MAP: Record<string, string> = {};
for (const m of GAME_MODES) {
  MODE_LABEL_MAP[m.mode] = m.name;
}

const HISTORY_PAGE_SIZE = 10;

/**
 * The viewer's IANA timezone, resolved once at module load. Used when
 * fetching per-user charts so bucket labels match the adjacent list
 * (which renders playedAt via toLocaleDateString in browser-local time).
 */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface PlayerProfileModalProps {
  username: string;
  onClose: () => void;
}

/**
 * Modal displaying a public player profile with stats, charts, and game history.
 *
 * @param username - The player's username to display.
 * @param onClose - Callback when the modal is closed.
 */
export default function PlayerProfileModal({ username, onClose }: PlayerProfileModalProps) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<PublicPlayerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Score history chart
  const [scoreHistory, setScoreHistory] = useState<UserScoreHistoryDay[]>([]);
  const [chartDays, setChartDays] = useState(30);
  const [chartLoading, setChartLoading] = useState(true);

  // Game history table
  const [history, setHistory] = useState<PublicGameHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Fetch profile on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);

    getPublicProfile(username)
      .then((data) => {
        if (!cancelled) setProfile(data.profile);
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof Error && err.message.includes("404")) {
            setNotFound(true);
          } else {
            setError("Failed to load profile.");
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [username]);

  // Fetch score history when chartDays changes
  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    getPublicScoreHistory(username, chartDays, BROWSER_TIMEZONE)
      .then((data) => { if (!cancelled) setScoreHistory(data.history); })
      .catch(() => { if (!cancelled) setScoreHistory([]); })
      .finally(() => { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [username, chartDays]);

  // Fetch game history when page changes
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    getPublicGameHistory(username, HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE, BROWSER_TIMEZONE)
      .then((data) => {
        if (!cancelled) {
          setHistory(data.entries);
          setHistoryTotal(data.total);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistory([]);
          setHistoryTotal(0);
        }
      })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [username, historyPage]);

  const totalPages = Math.ceil(historyTotal / HISTORY_PAGE_SIZE);

  const areaChartData = scoreHistory.map((d) => ({
    label: d.date.slice(5),
    value: d.totalScore,
  }));

  const modeBarData = profile
    ? Object.entries(profile.gamesByMode)
        .map(([mode, count]) => ({
          label: MODE_LABEL_MAP[mode] || mode,
          value: count,
        }))
        .sort((a, b) => b.value - a.value)
    : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content player-profile-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          &times;
        </button>

        {loading && <div className="loading">Loading profile...</div>}

        {notFound && (
          <div className="profile-not-found">
            <p>Player not found.</p>
          </div>
        )}

        {error && <p className="error-message">{error}</p>}

        {!loading && !error && !notFound && profile && (
          <>
            <div className="profile-modal-header">
              {profile.avatar && (
                <div className="profile-modal-avatar">
                  <AvatarIcon avatar={profile.avatar} size={72} />
                </div>
              )}
              <h2 className="profile-modal-username">{profile.username}</h2>
              <span className="profile-modal-since">
                Member since {profile.memberSince}
              </span>
              <div className="profile-modal-score">
                <span className="profile-modal-score-label">Lifetime Score</span>
                <span className="profile-modal-score-value">
                  {profile.lifetimeScore.toLocaleString()}
                </span>
              </div>
            </div>

            {profile.winRecord ? (
              <ProfileWinRecordStrip record={profile.winRecord} />
            ) : null}

            <div className="gh-kpi-grid">
              <KpiCard
                value={profile.totalGames.toLocaleString()}
                label="Total Games"
              />
              <KpiCard
                value={profile.averageScore.toLocaleString()}
                label="Avg Score"
              />
              <KpiCard
                value={profile.bestScore.toLocaleString()}
                label="Best Score"
              />
              <KpiCard
                value={profile.multiplayerWins.toLocaleString()}
                label="MP Wins"
              />
            </div>

            <div className="gh-chart-section">
              <div className="gh-chart-header">
                <span className="gh-chart-title">Daily Points</span>
                <div className="gh-range-btns">
                  {[7, 30, 90].map((d) => (
                    <button
                      key={d}
                      className={`gh-range-btn ${chartDays === d ? "gh-range-btn-active" : ""}`}
                      onClick={() => setChartDays(d)}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
              {chartLoading ? (
                <div className="gh-loading">Loading chart...</div>
              ) : (
                <RechartsAreaChart
                  data={areaChartData}
                  height={180}
                  color="#4ecca3"
                  formatValue={(v) => v.toLocaleString()}
                  valueLabel="Score"
                />
              )}
            </div>

            {modeBarData.length > 0 && (
              <div className="gh-chart-section">
                <div className="gh-chart-header">
                  <span className="gh-chart-title">Most Played Modes</span>
                </div>
                <RechartsBarChart data={modeBarData} color="#4a9eff" />
              </div>
            )}

            <div className="gh-chart-section">
              <div className="gh-chart-header">
                <span className="gh-chart-title">Game History</span>
              </div>
              {historyLoading ? (
                <div className="gh-loading">Loading...</div>
              ) : history.length === 0 ? (
                <p className="profile-empty">No games played yet.</p>
              ) : (
                <>
                  <table className="game-history-table">
                    <thead>
                      <tr>
                        <th>Mode</th>
                        <th>Type</th>
                        <th>Score</th>
                        <th>Result</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((entry) => {
                        // PR3 sec H1: public profile links route via the
                        // opaque shareId (`/s/:shareId`) so the IDOR-prone
                        // sequential `/recap/:historyId` route stays
                        // private to the row's owner. Legacy rows without
                        // a share_id render as non-clickable until the
                        // cold-path stamp catches up.
                        const recapPath = entry.shareId ? `/s/${entry.shareId}` : null;
                        const clickable = recapPath !== null;
                        return (
                          <tr
                            key={entry.id}
                            className={`gh-row${clickable ? " gh-row-clickable" : ""}`}
                            onClick={clickable ? () => navigate(recapPath!) : undefined}
                            onKeyDown={clickable ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                navigate(recapPath!);
                              }
                            } : undefined}
                            role={clickable ? "link" : undefined}
                            tabIndex={clickable ? 0 : undefined}
                            aria-label={clickable ? `View recap for ${MODE_LABEL_MAP[entry.gameMode] || entry.gameMode} game on ${entry.playedDate}` : undefined}
                          >
                            <td>
                              <span className="gh-mode-tag">
                                {MODE_LABEL_MAP[entry.gameMode] || entry.gameMode}
                              </span>
                            </td>
                            <td>
                              <span
                                className={`gh-type-tag gh-type-${entry.gameType}`}
                              >
                                {entry.gameType === "single" ? "SP" : "MP"}
                              </span>
                            </td>
                            <td className="gh-score">
                              {entry.score.toLocaleString()}
                            </td>
                            <td>
                              {entry.gameType === "multiplayer" &&
                              entry.placement != null ? (
                                <span
                                  className={`gh-placement ${entry.placement === 1 ? "gh-placement-1st" : ""}`}
                                >
                                  #{entry.placement}/{entry.playersCount}
                                </span>
                              ) : (
                                <span className="gh-result-dash">&mdash;</span>
                              )}
                            </td>
                            <td className="gh-date">
                              {entry.playedDate}
                              {clickable && (
                                <span className="gh-view-icon" aria-label="View breakdown">
                                  &#8250;
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {totalPages > 1 && (
                    <div className="profile-pagination">
                      <button
                        className="btn btn-secondary"
                        disabled={historyPage === 0}
                        onClick={() => setHistoryPage((p) => p - 1)}
                      >
                        Previous
                      </button>
                      <span className="profile-page-info">
                        Page {historyPage + 1} of {totalPages}
                      </span>
                      <button
                        className="btn btn-secondary"
                        disabled={historyPage >= totalPages - 1}
                        onClick={() => setHistoryPage((p) => p + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ProfileWinRecordStripProps {
  record: {
    wins: number;
    losses: number;
    currentStreak: number;
    bestStreak: number;
  };
}

/**
 * 3-cell horizontal strip rendered between the profile header and the
 * KPI grid. Surfaces the W/L/Streak summary without competing for one
 * of the four KPI slots — the signed streak number isn't peer to
 * unsigned counts like Best Score, so it gets its own row.
 */
function ProfileWinRecordStrip({ record }: ProfileWinRecordStripProps) {
  const totalCounted = record.wins + record.losses;
  const winRate =
    totalCounted > 0 ? Math.round((record.wins / totalCounted) * 1000) / 10 : null;
  const streakClass =
    record.currentStreak > 0
      ? "streak-positive"
      : record.currentStreak < 0
      ? "streak-negative"
      : "streak-neutral";
  const streakLabel = record.currentStreak === 0 ? "0" : formatStreakInline(record.currentStreak);

  return (
    <div className="profile-modal-record" role="group" aria-label="Win record">
      <div className="profile-modal-record-cell">
        <span className={`profile-modal-record-value ${streakClass}`}>
          {streakLabel}
          {tierIconInline(record.currentStreak)}
        </span>
        <span className="profile-modal-record-label">current</span>
      </div>
      <div className="profile-modal-record-cell">
        <span className="profile-modal-record-value">
          <span className="win-record-w">{record.wins}W</span>
          {" · "}
          <span className="win-record-l">{record.losses}L</span>
          {winRate !== null ? (
            <span className="profile-modal-record-rate"> · {winRate}%</span>
          ) : null}
        </span>
        <span className="profile-modal-record-label">record</span>
      </div>
      <div className="profile-modal-record-cell">
        <span className="profile-modal-record-value">
          {formatStreakInline(record.bestStreak)}
        </span>
        <span className="profile-modal-record-label">peak streak</span>
      </div>
    </div>
  );
}

function formatStreakInline(streak: number): string {
  if (streak === 0) return "0";
  return streak > 0 ? `+${streak}` : String(streak);
}

function tierIconInline(streak: number): string {
  if (streak >= 15) return " 💎";
  if (streak >= 7) return " ⚡";
  if (streak >= 3) return " 🔥";
  return "";
}
