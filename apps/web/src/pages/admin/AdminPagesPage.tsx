import { useEffect, useRef, useState } from "react";
import {
  getEnabledPagesAdmin,
  updateEnabledPagesAdmin,
  type AdminEnabledPages,
} from "../../api/adminClient";
import { useEnabledPages } from "../../context/EnabledPagesContext";

/** Row descriptor for each of the six toggleable SEO pages. The `url`
 *  is shown alongside the label so the admin can see at a glance what
 *  public URL each toggle controls. */
interface PageRow {
  key: keyof AdminEnabledPages;
  label: string;
  url: string;
  description: string;
}

const PAGE_ROWS: readonly PageRow[] = [
  {
    key: "about",
    label: "About",
    url: "/about",
    description: "Editable marketing page describing the site and team.",
  },
  {
    key: "faq",
    label: "FAQ",
    url: "/faq",
    description: "Frequently asked questions (editable) with FAQPage JSON-LD.",
  },
  {
    key: "contact",
    label: "Contact",
    url: "/contact",
    description: "Contact info, email, and social links (editable).",
  },
  {
    key: "game_modes",
    label: "Game Modes",
    url: "/game-modes",
    description: "All game modes with rules + strategy tips.",
  },
  {
    key: "privacy",
    label: "Privacy Policy",
    url: "/privacy",
    description: "Editable markdown privacy policy.",
  },
  {
    key: "terms",
    label: "Terms of Service",
    url: "/terms",
    description: "Editable markdown terms of service.",
  },
];

const ALL_DISABLED: AdminEnabledPages = {
  about: false,
  faq: false,
  contact: false,
  game_modes: false,
  privacy: false,
  terms: false,
};

/**
 * Admin page that enables/disables each of the six public SEO pages.
 * Disabled pages are removed from the footer, the sitemap, and return
 * 404 when requested. Defaults for a fresh deploy are all-disabled —
 * the admin opts each page in after populating its content.
 */
export default function AdminPagesPage() {
  const [pages, setPages] = useState<AdminEnabledPages>(ALL_DISABLED);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const { refresh: refreshPublicPages } = useEnabledPages();

  useEffect(() => {
    getEnabledPagesAdmin()
      .then((data) => setPages(data.pages))
      .catch(() => setError("Failed to load page visibility"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  function toggle(key: keyof AdminEnabledPages) {
    setPages((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      const result = await updateEnabledPagesAdmin(pages);
      setPages(result.pages);
      // Ask the public-side context to re-fetch so the footer and route
      // guards immediately reflect the new flags without a hard reload.
      // Best-effort — a failure here doesn't block the save confirmation.
      refreshPublicPages().catch(() => {});
      setSuccess("Page visibility saved");
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save page visibility");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading page visibility...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-pages-page" data-testid="admin-pages-page">
      <h2>Public Pages</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Control which public SEO pages are reachable. Disabled pages are
        hidden from the footer, removed from <code>/sitemap.xml</code>, and
        return a 404. Enable a page only after its content is populated.
      </p>

      {success && <div className="admin-success">{success}</div>}
      {error && (
        <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="admin-section" data-testid="admin-pages-grid">
        <div className="game-modes-grid">
          {PAGE_ROWS.map(({ key, label, url, description }) => {
            const enabled = pages[key] === true;
            return (
              <div
                key={key}
                className={`game-mode-card ${enabled ? "game-mode-enabled" : "game-mode-disabled"}`}
                data-testid={`admin-page-card-${key}`}
              >
                <div className="game-mode-card-header">
                  <span className="game-mode-card-name">
                    {label} <span style={{ fontWeight: 400, color: "#888", fontSize: "0.8rem" }}>({url})</span>
                  </span>
                  <label className="game-mode-toggle" data-testid={`admin-page-toggle-${key}`}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => toggle(key)}
                    />
                    <span className="game-mode-toggle-slider" />
                  </label>
                </div>
                <p className="game-mode-card-desc">{description}</p>
                <span
                  className={`game-mode-card-status ${enabled ? "status-enabled" : "status-disabled"}`}
                >
                  {enabled ? "Visible" : "Hidden"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button
          className="admin-btn-primary"
          onClick={handleSave}
          disabled={saving}
          data-testid="admin-pages-save"
        >
          {saving ? "Saving..." : "Save Page Visibility"}
        </button>
      </div>
    </div>
  );
}
