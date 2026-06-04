import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModalHistory } from "../hooks/useModalHistory";

describe("useModalHistory", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;
  let backSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    pushStateSpy = vi.spyOn(window.history, "pushState");
    backSpy = vi.spyOn(window.history, "back");
  });

  afterEach(() => {
    pushStateSpy.mockRestore();
    backSpy.mockRestore();
  });

  it("initializes as not visible", () => {
    const { result } = renderHook(() => useModalHistory("test"));
    expect(result.current[0]).toBe(false);
  });

  it("pushes history entry with modal name when opened", () => {
    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe(true);
    expect(pushStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ modal: "category" }),
      ""
    );
  });

  it("preserves existing history.state fields on push", () => {
    window.history.replaceState({ screen: "home", idx: 0 }, "", "/");

    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });

    expect(pushStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "home", idx: 0, modal: "category" }),
      ""
    );
  });

  it("calls history.back() when closed via UI and entry is on top", () => {
    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });

    // Simulate that pushState actually set the state (jsdom doesn't do this automatically)
    window.history.replaceState({ modal: "category" }, "", "/");

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe(false);
    expect(backSpy).toHaveBeenCalled();
  });

  it("does NOT call history.back() when entry is buried under another", () => {
    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });

    // Another history entry was pushed on top (e.g., screen change)
    window.history.replaceState({ screen: "playing" }, "", "/");

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe(false);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("closes modal on popstate without modal field (back button)", () => {
    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });
    expect(result.current[0]).toBe(true);

    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "home" } })
      );
    });

    expect(result.current[0]).toBe(false);
  });

  it("closes modal on popstate with null state", () => {
    const { result } = renderHook(() => useModalHistory("test"));

    act(() => {
      result.current[1](true);
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    expect(result.current[0]).toBe(false);
  });

  it("does NOT close modal when popstate has matching modal name", () => {
    const { result } = renderHook(() => useModalHistory("category"));

    act(() => {
      result.current[1](true);
    });

    // Landing ON a stale modal entry (navigating back through history)
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { modal: "category" } })
      );
    });

    expect(result.current[0]).toBe(true);
  });

  it("does not double-push if already open", () => {
    const { result } = renderHook(() => useModalHistory("test"));

    act(() => {
      result.current[1](true);
    });
    act(() => {
      result.current[1](true);
    });

    expect(pushStateSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when closing an already-closed modal", () => {
    const { result } = renderHook(() => useModalHistory("test"));

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe(false);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("does not react to popstate when modal is closed", () => {
    const { result } = renderHook(() => useModalHistory("test"));

    // Modal never opened — popstate should be ignored
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "home" } })
      );
    });

    expect(result.current[0]).toBe(false);
  });

  it("cleans up popstate listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useModalHistory("test"));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("popstate", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("two modals can coexist — closing one does not affect the other", () => {
    const { result: modal1 } = renderHook(() => useModalHistory("giveaway"));
    const { result: modal2 } = renderHook(() => useModalHistory("auth"));

    act(() => {
      modal1.current[1](true);
    });
    act(() => {
      modal2.current[1](true);
    });

    expect(modal1.current[0]).toBe(true);
    expect(modal2.current[0]).toBe(true);

    // Back closes auth (top of stack) but not giveaway
    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { modal: "giveaway" } })
      );
    });

    expect(modal2.current[0]).toBe(false);
    expect(modal1.current[0]).toBe(true);
  });
});
