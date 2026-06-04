import { useState, useEffect, useRef, useCallback } from "react";
import {
  getGhostSettings,
  updateGhostSettings,
  listGhostUsers,
  bulkCreateGhosts,
  patchGhostUser,
  deleteGhostUser,
  triggerGhostKillSwitch,
  getAutoLobbySettings,
  updateAutoLobbySettings,
  type GhostSettings,
  type GhostUserRow,
  type AutoLobbySettings,
} from "../../api/adminClient";

/**
 * Admin page for the ghost-user system.
 *
 * Surfaces:
 *   - Master toggle (enabled), leaderboard visibility, percentile cap,
 *     target count
 *   - Red kill-switch button — sets killSwitch + ends every on-shift
 *     ghost in one server round-trip
 *   - Bulk-create N ghosts (capped at 500/call by the server)
 *   - Paginated roster table with per-row deactivate / end-shift /
 *     delete actions
 *
 * The system ships dark — `enabled` defaults to false. PR B exposes the
 * leaderboard and profile surface; an admin opts in by flipping
 * showOnLeaderboard.
 */
export default function AdminGhostUsersPage(): JSX.Element {
  const [settings, setSettings] = useState<GhostSettings | null>(null);
  const [autoLobby, setAutoLobby] = useState<AutoLobbySettings | null>(null);
  const [ghosts, setGhosts] = useState<GhostUserRow[]>([]);
  const [bulkCount, setBulkCount] = useState<number>(35);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const okTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const flash = useCallback((msg: string) => {
    setOkMsg(msg);
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
    okTimerRef.current = setTimeout(() => setOkMsg(null), 4000);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setErr(null);
      const [s, r, al] = await Promise.all([
        getGhostSettings(),
        listGhostUsers({ limit: 200 }),
        getAutoLobbySettings(),
      ]);
      setSettings(s.settings);
      setGhosts(r.ghosts);
      setAutoLobby(al.settings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load ghost users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    return () => {
      if (okTimerRef.current) clearTimeout(okTimerRef.current);
    };
  }, [loadAll]);

  async function patchSettings(patch: Partial<GhostSettings>) {
    if (!settings) return;
    try {
      setSaving(true);
      setErr(null);
      const result = await updateGhostSettings(patch);
      setSettings(result.settings);
      flash("Settings saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function patchAutoLobby(patch: Partial<AutoLobbySettings>) {
    if (!autoLobby) return;
    try {
      setSaving(true);
      setErr(null);
      const result = await updateAutoLobbySettings(patch);
      setAutoLobby(result.settings);
      flash("Auto-lobby settings saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save auto-lobby settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkCreate() {
    if (bulkCount <= 0 || bulkCount > 500) {
      setErr("count must be between 1 and 500");
      return;
    }
    try {
      setSaving(true);
      setErr(null);
      const result = await bulkCreateGhosts(bulkCount);
      flash(`Created ${result.created} ghost${result.created === 1 ? "" : "s"}`);
      await loadAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Bulk create failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(id: string, isActive: boolean) {
    try {
      setSaving(true);
      setErr(null);
      await patchGhostUser(id, { isActive });
      await loadAll();
      flash(isActive ? "Ghost reactivated" : "Ghost deactivated");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleEndShift(id: string) {
    try {
      setSaving(true);
      setErr(null);
      await patchGhostUser(id, { endShift: true });
      await loadAll();
      flash("Shift ended");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "End-shift failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, username: string) {
    if (!confirm(`Hard-delete ghost "${username}"? This cannot be undone.`)) return;
    try {
      setSaving(true);
      setErr(null);
      await deleteGhostUser(id);
      await loadAll();
      flash("Ghost deleted");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleKillSwitch() {
    if (!confirm(
      "Trigger emergency kill-switch?\n\nThis sets killSwitch=true and ends every on-shift ghost immediately. Real users in active games are unaffected.",
    )) return;
    try {
      setSaving(true);
      setErr(null);
      const result = await triggerGhostKillSwitch();
      flash(`Kill-switch active. ${result.evictedShifts} shift(s) evicted.`);
      await loadAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kill-switch failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="admin-page"><h1>Ghost Users</h1><p>Loading…</p></div>;
  if (!settings) return <div className="admin-page"><h1>Ghost Users</h1><p>{err ?? "No settings"}</p></div>;

  const activeCount = ghosts.filter((g) => g.is_active === 1).length;
  const onShiftCount = ghosts.filter((g) => g.on_shift === 1).length;

  return (
    <div className="admin-page admin-ghost-users">
      <h1>Ghost Users</h1>
      <p className="admin-page-help">
        Persistent synthetic player accounts. Seat auto-lobbies, accrue scores capped at the {settings.percentileCap}th percentile of real users, and (when leaderboard visibility is on) appear on the public lifetime + streak boards. Ghosts cannot earn rewards or appear in admin user listings.
      </p>

      {err && <div className="admin-error" role="alert">{err}</div>}
      {okMsg && <div className="admin-success" role="status">{okMsg}</div>}

      <section className="admin-section">
        <h2>Auto-lobbies</h2>
        <p className="admin-page-help" style={{ marginTop: 0 }}>
          Master toggle for the auto-lobby system. When on, the manager
          maintains a band of public lobbies (sampled uniformly in
          [Min, Max] every tick) and seats them with on-shift ghosts when
          available, falling back to synthesized-name bots otherwise.
        </p>
        {autoLobby ? (
          <>
            <div className="admin-toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={autoLobby.enabled}
                  disabled={saving}
                  onChange={(e) => patchAutoLobby({ enabled: e.target.checked })}
                />
                <strong>Auto-lobbies enabled</strong> — manager spawns lobbies up to the band.
              </label>
            </div>
            <div className="admin-toggle-row" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label>
                Min lobbies:{" "}
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={autoLobby.targetMin}
                  disabled={saving || !autoLobby.enabled}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setAutoLobby({ ...autoLobby, targetMin: n });
                  }}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) patchAutoLobby({ targetMin: n });
                  }}
                  style={{ width: 80 }}
                />
              </label>
              <label>
                Max lobbies:{" "}
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={autoLobby.targetCount}
                  disabled={saving || !autoLobby.enabled}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setAutoLobby({ ...autoLobby, targetCount: n });
                  }}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) patchAutoLobby({ targetCount: n });
                  }}
                  style={{ width: 80 }}
                />
              </label>
              <label>
                Countdown min (s):{" "}
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={autoLobby.countdownMinSeconds}
                  disabled={saving || !autoLobby.enabled}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setAutoLobby({ ...autoLobby, countdownMinSeconds: n });
                  }}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) patchAutoLobby({ countdownMinSeconds: n });
                  }}
                  style={{ width: 80 }}
                />
              </label>
              <label>
                Countdown max (s):{" "}
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={autoLobby.countdownMaxSeconds}
                  disabled={saving || !autoLobby.enabled}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setAutoLobby({ ...autoLobby, countdownMaxSeconds: n });
                  }}
                  onBlur={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) patchAutoLobby({ countdownMaxSeconds: n });
                  }}
                  style={{ width: 80 }}
                />
              </label>
            </div>
          </>
        ) : (
          <p style={{ color: "#9ca3af" }}>Auto-lobby settings unavailable.</p>
        )}
      </section>

      <section className="admin-section">
        <h2>System</h2>
        <div className="admin-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={saving}
              onChange={(e) => patchSettings({ enabled: e.target.checked })}
            />
            <strong>Enabled</strong> — master toggle. When off, no shifts start; existing seated ghosts finish naturally.
          </label>
        </div>
        <div className="admin-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={settings.showOnLeaderboard}
              disabled={saving}
              onChange={(e) => patchSettings({ showOnLeaderboard: e.target.checked })}
            />
            <strong>Show on leaderboard</strong> — when on, ghosts appear on the public lifetime + streak boards and have profile pages.
          </label>
        </div>
        <div className="admin-toggle-row">
          <label>
            Percentile cap (0-100):{" "}
            <input
              type="number"
              min={0}
              max={100}
              value={settings.percentileCap}
              disabled={saving}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) {
                  setSettings({ ...settings, percentileCap: n });
                }
              }}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) patchSettings({ percentileCap: n });
              }}
              style={{ width: 80 }}
            />
          </label>
        </div>

        <div className="admin-kill-switch" style={{ marginTop: 16 }}>
          {settings.killSwitch ? (
            <>
              <span style={{ color: "#dc2626", fontWeight: 700 }}>Kill-switch is ACTIVE.</span>{" "}
              <button
                type="button"
                disabled={saving}
                onClick={() => patchSettings({ killSwitch: false })}
              >
                Clear kill-switch
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={handleKillSwitch}
              style={{ background: "#dc2626", color: "#fff", padding: "8px 16px", fontWeight: 700 }}
            >
              🚨 Trigger kill-switch
            </button>
          )}
        </div>
      </section>

      <section className="admin-section">
        <h2>Roster ({ghosts.length} total / {activeCount} active / {onShiftCount} on shift)</h2>
        <div className="admin-bulk-create" style={{ marginBottom: 12 }}>
          <label>
            Bulk-create N ghosts:{" "}
            <input
              type="number"
              min={1}
              max={500}
              value={bulkCount}
              disabled={saving}
              onChange={(e) => setBulkCount(parseInt(e.target.value, 10) || 0)}
              style={{ width: 80, marginRight: 8 }}
            />
          </label>
          <button type="button" disabled={saving || bulkCount <= 0} onClick={handleBulkCreate}>
            Create
          </button>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Lifetime score</th>
              <th>Streak (best/cur)</th>
              <th>Status</th>
              <th>Last played</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {ghosts.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: "center", padding: 20 }}>No ghosts yet — bulk-create above.</td></tr>
            ) : ghosts.map((g) => {
              const status =
                g.is_active === 0 ? "retired"
                : g.on_shift === 1 ? "on shift"
                : g.on_break_until ? "on break"
                : "idle";
              return (
                <tr key={g.id}>
                  <td>{g.username}</td>
                  <td>{g.lifetime_score}</td>
                  <td>{g.daily_streak_best}/{g.daily_streak_current}</td>
                  <td>{status}</td>
                  <td>{g.last_played_at ? new Date(g.last_played_at).toLocaleString() : "—"}</td>
                  <td>
                    {g.is_active === 1 ? (
                      <button type="button" disabled={saving} onClick={() => handleDeactivate(g.id, false)}>Deactivate</button>
                    ) : (
                      <button type="button" disabled={saving} onClick={() => handleDeactivate(g.id, true)}>Reactivate</button>
                    )}
                    {g.on_shift === 1 && (
                      <button type="button" disabled={saving} onClick={() => handleEndShift(g.id)} style={{ marginLeft: 6 }}>End shift</button>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleDelete(g.id, g.username)}
                      style={{ marginLeft: 6, color: "#dc2626" }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
