import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import SEO from "../components/SEO";
import SiteFooter from "../components/SiteFooter";
import PageTopBar from "../components/PageTopBar";
import type { FaqContent } from "../api/content";
import { getSiteContent } from "../api/content";

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML to prevent XSS. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

/**
 * Public FAQ page. Emits FAQPage JSON-LD for rich-result eligibility so
 * Google can render the Q&A directly in search results.
 */
export default function FAQPage() {
  const navigate = useNavigate();
  const [content, setContent] = useState<FaqContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  useEffect(() => {
    getSiteContent<FaqContent>("faq")
      .then(setContent)
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, []);

  const items = content?.items ?? [];
  const title = content?.title ?? "Frequently Asked Questions";

  const jsonLd = items.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((it) => ({
          "@type": "Question",
          name: it.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: it.answer,
          },
        })),
      }
    : undefined;

  return (
    <div className="app">
      <SEO jsonLd={jsonLd} />
      <PageTopBar />
      <main className="legal-page">
        <button className="btn btn-secondary legal-back-btn" onClick={() => navigate("/")}>
          &larr; Back
        </button>
        <h1 className="legal-page-title">{title}</h1>
        {loading ? (
          <p className="legal-loading">Loading...</p>
        ) : items.length === 0 ? (
          <p className="legal-empty">No FAQ entries have been configured yet.</p>
        ) : (
          <div className="faq-list" data-testid="faq-list">
            {items.map((it, i) => {
              const open = openIndex === i;
              return (
                <details
                  key={i}
                  className="faq-item"
                  open={open}
                  onToggle={(e) => {
                    if ((e.target as HTMLDetailsElement).open) setOpenIndex(i);
                  }}
                >
                  <summary className="faq-question">{it.question}</summary>
                  <div
                    className="faq-answer legal-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(it.answer) }}
                  />
                </details>
              );
            })}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
