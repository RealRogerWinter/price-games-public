import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScreenHistory } from "../hooks/useScreenHistory";

type Screen = "home" | "playing" | "result" | "leaderboard";

describe("useScreenHistory", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset history state
    window.history.replaceState({}, "", "/");
    pushStateSpy = vi.spyOn(window.history, "pushState");
    replaceStateSpy = vi.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
  });

  it("initializes with the given screen value", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));
    expect(result.current[0]).toBe("home");
  });

  it("replaces initial history state with screen data on mount", () => {
    renderHook(() => useScreenHistory<Screen>("home"));
    expect(replaceStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "home" }),
      ""
    );
  });

  it("pushes history entry when setScreen is called", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });

    expect(pushStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "playing" }),
      ""
    );
    expect(result.current[0]).toBe("playing");
  });

  it("preserves existing history.state fields (React Router idx) on push", () => {
    // Simulate React Router state
    window.history.replaceState({ idx: 0, key: "default", usr: null }, "", "/");

    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });

    expect(pushStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idx: 0, key: "default", usr: null, screen: "playing" }),
      ""
    );
  });

  it("updates screen state on popstate event (back button)", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });
    expect(result.current[0]).toBe("playing");

    // Simulate browser back button
    act(() => {
      const event = new PopStateEvent("popstate", {
        state: { screen: "home" },
      });
      window.dispatchEvent(event);
    });

    expect(result.current[0]).toBe("home");
  });

  it("does NOT push history on popstate-triggered screen change", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });

    pushStateSpy.mockClear();

    // Simulate browser back
    act(() => {
      const event = new PopStateEvent("popstate", {
        state: { screen: "home" },
      });
      window.dispatchEvent(event);
    });

    expect(result.current[0]).toBe("home");
    expect(pushStateSpy).not.toHaveBeenCalled();
  });

  it("ignores popstate events without a screen field", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });
    expect(result.current[0]).toBe("playing");

    // popstate with state that has no screen field
    act(() => {
      const event = new PopStateEvent("popstate", {
        state: { idx: 0 },
      });
      window.dispatchEvent(event);
    });

    // Screen should remain unchanged
    expect(result.current[0]).toBe("playing");
  });

  it("ignores popstate events with null state", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });
    expect(result.current[0]).toBe("playing");

    // popstate with null state (navigating past our history entries)
    act(() => {
      const event = new PopStateEvent("popstate", { state: null });
      window.dispatchEvent(event);
    });

    expect(result.current[0]).toBe("playing");
  });

  it("cleans up popstate listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useScreenHistory<Screen>("home"));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("popstate", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("handles multiple forward navigations and back correctly", () => {
    const { result } = renderHook(() => useScreenHistory<Screen>("home"));

    act(() => {
      result.current[1]("playing");
    });
    act(() => {
      result.current[1]("result");
    });
    act(() => {
      result.current[1]("leaderboard");
    });
    expect(result.current[0]).toBe("leaderboard");

    // Back to result
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "result" } })
      );
    });
    expect(result.current[0]).toBe("result");

    // Back to playing
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "playing" } })
      );
    });
    expect(result.current[0]).toBe("playing");

    // Back to home
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "home" } })
      );
    });
    expect(result.current[0]).toBe("home");
  });
});
