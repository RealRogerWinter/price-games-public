import { useState, useEffect, useRef } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { getContentDocument, updateContentDocument } from "../../api/adminClient";
import type {
  AboutContent,
  FaqContent,
  ContactContent,
  FaqItem,
  ContactSocial,
} from "../../api/content";

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

type ContentTab = "about" | "faq" | "contact";

const TABS: { key: ContentTab; label: string; path: string }[] = [
  { key: "about", label: "About", path: "/about" },
  { key: "faq", label: "FAQ", path: "/faq" },
  { key: "contact", label: "Contact", path: "/contact" },
];

const DEFAULT_ABOUT: AboutContent = { key: "about", title: "About Price Games", body: "" };
const DEFAULT_FAQ: FaqContent = { key: "faq", title: "Frequently Asked Questions", items: [] };
const DEFAULT_CONTACT: ContactContent = {
  key: "contact",
  title: "Contact Us",
  body: "",
  email: "",
  social: [],
};

/**
 * Admin page for editing the three public content documents (About, FAQ,
 * Contact). Each tab renders its own editor tuned to the document shape.
 */
export default function AdminContentPage() {
  const [activeTab, setActiveTab] = useState<ContentTab>("about");
  const [about, setAbout] = useState<AboutContent>(DEFAULT_ABOUT);
  const [faq, setFaq] = useState<FaqContent>(DEFAULT_FAQ);
  const [contact, setContact] = useState<ContactContent>(DEFAULT_CONTACT);
  const [savedAbout, setSavedAbout] = useState<AboutContent>(DEFAULT_ABOUT);
  const [savedFaq, setSavedFaq] = useState<FaqContent>(DEFAULT_FAQ);
  const [savedContact, setSavedContact] = useState<ContactContent>(DEFAULT_CONTACT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const hasUnsavedChanges =
    JSON.stringify(about) !== JSON.stringify(savedAbout) ||
    JSON.stringify(faq) !== JSON.stringify(savedFaq) ||
    JSON.stringify(contact) !== JSON.stringify(savedContact);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    Promise.all([
      getContentDocument<AboutContent>("about"),
      getContentDocument<FaqContent>("faq"),
      getContentDocument<ContactContent>("contact"),
    ])
      .then(([a, f, c]) => {
        const normalizedContact: ContactContent = {
          ...c,
          email: c.email ?? "",
          social: c.social ?? [],
        };
        setAbout(a); setSavedAbout(a);
        setFaq(f); setSavedFaq(f);
        setContact(normalizedContact); setSavedContact(normalizedContact);
      })
      .catch(() => setError("Failed to load content"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  function clearSuccessSoon() {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      if (activeTab === "about") {
        const saved = await updateContentDocument<AboutContent>("about", about);
        setSavedAbout(saved.content);
      } else if (activeTab === "faq") {
        const saved = await updateContentDocument<FaqContent>("faq", faq);
        setSavedFaq(saved.content);
      } else {
        const saved = await updateContentDocument<ContactContent>("contact", contact);
        setSavedContact({ ...saved.content, email: saved.content.email ?? "", social: saved.content.social ?? [] });
      }
      setSuccess(`${TABS.find((t) => t.key === activeTab)!.label} saved`);
      clearSuccessSoon();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading content...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-content-page" data-testid="admin-content-page">
      <h2>Site Content</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Edit the About, FAQ, and Contact pages. Markdown is supported for the body
        fields. These are publicly available at <code>/about</code>, <code>/faq</code>,
        and <code>/contact</code>.
      </p>

      {success && <div className="admin-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      <div className="admin-legal-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`admin-legal-tab ${activeTab === t.key ? "active" : ""}`}
            onClick={() => setActiveTab(t.key)}
            data-testid={`content-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="admin-legal-toolbar">
        {(activeTab === "about" || activeTab === "contact") && (
          <label className="admin-legal-preview-toggle">
            <input
              type="checkbox"
              checked={showPreview}
              onChange={(e) => setShowPreview(e.target.checked)}
            />
            Show Preview
          </label>
        )}
        <div className="admin-legal-actions">
          <button
            className="admin-legal-save-btn"
            onClick={handleSave}
            disabled={saving}
            data-testid="content-save-btn"
          >
            {saving ? "Saving..." : `Save ${TABS.find((t) => t.key === activeTab)!.label}`}
          </button>
        </div>
      </div>

      {activeTab === "about" && (
        <AboutEditor value={about} onChange={setAbout} showPreview={showPreview} render={renderMarkdown} />
      )}
      {activeTab === "faq" && (
        <FaqEditor value={faq} onChange={setFaq} render={renderMarkdown} />
      )}
      {activeTab === "contact" && (
        <ContactEditor value={contact} onChange={setContact} showPreview={showPreview} render={renderMarkdown} />
      )}
    </div>
  );
}

interface AboutEditorProps {
  value: AboutContent;
  onChange: (v: AboutContent) => void;
  showPreview: boolean;
  render: (md: string) => string;
}

function AboutEditor({ value, onChange, showPreview, render }: AboutEditorProps) {
  const preview = value.body ? render(value.body) : "";
  return (
    <>
      <label className="admin-field-label">Title</label>
      <input
        className="admin-text-input"
        type="text"
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.target.value })}
        data-testid="about-title-input"
        maxLength={200}
      />
      <div className={`admin-legal-editor-container ${showPreview ? "with-preview" : ""}`}>
        <div className="admin-legal-editor-pane">
          <textarea
            className="admin-legal-textarea"
            value={value.body}
            onChange={(e) => onChange({ ...value, body: e.target.value })}
            placeholder="Write the About page content in Markdown..."
            spellCheck
            data-testid="about-body-textarea"
          />
        </div>
        {showPreview && (
          <div className="admin-legal-preview-pane">
            <div className="admin-legal-preview-label">Preview</div>
            {value.body ? (
              <div className="legal-body" dangerouslySetInnerHTML={{ __html: preview }} />
            ) : (
              <p style={{ color: "#666", fontStyle: "italic" }}>No content to preview</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

interface FaqEditorProps {
  value: FaqContent;
  onChange: (v: FaqContent) => void;
  render: (md: string) => string;
}

function FaqEditor({ value, onChange, render }: FaqEditorProps) {
  function updateItem(index: number, patch: Partial<FaqItem>) {
    const items = value.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    onChange({ ...value, items });
  }
  function addItem() {
    onChange({ ...value, items: [...value.items, { question: "", answer: "" }] });
  }
  function removeItem(index: number) {
    onChange({ ...value, items: value.items.filter((_, i) => i !== index) });
  }
  function moveItem(index: number, dir: -1 | 1) {
    const items = [...value.items];
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    onChange({ ...value, items });
  }

  return (
    <>
      <label className="admin-field-label">Page title</label>
      <input
        className="admin-text-input"
        type="text"
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.target.value })}
        data-testid="faq-title-input"
        maxLength={200}
      />
      <div className="admin-faq-items" data-testid="faq-items">
        {value.items.length === 0 && (
          <p style={{ color: "#888", fontStyle: "italic", padding: "12px 0" }}>
            No FAQ items yet. Click "Add question" below to create the first one.
          </p>
        )}
        {value.items.map((item, i) => (
          <div key={i} className="admin-faq-item" data-testid={`faq-item-${i}`}>
            <div className="admin-faq-item-controls">
              <span className="admin-faq-item-index">#{i + 1}</span>
              <button
                className="admin-faq-btn-move"
                disabled={i === 0}
                onClick={() => moveItem(i, -1)}
                aria-label="Move up"
              >&uarr;</button>
              <button
                className="admin-faq-btn-move"
                disabled={i === value.items.length - 1}
                onClick={() => moveItem(i, 1)}
                aria-label="Move down"
              >&darr;</button>
              <button
                className="admin-faq-btn-remove"
                onClick={() => removeItem(i)}
                aria-label="Remove"
              >Remove</button>
            </div>
            <label className="admin-field-label">Question</label>
            <input
              className="admin-text-input"
              type="text"
              value={item.question}
              onChange={(e) => updateItem(i, { question: e.target.value })}
              placeholder="e.g., How is scoring calculated?"
              maxLength={300}
            />
            <label className="admin-field-label" style={{ marginTop: 8 }}>Answer (Markdown)</label>
            <textarea
              className="admin-legal-textarea"
              style={{ minHeight: 90 }}
              value={item.answer}
              onChange={(e) => updateItem(i, { answer: e.target.value })}
              placeholder="Write the answer in Markdown..."
            />
            {item.answer && (
              <div className="admin-faq-preview">
                <span className="admin-legal-preview-label">Preview</span>
                <div className="legal-body" dangerouslySetInnerHTML={{ __html: render(item.answer) }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="admin-legal-save-btn" onClick={addItem} data-testid="faq-add-btn" style={{ marginTop: 12 }}>
        + Add question
      </button>
    </>
  );
}

interface ContactEditorProps {
  value: ContactContent;
  onChange: (v: ContactContent) => void;
  showPreview: boolean;
  render: (md: string) => string;
}

function ContactEditor({ value, onChange, showPreview, render }: ContactEditorProps) {
  const social: ContactSocial[] = value.social ?? [];
  const preview = value.body ? render(value.body) : "";
  function updateSocial(index: number, patch: Partial<ContactSocial>) {
    const next = social.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange({ ...value, social: next });
  }
  function addSocial() {
    onChange({ ...value, social: [...social, { label: "", url: "" }] });
  }
  function removeSocial(index: number) {
    onChange({ ...value, social: social.filter((_, i) => i !== index) });
  }
  return (
    <>
      <label className="admin-field-label">Title</label>
      <input
        className="admin-text-input"
        type="text"
        value={value.title}
        onChange={(e) => onChange({ ...value, title: e.target.value })}
        data-testid="contact-title-input"
        maxLength={200}
      />
      <label className="admin-field-label" style={{ marginTop: 8 }}>Public contact email (optional)</label>
      <input
        className="admin-text-input"
        type="email"
        value={value.email ?? ""}
        onChange={(e) => onChange({ ...value, email: e.target.value })}
        placeholder="hello@price.games"
        data-testid="contact-email-input"
        maxLength={200}
      />
      <label className="admin-field-label" style={{ marginTop: 8 }}>Body (Markdown)</label>
      <div className={`admin-legal-editor-container ${showPreview ? "with-preview" : ""}`}>
        <div className="admin-legal-editor-pane">
          <textarea
            className="admin-legal-textarea"
            value={value.body}
            onChange={(e) => onChange({ ...value, body: e.target.value })}
            placeholder="Write the Contact page body in Markdown..."
            spellCheck
            data-testid="contact-body-textarea"
          />
        </div>
        {showPreview && (
          <div className="admin-legal-preview-pane">
            <div className="admin-legal-preview-label">Preview</div>
            {value.body ? (
              <div className="legal-body" dangerouslySetInnerHTML={{ __html: preview }} />
            ) : (
              <p style={{ color: "#666", fontStyle: "italic" }}>No content to preview</p>
            )}
          </div>
        )}
      </div>

      <label className="admin-field-label" style={{ marginTop: 16 }}>Social / external links</label>
      <p style={{ fontSize: "0.8rem", color: "#888", marginBottom: 8 }}>
        URLs must start with <code>http://</code> or <code>https://</code>. Leave empty and save to remove.
      </p>
      <div className="admin-social-links" data-testid="contact-social-list">
        {social.map((s, i) => (
          <div key={i} className="admin-social-row">
            <input
              className="admin-text-input"
              type="text"
              value={s.label}
              onChange={(e) => updateSocial(i, { label: e.target.value })}
              placeholder="Label (e.g., Twitter)"
              style={{ maxWidth: 200 }}
              maxLength={40}
            />
            <input
              className="admin-text-input"
              type="url"
              value={s.url}
              onChange={(e) => updateSocial(i, { url: e.target.value })}
              placeholder="https://..."
              maxLength={500}
            />
            <button
              className="admin-faq-btn-remove"
              onClick={() => removeSocial(i)}
              aria-label="Remove"
            >Remove</button>
          </div>
        ))}
      </div>
      <button className="admin-legal-save-btn" onClick={addSocial} data-testid="contact-add-social" style={{ marginTop: 10 }}>
        + Add social link
      </button>
    </>
  );
}
