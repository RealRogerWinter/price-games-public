/**
 * Tests for humanize — the fake-cursor init script + humanlike click /
 * fill wrappers used by the streamer's enactors.
 *
 * The init script is asserted by structure (it has to be a string we
 * eval into the page); the wrappers are exercised against a hand-rolled
 * fake Locator that records every call.
 */

import { describe, it, expect, vi } from "vitest";
import { FAKE_CURSOR_INIT_SCRIPT, humanClick, humanFill } from "../src/runner/humanize";
import type { Locator, Page } from "playwright";

describe("FAKE_CURSOR_INIT_SCRIPT", () => {
  it("is a self-invoking IIFE so addInitScript runs it on page load", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/\(function\(\)\s*\{/);
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/\}\)\(\);/);
  });

  it("guards against double-injection across navigations", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/__pgBotCursorInjected/);
  });

  it("renders an SVG arrow with stroke + fill so it stays visible against any background", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/<svg/);
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/fill="#ffffff"/);
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/stroke="#000000"/);
  });

  it("listens for mousemove + mousedown so synthetic CDP events move the cursor", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/addEventListener\(['"]mousemove['"]/);
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/addEventListener\(['"]mousedown['"]/);
  });

  it("uses pointer-events:none so the overlay never intercepts page clicks", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/pointer-events:none/);
  });

  it("uses the maximum z-index so it stays above any modal", () => {
    expect(FAKE_CURSOR_INIT_SCRIPT).toMatch(/2147483647/);
  });
});

describe("humanClick", () => {
  function buildLocator() {
    return {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      hover: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    };
  }
  function buildPage() {
    return { waitForTimeout: vi.fn().mockResolvedValue(undefined) };
  }

  it("scrolls into view → hovers → waits → clicks, in that order", async () => {
    const calls: string[] = [];
    const locator = {
      scrollIntoViewIfNeeded: vi.fn(async () => { calls.push("scroll"); }),
      hover: vi.fn(async () => { calls.push("hover"); }),
      click: vi.fn(async () => { calls.push("click"); }),
    };
    const page = { waitForTimeout: vi.fn(async () => { calls.push("wait"); }) };
    await humanClick(page as unknown as Page, locator as unknown as Locator);
    expect(calls).toEqual(["scroll", "hover", "wait", "click"]);
  });

  it("forwards the click position so price-match's offset trick works", async () => {
    const locator = buildLocator();
    const page = buildPage();
    await humanClick(page as unknown as Page, locator as unknown as Locator, {
      position: { x: 20, y: 220 },
    });
    expect(locator.click).toHaveBeenCalledWith({ position: { x: 20, y: 220 } });
  });

  it("falls through to click when scrollIntoView throws (best-effort)", async () => {
    const locator = buildLocator();
    locator.scrollIntoViewIfNeeded.mockRejectedValueOnce(new Error("detached"));
    const page = buildPage();
    await humanClick(page as unknown as Page, locator as unknown as Locator);
    expect(locator.click).toHaveBeenCalled();
  });

  it("hover delay is configurable via hoverMs", async () => {
    const locator = buildLocator();
    const page = buildPage();
    await humanClick(page as unknown as Page, locator as unknown as Locator, {
      hoverMs: 500,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });
});

describe("humanFill", () => {
  function buildLocator() {
    return {
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      pressSequentially: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("clicks → clears → types one keystroke at a time", async () => {
    const calls: string[] = [];
    const locator = {
      scrollIntoViewIfNeeded: vi.fn(async () => { calls.push("scroll"); }),
      click: vi.fn(async () => { calls.push("click"); }),
      fill: vi.fn(async () => { calls.push("fill"); }),
      pressSequentially: vi.fn(async () => { calls.push("type"); }),
    };
    await humanFill(locator as unknown as Locator, "49.99");
    expect(calls).toEqual(["scroll", "click", "fill", "type"]);
    expect(locator.fill).toHaveBeenCalledWith("");
    expect(locator.pressSequentially).toHaveBeenCalledWith("49.99", { delay: 90 });
  });

  it("delay is configurable so per-mode pacing can vary", async () => {
    const locator = buildLocator();
    await humanFill(locator as unknown as Locator, "12.34", { delayMs: 200 });
    expect(locator.pressSequentially).toHaveBeenCalledWith("12.34", { delay: 200 });
  });
});
