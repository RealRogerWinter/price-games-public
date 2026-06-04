/**
 * Tests for StreakCard — covers loading, active streak, zero/broken streak,
 * day strip rendering, error handling, and daily-disabled state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DailyDisabledError } from "../api/dailyClient";

vi.mock("../api/dailyClient", () => ({
  fetchDailyToday: vi.fn(),
  fetchDailyHistory: vi.fn(),
  DailyDisabledError: class extends Error {
    constructor(msg = "disabled") {
      super(msg);
      this.name = "DailyDisabledError";
    }
  },
}));

vi.mock("../assets/streak-missed.webp", () => ({ default: "streak-missed.webp" }));
vi.mock("../assets/streak-bronze.webp", () => ({ default: "streak-bronze.webp" }));
vi.mock("../assets/streak-silver.webp", () => ({ default: "streak-silver.webp" }));
vi.mock("../assets/streak-gold.webp", () => ({ default: "streak-gold.webp" }));
vi.mock("../assets/streak-diamond.webp", () => ({ default: "streak-diamond.webp" }));
vi.mock("../assets/streak-today.webp", () => ({ default: "streak-today.webp" }));

import { fetchDailyToday, fetchDailyHistory } from "../api/dailyClient";
import StreakCard from "../components/StreakCard";

const mockFetchToday = vi.mocked(fetchDailyToday);
const mockFetchHistory = vi.mocked(fetchDailyHistory);

function makeTodayResponse(streak: { current: number; best: number; lastDate: string | null }) {
  return {
    date: "2026-04-09",
    gameMode: "classic" as const,
    modeName: "Classic",
    totalRounds: 5,
    alreadyPlayed: false,
    streak,
  };
}

describe("StreakCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Loading state ---

  it("shows loading state while data is being fetched", () => {
    mockFetchToday.mockReturnValue(new Promise(() => {}));
    mockFetchHistory.mockReturnValue(new Promise(() => {}));
    render(<StreakCard />);
    expect(screen.getByTestId("streak-card-loading")).toBeInTheDocument();
  });

  // --- Active streak ---

  it("renders current streak count and best for an active streak", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 14, best: 28, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByTestId("streak-card-count")).toHaveTextContent("14");
    });
    expect(screen.getByText("DAILY STREAK")).toBeInTheDocument();
    expect(screen.getByText(/Best: 28 days/)).toBeInTheDocument();
  });

  it("shows DAILY STREAK title for an active streak", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 5, best: 5, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByTestId("streak-card-flame")).toHaveTextContent("DAILY STREAK");
    });
  });

  // --- Zero streak (never played) ---

  it("shows empty state when user has never played daily", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 0, best: 0, lastDate: null }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByTestId("streak-card-count")).toHaveTextContent("0");
    });
    expect(screen.getByText(/Play your first daily/i)).toBeInTheDocument();
  });

  // --- Broken streak ---

  it("shows broken streak state when current is 0 but best > 0", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 0, best: 12, lastDate: "2026-04-05" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByTestId("streak-card-count")).toHaveTextContent("0");
    });
    expect(screen.getByText(/Best: 12 days/)).toBeInTheDocument();
    expect(screen.getByText(/Start a new streak/i)).toBeInTheDocument();
  });

  // --- Day strip ---

  it("marks played days in the day strip", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 3, best: 3, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({
      plays: [
        { date: "2026-04-09", gameMode: "classic" as const, score: 4500, completedAt: "2026-04-09T10:00:00Z", streakAtCompletion: 3, perRoundScores: [900, 900, 900, 900, 900] },
        { date: "2026-04-08", gameMode: "classic" as const, score: 3000, completedAt: "2026-04-08T10:00:00Z", streakAtCompletion: 2, perRoundScores: [600, 600, 600, 600, 600] },
        { date: "2026-04-07", gameMode: "classic" as const, score: 1000, completedAt: "2026-04-07T10:00:00Z", streakAtCompletion: 1, perRoundScores: [200, 200, 200, 200, 200] },
      ],
    });
    render(<StreakCard />);

    await waitFor(() => {
      const playedCells = document.querySelectorAll("[data-played='true']");
      expect(playedCells.length).toBe(3);
    });
  });

  it("marks today's cell with a special class", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 1, best: 1, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      const todayCell = document.querySelector("[data-date='2026-04-09']");
      expect(todayCell).toBeInTheDocument();
      expect(todayCell).toHaveClass("streak-card-day--today");
    });
  });

  it("uses tier-based icon for played days and missed icon for unplayed", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 1, best: 1, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({
      plays: [
        { date: "2026-04-09", gameMode: "classic" as const, score: 4500, completedAt: "2026-04-09T10:00:00Z", streakAtCompletion: 1, perRoundScores: [] },
      ],
    });
    render(<StreakCard />);

    await waitFor(() => {
      const playedDay = document.querySelector("[data-date='2026-04-09'] img");
      expect(playedDay).toHaveAttribute("src", "streak-bronze.webp");
    });
    const missedDay = document.querySelector("[data-date='2026-04-08'] img");
    expect(missedDay).toHaveAttribute("src", "streak-missed.webp");
  });

  // --- Error state ---

  it("shows error state when fetchDailyToday rejects", async () => {
    mockFetchToday.mockRejectedValue(new Error("Network error"));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load streak data/i)).toBeInTheDocument();
    });
  });

  // --- Daily disabled ---

  it("shows unavailable message when daily is disabled", async () => {
    mockFetchToday.mockRejectedValue(new DailyDisabledError());
    mockFetchHistory.mockRejectedValue(new Error("401"));
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByText(/Daily challenges are currently unavailable/i)).toBeInTheDocument();
    });
  });

  // --- Best streak hidden when equal to current ---

  it("hides best streak label when best equals current", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 5, best: 5, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(screen.getByTestId("streak-card-count")).toHaveTextContent("5");
    });
    expect(screen.queryByText(/Best:/)).not.toBeInTheDocument();
  });

  // --- API call with limit ---

  it("fetches daily history with limit of 42", async () => {
    mockFetchToday.mockResolvedValue(makeTodayResponse({ current: 1, best: 1, lastDate: "2026-04-09" }));
    mockFetchHistory.mockResolvedValue({ plays: [] });
    render(<StreakCard />);

    await waitFor(() => {
      expect(mockFetchHistory).toHaveBeenCalledWith(42);
    });
  });
});
