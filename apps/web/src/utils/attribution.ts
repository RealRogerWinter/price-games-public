/**
 * UTM attribution capture — client-side.
 *
 * Parses UTM query params from the landing URL and stores them in sessionStorage
 * so they can be attached to signup requests later in the session.
 *
 * Follows a first-touch-wins model: once attribution is stored, subsequent
 * captures are no-ops. This preserves the original ad click source even if
 * the user navigates through internal links before signing up.
 *
 * Mirrors the existing `referral_code` pattern in App.tsx:ReferralRedirect.
 */

const STORAGE_KEY = "utm_attribution";
const MAX_VALUE_LENGTH = 128;

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

type UtmKey = (typeof UTM_KEYS)[number];

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  landing_page?: string;
  referrer?: string;
}

/** Clamp a string to MAX_VALUE_LENGTH characters to prevent storage abuse. */
function clamp(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
}

/**
 * Capture UTM attribution from a URL query string and store it in sessionStorage.
 *
 * First-touch wins: if attribution is already stored this session, this is a no-op.
 * Only stores data when at least one UTM parameter is present in the URL — direct
 * visits with no tracking params are ignored so we don't pollute storage.
 *
 * @param search - URL query string (including the leading `?`). Defaults to
 *                 `window.location.search`.
 */
export function captureUtmFromUrl(search: string = window.location.search): void {
  // First-touch wins — don't overwrite existing attribution in the same session.
  if (sessionStorage.getItem(STORAGE_KEY) !== null) return;

  const params = new URLSearchParams(search);
  const attribution: Attribution = {};

  for (const key of UTM_KEYS) {
    const raw = params.get(key);
    if (raw && raw.length > 0) {
      (attribution as Record<UtmKey, string>)[key] = clamp(raw);
    }
  }

  // utm_source is required — without it, the server-side first-touch-wins
  // guard (`utm_source IS NULL`) cannot distinguish "not yet attributed"
  // from "partially attributed". Capturing a payload without utm_source
  // here would round-trip to the server only to be rejected anyway.
  if (!attribution.utm_source) return;

  // Capture landing context as extras (always safe because utm_source is set).
  if (typeof window !== "undefined" && window.location?.pathname) {
    attribution.landing_page = clamp(window.location.pathname);
  }
  if (typeof document !== "undefined" && document.referrer) {
    attribution.referrer = clamp(document.referrer);
  }

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
  } catch {
    // sessionStorage full or disabled — silently ignore, attribution is best-effort.
  }
}

/**
 * Retrieve the stored attribution, if any.
 * @returns The parsed Attribution object, or null if nothing is stored
 *          or the stored value is malformed.
 */
export function getStoredAttribution(): Attribution | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Attribution;
  } catch {
    return null;
  }
}

/** Remove the stored attribution from sessionStorage. */
export function clearStoredAttribution(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Report the stored attribution to the server so it can be associated with
 * the anonymous visitor_id cookie, enabling "first game played" tracking
 * before signup. Fire-and-forget: errors are swallowed because attribution
 * is a best-effort analytics signal and must never block the UI.
 *
 * Designed to be called exactly once per page load (from `main.tsx`) after
 * {@link captureUtmFromUrl}. It no-ops if nothing is stored — the server
 * only ever writes a row when the payload is valid, so repeated calls
 * across tabs are harmless.
 *
 * Uses `credentials: "same-origin"` so the visitor_id cookie is sent and
 * any Set-Cookie response from the middleware is installed.
 *
 * @returns A promise that resolves once the request completes (or fails).
 *   Callers should not await it; it's exposed for tests only.
 */
export async function trackAttributionOnServer(): Promise<void> {
  const attribution = getStoredAttribution();
  if (!attribution) return;

  try {
    await fetch("/api/attribution/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ attribution }),
    });
  } catch {
    // Intentionally swallowed — attribution is best-effort.
  }
}
