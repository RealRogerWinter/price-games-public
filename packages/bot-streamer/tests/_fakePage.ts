/**
 * Lightweight fake Page / Locator for unit-testing enactors. Records
 * every action so tests can assert the call sequence + selectors.
 */

import type { LocatorLike, PageLike } from "../src/runner/pageLike";

export interface FakePageEvent {
  kind: "click" | "fill" | "waitForSelector";
  selector: string;
  /** Filled text, only set when kind === "fill". */
  value?: string;
  /** Options arg for `waitForSelector`, when provided. */
  options?: { state?: "attached" | "visible"; timeout?: number };
}

interface AttrTable {
  [selector: string]: { count?: number; nth?: Record<number, Record<string, string>> };
}

export interface FakePageOptions {
  /**
   * Optional pre-populated attribute / count table so tests can drive
   * locator.count() and locator.getAttribute() returns. Keyed by the
   * top-level selector string passed to page.locator().
   */
  attrs?: AttrTable;
}

export interface FakePage extends PageLike {
  events: FakePageEvent[];
  /** Set the count for `locator(sel).count()`. */
  setCount(selector: string, count: number): void;
  /** Set an attribute returned by `locator(sel).nth(n).getAttribute(name)`. */
  setAttribute(selector: string, n: number, name: string, value: string): void;
}

export function createFakePage(_opts: FakePageOptions = {}): FakePage {
  const events: FakePageEvent[] = [];
  const counts = new Map<string, number>();
  const attrs = new Map<string, Map<number, Map<string, string>>>();

  function buildLocator(selector: string, refinement?: string): LocatorLike {
    const fullSelector = refinement ? `${selector} >> ${refinement}` : selector;
    const indexedAt = (n: number): LocatorLike => ({
      async click() {
        events.push({ kind: "click", selector: `${fullSelector}[nth=${n}]` });
      },
      async fill(text) {
        events.push({ kind: "fill", selector: `${fullSelector}[nth=${n}]`, value: text });
      },
      async getAttribute(name) {
        return attrs.get(fullSelector)?.get(n)?.get(name) ?? null;
      },
      async count() {
        return counts.get(fullSelector) ?? 0;
      },
      nth(idx) {
        return indexedAt(idx);
      },
      locator(sub) {
        return buildLocator(fullSelector, sub);
      },
      async dispatchEvent(_type, _init?, _opts?) {
        events.push({ kind: "click", selector: `${fullSelector}[nth=${n}]` });
      },
    });
    return {
      async click() {
        events.push({ kind: "click", selector: fullSelector });
      },
      async fill(text) {
        events.push({ kind: "fill", selector: fullSelector, value: text });
      },
      async getAttribute(name) {
        return attrs.get(fullSelector)?.get(0)?.get(name) ?? null;
      },
      async count() {
        return counts.get(fullSelector) ?? 0;
      },
      nth(n) {
        return indexedAt(n);
      },
      locator(sub) {
        return buildLocator(fullSelector, sub);
      },
      async dispatchEvent(_type, _init?, _opts?) {
        // Recorded as a click so existing assertions filtering on
        // `kind === "click"` still cover dispatchEvent-based enactors.
        events.push({ kind: "click", selector: fullSelector });
      },
    };
  }

  return {
    events,
    locator(selector) {
      return buildLocator(selector);
    },
    async waitForSelector(selector, options) {
      events.push({ kind: "waitForSelector", selector, options });
      return buildLocator(selector);
    },
    setCount(selector, count) {
      counts.set(selector, count);
    },
    setAttribute(selector, n, name, value) {
      const perSel = attrs.get(selector) ?? new Map<number, Map<string, string>>();
      const perN = perSel.get(n) ?? new Map<string, string>();
      perN.set(name, value);
      perSel.set(n, perN);
      attrs.set(selector, perSel);
    },
  };
}
