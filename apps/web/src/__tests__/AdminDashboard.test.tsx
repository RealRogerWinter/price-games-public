/**
 * Smoke test for the post-PR-209 AdminDashboard. The legacy v1 dashboard
 * tested 10+ widgets; this rewrite covers the three surfaces the new page
 * actually renders: combined chart loaded from the v2 endpoint, active
 * rooms ops widget, and the link to Insights.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/adminClient", () => ({
  getActiveRooms: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminDashboard from "../pages/admin/AdminDashboard";

const mockGetActiveRooms = vi.mocked(adminClient.getActiveRooms);

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetActiveRooms.mockResolvedValue([]);
  // Stub fetch for the v2 games-by-mode endpoint.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { date: "2026-04-28", mode: "classic", variant: "single", count: 5 },
        { date: "2026-04-28", mode: "classic", variant: "multiplayer", count: 3 },
      ],
    }),
  );
});

afterEach(() => {
  // `vi.restoreAllMocks` doesn't unstub globals; without this the fetch
  // stub leaks across test files in worker-reused vitest runs.
  vi.unstubAllGlobals();
});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <AdminDashboard />
    </MemoryRouter>,
  );
}

describe("AdminDashboard", () => {
  it("renders the page title and Insights link after the data loads", async () => {
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("admin-dashboard")).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: /Dashboard/i })).toBeInTheDocument();
    const link = screen.getByTestId("dashboard-insights-link");
    expect(link).toHaveAttribute("href", "/admin/analytics");
  });

  it("calls the v2 games-by-mode endpoint with the default range", async () => {
    renderDashboard();
    await waitFor(() => expect(mockGetActiveRooms).toHaveBeenCalled());
    const fetchSpy = vi.mocked(fetch);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/analytics/v2/games-by-mode?range=28d"),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("re-fetches when the range filter changes", async () => {
    renderDashboard();
    await waitFor(() => expect(mockGetActiveRooms).toHaveBeenCalled());
    const fetchSpy = vi.mocked(fetch);
    const initialCalls = fetchSpy.mock.calls.length;

    const select = screen.getByTestId("dashboard-range");
    fireEvent.change(select, { target: { value: "7d" } });

    await waitFor(() =>
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls),
    );
    expect(fetchSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("range=7d"),
      expect.any(Object),
    );
  });

  it("renders the empty-state message when no rooms are active", async () => {
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/No active rooms right now/i)).toBeInTheDocument(),
    );
  });

  it("renders the active-rooms table when rooms exist", async () => {
    mockGetActiveRooms.mockResolvedValueOnce([
      {
        code: "ABCDEFG",
        gameMode: "classic",
        status: "playing",
        currentRound: 3,
        totalRounds: 5,
        playerCount: 4,
        createdAt: "2026-04-28T20:00:00Z",
        lastActivityAt: "2026-04-28T20:05:00Z",
      },
    ]);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("active-room-ABCDEFG")).toBeInTheDocument(),
    );
  });

  it("surfaces an error if the v2 endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-error")).toBeInTheDocument(),
    );
  });
});
