import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  getAdminUsers,
  deactivateAdminUser,
  reactivateAdminUser,
  deleteAdminUser,
} from "../../api/adminClient";
import type { AdminUserSummary } from "@price-game/shared";
import AvatarIcon from "../../components/multiplayer/AvatarIcon";

/**
 * Admin user management list page. Displays a searchable, filterable,
 * paginated table of users with actions for deactivate/reactivate and delete.
 */
export default function AdminUsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterActive, setFilterActive] = useState<"all" | "true" | "false">("all");
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pageSize = 50;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const params: Record<string, unknown> = {
        page,
        pageSize,
        sortBy,
        sortOrder,
      };
      if (debouncedSearch) params.search = debouncedSearch;
      if (filterActive !== "all") params.isActive = filterActive === "true";
      const result = await getAdminUsers(params as Parameters<typeof getAdminUsers>[0]);
      setUsers(result.users);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, debouncedSearch, filterActive, sortBy, sortOrder]);

  useEffect(() => {
    setLoading(true);
    fetchUsers();
  }, [fetchUsers]);

  function handleSort(col: string) {
    if (sortBy === col) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortOrder("asc");
    }
    setPage(1);
  }

  async function handleDeactivate(id: string) {
    try {
      await deactivateAdminUser(id);
      fetchUsers();
    } catch {
      // Silently handle
    }
  }

  async function handleReactivate(id: string) {
    try {
      await reactivateAdminUser(id);
      fetchUsers();
    } catch {
      // Silently handle
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteAdminUser(id);
      setConfirmDelete(null);
      fetchUsers();
    } catch {
      // Silently handle
    }
  }

  if (loading && users.length === 0) {
    return (
      <div className="admin-loading" data-testid="admin-users-loading">
        <span className="admin-loading-spinner" />
        Loading users...
      </div>
    );
  }

  if (error && users.length === 0) {
    return (
      <div className="admin-dashboard" data-testid="admin-users-error">
        <div className="admin-header"><h1>User Management</h1></div>
        <div className="admin-error">{error}</div>
        <button onClick={() => { setLoading(true); fetchUsers(); }} style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="admin-dashboard" data-testid="admin-users-page">
      <div className="admin-dashboard-header">
        <h1>User Management</h1>
        <span style={{ color: "#666", fontSize: 14 }}>{total} total users</span>
      </div>

      {/* Search and Filter Controls */}
      <div className="admin-controls" style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search by username or email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="admin-search-input"
          data-testid="users-search-input"
          style={{ flex: 1, padding: "8px 12px", background: "#16213e", border: "1px solid #2a2a4a", color: "#e0e0e0", borderRadius: 4 }}
        />
        <select
          value={filterActive}
          onChange={(e) => { setFilterActive(e.target.value as "all" | "true" | "false"); setPage(1); }}
          data-testid="users-filter-active"
          style={{ padding: "8px 12px", background: "#16213e", border: "1px solid #2a2a4a", color: "#e0e0e0", borderRadius: 4 }}
        >
          <option value="all">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>

      {users.length === 0 ? (
        <p style={{ color: "#666", textAlign: "center", padding: 24 }}>No users found</p>
      ) : (
        <>
          <div className="admin-table-wrap">
          <table className="admin-table admin-table-sticky-first" data-testid="admin-users-table">
            <thead>
              <tr>
                <th onClick={() => handleSort("username")} style={{ cursor: "pointer" }}>
                  Username {sortBy === "username" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th onClick={() => handleSort("email")} style={{ cursor: "pointer" }}>
                  Email {sortBy === "email" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th>Status</th>
                <th onClick={() => handleSort("lifetime_score")} style={{ cursor: "pointer" }}>
                  Score {sortBy === "lifetime_score" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th>Games</th>
                <th
                  onClick={() => handleSort("referrals")}
                  style={{ cursor: "pointer" }}
                  data-testid="users-th-referrals"
                  title="Credited / total referrals"
                >
                  Referrals {sortBy === "referrals" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th onClick={() => handleSort("created_at")} style={{ cursor: "pointer" }}>
                  Joined {sortBy === "created_at" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th onClick={() => handleSort("last_login_at")} style={{ cursor: "pointer" }}>
                  Last Login {sortBy === "last_login_at" ? (sortOrder === "asc" ? "\u25B2" : "\u25BC") : ""}
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <button
                      className="admin-link-btn admin-user-cell"
                      onClick={() => navigate(`/admin/users/${u.id}`)}
                      style={{ color: "#4a9eff", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: 8 }}
                    >
                      {u.avatar && <AvatarIcon avatar={u.avatar} size={24} />}
                      <span>{u.username}</span>
                    </button>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <span className={`status-badge ${u.isActive ? "status-completed" : "status-abandoned"}`}>
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{u.lifetimeScore.toLocaleString()}</td>
                  <td>{u.totalGames}</td>
                  <td data-testid={`referrals-cell-${u.id}`} title="Credited / total">
                    <strong>{u.creditedReferrals}</strong>
                    <span style={{ color: "#666" }}> / {u.totalReferrals}</span>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      {u.isActive ? (
                        <button
                          className="admin-btn admin-btn-warning"
                          onClick={() => handleDeactivate(u.id)}
                          data-testid={`deactivate-${u.id}`}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          className="admin-btn admin-btn-success"
                          onClick={() => handleReactivate(u.id)}
                          data-testid={`reactivate-${u.id}`}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          Reactivate
                        </button>
                      )}
                      {confirmDelete === u.id ? (
                        <button
                          className="admin-btn admin-btn-danger"
                          onClick={() => handleDelete(u.id)}
                          data-testid={`confirm-delete-${u.id}`}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          Confirm
                        </button>
                      ) : (
                        <button
                          className="admin-btn admin-btn-danger-outline"
                          onClick={() => setConfirmDelete(u.id)}
                          data-testid={`delete-${u.id}`}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="admin-pagination" data-testid="users-pagination" style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "center" }}>
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                style={{ padding: "6px 12px", cursor: page <= 1 ? "not-allowed" : "pointer" }}
              >
                Prev
              </button>
              <span style={{ color: "#e0e0e0", lineHeight: "32px" }}>
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                style={{ padding: "6px 12px", cursor: page >= totalPages ? "not-allowed" : "pointer" }}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
