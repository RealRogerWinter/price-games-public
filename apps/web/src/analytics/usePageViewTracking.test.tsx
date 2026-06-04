import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { usePageViewTracking } from "./usePageViewTracking";
import { initBeacon, __resetBeaconState, __getBeaconState } from "./beacon";

function TestApp(): React.ReactElement {
  usePageViewTracking();
  return (
    <>
      <Link to="/b" data-testid="link-b">Go B</Link>
      <Link to="/a" data-testid="link-a">Go A</Link>
      <Routes>
        <Route path="/a" element={<div>AAA</div>} />
        <Route path="/b" element={<div>BBB</div>} />
      </Routes>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetBeaconState();
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 }) as unknown as typeof fetch;
  Object.defineProperty(navigator, "doNotTrack", { value: "0", writable: true, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  __resetBeaconState();
});

describe("usePageViewTracking", () => {
  it("does NOT fire on the initial mount", () => {
    initBeacon();
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <TestApp />
      </MemoryRouter>,
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const state = __getBeaconState();
    expect(state!.buffer.filter((e) => e.name === "page_viewed")).toHaveLength(0);
  });

  it("fires a page_viewed event after a route change (debounced)", async () => {
    initBeacon();
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/a"]}>
        <TestApp />
      </MemoryRouter>,
    );

    act(() => {
      getByTestId("link-b").click();
    });
    act(() => {
      vi.advanceTimersByTime(200); // past the 150ms debounce
    });
    const state = __getBeaconState();
    const pageViews = state!.buffer.filter((e) => e.name === "page_viewed");
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0].path).toBe("/b");
  });

  it("collapses rapid consecutive navigation via the debounce", () => {
    initBeacon();
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/a"]}>
        <TestApp />
      </MemoryRouter>,
    );
    act(() => {
      getByTestId("link-b").click();
      getByTestId("link-a").click();
      getByTestId("link-b").click();
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const state = __getBeaconState();
    const pageViews = state!.buffer.filter((e) => e.name === "page_viewed");
    // Only the last settled path fires (debounced collapse).
    expect(pageViews).toHaveLength(1);
    expect(pageViews[0].path).toBe("/b");
  });
});
