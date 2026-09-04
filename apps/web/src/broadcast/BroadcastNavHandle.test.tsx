/**
 * Tests for BroadcastNavHandle — the inside-router component that
 * exposes `window.__pgBroadcastNav` for the streamer-bot driver to
 * call between plan boundaries.
 *
 * The component is invisible (returns null). Each test mounts it
 * inside a MemoryRouter, asserts the helper's presence/absence, and
 * verifies that invoking the helper triggers a React Router
 * navigation rather than a full document load.
 *
 * `useBroadcastMode()` now reads `BroadcastModeContext` rather than the
 * URL directly, so each test wraps its tree in a Provider seeded from
 * the same `?broadcast=1` flag it sets via `setSearch` — mirroring how
 * `BroadcastShell` seeds the real Provider once at startup.
 */
import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import BroadcastNavHandle, { BROADCAST_NAV_GLOBAL } from "./BroadcastNavHandle";
import { BroadcastModeContext, readBroadcastFlagOnce } from "./useBroadcastMode";

function setSearch(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

/** Seeds BroadcastModeContext from the current URL, same as BroadcastShell. */
function BroadcastProviderFromUrl({ children }: { children: ReactNode }) {
  return (
    <BroadcastModeContext.Provider value={readBroadcastFlagOnce()}>
      {children}
    </BroadcastModeContext.Provider>
  );
}

function LocationProbe({ onLocation }: { onLocation: (path: string) => void }): null {
  const loc = useLocation();
  onLocation(`${loc.pathname}${loc.search}`);
  return null;
}

describe("BroadcastNavHandle", () => {
  beforeEach(() => {
    setSearch("");
    delete window[BROADCAST_NAV_GLOBAL];
  });

  afterEach(() => {
    delete window[BROADCAST_NAV_GLOBAL];
  });

  it("does not register the window helper when broadcast=0", () => {
    setSearch("");
    render(
      <BroadcastProviderFromUrl>
        <MemoryRouter>
          <BroadcastNavHandle />
        </MemoryRouter>
      </BroadcastProviderFromUrl>,
    );
    expect(typeof window[BROADCAST_NAV_GLOBAL]).toBe("undefined");
  });

  it("registers a navigation function when broadcast=1", () => {
    setSearch("?broadcast=1");
    render(
      <BroadcastProviderFromUrl>
        <MemoryRouter>
          <BroadcastNavHandle />
        </MemoryRouter>
      </BroadcastProviderFromUrl>,
    );
    expect(typeof window[BROADCAST_NAV_GLOBAL]).toBe("function");
  });

  it("clears the helper on unmount", () => {
    setSearch("?broadcast=1");
    const { unmount } = render(
      <BroadcastProviderFromUrl>
        <MemoryRouter>
          <BroadcastNavHandle />
        </MemoryRouter>
      </BroadcastProviderFromUrl>,
    );
    expect(typeof window[BROADCAST_NAV_GLOBAL]).toBe("function");
    unmount();
    expect(typeof window[BROADCAST_NAV_GLOBAL]).toBe("undefined");
  });

  it("invoking the helper navigates without a full page load", () => {
    setSearch("?broadcast=1");
    let observedPath = "/";
    render(
      <BroadcastProviderFromUrl>
        <MemoryRouter initialEntries={["/play/classic?broadcast=1"]}>
          <BroadcastNavHandle />
          <Routes>
            <Route
              path="*"
              element={<LocationProbe onLocation={(p) => { observedPath = p; }} />}
            />
          </Routes>
        </MemoryRouter>
      </BroadcastProviderFromUrl>,
    );
    expect(observedPath).toBe("/play/classic?broadcast=1");
    act(() => {
      // Build the URL using the test's jsdom origin so the helper's
      // same-origin guard accepts it. Production code uses the real
      // host; the guard logic is identical.
      window[BROADCAST_NAV_GLOBAL]?.(`${window.location.origin}/play/higher-lower?broadcast=1`);
    });
    expect(observedPath).toBe("/play/higher-lower?broadcast=1");
  });

  it("ignores cross-origin navigation attempts", () => {
    setSearch("?broadcast=1");
    let observedPath = "/play/classic";
    render(
      <BroadcastProviderFromUrl>
        <MemoryRouter initialEntries={["/play/classic?broadcast=1"]}>
          <BroadcastNavHandle />
          <Routes>
            <Route
              path="*"
              element={<LocationProbe onLocation={(p) => { observedPath = p; }} />}
            />
          </Routes>
        </MemoryRouter>
      </BroadcastProviderFromUrl>,
    );
    act(() => {
      window[BROADCAST_NAV_GLOBAL]?.("https://evil.example.com/steal");
    });
    // URL should remain unchanged.
    expect(observedPath).toBe("/play/classic?broadcast=1");
  });
});
