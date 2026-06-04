import { Link } from "react-router-dom";
import { useEnabledPages } from "../context/EnabledPagesContext";
import type { PageKey } from "../api/content";

interface FooterLink {
  page: PageKey;
  to: string;
  label: string;
}

/** All possible footer links, in render order. Each is conditionally
 *  rendered based on the admin-controlled `EnabledPagesContext` — a
 *  disabled page vanishes from the footer entirely. */
const FOOTER_LINKS: readonly FooterLink[] = [
  { page: "about", to: "/about", label: "About" },
  { page: "game_modes", to: "/game-modes", label: "Game Modes" },
  { page: "faq", to: "/faq", label: "FAQ" },
  { page: "contact", to: "/contact", label: "Contact" },
  { page: "privacy", to: "/privacy", label: "Privacy Policy" },
  { page: "terms", to: "/terms", label: "Terms of Service" },
];

/**
 * Shared site footer rendered at the bottom of every top-level public
 * page. Links to admin-disabled pages are hidden entirely; if every
 * page is disabled the legal-links row collapses and only the
 * affiliate disclosure remains.
 */
export default function SiteFooter() {
  const { pages } = useEnabledPages();
  const visible = FOOTER_LINKS.filter((l) => pages[l.page] === true);

  return (
    <footer className="affiliate-disclosure">
      <span>As an Amazon Associate, this site earns from qualifying purchases.</span>
      {visible.length > 0 && (
        <span className="footer-legal-links">
          {visible.flatMap((l, i) => {
            const link = <Link key={`${l.page}-link`} to={l.to}>{l.label}</Link>;
            if (i === 0) return [link];
            const sep = (
              <span key={`${l.page}-sep`} className="footer-legal-sep">
                &middot;
              </span>
            );
            return [sep, link];
          })}
        </span>
      )}
    </footer>
  );
}
