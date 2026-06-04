import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type { PageKey } from "../api/content";
import { useEnabledPages } from "../context/EnabledPagesContext";
import SEO from "./SEO";
import PageTopBar from "./PageTopBar";
import SiteFooter from "./SiteFooter";

interface Props {
  page: PageKey;
  children: ReactNode;
}

/**
 * Gate a route on the admin page-visibility toggle. When the requested
 * page is disabled, render an in-app 404 shell (with the top nav + site
 * footer for consistency) instead of the page's children.
 *
 * While the initial visibility fetch is in flight, render nothing —
 * avoids a brief flash of the real page contents before we know it's
 * been disabled.
 */
export default function RequireEnabled({ page, children }: Props) {
  const { pages, loading } = useEnabledPages();

  if (loading) {
    return (
      <div className="app">
        <PageTopBar />
      </div>
    );
  }

  if (pages[page] === true) {
    return <>{children}</>;
  }

  // Server-side meta injection already forces `noindex` for this path
  // when the page is disabled, but render a local <SEO noindex /> too
  // so the client-side Helmet override stays consistent during SPA
  // navigations.
  return (
    <div className="app">
      <SEO title="Page not available" description="This page is not available." noindex />
      <PageTopBar />
      <div className="legal-page">
        <h1 className="legal-page-title">Page not available</h1>
        <p className="legal-empty">
          This page is not currently available. Head back home to keep playing.
        </p>
        <div style={{ marginTop: 16 }}>
          <Link to="/" className="btn btn-primary">Back to Home</Link>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
