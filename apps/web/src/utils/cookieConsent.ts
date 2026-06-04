/**
 * Cookie-consent preferences stored in localStorage.
 *
 * Categories:
 *  - necessary: site-functionality cookies. Default on; toggleable so users
 *    who click "Reject all" get a consistent UI, but keeps the explicit opt-in.
 *  - analytics: Google Analytics / tracking / marketing pixels.
 */

const STORAGE_KEY = "cookie_consent";

export interface CookiePreferences {
  /** User has made an active choice (banner dismissed). */
  consented: boolean;
  necessary: boolean;
  analytics: boolean;
}

const DEFAULTS: CookiePreferences = {
  consented: false,
  necessary: true,
  analytics: false,
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
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist preferences to localStorage. */
export function savePreferences(prefs: CookiePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/** Convenience: has the user made a choice yet? */
export function hasConsented(): boolean {
  return getPreferences().consented;
}
