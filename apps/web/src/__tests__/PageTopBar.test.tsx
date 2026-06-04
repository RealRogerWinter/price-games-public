import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import PageTopBar from "../components/PageTopBar";

function renderTopBar() {
  return render(
    <MemoryRouter>
      <PageTopBar />
    </MemoryRouter>
  );
}

describe("PageTopBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("renders the logo as a link home", () => {
    renderTopBar();
    const logo = screen.getByAltText("price.games");
    expect(logo).toBeInTheDocument();
    expect(logo.closest("a")).toHaveAttribute("href", "/");
  });

  it("renders a New Game link to home", () => {
    renderTopBar();
    const btn = screen.getByText("New Game");
    expect(btn).toBeInTheDocument();
    expect(btn.closest("a")).toHaveAttribute("href", "/");
  });

  it("renders UserDropdown", () => {
    renderTopBar();
    expect(screen.getByTestId("user-dropdown")).toBeInTheDocument();
  });

  it("does not show resume button when no active game", () => {
    renderTopBar();
    expect(screen.queryByText(/Resume Game/)).not.toBeInTheDocument();
  });

  it("shows resume button when active game in sessionStorage", () => {
    sessionStorage.setItem(
      "active_game",
      JSON.stringify({
        session: { currentRound: 3, completed: false },
        gameMode: "classic",
        roundResults: [],
        isPlayingDaily: false,
      })
    );
    renderTopBar();
    const btn = screen.getByText(/Resume Game/);
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain("Round 3");
    // "classic" mode displays as "Precision" via getGameModeName
    expect(btn.textContent).toContain("Precision");
  });

  it("does not show resume button when session is completed", () => {
    sessionStorage.setItem(
      "active_game",
      JSON.stringify({
        session: { currentRound: 10, completed: true },
        gameMode: "classic",
        roundResults: [],
        isPlayingDaily: false,
      })
    );
    renderTopBar();
    expect(screen.queryByText(/Resume Game/)).not.toBeInTheDocument();
  });

  it("resume button links to home", () => {
    sessionStorage.setItem(
      "active_game",
      JSON.stringify({
        session: { currentRound: 5, completed: false },
        gameMode: "higher-lower",
        roundResults: [],
        isPlayingDaily: false,
      })
    );
    renderTopBar();
    const btn = screen.getByText(/Resume Game/);
    expect(btn.closest("a")).toHaveAttribute("href", "/");
  });

  it("uses top-bar class for layout", () => {
    const { container } = renderTopBar();
    expect(container.querySelector(".top-bar")).toBeInTheDocument();
  });
});
