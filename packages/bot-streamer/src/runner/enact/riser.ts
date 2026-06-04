import type { Enactor, EnactorContext } from "./types";

interface RiserDeps {
  /**
   * Read the current displayed price from the page. Returns null
   * when the price element is missing or its `data-cents` attribute
   * is unset — the enactor treats that as "page hasn't rendered the
   * tick yet" and re-polls instead of treating it as 0 (which would
   * trip the `>= target` guard if the animation overshot the target
   * before the bot saw any non-zero reading).
   */
  currentPriceCents(page: import("../pageLike").PageLike): Promise<number | null>;
  /**
   * Sleep for `ms` so the test harness can advance fake timers
   * without the enactor blocking on real wall-clock.
   */
  sleep(ms: number): Promise<void>;
}

const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Maximum consecutive null reads before we give up and click stop.
 * 200 polls @ 50ms = 10s; if the price element never appears in
 * that window the bot bails so the round can advance.
 */
const MAX_CONSECUTIVE_NULL_READS = 200;

const PRODUCTION_DEPS: RiserDeps = {
  async currentPriceCents(page) {
    // The animated price span carries a `data-cents` attribute the
    // RiserPage refreshes on every animation tick. Reading the
    // attribute keeps the bot's polling locale-/currency-agnostic
    // (parsing the formatted text would couple us to the user's
    // currency setting). Returning null here propagates "selector
    // missing / attribute unset" up to the polling loop, which
    // retries instead of pretending the price is $0.
    const handle = page.locator(".riser-price-label span[data-cents]").nth(0);
    const text = await handle.getAttribute("data-cents");
    if (text === null || text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

/**
 * Build a riser enactor with optional custom deps. Production code
 * uses the default; tests inject a deterministic priceCents source.
 */
export function makeRiserEnactor(deps: RiserDeps = PRODUCTION_DEPS): Enactor {
  return {
    mode: "riser",
    async enact(payload, page, _ctx: EnactorContext = {}) {
      if (!("stoppedPriceCents" in payload)) {
        throw new Error("riserEnactor: payload missing stoppedPriceCents");
      }
      const target = payload.stoppedPriceCents;
      // Click Start, then poll the live price until it crosses the
      // target. Click Stop at that point.
      await page.waitForSelector('[data-testid="riser-start"]');
      await page.locator('[data-testid="riser-start"]').click();
      await page.waitForSelector('[data-testid="riser-stop"]');

      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      let nullStreak = 0;
      while (Date.now() < deadline) {
        const current = await deps.currentPriceCents(page);
        if (current === null) {
          nullStreak++;
          if (nullStreak > MAX_CONSECUTIVE_NULL_READS) {
            // eslint-disable-next-line no-console
            console.warn(
              "[riserEnactor] data-cents missing for 10s straight; bailing out",
            );
            break;
          }
          await deps.sleep(DEFAULT_POLL_MS);
          continue;
        }
        nullStreak = 0;
        if (current >= target) {
          await page.locator('[data-testid="riser-stop"]').click();
          return;
        }
        await deps.sleep(DEFAULT_POLL_MS);
      }
      // Timed out — click stop anyway so we don't go over.
      await page.locator('[data-testid="riser-stop"]').click();
    },
  };
}

export const riserEnactor = makeRiserEnactor();
