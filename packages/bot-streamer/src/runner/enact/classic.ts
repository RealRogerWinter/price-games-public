import type { GuessData } from "@price-game/shared";
import type { Enactor } from "./types";

/**
 * Classic & closest-without-going-over share the same UI: a numeric
 * `data-testid="price-input-text"` input, a submit button, and a
 * round_result-next continue button.
 */
async function priceInputEnact(payload: GuessData, page: import("../pageLike").PageLike): Promise<void> {
  if (!("guessedPriceCents" in payload)) {
    throw new Error("priceInputEnact: payload missing guessedPriceCents");
  }
  const cents = payload.guessedPriceCents;
  const dollars = (cents / 100).toFixed(2);
  await page.waitForSelector('[data-testid="price-input-text"]');
  // Click the input first to focus it, then type one keystroke at a
  // time so the stream shows the bot deliberating. pressSequentially
  // is optional in PageLike for tests; fall back to fill when absent.
  const input = page.locator('[data-testid="price-input-text"]');
  if (input.pressSequentially) {
    // pressSequentially only appends; clear any prefilled value first.
    await input.click();
    await input.fill("");
    await input.pressSequentially(dollars, { delay: 110 });
  } else {
    // Plain fill overwrites any existing value, no pre-clear needed.
    await input.fill(dollars);
  }
  const submit = page.locator('[data-testid="price-input-submit"]');
  if (submit.hover) await submit.hover().catch(() => { /* best effort */ });
  await submit.click();
}

export const classicEnactor: Enactor = {
  mode: "classic",
  async enact(payload, page) {
    await priceInputEnact(payload, page);
  },
};

export const closestEnactor: Enactor = {
  mode: "closest-without-going-over",
  async enact(payload, page) {
    await priceInputEnact(payload, page);
  },
};

export const singlePlayerBiddingEnactor: Enactor = {
  // The single-player Bidding War daily challenge reuses the closest
  // UI; the bot submits via the same selectors. Phase 3d.2: the
  // bidding strategy emits `{ bidCents }` rather than
  // `{ guessedPriceCents }` even on the single-player path (so the
  // strategy is shape-coherent with MP). Adapt here.
  mode: "bidding",
  async enact(payload, page) {
    if ("bidCents" in payload) {
      await priceInputEnact({ guessedPriceCents: payload.bidCents }, page);
      return;
    }
    await priceInputEnact(payload, page);
  },
};
