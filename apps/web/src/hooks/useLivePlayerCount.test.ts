/**
 * Tests for useLivePlayerCount — exposes the count of active public lobbies
 * so the home page can show "{N} games active" social proof.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLivePlayerCount } from "./useLivePlayerCount";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("useLivePlayerCount", () => {
  it("starts in 'loading' state and resolves to 'live' with the count", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lobbies: [{ code: "AAAA" }, { code: "BBBB" }, { code: "CCCC" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLivePlayerCount());
    expect(result.current.status).toBe("loading");
    expect(result.current.count).toBe(0);

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.count).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith("/api/mp/lobbies", expect.any(Object));
  });

  it("falls back to 'offline' status when the fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLivePlayerCount());
    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.count).toBe(0);
  });

  it("treats a non-OK response as offline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "bad" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLivePlayerCount());
    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.count).toBe(0);
  });

  it("handles a missing 'lobbies' array gracefully (treats as 0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLivePlayerCount());
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.count).toBe(0);
  });
});
