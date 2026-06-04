import type { Enactor } from "./types";

export const higherLowerEnactor: Enactor = {
  mode: "higher-lower",
  async enact(payload, page) {
    if (!("guess" in payload)) {
      throw new Error("higherLowerEnactor: payload missing guess");
    }
    const selector =
      payload.guess === "higher"
        ? '[data-testid="higher-lower-higher"]'
        : '[data-testid="higher-lower-lower"]';
    await page.waitForSelector(selector);
    const target = page.locator(selector);
    if (target.hover) await target.hover().catch(() => { /* best effort */ });
    await target.click();
  },
};
