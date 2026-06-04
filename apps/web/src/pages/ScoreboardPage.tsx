import { useEffect, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useUserAuth } from "../context/UserAuthContext";
import type { UserRankResponse, UserRankHistoryDay } from "@price-game/shared";
import { getUserRank, getRankHistory } from "../api/client";

/**
 * The viewer's IANA timezone, resolved once at module load. Passed to
 * `getRankHistory` so rank-per-day buckets match the adjacent scoreboard
 * tables and the game-history list rendered below the chart.
 */
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
import GameHistoryPanel from "../components/GameHistoryPanel";
import StreakCard from "../components/StreakCard";
import WinRecordCard from "../components/WinRecordCard";
import RankHistoryChart from "../components/RankHistoryChart";
import PageTopBar from "../components/PageTopBar";
import AvatarIcon from "../components/multiplayer/AvatarIcon";

/**
 * Scoreboard page displaying lifetime score, rank, streak, rank chart, and game history.
 * Redirects to home if the user is not authenticated.
 */
export default function ScoreboardPage() {
  const { user, isAuthenticated, loading: authLoading, refreshUser } = useUserAuth();
  const navigate = useNavigate();
  const [rankData, setRankData] = useState<UserRankResponse | null>(null);
  const [rankHistory, setRankHistory] = useState<UserRankHistoryDay[]>([]);
  const [rankDays, setRankDays] = useState(30);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/");
    }
  }, [authLoading, isAuthenticated, navigate]);

  // Refresh user data on mount to get up-to-date lifetime score
  useEffect(() => {
    if (isAuthenticated) {
      refreshUser();
    }
  }, [isAuthenticated, refreshUser]);

  // Fetch current rank + best rank
  useEffect(() => {
    if (!isAuthenticated) return;
    getUserRank()
      .then(setRankData)
      .catch(() => {});
  }, [isAuthenticated]);

  // Fetch rank history
  const loadRankHistory = useCallback((days: number) => {
    getRankHistory(days, BROWSER_TIMEZONE)
      .then((res) => setRankHistory(res.history))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    loadRankHistory(rankDays);
  }, [isAuthenticated, rankDays, loadRankHistory]);

  function handleRankDaysChange(days: number) {
    setRankDays(days);
  }

  if (authLoading) {
    return (
      <div className="profile-page">
        <p className="loading-text">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="profile-page">
      <PageTopBar />

      <div className="profile-header">
        <h1 className="profile-title">My Scores</h1>
      </div>

      <div className="profile-section">
        <StreakCard />
      </div>

      <div className="profile-section">
        <WinRecordCard />
      </div>

      <div className="profile-score-card profile-score-card-with-avatar">
        <div className="profile-score-avatar">
          <AvatarIcon avatar={user.avatar ?? "silhouette"} size={72} />
        </div>
        <div className="profile-score-text">
          <span className="profile-score-label">Lifetime Score</span>
          <span className="profile-score-value">{user.lifetimeScore.toLocaleString()}</span>
          <span className="profile-score-username">{user.username}</span>
        </div>
      </div>

      <div className="profile-section">
        <RankHistoryChart
          history={rankHistory}
          days={rankDays}
          onChangeDays={handleRankDaysChange}
        />
      </div>

      <div className="scoreboard-leaderboard-link">
        <Link to="/?view=leaderboard" className="btn btn-secondary scoreboard-lb-btn">
          View Leaderboard
        </Link>
        {rankData && (
          <span className="scoreboard-rank-info">
            <span className="scoreboard-rank-current">
              Current: <strong>#{rankData.rank}</strong> of {rankData.totalPlayers}
            </span>
            <span className="scoreboard-rank-best">
              All-Time Best: <strong>#{rankData.bestRank ?? rankData.rank}</strong>
            </span>
          </span>
        )}
      </div>

      <div className="profile-section">
        <GameHistoryPanel />
      </div>
    </div>
  );
}
