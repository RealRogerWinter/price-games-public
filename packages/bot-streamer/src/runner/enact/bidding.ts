import type { Enactor } from "./types";

export const multiplayerBiddingEnactor: Enactor = {
  // Multiplayer Bidding War uses the shared PriceInput component
  // (with the same data-testid attrs as classic) embedded inside the
  // BiddingUI's spotlight. The bot types its bid and submits.
  //
  // Note: the Driver gates the call on the observer's
  // `BiddingTurnPayload.currentPlayerId === observer.myPlayerId`
  // (see `playwrightDriver.ts` attemptRound's bidding turn-wait
  // block). When that matches, the BiddingUI's spotlight is in
  // `phase="active"` for our seat and the price input is mounted —
  // the 5s waitForSelector below covers the React render gap.
  mode: "bidding",
  async enact(payload, page) {
    if (!("bidCents" in payload)) {
      throw new Error("multiplayerBiddingEnactor: payload missing bidCents");
    }
    const dollars = (payload.bidCents / 100).toFixed(2);
    // The bid input mounts within a render tick of `data-my-turn`
    // flipping true. attemptRound already waits up to 90s for the
    // bot's seat-matching turn payload before invoking us, so when
    // we run our turn is already live — a tight 5s window catches
    // the React render and bails fast if the input is missing
    // (typically because our turn passed mid-decision and we should
    // skip rather than block the round path with a 100s wait that
    // can never resolve).
    await page.waitForSelector('[data-testid="price-input-text"]', { timeout: 5_000 });
    await page.locator('[data-testid="price-input-text"]').fill(dollars);
    await page.locator('[data-testid="price-input-submit"]').click();
  },
};
