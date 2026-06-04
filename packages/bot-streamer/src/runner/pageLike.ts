/**
 * Minimal Page / Locator surface the runner uses, isolated from
 * `playwright`'s real types so unit tests can drive enactors with a
 * lightweight fake. The fields are a strict subset of Playwright's
 * `Page` / `Locator`, so a real Playwright page satisfies this
 * interface without an adapter.
 */

export interface PageLike {
  /** Build a locator scoped to a CSS / data-testid selector. */
  locator(selector: string): LocatorLike;
  /**
   * Wait for a selector to attach / become visible. The runner only
   * uses this for readiness — actions still go through `locator()`,
   * which is why this returns void rather than a handle that would
   * be incompatible between Playwright's ElementHandle and our
   * LocatorLike.
   */
  waitForSelector(selector: string, options?: { state?: "attached" | "visible"; timeout?: number }): Promise<unknown>;
}

export interface LocatorLike {
  /** Click the element. Honours Playwright's auto-wait semantics. */
  click(options?: { force?: boolean; timeout?: number; position?: { x: number; y: number } }): Promise<void>;
  /** Type text into the element atomically. */
  fill(text: string, options?: { timeout?: number }): Promise<void>;
  /**
   * Type text one keystroke at a time so the page repaints between
   * each char — used for humanlike-on-stream typing. Defaults to
   * Playwright's pressSequentially semantics.
   */
  pressSequentially?(text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  /**
   * Hover the element. Used by enactors to move the (synthetic)
   * cursor onto a target before clicking so the fake-cursor overlay
   * traces a visible path on stream.
   */
  hover?(options?: { timeout?: number }): Promise<void>;
  /** Scroll the element into view if it isn't already. */
  scrollIntoViewIfNeeded?(options?: { timeout?: number }): Promise<void>;
  /** Read an attribute (e.g. data-product-id). */
  getAttribute(name: string): Promise<string | null>;
  /** Count of elements matching the locator. */
  count(): Promise<number>;
  /** Refine to a child by index. */
  nth(index: number): LocatorLike;
  /** Refine by another selector. */
  locator(selector: string): LocatorLike;
  /**
   * Dispatch a synthetic event directly on the element. Bypasses both
   * Playwright's actionability checks AND DOM hit-testing — required
   * when an element's React onClick should fire even though a real
   * mouse click would be intercepted (inner element with
   * stopPropagation, or an overlay panel sitting on top of the target).
   * Mirrors real Playwright's `Locator.dispatchEvent` signature.
   */
  dispatchEvent?(type: string, eventInit?: Record<string, unknown>, options?: { timeout?: number }): Promise<void>;
}
