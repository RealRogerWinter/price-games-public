import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import HomePage from "../pages/HomePage";

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
    renderWithProviders(<HomePage {...defaultProps} />);
    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  it("renders all 6 game mode cards", () => {
    renderWithProviders(<HomePage {...defaultProps} />);
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("Higher or Lower")).toBeInTheDocument();
    expect(screen.getByText("Comparison")).toBeInTheDocument();
    expect(screen.getByText("Underbid")).toBeInTheDocument();
    expect(screen.getByText("Price Match")).toBeInTheDocument();
    expect(screen.getByText("Riser")).toBeInTheDocument();
  });

  it("calls onSelectMode when a game mode card is clicked", () => {
    const onSelectMode = vi.fn();
    renderWithProviders(<HomePage {...defaultProps} onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText("Precision"));
    expect(onSelectMode).toHaveBeenCalledWith("classic");
  });

  it("calls onShowLeaderboard when leaderboard button is clicked", () => {
    const onShowLeaderboard = vi.fn();
    renderWithProviders(<HomePage {...defaultProps} onShowLeaderboard={onShowLeaderboard} />);
    fireEvent.click(screen.getByText("Leaderboard"));
    expect(onShowLeaderboard).toHaveBeenCalledOnce();
  });

  it("renders Play with Friends hero when onMultiplayer is provided", () => {
    renderWithProviders(<HomePage {...defaultProps} onMultiplayer={vi.fn()} />);
    expect(screen.getByText(/play with friends/i)).toBeInTheDocument();
  });

  it("does not render the Play with Friends hero when onMultiplayer is not provided", () => {
    renderWithProviders(<HomePage {...defaultProps} />);
    expect(screen.queryByText(/play with friends/i)).not.toBeInTheDocument();
  });

  it("calls onMultiplayer when the Play with Friends hero is clicked", () => {
    const onMultiplayer = vi.fn();
    renderWithProviders(<HomePage {...defaultProps} onMultiplayer={onMultiplayer} />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    expect(onMultiplayer).toHaveBeenCalledOnce();
  });

  it("renders Game Options button with categories inside the dropdown", () => {
    renderWithProviders(
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
    renderWithProviders(
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
    renderWithProviders(
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
    renderWithProviders(<HomePage {...defaultProps} />);
    // Open Game Options dropdown first
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  // --- Confirmation modal tests ---

  it("shows confirmation modal when clicking a mode card with an active game", () => {
    const onSelectMode = vi.fn();
    renderWithProviders(
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
    expect(screen.getByText("Precision", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/lose your current progress/)).toBeInTheDocument();
  });

  it("resumes game when clicking Resume Game in confirmation modal", () => {
    const onResumeGame = vi.fn();
    renderWithProviders(
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
    renderWithProviders(
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
    const onSelectMode = vi.fn();
    renderWithProviders(<HomePage {...defaultProps} onSelectMode={onSelectMode} />);
    fireEvent.click(screen.getByText("Higher or Lower"));
    expect(onSelectMode).toHaveBeenCalledWith("higher-lower");
    expect(screen.queryByText("Game in Progress")).not.toBeInTheDocument();
  });

  // --- Random card tests ---

  it("renders the Random card", () => {
    renderWithProviders(<HomePage {...defaultProps} />);
    expect(screen.getByText("Random")).toBeInTheDocument();
    expect(screen.getByText("Feeling lucky? Play a random game mode!")).toBeInTheDocument();
  });

  it("calls onSelectMode with a valid game mode when Random is clicked", () => {
    const onSelectMode = vi.fn();
    renderWithProviders(<HomePage {...defaultProps} onSelectMode={onSelectMode} />);
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
    renderWithProviders(
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
