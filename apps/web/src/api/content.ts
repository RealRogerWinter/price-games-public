/**
 * Public API for site content pages (About, FAQ, Contact).
 *
 * Mirrors the types used server-side so components have a strong type for
 * the JSON shape they render.
 */

export interface AboutContent {
  key: "about";
  title: string;
  body: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqContent {
  key: "faq";
  title: string;
  items: FaqItem[];
}

export interface ContactSocial {
  label: string;
  url: string;
}

export interface ContactContent {
  key: "contact";
  title: string;
  body: string;
  email?: string;
  social?: ContactSocial[];
}

export type ContentKey = "about" | "faq" | "contact";

/**
 * Fetch a public site content document by key.
 * @throws Error if the response is non-OK.
 */
export async function getSiteContent<T>(key: ContentKey): Promise<T> {
  const res = await fetch(`/api/content/${key}`);
  if (!res.ok) {
    throw new Error(`Failed to load content: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Canonical keys for the six admin-toggleable public SEO pages. */
export type PageKey =
  | "about"
  | "faq"
  | "contact"
  | "game_modes"
  | "privacy"
  | "terms";

/** Map of page key → boolean visibility flag. Missing keys are treated
 *  as disabled so callers don't need to special-case an incomplete map. */
export type EnabledPages = Record<PageKey, boolean>;

/**
 * Fetch the public visibility map for the six SEO pages. Returns an
 * all-disabled map on any error so the UI stays conservative — a
 * hiccup with the API should never accidentally expose a page.
 */
export async function getEnabledPages(): Promise<EnabledPages> {
  const allDisabled: EnabledPages = {
    about: false,
    faq: false,
    contact: false,
    game_modes: false,
    privacy: false,
    terms: false,
  };
  try {
    const res = await fetch("/api/content/pages-enabled");
    if (!res.ok) return allDisabled;
    const data = (await res.json()) as { pages?: Partial<EnabledPages> };
    const pages = data.pages ?? {};
    return {
      about: pages.about === true,
      faq: pages.faq === true,
      contact: pages.contact === true,
      game_modes: pages.game_modes === true,
      privacy: pages.privacy === true,
      terms: pages.terms === true,
    };
  } catch {
    return allDisabled;
  }
}
