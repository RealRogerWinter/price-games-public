/**
 * Cookie-consent preferences stored in localStorage.
 *
 * Categories:
 *  - necessary: site-functionality cookies. Default on; toggleable so users
 *    who click "Reject all" get a consistent UI, but keeps the explicit opt-in.
 *  - analytics: Google Analytics / tracking / marketing pixels.
 *  - advertising: ad-network cookies/signals (e.g. Google AdSense). Default
 *    off, same as analytics — required before any ad request can legally
 *    fire for EEA/UK visitors under Google Consent Mode v2.
 */

import { useState, useEffect } from "react";

const STORAGE_KEY = "cookie_consent";

/** Fired whenever preferences are written, so components elsewhere in the
 * tree can react without polling localStorage. Mirrors the
 * "open-cookie-settings" custom-event idiom used by CookieConsent.tsx. */
const CHANGE_EVENT = "cookie-consent-changed";

export interface CookiePreferences {
  /** User has made an active choice (banner dismissed). */
  consented: boolean;
  necessary: boolean;
  analytics: boolean;
  advertising: boolean;
}

const DEFAULTS: CookiePreferences = {
  consented: false,
  necessary: true,
  analytics: false,
  advertising: false,
};

/** Read stored preferences, or return defaults if none exist. */
export function getPreferences(): CookiePreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Legacy records (pre-"necessary" field) implicitly opted in to necessary
    // cookies — treat a missing field as true so they don't get flipped off on
    // their next visit.
    const necessary =
      typeof parsed.necessary === "boolean" ? parsed.necessary : true;
    return {
      consented: parsed.consented === true,
      necessary,
      analytics: parsed.analytics === true,
      // Records saved before the "advertising" category existed have no
      // such field — treat that (and any non-boolean garbage) as not
      // consented, same as analytics, consistent with default-to-denied.
      advertising: parsed.advertising === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist preferences to localStorage. */
export function savePreferences(prefs: CookiePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Convenience: has the user made a choice yet? */
export function hasConsented(): boolean {
  return getPreferences().consented;
}

/**
 * Reactive hook for current cookie preferences. Reads on mount and
 * re-renders whenever savePreferences() writes a new value anywhere in the
 * tree (via the "cookie-consent-changed" custom event) — lets components
 * outside CookieConsent itself (e.g. an ad-slot component) react to
 * consent changes without prop drilling.
 */
export function useConsentPreferences(): CookiePreferences {
  const [prefs, setPrefs] = useState<CookiePreferences>(getPreferences);

  useEffect(() => {
    const handler = () => setPrefs(getPreferences());
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);

  return prefs;
}
