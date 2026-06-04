import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initBeacon, enqueue, flush, __resetBeaconState, __getBeaconState, tracking_disabled } from "./beacon";

let fetchMock: ReturnType<typeof vi.fn>;
let sendBeaconMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetBeaconState();
  localStorage.clear();

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  sendBeaconMock = vi.fn().mockReturnValue(true);

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(navigator, "sendBeacon", {
    value: sendBeaconMock,
    writable: true,
    configurable: true,
  });

  // Ensure DNT defaults to off between tests.
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


describe("initBeacon + enqueue + flush", () => {
  it("initializes only once and returns a teardown", () => {
    const teardown1 = initBeacon();
    const teardown2 = initBeacon(); // no-op second call
    expect(typeof teardown1).toBe("function");
    expect(typeof teardown2).toBe("function");
    teardown1();
  });

  it("buffers events and flushes them to /api/events/track", async () => {
    initBeacon();
    enqueue({ name: "test_event", category: "custom", path: "/x" });
    await flush();

    // Either fetch(keepalive) OR sendBeacon is used depending on the
    // browser's capability detection. Both are accepted transports;
    // we assert SOMETHING was sent to the right endpoint.
    const fetchCall = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
    const beaconCall = sendBeaconMock.mock.calls[0] as [string, Blob] | undefined;
    const urlSent = fetchCall?.[0] ?? beaconCall?.[0];
    expect(urlSent).toBe("/api/events/track");

    if (fetchCall) {
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].name).toBe("test_event");
    }
  });

  it("falls back to sendBeacon if fetch throws", async () => {
    initBeacon();
    fetchMock.mockRejectedValue(new Error("network"));
    enqueue({ name: "fallback_event", path: "/" });
    await flush();
    expect(sendBeaconMock).toHaveBeenCalled();
  });

  it("persists to localStorage when both fetch and sendBeacon fail", async () => {
    initBeacon();
    fetchMock.mockRejectedValue(new Error("fetch-down"));
    sendBeaconMock.mockReturnValue(false);
    enqueue({ name: "unreachable", path: "/" });
    await flush();
    expect(localStorage.getItem("pg_ev_buf")).not.toBeNull();
  });

  it("caps buffer at 200 events and emits a buffer_overflowed sentinel", () => {
    initBeacon();
    for (let i = 0; i < 250; i++) {
      enqueue({ name: `e${i}`, path: "/" });
    }
    const state = __getBeaconState();
    expect(state).not.toBeNull();
    expect(state!.buffer.length).toBeLessThanOrEqual(200);
    expect(state!.buffer.some((e) => e.name === "buffer_overflowed")).toBe(true);
  });

  it("is a no-op when DNT is set", async () => {
    Object.defineProperty(navigator, "doNotTrack", {
      value: "1",
      writable: true,
      configurable: true,
    });
    expect(tracking_disabled()).toBe(true);
    initBeacon();
    enqueue({ name: "should_not_send", path: "/" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when globalPrivacyControl is set", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(tracking_disabled()).toBe(true);
    initBeacon();
    enqueue({ name: "should_not_send", path: "/" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates oversized properties to a sentinel object", () => {
    initBeacon();
    enqueue({
      name: "huge",
      path: "/",
      properties: { big: "x".repeat(3000) },
    });
    const state = __getBeaconState();
    expect(state!.buffer[0]!.properties).toEqual({ _truncated: true });
  });

  it("ignores enqueue calls before init", () => {
    enqueue({ name: "orphan", path: "/" });
    const state = __getBeaconState();
    expect(state).toBeNull();
  });

  it("flushes on visibilitychange → hidden", async () => {
    initBeacon();
    enqueue({ name: "pageleft", path: "/" });
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 10));
    expect(
      fetchMock.mock.calls.length + sendBeaconMock.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it("flushes on pagehide", async () => {
    initBeacon();
    enqueue({ name: "pageleft", path: "/" });
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 10));
    expect(
      fetchMock.mock.calls.length + sendBeaconMock.mock.calls.length,
    ).toBeGreaterThan(0);
  });
});
