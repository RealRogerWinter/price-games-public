import { describe, it, expect } from "vitest";
import { observePageState, urlMatchesExpected } from "../src/runner/pageStateProbe";
import type { Page } from "playwright";

interface FakeLocator {
  first(): { isVisible(): Promise<boolean> };
}

interface FakePage {
  url(): string;
  locator(selector: string): FakeLocator;
}

function makeFakePage(opts: {
  url?: string;
  visibleSelectors?: ReadonlySet<string>;
  throwOnUrl?: boolean;
  throwOnLocator?: ReadonlySet<string>;
}): FakePage {
  const visibleSelectors = opts.visibleSelectors ?? new Set<string>();
  const throwOnLocator = opts.throwOnLocator ?? new Set<string>();
  return {
    url() {
      if (opts.throwOnUrl) throw new Error("simulated url() failure");
      return opts.url ?? "";
    },
    locator(selector: string) {
      return {
        first() {
          return {
            async isVisible() {
              if (throwOnLocator.has(selector)) throw new Error("simulated isVisible() failure");
              return visibleSelectors.has(selector);
            },
          };
        },
      };
    },
  };
}

describe("urlMatchesExpected", () => {
  it("returns true when expectedPathPrefix is null (no expectation set)", () => {
    expect(urlMatchesExpected("https://price.games/", null)).toBe(true);
    expect(urlMatchesExpected("", null)).toBe(true);
  });

  it("returns true when the URL pathname starts with the expected prefix", () => {
    expect(urlMatchesExpected("https://price.games/play/comparison?broadcast=1", "/play/comparison")).toBe(true);
    expect(urlMatchesExpected("https://www.price.games/ABC123", "/ABC123")).toBe(true);
  });

  it("returns false when the URL pathname does NOT start with the expected prefix", () => {
    expect(urlMatchesExpected("https://price.games/", "/play/comparison")).toBe(false);
    expect(urlMatchesExpected("https://price.games/game-over", "/play/classic")).toBe(false);
    expect(urlMatchesExpected("https://price.games/login", "/ABC123")).toBe(false);
  });

  it("treats production redirect (price.games → www.price.games) as a match — host doesn't matter", () => {
    expect(urlMatchesExpected("https://www.price.games/play/classic", "/play/classic")).toBe(true);
  });

  it("returns true on empty / unparseable URL (test fakes, mid-navigation, closed page)", () => {
    expect(urlMatchesExpected("", "/play/classic")).toBe(true);
    expect(urlMatchesExpected("not a url", "/play/classic")).toBe(true);
  });
});

describe("observePageState", () => {
  it("returns a sane all-false snapshot when no overlays are visible", async () => {
    const page = makeFakePage({ url: "https://price.games/play/classic?broadcast=1" });
    const snap = await observePageState(page as unknown as Page);
    expect(snap).toEqual({
      url: "https://price.games/play/classic?broadcast=1",
      hasBlockingOverlay: false,
      hasRoundResultUI: false,
      hasGameOverUI: false,
      hasErrorBanner: false,
    });
  });

  it("flags `hasBlockingOverlay` when a blocking-overlay selector is visible", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set([".image-modal-overlay"]),
    });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.hasBlockingOverlay).toBe(true);
  });

  it("flags the alternate blocking-overlay selector (.product-tooltip) too", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set([".product-tooltip"]),
    });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.hasBlockingOverlay).toBe(true);
  });

  it("flags `hasRoundResultUI` when the round-result-next selector is visible", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set(['[data-testid="round-result-next"]']),
    });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.hasRoundResultUI).toBe(true);
  });

  it("flags `hasGameOverUI` when any game-over selector is visible", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set(['[data-testid="game-over"]']),
    });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.hasGameOverUI).toBe(true);
  });

  it("flags `hasErrorBanner` when an error / disconnected banner is visible", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set([".error-banner"]),
    });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.hasErrorBanner).toBe(true);
  });

  it("returns empty url string when page.url() throws (closed page, etc.) without crashing", async () => {
    const page = makeFakePage({ throwOnUrl: true });
    const snap = await observePageState(page as unknown as Page);
    expect(snap.url).toBe("");
  });

  it("treats individual locator failures as `not visible` rather than propagating", async () => {
    const page = makeFakePage({
      url: "https://price.games/play/classic",
      visibleSelectors: new Set([".error-banner"]),
      throwOnLocator: new Set([".image-modal-overlay"]),
    });
    const snap = await observePageState(page as unknown as Page);
    // The blocking-overlay check sits behind the throwing locator —
    // shouldn't poison sibling checks.
    expect(snap.hasBlockingOverlay).toBe(false);
    expect(snap.hasErrorBanner).toBe(true);
  });
});
