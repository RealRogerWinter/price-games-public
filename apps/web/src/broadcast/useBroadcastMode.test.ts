/**
 * Tests for useBroadcastMode — pure read of the ?broadcast=1 URL flag.
 *
 * The hook intentionally has no side effects; the body-class is owned by
 * BroadcastShell (see BroadcastShell.test.tsx). That ownership split is
 * what lets transient consumers like AuthModal call this hook safely
 * without their cleanup stripping the class away from the shell.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBroadcastMode } from "./useBroadcastMode";

function setSearch(search: string): void {
  // jsdom blocks `window.location = ...` but allows history.replaceState
  // to mutate `window.location.search`.
  window.history.replaceState(null, "", `/${search}`);
}

describe("useBroadcastMode", () => {
  beforeEach(() => {
    setSearch("");
  });

  it("returns false when no broadcast param is present", () => {
    setSearch("");
    const { result } = renderHook(() => useBroadcastMode());
    expect(result.current).toBe(false);
  });

  it("returns false when broadcast param is something other than '1'", () => {
    setSearch("?broadcast=0");
    const { result } = renderHook(() => useBroadcastMode());
    expect(result.current).toBe(false);
  });

  it("returns true when ?broadcast=1 is present", () => {
    setSearch("?broadcast=1");
    const { result } = renderHook(() => useBroadcastMode());
    expect(result.current).toBe(true);
  });

  it("returns true when broadcast=1 is one of multiple params", () => {
    setSearch("?utm_source=test&broadcast=1&foo=bar");
    const { result } = renderHook(() => useBroadcastMode());
    expect(result.current).toBe(true);
  });

  it("does not touch document.body.classList", () => {
    // The hook is a pure read. If a consumer mounts and unmounts the hook,
    // existing body classes must be untouched — that invariant is what
    // makes it safe for transient consumers (AuthModal etc.) to call.
    document.body.classList.add("some-other-class");
    setSearch("?broadcast=1");
    const { unmount } = renderHook(() => useBroadcastMode());
    expect(document.body.classList.contains("broadcast")).toBe(false);
    expect(document.body.classList.contains("some-other-class")).toBe(true);
    unmount();
    expect(document.body.classList.contains("broadcast")).toBe(false);
    expect(document.body.classList.contains("some-other-class")).toBe(true);
    document.body.classList.remove("some-other-class");
  });
});
