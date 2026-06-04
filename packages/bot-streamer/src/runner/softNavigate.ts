/**
 * Soft-navigation helper for the streamer-bot driver.
 *
 * Plan boundaries used to call `page.goto(url)` which is a full
 * document load: every chunk re-fetched, React tree torn down, audio
 * context reset, lipsync engine re-initialised, NN canvases cleared.
 * For the broadcast viewer this is a jarring per-game flash.
 *
 * `softNavigate` instead routes through `window.__pgBroadcastNav(url)`
 * registered by `apps/web/src/broadcast/BroadcastNavHandle.tsx` while
 * the page is in `?broadcast=1` mode. The helper calls React Router's
 * `navigate()` so the routes swap in-place under the still-mounted
 * `BroadcastShell`.
 *
 * Falls back to `page.goto(url, { waitUntil: "domcontentloaded" })`
 * when:
 *   - The page hasn't loaded yet (no document, helper not registered).
 *   - The helper is missing for any reason (broadcast=0, viewer not
 *     yet hydrated, build skew).
 *   - The helper is present but the route swap doesn't actually move
 *     the URL (treated as a misconfiguration; full reload is the
 *     correct recovery).
 *
 * After a successful soft-navigation the page URL must reflect the
 * target pathname before we return — the page-state probe in
 * `playwrightDriver.ts` compares the live `page.url()` against
 * `expectedPathPrefix` and would otherwise diverge on the first probe
 * tick. We poll briefly to catch React Router's microtask-deferred
 * URL update.
 */
import type { Page } from "playwright";

/**
 * The window-global identifier the web app registers its in-page
 * navigation helper under. Kept in lockstep with
 * `apps/web/src/broadcast/BroadcastNavHandle.tsx`.
 */
export const BROADCAST_NAV_GLOBAL = "__pgBroadcastNav";

export interface SoftNavigateOptions {
  /**
   * Soft-nav is only safe when the page has already loaded a build
   * carrying the broadcast helper. The driver flips this to true after
   * the first successful `page.goto`. First navigation always uses
   * `goto` regardless.
   */
  pageLoaded: boolean;
  /**
   * Maximum total time to spend waiting for the URL to reflect the
   * target after invoking the helper. Defaults to 1500ms. If the
   * helper has not moved the URL by then, fall back to `goto`.
   */
  urlSettleTimeoutMs?: number;
  /**
   * Polling interval while waiting for the URL to settle. Defaults to
   * 50ms.
   */
  urlPollIntervalMs?: number;
  /** Inject for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SoftNavigateResult {
  /** Which path actually executed: "soft" (helper) or "hard" (page.goto). */
  path: "soft" | "hard";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Navigate `page` to `url`, preferring an in-page React Router push
 * over a full document load when the broadcast helper is available.
 *
 * @param page - Playwright page handle.
 * @param url - Absolute target URL (the bot driver always passes one).
 * @param options - See `SoftNavigateOptions`. Notably `pageLoaded` —
 *   the FIRST navigation of a session must use `page.goto` because no
 *   document yet exists to host the helper.
 * @returns `{ path }` indicating whether the soft path or hard
 *   fallback was taken.
 */
export async function softNavigate(
  page: Page,
  url: string,
  options: SoftNavigateOptions,
): Promise<SoftNavigateResult> {
  const sleep = options.sleep ?? defaultSleep;
  const settleTimeout = options.urlSettleTimeoutMs ?? 1500;
  const pollInterval = options.urlPollIntervalMs ?? 50;

  if (!options.pageLoaded) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { path: "hard" };
  }

  // Compute the expected pathname so we can confirm the SPA navigation
  // actually moved the URL. Includes `hash` so a future hash-bearing
  // route (the in-page helper writes pathname+search+hash via React
  // Router) doesn't silently force a hard reload after the timeout.
  // If parsing fails we drop straight to the hard fallback — the URL
  // is malformed and `page.goto` would error anyway, but at least the
  // error surfaces from a single code path.
  let targetPath: string;
  try {
    const parsed = new URL(url);
    targetPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { path: "hard" };
  }

  // Probe whether the helper exists in the current page. A missing
  // helper means broadcast=0 or a stale build that predates this
  // change — fall back so we don't no-op the entire navigation. The
  // outer try/catch handles synchronous throws (e.g. fakes whose
  // `evaluate` isn't a function); the inner `.catch` handles async
  // rejection from a real Playwright page.
  let helperPresent = false;
  try {
    helperPresent = await page
      .evaluate((g) => typeof (window as unknown as Record<string, unknown>)[g] === "function", BROADCAST_NAV_GLOBAL)
      .catch(() => false);
  } catch {
    helperPresent = false;
  }
  if (!helperPresent) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { path: "hard" };
  }

  try {
    await page
      .evaluate(
        ({ g, u }) => {
          const fn = (window as unknown as Record<string, unknown>)[g];
          if (typeof fn === "function") (fn as (s: string) => void)(u);
        },
        { g: BROADCAST_NAV_GLOBAL, u: url },
      )
      .catch(() => {
        // Swallow; the URL-poll below will detect the no-op and fall
        // through to the hard path.
      });
  } catch {
    // Same defensive double-wrap as above.
  }

  const deadline = Date.now() + settleTimeout;
  while (Date.now() < deadline) {
    let current: URL | null = null;
    try {
      current = new URL(page.url());
    } catch {
      current = null;
    }
    if (current && `${current.pathname}${current.search}${current.hash}` === targetPath) {
      return { path: "soft" };
    }
    await sleep(pollInterval);
  }

  // Helper present but URL never moved — treat as soft-nav failure
  // and fall back to a full reload so the plan can still proceed.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { path: "hard" };
}
