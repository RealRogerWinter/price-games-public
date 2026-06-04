import { useState, useEffect, useRef } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { getLegalDocument, updateLegalDocument } from "../../api/adminClient";

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML to prevent XSS. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

type DocKey = "privacy_policy" | "terms_of_service";

const DOCS: { key: DocKey; label: string }[] = [
  { key: "privacy_policy", label: "Privacy Policy" },
  { key: "terms_of_service", label: "Terms of Service" },
];

/**
 * Admin page for editing the site's Privacy Policy and Terms of Service.
 * Provides a side-by-side markdown editor and live preview.
 */
export default function AdminLegalPage() {
  const [activeDoc, setActiveDoc] = useState<DocKey>("privacy_policy");
  const [content, setContent] = useState<Record<DocKey, string>>({
    privacy_policy: "",
    terms_of_service: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [savedContent, setSavedContent] = useState<Record<DocKey, string>>({
    privacy_policy: "",
    terms_of_service: "",
  });
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Track whether content has unsaved changes
  const hasUnsavedChanges =
    content.privacy_policy !== savedContent.privacy_policy ||
    content.terms_of_service !== savedContent.terms_of_service;

  // Warn before navigating away with unsaved changes
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    Promise.all(
      DOCS.map((doc) =>
        getLegalDocument(doc.key).then((res) => ({ key: doc.key, content: res.content }))
      )
    )
      .then((results) => {
        const newContent = { ...content };
        for (const r of results) {
          newContent[r.key] = r.content;
        }
        setContent(newContent);
        setSavedContent(newContent);
      })
      .catch(() => setError("Failed to load legal documents"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  function clearSuccess() {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      await updateLegalDocument(activeDoc, content[activeDoc]);
      setSavedContent((prev) => ({ ...prev, [activeDoc]: content[activeDoc] }));
      const label = DOCS.find((d) => d.key === activeDoc)!.label;
      setSuccess(`${label} saved`);
      clearSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAll() {
    try {
      setSaving(true);
      setError(null);
      await Promise.all(
        DOCS.map((doc) => updateLegalDocument(doc.key, content[doc.key]))
      );
      setSavedContent({ ...content });
      setSuccess("All documents saved");
      clearSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const previewHtml = content[activeDoc] ? renderMarkdown(content[activeDoc]) : "";

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading legal documents...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-legal-page" data-testid="admin-legal-page">
      <h2>Legal Documents</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Edit the Privacy Policy and Terms of Service. Content is written in Markdown.
        These are publicly available at <code>/privacy</code> and <code>/terms</code>.
      </p>

      {success && <div className="admin-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      <div className="admin-legal-tabs">
        {DOCS.map((doc) => (
          <button
            key={doc.key}
            className={`admin-legal-tab ${activeDoc === doc.key ? "active" : ""}`}
            onClick={() => setActiveDoc(doc.key)}
            data-testid={`legal-tab-${doc.key}`}
          >
            {doc.label}
          </button>
        ))}
      </div>

      <div className="admin-legal-toolbar">
        <label className="admin-legal-preview-toggle">
          <input
            type="checkbox"
            checked={showPreview}
            onChange={(e) => setShowPreview(e.target.checked)}
          />
          Show Preview
        </label>
        <div className="admin-legal-actions">
          <button
            className="admin-legal-save-btn"
            onClick={handleSave}
            disabled={saving}
            data-testid="legal-save-btn"
          >
            {saving ? "Saving..." : `Save ${DOCS.find((d) => d.key === activeDoc)!.label}`}
          </button>
          <button
            className="admin-legal-save-all-btn"
            onClick={handleSaveAll}
            disabled={saving}
            data-testid="legal-save-all-btn"
          >
            {saving ? "Saving..." : "Save All"}
          </button>
        </div>
      </div>

      <div className={`admin-legal-editor-container ${showPreview ? "with-preview" : ""}`}>
        <div className="admin-legal-editor-pane">
          <textarea
            className="admin-legal-textarea"
            value={content[activeDoc]}
            onChange={(e) =>
              setContent({ ...content, [activeDoc]: e.target.value })
            }
            placeholder={`Enter ${DOCS.find((d) => d.key === activeDoc)!.label} content in Markdown...`}
            spellCheck
            data-testid="legal-textarea"
          />
        </div>
        {showPreview && (
          <div className="admin-legal-preview-pane">
            <div className="admin-legal-preview-label">Preview</div>
            {content[activeDoc] ? (
              <div
                className="legal-body"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <p style={{ color: "#666", fontStyle: "italic" }}>No content to preview</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
