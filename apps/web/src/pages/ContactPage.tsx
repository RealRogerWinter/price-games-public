import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import SEO from "../components/SEO";
import SiteFooter from "../components/SiteFooter";
import PageTopBar from "../components/PageTopBar";
import type { ContactContent } from "../api/content";
import { getSiteContent } from "../api/content";

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML to prevent XSS. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

/**
 * Public Contact page. Renders the admin-editable body, optional email
 * link, and a list of social links configured in the admin panel.
 */
export default function ContactPage() {
  const navigate = useNavigate();
  const [content, setContent] = useState<ContactContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSiteContent<ContactContent>("contact")
      .then(setContent)
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, []);

  const title = content?.title ?? "Contact Us";
  const html = content?.body ? renderMarkdown(content.body) : "";
  const social = content?.social ?? [];

  return (
    <div className="app">
      <SEO />
      <PageTopBar />
      <main className="legal-page">
        <button className="btn btn-secondary legal-back-btn" onClick={() => navigate("/")}>
          &larr; Back
        </button>
        <h1 className="legal-page-title">{title}</h1>
        {loading ? (
          <p className="legal-loading">Loading...</p>
        ) : !content ? (
          <p className="legal-empty">Contact information has not been configured yet.</p>
        ) : (
          <>
            {html && <div className="legal-body" dangerouslySetInnerHTML={{ __html: html }} />}
            {(content.email || social.length > 0) && (
              <div className="contact-links" data-testid="contact-links">
                {content.email && (
                  <p className="contact-email">
                    Email: <a href={`mailto:${content.email}`}>{content.email}</a>
                  </p>
                )}
                {social.length > 0 && (
                  <ul className="contact-social">
                    {social.map((s, i) => (
                      <li key={i}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
