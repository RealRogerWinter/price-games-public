import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LeaderboardLink from "../components/results/LeaderboardLink";

function getLink(): HTMLAnchorElement {
  return screen.getByRole("link", { name: /view leaderboard/i }) as HTMLAnchorElement;
}

describe("LeaderboardLink", () => {
  it("renders a 'View Leaderboard' anchor", () => {
    render(<LeaderboardLink />);
    expect(getLink()).toBeInTheDocument();
  });

  it("falls back to a plain href so it works without a router context", () => {
    render(<LeaderboardLink />);
    expect(getLink().getAttribute("href")).toBe("/leaderboard");
  });

  it("calls onShowLeaderboard and prevents default navigation when provided", () => {
    const cb = vi.fn();
    render(<LeaderboardLink onShowLeaderboard={cb} />);
    const link = getLink();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does NOT prevent default when no callback is provided (browser follows href)", () => {
    render(<LeaderboardLink />);
    const link = getLink();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(false);
  });
});
