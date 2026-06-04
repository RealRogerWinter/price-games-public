import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import SEO from "../components/SEO";
import SiteFooter from "../components/SiteFooter";
import PageTopBar from "../components/PageTopBar";
import type { AboutContent } from "../api/content";
import { getSiteContent } from "../api/content";
import heroReveal from "../assets/about/hero-reveal.webp";
import modesCollage from "../assets/about/modes-collage.webp";
import catalogBox from "../assets/about/catalog-box.webp";
import indieWorkspace from "../assets/about/indie-workspace.webp";
import treasureChest from "../assets/signup-cta/treasure-chest.webp";

const markedInstance = new Marked({ breaks: true, gfm: true });

/** Parse markdown and sanitize HTML to prevent XSS. */
function renderMarkdown(md: string): string {
  const raw = markedInstance.parse(md);
  return DOMPurify.sanitize(raw as string);
}

interface Section {
  heading: string;
  body: string;
}

interface ParsedAbout {
  title: string | null;
  lead: string;
  sections: Section[];
}

/**
 * Split the About markdown into a lead paragraph (before the first `##`)
 * and an ordered list of top-level sections so each can be rendered in its
 * own card with a themed illustration. The document title (the first `# `
 * line) is extracted so the page can decorate it separately from body copy.
 *
 * Tracks fenced code-block state so `## ` appearing inside ``` blocks is
 * treated as literal content instead of a section boundary.
 */
export function parseAbout(md: string): ParsedAbout {
  const lines = md.split("\n");
  let i = 0;
  let title: string | null = null;
  let inFence = false;

  const isFenceToggle = (line: string): boolean => /^\s{0,3}(```|~~~)/.test(line);
  const isH2 = (line: string, fenced: boolean): boolean =>
    !fenced && line.startsWith("## ");

  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.startsWith("# ")) {
    title = lines[i].slice(2).trim();
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
  }

  const leadLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (isFenceToggle(line)) inFence = !inFence;
    else if (isH2(line, inFence)) break;
    leadLines.push(line);
    i++;
  }

  const sections: Section[] = [];
  let current: Section | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceToggle(line)) inFence = !inFence;
    if (isH2(line, inFence)) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), body: "" };
    } else if (current) {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  if (current) sections.push(current);

  return { title, lead: leadLines.join("\n").trim(), sections };
}

/** Match a top-level section heading to a themed illustration. */
function imageForSection(heading: string): string | null {
  const h = heading.toLowerCase();
  if (h.includes("what is")) return modesCollage;
  if (h.includes("how the game works")) return null;
  if (h.includes("where the prices")) return catalogBox;
  if (h.includes("giveaway")) return treasureChest;
  if (h.includes("who we are")) return indieWorkspace;
  return null;
}

/**
 * Public About page. Content is editable via /admin/content and rendered
 * from markdown. The markdown is split into sections so each can be paired
 * with a themed illustration and a card treatment. Copy is never altered —
 * if the markdown doesn't parse into sections, the whole body is rendered
 * inside a single card as a fallback.
 */
export default function AboutPage() {
  const navigate = useNavigate();
  const [content, setContent] = useState<AboutContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSiteContent<AboutContent>("about")
      .then(setContent)
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, []);

  const parsed = useMemo<ParsedAbout | null>(
    () => (content?.body ? parseAbout(content.body) : null),
    [content?.body],
  );

  const pageTitle = parsed?.title ?? content?.title ?? "About Price Games";

  return (
    <div className="app">
      <SEO />
      <PageTopBar />
      <main className="legal-page about-page">
        <button
          className="btn btn-secondary legal-back-btn"
          onClick={() => navigate("/")}
        >
          &larr; Back
        </button>

        {loading ? (
          <p className="legal-loading">Loading...</p>
        ) : parsed && parsed.sections.length > 0 ? (
          <>
            <header className="about-hero">
              <div className="about-hero-text">
                <h1 className="about-hero-title">{pageTitle}</h1>
                {parsed.lead && (
                  <div
                    className="about-hero-lead"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(parsed.lead),
                    }}
                  />
                )}
              </div>
              <figure className="about-hero-figure">
                <img src={heroReveal} alt="" loading="eager" />
              </figure>
            </header>

            {parsed.sections.map((section, i) => {
              const img = imageForSection(section.heading);
              const isGiveaway = section.heading.toLowerCase().includes("giveaway");
              // Giveaway card pins image to the right so the treasure chest
              // doesn't dominate the card — everywhere else alternates.
              const imageRight = isGiveaway ? true : i % 2 === 0;
              const layoutClass = img
                ? imageRight
                  ? "about-section--image-right"
                  : "about-section--image-left"
                : "about-section--no-image";
              const variantClass = isGiveaway ? " about-section--giveaway" : "";
              return (
                <section
                  key={`${i}-${section.heading}`}
                  className={`about-section ${layoutClass}${variantClass}`}
                >
                  <div className="about-section-text">
                    <h2 className="about-section-title">{section.heading}</h2>
                    <div
                      className="legal-body about-section-body"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(section.body),
                      }}
                    />
                  </div>
                  {img && (
                    <figure className="about-section-figure">
                      <img src={img} alt="" loading="lazy" />
                    </figure>
                  )}
                </section>
              );
            })}
          </>
        ) : content && content.body ? (
          <>
            <h1 className="legal-page-title">{pageTitle}</h1>
            <div
              className="legal-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content.body) }}
            />
          </>
        ) : (
          <>
            <h1 className="legal-page-title">{pageTitle}</h1>
            <p className="legal-empty">This page has not been configured yet.</p>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
