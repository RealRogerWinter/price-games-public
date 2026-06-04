/**
 * Tests for useStreamerMusicRelay — the broadcast page's bridge from
 * the server's streamer-music Socket.IO event to the overlay bus.
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

import { useStreamerMusicRelay } from "./useStreamerMusicRelay";
import { SOCKET_EVENTS } from "@price-game/shared";

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket.on.mockReset();
  mockSocket.off.mockReset();
});

describe("useStreamerMusicRelay", () => {
  it("is a no-op when broadcast mode is off", () => {
    renderHook(() => useStreamerMusicRelay(false));
    expect(mockSocket.on).not.toHaveBeenCalled();
  });

  it("subscribes to STREAMER_BOT_MUSIC and dispatches incoming payloads as music.now", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderHook(() => useStreamerMusicRelay(true));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_MUSIC, expect.any(Function));

    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_MUSIC,
    )?.[1] as Listener;

    handler({ title: "Coffee Shop", artist: "Lofi Girl", album: "Loops" });
    expect(dispatchOverlayEvent).toHaveBeenCalledWith("music.now", {
      title: "Coffee Shop",
      artist: "Lofi Girl",
      album: "Loops",
    });
  });

  it("dispatches null when the server emits null (queue stopped)", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderHook(() => useStreamerMusicRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_MUSIC,
    )?.[1] as Listener;
    handler(null);
    expect(dispatchOverlayEvent).toHaveBeenCalledWith("music.now", null);
  });

  it("ignores malformed payloads", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderHook(() => useStreamerMusicRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_MUSIC,
    )?.[1] as Listener;
    handler({ title: "" });
    handler({ artist: "no title" });
    handler("not an object");
    expect(dispatchOverlayEvent).not.toHaveBeenCalled();
  });

  it("hydrates from /api/streamer/music on mount", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ music: { title: "Carefree", artist: "Kevin MacLeod" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useStreamerMusicRelay(true));
    await waitFor(() => {
      expect(dispatchOverlayEvent).toHaveBeenCalledWith("music.now", {
        title: "Carefree",
        artist: "Kevin MacLeod",
      });
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/streamer/music", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("hydrates explicit null from the server (operator-cleared queue)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ music: null }),
    })));
    renderHook(() => useStreamerMusicRelay(true));
    await waitFor(() => {
      expect(dispatchOverlayEvent).toHaveBeenCalledWith("music.now", null);
    });
  });

  it("unsubscribes on unmount", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { unmount } = renderHook(() => useStreamerMusicRelay(true));
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_MUSIC, expect.any(Function));
  });

  it("drops the GET payload when a socket event arrives mid-fetch (race fix)", async () => {
    let resolveFetch: (v: unknown) => void = () => undefined;
    const fetchPromise = new Promise<unknown>((r) => { resolveFetch = r; });
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    renderHook(() => useStreamerMusicRelay(true));
    const handler = mockSocket.on.mock.calls.find(
      (c) => c[0] === SOCKET_EVENTS.STREAMER_BOT_MUSIC,
    )?.[1] as (p: unknown) => void;

    handler({ title: "New Track", artist: "Live" });
    resolveFetch({ ok: true, json: async () => ({ music: { title: "Stale Cached" } }) });
    await new Promise((r) => setTimeout(r, 0));

    const calls = dispatchOverlayEvent.mock.calls.filter((c) => c[0] === "music.now");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ title: "New Track", artist: "Live" });
  });
});
