import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { GAME_MODES } from "@price-game/shared";
import {
  banLbUser,
  banLbUserHistory,
  bulkExcludeLbEntries,
  excludeLbEntry,
  getLbAuditLog,
  getLbBannedUsers,
  getLbEntries,
  getLbStats,
  getLbUserSummary,
  restoreLbEntry,
  setLbTestAccountFlag,
  unbanLbUser,
  type AdminLbAuditEntry,
  type AdminLbEntry,
  type AdminLbEntryFilters,
  type AdminLbStats,
  type AdminLbUserSummary,
} from "../../api/adminClient";
import "./admin.css";

type Tab = "entries" | "banned" | "audit";

const PAGE_SIZE = 50;

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case "exclude_entry":
      return "excluded entry";
    case "restore_entry":
      return "restored entry";
    case "ban_user":
      return "banned user";
    case "unban_user":
      return "unbanned user";
    case "set_test_flag":
      return "tagged test account";
    default:
      return action;
  }
}

/**
 * Admin moderation panel for the public leaderboard.
 *
 * Tabs: Entries (default), Banned Accounts, Audit Log. Filters and
 * pagination are URL-synced via `useSearchParams` so admins can share
 * deep links to the same query state. Player drilldowns open in a
 * right-side drawer (URL param `player=<userId>`).
 */
export default function AdminLeaderboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) || "entries";
  const drawerUser = searchParams.get("player");

  const [stats, setStats] = useState<AdminLbStats | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const triggerRefresh = useCallback(() => setRefreshSignal((n) => n + 1), []);

  useEffect(() => {
    let cancel = false;
    getLbStats()
      .then((data) => {
        if (!cancel) setStats(data);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [refreshSignal]);

  function setTab(next: Tab) {
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp);
  }

  return (
    <div className="admin-page admin-leaderboard">
      <div className="admin-page-header">
        <h1>Leaderboard moderation</h1>
        {stats && (
          <div className="admin-lb-stats">
            <Stat label="Entries" value={stats.totalEntries} />
            <Stat label="Excluded" value={stats.excludedEntries} tone="warn" />
            <Stat label="Banned users" value={stats.bannedUsers} tone="warn" />
            <Stat label="Test accounts" value={stats.testAccounts} />
          </div>
        )}
      </div>

      <nav className="admin-lb-tabs" role="tablist">
        <TabButton active={tab === "entries"} onClick={() => setTab("entries")}>
          Entries
        </TabButton>
        <TabButton active={tab === "banned"} onClick={() => setTab("banned")}>
          Banned accounts
        </TabButton>
        <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>
          Audit log
        </TabButton>
      </nav>

      {tab === "entries" && (
        <EntriesTab refreshSignal={refreshSignal} onAction={triggerRefresh} />
      )}
      {tab === "banned" && <BannedTab refreshSignal={refreshSignal} />}
      {tab === "audit" && <AuditTab refreshSignal={refreshSignal} />}

      {drawerUser && (
        <PlayerDrawer
          userId={drawerUser}
          onClose={() => {
            const sp = new URLSearchParams(searchParams);
            sp.delete("player");
            setSearchParams(sp);
          }}
          onAction={triggerRefresh}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div className={`admin-lb-stat ${tone === "warn" ? "admin-lb-stat-warn" : ""}`}>
      <div className="admin-lb-stat-value">{value.toLocaleString()}</div>
      <div className="admin-lb-stat-label">{label}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`admin-lb-tab ${active ? "admin-lb-tab-active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ─── Entries tab ─────────────────────────────────────────────────────────

function EntriesTab({
  refreshSignal,
  onAction,
}: {
  refreshSignal: number;
  onAction: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters: AdminLbEntryFilters = useMemo(
    () => ({
      mode: searchParams.get("mode") || undefined,
      search: searchParams.get("search") || undefined,
      scoreMin: searchParams.get("scoreMin") ? Number(searchParams.get("scoreMin")) : undefined,
      scoreMax: searchParams.get("scoreMax") ? Number(searchParams.get("scoreMax")) : undefined,
      dateFrom: searchParams.get("dateFrom") || undefined,
      dateTo: searchParams.get("dateTo") || undefined,
      status: (searchParams.get("status") as "active" | "excluded" | "all" | null) || "all",
      limit: PAGE_SIZE,
      offset: searchParams.get("offset") ? Number(searchParams.get("offset")) : 0,
    }),
    [searchParams],
  );

  const [data, setData] = useState<{ entries: AdminLbEntry[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    getLbEntries(filters)
      .then((res) => {
        if (cancel) return;
        setData(res);
        setSelected(new Set());
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Failed to load entries");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [filters, refreshSignal]);

  function updateParam(key: string, value: string | undefined) {
    const sp = new URLSearchParams(searchParams);
    if (value === undefined || value === "") sp.delete(key);
    else sp.set(key, value);
    sp.delete("offset"); // reset pagination on filter change
    setSearchParams(sp);
  }

  function setOffset(next: number) {
    const sp = new URLSearchParams(searchParams);
    if (next === 0) sp.delete("offset");
    else sp.set("offset", String(next));
    setSearchParams(sp);
  }

  function openPlayer(userId: string) {
    const sp = new URLSearchParams(searchParams);
    sp.set("player", userId);
    setSearchParams(sp);
  }

  async function handleExclude(entry: AdminLbEntry) {
    const reason = window.prompt(`Reason for excluding "${entry.playerName}" (${entry.score})?`);
    if (!reason || !reason.trim()) return;
    try {
      await excludeLbEntry(entry.id, reason.trim());
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleRestore(entry: AdminLbEntry) {
    try {
      await restoreLbEntry(entry.id);
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    }
  }

  async function handleBulkExclude() {
    if (selected.size === 0) return;
    const reason = window.prompt(`Reason for excluding ${selected.size} entries?`);
    if (!reason || !reason.trim()) return;
    try {
      const result = await bulkExcludeLbEntries(Array.from(selected), reason.trim());
      window.alert(`Excluded ${result.excluded} entries (${result.notFound} not found).`);
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    }
  }

  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleSelectAll() {
    if (!data) return;
    if (selected.size === data.entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.entries.map((e) => e.id)));
    }
  }

  const total = data?.total ?? 0;
  const offset = filters.offset ?? 0;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="admin-lb-filters">
        <input
          type="search"
          placeholder="Search player or username"
          defaultValue={searchParams.get("search") || ""}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              updateParam("search", (e.target as HTMLInputElement).value);
            }
          }}
        />
        <select
          value={searchParams.get("mode") || ""}
          onChange={(e) => updateParam("mode", e.target.value)}
        >
          <option value="">All modes</option>
          {GAME_MODES.map((g) => (
            <option key={g.mode} value={g.mode}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          value={searchParams.get("status") || "all"}
          onChange={(e) => updateParam("status", e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active only</option>
          <option value="excluded">Excluded only</option>
        </select>
        <input
          type="number"
          placeholder="Min score"
          defaultValue={searchParams.get("scoreMin") || ""}
          onBlur={(e) => updateParam("scoreMin", e.target.value || undefined)}
        />
        <input
          type="number"
          placeholder="Max score"
          defaultValue={searchParams.get("scoreMax") || ""}
          onBlur={(e) => updateParam("scoreMax", e.target.value || undefined)}
        />
        <input
          type="date"
          aria-label="From date"
          defaultValue={searchParams.get("dateFrom") || ""}
          onBlur={(e) => updateParam("dateFrom", e.target.value || undefined)}
        />
        <input
          type="date"
          aria-label="To date"
          defaultValue={searchParams.get("dateTo") || ""}
          onBlur={(e) => updateParam("dateTo", e.target.value || undefined)}
        />
        {searchParams.toString() && (
          <button
            type="button"
            className="admin-lb-link"
            onClick={() => setSearchParams(new URLSearchParams())}
          >
            Clear filters
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="admin-lb-bulk-bar" role="region" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <button type="button" onClick={handleBulkExclude}>
            Exclude with reason
          </button>
          <button type="button" className="admin-lb-link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {loading && <div className="admin-lb-empty">Loading…</div>}
      {error && <div className="admin-lb-error">{error}</div>}
      {!loading && !error && data && data.entries.length === 0 && (
        <div className="admin-lb-empty">No entries match these filters.</div>
      )}
      {!loading && !error && data && data.entries.length > 0 && (
        <>
          <table className="admin-lb-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === data.entries.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Player</th>
                <th>Mode</th>
                <th style={{ textAlign: "right" }}>Score</th>
                <th>Played at</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id} className={entry.isExcluded ? "admin-lb-row-excluded" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(entry.id)}
                      onChange={() => toggleSelect(entry.id)}
                      aria-label={`Select entry ${entry.id}`}
                    />
                  </td>
                  <td>
                    {entry.userId ? (
                      <button
                        type="button"
                        className="admin-lb-link"
                        onClick={() => openPlayer(entry.userId!)}
                      >
                        {entry.username || entry.playerName}
                      </button>
                    ) : (
                      <span>{entry.playerName}</span>
                    )}
                    {entry.userBanned && <span className="admin-lb-pill admin-lb-pill-warn">banned</span>}
                    {entry.userIsTest && <span className="admin-lb-pill">test</span>}
                  </td>
                  <td>{entry.gameMode}</td>
                  <td style={{ textAlign: "right" }}>{entry.score.toLocaleString()}</td>
                  <td>{formatTimestamp(entry.playedAt)}</td>
                  <td>
                    {entry.isExcluded ? (
                      <span className="admin-lb-pill admin-lb-pill-warn" title={entry.excludedReason || ""}>
                        excluded
                      </span>
                    ) : (
                      <span className="admin-lb-pill admin-lb-pill-ok">active</span>
                    )}
                  </td>
                  <td>
                    {entry.isExcluded ? (
                      <button type="button" className="admin-lb-link" onClick={() => handleRestore(entry)}>
                        Restore
                      </button>
                    ) : (
                      <button type="button" className="admin-lb-link" onClick={() => handleExclude(entry)}>
                        Exclude
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="admin-lb-pagination">
            <span>
              {showingFrom}–{showingTo} of {total.toLocaleString()}
            </span>
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Banned tab ──────────────────────────────────────────────────────────

function BannedTab({ refreshSignal }: { refreshSignal: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLbBannedUsers>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setSearchParams] = useSearchParams();

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    getLbBannedUsers({ limit: 100 })
      .then((res) => {
        if (!cancel) setData(res);
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshSignal]);

  function openPlayer(userId: string) {
    setSearchParams((sp) => {
      const next = new URLSearchParams(sp);
      next.set("player", userId);
      return next;
    });
  }

  if (loading) return <div className="admin-lb-empty">Loading…</div>;
  if (error) return <div className="admin-lb-error">{error}</div>;
  if (!data || data.users.length === 0) return <div className="admin-lb-empty">No banned accounts.</div>;

  return (
    <table className="admin-lb-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Banned at</th>
          <th>Until</th>
          <th>Reason</th>
          <th>Entries</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.users.map((u) => (
          <tr key={u.userId}>
            <td>
              <button type="button" className="admin-lb-link" onClick={() => openPlayer(u.userId)}>
                {u.username}
              </button>
            </td>
            <td>{formatTimestamp(u.bannedAt)}</td>
            <td>{u.bannedUntil ? formatTimestamp(u.bannedUntil) : "permanent"}</td>
            <td>{u.bannedReason || "—"}</td>
            <td>
              {u.totalEntries} ({u.excludedEntries} excluded)
            </td>
            <td>
              <button type="button" className="admin-lb-link" onClick={() => openPlayer(u.userId)}>
                Open
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Audit tab ───────────────────────────────────────────────────────────

function AuditTab({ refreshSignal }: { refreshSignal: number }) {
  const [data, setData] = useState<{ entries: AdminLbAuditEntry[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>("");

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    getLbAuditLog({ limit: 200, action: actionFilter || undefined })
      .then((res) => {
        if (!cancel) setData(res);
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshSignal, actionFilter]);

  return (
    <div>
      <div className="admin-lb-filters">
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">All actions</option>
          <option value="exclude_entry">Exclude entry</option>
          <option value="restore_entry">Restore entry</option>
          <option value="ban_user">Ban user</option>
          <option value="unban_user">Unban user</option>
          <option value="set_test_flag">Set test flag</option>
        </select>
      </div>
      {loading && <div className="admin-lb-empty">Loading…</div>}
      {error && <div className="admin-lb-error">{error}</div>}
      {!loading && !error && data && data.entries.length === 0 && (
        <div className="admin-lb-empty">No audit events.</div>
      )}
      {!loading && !error && data && data.entries.length > 0 && (
        <ul className="admin-lb-audit-feed">
          {data.entries.map((event) => (
            <li key={event.id}>
              <span className="admin-lb-audit-actor">{event.adminUsername}</span>{" "}
              <span>{actionLabel(event.action)}</span>{" "}
              <span className="admin-lb-audit-target">{event.targetLabel || event.targetId}</span>
              {event.reason && <span className="admin-lb-audit-reason"> — {event.reason}</span>}
              <span className="admin-lb-audit-time">{formatTimestamp(event.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Player drawer ───────────────────────────────────────────────────────

function PlayerDrawer({
  userId,
  onClose,
  onAction,
}: {
  userId: string;
  onClose: () => void;
  onAction: () => void;
}) {
  const [summary, setSummary] = useState<AdminLbUserSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return getLbUserSummary(userId)
      .then((res) => setSummary(res))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    let cancel = false;
    getLbUserSummary(userId)
      .then((res) => {
        if (!cancel) setSummary(res);
      })
      .catch((err) => {
        if (!cancel) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [userId]);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleBan() {
    if (!summary) return;
    const reason = window.prompt(`Reason for banning ${summary.username}?`);
    if (!reason || !reason.trim()) return;
    const durationStr = window.prompt(
      "Duration in days (leave blank for permanent ban):",
      "",
    );
    const durationDays =
      durationStr && Number.isFinite(Number(durationStr)) && Number(durationStr) > 0
        ? Number(durationStr)
        : undefined;
    setBusy(true);
    try {
      await banLbUser(userId, { reason: reason.trim(), durationDays });
      await reload();
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleBanHistory() {
    if (!summary) return;
    const total = summary.totalEntries;
    const confirmed = window.confirm(
      `Ban ${summary.username} AND exclude all ${total} of their leaderboard entries?\n\n` +
      `This wipes their entire score history from public boards. ` +
      `You can restore individual entries later, but this is harder to undo than a normal ban.`,
    );
    if (!confirmed) return;
    const reason = window.prompt(`Reason for banning ${summary.username}'s full history?`);
    if (!reason || !reason.trim()) return;
    const durationStr = window.prompt(
      "Duration in days (leave blank for permanent ban):",
      "",
    );
    const durationDays =
      durationStr && Number.isFinite(Number(durationStr)) && Number(durationStr) > 0
        ? Number(durationStr)
        : undefined;
    setBusy(true);
    try {
      await banLbUserHistory(userId, { reason: reason.trim(), durationDays });
      await reload();
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnban() {
    setBusy(true);
    try {
      await unbanLbUser(userId);
      await reload();
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleTest() {
    if (!summary) return;
    setBusy(true);
    try {
      await setLbTestAccountFlag(userId, !summary.isTestAccount);
      await reload();
      onAction();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-lb-drawer-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <aside
        className="admin-lb-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Player details"
      >
        <header className="admin-lb-drawer-header">
          <h2>{summary?.username || "Player"}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {loading && <div className="admin-lb-empty">Loading…</div>}
        {error && <div className="admin-lb-error">{error}</div>}
        {summary && (
          <div className="admin-lb-drawer-body">
            <section className="admin-lb-drawer-section">
              <dl className="admin-lb-dl">
                <dt>Email</dt>
                <dd>{summary.email || "—"}</dd>
                <dt>Lifetime score</dt>
                <dd>{summary.lifetimeScore.toLocaleString()}</dd>
                <dt>Best score</dt>
                <dd>{summary.bestScore.toLocaleString()}</dd>
                <dt>Total entries</dt>
                <dd>
                  {summary.totalEntries} ({summary.excludedEntries} excluded)
                </dd>
              </dl>
            </section>

            <section className="admin-lb-drawer-section">
              <h3>Moderation</h3>
              <div className="admin-lb-drawer-actions">
                {summary.banned ? (
                  <>
                    <p>
                      <strong>Banned</strong> {summary.bannedUntil ? "until " + formatTimestamp(summary.bannedUntil) : "permanently"}
                      {summary.bannedReason && <> — “{summary.bannedReason}”</>}
                    </p>
                    <button type="button" disabled={busy} onClick={handleUnban}>
                      Unban
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy} onClick={handleBan}>
                      Ban from leaderboard
                    </button>
                    <button
                      type="button"
                      disabled={busy || summary.totalEntries === 0}
                      onClick={handleBanHistory}
                      title="Ban user and exclude every entry they own"
                      data-testid="admin-lb-ban-history"
                    >
                      Ban + wipe history ({summary.totalEntries})
                    </button>
                  </>
                )}
                <label className="admin-lb-checkbox">
                  <input
                    type="checkbox"
                    checked={summary.isTestAccount}
                    disabled={busy}
                    onChange={handleToggleTest}
                  />
                  Test account (hidden from public boards)
                </label>
              </div>
            </section>

            <section className="admin-lb-drawer-section">
              <h3>Recent entries</h3>
              {summary.recentEntries.length === 0 ? (
                <p className="admin-lb-empty">No leaderboard entries.</p>
              ) : (
                <ul className="admin-lb-drawer-entries">
                  {summary.recentEntries.map((entry) => (
                    <li key={entry.id} className={entry.isExcluded ? "admin-lb-row-excluded" : ""}>
                      <span>{entry.gameMode}</span>
                      <span>{entry.score.toLocaleString()}</span>
                      <span>{formatTimestamp(entry.playedAt)}</span>
                      {entry.isExcluded ? (
                        <span className="admin-lb-pill admin-lb-pill-warn">excluded</span>
                      ) : (
                        <span className="admin-lb-pill admin-lb-pill-ok">active</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
