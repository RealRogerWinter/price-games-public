/**
 * Content script — runs on Amazon product pages and (when injected on-demand) any e-commerce page.
 * Scrapes product data from the live DOM and responds to messages from the popup.
 */
import { extractAsinFromUrl, parsePriceToCents, cleanTitle, cleanManufacturer, mapBreadcrumbsToCategory, upgradeImageUrl } from "./scraper";

export interface ScrapedProduct {
  asin: string | null;
  title: string | null;
  priceCents: number | null;
  imageUrl: string | null;
  manufacturer: string | null;
  description: string | null;
  category: string | null;
}

/** Raw structured data collected from the DOM for product detection. */
export interface RawStructuredData {
  jsonLdScripts: string[];
  metaTags: { property: string; content: string }[];
  microdataItems: { type: string; properties: Record<string, string> }[];
}

function scrapeProduct(): ScrapedProduct {
  const asin = extractAsinFromUrl(window.location.href);
  const titleEl = document.getElementById("productTitle");
  const title = titleEl ? cleanTitle(titleEl.textContent || "") : null;

  let priceCents: number | null = null;
  for (const sel of [".a-price .a-offscreen", "#corePrice_feature_div .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice"]) {
    const el = document.querySelector(sel);
    if (el?.textContent) { priceCents = parsePriceToCents(el.textContent); if (priceCents !== null) break; }
  }

  let imageUrl: string | null = null;
  const imgEl = document.getElementById("landingImage") as HTMLImageElement | null;
  if (imgEl) { imageUrl = imgEl.getAttribute("data-old-hires") || imgEl.src || null; if (imageUrl) imageUrl = upgradeImageUrl(imageUrl); }

  let manufacturer: string | null = null;
  const bylineEl = document.getElementById("bylineInfo");
  if (bylineEl?.textContent) manufacturer = cleanManufacturer(bylineEl.textContent);

  let description: string | null = null;
  const descEl = document.getElementById("productDescription");
  if (descEl?.textContent?.trim()) { description = descEl.textContent.trim(); }
  else { const bullets = document.querySelectorAll("#feature-bullets li .a-list-item"); if (bullets.length > 0) description = Array.from(bullets).map((li) => li.textContent?.trim()).filter(Boolean).join(" | "); }

  let category: string | null = null;
  const crumbEls = document.querySelectorAll("#wayfinding-breadcrumbs_feature_div .a-link-normal");
  if (crumbEls.length > 0) category = mapBreadcrumbsToCategory(Array.from(crumbEls).map((el) => el.textContent?.trim() || "").filter(Boolean));

  return { asin, title, priceCents, imageUrl, manufacturer, description, category };
}

/**
 * Collect raw structured data from the DOM for product detection.
 *
 * Returns the raw JSON-LD, Open Graph, and microdata so the popup can run
 * detectProduct() in its own module context (avoiding code-splitting issues).
 */
function collectStructuredData(): RawStructuredData {
  const jsonLdScripts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).map((el) => el.textContent || "");

  const metaTags = Array.from(
    document.querySelectorAll('meta[property^="og:"], meta[property^="product:"]'),
  ).map((el) => ({
    property: el.getAttribute("property")!,
    content: el.getAttribute("content") || "",
  }));

  const microdataItems = Array.from(
    document.querySelectorAll('[itemtype*="schema.org/Product"]'),
  ).map((el) => ({
    type: el.getAttribute("itemtype") || "",
    properties: Object.fromEntries(
      Array.from(el.querySelectorAll("[itemprop]")).map((p) => [
        p.getAttribute("itemprop")!,
        p.getAttribute("content") || p.textContent?.trim() || "",
      ]),
    ),
  }));

  return { jsonLdScripts, metaTags, microdataItems };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === "SCRAPE_PRODUCT") {
    sendResponse(scrapeProduct());
  } else if (message.type === "DETECT_PRODUCT") {
    sendResponse(collectStructuredData());
  } else {
    sendResponse(null);
  }
  return true;
});
