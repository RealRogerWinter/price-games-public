import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import MPResultsScreen from "../components/multiplayer/MPResultsScreen";
import { renderWithAllProviders, makeRoundResultsPayload, makeProductWithPrice } from "./testUtils";

describe("MPResultsScreen", () => {
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

  const results = makeRoundResultsPayload({
    standings: [
      { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 5000 },
      { playerId: "player-2", displayName: "Bob", avatar: "yeti" as const, totalScore: 3000 },
    ],
    playerResults: [
      {
        playerId: "player-1",
        displayName: "Alice",
        avatar: "wizard" as const,
        score: 500,
        guessData: { guessedPriceCents: 2200 },
      },
      {
        playerId: "player-2",
        displayName: "Bob",
        avatar: "yeti" as const,
        score: 300,
        guessData: { guessedPriceCents: 2600 },
      },
    ],
  });

  const defaultProps = {
    finalResults: results,
    allRoundResults: [results],
    currentPlayerId: "player-1",
    onPlayAgain: vi.fn(),
    onLeave: vi.fn(),
  };

  it("displays Final Results title", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    expect(screen.getByText("Final Results")).toBeInTheDocument();
  });

  it("shows standings with player names and scores", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    // Names appear in podium, breakdown header, and product section
    expect(screen.getAllByText("Alice").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Bob").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("5,000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("3,000").length).toBeGreaterThanOrEqual(1);
  });

  it("shows rank numbers", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("shows round-by-round breakdown", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    expect(screen.getByText("Round-by-Round")).toBeInTheDocument();
  });

  it("shows product section", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
  });

  it("calls onPlayAgain when Play Again is clicked", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Play Again" }));
    expect(defaultProps.onPlayAgain).toHaveBeenCalledOnce();
  });

  it("calls onLeave when Leave Room is clicked", () => {
    renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave Room" }));
    expect(defaultProps.onLeave).toHaveBeenCalledOnce();
  });

  it("highlights current player entry", () => {
    const { container } = renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
    const youEntries = container.querySelectorAll(".is-you");
    expect(youEntries.length).toBeGreaterThan(0);
  });

  describe("signup CTA", () => {
    it("renders the SignupCtaCard when the user is logged out and onOpenAuth is provided", () => {
      const onOpen = vi.fn();
      renderWithAllProviders(<MPResultsScreen {...defaultProps} onOpenAuth={onOpen} />);
      expect(screen.getByText(/Claim your/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Create free account/i }));
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it("does not render the SignupCtaCard when onOpenAuth is omitted", () => {
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      expect(screen.queryByRole("button", { name: /Create free account/i })).not.toBeInTheDocument();
    });
  });

  describe("Share Results button", () => {
    it("renders a Share Results button", () => {
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      expect(screen.getByText("Share Results")).toBeInTheDocument();
    });

    it("opens the ShareModal when clicked", () => {
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      fireEvent.click(screen.getByText("Share Results"));
      expect(screen.getByRole("dialog", { name: "Share your results" })).toBeInTheDocument();
    });

    it("uses the current player's total and per-round scores (not an opponent's)", () => {
      // Alice (player-1, current) scored 500, Bob scored 300. Only Alice's
      // total (5000) and her round score should feed the grid.
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      fireEvent.click(screen.getByText("Share Results"));
      // Header includes 5000 total (Alice's), not 3000 (Bob's).
      // totalMax = perRoundMax(1000) * roundScores.length(1) = 1,000
      expect(screen.getByText(/5,000\/1,000/)).toBeInTheDocument();
    });

    it("includes finishing position '#N of M' in the share header", () => {
      // Alice is rank #1, Bob is rank #2 → Alice's share should say "#1 of 2".
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      fireEvent.click(screen.getByText("Share Results"));
      expect(screen.getByText(/· #1 of 2/)).toBeInTheDocument();
    });

    it("renders '#2 of 2' for the runner-up", () => {
      renderWithAllProviders(
        <MPResultsScreen {...defaultProps} currentPlayerId="player-2" />
      );
      fireEvent.click(screen.getByText("Share Results"));
      expect(screen.getByText(/· #2 of 2/)).toBeInTheDocument();
    });
  });

  describe("BB / Chain Reaction local-player recap", () => {
    it("renders 'Your Rounds' BB recap with the player's selected items only", () => {
      const bbRound = makeRoundResultsPayload({
        roundNumber: 1,
        gameMode: "budget-builder",
        revealData: {
          mode: "budget-builder",
          products: [
            makeProductWithPrice({ id: 1, title: "Laptop", priceCents: 5000 }),
            makeProductWithPrice({ id: 2, title: "Mouse", priceCents: 1500 }),
            makeProductWithPrice({ id: 3, title: "Keyboard", priceCents: 2500 }),
            makeProductWithPrice({ id: 4, title: "Monitor", priceCents: 8000 }),
          ],
          budgetCents: 5000,
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score: 800,
            // Picked Mouse + Keyboard = 4000 (under 5000 budget)
            guessData: { selectedProductIds: [2, 3] },
          },
          {
            playerId: "player-2",
            displayName: "Bob",
            avatar: "yeti" as const,
            score: 0,
            // Bob picked Laptop + Monitor = 13000 (way over)
            guessData: { selectedProductIds: [1, 4] },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 800 },
          { playerId: "player-2", displayName: "Bob", avatar: "yeti" as const, totalScore: 0 },
        ],
      });
      renderWithAllProviders(
        <MPResultsScreen
          finalResults={bbRound}
          allRoundResults={[bbRound]}
          currentPlayerId="player-1"
          onPlayAgain={vi.fn()}
          onLeave={vi.fn()}
        />
      );
      // 'Your Rounds' header rendered for BB mode
      expect(screen.getByText("Your Rounds")).toBeInTheDocument();
      // The local player's recap exposes their picks (Mouse + Keyboard) and
      // their stats (Cart 4000, Status Under). These appear in the per-round
      // recap; we don't check Bob's because we deliberately don't surface
      // opponents' carts on the final screen.
      const myBreakdown = document.querySelector(".mp-my-breakdown");
      expect(myBreakdown).not.toBeNull();
      expect(myBreakdown!.textContent).toContain("Mouse");
      expect(myBreakdown!.textContent).toContain("Keyboard");
      // Bob's items should NOT appear in the local-player breakdown
      expect(myBreakdown!.textContent).not.toContain("Laptop");
      expect(myBreakdown!.textContent).not.toContain("Monitor");
      // Cart subtotal + status visible
      expect(myBreakdown!.textContent).toMatch(/Cart/);
      expect(myBreakdown!.textContent).toMatch(/Under/);
    });

    it("renders 'Your Rounds' Chain Reaction recap with correct/total link count", () => {
      const crRound = makeRoundResultsPayload({
        roundNumber: 1,
        gameMode: "chain-reaction",
        revealData: {
          mode: "chain-reaction",
          // Actual: more, less, more (chainLength = 3)
          products: [
            makeProductWithPrice({ id: 1, title: "Item A", priceCents: 100 }),
            makeProductWithPrice({ id: 2, title: "Item B", priceCents: 200 }),
            makeProductWithPrice({ id: 3, title: "Item C", priceCents: 150 }),
            makeProductWithPrice({ id: 4, title: "Item D", priceCents: 300 }),
          ],
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score: 250,
            // 2 of 3 correct: more (✓), more (✗), more (✓)
            guessData: { chainGuesses: ["more", "more", "more"] },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 250 },
        ],
      });
      renderWithAllProviders(
        <MPResultsScreen
          finalResults={crRound}
          allRoundResults={[crRound]}
          currentPlayerId="player-1"
          onPlayAgain={vi.fn()}
          onLeave={vi.fn()}
        />
      );
      expect(screen.getByText("Your Rounds")).toBeInTheDocument();
      const myBreakdown = document.querySelector(".mp-my-breakdown");
      expect(myBreakdown).not.toBeNull();
      // Correct count is rendered as "2 / 3"
      expect(myBreakdown!.textContent).toMatch(/2\s*\/\s*3/);
    });

    it("does NOT render 'Your Rounds' for non-BB / non-CR modes (classic)", () => {
      renderWithAllProviders(<MPResultsScreen {...defaultProps} />);
      expect(screen.queryByText("Your Rounds")).not.toBeInTheDocument();
    });
  });
});
