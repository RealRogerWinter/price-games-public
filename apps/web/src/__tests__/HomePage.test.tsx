import type React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { renderWithProviders } from "./testUtils";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import HomePage from "../pages/HomePage";

/**
 * The mode cards are `<Link>`s to `/play/<mode>`, so HomePage needs a router
 * in context. Wraps every render in this file rather than adding a router to
 * the shared `renderWithProviders` — App.test.tsx renders the real `<App>`,
 * which brings its own `BrowserRouter`, and nesting the two would break it.
 */
function renderHome(ui: React.ReactElement) {
  return renderWithProviders(
    <MemoryRouter>
      {ui}
      <LocationProbe />
    </MemoryRouter>
  );
}

/** Renders the router's current path so a test can assert that a click did
 *  (or did not) navigate. Without this, a test that only checks "the modal
 *  opened" passes even if `preventDefault()` is deleted — under MemoryRouter
 *  the link navigates silently and nothing observable changes. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe("HomePage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    onSelectMode: vi.fn(),
    onShowLeaderboard: vi.fn(),
  };

  it("renders the app title", () => {
    renderHome(<HomePage {...defaultProps} />);
    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  it("renders all 6 game mode cards", () => {
    renderHome(<HomePage {...defaultProps} />);
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("Higher or Lower")).toBeInTheDocument();
    expect(screen.getByText("Comparison")).toBeInTheDocument();
    expect(screen.getByText("Underbid")).toBeInTheDocument();
    expect(screen.getByText("Price Match")).toBeInTheDocument();
    expect(screen.getByText("Riser")).toBeInTheDocument();
  });

  it("links each game mode card to that mode's canonical URL", () => {
    // The cards are real anchors, not buttons: the home page is the main
    // internal link source for the eleven /play/<mode> pages, and a
    // button+onClick gives a crawler nothing to follow.
    renderHome(<HomePage {...defaultProps} />);
    expect(screen.getByText("Precision").closest("a")).toHaveAttribute(
      "href",
      "/play/classic"
    );
    expect(screen.getByText("Higher or Lower").closest("a")).toHaveAttribute(
      "href",
      "/play/higher-lower"
    );
  });

  it("navigates on a mode card click rather than starting in place", () => {
    // With no game in progress the browser just follows the link — the
    // canonical URL is what starts the game.
    const onSelectMode = vi.fn();
    renderHome(<HomePage {...defaultProps} onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText("Precision"));
    expect(screen.getByTestId("location")).toHaveTextContent("/play/classic");
    expect(onSelectMode).not.toHaveBeenCalled();
  });

  it("calls onShowLeaderboard when leaderboard button is clicked", () => {
    const onShowLeaderboard = vi.fn();
    renderHome(<HomePage {...defaultProps} onShowLeaderboard={onShowLeaderboard} />);
    fireEvent.click(screen.getByText("Leaderboard"));
    expect(onShowLeaderboard).toHaveBeenCalledOnce();
  });

  it("renders Play with Friends hero when onMultiplayer is provided", () => {
    renderHome(<HomePage {...defaultProps} onMultiplayer={vi.fn()} />);
    expect(screen.getByText(/play with friends/i)).toBeInTheDocument();
  });

  it("does not render the Play with Friends hero when onMultiplayer is not provided", () => {
    renderHome(<HomePage {...defaultProps} />);
    expect(screen.queryByText(/play with friends/i)).not.toBeInTheDocument();
  });

  it("calls onMultiplayer when the Play with Friends hero is clicked", () => {
    const onMultiplayer = vi.fn();
    renderHome(<HomePage {...defaultProps} onMultiplayer={onMultiplayer} />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    expect(onMultiplayer).toHaveBeenCalledOnce();
  });

  it("renders Game Options button with categories inside the dropdown", () => {
    renderHome(
      <HomePage
        {...defaultProps}
        onApplyCategories={vi.fn()}
        currentCategories={["Electronics", "Toys & Games", "Home & Kitchen", "Sports & Outdoors", "Clothing & Fashion"]}
      />
    );
    // Game Options button is always rendered
    const optionsBtn = screen.getByText("Game Options");
    expect(optionsBtn).toBeInTheDocument();
    // Open the dropdown
    fireEvent.click(optionsBtn);
    // Categories row with count shown in the sub-label
    expect(screen.getByText("Categories")).toBeInTheDocument();
    expect(screen.getByText("5 selected")).toBeInTheDocument();
  });

  it("shows resume game button when activeGameMode is set", () => {
    const onResumeGame = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        activeGameMode="classic"
        activeGameRound={3}
        onResumeGame={onResumeGame}
      />
    );
    const resumeBtn = screen.getByText(/Resume Game/);
    expect(resumeBtn).toBeInTheDocument();
    expect(resumeBtn.textContent).toContain("Precision");
    expect(resumeBtn.textContent).toContain("Round 3");
  });

  it("calls onResumeGame when resume button is clicked", () => {
    const onResumeGame = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        activeGameMode="classic"
        activeGameRound={3}
        onResumeGame={onResumeGame}
      />
    );
    fireEvent.click(screen.getByText(/Resume Game/));
    expect(onResumeGame).toHaveBeenCalledOnce();
  });

  it("renders the currency selector inside the Game Options dropdown", () => {
    renderHome(<HomePage {...defaultProps} />);
    // Open Game Options dropdown first
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  // --- Confirmation modal tests ---

  it("shows confirmation modal when clicking a mode card with an active game", () => {
    const onSelectMode = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        onSelectMode={onSelectMode}
        activeGameMode="classic"
        activeGameRound={2}
        activeGameScore={450}
        onResumeGame={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Higher or Lower"));
    // Should NOT directly start the game
    expect(onSelectMode).not.toHaveBeenCalled();
    // Should show the confirmation modal
    expect(screen.getByText("Game in Progress")).toBeInTheDocument();
    // ...and the card's navigation must have been cancelled, or the prompt
    // would be moot: the mode URL starts a game on arrival. This assertion
    // is what actually pins `preventDefault()`.
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(screen.getByTestId("location")).not.toHaveTextContent("/play/higher-lower");
    expect(screen.getByText("Precision", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/lose your current progress/)).toBeInTheDocument();
  });

  it("resumes game when clicking Resume Game in confirmation modal", () => {
    const onResumeGame = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        activeGameMode="classic"
        activeGameRound={2}
        onResumeGame={onResumeGame}
      />
    );
    fireEvent.click(screen.getByText("Higher or Lower"));
    fireEvent.click(screen.getByText("Resume Game"));
    expect(onResumeGame).toHaveBeenCalledOnce();
  });

  it("starts new game when clicking Start New Game in confirmation modal", () => {
    const onSelectMode = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        onSelectMode={onSelectMode}
        activeGameMode="classic"
        activeGameRound={2}
        onResumeGame={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Higher or Lower"));
    fireEvent.click(screen.getByText("Start New Game"));
    expect(onSelectMode).toHaveBeenCalledWith("higher-lower");
  });

  it("does not show confirmation modal when no active game", () => {
    renderHome(<HomePage {...defaultProps} />);
    fireEvent.click(screen.getByText("Higher or Lower"));
    expect(screen.queryByText("Game in Progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/play/higher-lower");
  });

  // --- Random card tests ---

  it("renders the Random card", () => {
    renderHome(<HomePage {...defaultProps} />);
    expect(screen.getByText("Random")).toBeInTheDocument();
    expect(screen.getByText("Feeling lucky? Play a random game mode!")).toBeInTheDocument();
  });

  it("calls onSelectMode with a valid game mode when Random is clicked", () => {
    const onSelectMode = vi.fn();
    renderHome(<HomePage {...defaultProps} onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText("Random"));
    expect(onSelectMode).toHaveBeenCalledOnce();
    // The selected mode should be one of the valid game modes
    const validModes = [
      "classic", "higher-lower", "comparison", "closest-without-going-over",
      "price-match", "riser", "odd-one-out", "market-basket", "sort-it-out",
      "budget-builder", "chain-reaction",
    ];
    expect(validModes).toContain(onSelectMode.mock.calls[0][0]);
  });

  it("shows confirmation modal when Random is clicked with an active game", () => {
    const onSelectMode = vi.fn();
    renderHome(
      <HomePage
        {...defaultProps}
        onSelectMode={onSelectMode}
        activeGameMode="classic"
        activeGameRound={2}
        onResumeGame={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Random"));
    expect(onSelectMode).not.toHaveBeenCalled();
    expect(screen.getByText("Game in Progress")).toBeInTheDocument();
  });
});
