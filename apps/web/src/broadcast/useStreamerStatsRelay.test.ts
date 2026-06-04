/**
 * Tests for useStreamerStatsRelay — the broadcast page's bridge from
 * the server's streamer-stats Socket.IO event to the overlay bus.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

type Listener = (payload: unknown) => void;

const mockSocket = {
  connected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("../api/socket", () => ({
  connectSocket: vi.fn(() => mockSocket),
  getSocket: vi.fn(() => mockSocket),
}));

const dispatchOverlayEvent = vi.fn();
vi.mock("./state/overlayBus", () => ({
  dispatchOverlayEvent: (...args: unknown[]) => dispatchOverlayEvent(...args),
}));

import { useStreamerStatsRelay } from "./useStreamerStatsRelay";
import { SOCKET_EVENTS } from "@price-game/shared";

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket.on.mockReset();
  mockSocket.off.mockReset();
});

describe("useStreamerStatsRelay", () => {
  it("is a no-op when broadcast mode is off", () => {
    renderHook(() => useStreamerStatsRelay(false));
    expect(mockSocket.on).not.toHaveBeenCalled();
  });

  it("subscribes to STREAMER_BOT_STATS and dispatches incoming payloads as stats.update", () => {
    // Stub fetch so the initial hydrate path is a noop.
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })));

    renderHook(() => useStreamerStatsRelay(true));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_STATS, expect.any(Function));

    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_STATS,
    )?.[1] as Listener;

    handler({ wins: 7, losses: 3, streak: 2, mood: "happy" });
    expect(dispatchOverlayEvent).toHaveBeenCalledWith("stats.update", {
      wins: 7,
      losses: 3,
      streak: 2,
      mood: "happy",
    });
  });

  it("ignores malformed payloads from the server", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderHook(() => useStreamerStatsRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_STATS,
    )?.[1] as Listener;
    handler({ wins: "lots", losses: 0, streak: 0 });
    handler(null);
    handler("nope");
    expect(dispatchOverlayEvent).not.toHaveBeenCalled();
  });

  it("hydrates from /api/streamer/stats on mount", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ stats: { wins: 11, losses: 4, streak: 1 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useStreamerStatsRelay(true));
    await waitFor(() => {
      expect(dispatchOverlayEvent).toHaveBeenCalledWith("stats.update", {
        wins: 11,
        losses: 4,
        streak: 1,
      });
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/streamer/stats", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("unsubscribes on unmount", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { unmount } = renderHook(() => useStreamerStatsRelay(true));
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_STATS, expect.any(Function));
  });

  it("drops the GET payload when a socket event arrives mid-fetch (race fix)", async () => {
    // Regression: the GET hydrate awaits a fetch while the socket is
    // attached concurrently. If a socket payload arrives DURING the
    // in-flight GET, the older cached GET response must NOT overwrite
    // it. Implementation: socket.on attached BEFORE the fetch fires,
    // and the GET resolver checks a "socketDeliveredFirst" flag.
    let resolveFetch: (v: unknown) => void = () => undefined;
    const fetchPromise = new Promise<unknown>((r) => { resolveFetch = r; });
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    renderHook(() => useStreamerStatsRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_STATS,
    )?.[1] as (p: unknown) => void;

    // Socket fires NEW value while GET is in flight.
    handler({ wins: 99, losses: 1, streak: 5 });
    // GET resolves later with stale cached snapshot.
    resolveFetch({ ok: true, json: async () => ({ stats: { wins: 1, losses: 0, streak: 1 } }) });
    await new Promise((r) => setTimeout(r, 0));

    // Only the socket payload should have been dispatched. The GET
    // result is dropped because the flag was already set.
    const calls = dispatchOverlayEvent.mock.calls.filter((c) => c[0] === "stats.update");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ wins: 99, losses: 1, streak: 5 });
  });
});
