/**
 * Tests for useBroadcastMode / readBroadcastFlagOnce / BroadcastModeContext.
 *
 * `readBroadcastFlagOnce` is the pure ?broadcast=1 URL reader — it is
 * exercised directly here for the "present -> true / absent -> false"
 * cases, since it's the one place URL parsing actually happens now.
 *
 * `useBroadcastMode` itself is just `useContext(BroadcastModeContext)`:
 * with no Provider in the tree it must fall back to the safe default
 * (false), and with a Provider it must return exactly the value that
 * Provider was given — never re-derive anything from the URL itself.
 * (BroadcastShell is the sole owner of seeding that Provider from the
 * URL; see BroadcastShell.test.tsx, including the leak-regression test
 * proving a late-mounting consumer still sees the value BroadcastShell
 * captured at its own mount, not a fresh per-component URL read.)
 *
 * The hook intentionally has no side effects; the body-class is owned by
 * BroadcastShell (see BroadcastShell.test.tsx). That ownership split is
 * what lets transient consumers like AuthModal call this hook safely
 * without their cleanup stripping the class away from the shell.
 */

import { createElement, type ReactNode } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useBroadcastMode,
  readBroadcastFlagOnce,
  BroadcastModeContext,
} from "./useBroadcastMode";

// Plain `createElement` (no JSX) so this file can stay a `.ts` — the
// project's esbuild/vite pipeline only enables JSX parsing for `.tsx`.
function providerWrapper(value: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(BroadcastModeContext.Provider, { value }, children);
  };
}

function setSearch(search: string): void {
  // jsdom blocks `window.location = ...` but allows history.replaceState
  // to mutate `window.location.search`.
  window.history.replaceState(null, "", `/${search}`);
}

describe("readBroadcastFlagOnce", () => {
  beforeEach(() => {
    setSearch("");
  });

  it("returns false when no broadcast param is present", () => {
    setSearch("");
    expect(readBroadcastFlagOnce()).toBe(false);
  });

  it("returns false when broadcast param is something other than '1'", () => {
    setSearch("?broadcast=0");
    expect(readBroadcastFlagOnce()).toBe(false);
  });

  it("returns true when ?broadcast=1 is present", () => {
    setSearch("?broadcast=1");
    expect(readBroadcastFlagOnce()).toBe(true);
  });

  it("returns true when broadcast=1 is one of multiple params", () => {
    setSearch("?utm_source=test&broadcast=1&foo=bar");
    expect(readBroadcastFlagOnce()).toBe(true);
  });
});

describe("useBroadcastMode", () => {
  it("returns false when rendered with no BroadcastModeContext.Provider", () => {
    // No BroadcastShell in the tree (e.g. an isolated unit test) — the
    // context's own default applies, never a live URL read.
    setSearch("?broadcast=1");
    const { result } = renderHook(() => useBroadcastMode());
    expect(result.current).toBe(false);
  });

  it("returns the Provider's value, not a fresh URL read", () => {
    // The URL says broadcast=1, but the hook must return whatever the
    // Provider was seeded with — proving the hook itself never touches
    // `window.location`.
    setSearch("?broadcast=1");
    const { result } = renderHook(() => useBroadcastMode(), {
      wrapper: providerWrapper(false),
    });
    expect(result.current).toBe(false);
  });

  it("returns true when the Provider is seeded true", () => {
    setSearch("");
    const { result } = renderHook(() => useBroadcastMode(), {
      wrapper: providerWrapper(true),
    });
    expect(result.current).toBe(true);
  });

  it("does not touch document.body.classList", () => {
    // The hook is a pure context read. If a consumer mounts and unmounts
    // the hook, existing body classes must be untouched — that invariant
    // is what makes it safe for transient consumers (AuthModal etc.) to
    // call.
    document.body.classList.add("some-other-class");
    const { unmount } = renderHook(() => useBroadcastMode(), {
      wrapper: providerWrapper(true),
    });
    expect(document.body.classList.contains("broadcast")).toBe(false);
    expect(document.body.classList.contains("some-other-class")).toBe(true);
    unmount();
    expect(document.body.classList.contains("broadcast")).toBe(false);
    expect(document.body.classList.contains("some-other-class")).toBe(true);
    document.body.classList.remove("some-other-class");
  });
});
