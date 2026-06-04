import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LeaderboardPage from "../pages/LeaderboardPage";
import * as api from "../api/client";
import { CurrencyProvider } from "../context/CurrencyContext";

vi.mock("../api/client");
vi.mock("../components/PlayerProfileModal", () => ({
  default: ({ username, onClose }: { username: string; onClose: () => void }) => (
    <div data-testid="player-profile-modal">
      <span data-testid="profile-username">{username}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const mockedApi = vi.mocked(api);

/**
 * Render LeaderboardPage wrapped in a MemoryRouter so the page's
 * `useSearchParams` calls resolve. Defaults to the canonical URL with
 * no period selected; callers can override `initialPath` to exercise
 * preselected periods from the URL.
 */
function renderLeaderboard(
  props: Parameters<typeof LeaderboardPage>[0] = { onBack: vi.fn() },
  initialPath: string = "/leaderboard",
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <CurrencyProvider>
        <LeaderboardPage {...props} />
      </CurrencyProvider>
    </MemoryRouter>,
  );
}

describe("LeaderboardPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // The page now persists the open profile in history.state; clear it
    // between tests so pushes from one test don't leak into the mount of
    // the next (otherwise the modal opens pre-emptively and disambiguates
    // getByText lookups on usernames).
    window.history.replaceState({}, "");
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} })),
    );
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    mockedApi.getLongestStreakLeaderboard.mockResolvedValue({ leaderboard: [] });
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 0, week: 0, month: 0, all: 0,
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("shows loading state initially", () => {
    mockedApi.getLeaderboardV2.mockReturnValue(new Promise(() => {}));
    renderLeaderboard();
    expect(screen.getByText("Loading leaderboard...")).toBeInTheDocument();
  });

  it("shows empty message when no entries", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    renderLeaderboard();

    await waitFor(() => {
      expect(
        screen.getByText("No scores yet. Be the first to play!"),
      ).toBeInTheDocument();
    });
  });

  it("renders lifetime leaderboard entries with username, score, games, rank", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "Alice", lifetimeScore: 50000, totalGames: 42, avatar: null },
        { rank: 2, username: "Bob", lifetimeScore: 30000, totalGames: 25, avatar: null },
      ],
      period: "all",
    });
    renderLeaderboard();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("50,000")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    // RankBadge renders a "1st place" aria label for rank 1 via RankBadge
    expect(screen.getByLabelText("1st place")).toBeInTheDocument();
    expect(screen.getByLabelText("2nd place")).toBeInTheDocument();
  });

  it("calls getLeaderboardV2 on mount (not the multiplayer board)", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    renderLeaderboard();

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalled();
    });
    expect(mockedApi.getMpLeaderboard).not.toHaveBeenCalled();
  });

  // Note: a previous version of this page (before the SP/MP/All chip group)
  // intentionally hid Solo/Multiplayer toggles. Now the chips render as
  // role="tab" controls — the assertions below only guard against the old
  // role="button" variant being accidentally re-introduced.
  it("does NOT render SP/MP toggle as plain buttons (uses role=tab now)", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all", gameType: "all" });
    renderLeaderboard();

    await waitFor(() => {
      expect(
        screen.queryByText("Loading leaderboard..."),
      ).not.toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Solo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Multiplayer" })).not.toBeInTheDocument();
  });

  it("does NOT render game mode tab buttons", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    renderLeaderboard();

    await waitFor(() => {
      expect(
        screen.queryByText("Loading leaderboard..."),
      ).not.toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Precision" })).not.toBeInTheDocument();
  });

  it("clicking a username opens PlayerProfileModal", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "Alice", lifetimeScore: 50000, totalGames: 42, avatar: null },
      ],
      period: "all",
    });
    renderLeaderboard();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Alice"));

    expect(screen.getByTestId("player-profile-modal")).toBeInTheDocument();
    expect(screen.getByTestId("profile-username")).toHaveTextContent("Alice");
  });

  it("when openUsername is set, auto-opens PlayerProfileModal", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    renderLeaderboard({ onBack: vi.fn(), openUsername: "Bob" });

    await waitFor(() => {
      expect(screen.getByTestId("player-profile-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("profile-username")).toHaveTextContent("Bob");
  });

  it("clicking a username writes the profile into history.state so back-nav can restore it", async () => {
    // Back-nav contract: opening a profile pushes a history entry so that
    // navigating away (e.g. to /recap/:id) and hitting the browser back
    // button lands the user on the leaderboard with the same profile open.
    mockedApi.getLeaderboardV2.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "Alice", lifetimeScore: 50000, totalGames: 42 },
      ],
    });
    renderLeaderboard({ onBack: vi.fn() });

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Alice"));

    expect(
      (window.history.state as { leaderboardProfile?: string } | null)?.leaderboardProfile,
    ).toBe("Alice");
  });

  it("restores an open profile from history.state on mount (simulating browser-back from /recap)", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [] });
    // Simulate the state that would be left on the stack after the user
    // opened Alice's profile, navigated to /recap/:id, and hit back.
    window.history.replaceState({ leaderboardProfile: "Alice" }, "");

    renderLeaderboard({ onBack: vi.fn() });

    await waitFor(() => {
      expect(screen.getByTestId("player-profile-modal")).toBeInTheDocument();
    });
    expect(screen.getByTestId("profile-username")).toHaveTextContent("Alice");

    // Don't leak synthetic state into sibling tests.
    window.history.replaceState({}, "");
  });

  it("reacts to popstate events by syncing the open profile", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "Alice", lifetimeScore: 50000, totalGames: 42 },
      ],
    });
    renderLeaderboard({ onBack: vi.fn() });

    await waitFor(() => expect(screen.getByText("Alice")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Alice"));
    expect(screen.getByTestId("profile-username")).toHaveTextContent("Alice");

    // Dispatch a popstate with no profile in state — simulates the user
    // hitting back one extra time past the profile entry.
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));

    await waitFor(() => {
      expect(screen.queryByTestId("player-profile-modal")).not.toBeInTheDocument();
    });
  });

  it("calls onBack when Back button is clicked", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    const onBack = vi.fn();
    renderLeaderboard({ onBack });

    await waitFor(() => {
      expect(
        screen.queryByText("Loading leaderboard..."),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows error message on fetch failure", async () => {
    mockedApi.getLeaderboardV2.mockRejectedValue(new Error("Network error"));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    renderLeaderboard();

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load leaderboard."),
      ).toBeInTheDocument();
    });
    consoleSpy.mockRestore();
  });

  // ─── Longest Streak tab ───

  it("renders both Score and Longest Streak tabs", async () => {
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: "Score" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Longest Streak" })).toBeInTheDocument();
  });

  it("does not fetch streak data until the Longest Streak tab is clicked", async () => {
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });
    expect(mockedApi.getLongestStreakLeaderboard).not.toHaveBeenCalled();
  });

  it("lazy-loads the streak leaderboard the first time the tab is clicked", async () => {
    mockedApi.getLongestStreakLeaderboard.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "StreakStar", avatar: null, longestStreak: 42, currentStreak: 12 },
        { rank: 2, username: "FlameFan", avatar: "wizard", longestStreak: 25, currentStreak: 0 },
      ],
    });

    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    await waitFor(() => {
      expect(mockedApi.getLongestStreakLeaderboard).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(screen.getByText("StreakStar")).toBeInTheDocument();
    });
    expect(screen.getByText("FlameFan")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
  });

  it("shows empty message when streak board has no entries", async () => {
    mockedApi.getLongestStreakLeaderboard.mockResolvedValue({ leaderboard: [] });
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    await waitFor(() => {
      expect(
        screen.getByText("No streaks yet. Play the daily challenge!"),
      ).toBeInTheDocument();
    });
  });

  it("shows error message when streak fetch fails", async () => {
    mockedApi.getLongestStreakLeaderboard.mockRejectedValue(new Error("boom"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to load streak leaderboard.")).toBeInTheDocument();
    });
    consoleSpy.mockRestore();
  });

  it("does not refetch streak data when switching back and forth", async () => {
    mockedApi.getLongestStreakLeaderboard.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "StreakStar", avatar: null, longestStreak: 5, currentStreak: 0 },
      ],
    });
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));
    await waitFor(() => {
      expect(mockedApi.getLongestStreakLeaderboard).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Score" }));
    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    // Still only one call — the result was cached on first load.
    expect(mockedApi.getLongestStreakLeaderboard).toHaveBeenCalledOnce();
  });

  // ─── Period pills ───

  it("does not render any period pills when no periods have data", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 0, week: 0, month: 0, all: 0,
    });
    renderLeaderboard();
    await waitFor(() => {
      expect(mockedApi.getLeaderboardAvailability).toHaveBeenCalled();
    });
    expect(screen.queryByRole("tab", { name: "All Time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Day" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Month" })).not.toBeInTheDocument();
  });

  it("renders only the period pills for non-zero periods", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 0, week: 3, month: 5, all: 5,
    });
    renderLeaderboard();

    // "All Time" always renders alongside any non-zero bounded period.
    expect(await screen.findByRole("tab", { name: "All Time" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Week" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Month" })).toBeInTheDocument();
    // Day has zero players → pill hidden.
    expect(screen.queryByRole("tab", { name: "Day" })).not.toBeInTheDocument();
  });

  it("clicking a period pill refetches the leaderboard with that period", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 1, week: 1, month: 1, all: 1,
    });
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all" });
    renderLeaderboard();

    const weekPill = await screen.findByRole("tab", { name: "Week" });
    fireEvent.click(weekPill);

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "week",
        "all",
      );
    });
  });

  it("reads the initial period from the URL", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 1, week: 1, month: 1, all: 1,
    });
    renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?period=month");

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "month",
        "all",
      );
    });
  });

  it("renders PeriodLeaderboardEntry rows (score field) for bounded periods", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 0, week: 2, month: 2, all: 2,
    });
    mockedApi.getLeaderboardV2.mockResolvedValue({
      leaderboard: [
        { rank: 1, username: "Alice", score: 1234, totalGames: 5, avatar: null },
      ],
      period: "week",
    });
    renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?period=week");

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
    expect(screen.getByText("1,234")).toBeInTheDocument();
    // Column header reflects the period.
    expect(screen.getByText("Score (7d)")).toBeInTheDocument();
  });

  it("shows a period-specific empty message when the bounded board is empty", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 0, week: 1, month: 1, all: 1,
    });
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "week" });
    renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?period=week");

    await waitFor(() => {
      expect(screen.getByText("No scores yet in this period.")).toBeInTheDocument();
    });
  });

  it("does not show period pills on the Streak tab", async () => {
    mockedApi.getLeaderboardAvailability.mockResolvedValue({
      day: 1, week: 1, month: 1, all: 1,
    });
    renderLeaderboard();

    // Pills render on the default Score tab.
    await screen.findByRole("tab", { name: "All Time" });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    expect(screen.queryByRole("tab", { name: "All Time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Week" })).not.toBeInTheDocument();
  });

  // ─── SP/MP/All game-type chips ───

  it("renders the All / Solo / Multiplayer chip group on the Score tab", async () => {
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Solo" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Multiplayer" })).toBeInTheDocument();
  });

  it("defaults to gameType='all' on initial fetch", async () => {
    renderLeaderboard();
    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "all",
        "all",
      );
    });
  });

  it("clicking the Solo chip refetches with gameType='sp' and updates the URL", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all", gameType: "all" });
    renderLeaderboard();

    const soloChip = await screen.findByRole("tab", { name: "Solo" });
    fireEvent.click(soloChip);

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "all",
        "sp",
      );
    });
    // Chip should reflect selected state.
    expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("clicking Multiplayer refetches with gameType='mp'", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all", gameType: "all" });
    renderLeaderboard();

    const mpChip = await screen.findByRole("tab", { name: "Multiplayer" });
    fireEvent.click(mpChip);

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "all",
        "mp",
      );
    });
  });

  it("clicking back to All clears the gameType URL param", async () => {
    mockedApi.getLeaderboardV2.mockResolvedValue({ leaderboard: [], period: "all", gameType: "all" });
    renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?gameType=mp");

    // Wait for initial mount load with mp.
    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "all",
        "mp",
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: "All" }));

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenLastCalledWith(
        expect.any(Number),
        0,
        "all",
        "all",
      );
    });
  });

  it("reads the initial gameType from the URL", async () => {
    renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?gameType=sp");

    await waitFor(() => {
      expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(
        expect.any(Number),
        0,
        "all",
        "sp",
      );
    });
    expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("game-type chips are not rendered on the Streak tab", async () => {
    renderLeaderboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading leaderboard...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Longest Streak" }));

    expect(screen.queryByRole("tab", { name: "Solo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Multiplayer" })).not.toBeInTheDocument();
  });

  // ─── Numbered pagination ───

  describe("numbered pagination", () => {
    /** Build a 50-row page mock so totalPages = ceil(total / 50). */
    function fullPage(rank0: number) {
      return Array.from({ length: 50 }, (_, i) => ({
        rank: rank0 + i + 1,
        username: `u${rank0 + i + 1}`,
        lifetimeScore: 50000 - (rank0 + i),
        totalGames: 1,
        avatar: null,
      }));
    }

    it("hides the pagination control when total ≤ pageSize", async () => {
      mockedApi.getLeaderboardV2.mockResolvedValue({
        leaderboard: fullPage(0).slice(0, 5),
        period: "all",
        gameType: "all",
        total: 5,
      } as any);
      renderLeaderboard();

      await waitFor(() => {
        expect(screen.getByText("u1")).toBeInTheDocument();
      });
      expect(screen.queryByRole("navigation", { name: "Leaderboard pagination" })).not.toBeInTheDocument();
    });

    it("renders Prev/Next + numbered page buttons when total > pageSize", async () => {
      mockedApi.getLeaderboardV2.mockResolvedValue({
        leaderboard: fullPage(0),
        period: "all",
        gameType: "all",
        total: 200,
      } as any);
      renderLeaderboard();

      await waitFor(() => {
        expect(screen.getByRole("navigation", { name: "Leaderboard pagination" })).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Next page" })).not.toBeDisabled();
      // 200 / 50 = 4 pages. Page 1 list: 1, 2, ..., 4 (no ellipsis at this size)
      expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Page 4" })).toBeInTheDocument();
    });

    it("clicking Next refetches the next page with offset = pageSize", async () => {
      mockedApi.getLeaderboardV2
        .mockResolvedValueOnce({
          leaderboard: fullPage(0),
          period: "all",
          gameType: "all",
          total: 200,
        } as any)
        .mockResolvedValueOnce({
          leaderboard: fullPage(50),
          period: "all",
          gameType: "all",
          total: 200,
        } as any);
      renderLeaderboard();

      await waitFor(() => expect(screen.getByText("u1")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Next page" }));

      await waitFor(() => {
        expect(mockedApi.getLeaderboardV2).toHaveBeenLastCalledWith(50, 50, "all", "all");
      });
      await waitFor(() => expect(screen.getByText("u51")).toBeInTheDocument());
      // Old rows were replaced (not appended like Load More).
      expect(screen.queryByText("u1")).not.toBeInTheDocument();
    });

    it("clicking a numbered page jumps directly to that offset", async () => {
      mockedApi.getLeaderboardV2.mockResolvedValue({
        leaderboard: fullPage(0),
        period: "all",
        gameType: "all",
        total: 500,
      } as any);
      renderLeaderboard();

      await waitFor(() =>
        expect(screen.getByRole("navigation", { name: "Leaderboard pagination" })).toBeInTheDocument(),
      );

      // 500 / 50 = 10 pages. Last button should be Page 10.
      fireEvent.click(screen.getByRole("button", { name: "Page 10" }));

      await waitFor(() => {
        // Page 10 -> offset (10-1) * 50 = 450
        expect(mockedApi.getLeaderboardV2).toHaveBeenLastCalledWith(50, 450, "all", "all");
      });
    });

    it("changing the period filter resets pagination to page 1", async () => {
      mockedApi.getLeaderboardV2.mockResolvedValue({
        leaderboard: fullPage(0),
        period: "all",
        gameType: "all",
        total: 200,
      } as any);
      // Make all bounded periods available so the Week pill renders.
      mockedApi.getLeaderboardAvailability.mockResolvedValue({
        day: 1, week: 1, month: 1, all: 200,
      });

      renderLeaderboard({ onBack: vi.fn() }, "/leaderboard?page=3");

      await waitFor(() => {
        // First call: page=3 → offset 100.
        expect(mockedApi.getLeaderboardV2).toHaveBeenCalledWith(50, 100, "all", "all");
      });

      fireEvent.click(screen.getByRole("tab", { name: "Week" }));

      await waitFor(() => {
        // Period flip: page resets to 1, so offset 0.
        expect(mockedApi.getLeaderboardV2).toHaveBeenLastCalledWith(50, 0, "week", "all");
      });
    });
  });
});
