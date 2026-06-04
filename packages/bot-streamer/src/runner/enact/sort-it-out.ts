import type { Enactor, EnactorContext } from "./types";
import type { PageLike } from "../pageLike";
import { interActionDelayMs } from "../../realism/timing";

const SLEEP_DEFAULT = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function readSlotOrder(page: PageLike): Promise<number[]> {
  const slots = page.locator('[data-testid="sort-it-out-slot"]');
  const count = await slots.count();
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    const idAttr = await slots.nth(i).getAttribute("data-product-id");
    const id = idAttr ? Number(idAttr) : NaN;
    if (Number.isFinite(id)) order.push(id);
  }
  return order;
}

async function clickSlotByPosition(page: PageLike, position: number): Promise<void> {
  await page.locator(`[data-testid="sort-it-out-slot"][data-position="${position}"]`).click();
}

export const sortItOutEnactor: Enactor = {
  mode: "sort-it-out",
  async enact(payload, page, ctx?: EnactorContext) {
    if (!("submittedOrder" in payload)) {
      throw new Error("sortItOutEnactor: payload missing submittedOrder");
    }
    const target = payload.submittedOrder;
    const sleep = ctx?.sleep ?? SLEEP_DEFAULT;
    await page.waitForSelector('[data-testid="sort-it-out-slot"]');

    // Selection-sort against the live DOM. For each target slot:
    //   1. Read the current order
    //   2. Find where the desired product currently sits
    //   3. If it's not in place, tap the target slot then the holder
    //      slot to swap them
    // The price-game UI swaps on a "tap A then tap B" pattern.
    //
    // After each swap-pair we wait for the DOM to actually reflect
    // the swap before reading the next iteration's slot order.
    // Without this, React's state update may not have flushed by the
    // time we call `readSlotOrder()` again — we'd read stale
    // `data-product-id`s and compute the next swap against the wrong
    // baseline. The wait is a single combined-attribute selector
    // that only matches once the slot at `target_idx` carries
    // `data-product-id="${wanted}"`.
    //
    // B6: insert a comprehension beat between swaps. The first swap
    // gets a longer dwell (~1.3s) so viewers register the initial
    // shuffle layout before items start moving.
    let swapsExecuted = 0;
    for (let target_idx = 0; target_idx < target.length; target_idx++) {
      const wanted = target[target_idx];
      const current = await readSlotOrder(page);
      if (current[target_idx] === wanted) continue;
      const holder_idx = current.indexOf(wanted);
      if (holder_idx === -1) continue; // bail rather than crash
      const beatKey = swapsExecuted === 0 ? "sort-it-out-first" : "sort-it-out";
      await sleep(interActionDelayMs(beatKey, { rng: ctx?.rng }));
      await clickSlotByPosition(page, target_idx);
      await clickSlotByPosition(page, holder_idx);
      await page.waitForSelector(
        `[data-testid="sort-it-out-slot"][data-position="${target_idx}"][data-product-id="${wanted}"]`,
      );
      swapsExecuted++;
    }

    await page.waitForSelector('[data-testid="sort-it-out-submit"]');
    await page.locator('[data-testid="sort-it-out-submit"]').click();
  },
};
