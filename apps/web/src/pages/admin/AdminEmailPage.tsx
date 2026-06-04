/**
 * Admin email management page.
 *
 * Five tabs:
 *  1. Stats     — send / open / click / bounce rates, per-type breakdown.
 *  2. Send      — ad-hoc or template-based send (with live preview).
 *  3. Templates — CRUD for email templates (subject + HTML + text).
 *  4. Triggers  — admin-tunable trigger config: enabled flag, cooldown,
 *                 threshold JSON, bound template.
 *  5. Log       — paginated `email_log` with filters.
 *
 * Designed to feel identical to the push-notification page (same CSS,
 * same tab/form patterns) so the two marketing channels read as one
 * coherent product from an admin's POV.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type {
  EmailTemplate,
  EmailNotificationType,
  EmailLogEntry,
  EmailStats,
  EmailTriggerConfig,
} from "@price-game/shared";
import { EMAIL_NOTIFICATION_TYPES } from "@price-game/shared";
import {
  fetchEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  sendAdminEmail,
  sendTestAdminEmail,
  fetchEmailStats,
  fetchEmailLog,
  fetchEmailTriggers,
  updateEmailTrigger,
} from "../../api/adminClient";

type Tab = "stats" | "send" | "templates" | "triggers" | "log";
const TYPES = Object.values(EMAIL_NOTIFICATION_TYPES) as EmailNotificationType[];

/**
 * Root admin email management page with tab navigation.
 */
export default function AdminEmailPage() {
  const [activeTab, setActiveTab] = useState<Tab>("stats");

  return (
    <div className="admin-page" data-testid="admin-email-page">
      <h1 className="notif-page-title">Emails</h1>
      <p style={{ color: "#8a96b0", fontSize: "0.85rem", marginTop: -8 }}>
        Marketing &amp; re-engagement email channel. Triggers are OFF by default
        and users opt in per-type — cooldowns are enforced server-side.
      </p>
      <div className="notif-tabs">
        {(["stats", "send", "templates", "triggers", "log"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`notif-tab ${activeTab === tab ? "notif-tab-active" : ""}`}
            onClick={() => setActiveTab(tab)}
            data-testid={`admin-email-tab-${tab}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {activeTab === "stats" && <StatsSection />}
      {activeTab === "send" && <SendSection />}
      {activeTab === "templates" && <TemplatesSection />}
      {activeTab === "triggers" && <TriggersSection />}
      {activeTab === "log" && <LogSection />}
    </div>
  );
}

// ── Stats ────────────────────────────────────────────────────────────────

function StatsSection() {
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await fetchEmailStats(days));
    } catch {
      /* error state handled via null */
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p style={{ color: "#8a96b0" }}>Loading stats...</p>;
  if (!stats) return <p style={{ color: "#666" }}>Failed to load stats.</p>;

  return (
    <div className="admin-section">
      <div className="notif-section-header">
        <h2>Analytics</h2>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{
            padding: "6px 10px",
            background: "#16213e",
            border: "1px solid #333",
            borderRadius: 6,
            color: "#e0e0e0",
            fontSize: "0.85rem",
          }}
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      <div className="notif-stats-grid">
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.totalSent}</div>
          <div className="notif-stat-label">Sent</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.openRate.toFixed(1)}%</div>
          <div className="notif-stat-label">Open Rate</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.clickRate.toFixed(1)}%</div>
          <div className="notif-stat-label">Click Rate</div>
        </div>
        <div className="notif-stat-card">
          <div className="notif-stat-value">{stats.bounceRate.toFixed(1)}%</div>
          <div className="notif-stat-label">Bounce Rate</div>
        </div>
      </div>

      {stats.byType.length > 0 && (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Sent</th>
              <th>Opened</th>
              <th>Clicked</th>
              <th>Bounced</th>
              <th>Open %</th>
              <th>Click %</th>
            </tr>
          </thead>
          <tbody>
            {stats.byType.map((row) => (
              <tr key={row.type}>
                <td><span className="notif-badge">{row.type}</span></td>
                <td>{row.sent}</td>
                <td>{row.opened}</td>
                <td>{row.clicked}</td>
                <td>{row.bounced}</td>
                <td>{row.openRate.toFixed(1)}%</td>
                <td>{row.clickRate.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// ── Send ────────────────────────────────────────────────────────────────

function SendSection() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [mode, setMode] = useState<"adhoc" | "template">("adhoc");
  const [templateId, setTemplateId] = useState<number | undefined>();
  const [subject, setSubject] = useState("Hello from Price Games");
  const [html, setHtml] = useState(
    "<h2 style=\"margin:0 0 16px\">Hi {{username}}</h2><p>This is an example email.</p>",
  );
  const [text, setText] = useState("");
  const [type, setType] = useState<EmailNotificationType>("custom");
  const [userId, setUserId] = useState("");
  const [toAllOptedIn, setToAllOptedIn] = useState(false);
  const [adminOverride, setAdminOverride] = useState(false);
  const [vars, setVars] = useState("{}");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchEmailTemplates().then(({ templates: t }) => setTemplates(t)).catch(() => {});
  }, []);

  // Live preview for ad-hoc HTML. Rendered via srcDoc so styles in the
  // template body don't leak into the admin panel.
  const previewHtml = useMemo(() => {
    if (mode === "template") {
      const t = templates.find((x) => x.id === templateId);
      if (!t) return "";
      return substituteVarsForPreview(t.htmlTemplate, vars);
    }
    return substituteVarsForPreview(html, vars);
  }, [mode, templates, templateId, html, vars]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);
    setError(null);
    let parsedVars: Record<string, string | number> = {};
    try {
      parsedVars = vars.trim() ? JSON.parse(vars) : {};
    } catch {
      setError("vars must be valid JSON");
      setSending(false);
      return;
    }
    try {
      const payload: Parameters<typeof sendAdminEmail>[0] =
        mode === "template"
          ? { templateId, userId: userId || undefined, toAllOptedIn, vars: parsedVars, adminOverride }
          : {
              subject,
              html,
              text: text || undefined,
              type,
              userId: userId || undefined,
              toAllOptedIn,
              adminOverride,
            };
      const r = await sendAdminEmail(payload);
      if (typeof r.sent === "number") {
        setResult(`Sent: ${r.sent}${r.skipped ? `, skipped: ${r.skipped}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
      } else {
        setResult(`Reason: ${r.reason ?? "ok"}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function handleTestSend() {
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const r = await sendTestAdminEmail({
        userId: userId || undefined,
        adminOverride: true,
      });
      setResult(r.ok ? `Test sent (reason: ${r.reason ?? "ok"})` : `Failed: ${r.error ?? "unknown"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test");
    } finally {
      setSending(false);
    }
  }

  const activeTemplates = templates.filter((t) => t.isActive);

  return (
    <div className="admin-section">
      <h2>Send Email</h2>
      {error && <div className="notif-error">{error}</div>}
      {result && <div className="notif-success">{result}</div>}

      <div style={{ marginBottom: 20 }}>
        <button
          className="admin-btn-sm"
          onClick={handleTestSend}
          disabled={sending}
          style={{ padding: "10px 20px" }}
        >
          {sending ? "Sending..." : "Send test to user id above"}
        </button>
        <p style={{ color: "#8a96b0", fontSize: "0.8rem", marginTop: 6 }}>
          Sends a minimal test email. If User ID is empty and no <code>to</code>
          is supplied, this is a no-op — set a User ID first.
        </p>
      </div>

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
            <select
              value={templateId ?? ""}
              onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">Select a template...</option>
              {activeTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div className="notif-form-row">
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </div>
            <div className="notif-form-row">
              <label>HTML body</label>
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                rows={8}
                required
                placeholder="Use {{username}}, {{streakCount}} for variables"
              />
            </div>
            <div className="notif-form-row">
              <label>Plain text (optional)</label>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
            </div>
            <div className="notif-form-row">
              <label>Type</label>
              <select value={type} onChange={(e) => setType(e.target.value as EmailNotificationType)}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </>
        )}

        <div className="notif-form-row">
          <label>vars (JSON, for {`{{placeholders}}`})</label>
          <input
            value={vars}
            onChange={(e) => setVars(e.target.value)}
            placeholder='{"username":"alice","streakCount":7}'
          />
        </div>

        <div className="notif-form-row">
          <label>User ID (leave empty to use &quot;all opted-in&quot; below)</label>
          <input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </div>

        <div className="notif-form-row">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={toAllOptedIn}
              onChange={(e) => setToAllOptedIn(e.target.checked)}
            />
            Send to all users opted in for this type
          </label>
        </div>

        <div className="notif-form-row">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={adminOverride}
              onChange={(e) => setAdminOverride(e.target.checked)}
            />
            Admin override (bypass cooldowns + preferences)
          </label>
        </div>

        <button type="submit" className="admin-btn-sm" disabled={sending}>
          {sending ? "Sending..." : "Send"}
        </button>
      </form>

      <div style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8, color: "#e0e0e0" }}>Preview</h3>
        <iframe
          title="email-preview"
          srcDoc={previewHtml}
          style={{
            width: "100%",
            minHeight: 400,
            background: "#fff",
            border: "1px solid #333",
            borderRadius: 6,
          }}
        />
      </div>
    </div>
  );
}

// ── Templates ────────────────────────────────────────────────────────────

function TemplatesSection() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<EmailNotificationType>("custom");
  const [subjectTemplate, setSubjectTemplate] = useState("");
  const [htmlTemplate, setHtmlTemplate] = useState("");
  const [textTemplate, setTextTemplate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { templates: t } = await fetchEmailTemplates();
      setTemplates(t);
    } catch {
      setError("Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setName(""); setType("custom"); setSubjectTemplate("");
    setHtmlTemplate(""); setTextTemplate(""); setEditingId(null); setShowForm(false);
  }

  function startEdit(t: EmailTemplate) {
    setName(t.name); setType(t.type); setSubjectTemplate(t.subjectTemplate);
    setHtmlTemplate(t.htmlTemplate); setTextTemplate(t.textTemplate ?? "");
    setEditingId(t.id); setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await updateEmailTemplate(editingId, {
          name, type, subjectTemplate, htmlTemplate,
          textTemplate: textTemplate || null,
        });
      } else {
        await createEmailTemplate({
          name, type, subjectTemplate, htmlTemplate,
          textTemplate: textTemplate || null,
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
      await deleteEmailTemplate(id);
      load();
    } catch {
      setError("Failed to delete template");
    }
  }

  async function handleToggleActive(t: EmailTemplate) {
    try {
      await updateEmailTemplate(t.id, { isActive: !t.isActive });
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
        <button
          className="admin-btn-sm"
          onClick={() => { resetForm(); setShowForm(!showForm); }}
        >
          {showForm ? "Cancel" : "+ New Template"}
        </button>
      </div>

      {showForm && (
        <form className="notif-form" onSubmit={handleSubmit}>
          <div className="notif-form-row">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="notif-form-row">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as EmailNotificationType)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="notif-form-row">
            <label>Subject template</label>
            <input
              value={subjectTemplate}
              onChange={(e) => setSubjectTemplate(e.target.value)}
              required
              placeholder="e.g. Your {{streakCount}}-day streak!"
            />
          </div>
          <div className="notif-form-row">
            <label>HTML body (use {`{{var}}`} placeholders)</label>
            <textarea
              value={htmlTemplate}
              onChange={(e) => setHtmlTemplate(e.target.value)}
              rows={10}
              required
            />
          </div>
          <div className="notif-form-row">
            <label>Plain text fallback (optional)</label>
            <textarea
              value={textTemplate}
              onChange={(e) => setTextTemplate(e.target.value)}
              rows={3}
            />
          </div>
          <button type="submit" className="admin-btn-sm">
            {editingId ? "Update" : "Create"}
          </button>
        </form>
      )}

      {loading ? (
        <p style={{ color: "#8a96b0" }}>Loading...</p>
      ) : templates.length === 0 ? (
        <div className="admin-empty">No templates yet. Create one to get started.</div>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Subject</th><th>Active</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><span className="notif-badge">{t.type}</span></td>
                <td>{t.subjectTemplate}</td>
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

// ── Triggers ─────────────────────────────────────────────────────────────

function TriggersSection() {
  const [triggers, setTriggers] = useState<EmailTriggerConfig[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ triggers: t }, { templates: tpl }] = await Promise.all([
        fetchEmailTriggers(),
        fetchEmailTemplates(),
      ]);
      setTriggers(t);
      setTemplates(tpl);
    } catch {
      setError("Failed to load triggers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(
    type: EmailNotificationType,
    patch: Partial<EmailTriggerConfig> & { templateId?: number | null; thresholdJson?: string | null },
  ) {
    setSaving(type);
    setError(null);
    try {
      await updateEmailTrigger(type, patch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trigger");
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <p style={{ color: "#8a96b0" }}>Loading triggers...</p>;

  return (
    <div className="admin-section">
      {error && <div className="notif-error">{error}</div>}
      <h2>Trigger configuration</h2>
      <p style={{ color: "#8a96b0", fontSize: "0.85rem" }}>
        Each trigger runs on the email scheduler (default every 15 min) and
        enqueues emails for users who match the threshold and are opted in.
        Cooldowns are per-user minimum gaps between sends of that trigger.
      </p>

      {triggers.map((t) => (
        <div
          key={t.type}
          className="admin-section"
          style={{ border: "1px solid #2a2a44", borderRadius: 8, padding: 16, marginBottom: 12 }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0, color: "#e0e0e0" }}>{t.type}</h3>
            <button
              className={`notif-toggle ${t.isEnabled ? "notif-toggle-on" : ""}`}
              onClick={() => save(t.type, { isEnabled: !t.isEnabled })}
              disabled={saving === t.type}
              data-testid={`email-trigger-toggle-${t.type}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>
          <div className="notif-form-row">
            <label>Cooldown (hours)</label>
            <input
              type="number"
              min={1}
              defaultValue={t.cooldownHours}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1 && v !== t.cooldownHours) {
                  save(t.type, { cooldownHours: v });
                }
              }}
            />
          </div>
          <div className="notif-form-row">
            <label>Threshold JSON</label>
            <input
              defaultValue={t.thresholdJson ?? ""}
              placeholder='{"days":7}'
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === (t.thresholdJson ?? "")) return;
                if (v && !isValidJson(v)) {
                  setError("Threshold must be valid JSON or empty");
                  return;
                }
                save(t.type, { thresholdJson: v || null });
              }}
            />
          </div>
          <div className="notif-form-row">
            <label>Template</label>
            <select
              value={t.templateId ?? ""}
              onChange={(e) =>
                save(t.type, { templateId: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">(none)</option>
              {templates
                .filter((tpl) => tpl.type === t.type || t.type === "custom")
                .map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Log ─────────────────────────────────────────────────────────────────

function LogSection() {
  const [entries, setEntries] = useState<EmailLogEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [typeFilter, setTypeFilter] = useState<EmailNotificationType | "">("");
  const [statusFilter, setStatusFilter] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchEmailLog({
        page,
        limit: 25,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
        userId: userIdFilter || undefined,
      });
      setEntries(r.entries);
      setTotalPages(r.totalPages);
    } catch {
      /* empty state handled by entries.length === 0 */
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, statusFilter, userIdFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-section">
      <h2>Email log</h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={typeFilter} onChange={(e) => { setPage(1); setTypeFilter(e.target.value as EmailNotificationType | ""); }}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
          <option value="">All statuses</option>
          {["queued", "sent", "opened", "clicked", "failed", "bounced", "complained", "suppressed"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          placeholder="User ID"
          value={userIdFilter}
          onChange={(e) => { setPage(1); setUserIdFilter(e.target.value); }}
        />
      </div>

      {loading ? (
        <p style={{ color: "#8a96b0" }}>Loading...</p>
      ) : entries.length === 0 ? (
        <div className="admin-empty">No log entries.</div>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th><th>Error</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.createdAt}</td>
                <td><span className="notif-badge">{e.type}</span></td>
                <td>{e.toAddress}</td>
                <td>{e.subject}</td>
                <td>{e.status}</td>
                <td style={{ fontSize: "0.8rem", color: "#8a96b0" }}>{e.errorMessage ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="admin-btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
        <span style={{ color: "#8a96b0", alignSelf: "center" }}>
          Page {page} / {totalPages}
        </span>
        <button
          className="admin-btn-sm"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function substituteVarsForPreview(tpl: string, varsJson: string): string {
  let vars: Record<string, unknown> = {};
  try { vars = JSON.parse(varsJson); } catch { /* ignore */ }
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{{${key}}}`,
  );
}

function isValidJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}
