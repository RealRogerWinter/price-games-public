/**
 * Reddit Pixel — consent-gated conversion tracking.
 *
 * Mirrors the GA consent-mode pattern in analytics.ts. The external
 * `pixel.js` loader (~18 KB + ~200 ms of main-thread scripting on mid-tier
 * phones) is no longer injected at page load for every visitor. Instead:
 *
 *   1. `loadRedditPixel()` always installs the `window.rdt` queue stub and
 *      fires `rdt("init", pixelId, { optOut: true })` synchronously. The
 *      stub buffers every call until the real `pixel.js` overwrites it.
 *   2. `loadRedditPixel()` only injects `pixel.js` if the user previously
 *      consented to analytics in a prior visit, and even then waits for
 *      `requestIdleCallback` so it competes with nothing on the LCP path.
 *   3. `grantRedditConsent()` — called when the user accepts the cookie
 *      banner — flips optOut to false, queues a PageVisit, and injects
 *      `pixel.js` if it hasn't been loaded already. The stub's callQueue
 *      is replayed by the real script when it finishes loading, so the
 *      PageVisit emits correctly even though it was enqueued before the
 *      network round-trip finished.
 *
 * Consequence: first-time visitors who bounce before touching the banner
 * never download `pixel.js`. Deliberate trade-off — narrower ad-conversion
 * coverage, but a clean TBT on first paint.
 *
 * The pixel ID is read from VITE_REDDIT_PIXEL_ID at build time. This value
 * is a public identifier by design (the pixel runs in the browser). When
 * the env var is absent, every export is a no-op so dev/test environments
 * and self-hosted deployments without Reddit ads are unaffected.
 */

import { getPreferences } from "./cookieConsent";

const PIXEL_ID = import.meta.env.VITE_REDDIT_PIXEL_ID as string | undefined;
// Reddit's canonical snippet includes the pixel_id as a query param on the
// script src alongside the init() call below — matching their exact format
// avoids any risk of pixel.js refusing to initialize for the wrong ID.
const PIXEL_SRC = PIXEL_ID
  ? `https://www.redditstatic.com/ads/pixel.js?pixel_id=${encodeURIComponent(PIXEL_ID)}`
  : "https://www.redditstatic.com/ads/pixel.js";

type RdtFn = ((...args: unknown[]) => void) & {
  callQueue?: unknown[][];
  sendEvent?: (...args: unknown[]) => void;
};

let loaded = false;
let scriptInjected = false;

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
 * Inject the external `pixel.js` loader. Idempotent. Called from:
 *  - `grantRedditConsent()` when the user accepts the banner
 *  - `loadRedditPixel()` at startup iff the user already consented in a
 *    prior visit
 *
 * NOTE: no Subresource Integrity (SRI) attribute is set. Reddit's pixel
 * script is updated server-side without notice, so a pinned hash would
 * break on every vendor change. The integrity guarantee comes from the
 * CSP `script-src` allowlist (`https://www.redditstatic.com`) + TLS.
 * Same trade-off as `analytics.ts` for the GA loader.
 */
function injectPixelScript(): void {
  if (scriptInjected || !PIXEL_ID) return;
  if (document.querySelector(`script[src='${PIXEL_SRC}']`)) {
    scriptInjected = true;
    return;
  }
  scriptInjected = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = PIXEL_SRC;
  document.head.appendChild(script);
}

/**
 * Bootstrap the Reddit pixel queue and initialize with consent denied by
 * default. Always runs cheaply; only injects `pixel.js` if the user
 * consented in a previous visit.
 *
 * Safe to call multiple times — only runs once. No-op when
 * VITE_REDDIT_PIXEL_ID is not configured.
 */
export function loadRedditPixel(): void {
  if (loaded || !PIXEL_ID) return;
  loaded = true;

  // Install the queue-based rdt stub that Reddit's pixel.js replaces when
  // the real script loads. Any calls made before pixel.js loads are queued
  // and replayed once the real implementation is installed.
  if (!window.rdt) {
    const rdt = function (...args: unknown[]) {
      if (rdt.sendEvent) {
        rdt.sendEvent.apply(rdt, args);
      } else {
        (rdt.callQueue = rdt.callQueue || []).push(args);
      }
    } as RdtFn;
    rdt.callQueue = [];
    window.rdt = rdt as unknown as typeof window.rdt;
  }

  // Initialize with consent denied. grantRedditConsent() flips this later.
  // Non-null assert is safe: the block above always leaves window.rdt defined.
  window.rdt!("init", PIXEL_ID, { optOut: true });

  // Only inject the external script if the user previously consented to
  // analytics. First-time visitors don't pay the ~200 ms scripting cost
  // unless / until they accept the cookie banner.
  const prefs = getPreferences();
  if (prefs.consented && prefs.analytics) {
    whenIdle(() => injectPixelScript());
  }
}

/**
 * Grant analytics consent — the pixel begins tracking and fires an initial
 * PageVisit event. Called by CookieConsent when the user accepts the
 * Analytics cookie category. Injects `pixel.js` if this is the user's first
 * time consenting (i.e. `loadRedditPixel` ran in deferred mode).
 */
export function grantRedditConsent(): void {
  if (!PIXEL_ID || typeof window.rdt !== "function") return;
  window.rdt("init", PIXEL_ID, { optOut: false });
  window.rdt("track", "PageVisit");
  // Inject the external script if startup didn't. The calls above are
  // queued on the stub and will replay when pixel.js finishes loading.
  injectPixelScript();
}

/**
 * Revoke analytics consent — the pixel stops tracking and existing Reddit
 * cookies are cleared.
 */
export function revokeRedditConsent(): void {
  if (!PIXEL_ID || typeof window.rdt !== "function") return;
  window.rdt("init", PIXEL_ID, { optOut: true });

  // Clear pixel cookies on both host and apex domain (mirrors analytics.ts pattern).
  // Reddit historically used multiple naming conventions for its tracking
  // cookies — `_rdt`, `_rdtu`, `_rdt_uuid`, and the un-prefixed `rdt_uuid`.
  // Match all of them so a consent revocation actually clears the state.
  const cookieNames = document.cookie
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .filter((name) => name.startsWith("_rdt") || name.startsWith("rdt_"));

  const host = window.location.hostname;
  const parts = host.split(".");
  const apex = parts.length > 2 ? `.${parts.slice(-2).join(".")}` : `.${host}`;

  for (const name of cookieNames) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${host}`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${apex}`;
  }
}

/**
 * Fire a custom Reddit conversion event (e.g. "SignUp", "ViewContent").
 * No-op if the pixel is not loaded.
 *
 * @param eventName - Standard Reddit event name or custom string.
 * @param metadata - Optional metadata object attached to the event.
 */
export function trackRedditEvent(
  eventName: string,
  metadata?: Record<string, string | number | boolean>,
): void {
  if (typeof window.rdt !== "function") return;
  if (metadata === undefined) {
    window.rdt("track", eventName);
  } else {
    window.rdt("track", eventName, metadata);
  }
}

declare global {
  interface Window {
    rdt?: (...args: unknown[]) => void;
  }
}
