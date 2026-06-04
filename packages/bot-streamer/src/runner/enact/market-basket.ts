import type { Enactor } from "./types";

export const marketBasketEnactor: Enactor = {
  mode: "market-basket",
  async enact(payload, page) {
    if (!("guessedTotalCents" in payload)) {
      throw new Error("marketBasketEnactor: payload missing guessedTotalCents");
    }
    const dollars = (payload.guessedTotalCents / 100).toFixed(2);
    await page.waitForSelector('[data-testid="market-basket-input-text"]');
    await page.locator('[data-testid="market-basket-input-text"]').fill(dollars);
    await page.locator('[data-testid="market-basket-submit"]').click();
  },
};
