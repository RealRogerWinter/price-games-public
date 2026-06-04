import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Scoreboard from "../components/Scoreboard";

describe("Scoreboard", () => {
  it("renders the current round and total rounds", () => {
    render(<Scoreboard currentRound={3} totalRounds={10} score={1500} />);
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
  });

  it("renders the score", () => {
    render(<Scoreboard currentRound={1} totalRounds={10} score={2500} />);
    expect(screen.getByText("2500")).toBeInTheDocument();
  });

  it("has correct aria-label", () => {
    const { container } = render(<Scoreboard currentRound={5} totalRounds={10} score={3000} />);
    const scoreboard = container.querySelector(".scoreboard");
    expect(scoreboard).toHaveAttribute("aria-label", "Round 5 of 10, Score: 3000");
  });

  it("uses aria-live polite for screen reader updates", () => {
    const { container } = render(<Scoreboard currentRound={1} totalRounds={10} score={0} />);
    const scoreboard = container.querySelector(".scoreboard");
    expect(scoreboard).toHaveAttribute("aria-live", "polite");
  });

  it("renders labels", () => {
    render(<Scoreboard currentRound={1} totalRounds={10} score={0} />);
    expect(screen.getByText("Round")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
  });

  it("does not render the legacy PlayerChip — identity now lives in IdentityCard", () => {
    const { container } = render(<Scoreboard currentRound={1} totalRounds={10} score={0} />);
    expect(container.querySelector(".player-chip")).toBeNull();
  });
});
