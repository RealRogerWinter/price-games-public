/**
 * Page-state probe — a cheap, read-only snapshot of the bot's page
 * relevant to the round attempt loop. Used by `attemptRound` to bail
 * out of long waits early when the page has navigated, the room has
 * ended, or an error banner has rendered — instead of sitting on the
 * full Phase-1/Phase-4 timeout (10–30s) for an event that will never
 * arrive.
 *
 * Layers below the watchdog (`runner/watchdog.ts`) which fires the
 * heavy-weight `driver.panic()` (close + relaunch Chromium) only
 * after 4 minutes of no progress. The probe catches state divergence
 * within ~1.5–3s and lets the lifecycle re-plan before the watchdog
 * has anything to react to.
 *
 * Pure read — no clicks, no keyboard, no navigation. The caller
 * decides recovery.
 */
import type { Page } from "playwright";

/**
 * Visible-overlay selectors that block the bot's path. `Escape`
 * dismisses both. Shared between `playwrightDriver`'s
 * `dismissBlockingOverlays` and the page-state probe so they stay
 * in sync — adding a new blocker here automatically extends both
 * detection and dismissal.
 */
export const BLOCKING_OVERLAY_SELECTORS = [
  ".image-modal-overlay",
  ".product-tooltip",
] as const;

/**
 * Markers that indicate the round-result modal is currently mounted.
 * The bot expects this between rounds — its presence is a positive
 * signal, not a divergence.
 */
const ROUND_RESULT_SELECTOR = '[data-testid="round-result-next"]';

/**
 * Markers for known divergent states — pages where the round event
 * the bot is waiting for will never come. Detection is best-effort:
 * any selector here matching means recovery should kick in.
 */
const GAME_OVER_SELECTORS = [
  '[data-testid="game-over"]',
  '[data-testid="final-results"]',
  ".game-over-screen",
  ".final-results",
] as const;

const ERROR_BANNER_SELECTORS = [
  ".error-banner",
  ".disconnected-banner",
  '[data-testid="error-banner"]',
  '[data-testid="disconnected"]',
] as const;

export interface PageStateSnapshot {
  /** `page.url()` at the moment of the snapshot. */
  url: string;
  /** True when any of `BLOCKING_OVERLAY_SELECTORS` is visible. */
  hasBlockingOverlay: boolean;
  /** True when the round-result modal is currently mounted (`data-testid="round-result-next"`). */
  hasRoundResultUI: boolean;
  /** True when a game-over / final-results screen is visible. */
  hasGameOverUI: boolean;
  /** True when an error / disconnected banner is visible. */
  hasErrorBanner: boolean;
}

/**
 * Run the snapshot. Cheap (~10–80ms total): one `page.url()` plus a
 * handful of `locator(sel).first().isVisible()` calls in parallel.
 * Each check is wrapped in `.catch(() => false)` so a closed page or
 * detached frame mid-snapshot returns a sensible "all-false" snapshot
 * rather than throwing.
 */
export async function observePageState(page: Page): Promise<PageStateSnapshot> {
  const url = (() => {
    try {
      return page.url();
    } catch {
      return "";
    }
  })();
  const visible = (selectors: ReadonlyArray<string>): Promise<boolean> => {
    // Race "any visible" — short-circuit on the first true, but tolerate
    // individual selector throws (e.g. invalid CSS edge case).
    return Promise.all(selectors.map((sel) => page.locator(sel).first().isVisible().catch(() => false)))
      .then((results) => results.some((r) => r));
  };
  const [hasBlockingOverlay, hasRoundResultUI, hasGameOverUI, hasErrorBanner] = await Promise.all([
    visible(BLOCKING_OVERLAY_SELECTORS),
    visible([ROUND_RESULT_SELECTOR]),
    visible(GAME_OVER_SELECTORS),
    visible(ERROR_BANNER_SELECTORS),
  ]);
  return { url, hasBlockingOverlay, hasRoundResultUI, hasGameOverUI, hasErrorBanner };
}

/**
 * Compare the current URL against an expected path-prefix. Used to
 * detect "the page navigated out from under us" without hard-coding
 * the full URL (production redirects e.g. `price.games` →
 * `www.price.games` would otherwise false-trigger).
 *
 * `expected` may be `null` when the caller hasn't set an expected
 * prefix (e.g. between plans). In that case any URL passes.
 *
 * @param url Current URL from `observePageState`.
 * @param expectedPathPrefix Path prefix the caller expects, e.g.
 *   `/play/comparison` or `/ABC123` for a multiplayer room. Compared
 *   against the URL's pathname (host + scheme ignored).
 * @returns True if the URL's pathname starts with the expected prefix
 *   OR `expectedPathPrefix` is null.
 */
export function urlMatchesExpected(url: string, expectedPathPrefix: string | null): boolean {
  if (!expectedPathPrefix) return true;
  // Empty / unparseable URLs (test fakes, page mid-navigation, closed
  // pages) are treated as "unknown — don't trigger divergence".
  // The cost of a false-negative (missing a real divergence) is one
  // probe tick; the cost of a false-positive is a wrongful plan
  // abort. Default toward staying.
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith(expectedPathPrefix);
  } catch {
    return true;
  }
}
