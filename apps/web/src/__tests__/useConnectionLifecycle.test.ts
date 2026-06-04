import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { useConnectionLifecycle } from "../hooks/useConnectionLifecycle";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function makeSocket(overrides: Partial<{ connected: boolean }> = {}) {
  const emit = vi.fn();
  const disconnect = vi.fn();
  return {
    socket: {
      connected: overrides.connected ?? true,
      emit,
      disconnect,
    },
    emit,
    disconnect,
  };
}

describe("useConnectionLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("proactively disconnects after the tab is hidden for 5 minutes", () => {
    const { disconnect: socketDisconnect } = makeSocket();
    const connect = vi.fn();
    const disconnectFn = vi.fn();

    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: socketDisconnect } as any),
        connect,
        disconnect: disconnectFn,
      })
    );

    act(() => { setVisibility("hidden"); });
    // Nothing immediately.
    expect(disconnectFn).not.toHaveBeenCalled();
    // Still within the 5-min window — no-op.
    act(() => { vi.advanceTimersByTime(299_000); });
    expect(disconnectFn).not.toHaveBeenCalled();
    // Cross the threshold.
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(disconnectFn).toHaveBeenCalledTimes(1);
  });

  it("cancels the hidden timer if the tab becomes visible again in time", () => {
    const connect = vi.fn();
    const disconnectFn = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect,
        disconnect: disconnectFn,
      })
    );
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(30_000); });
    act(() => { setVisibility("visible"); });
    // Push well past the original 5-min window.
    act(() => { vi.advanceTimersByTime(360_000); });
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it("does NOT arm the hidden timer when shouldArmHiddenDisconnect is false", () => {
    // The user is on a non-active screen (lobby/results/join). Hiding
    // the tab there must not silently kill their socket — the connection
    // is shared with rejoin / chat presence and there's no game cost to
    // staying connected.
    const disconnectFn = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect: vi.fn(),
        disconnect: disconnectFn,
        shouldArmHiddenDisconnect: false,
      })
    );
    act(() => { setVisibility("hidden"); });
    // Push well past the 5-min threshold.
    act(() => { vi.advanceTimersByTime(310_000); });
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it("re-arms the hidden timer when shouldArmHiddenDisconnect flips to true", () => {
    // Initially the user is not in an active round (so we don't arm),
    // but they enter a round mid-hidden. The timer should arm at that
    // transition rather than waiting for the next visibility flip.
    const disconnectFn = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useConnectionLifecycle({
          getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
          connect: vi.fn(),
          disconnect: disconnectFn,
          shouldArmHiddenDisconnect: active,
        }),
      { initialProps: { active: true } }
    );
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(60_000); });
    // Round ends → flip to false. Existing timer must be cleared so a
    // user lingering on the results screen with the tab hidden isn't
    // dropped 4 minutes later.
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(310_000); });
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it("does NOT arm the hidden-on-mount timer when shouldArmHiddenDisconnect is false", () => {
    setVisibility("hidden");
    const disconnect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect: vi.fn(),
        disconnect,
        shouldArmHiddenDisconnect: false,
      })
    );
    act(() => { vi.advanceTimersByTime(310_000); });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("on resume: reconnects when the socket is disconnected", () => {
    const connect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: false, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect,
        disconnect: vi.fn(),
      })
    );
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("on resume: heartbeats with a 5s timeout and force-reconnects a zombie socket", () => {
    const emit = vi.fn();
    const disconnectSocket = vi.fn();
    const connect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit, disconnect: disconnectSocket } as any),
        connect,
        disconnect: vi.fn(),
      })
    );
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    // A heartbeat emit went out.
    const heartbeatCalls = emit.mock.calls.filter(
      (c) => c[0] === SOCKET_EVENTS.MP_HEARTBEAT
    );
    expect(heartbeatCalls.length).toBe(1);
    // Ack never returns. 5s later we should kill the zombie socket.
    act(() => { vi.advanceTimersByTime(5_500); });
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("on resume: a live ack keeps the socket; no force reconnect", () => {
    const emit = vi.fn((_evt: string, _data: any, cb?: Function) => {
      if (cb) cb({ t: Date.now() });
    });
    const disconnectSocket = vi.fn();
    const connect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit, disconnect: disconnectSocket } as any),
        connect,
        disconnect: vi.fn(),
      })
    );
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    act(() => { vi.advanceTimersByTime(5_500); });
    expect(disconnectSocket).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("window 'offline' triggers disconnect; 'online' triggers connect", () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect,
        disconnect,
      })
    );
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(disconnect).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("is inert when `enabled` is false", () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        enabled: false,
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect,
        disconnect,
      })
    );
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(310_000); });
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("arms the hidden timer on mount when the tab is already hidden", () => {
    setVisibility("hidden");
    const disconnect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
        connect: vi.fn(),
        disconnect,
      })
    );
    // No visibilitychange event will fire — hook must notice on mount.
    act(() => { vi.advanceTimersByTime(301_000); });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("parent re-rendering with new callback identities does not reset the hidden timer", () => {
    const disconnect1 = vi.fn();
    const disconnect2 = vi.fn();
    // Render with disconnect1, then re-render with disconnect2 — the
    // current disconnect function should be the latest (2), and the
    // hidden timer started under the first render should NOT be reset.
    const { rerender } = renderHook(
      ({ d }) =>
        useConnectionLifecycle({
          getSocket: () => ({ connected: true, emit: vi.fn(), disconnect: vi.fn() } as any),
          connect: vi.fn(),
          disconnect: d,
        }),
      { initialProps: { d: disconnect1 } }
    );
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(150_000); });
    // Parent re-renders and hands us a new disconnect function.
    rerender({ d: disconnect2 });
    act(() => { vi.advanceTimersByTime(151_000); });
    // Timer continues from its original 5 min, so by now it has fired.
    // The LATEST callback (disconnect2) should have been invoked — not
    // disconnect1, which was stale by the time the timer ran.
    expect(disconnect1).not.toHaveBeenCalled();
    expect(disconnect2).toHaveBeenCalledTimes(1);
  });

  it("a late heartbeat ack does not cancel a subsequent heartbeat's zombie timer", () => {
    // Capture the emit callbacks so we can invoke them out of order.
    const emitCallbacks: Function[] = [];
    const emit = vi.fn((_evt: string, _data: any, cb?: Function) => {
      if (cb) emitCallbacks.push(cb);
    });
    const disconnectSocket = vi.fn();
    const connect = vi.fn();
    renderHook(() =>
      useConnectionLifecycle({
        getSocket: () => ({ connected: true, emit, disconnect: disconnectSocket } as any),
        connect,
        disconnect: vi.fn(),
      })
    );
    // Resume #1 — sends heartbeat 1.
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    expect(emitCallbacks.length).toBe(1);
    // Resume #2 — sends heartbeat 2 (supersedes 1).
    act(() => { setVisibility("hidden"); });
    act(() => { setVisibility("visible"); });
    expect(emitCallbacks.length).toBe(2);
    // Heartbeat 1's ack arrives LATE. It must not cancel heartbeat 2's
    // zombie timer.
    act(() => { emitCallbacks[0]({ t: Date.now() }); });
    // Heartbeat 2 never acks → after 5s we should force a reconnect.
    act(() => { vi.advanceTimersByTime(5_500); });
    expect(disconnectSocket).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
