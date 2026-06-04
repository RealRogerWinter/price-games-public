import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PlayerProfileModal from "../components/PlayerProfileModal";
import * as api from "../api/client";
import { CurrencyProvider } from "../context/CurrencyContext";

vi.mock("../api/client");
vi.mock("../components/charts/RechartsAreaChart", () => ({
  default: () => <div data-testid="area-chart" />,
}));
vi.mock("../components/charts/RechartsBarChart", () => ({
  default: () => <div data-testid="bar-chart" />,
}));

const mockedApi = vi.mocked(api);

function renderModal(ui: React.ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter>
        <CurrencyProvider>{children}</CurrencyProvider>
      </MemoryRouter>
    ),
  });
}

const mockProfile = {
  username: "alice",
  lifetimeScore: 50000,
  totalGames: 42,
  bestScore: 8000,
  averageScore: 1190,
  gamesByMode: { classic: 20, "higher-lower": 15, comparison: 7 },
  multiplayerWins: 5,
  memberSince: "2025-06-15",
  winRecord: { wins: 30, losses: 12, currentStreak: 4, bestStreak: 9 },
};

describe("PlayerProfileModal", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} })),
    );
    mockedApi.getPublicProfile.mockResolvedValue({ profile: mockProfile });
    mockedApi.getPublicScoreHistory.mockResolvedValue({ history: [] });
    mockedApi.getPublicGameHistory.mockResolvedValue({
      entries: [],
      total: 0,
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("shows loading state while fetching", () => {
    mockedApi.getPublicProfile.mockReturnValue(new Promise(() => {}));
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );
    expect(screen.getByText("Loading profile...")).toBeInTheDocument();
  });

  it("renders username, lifetime score, and member since", async () => {
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("50,000")).toBeInTheDocument();
    expect(screen.getByText("Member since 2025-06-15")).toBeInTheDocument();
  });

  it("renders KPI cards", async () => {
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Games")).toBeInTheDocument();
    expect(screen.getByText("Avg Score")).toBeInTheDocument();
    expect(screen.getByText("Best Score")).toBeInTheDocument();
    expect(screen.getByText("MP Wins")).toBeInTheDocument();
  });

  it("renders daily points chart area", async () => {
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Daily Points")).toBeInTheDocument();
    });
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders games by mode chart", async () => {
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Most Played Modes")).toBeInTheDocument();
    });
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
  });

  it("shows error state on profile fetch failure", async () => {
    mockedApi.getPublicProfile.mockRejectedValue(new Error("Network error"));
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Failed to load profile.")).toBeInTheDocument();
    });
  });

  it("shows 'Player not found' on 404", async () => {
    mockedApi.getPublicProfile.mockRejectedValue(
      new Error("API error 404: Player not found"),
    );
    renderModal(
      <PlayerProfileModal username="nobody" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Player not found.")).toBeInTheDocument();
    });
  });

  it("close button calls onClose", async () => {
    const onClose = vi.fn();
    renderModal(
      <PlayerProfileModal username="alice" onClose={onClose} />,
    );

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("\u00d7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("chart range buttons refetch score history", async () => {
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Daily Points")).toBeInTheDocument();
    });

    // Default fetch was days=30; the 3rd arg is the browser timezone
    // (resolved via Intl), which varies by host — match any value.
    expect(mockedApi.getPublicScoreHistory).toHaveBeenCalledWith(
      "alice",
      30,
      expect.any(String),
    );

    fireEvent.click(screen.getByText("7d"));

    await waitFor(() => {
      expect(mockedApi.getPublicScoreHistory).toHaveBeenCalledWith(
        "alice",
        7,
        expect.any(String),
      );
    });
  });

  it("renders game history table with date-only entries", async () => {
    mockedApi.getPublicGameHistory.mockResolvedValue({
      entries: [
        {
          id: 1,
          gameType: "single" as const,
          gameMode: "classic",
          score: 5000,
          placement: null,
          playersCount: null,
          playedDate: "2026-04-01",
          shareId: null,
        },
      ],
      total: 1,
    });
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("2026-04-01")).toBeInTheDocument();
    });
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("SP")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });

  it("makes rows with shareId clickable; legacy rows without shareId stay non-clickable (PR3 sec H1)", async () => {
    // Pre-PR3 the public-profile modal linked every row to
    // `/recap/:historyId` regardless of shareId — but that route used
    // sequential integer ids and had no auth, so it was an unauth IDOR.
    // The PR3 fix routes public click-throughs via `/s/:shareId` (the
    // existing opaque-id surface). Legacy rows without a stamped
    // share_id render as non-clickable until the cold-path stamp
    // catches up; new rows stamp at write time.
    mockedApi.getPublicGameHistory.mockResolvedValue({
      entries: [
        {
          id: 11,
          gameType: "single" as const,
          gameMode: "classic",
          score: 5000,
          placement: null,
          playersCount: null,
          playedDate: "2026-04-01",
          shareId: null, // legacy row — non-clickable
        },
        {
          id: 12,
          gameType: "multiplayer" as const,
          gameMode: "classic",
          score: 3000,
          placement: 2,
          playersCount: 4,
          playedDate: "2026-04-02",
          shareId: "abcd1234", // has shareId — clickable to /s/abcd1234
        },
      ],
      total: 2,
    });
    renderModal(
      <PlayerProfileModal username="alice" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("2026-04-01")).toBeInTheDocument();
    });

    const clickable = document.querySelectorAll(".gh-row.gh-row-clickable");
    expect(clickable.length).toBe(1);
    // Only the row with a shareId gets the view chevron.
    const chevrons = document.querySelectorAll(".gh-view-icon");
    expect(chevrons.length).toBe(1);

    // Keyboard-only users must get the same affordance as mouse users:
    // role="link" so screen readers announce it, tabIndex=0 so Tab reaches
    // it, and a descriptive aria-label so the announcement is meaningful.
    for (const row of Array.from(clickable)) {
      expect(row).toHaveAttribute("role", "link");
      expect(row).toHaveAttribute("tabIndex", "0");
      expect(row.getAttribute("aria-label")).toMatch(/View recap/);
    }
  });
});
