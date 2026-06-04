/**
 * Stats section showing total plays, unique players, and top streaks.
 * Extracted from the original AdminDailyModePage for reuse.
 */

import type { AdminDailyStatsResponse } from "@price-game/shared";

interface DailyStatsSectionProps {
  stats: AdminDailyStatsResponse;
}

/**
 * Renders aggregate daily challenge stats: total plays, unique players,
 * and a top streaks leaderboard.
 */
export default function DailyStatsSection({ stats }: DailyStatsSectionProps) {
  return (
    <section className="admin-section">
      <h3>Stats</h3>
      <div className="daily-stats-cards">
        <div className="daily-stat-card">
          <div className="daily-stat-value">{stats.totalPlays.toLocaleString()}</div>
          <div className="daily-stat-label">Total Plays</div>
        </div>
        <div className="daily-stat-card">
          <div className="daily-stat-value">{stats.uniquePlayers.toLocaleString()}</div>
          <div className="daily-stat-label">Unique Players</div>
        </div>
      </div>

      {stats.topStreaks.length > 0 && (
        <>
          <h4>Top Streaks</h4>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Current</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>
              {stats.topStreaks.map((s) => (
                <tr key={s.username}>
                  <td>{s.username}</td>
                  <td>{s.currentStreak}</td>
                  <td>{s.bestStreak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
