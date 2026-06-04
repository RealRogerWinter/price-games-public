import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import GameHistoryPanel from "../components/GameHistoryPanel";
import * as userClient from "../api/userClient";
import { renderWithProviders, makeGameHistoryEntry, flushMicrotasks } from "./testUtils";

// Partial mock: forward every real export (userGetMe, etc. the providers
// reach for on mount) and only stub the methods the test asserts on.
vi.mock("../api/userClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/userClient")>();
  return {
    ...actual,
    userGetStats: vi.fn(),
    userGetMonthlyPoints: vi.fn(),
    userGetScoreHistory: vi.fn(),
    userGetHistory: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

// GiveawayModal uses useUserAuth + useNavigate; mock it to avoid provider requirements
vi.mock("../components/GiveawayModal", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="giveaway-modal">
      <button onClick={onClose}>Close Giveaway</button>
    </div>
  ),
}));

// Mock chart components — they use recharts which needs a real DOM/canvas
vi.mock("../components/charts/RechartsAreaChart", () => ({
  default: () => <div data-testid="area-chart-mock" />,
}));

vi.mock("../components/charts/RechartsBarChart", () => ({
  default: ({ onBarClick }: { onBarClick?: (label: string) => void }) => (
    <div
      data-testid="bar-chart-mock"
      onClick={() => onBarClick?.("Classic")}
    />
  ),
}));

vi.mock("../components/charts/KpiCard", () => ({
  default: ({ value, label }: { value: string; label: string }) => (
    <div data-testid="kpi-card">
      <span>{value}</span>
      <span>{label}</span>
    </div>
  ),
}));

const mockedUserClient = vi.mocked(userClient);

const mockStats = {
  totalGames: 42,
  averageScore: 450,
  bestScore: 950,
  multiplayerWins: 5,
  gamesByMode: { classic: 20, higher_lower: 12, comparison: 10 },
};

const mockHistory = {
  entries: [
    makeGameHistoryEntry({ id: 1, gameType: "single", gameMode: "classic", score: 500 }),
    makeGameHistoryEntry({
      id: 2,
      gameType: "multiplayer",
      gameMode: "higher_lower",
      score: 700,
      placement: 1,
      playersCount: 4,
      playedAt: "2026-03-09T12:00:00Z",
    }),
  ],
  total: 2,
};

describe("GameHistoryPanel", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockNavigate.mockReset();

    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, giveawayMinPoints: 20000 }))
    );

    mockedUserClient.userGetStats.mockResolvedValue(mockStats as any);
    mockedUserClient.userGetMonthlyPoints.mockResolvedValue({ points: 5000, gamesPlayed: 10 });
    mockedUserClient.userGetScoreHistory.mockResolvedValue({ history: [] });
    mockedUserClient.userGetHistory.mockResolvedValue(mockHistory as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  describe("loading state", () => {
    it("shows loading stats text while fetching", () => {
      mockedUserClient.userGetStats.mockReturnValue(new Promise(() => {}));
      mockedUserClient.userGetHistory.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<GameHistoryPanel />);
      expect(screen.getByText("Loading stats...")).toBeInTheDocument();
    });

    it("shows loading chart text while fetching score history", () => {
      mockedUserClient.userGetScoreHistory.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<GameHistoryPanel />);
      expect(screen.getByText("Loading chart...")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // KPI cards
  // ---------------------------------------------------------------------------

  describe("KPI cards", () => {
    it("shows all four KPI cards after stats load", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByText("Total Games")).toBeInTheDocument();
      expect(screen.getByText("Avg Score")).toBeInTheDocument();
      expect(screen.getByText("Best Score")).toBeInTheDocument();
      expect(screen.getByText("MP Wins")).toBeInTheDocument();
    });

    it("displays correct values in KPI cards", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByText("42")).toBeInTheDocument();  // totalGames
      expect(screen.getByText("450")).toBeInTheDocument(); // averageScore
      expect(screen.getByText("950")).toBeInTheDocument(); // bestScore
      expect(screen.getByText("5")).toBeInTheDocument();   // multiplayerWins
    });

    it("does not show KPI cards when stats fail to load", async () => {
      mockedUserClient.userGetStats.mockRejectedValue(new Error("Network error"));
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      // No KPI cards shown when stats is null
      expect(screen.queryByText("Total Games")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // History table
  // ---------------------------------------------------------------------------

  describe("history table", () => {
    it("shows history table with entries after load", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      // Table headers
      expect(screen.getByText("Mode")).toBeInTheDocument();
      expect(screen.getByText("Score")).toBeInTheDocument();
      expect(screen.getByText("Result")).toBeInTheDocument();
    });

    it("shows score values for each entry", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByText("500")).toBeInTheDocument();
      expect(screen.getByText("700")).toBeInTheDocument();
    });

    it("shows '—' for single player result (no placement)", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      // The em dash is rendered via &mdash;
      const dashes = document.querySelectorAll(".gh-result-dash");
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });

    it("shows '#1/4' placement for multiplayer entry", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      expect(screen.getByText("#1/4")).toBeInTheDocument();
    });

    it("shows 'SP' badge for single player entries", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      expect(screen.getAllByText("SP").length).toBeGreaterThanOrEqual(1);
    });

    it("shows 'MP' badge for multiplayer entries", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      expect(screen.getAllByText("MP").length).toBeGreaterThanOrEqual(1);
    });

    it("shows empty state when no history exists", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({ entries: [], total: 0 });
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      expect(screen.getByText("No games played yet.")).toBeInTheDocument();
    });

    it("navigates to /recap/:historyId on row click, keyed by history row id", async () => {
      const historyEntries = {
        entries: [
          makeGameHistoryEntry({
            id: 7,
            gameType: "single",
            gameMode: "classic",
            score: 500,
          }),
        ],
        total: 1,
      };
      mockedUserClient.userGetHistory.mockResolvedValue(historyEntries as any);

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      const row = document.querySelector(".gh-row.gh-row-clickable") as HTMLElement | null;
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute("role", "link");
      expect(row).toHaveAttribute("tabIndex", "0");

      await act(async () => {
        fireEvent.click(row!);
        await flushMicrotasks();
      });

      expect(mockNavigate).toHaveBeenCalledWith("/recap/7");
    });

    it("makes every row clickable regardless of shareId presence", async () => {
      const historyMixed = {
        entries: [
          makeGameHistoryEntry({ id: 1, gameType: "single", gameMode: "classic", score: 500 }),
          makeGameHistoryEntry({ id: 2, gameType: "single", gameMode: "classic", score: 600, shareId: "abc12345" }),
        ],
        total: 2,
      };
      mockedUserClient.userGetHistory.mockResolvedValue(historyMixed as any);

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      const rows = document.querySelectorAll(".gh-row");
      expect(rows.length).toBe(2);
      const clickableRows = document.querySelectorAll(".gh-row.gh-row-clickable");
      expect(clickableRows.length).toBe(2);
    });

    it("activates navigation on Enter key press", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({
        entries: [makeGameHistoryEntry({ id: 42, gameType: "single", gameMode: "classic", score: 100 })],
        total: 1,
      } as any);

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      const row = document.querySelector(".gh-row.gh-row-clickable") as HTMLElement;
      await act(async () => {
        fireEvent.keyDown(row, { key: "Enter" });
        await flushMicrotasks();
      });
      expect(mockNavigate).toHaveBeenCalledWith("/recap/42");
    });

    it("shows filter empty state when filters are active and no results", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({ entries: [], total: 0 });
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      // Switch to Single Player filter → should trigger re-fetch with type filter
      mockedUserClient.userGetHistory.mockResolvedValue({ entries: [], total: 0 });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Single Player" }));
        await flushMicrotasks();
      });

      expect(screen.getByText("No games match the selected filters.")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Filter buttons
  // ---------------------------------------------------------------------------

  describe("filter buttons", () => {
    it("shows All, Single Player, and Multiplayer filter buttons", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Single Player" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Multiplayer" })).toBeInTheDocument();
    });

    it("clicking Single Player filter calls userGetHistory with type=single", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      mockedUserClient.userGetHistory.mockResolvedValue(mockHistory as any);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Single Player" }));
        await flushMicrotasks();
      });

      expect(mockedUserClient.userGetHistory).toHaveBeenCalledWith(
        10, // PAGE_SIZE
        0,
        "single",
        undefined
      );
    });

    it("clicking Multiplayer filter calls userGetHistory with type=multiplayer", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
        await flushMicrotasks();
      });

      expect(mockedUserClient.userGetHistory).toHaveBeenCalledWith(
        10,
        0,
        "multiplayer",
        undefined
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Chart range buttons
  // ---------------------------------------------------------------------------

  describe("chart range buttons", () => {
    it("shows 7d, 30d, and 90d range buttons", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "7d" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "30d" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "90d" })).toBeInTheDocument();
    });

    it("clicking 7d range calls userGetScoreHistory with 7", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "7d" }));
        await flushMicrotasks();
      });

      expect(mockedUserClient.userGetScoreHistory).toHaveBeenCalledWith(
        7,
        expect.any(String),
      );
    });

    it("clicking 90d range calls userGetScoreHistory with 90", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "90d" }));
        await flushMicrotasks();
      });

      expect(mockedUserClient.userGetScoreHistory).toHaveBeenCalledWith(
        90,
        expect.any(String),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe("pagination", () => {
    it("shows no pagination when only one page of results", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();
      // total=2 < PAGE_SIZE=10, so no pagination
      expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    });

    it("shows pagination when total exceeds PAGE_SIZE", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) =>
          makeGameHistoryEntry({ id: i + 1, score: 100 + i })
        ),
        total: 25,
      });

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    });

    it("Previous button is disabled on first page", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) =>
          makeGameHistoryEntry({ id: i + 1, score: 100 + i })
        ),
        total: 25,
      });

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    });

    it("clicking Next advances the page", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) =>
          makeGameHistoryEntry({ id: i + 1, score: 100 + i })
        ),
        total: 25,
      });

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await flushMicrotasks();
      });

      // On page 2 offset=10; type is empty string so component passes undefined
      expect(mockedUserClient.userGetHistory).toHaveBeenCalledWith(10, 10, undefined, undefined);
    });

    it("shows page info text", async () => {
      mockedUserClient.userGetHistory.mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) =>
          makeGameHistoryEntry({ id: i + 1, score: 100 + i })
        ),
        total: 25,
      });

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Monthly giveaway progress
  // ---------------------------------------------------------------------------

  describe("monthly giveaway progress", () => {
    it("shows giveaway progress section when banner has giveawayMinPoints", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      // Banner has giveawayMinPoints=20000 and monthlyPoints is set
      expect(screen.getByText(/Giveaway Progress/)).toBeInTheDocument();
    });

    it("shows remaining points text when not yet qualified", async () => {
      // monthlyPoints=5000, goal=20000 → 15000 pts to go
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.getByText(/15,000 pts to go/)).toBeInTheDocument();
    });

    it("does not show giveaway section when banner has no giveawayMinPoints", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ enabled: true, giveawayMinPoints: 0 }))
      );

      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      expect(screen.queryByText(/Giveaway Progress/)).not.toBeInTheDocument();
    });

    it("shows 'Giveaway Details' button that opens modal", async () => {
      renderWithProviders(<GameHistoryPanel />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Giveaway Details" }));
        await flushMicrotasks();
      });

      expect(screen.getByTestId("giveaway-modal")).toBeInTheDocument();
    });
  });
});
