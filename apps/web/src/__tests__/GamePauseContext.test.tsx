import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  GamePauseProvider,
  useGamePause,
} from "../context/GamePauseContext";

describe("GamePauseContext", () => {
  it("returns a stable no-op default outside the provider", () => {
    const { result, rerender } = renderHook(() => useGamePause());
    const first = result.current;
    expect(first.paused).toBe(false);
    rerender();
    // Re-rendering must yield the SAME object identity so AuthModal-style
    // effects with deps [pause, resume] do not re-fire on every render.
    expect(result.current).toBe(first);
  });

  it("starts unpaused inside a provider", () => {
    const { result } = renderHook(() => useGamePause(), {
      wrapper: GamePauseProvider,
    });
    expect(result.current.paused).toBe(false);
  });

  it("flips paused when pause is called and back when resume is called", () => {
    const { result } = renderHook(() => useGamePause(), {
      wrapper: GamePauseProvider,
    });
    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);
    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
  });

  it("reference-counts so stacked overlays compose cleanly", () => {
    const { result } = renderHook(() => useGamePause(), {
      wrapper: GamePauseProvider,
    });
    act(() => result.current.pause());
    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);
    act(() => result.current.resume());
    // One overlay still up — must remain paused.
    expect(result.current.paused).toBe(true);
    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
  });

  it("clamps the pause counter at zero — extra resumes are no-ops", () => {
    const { result } = renderHook(() => useGamePause(), {
      wrapper: GamePauseProvider,
    });
    act(() => result.current.resume());
    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
    act(() => result.current.pause());
    // Still paused after a single pause despite the prior over-resume.
    expect(result.current.paused).toBe(true);
  });
});
