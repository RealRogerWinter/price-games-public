import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { userGetHistory, userGetStats, userGetMonthlyPoints, userGetScoreHistory } from "../api/userClient";
import RechartsAreaChart from "./charts/RechartsAreaChart";
import RechartsBarChart from "./charts/RechartsBarChart";
import KpiCard from "./charts/KpiCard";
import GiveawayModal from "./GiveawayModal";
import type { GameHistoryEntry, UserStats, UserScoreHistoryDay, PromoBanner } from "@price-game/shared";
import { GAME_MODES } from "@price-game/shared";

const PAGE_SIZE = 10;

/**
 * The viewer's IANA timezone, resolved once at module load. Passed to
 * `userGetScoreHistory` so score-per-day buckets match the adjacent
 * game-history table (rendered via toLocaleDateString in browser-local).
 */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Map of game mode slug to display name. */
const MODE_LABEL_MAP: Record<string, string> = {};
for (const m of GAME_MODES) {
  MODE_LABEL_MAP[m.mode] = m.name;
}

/**
 * Comprehensive game history panel with stats, charts, filtering, and paginated table.
 * Displayed on the scoreboard page with stats, charts, and game history table.
 */
export default function GameHistoryPanel() {
  const navigate = useNavigate();

  // Stats data
  const [stats, setStats] = useState<UserStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Monthly progress
  const [monthlyPoints, setMonthlyPoints] = useState<{ points: number; gamesPlayed: number } | null>(null);
  const [banner, setBanner] = useState<PromoBanner | null>(null);
  const [showGiveawayModal, setShowGiveawayModal] = useState(false);

  // Score history chart
  const [scoreHistory, setScoreHistory] = useState<UserScoreHistoryDay[]>([]);
  const [chartDays, setChartDays] = useState(30);
  const [chartLoading, setChartLoading] = useState(true);

  // Filters
  const [typeFilter, setTypeFilter] = useState<"" | "single" | "multiplayer">("");
  const [modeFilter, setModeFilter] = useState<string>("");

  // History table
  const [history, setHistory] = useState<GameHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Fetch stats + monthly points + banner on mount
  useEffect(() => {
    setStatsLoading(true);
    Promise.all([
      userGetStats(),
      userGetMonthlyPoints().catch(() => null),
      fetch("/api/settings/banner").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([statsData, monthly, bannerData]) => {
      setStats(statsData);
      if (monthly) setMonthlyPoints(monthly);
      if (bannerData) setBanner(bannerData);
    }).catch(() => {
      // stats fetch failed
    }).finally(() => setStatsLoading(false));
  }, []);

  // Fetch score history when chartDays changes
  useEffect(() => {
    setChartLoading(true);
    userGetScoreHistory(chartDays, BROWSER_TIMEZONE)
      .then((data) => setScoreHistory(data.history))
      .catch(() => setScoreHistory([]))
      .finally(() => setChartLoading(false));
  }, [chartDays]);

  // Fetch history table when filters/page change
  const fetchHistory = useCallback(async (page: number, type: string, mode: string) => {
    setHistoryLoading(true);
    try {
      const res = await userGetHistory(
        PAGE_SIZE,
        page * PAGE_SIZE,
        type || undefined,
        mode || undefined,
      );
      setHistory(res.entries);
      setHistoryTotal(res.total);
    } catch {
      // silently fail
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory(historyPage, typeFilter, modeFilter);
  }, [historyPage, typeFilter, modeFilter, fetchHistory]);

  // Reset page when filters change
  function handleTypeFilter(type: "" | "single" | "multiplayer") {
    setTypeFilter(type);
    setHistoryPage(0);
  }

  function handleModeFilter(mode: string) {
    // Toggle: if already selected, clear it
    setModeFilter((prev) => (prev === mode ? "" : mode));
    setHistoryPage(0);
  }

  function handleBarClick(label: string) {
    // Find the mode slug from the display label
    const entry = GAME_MODES.find((m) => m.name === label);
    if (entry) {
      handleModeFilter(entry.mode);
    }
  }

  const totalPages = Math.ceil(historyTotal / PAGE_SIZE);
  const monthName = MONTH_NAMES[new Date().getMonth()];

  // Build chart data
  const areaChartData = scoreHistory.map((d) => ({
    label: d.date.slice(5), // "MM-DD"
    value: d.totalScore,
  }));

  // Build games-by-mode bar chart data sorted descending
  const modeBarData = stats
    ? Object.entries(stats.gamesByMode)
        .map(([mode, count]) => ({
          label: MODE_LABEL_MAP[mode] || mode,
          value: count,
        }))
        .sort((a, b) => b.value - a.value)
    : [];

  // Selected labels for bar chart highlighting
  const selectedBarLabels = modeFilter ? [MODE_LABEL_MAP[modeFilter] || modeFilter] : [];

  // Monthly goal progress
  const giveawayGoal = banner?.giveawayMinPoints ?? 0;
  const monthlyPts = monthlyPoints?.points ?? 0;
  const goalPct = giveawayGoal > 0 ? Math.min((monthlyPts / giveawayGoal) * 100, 100) : 0;
  const qualified = monthlyPts >= giveawayGoal && giveawayGoal > 0;
  const qualifiedMsg = qualified
    ? (banner?.qualifiedMessage || "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries.")
        .replace(/\{month\}/g, monthName)
    : "";

  return (
    <div className="gh-panel">
      <h3 className="profile-section-title">Game History</h3>

      {/* Monthly Goal Progress */}
      {giveawayGoal > 0 && monthlyPoints && (
        <div className={`gh-goal-card ${qualified ? "gh-goal-qualified" : ""}`}>
          <div className="gh-goal-header">
            <span className="gh-goal-title">{monthName} Giveaway Progress</span>
            {qualified ? (
              <span className="gh-goal-badge">Qualified</span>
            ) : (
              <span className="gh-goal-remaining">
                {(giveawayGoal - monthlyPts).toLocaleString()} pts to go
              </span>
            )}
          </div>
          <div className="gh-goal-bar-bg">
            <div
              className={`gh-goal-bar-fill ${qualified ? "gh-goal-bar-qualified" : ""}`}
              style={{ width: `${goalPct}%` }}
            />
          </div>
          <div className="gh-goal-stats">
            <span>{monthlyPts.toLocaleString()} / {giveawayGoal.toLocaleString()} pts</span>
            <span>
              {monthlyPoints.gamesPlayed} game{monthlyPoints.gamesPlayed !== 1 ? "s" : ""} this month
              {" · "}
              <button className="gh-goal-details-link" onClick={() => setShowGiveawayModal(true)}>
                Giveaway Details
              </button>
            </span>
          </div>
          {qualified && (
            <div className="gh-goal-referral">
              {qualifiedMsg}{" "}
              <a href="/settings#referrals">Share your link</a>
            </div>
          )}
        </div>
      )}

      {/* KPI Cards */}
      {statsLoading ? (
        <div className="gh-loading">Loading stats...</div>
      ) : stats ? (
        <div className="gh-kpi-grid">
          <KpiCard value={stats.totalGames.toLocaleString()} label="Total Games" />
          <KpiCard value={stats.averageScore.toLocaleString()} label="Avg Score" />
          <KpiCard value={stats.bestScore.toLocaleString()} label="Best Score" />
          <KpiCard value={stats.multiplayerWins.toLocaleString()} label="MP Wins" />
        </div>
      ) : null}

      {/* Daily Points Chart (sum of scores earned per day) */}
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

      {/* Games by Mode Chart */}
      {modeBarData.length > 0 && (
        <div className="gh-chart-section">
          <div className="gh-chart-header">
            <span className="gh-chart-title">Games by Mode</span>
            {modeFilter && (
              <button
                className="gh-filter-reset"
                onClick={() => handleModeFilter(modeFilter)}
              >
                Clear filter
              </button>
            )}
          </div>
          <RechartsBarChart
            data={modeBarData}
            color="#4a9eff"
            onBarClick={handleBarClick}
            selectedLabels={selectedBarLabels}
          />
        </div>
      )}

      {/* Filters */}
      <div className="gh-filters">
        <div className="gh-type-toggle">
          {(["", "single", "multiplayer"] as const).map((t) => (
            <button
              key={t}
              className={`gh-type-btn ${typeFilter === t ? "gh-type-btn-active" : ""}`}
              onClick={() => handleTypeFilter(t)}
            >
              {t === "" ? "All" : t === "single" ? "Single Player" : "Multiplayer"}
            </button>
          ))}
        </div>
        {modeFilter && (
          <div className="gh-active-filter">
            <span className="gh-filter-chip">
              {MODE_LABEL_MAP[modeFilter] || modeFilter}
              <button className="gh-filter-chip-x" onClick={() => handleModeFilter(modeFilter)}>
                &times;
              </button>
            </span>
          </div>
        )}
      </div>

      {/* History Table */}
      {historyLoading ? (
        <div className="gh-loading">Loading...</div>
      ) : history.length === 0 ? (
        <p className="profile-empty">
          {typeFilter || modeFilter ? "No games match the selected filters." : "No games played yet."}
        </p>
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
                // Every row links to `/recap/:historyId`; the server either
                // serves the cached shared_games row or synthesizes one on
                // first click (lazy memoization for legacy rows). See
                // `GET /api/user/history/:historyId/recap`.
                const recapPath = `/recap/${entry.id}`;
                return (
                  <tr
                    key={entry.id}
                    className="gh-row gh-row-clickable"
                    onClick={() => navigate(recapPath)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(recapPath);
                      }
                    }}
                    role="link"
                    tabIndex={0}
                    aria-label={`View recap for ${MODE_LABEL_MAP[entry.gameMode] || entry.gameMode} game on ${new Date(entry.playedAt).toLocaleDateString()}`}
                  >
                    <td>
                      <span className="gh-mode-tag">{MODE_LABEL_MAP[entry.gameMode] || entry.gameMode}</span>
                    </td>
                    <td>
                      <span className={`gh-type-tag gh-type-${entry.gameType}`}>
                        {entry.gameType === "single" ? "SP" : "MP"}
                      </span>
                    </td>
                    <td className="gh-score">{entry.score.toLocaleString()}</td>
                    <td>
                      {entry.gameType === "multiplayer" && entry.placement != null ? (
                        <span className={`gh-placement ${entry.placement === 1 ? "gh-placement-1st" : ""}`}>
                          #{entry.placement}/{entry.playersCount}
                        </span>
                      ) : (
                        <span className="gh-result-dash">&mdash;</span>
                      )}
                    </td>
                    <td className="gh-date">
                      {new Date(entry.playedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
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
      {/* User is already authenticated on the scoreboard page, so the sign-up CTA is never visible.
         onOpenRegister just closes the modal as a safe fallback. */}
      {showGiveawayModal && (
        <GiveawayModal
          banner={banner}
          onClose={() => setShowGiveawayModal(false)}
          onOpenRegister={() => setShowGiveawayModal(false)}
        />
      )}
    </div>
  );
}
