import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Scoreboard, { formatStreak, tierIcon } from "./Scoreboard";

vi.mock("../api/userClient", () => ({
  userGetWinRecord: vi.fn(),
}));

import { userGetWinRecord } from "../api/userClient";

beforeEach(() => {
  sessionStorage.clear();
  (userGetWinRecord as unknown as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatStreak", () => {
  it("returns 0 for a neutral streak (no sign prefix)", () => {
    expect(formatStreak(0)).toBe("0");
  });

  it("prefixes positive values with +", () => {
    expect(formatStreak(5)).toBe("+5");
    expect(formatStreak(999)).toBe("+999");
  });

  it("preserves the minus sign on negative streaks", () => {
    expect(formatStreak(-3)).toBe("-3");
    expect(formatStreak(-1)).toBe("-1");
  });

  it("clamps absurdly large absolute values to ±999", () => {
    expect(formatStreak(9999)).toBe("+999");
    expect(formatStreak(-9999)).toBe("-999");
  });
});

describe("tierIcon", () => {
  it("shows no icon below +3", () => {
    expect(tierIcon(0)).toBe("");
    expect(tierIcon(2)).toBe("");
  });

  it("shows fire 🔥 between +3 and +6", () => {
    expect(tierIcon(3)).toContain("🔥");
    expect(tierIcon(6)).toContain("🔥");
  });

  it("shows lightning ⚡ between +7 and +14", () => {
    expect(tierIcon(7)).toContain("⚡");
    expect(tierIcon(14)).toContain("⚡");
  });

  it("shows diamond 💎 at +15 and above", () => {
    expect(tierIcon(15)).toContain("💎");
    expect(tierIcon(99)).toContain("💎");
  });

  it("shows no icon for negative streaks (deliberate UX choice)", () => {
    expect(tierIcon(-3)).toBe("");
    expect(tierIcon(-15)).toBe("");
  });
});

describe("Scoreboard component", () => {
  it("renders Round and Score even when the win record hasn't loaded yet", () => {
    (userGetWinRecord as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    render(<Scoreboard currentRound={3} totalRounds={10} score={4200} />);

    expect(screen.getByText("Round")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("4200")).toBeInTheDocument();
  });

  it("renders the three pills from a sessionStorage cache without waiting on fetch", () => {
    sessionStorage.setItem(
      "win_record_cache_v1",
      JSON.stringify({
        wins: 12,
        losses: 4,
        currentStreak: 3,
        bestStreak: 8,
        totalGames: 16,
      }),
    );
    (userGetWinRecord as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    render(<Scoreboard currentRound={1} totalRounds={5} score={0} />);

    expect(screen.getByText("Wins")).toBeInTheDocument();
    expect(screen.getByText("Losses")).toBeInTheDocument();
    expect(screen.getByText("Streak")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    // +3 with the fire icon adjacent (single tier 3+ value).
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
  });

  it("tints the streak pill red when the current streak is negative", () => {
    sessionStorage.setItem(
      "win_record_cache_v1",
      JSON.stringify({
        wins: 2,
        losses: 5,
        currentStreak: -3,
        bestStreak: 4,
        totalGames: 7,
      }),
    );
    (userGetWinRecord as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );

    const { container } = render(
      <Scoreboard currentRound={1} totalRounds={5} score={0} />,
    );

    const streakPill = container.querySelector(".win-pill--streak");
    expect(streakPill).not.toBeNull();
    expect(streakPill!.className).toContain("streak-negative");
    expect(screen.getByText("-3")).toBeInTheDocument();
  });
});
