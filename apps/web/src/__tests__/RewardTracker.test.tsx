import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { PromoBanner } from "@price-game/shared";

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: vi.fn(() => ({
    isAuthenticated: true,
    user: { emailVerified: true },
  })),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock("../api/userClient", () => ({
  userGetMonthlyPoints: vi.fn(),
}));

import { useUserAuth } from "../context/UserAuthContext";
import { userGetMonthlyPoints } from "../api/userClient";
import RewardTracker from "../components/RewardTracker";

/** Minimal PromoBanner for tests. */
function makeBanner(overrides: Partial<PromoBanner> = {}): PromoBanner {
  return {
    enabled: true,
    text: "Win prizes!",
    linkText: "Learn More",
    linkUrl: "/learn",
    audienceMode: "all",
    showLink: true,
    showGiveawayModal: true,
    giveawayMinPoints: 500,
    giveawayMinStreak: 0,
    giveawayQualifyMode: "points_only",
    showTracker: true,
    qualifiedMessage: "",
    ...overrides,
  };
}

describe("RewardTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: { emailVerified: true } as never,
    });
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 0, gamesPlayed: 0, streak: 0 });
  });

  it("returns null when user is not authenticated", async () => {
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    const { container } = render(<RewardTracker banner={makeBanner()} />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("returns null when user is authenticated but email is not verified", async () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: { emailVerified: false } as never,
    });
    const { container } = render(<RewardTracker banner={makeBanner()} />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("returns null when the API call fails", async () => {
    vi.mocked(userGetMonthlyPoints).mockRejectedValue(new Error("Server error"));
    const { container } = render(<RewardTracker banner={makeBanner()} />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("shows loading skeleton (bar-fill at 0 width) while points are loading", () => {
    // Return a promise that never resolves to keep loading state
    vi.mocked(userGetMonthlyPoints).mockReturnValue(new Promise(() => {}));
    render(<RewardTracker banner={makeBanner()} />);
    expect(screen.getByTestId("reward-tracker")).toBeInTheDocument();
    const fill = screen
      .getByTestId("reward-tracker")
      .querySelector(".promo-tracker-bar-fill");
    expect(fill).toBeTruthy();
    expect((fill as HTMLElement).style.width).toBe("0px");
  });

  it("renders reward-tracker container after points load", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 100, gamesPlayed: 2 });
    render(<RewardTracker banner={makeBanner()} />);
    await act(async () => {});
    expect(screen.getByTestId("reward-tracker")).toBeInTheDocument();
  });

  it("shows progress bar when points are below the threshold", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 250, gamesPlayed: 3 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    expect(screen.getByText("250 / 500 pts")).toBeInTheDocument();
  });

  it("shows games played count in progress view", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 100, gamesPlayed: 4 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    expect(screen.getByText("4 games this month")).toBeInTheDocument();
  });

  it("uses singular 'game' when gamesPlayed is 1", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 100, gamesPlayed: 1 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    expect(screen.getByText("1 game this month")).toBeInTheDocument();
  });

  it("shows qualified message when points meet the threshold", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 500, gamesPlayed: 8 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    // The check mark character should appear
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("shows qualified message when points exceed the threshold", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 750, gamesPlayed: 10 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    expect(screen.getByText("✓")).toBeInTheDocument();
    // The progress bar should NOT appear
    expect(screen.queryByText(/\/.*pts/)).not.toBeInTheDocument();
  });

  it("replaces {month} placeholder in qualified message with current month name", async () => {
    const MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const currentMonth = MONTH_NAMES[new Date().getMonth()];
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 600, gamesPlayed: 5 });
    render(
      <RewardTracker
        banner={makeBanner({
          giveawayMinPoints: 500,
          qualifiedMessage: "You qualified for {month}!",
        })}
      />
    );
    await act(async () => {});
    expect(screen.getByText(`You qualified for ${currentMonth}!`)).toBeInTheDocument();
  });

  it("uses default qualified message when qualifiedMessage is empty string", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 600, gamesPlayed: 5 });
    render(
      <RewardTracker
        banner={makeBanner({ giveawayMinPoints: 500, qualifiedMessage: "" })}
      />
    );
    await act(async () => {});
    // Default message contains the current month name and "drawing"
    const MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const currentMonth = MONTH_NAMES[new Date().getMonth()];
    expect(screen.getByText(new RegExp(`${currentMonth}.*drawing`))).toBeInTheDocument();
  });

  it("shows 'Share your link' button in the qualified state", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 600, gamesPlayed: 5 });
    render(<RewardTracker banner={makeBanner({ giveawayMinPoints: 500 })} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Share your link" })).toBeInTheDocument();
  });

  it("does not call userGetMonthlyPoints when not authenticated", () => {
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    render(<RewardTracker banner={makeBanner()} />);
    expect(userGetMonthlyPoints).not.toHaveBeenCalled();
  });

  it("calls userGetMonthlyPoints when refreshKey changes", async () => {
    vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 100, gamesPlayed: 2, streak: 0 });
    const { rerender } = render(
      <RewardTracker banner={makeBanner()} refreshKey={0} />
    );
    await act(async () => {});
    expect(userGetMonthlyPoints).toHaveBeenCalledTimes(1);

    rerender(<RewardTracker banner={makeBanner()} refreshKey={1} />);
    await act(async () => {});
    expect(userGetMonthlyPoints).toHaveBeenCalledTimes(2);
  });

  // ── Streak qualification modes ─────────────────────────────────────────────
  describe("streak qualification modes", () => {
    it("streak_only: shows streak progress and hides points bar", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 0, gamesPlayed: 0, streak: 3 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "streak_only",
            giveawayMinStreak: 7,
            giveawayMinPoints: 500,
          })}
        />
      );
      await act(async () => {});
      expect(screen.getByTestId("reward-tracker-streak")).toBeInTheDocument();
      expect(screen.queryByTestId("reward-tracker-points")).not.toBeInTheDocument();
      expect(screen.getByText(/3 \/ 7 days/)).toBeInTheDocument();
    });

    it("streak_only: qualifies when streak meets threshold", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 0, gamesPlayed: 0, streak: 7 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "streak_only",
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("points_and_streak: shows both bars, only qualifies when both met", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 500, gamesPlayed: 3, streak: 4 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "points_and_streak",
            giveawayMinPoints: 500,
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      // Points met but streak not — should NOT be qualified
      expect(screen.queryByText("✓")).not.toBeInTheDocument();
      // Both indicators are visible
      expect(screen.getByTestId("reward-tracker-points")).toBeInTheDocument();
      expect(screen.getByTestId("reward-tracker-streak")).toBeInTheDocument();
    });

    it("points_and_streak: qualifies when both criteria are met", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 500, gamesPlayed: 3, streak: 7 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "points_and_streak",
            giveawayMinPoints: 500,
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("points_or_streak: qualifies when only points threshold is met", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 500, gamesPlayed: 3, streak: 0 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "points_or_streak",
            giveawayMinPoints: 500,
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("points_or_streak: qualifies when only streak threshold is met", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 0, gamesPlayed: 0, streak: 10 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "points_or_streak",
            giveawayMinPoints: 500,
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      expect(screen.getByText("✓")).toBeInTheDocument();
    });

    it("points_or_streak: shows both bars when neither criterion met", async () => {
      vi.mocked(userGetMonthlyPoints).mockResolvedValue({ points: 100, gamesPlayed: 1, streak: 2 });
      render(
        <RewardTracker
          banner={makeBanner({
            giveawayQualifyMode: "points_or_streak",
            giveawayMinPoints: 500,
            giveawayMinStreak: 7,
          })}
        />
      );
      await act(async () => {});
      expect(screen.queryByText("✓")).not.toBeInTheDocument();
      expect(screen.getByTestId("reward-tracker-points")).toBeInTheDocument();
      expect(screen.getByTestId("reward-tracker-streak")).toBeInTheDocument();
    });
  });
});
