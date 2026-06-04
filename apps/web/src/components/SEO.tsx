import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import {
  canonicalUrl,
  resolveSeoMeta,
  SITE_NAME,
  SITE_OG_IMAGE,
} from "@price-game/shared";

interface SEOProps {
  /** Override the page title. When omitted, resolved from the current pathname. */
  title?: string;
  /** Override the meta description. */
  description?: string;
  /** Override the canonical URL. Defaults to SITE_ORIGIN + current pathname. */
  canonical?: string;
  /** OG image URL (absolute). Defaults to the site's standard og-image.png. */
  image?: string;
  /** When true, adds <meta name="robots" content="noindex,nofollow">. */
  noindex?: boolean;
  /** Optional JSON-LD structured data to embed as a <script type="application/ld+json">. */
  jsonLd?: object | object[];
}

/**
 * Renders <head> metadata for the current route: title, description,
 * canonical, OG/Twitter tags, and optional JSON-LD. Overrides the
 * server-injected defaults during client-side navigation.
 *
 * Falls back to the SEO registry (`packages/shared/src/seo.ts`) when
 * no explicit title/description is passed — so a page can render
 * <SEO /> with no props and still get route-appropriate meta.
 */
export function SEO({
  title,
  description,
  canonical,
  image,
  noindex,
  jsonLd,
}: SEOProps) {
  const location = useLocation();
  const resolved = resolveSeoMeta(location.pathname);
  const finalTitle = title ?? resolved.title;
  const finalDescription = description ?? resolved.description;
  const finalCanonical = canonical ?? canonicalUrl(location.pathname);
  const finalImage = image ?? SITE_OG_IMAGE;
  const finalNoindex = noindex ?? resolved.noindex ?? false;

  const ldItems = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];

  return (
    <Helmet>
      <title>{finalTitle}</title>
      <meta name="description" content={finalDescription} />
      <link rel="canonical" href={finalCanonical} />
      {finalNoindex && <meta name="robots" content="noindex,nofollow" />}

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={finalTitle} />
      <meta property="og:description" content={finalDescription} />
      <meta property="og:url" content={finalCanonical} />
      <meta property="og:image" content={finalImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={finalTitle} />
      <meta name="twitter:description" content={finalDescription} />
      <meta name="twitter:image" content={finalImage} />

      {ldItems.map((item, i) => (
        <script key={i} type="application/ld+json">
          {/* Escape any literal </script> in the JSON to prevent it from
              prematurely terminating the block if admin content ever
              contains that sequence. */}
          {JSON.stringify(item).replace(/<\/script>/gi, "<\\/script>")}
        </script>
      ))}
    </Helmet>
  );
}

export default SEO;
