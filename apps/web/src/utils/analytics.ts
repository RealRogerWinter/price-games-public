/**
 * Google Analytics 4 consent helpers.
 *
 * The external gtag.js loader (~160 KB, ~800 ms of main-thread scripting
 * on mid-tier phones) is not injected at page load any more. Instead:
 *
 *   1. index.html runs a tiny inline bootstrap: creates window.dataLayer,
 *      the gtag() queueing fn, and sets Consent Mode v2 defaults to
 *      denied. This is a few bytes and fires before paint.
 *   2. loadGA() (called from main.tsx) finishes the dataLayer/gtag setup
 *      and, IF the user has already consented in a prior visit,
 *      injects gtag.js after the browser goes idle.
 *   3. grantAnalyticsConsent() — called when the user accepts the
 *      cookie banner — pushes the consent update AND injects gtag.js
 *      if it isn't already loaded.
 *
 * Consequence: first-time visitors who bounce before interacting with
 * the banner never download gtag.js. This is a deliberate tradeoff —
 * analytics coverage is narrower but Total Blocking Time drops
 * substantially on the home page.
 *
 * VITE_GA_MEASUREMENT_ID is a public identifier by design.
 */

import { getPreferences } from "./cookieConsent";

const GA_MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as
  | string
  | undefined;

/**
 * Push an entry onto the dataLayer.
 * Uses window.gtag (set by the inline HTML snippet) when available,
 * falls back to direct dataLayer.push.
 */
function gtagPush(...args: unknown[]): void {
  if (typeof window.gtag === "function") {
    window.gtag(...args);
  } else if (window.dataLayer) {
    window.dataLayer.push(args);
  }
}

let inited = false;
let scriptInjected = false;

/**
 * Ensure the dataLayer queue, the gtag() fn, Consent Mode v2 defaults,
 * and the mandatory js / config calls are set up. Safe to call multiple
 * times — only runs once. index.html's inline bootstrap already does
 * all of this in production; this is the fallback path for dev/test.
 *
 * Does NOT inject the external gtag.js script — that is gated on
 * consent via `injectGtagScript`.
 */
function initGA(): void {
  if (inited || !GA_MEASUREMENT_ID) return;
  inited = true;

  if (typeof window.gtag === "function" && window.dataLayer) {
    // Inline HTML snippet already initialized GA. Nothing to do here.
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer.push(args);
  };

  window.gtag("consent", "default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    wait_for_update: 500,
  });

  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID);
}

/**
 * Inject the external gtag.js loader. Idempotent. Called from:
 *  - `grantAnalyticsConsent()` when the user accepts the banner
 *  - `loadGA()` at startup iff the user already consented in a prior visit
 */
function injectGtagScript(): void {
  if (scriptInjected || !GA_MEASUREMENT_ID) return;
  if (document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
    scriptInjected = true;
    return;
  }
  scriptInjected = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}

/** Run `cb` during the next browser idle window, or soon thereafter. */
function whenIdle(cb: () => void): void {
  type IdleWindow = Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(cb, { timeout: 2000 });
  } else {
    setTimeout(cb, 500);
  }
}

/**
 * Called once at app startup. Always sets up the dataLayer/gtag queue.
 * Injects gtag.js only if the user previously consented to analytics
 * (persisted in localStorage). First-time visitors don't get the
 * external script until they click Accept in the cookie banner.
 */
export function loadGA(): void {
  initGA();
  const prefs = getPreferences();
  if (prefs.consented && prefs.analytics) {
    whenIdle(() => injectGtagScript());
  }
}

/** Grant analytics consent — GA will begin collecting data. */
export function grantAnalyticsConsent(): void {
  initGA();
  gtagPush("consent", "update", {
    analytics_storage: "granted",
  });
  injectGtagScript();
}

/** Revoke analytics consent and clear existing GA cookies. */
export function revokeAnalyticsConsent(): void {
  gtagPush("consent", "update", {
    analytics_storage: "denied",
  });

  const cookieNames = ["_ga", "_gid", "_gat"];
  document.cookie.split(";").forEach((c) => {
    const name = c.trim().split("=")[0];
    if (name.startsWith("_ga_")) cookieNames.push(name);
  });

  const host = window.location.hostname;
  const parts = host.split(".");
  const apex = parts.length > 2 ? `.${parts.slice(-2).join(".")}` : `.${host}`;

  for (const name of cookieNames) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${host}`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${apex}`;
  }
}

/** Send a custom GA4 event. No-op if gtag isn't loaded. */
export function trackEvent(
  eventName: string,
  params?: Record<string, string | number | boolean>,
): void {
  if (typeof window.gtag === "function") {
    window.gtag("event", eventName, params);
  }
}

// Extend Window for gtag / dataLayer
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}
