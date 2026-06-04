import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTrackEvent } from "./useTrackEvent";
import { initBeacon, __resetBeaconState, __getBeaconState } from "./beacon";

beforeEach(() => {
  __resetBeaconState();
  // Use a no-op fetch so the flush timer doesn't spam errors during the test.
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 }) as unknown as typeof fetch;
  Object.defineProperty(navigator, "doNotTrack", {
    value: "0",
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "globalPrivacyControl", {
    value: false,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  __resetBeaconState();
});

describe("useTrackEvent", () => {
  it("returns a stable function across renders", () => {
    const { result, rerender } = renderHook(() => useTrackEvent());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("enqueues a custom event with the current path", () => {
    initBeacon();
    const { result } = renderHook(() => useTrackEvent());
    result.current({ name: "share_clicked", category: "custom" });
    const state = __getBeaconState();
    expect(state!.buffer.some((e) => e.name === "share_clicked")).toBe(true);
  });

  it("silently ignores a payload with no name", () => {
    initBeacon();
    const { result } = renderHook(() => useTrackEvent());
    result.current({ name: "" });
    const state = __getBeaconState();
    expect(state!.buffer).toHaveLength(0);
  });

  it("defaults category to 'custom'", () => {
    initBeacon();
    const { result } = renderHook(() => useTrackEvent());
    result.current({ name: "plain_event" });
    const state = __getBeaconState();
    expect(state!.buffer[0].category).toBe("custom");
  });
});
