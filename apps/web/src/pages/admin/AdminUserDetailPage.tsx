import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getAdminUser,
  updateAdminUser,
  deactivateAdminUser,
  reactivateAdminUser,
  deleteAdminUser,
  resetAdminUserPassword,
  getAdminUserGameHistory,
  getAdminUserStats,
  getAdminUserActivity,
} from "../../api/adminClient";
import { AreaChart, KpiCard } from "../../components/charts";
import AvatarIcon from "../../components/multiplayer/AvatarIcon";
import type {
  AdminUserDetail,
  UserStats,
  AdminUserGameHistoryResponse,
  AdminUserActivityDay,
} from "@price-game/shared";
import { ADMIN_TIMEZONE } from "@price-game/shared";

/**
 * Admin user detail page. Shows user profile, stats, game history, and
 * activity chart. Allows editing profile, deactivating/reactivating,
 * deleting, and resetting passwords.
 */
export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [history, setHistory] = useState<AdminUserGameHistoryResponse | null>(null);
  const [activity, setActivity] = useState<AdminUserActivityDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);

  const fetchUser = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);
      const [u, s, h, a] = await Promise.all([
        getAdminUser(id),
        getAdminUserStats(id),
        getAdminUserGameHistory(id, historyPage, 20),
        getAdminUserActivity(id, 30, ADMIN_TIMEZONE),
      ]);
      setUser(u);
      setStats(s);
      setHistory(h);
      setActivity(a);
      setEditUsername(u.username);
      setEditEmail(u.email);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load user");
    } finally {
      setLoading(false);
    }
  }, [id, historyPage]);

  useEffect(() => {
    setLoading(true);
    fetchUser();
  }, [fetchUser]);

  async function handleSave() {
    if (!id) return;
    setActionError(null);
    try {
      const updated = await updateAdminUser(id, {
        username: editUsername,
        email: editEmail,
      });
      setUser(updated);
      setEditing(false);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to save changes");
    }
  }

  async function handleDeactivate() {
    if (!id) return;
    setActionError(null);
    try {
      const updated = await deactivateAdminUser(id);
      setUser(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to deactivate user");
    }
  }

  async function handleReactivate() {
    if (!id) return;
    setActionError(null);
    try {
      const updated = await reactivateAdminUser(id);
      setUser(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to reactivate user");
    }
  }

  async function handleDelete() {
    if (!id) return;
    setActionError(null);
    try {
      await deleteAdminUser(id);
      navigate("/admin/users");
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  async function handleResetPassword() {
    if (!id) return;
    setActionError(null);
    try {
      const result = await resetAdminUserPassword(id);
      setTempPassword(result.temporaryPassword);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to reset password");
    }
  }

  if (loading) {
    return (
      <div className="admin-loading" data-testid="admin-user-loading">
        <span className="admin-loading-spinner" />
        Loading user...
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-dashboard" data-testid="admin-user-error">
        <div className="admin-header"><h1>User Detail</h1></div>
        <div className="admin-error">{error}</div>
        <button onClick={() => navigate("/admin/users")} style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}>
          Back to Users
        </button>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="admin-dashboard" data-testid="user-detail-page">
      {/* Back button */}
      <button
        onClick={() => navigate("/admin/users")}
        style={{ color: "#4a9eff", background: "none", border: "none", cursor: "pointer", marginBottom: 16 }}
      >
        &larr; Back to Users
      </button>

      {/* Profile Card */}
      <div className="admin-section" data-testid="user-profile-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          {user.avatar && (
            <div style={{ flexShrink: 0 }}>
              <AvatarIcon avatar={user.avatar} size={72} />
            </div>
          )}
          <div style={{ flex: 1 }}>
            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  data-testid="edit-username"
                  style={{ padding: "6px 10px", background: "#16213e", border: "1px solid #2a2a4a", color: "#e0e0e0", borderRadius: 4 }}
                />
                <input
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  data-testid="edit-email"
                  style={{ padding: "6px 10px", background: "#16213e", border: "1px solid #2a2a4a", color: "#e0e0e0", borderRadius: 4 }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleSave}
                    data-testid="btn-save-user"
                    className="admin-btn admin-btn-primary"
                    style={{ padding: "6px 12px" }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setEditing(false); setEditUsername(user.username); setEditEmail(user.email); }}
                    style={{ padding: "6px 12px" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0 }}>{user.username}</h2>
                <p style={{ color: "#aaa", margin: "4px 0" }}>{user.email}</p>
                <p style={{ color: "#666", margin: "4px 0", fontSize: 13 }}>
                  Joined {new Date(user.createdAt).toLocaleDateString("en-US", { timeZone: ADMIN_TIMEZONE })}
                  {user.lastLoginAt && ` | Last login ${new Date(user.lastLoginAt).toLocaleDateString("en-US", { timeZone: ADMIN_TIMEZONE })}`}
                </p>
                <span className={`status-badge ${user.isActive ? "status-completed" : "status-abandoned"}`}>
                  {user.isActive ? "Active" : "Inactive"}
                </span>
                {user.emailVerified && <span className="status-badge status-completed" style={{ marginLeft: 8 }}>Email Verified</span>}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                data-testid="btn-edit-user"
                className="admin-btn"
                style={{ padding: "6px 12px" }}
              >
                Edit
              </button>
            )}
            {user.isActive ? (
              <button onClick={handleDeactivate} data-testid="btn-deactivate" className="admin-btn admin-btn-warning" style={{ padding: "6px 12px" }}>
                Deactivate
              </button>
            ) : (
              <button onClick={handleReactivate} data-testid="btn-reactivate" className="admin-btn admin-btn-success" style={{ padding: "6px 12px" }}>
                Reactivate
              </button>
            )}
            <button onClick={handleResetPassword} data-testid="btn-reset-password" className="admin-btn" style={{ padding: "6px 12px" }}>
              Reset Password
            </button>
            {confirmingDelete ? (
              <button onClick={handleDelete} data-testid="btn-confirm-delete" className="admin-btn admin-btn-danger" style={{ padding: "6px 12px" }}>
                Confirm Delete
              </button>
            ) : (
              <button onClick={() => setConfirmingDelete(true)} data-testid="btn-delete-user" className="admin-btn admin-btn-danger" style={{ padding: "6px 12px" }}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Action error display */}
      {actionError && (
        <div className="admin-error" data-testid="action-error" style={{ marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      {/* Temp password display */}
      {tempPassword && (
        <div className="admin-section" data-testid="temp-password-display" style={{ background: "#1a3a1a", border: "1px solid #2ed573", padding: 16, borderRadius: 8 }}>
          <strong>Temporary Password:</strong>{" "}
          <code style={{ color: "#2ed573", fontSize: 16, userSelect: "all" }}>{tempPassword}</code>
          <p style={{ color: "#aaa", fontSize: 12, marginTop: 8 }}>
            Copy this password now — it will not be shown again.
          </p>
          <button onClick={() => setTempPassword(null)} style={{ padding: "4px 8px", marginTop: 8 }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Stats KPI Cards */}
      {stats && (
        <div className="admin-kpi-grid" data-testid="user-stats-grid">
          <KpiCard value={stats.totalGames.toLocaleString()} label="Total Games" />
          <KpiCard value={stats.bestScore.toLocaleString()} label="Best Score" />
          <KpiCard value={stats.averageScore.toLocaleString()} label="Avg Score" />
          <KpiCard value={user.lifetimeScore.toLocaleString()} label="Lifetime Score" />
          <KpiCard value={String(stats.multiplayerWins)} label="MP Wins" />
        </div>
      )}

      {/* Activity Chart */}
      {activity.length > 0 && (
        <div className="admin-section" data-testid="user-activity-chart">
          <h2>Activity (Last 30 Days)</h2>
          <AreaChart
            data={activity.map((d) => ({ label: d.date, value: d.gamesPlayed }))}
            height={180}
            color="#4a9eff"
          />
        </div>
      )}

      {/* Game History */}
      <div className="admin-section" data-testid="user-game-history">
        <h2>Game History</h2>
        {history && history.history.length === 0 ? (
          <p style={{ color: "#666" }}>No games played</p>
        ) : history && (
          <>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Mode</th>
                  <th>Score</th>
                  <th>Placement</th>
                  <th>Players</th>
                  <th>Played At</th>
                </tr>
              </thead>
              <tbody>
                {history.history.map((g) => (
                  <tr key={g.id}>
                    <td>{g.gameType === "single" ? "SP" : "MP"}</td>
                    <td>{g.gameMode}</td>
                    <td>{g.score.toLocaleString()}</td>
                    <td>{g.placement ?? "-"}</td>
                    <td>{g.playersCount ?? "-"}</td>
                    <td>{new Date(g.playedAt).toLocaleString("en-US", { timeZone: ADMIN_TIMEZONE })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {history.totalPages > 1 && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
                <button disabled={historyPage <= 1} onClick={() => setHistoryPage(historyPage - 1)}>Prev</button>
                <span style={{ color: "#e0e0e0", lineHeight: "32px" }}>Page {historyPage} of {history.totalPages}</span>
                <button disabled={historyPage >= history.totalPages} onClick={() => setHistoryPage(historyPage + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
