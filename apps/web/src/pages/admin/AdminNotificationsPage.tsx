/**
 * Admin notification management page.
 *
 * Four tabs:
 * 1. Templates — CRUD for notification templates
 * 2. Send — Manual and template-based notification sending
 * 3. Stats — Delivery rates, CTR, subscriber counts
 * 4. Log — Paginated notification delivery log
 */

import { useState, useEffect, useCallback } from "react";
import type { NotificationTemplate, NotificationType, NotificationLogEntry, NotificationStats } from "@price-game/shared";
import { NOTIFICATION_TYPES } from "@price-game/shared";
import {
  fetchNotifTemplates,
  createNotifTemplate,
  updateNotifTemplate,
  deleteNotifTemplate,
  sendNotification,
  sendTestNotification,
  fetchNotifStats,
  fetchNotifLog,
  fetchSubscriberCounts,
} from "../../api/adminClient";

type Tab = "templates" | "send" | "stats" | "log";
const TYPES = Object.values(NOTIFICATION_TYPES) as NotificationType[];

/**
 * Admin notification management page with tabs for templates, send, stats, and log.
 */
export default function AdminNotificationsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");

  return (
    <div className="admin-page" data-testid="admin-notifications-page">
      <h1 className="notif-page-title">Notifications</h1>
      <div className="notif-tabs">
        {(["stats", "send", "templates", "log"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`notif-tab ${activeTab === tab ? "notif-tab-active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {activeTab === "stats" && <StatsSection />}
      {activeTab === "send" && <SendSection />}
      {activeTab === "templates" && <TemplatesSection />}
      {activeTab === "log" && <LogSection />}
    </div>
  );
}

// ── Stats Section ─────────────────────────────────────────────────────────

function StatsSection() {
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [subscribers, setSubscribers] = useState<{ total: number; active: number } | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([fetchNotifStats(days), fetchSubscriberCounts()]);
      setStats(s);
      setSubscribers(c);
    } catch {
      // Error loading stats
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p style={{ color: "#8a96b0" }}>Loading stats...</p>;
  if (!stats || !subscribers) return <p style={{ color: "#666" }}>Failed to load stats.</p>;

  return (
    <div className="admin-section">
      <div className="notif-section-header">
        <h2>Analytics</h2>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ padding: "6px 10px", background: "#16213e", border: "1px solid #333", borderRadius: 6, color: "#e0e0e0", fontSize: "0.85rem" }}
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      <div className="notif-stats-grid">
        <div className="notif-stat-card">
          <div className="notif-stat-value">{subscribers.active}</div>
          <div className="notif-stat-label">Active Subscribers</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.totalSent}</div>
          <div className="notif-stat-label">Sent</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.deliveryRate.toFixed(1)}%</div>
          <div className="notif-stat-label">Delivery Rate</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.clickThroughRate.toFixed(1)}%</div>
          <div className="notif-stat-label">Click-Through Rate</div>
        </div>
      </div>

      {stats.byType.length > 0 && (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Type</th><th>Sent</th><th>Clicked</th><th>Failed</th><th>CTR</th></tr>
          </thead>
          <tbody>
            {stats.byType.map((row) => (
              <tr key={row.type}>
                <td><span className="notif-badge">{row.type}</span></td>
                <td>{row.sent}</td>
                <td>{row.clicked}</td>
                <td>{row.failed}</td>
                <td>{row.ctr.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// ── Send Section ──────────────────────────────────────────────────────────

function SendSection() {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [mode, setMode] = useState<"adhoc" | "template">("adhoc");
  const [templateId, setTemplateId] = useState<number | undefined>();
  const [title, setTitle] = useState("Test Notification");
  const [body, setBody] = useState("This is a test push notification.");
  const [type, setType] = useState<NotificationType>("daily_puzzle");
  const [userId, setUserId] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchNotifTemplates().then(({ templates: t }) => setTemplates(t)).catch(() => {});
  }, []);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);
    setError(null);
    try {
      let data: Parameters<typeof sendNotification>[0];
      if (mode === "template") {
        if (!templateId) { setError("Select a template"); setSending(false); return; }
        data = { templateId, userId: userId || undefined };
      } else {
        if (!title || !body) { setError("Title and body are required"); setSending(false); return; }
        data = { title, body, type, userId: userId || undefined };
      }
      const { sent } = await sendNotification(data);
      setResult(`Sent to ${sent} subscription(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function handleTest() {
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const { sent } = await sendTestNotification(userId || undefined);
      setResult(`Test sent to ${sent} subscription(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test");
    } finally {
      setSending(false);
    }
  }

  const activeTemplates = templates.filter((t) => t.isActive);

  return (
    <div className="admin-section">
      <h2>Send Notification</h2>
      {error && <div className="notif-error">{error}</div>}
      {result && <div className="notif-success">{result}</div>}

      <div style={{ marginBottom: 20 }}>
        <button className="admin-btn-sm" onClick={handleTest} disabled={sending} style={{ padding: "10px 20px" }}>
          {sending ? "Sending..." : "Send Test to All Subscribers"}
        </button>
        <p style={{ color: "#8a96b0", fontSize: "0.8rem", marginTop: 6 }}>
          Sends a generic test notification to all active subscribers.
        </p>
      </div>

      <h2>Custom Send</h2>
      <form className="notif-form" onSubmit={handleSend}>
        <div className="notif-form-row">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as "adhoc" | "template")}>
            <option value="adhoc">Ad-hoc (custom message)</option>
            <option value="template">From template</option>
          </select>
        </div>

        {mode === "template" ? (
          <div className="notif-form-row">
            <label>Template</label>
            <select value={templateId ?? ""} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">Select a template...</option>
              {activeTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div className="notif-form-row">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="notif-form-row">
              <label>Body</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="notif-form-row">
              <label>Type</label>
              <select value={type} onChange={(e) => setType(e.target.value as NotificationType)}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </>
        )}

        <div className="notif-form-row">
          <label>User ID (leave empty to send to all subscribers)</label>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Optional: target a specific user" />
        </div>
        <button type="submit" className="admin-btn-sm" disabled={sending}>
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </div>
  );
}

// ── Templates Section ─────────────────────────────────────────────────────

function TemplatesSection() {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<NotificationType>("daily_puzzle");
  const [titleTpl, setTitleTpl] = useState("");
  const [bodyTpl, setBodyTpl] = useState("");
  const [urlPath, setUrlPath] = useState("/");
  const [urgency, setUrgency] = useState("normal");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { templates: t } = await fetchNotifTemplates();
      setTemplates(t);
    } catch {
      setError("Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setName(""); setType("daily_puzzle"); setTitleTpl(""); setBodyTpl("");
    setUrlPath("/"); setUrgency("normal"); setEditingId(null); setShowForm(false);
  }

  function startEdit(t: NotificationTemplate) {
    setName(t.name); setType(t.type); setTitleTpl(t.titleTemplate);
    setBodyTpl(t.bodyTemplate); setUrlPath(t.urlPath); setUrgency(t.urgency);
    setEditingId(t.id); setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await updateNotifTemplate(editingId, {
          name, type, titleTemplate: titleTpl, bodyTemplate: bodyTpl, urlPath, urgency,
        });
      } else {
        await createNotifTemplate({
          name, type, titleTemplate: titleTpl, bodyTemplate: bodyTpl, urlPath, urgency,
        });
      }
      resetForm();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this template?")) return;
    try {
      await deleteNotifTemplate(id);
      load();
    } catch {
      setError("Failed to delete template");
    }
  }

  async function handleToggleActive(t: NotificationTemplate) {
    try {
      await updateNotifTemplate(t.id, { isActive: !t.isActive });
      load();
    } catch {
      setError("Failed to update template");
    }
  }

  return (
    <div className="admin-section">
      {error && <div className="notif-error">{error}</div>}

      <div className="notif-section-header">
        <h2>Templates</h2>
        <button className="admin-btn-sm" onClick={() => { resetForm(); setShowForm(!showForm); }}>
          {showForm ? "Cancel" : "+ New Template"}
        </button>
      </div>

      {showForm && (
        <form className="notif-form" onSubmit={handleSubmit}>
          <div className="notif-form-row">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Daily Reminder" />
          </div>
          <div className="notif-form-row">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as NotificationType)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="notif-form-row">
            <label>Title Template</label>
            <input value={titleTpl} onChange={(e) => setTitleTpl(e.target.value)} required placeholder="e.g. Daily Puzzle Ready!" />
          </div>
          <div className="notif-form-row">
            <label>Body Template</label>
            <textarea value={bodyTpl} onChange={(e) => setBodyTpl(e.target.value)} required placeholder="Use {{userName}}, {{streakCount}} for variables" />
          </div>
          <div className="notif-form-row">
            <label>URL Path</label>
            <input value={urlPath} onChange={(e) => setUrlPath(e.target.value)} placeholder="/" />
          </div>
          <div className="notif-form-row">
            <label>Urgency</label>
            <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              {["very-low", "low", "normal", "high"].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <button type="submit" className="admin-btn-sm">{editingId ? "Update" : "Create"}</button>
        </form>
      )}

      {loading ? <p style={{ color: "#8a96b0" }}>Loading...</p> : templates.length === 0 ? (
        <div className="admin-empty">No templates yet. Create one to get started.</div>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Title</th><th>Active</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><span className="notif-badge">{t.type}</span></td>
                <td>{t.titleTemplate}</td>
                <td>
                  <button
                    className={`notif-toggle notif-toggle-sm ${t.isActive ? "notif-toggle-on" : ""}`}
                    onClick={() => handleToggleActive(t)}
                  >
                    <span className="notif-toggle-knob" />
                  </button>
                </td>
                <td>
                  <button className="admin-btn-sm" onClick={() => startEdit(t)}>Edit</button>{" "}
                  <button className="admin-btn-sm-danger" onClick={() => handleDelete(t.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// ── Log Section ───────────────────────────────────────────────────────────

function LogSection() {
  const [entries, setEntries] = useState<NotificationLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [typeFilter, setTypeFilter] = useState<NotificationType | "">("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchNotifLog({
        page,
        limit: 25,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
      });
      setEntries(result.entries);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch {
      // Error
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-section">
      <h2>Notification Log ({total})</h2>

      <div className="admin-filters">
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value as NotificationType | ""); setPage(1); }}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {["pending", "sent", "clicked", "failed", "expired", "suppressed"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading ? <p style={{ color: "#8a96b0" }}>Loading...</p> : entries.length === 0 ? (
        <div className="admin-empty">No log entries found.</div>
      ) : (
        <>
          <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>ID</th><th>User</th><th>Type</th><th>Title</th><th>Status</th><th>Sent</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td title={e.userId}>
                    {e.username ?? <span className="notif-mono">{e.userId.slice(0, 8)}...</span>}
                  </td>
                  <td><span className="notif-badge">{e.type}</span></td>
                  <td>{e.title ?? "—"}</td>
                  <td><span className={`notif-badge notif-badge-${e.status}`}>{e.status}</span></td>
                  <td>{e.sentAt ? new Date(e.sentAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="notif-pagination">
            <button className="admin-btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <span>Page {page} of {totalPages}</span>
            <button className="admin-btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
