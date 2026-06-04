import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DailyIntroPage from "../pages/DailyIntroPage";
import type { DailyTodayResponse } from "@price-game/shared";

function makeToday(overrides: Partial<DailyTodayResponse> = {}): DailyTodayResponse {
  return {
    date: "2026-04-15",
    gameMode: "comparison",
    modeName: "Comparison",
    totalRounds: 5,
    ...overrides,
  };
}

describe("DailyIntroPage", () => {
  it("renders the date and mode name", () => {
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={null}
        onStart={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Comparison/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders the streak when current > 0", () => {
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={{ current: 7, best: 10, lastDate: "2026-04-14" }}
        onStart={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/7/)).toBeInTheDocument();
  });

  it("renders 'Start your streak' for new players", () => {
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={{ current: 0, best: 0, lastDate: null }}
        onStart={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Start your streak/i)).toBeInTheDocument();
  });

  it("includes the explicit microcopy about first guess", () => {
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={null}
        onStart={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/first guess/i)).toBeInTheDocument();
  });

  it("calls onStart when the Start button is clicked", () => {
    const onStart = vi.fn();
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={null}
        onStart={onStart}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("calls onBack when the Back button is clicked", () => {
    const onBack = vi.fn();
    render(
      <DailyIntroPage
        today={makeToday()}
        streak={null}
        onStart={vi.fn()}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
