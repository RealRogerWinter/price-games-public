import type { Enactor } from "./types";
import type { LocatorLike } from "../pageLike";

/**
 * Click a card by dispatching a synthetic click on the element.
 *
 * Why dispatchEvent instead of locator.click():
 *   1. The card's inner `.comparison-image-wrapper` div has
 *      `e.stopPropagation()` (opens the image-zoom modal). A real
 *      click landing at the card centre fires the wrapper's handler
 *      instead of the card's `doGuess` — the round guess is silently
 *      swallowed and `[data-testid="round-result-next"]` never appears.
 *   2. With `?broadcast=1` the BroadcastShell mounts side-panels
 *      (BotCard at x<=280, ChatOverlay at x>=1640) on top of the
 *      full-bleed game canvas. Cards near the edges are
 *      hit-test-occluded; locator.click() waits 30s on the
 *      "receives pointer events" actionability check before timing out.
 *
 * dispatchEvent sidesteps both: the React onClick fires regardless of
 * what visual element is on top. Hover is still attempted first so the
 * synthetic cursor animates toward the target on stream — viewers see
 * the bot's intent before the click commits.
 */
// Tight click timeout — when the strategy picks a product that
// isn't on the page (e.g. a stale payload from the previous round
// after the server advanced), we want the enactor to fail in
// seconds, not after Playwright's 30s default. Two attempts × 5s =
// at most 10s of dead air before the round is skipped.
const CLICK_TIMEOUT_MS = 5_000;

// Defense-in-depth: product IDs from the strategy are interpolated
// into a CSS attribute selector. Today they originate from the
// observer's parsed round payload (server-trusted), but a strict
// numeric/safe-token gate eliminates the attribute-selector-injection
// class entirely — a malformed payload field can't ever escape the
// quoted attribute value to add another clause.
const SAFE_PRODUCT_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeProductId(id: unknown): string {
  const s = String(id);
  if (!SAFE_PRODUCT_ID.test(s)) {
    throw new Error(`enactor: unsafe product id ${JSON.stringify(id)}`);
  }
  return s;
}

async function clickCard(target: LocatorLike): Promise<void> {
  if (target.hover) await target.hover().catch(() => { /* best effort */ });
  if (target.dispatchEvent) {
    await target.dispatchEvent("click", undefined, { timeout: CLICK_TIMEOUT_MS });
    return;
  }
  await target.click({ timeout: CLICK_TIMEOUT_MS });
}

export const comparisonEnactor: Enactor = {
  mode: "comparison",
  async enact(payload, page) {
    if (!("guessedProductId" in payload)) {
      throw new Error("comparisonEnactor: payload missing guessedProductId");
    }
    const id = assertSafeProductId(payload.guessedProductId);
    const sel = `[data-testid="comparison-card"][data-product-id="${id}"]`;
    await page.waitForSelector(sel, { timeout: CLICK_TIMEOUT_MS });
    await clickCard(page.locator(sel));
  },
};

export const oddOneOutEnactor: Enactor = {
  mode: "odd-one-out",
  async enact(payload, page) {
    if (!("guessedProductId" in payload)) {
      throw new Error("oddOneOutEnactor: payload missing guessedProductId");
    }
    const id = assertSafeProductId(payload.guessedProductId);
    const sel = `[data-testid="odd-one-out-card"][data-product-id="${id}"]`;
    await page.waitForSelector(sel, { timeout: CLICK_TIMEOUT_MS });
    await clickCard(page.locator(sel));
  },
};
