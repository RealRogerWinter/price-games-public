/**
 * MotionEngine tests. The engine takes Playwright's real Page +
 * Locator types; we satisfy them via duck-typed mocks that capture
 * the operations we want to assert on.
 */

import { describe, it, expect, vi } from "vitest";
import { createMotionEngine } from "../src/runner/motionEngine";
import type { Locator, Page } from "playwright";

interface MockPage {
  page: Page;
  moves: Array<{ x: number; y: number }>;
}

function mockPage(): MockPage {
  const moves: Array<{ x: number; y: number }> = [];
  const page = {
    mouse: {
      async move(x: number, y: number) {
        moves.push({ x, y });
      },
    },
  } as unknown as Page;
  return { page, moves };
}

interface MockLocatorOptions {
  bbox?: { x: number; y: number; width: number; height: number } | null;
  /** When true, scrollIntoViewIfNeeded is missing entirely (simulates a fake-page). */
  noScroll?: boolean;
  /** When true, hover() throws — used to assert click-only fallback path. */
  hoverThrows?: boolean;
  /** When true, boundingBox() is undefined (fake-page case). */
  noBoundingBox?: boolean;
}

interface MockLocatorReturn {
  locator: Locator;
  clicks: Array<unknown>;
  hovers: number;
  scrolls: number;
}

function mockLocator(opts: MockLocatorOptions = {}): MockLocatorReturn {
  const clicks: Array<unknown> = [];
  let hovers = 0;
  let scrolls = 0;
  const handle: Partial<Locator> = {
    async click(arg?: unknown) {
      clicks.push(arg);
    },
    async hover() {
      hovers++;
      if (opts.hoverThrows) throw new Error("hover not supported");
    },
  };
  if (!opts.noScroll) {
    handle.scrollIntoViewIfNeeded = (async () => { scrolls++; }) as Locator["scrollIntoViewIfNeeded"];
  }
  if (!opts.noBoundingBox) {
    handle.boundingBox = (async () => opts.bbox ?? null) as Locator["boundingBox"];
  }
  return {
    locator: handle as Locator,
    clicks,
    hovers,
    get scrolls() {
      return scrolls;
    },
  } as MockLocatorReturn;
}

describe("createMotionEngine", () => {
  it("walks waypoints via page.mouse.move when a bounding box is available", async () => {
    const { page, moves } = mockPage();
    const { locator, clicks } = mockLocator({
      bbox: { x: 100, y: 100, width: 80, height: 40 },
    });
    const engine = createMotionEngine({
      sleep: async () => {},
      stepIntervalMs: 0,
      rng: () => 0.5,
    });
    await engine.moveAndClick(page, locator, { hoverMs: 0 });
    expect(moves.length).toBeGreaterThan(0);
    expect(clicks).toHaveLength(1);
    // Last waypoint lands inside the bounding box (ish — may include
    // jitter but should be within target dims plus a safety margin).
    const last = moves[moves.length - 1];
    expect(last.x).toBeGreaterThan(50);
    expect(last.x).toBeLessThan(220);
    expect(last.y).toBeGreaterThan(50);
    expect(last.y).toBeLessThan(180);
  });

  it("falls back to hover+click when boundingBox() is missing (fake-page case)", async () => {
    const { page, moves } = mockPage();
    const m = mockLocator({ noBoundingBox: true });
    const engine = createMotionEngine({ sleep: async () => {}, stepIntervalMs: 0 });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0 });
    // No mouse-move waypoints fired.
    expect(moves).toHaveLength(0);
    // Click still happened.
    expect(m.clicks).toHaveLength(1);
  });

  it("falls back when boundingBox returns null (e.g. detached element)", async () => {
    const { page, moves } = mockPage();
    const m = mockLocator({ bbox: null });
    const engine = createMotionEngine({ sleep: async () => {}, stepIntervalMs: 0 });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0 });
    expect(moves).toHaveLength(0);
    expect(m.clicks).toHaveLength(1);
  });

  it("forwards `position` to locator.click()", async () => {
    const { page } = mockPage();
    const m = mockLocator({ bbox: { x: 0, y: 0, width: 200, height: 100 } });
    const engine = createMotionEngine({ sleep: async () => {}, stepIntervalMs: 0, rng: () => 0.5 });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0, position: { x: 20, y: 30 } });
    expect(m.clicks).toHaveLength(1);
    expect(m.clicks[0]).toEqual({ position: { x: 20, y: 30 } });
  });

  it("updates internal cursor position to the last waypoint", async () => {
    const { page, moves } = mockPage();
    const m = mockLocator({ bbox: { x: 500, y: 300, width: 100, height: 50 } });
    const engine = createMotionEngine({
      sleep: async () => {},
      stepIntervalMs: 0,
      rng: () => 0.5,
      initialPosition: { x: 0, y: 0 },
    });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0 });
    const final = moves[moves.length - 1];
    const pos = engine.getPosition();
    expect(pos.x).toBeCloseTo(final.x, 0);
    expect(pos.y).toBeCloseTo(final.y, 0);
  });

  it("setPosition seeds the cursor for the next call", async () => {
    const { page, moves } = mockPage();
    const m = mockLocator({ bbox: { x: 1000, y: 500, width: 100, height: 50 } });
    const engine = createMotionEngine({
      sleep: async () => {},
      stepIntervalMs: 0,
      rng: () => 0.5,
    });
    engine.setPosition({ x: 0, y: 0 });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0 });
    // First waypoint is the first step on the path FROM (0,0) — well to the
    // left of the eventual landing in the (1050,525) range.
    const first = moves[0];
    expect(first.x).toBeLessThan(1000);
  });

  it("respects an absent page.mouse (test fake)", async () => {
    const page = {} as Page;
    const m = mockLocator({ bbox: { x: 0, y: 0, width: 100, height: 50 } });
    const engine = createMotionEngine({ sleep: async () => {}, stepIntervalMs: 0 });
    await engine.moveAndClick(page, m.locator, { hoverMs: 0 });
    expect(m.clicks).toHaveLength(1);
  });

  it("hoverMs delay invoked between path completion and click", async () => {
    const { page } = mockPage();
    const m = mockLocator({ bbox: { x: 0, y: 0, width: 100, height: 50 } });
    const sleep = vi.fn(async () => {});
    const engine = createMotionEngine({
      sleep: sleep as never,
      stepIntervalMs: 0,
      rng: () => 0.5,
    });
    await engine.moveAndClick(page, m.locator, { hoverMs: 250 });
    // The 250ms hover sleep is one of the calls (the others are the
    // 0ms per-step intervals which were skipped by the 0 condition).
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
