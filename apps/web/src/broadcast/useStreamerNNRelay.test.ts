/**
 * Tests for useStreamerNNRelay — broadcast page's bridge from
 * streamer:nn-tick Socket.IO event to the overlay bus.
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
// Use the REAL sanitizeNnTick (only mock dispatchOverlayEvent) so this
// test catches regressions in the validator. Re-implementing the
// validator inline meant a strictness change in the real sanitizer
// went uncaught — the regression-trapping happens here now.
vi.mock("./state/overlayBus", async (importActual) => {
  const actual = await importActual<typeof import("./state/overlayBus")>();
  return {
    ...actual,
    dispatchOverlayEvent: (...args: unknown[]) => dispatchOverlayEvent(...args),
  };
});

import { useStreamerNNRelay } from "./useStreamerNNRelay";
import { SOCKET_EVENTS } from "@price-game/shared";

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket.on.mockReset();
  mockSocket.off.mockReset();
});

const VALID_TICK = {
  roundId: "r1",
  phase: "result",
  network: { layers: [], weightSamples: [] },
  prediction: { cents: 1234, sigma: 200 },
  belief: {
    topFeatures: [],
  },
  embedding2d: { x: 0, y: 0 },
  recentLosses: [],
  recentAccuracy: [],
  teachingMoment: { triggered: false },
  ageMs: 0,
};

describe("useStreamerNNRelay", () => {
  it("is a no-op when broadcast mode is off", () => {
    renderHook(() => useStreamerNNRelay(false));
    expect(mockSocket.on).not.toHaveBeenCalled();
  });

  it("subscribes to STREAMER_BOT_NN_TICK and dispatches as nn.tick", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    renderHook(() => useStreamerNNRelay(true));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, expect.any(Function));

    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_NN_TICK,
    )?.[1] as Listener;

    handler(VALID_TICK);
    expect(dispatchOverlayEvent).toHaveBeenCalledWith("nn.tick", VALID_TICK);
  });

  it("ignores malformed payloads from the server", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderHook(() => useStreamerNNRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_NN_TICK,
    )?.[1] as Listener;
    handler({ roundId: "bad", phase: "weird" });
    handler(null);
    handler("nope");
    expect(dispatchOverlayEvent).not.toHaveBeenCalled();
  });

  it("hydrates from /api/streamer/nn-tick on mount", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tick: VALID_TICK }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useStreamerNNRelay(true));
    await waitFor(() => {
      expect(dispatchOverlayEvent).toHaveBeenCalledWith("nn.tick", VALID_TICK);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/streamer/nn-tick", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("unsubscribes on unmount", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { unmount } = renderHook(() => useStreamerNNRelay(true));
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, expect.any(Function));
  });

  it("drops the GET payload when a socket event arrives mid-fetch (race fix)", async () => {
    let resolveFetch: (v: unknown) => void = () => undefined;
    const fetchPromise = new Promise<unknown>((r) => { resolveFetch = r; });
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    renderHook(() => useStreamerNNRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_NN_TICK,
    )?.[1] as (p: unknown) => void;

    handler({ ...VALID_TICK, roundId: "socket-fresh" });
    resolveFetch({ ok: true, json: async () => ({ tick: { ...VALID_TICK, roundId: "stale" } }) });
    await new Promise((r) => setTimeout(r, 0));

    const calls = dispatchOverlayEvent.mock.calls.filter((c) => c[0] === "nn.tick");
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { roundId: string }).roundId).toBe("socket-fresh");
  });
});
