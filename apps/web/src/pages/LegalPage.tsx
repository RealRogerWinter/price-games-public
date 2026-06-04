import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import SEO from "../components/SEO";
import SiteFooter from "../components/SiteFooter";
import PageTopBar from "../components/PageTopBar";

/**
 * Standalone page for displaying a legal document (privacy policy or terms of service).
 * Fetches the document from the public API and renders it as HTML from markdown.
 * Also usable as a modal overlay when `isModal` is true.
 *
 * @param props.docKey - The legal document key ("privacy_policy" or "terms_of_service").
 * @param props.title - Display title for the document.
 * @param props.isModal - Whether to render as a modal overlay (default: false).
 * @param props.onClose - Callback when the modal is closed (required if isModal).
 */
interface LegalPageProps {
  docKey: "privacy_policy" | "terms_of_service";
  title: string;
  isModal?: boolean;
  onClose?: () => void;
}

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML to prevent XSS. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

export default function LegalPage({ docKey, title, isModal, onClose }: LegalPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/settings/legal/${docKey}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.content) setContent(data.content);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [docKey]);

  const html = content ? renderMarkdown(content) : "";

  function handleClose() {
    if (onClose) {
      onClose();
    } else if (location.key !== "default") {
      navigate(-1);
    } else {
      navigate("/");
    }
  }

  if (isModal) {
    return (
      <div className="legal-modal-overlay" onClick={handleClose}>
        <div className="legal-modal-content" onClick={(e) => e.stopPropagation()}>
          <button className="legal-modal-close" onClick={handleClose}>&times;</button>
          <h2 className="legal-modal-title">{title}</h2>
          {loading ? (
            <p className="legal-loading">Loading...</p>
          ) : content ? (
            <div
              className="legal-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <p className="legal-empty">This document has not been configured yet.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {!isModal && <SEO />}
      {!isModal && <PageTopBar />}
      <main className="legal-page">
        <button className="btn btn-secondary legal-back-btn" onClick={handleClose}>
          &larr; Back
        </button>
        <h1 className="legal-page-title">{title}</h1>
        {loading ? (
          <p className="legal-loading">Loading...</p>
        ) : content ? (
          <div
            className="legal-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="legal-empty">This document has not been configured yet.</p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
