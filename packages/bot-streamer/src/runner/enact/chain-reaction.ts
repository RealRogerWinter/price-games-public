import type { Enactor, EnactorContext } from "./types";
import { interActionDelayMs } from "../../realism/timing";

const SLEEP_DEFAULT = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const chainReactionEnactor: Enactor = {
  mode: "chain-reaction",
  async enact(payload, page, ctx?: EnactorContext) {
    if (!("chainGuesses" in payload)) {
      throw new Error("chainReactionEnactor: payload missing chainGuesses");
    }
    const sleep = ctx?.sleep ?? SLEEP_DEFAULT;
    // Step 1: click the "Start Chain" button to advance off the
    //         starting product. The button only mounts on link 1.
    await page.waitForSelector('[data-testid="chain-start"]');
    await page.locator('[data-testid="chain-start"]').click();

    // Step 2: for each subsequent link, click the matching more/less
    //         button. B6: pause before each link with a heavier beat
    //         on the final link — the pre-final pause is the
    //         strongest "stakes are rising" cue we can give viewers
    //         in this mode.
    for (let i = 0; i < payload.chainGuesses.length; i++) {
      const guess = payload.chainGuesses[i];
      const isFinal = i === payload.chainGuesses.length - 1;
      await sleep(
        interActionDelayMs(isFinal ? "chain-reaction-final" : "chain-reaction", {
          rng: ctx?.rng,
        }),
      );
      const sel =
        guess === "more"
          ? '[data-testid="chain-more"]'
          : '[data-testid="chain-less"]';
      await page.waitForSelector(sel);
      await page.locator(sel).click();
    }
  },
};
