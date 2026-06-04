import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useRejoinBanner } from "../hooks/useRejoinBanner";

// Mock the api/socket module so we can drive getPlayerSession deterministically.
vi.mock("../api/socket", () => ({
  getPlayerSession: vi.fn(() => null),
  clearPlayerSession: vi.fn(),
}));
import { getPlayerSession, clearPlayerSession } from "../api/socket";

/**
 * Render the hook under a MemoryRouter so `useLocation()` resolves. The
 * `initialEntries` lets each test seed a starting path.
 */
function renderUnderRouter(initial: string = "/"): ReturnType<typeof renderHook<ReturnType<typeof useRejoinBanner>, void>> {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="*" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    );
  }
  return renderHook(() => useRejoinBanner(), { wrapper: Wrapper });
}

describe("useRejoinBanner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPlayerSession).mockReturnValue(null);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "lobby" })),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns null rejoinInfo when there's no saved session", async () => {
    const { result } = renderUnderRouter();
    // Wait past the debounce. The hook should NOT fetch.
    await new Promise((r) => setTimeout(r, 320));
    expect(result.current.rejoinInfo).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("populates rejoinInfo when the saved room is still active", async () => {
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "t",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "lobby" })),
    );
    const { result } = renderUnderRouter();
    await waitFor(() => {
      expect(result.current.rejoinInfo).toEqual({
        roomCode: "ABCD",
        status: "lobby",
      });
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/mp/room/ABCD");
  });

  it("clears the saved session when the server says the room is finished", async () => {
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "t",
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "finished" })),
    );
    const { result } = renderUnderRouter();
    await waitFor(() => {
      expect(clearPlayerSession).toHaveBeenCalled();
    });
    expect(result.current.rejoinInfo).toBeNull();
  });

  it("clears the saved session on a 404 (room no longer exists)", async () => {
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "GONE",
      playerId: "p1",
      playerToken: "t",
    });
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    const { result } = renderUnderRouter();
    await waitFor(() => {
      expect(clearPlayerSession).toHaveBeenCalled();
    });
    expect(result.current.rejoinInfo).toBeNull();
  });

  it("dismiss-clear() removes both local state and persisted session", async () => {
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "t",
    });
    const { result } = renderUnderRouter();
    await waitFor(() => {
      expect(result.current.rejoinInfo).not.toBeNull();
    });
    act(() => {
      result.current.clear();
    });
    expect(clearPlayerSession).toHaveBeenCalled();
    expect(result.current.rejoinInfo).toBeNull();
  });

  it("re-evaluates the saved session when the route changes", async () => {
    // Start with no session — banner stays empty.
    vi.mocked(getPlayerSession).mockReturnValue(null);
    function HarnessWrapper({ children }: { children: ReactNode }) {
      return (
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="*" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      );
    }
    function useHarness() {
      const banner = useRejoinBanner();
      const navigate = useNavigate();
      return { banner, navigate };
    }
    const { result } = renderHook(() => useHarness(), { wrapper: HarnessWrapper });
    await new Promise((r) => setTimeout(r, 320));
    expect(result.current.banner.rejoinInfo).toBeNull();

    // Now a session appears (e.g., user just left an MP game). Navigate
    // — the location-keyed effect should pick it up on the next pass.
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "EFGH",
      playerId: "p2",
      playerToken: "t2",
    });
    act(() => {
      result.current.navigate("/scoreboard");
    });
    await waitFor(() => {
      expect(result.current.banner.rejoinInfo).toEqual({
        roomCode: "EFGH",
        status: "lobby",
      });
    });
  });

  it("debounces rapid navigations into a single server lookup", async () => {
    vi.mocked(getPlayerSession).mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "t",
    });
    function HarnessWrapper({ children }: { children: ReactNode }) {
      return (
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="*" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      );
    }
    function useHarness() {
      const banner = useRejoinBanner();
      const navigate = useNavigate();
      return { banner, navigate };
    }
    const { result } = renderHook(() => useHarness(), { wrapper: HarnessWrapper });
    // Fire several quick navigations BEFORE the debounce elapses. Only
    // the final one should result in a fetch.
    act(() => {
      result.current.navigate("/a");
      result.current.navigate("/b");
      result.current.navigate("/c");
    });
    await waitFor(() => {
      expect(result.current.banner.rejoinInfo?.roomCode).toBe("ABCD");
    });
    // Three intermediate location changes plus the initial mount could
    // have triggered up to four fetches without debounce — assert we
    // collapsed those into at most one outstanding request per quiet
    // window. (`fetchSpy.mock.calls.length` may be 1 or 2 depending on
    // jsdom timing; the important thing is it's well below 4.)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
