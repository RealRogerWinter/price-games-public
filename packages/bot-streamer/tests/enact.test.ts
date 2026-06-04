import { describe, it, expect } from "vitest";
import { createFakePage } from "./_fakePage";
import { classicEnactor, closestEnactor, singlePlayerBiddingEnactor } from "../src/runner/enact/classic";
import { higherLowerEnactor } from "../src/runner/enact/higher-lower";
import { comparisonEnactor, oddOneOutEnactor } from "../src/runner/enact/comparison";
// Phase 3d.2: priceMatchEnactor + budgetBuilderEnactor removed with the modes.
import { makeRiserEnactor } from "../src/runner/enact/riser";
import { marketBasketEnactor } from "../src/runner/enact/market-basket";
import { sortItOutEnactor } from "../src/runner/enact/sort-it-out";
import { chainReactionEnactor } from "../src/runner/enact/chain-reaction";
import { multiplayerBiddingEnactor } from "../src/runner/enact/bidding";
import { enactorFor, enactorForSinglePlayer } from "../src/runner/enact/index";

describe("classicEnactor", () => {
  it("fills the price and submits", async () => {
    const page = createFakePage();
    await classicEnactor.enact({ guessedPriceCents: 4999 }, page);
    const fills = page.events.filter((e) => e.kind === "fill");
    const clicks = page.events.filter((e) => e.kind === "click");
    expect(fills).toHaveLength(1);
    expect(fills[0].value).toBe("49.99");
    expect(fills[0].selector).toBe('[data-testid="price-input-text"]');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].selector).toBe('[data-testid="price-input-submit"]');
  });

  it("throws on the wrong payload variant", async () => {
    const page = createFakePage();
    await expect(classicEnactor.enact({ guess: "higher" }, page)).rejects.toThrow();
  });
});

describe("closestEnactor + single-player bidding", () => {
  it("uses the same price-input UI as classic", async () => {
    const a = createFakePage();
    const b = createFakePage();
    await closestEnactor.enact({ guessedPriceCents: 100 }, a);
    await singlePlayerBiddingEnactor.enact({ guessedPriceCents: 100 }, b);
    expect(a.events).toEqual(b.events);
  });
});

describe("higherLowerEnactor", () => {
  it("clicks the higher button on guess: higher", async () => {
    const page = createFakePage();
    await higherLowerEnactor.enact({ guess: "higher" }, page);
    const clicks = page.events.filter((e) => e.kind === "click");
    expect(clicks[0].selector).toBe('[data-testid="higher-lower-higher"]');
  });

  it("clicks the lower button on guess: lower", async () => {
    const page = createFakePage();
    await higherLowerEnactor.enact({ guess: "lower" }, page);
    const clicks = page.events.filter((e) => e.kind === "click");
    expect(clicks[0].selector).toBe('[data-testid="higher-lower-lower"]');
  });
});

describe("comparison + odd-one-out enactors", () => {
  it("clicks the chosen product card", async () => {
    const page = createFakePage();
    await comparisonEnactor.enact({ guessedProductId: 42 }, page);
    expect(page.events.find((e) => e.kind === "click")?.selector).toBe(
      '[data-testid="comparison-card"][data-product-id="42"]',
    );
  });

  it("waits for the card with a tight timeout (not Playwright's 30s default)", async () => {
    // Regression guard: an unbounded waitForSelector burned ~60s of
    // dead air on stream every time the strategy picked a product the
    // page had already moved past (stale payload). The timeout caps
    // the worst-case at CLICK_TIMEOUT_MS (5s) per attempt.
    const page = createFakePage();
    await comparisonEnactor.enact({ guessedProductId: 42 }, page);
    const wait = page.events.find((e) => e.kind === "waitForSelector");
    expect(wait?.options?.timeout).toBeDefined();
    expect(wait?.options?.timeout).toBeLessThanOrEqual(10_000);
  });

  it("odd-one-out uses its own selector", async () => {
    const page = createFakePage();
    await oddOneOutEnactor.enact({ guessedProductId: 7 }, page);
    expect(page.events.find((e) => e.kind === "click")?.selector).toBe(
      '[data-testid="odd-one-out-card"][data-product-id="7"]',
    );
  });

  it("rejects an unsafe product id before touching the page", async () => {
    // Defense-in-depth: the id is interpolated into a CSS attribute
    // value, so a malformed id with a quote or bracket could escape.
    // The enactor refuses anything outside [A-Za-z0-9_-].
    const page = createFakePage();
    await expect(
      comparisonEnactor.enact({ guessedProductId: '42"]' as unknown as number }, page),
    ).rejects.toThrow(/unsafe product id/);
    expect(page.events).toHaveLength(0);
  });
});

// Phase 3d.2: priceMatchEnactor test removed with the enactor.

describe("riserEnactor", () => {
  it("clicks Stop when the live price crosses the target", async () => {
    const page = createFakePage();
    let cents = 0;
    const enactor = makeRiserEnactor({
      async currentPriceCents() {
        cents += 50;
        return cents;
      },
      async sleep() {},
    });
    await enactor.enact({ stoppedPriceCents: 200 }, page);
    const clicks = page.events.filter((e) => e.kind === "click").map((e) => e.selector);
    expect(clicks).toEqual([
      '[data-testid="riser-start"]',
      '[data-testid="riser-stop"]',
    ]);
  });

  it("retries (does not click stop) when currentPriceCents returns null", async () => {
    // Regression: a missing data-cents attribute used to coerce to 0
    // and bail out of the polling loop with a stop click — the stop
    // would fire on the very first poll, before the animation even
    // started. With the fix, null reads are skipped and only real
    // numeric reads cross the >= target threshold.
    const page = createFakePage();
    const reads: Array<number | null> = [null, null, null, 100, 250];
    let i = 0;
    const enactor = makeRiserEnactor({
      async currentPriceCents() {
        return reads[i++] ?? 250;
      },
      async sleep() {},
    });
    await enactor.enact({ stoppedPriceCents: 200 }, page);
    // Stop fires only once (after the 250-cent read), not on each null.
    const stopClicks = page.events.filter(
      (e) => e.kind === "click" && e.selector === '[data-testid="riser-stop"]',
    );
    expect(stopClicks).toHaveLength(1);
  });

  it("bails after a long null streak rather than polling forever", async () => {
    const page = createFakePage();
    let nullCount = 0;
    const enactor = makeRiserEnactor({
      async currentPriceCents() {
        nullCount++;
        return null;
      },
      async sleep() {},
    });
    await enactor.enact({ stoppedPriceCents: 200 }, page);
    // The MAX_CONSECUTIVE_NULL_READS guard kicks in well before the
    // 30s wall-clock timeout. The exact count is internal but the
    // enactor must terminate (this test would hang otherwise).
    expect(nullCount).toBeGreaterThan(0);
    expect(nullCount).toBeLessThan(1000); // sanity bound
    // Still clicks stop at the end, since timed-out riser presses
    // stop to avoid going over.
    const stopClicks = page.events.filter(
      (e) => e.kind === "click" && e.selector === '[data-testid="riser-stop"]',
    );
    expect(stopClicks).toHaveLength(1);
  });
});

describe("marketBasketEnactor", () => {
  it("fills the dollar amount and submits", async () => {
    const page = createFakePage();
    await marketBasketEnactor.enact({ guessedTotalCents: 12345 }, page);
    expect(page.events.find((e) => e.kind === "fill")?.value).toBe("123.45");
    expect(page.events.find((e) => e.kind === "click")?.selector).toBe(
      '[data-testid="market-basket-submit"]',
    );
  });
});

describe("sortItOutEnactor", () => {
  it("submits without swaps when the order already matches", async () => {
    const page = createFakePage();
    page.setCount('[data-testid="sort-it-out-slot"]', 3);
    page.setAttribute('[data-testid="sort-it-out-slot"]', 0, "data-product-id", "10");
    page.setAttribute('[data-testid="sort-it-out-slot"]', 1, "data-product-id", "20");
    page.setAttribute('[data-testid="sort-it-out-slot"]', 2, "data-product-id", "30");
    await sortItOutEnactor.enact({ submittedOrder: [10, 20, 30] }, page, { sleep: async () => {} });
    const clicks = page.events.filter((e) => e.kind === "click").map((e) => e.selector);
    expect(clicks).toEqual(['[data-testid="sort-it-out-submit"]']);
  });

  it("performs swaps to reach the target order", async () => {
    const page = createFakePage();
    // Initial: [10, 20, 30]; target: [30, 10, 20]
    let order = [10, 20, 30];
    const slotSel = '[data-testid="sort-it-out-slot"]';
    page.setCount(slotSel, 3);
    function refreshAttrs() {
      for (let i = 0; i < order.length; i++) {
        page.setAttribute(slotSel, i, "data-product-id", String(order[i]));
      }
    }
    refreshAttrs();

    // Patch click to apply swaps when it's a position-tap pattern.
    const origPage = page.locator;
    let pendingTap: number | null = null;
    page.locator = ((selector: string) => {
      const handle = origPage.call(page, selector);
      const m = selector.match(/data-position="(\d+)"/);
      if (m) {
        const pos = Number(m[1]);
        const wrappedClick = handle.click;
        handle.click = async () => {
          await wrappedClick.call(handle);
          if (pendingTap === null) {
            pendingTap = pos;
          } else {
            const a = pendingTap;
            const b = pos;
            [order[a], order[b]] = [order[b], order[a]];
            refreshAttrs();
            pendingTap = null;
          }
        };
      }
      return handle;
    }) as typeof page.locator;

    await sortItOutEnactor.enact({ submittedOrder: [30, 10, 20] }, page, { sleep: async () => {} });
    expect(order).toEqual([30, 10, 20]);
  });

  it("waits for the DOM to reflect each swap before issuing the next one", async () => {
    // Regression: the enactor used to read `data-product-id` immediately
    // after a tap pair, racing React's state flush. The fix is an
    // explicit waitForSelector that asserts the post-swap product is at
    // the target slot's data-position. Without it, the next iteration
    // may compute the wrong holder index and cascade-fail.
    const page = createFakePage();
    const slotSel = '[data-testid="sort-it-out-slot"]';
    page.setCount(slotSel, 3);
    page.setAttribute(slotSel, 0, "data-product-id", "10");
    page.setAttribute(slotSel, 1, "data-product-id", "20");
    page.setAttribute(slotSel, 2, "data-product-id", "30");
    // Patch click to apply the swap immediately on the second tap.
    const origLocator = page.locator;
    let pendingTap: number | null = null;
    const order = [10, 20, 30];
    page.locator = ((selector: string) => {
      const handle = origLocator.call(page, selector);
      const m = selector.match(/data-position="(\d+)"/);
      if (m) {
        const pos = Number(m[1]);
        const wrappedClick = handle.click;
        handle.click = async () => {
          await wrappedClick.call(handle);
          if (pendingTap === null) {
            pendingTap = pos;
          } else {
            const a = pendingTap;
            const b = pos;
            [order[a], order[b]] = [order[b], order[a]];
            for (let i = 0; i < order.length; i++) {
              page.setAttribute(slotSel, i, "data-product-id", String(order[i]));
            }
            pendingTap = null;
          }
        };
      }
      return handle;
    }) as typeof page.locator;

    await sortItOutEnactor.enact({ submittedOrder: [30, 10, 20] }, page, { sleep: async () => {} });

    // Confirm the post-swap selector waits land in the event log.
    const waits = page.events.filter((e) => e.kind === "waitForSelector");
    const swapWaits = waits.filter(
      (e) => e.selector?.includes('data-position="0"') && e.selector?.includes('data-product-id="30"'),
    );
    expect(swapWaits.length).toBeGreaterThanOrEqual(1);
  });
});

// Phase 3d.2: budgetBuilderEnactor test removed with the enactor.

describe("chainReactionEnactor", () => {
  it("clicks Start once, then walks the chainGuesses sequence", async () => {
    const page = createFakePage();
    await chainReactionEnactor.enact({ chainGuesses: ["more", "less", "more"] }, page, { sleep: async () => {} });
    const clicks = page.events.filter((e) => e.kind === "click").map((e) => e.selector);
    expect(clicks).toEqual([
      '[data-testid="chain-start"]',
      '[data-testid="chain-more"]',
      '[data-testid="chain-less"]',
      '[data-testid="chain-more"]',
    ]);
  });
});

describe("multiplayerBiddingEnactor", () => {
  it("fills the bid amount and submits", async () => {
    const page = createFakePage();
    await multiplayerBiddingEnactor.enact({ bidCents: 7500 }, page);
    expect(page.events.find((e) => e.kind === "fill")?.value).toBe("75.00");
    expect(page.events.find((e) => e.kind === "click")?.selector).toBe(
      '[data-testid="price-input-submit"]',
    );
  });

  it("waits for the bid input with a tight timeout, not the 100s legacy", async () => {
    // Regression guard: a 100s waitForSelector here let a stale-call
    // reattempt (Phase 3.5 verify path) block the entire round path
    // for 100s when our turn was already gone, eating the plan budget
    // and stranding the bot through game:over. attemptRound now waits
    // for our seat-matching turn payload before invoking us, so the
    // input is mounted within a render tick when enact runs.
    const page = createFakePage();
    await multiplayerBiddingEnactor.enact({ bidCents: 100 }, page);
    const wait = page.events.find((e) => e.kind === "waitForSelector");
    expect(wait?.options?.timeout).toBeDefined();
    expect(wait?.options?.timeout).toBeLessThanOrEqual(10_000);
  });

  it("propagates a waitForSelector rejection so a stale turn fails fast", async () => {
    // Behaviour-level guard for the fail-fast contract: when our turn
    // has already passed (price input never mounts), the enactor must
    // surface the timeout as a throw rather than swallow it. The
    // driver's enactor try/catch then turns it into a `skipped` round,
    // which is what unwedges MP bidding plans.
    let waitTimeoutObserved: number | undefined;
    const failingPage = {
      locator() {
        throw new Error("locator() should not be called when the input never appears");
      },
      async waitForSelector(_selector: string, options?: { timeout?: number }) {
        waitTimeoutObserved = options?.timeout;
        throw new Error("waitForSelector: timed out");
      },
    } satisfies import("../src/runner/pageLike").PageLike;
    await expect(
      multiplayerBiddingEnactor.enact({ bidCents: 100 }, failingPage),
    ).rejects.toThrow(/timed out/);
    expect(waitTimeoutObserved).toBeDefined();
    expect(waitTimeoutObserved).toBeLessThanOrEqual(10_000);
  });
});

describe("enactor registry", () => {
  it("returns the right enactor per mode", () => {
    expect(enactorFor("classic")).toBe(classicEnactor);
    expect(enactorFor("bidding")).toBe(multiplayerBiddingEnactor);
  });

  it("enactorForSinglePlayer falls back to the closest-style bidding enactor", () => {
    expect(enactorForSinglePlayer("bidding")).toBe(singlePlayerBiddingEnactor);
    expect(enactorForSinglePlayer("classic")).toBe(classicEnactor);
  });

  it("throws on an unsupported mode", () => {
    expect(() => enactorFor("not-a-mode" as never)).toThrow();
  });
});
