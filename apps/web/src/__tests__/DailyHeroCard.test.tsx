import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DailyHeroCard from "../components/home/DailyHeroCard";
import type { DailyTodayResponse, DailyStreak } from "@price-game/shared";

vi.mock("../../assets/daily-challenge.webp", () => ({ default: "daily-challenge.webp" }));

function makeToday(overrides: Partial<DailyTodayResponse> = {}): DailyTodayResponse {
  return {
    date: "2026-04-15",
    gameMode: "comparison",
    modeName: "Comparison",
    totalRounds: 5,
    ...overrides,
  };
}

const defaultStreak: DailyStreak = { current: 0, best: 0, lastDate: null };

describe("DailyHeroCard", () => {
  it("renders the mode name and 'Play' when state is available", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="available"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/Comparison/)).toBeInTheDocument();
    expect(screen.getByText(/Play/i)).toBeInTheDocument();
  });

  it("does not render when state is unavailable", () => {
    const { container } = render(
      <DailyHeroCard
        today={null}
        streak={null}
        state="unavailable"
        onClick={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders 'Completed' text when state is completed", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={{ current: 5, best: 10, lastDate: "2026-04-15" }}
        state="completed"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
    expect(screen.getByText("5", { selector: ".daily-hero-streak" })).toBeInTheDocument();
  });

  it("shows a NEW badge when state is first-ever", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="first-ever"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/NEW/)).toBeInTheDocument();
  });

  it("fires onClick when clicked in any interactive state", () => {
    const onClick = vi.fn();
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="available"
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fires onClick when completed (tap-to-recap)", () => {
    const onClick = vi.fn();
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={{ current: 3, best: 3, lastDate: "2026-04-15" }}
        state="completed"
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a loading placeholder when state is loading", () => {
    render(
      <DailyHeroCard
        today={null}
        streak={null}
        state="loading"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/Daily Challenge/i)).toBeInTheDocument();
  });

  it("renders the iridescent sheen overlay", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="available"
        onClick={vi.fn()}
      />,
    );
    expect(document.querySelector(".daily-hero-sheen")).toBeInTheDocument();
  });

  it("renders the bag image graphic", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="available"
        onClick={vi.fn()}
      />,
    );
    const img = document.querySelector(".daily-hero-bag-img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain("daily-challenge.webp");
  });

  it("does not show streak badge when streak is 0", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={defaultStreak}
        state="available"
        onClick={vi.fn()}
      />,
    );
    expect(document.querySelector(".daily-hero-streak")).not.toBeInTheDocument();
  });

  it("shows streak badge with count when streak > 0", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={{ current: 12, best: 12, lastDate: "2026-04-15" }}
        state="available"
        onClick={vi.fn()}
      />,
    );
    const badge = document.querySelector(".daily-hero-streak");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("12");
  });

  // Regression guard for the anon-streak fix: an unlogged session has a
  // `null` streak (the hook no longer falls back to localStorage). The
  // card must render the "Start a streak!" prompt and must not display
  // any streak count or "N-day streak" text.
  it("renders the 'Start a streak' prompt and no count for an anonymous (null) streak", () => {
    render(
      <DailyHeroCard
        today={makeToday()}
        streak={null}
        state="available"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/start a streak/i)).toBeInTheDocument();
    expect(document.querySelector(".daily-hero-streak")).not.toBeInTheDocument();
    // No "N-day streak" text either.
    expect(screen.queryByText(/-day streak/i)).not.toBeInTheDocument();
  });
});
