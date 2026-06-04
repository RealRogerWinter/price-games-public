import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import MPRoundResultOverlay from "../components/multiplayer/MPRoundResultOverlay";
import { renderWithProviders, makeRoundResultsPayload, makeProductWithPrice } from "./testUtils";
import type { RoundResultsPayload } from "@price-game/shared";

describe("MPRoundResultOverlay", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  function makeClassicResults(overrides: Partial<RoundResultsPayload> = {}): RoundResultsPayload {
    return makeRoundResultsPayload({
      gameMode: "classic",
      revealData: {
        mode: "classic",
        product: makeProductWithPrice({ priceCents: 2000 }),
      },
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
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 500 },
        { playerId: "player-2", displayName: "Bob", avatar: "yeti" as const, totalScore: 300 },
      ],
      ...overrides,
    });
  }

  const defaultProps = {
    results: makeClassicResults(),
    currentPlayerId: "player-1",
    onContinue: vi.fn(),
    isGameOver: false,
  };

  it("shows personal message for current player", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    expect(screen.getByText("Nice guess!")).toBeInTheDocument();
  });

  it("shows all player results in table", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("+500")).toBeInTheDocument();
    expect(screen.getByText("+300")).toBeInTheDocument();
  });

  it("shows actual price in reveal section", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });

  it("shows Continue button when not game over", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    const btn = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(btn);
    expect(defaultProps.onContinue).toHaveBeenCalledOnce();
  });

  it("shows See Final Results button when game is over", () => {
    renderWithProviders(
      <MPRoundResultOverlay {...defaultProps} isGameOver={true} />
    );
    expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
  });

  it("shows waiting message when hasContinued is true", () => {
    renderWithProviders(
      <MPRoundResultOverlay
        {...defaultProps}
        hasContinued={true}
        continuedPlayerIds={new Set(["player-1"])}
        players={[
          { id: "player-1", displayName: "Alice", isConnected: true },
          { id: "player-2", displayName: "Bob", isConnected: true },
        ]}
      />
    );
    expect(screen.getByText(/Waiting for others/)).toBeInTheDocument();
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it("shows guess data in player table", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    // Price appears in both reveal and table, so use getAllByText
    expect(screen.getAllByText("$22.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$26.00").length).toBeGreaterThanOrEqual(1);
  });

  it("shows percentage off in classic mode", () => {
    renderWithProviders(<MPRoundResultOverlay {...defaultProps} />);
    // 10% off for player-1 (appears in header and table)
    expect(screen.getAllByText("10.0%").length).toBeGreaterThanOrEqual(1);
  });

  it("shows higher/lower answers for that mode", () => {
    const hlResults = makeRoundResultsPayload({
      gameMode: "higher-lower",
      revealData: {
        mode: "higher-lower",
        product: makeProductWithPrice({ priceCents: 3000 }),
        referencePrice: 2500,
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 800,
          guessData: { guess: "higher" as const },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 800 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={hlResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Correct!")).toBeInTheDocument();
    // "Higher" appears in both the reveal section and player table
    expect(screen.getAllByText("Higher").length).toBeGreaterThanOrEqual(1);
  });

  it("shows missed message for zero score in classic", () => {
    const results = makeClassicResults({
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 0,
          guessData: { guessedPriceCents: 5000 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 0 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={results}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Missed it!")).toBeInTheDocument();
  });

  it("shows comparison reveal with products and correct badge", () => {
    const compResults = makeRoundResultsPayload({
      gameMode: "comparison",
      revealData: {
        mode: "comparison",
        products: [
          makeProductWithPrice({ id: 1, title: "Expensive Item", priceCents: 5000 }),
          makeProductWithPrice({ id: 2, title: "Cheap Item", priceCents: 1000 }),
        ],
        correctProductId: 1,
        question: "most-expensive" as any,
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 1000,
          guessData: { guessedProductId: 1 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 1000 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={compResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getAllByText("Expensive Item").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Cheap Item").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("More Expensive")).toBeInTheDocument();
    expect(screen.getByText("Correct!")).toBeInTheDocument();
  });

  it("shows comparison with least-expensive question", () => {
    const compResults = makeRoundResultsPayload({
      gameMode: "comparison",
      revealData: {
        mode: "comparison",
        products: [
          makeProductWithPrice({ id: 1, title: "Item A", priceCents: 5000 }),
          makeProductWithPrice({ id: 2, title: "Item B", priceCents: 1000 }),
        ],
        correctProductId: 2,
        question: "least-expensive" as any,
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 0,
          guessData: { guessedProductId: 1 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 0 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={compResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Less Expensive")).toBeInTheDocument();
    expect(screen.getByText("Wrong!")).toBeInTheDocument();
  });

  it("shows price-match reveal with correct and wrong products", () => {
    const pmResults = makeRoundResultsPayload({
      gameMode: "price-match",
      revealData: {
        mode: "price-match",
        products: [
          makeProductWithPrice({ id: 1, title: "PM Item A", priceCents: 1000 }),
          makeProductWithPrice({ id: 2, title: "PM Item B", priceCents: 2000 }),
        ],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 500,
          guessData: { assignments: { "1": 1000, "2": 3000 } },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 500 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={pmResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("PM Item A")).toBeInTheDocument();
    expect(screen.getByText("PM Item B")).toBeInTheDocument();
    // Shows "1/2 correct" in guess column
    expect(screen.getByText("1/2 correct")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 correct")).toBeInTheDocument();
  });

  it("shows closest-without-going-over with went over result", () => {
    const closestResults = makeRoundResultsPayload({
      gameMode: "closest-without-going-over",
      revealData: {
        mode: "closest-without-going-over",
        product: makeProductWithPrice({ priceCents: 2000 }),
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 0,
          guessData: { guessedPriceCents: 2200 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 0 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={closestResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Went over!")).toBeInTheDocument();
    expect(screen.getByText("Your Guess")).toBeInTheDocument();
  });

  it("shows riser mode with stopped price", () => {
    const riserResults = makeRoundResultsPayload({
      gameMode: "riser",
      revealData: {
        mode: "riser",
        product: makeProductWithPrice({ priceCents: 3000 }),
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 800,
          guessData: { stoppedPriceCents: 2800 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 800 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={riserResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("You Stopped At")).toBeInTheDocument();
    expect(screen.getAllByText("$28.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("So close!")).toBeInTheDocument();
  });

  it("shows 'Spot on!' for perfect classic score", () => {
    const results = makeClassicResults({
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 950,
          guessData: { guessedPriceCents: 2000 },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 950 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={results}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getAllByText("Spot on!").length).toBeGreaterThanOrEqual(1);
  });

  it("shows price-match perfect message", () => {
    const pmResults = makeRoundResultsPayload({
      gameMode: "price-match",
      revealData: {
        mode: "price-match",
        products: [
          makeProductWithPrice({ id: 1, title: "A", priceCents: 1000 }),
          makeProductWithPrice({ id: 2, title: "B", priceCents: 2000 }),
        ],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 1000,
          guessData: { assignments: { "1": 1000, "2": 2000 } },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 1000 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={pmResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Perfect match!")).toBeInTheDocument();
  });

  it("shows sort-it-out reveal with per-player position badges", () => {
    const sioResults = makeRoundResultsPayload({
      gameMode: "sort-it-out",
      revealData: {
        mode: "sort-it-out",
        products: [
          makeProductWithPrice({ id: 1, title: "Cheapest Widget", priceCents: 500 }),
          makeProductWithPrice({ id: 2, title: "Mid Widget", priceCents: 1500 }),
          makeProductWithPrice({ id: 3, title: "Pricey Widget", priceCents: 3000 }),
        ],
        correctOrder: [1, 2, 3],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 600,
          guessData: { submittedOrder: [1, 3, 2] },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 600 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={sioResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    // Product #1 was at position 1 in both orders → "Correct"
    expect(screen.getByText("Correct")).toBeInTheDocument();
    // Product #3 was at position 2 in submitted but position 3 in correct → "You put #2"
    expect(screen.getByText("You put #2")).toBeInTheDocument();
    // Product #2 was at position 3 in submitted but position 2 in correct → "You put #3"
    expect(screen.getByText("You put #3")).toBeInTheDocument();
    expect(screen.getByText("Almost right!")).toBeInTheDocument();
  });

  it("shows sort-it-out perfect order message", () => {
    const sioResults = makeRoundResultsPayload({
      gameMode: "sort-it-out",
      revealData: {
        mode: "sort-it-out",
        products: [
          makeProductWithPrice({ id: 1, title: "Item A", priceCents: 100 }),
          makeProductWithPrice({ id: 2, title: "Item B", priceCents: 200 }),
        ],
        correctOrder: [1, 2],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 1000,
          guessData: { submittedOrder: [1, 2] },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 1000 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={sioResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Perfect order!")).toBeInTheDocument();
    expect(screen.getAllByText("Correct").length).toBe(2);
  });

  it("shows reference price for higher-lower mode", () => {
    const hlResults = makeRoundResultsPayload({
      gameMode: "higher-lower",
      revealData: {
        mode: "higher-lower",
        product: makeProductWithPrice({ priceCents: 3000 }),
        referencePrice: 2500,
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 0,
          guessData: { guess: "lower" as const },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 0 },
      ],
    });

    renderWithProviders(
      <MPRoundResultOverlay
        results={hlResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Reference Price")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
    expect(screen.getByText("Your Answer")).toBeInTheDocument();
    // "Lower" appears in both the table and reveal
    expect(screen.getAllByText("Lower").length).toBeGreaterThanOrEqual(1);
  });

  it("price-match: two players see different personalized results", () => {
    const pmResults = makeRoundResultsPayload({
      gameMode: "price-match",
      revealData: {
        mode: "price-match",
        products: [
          makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1000 }),
          makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2000 }),
        ],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 200,
          guessData: { assignments: { "1": 1000, "2": 3000 } },
        },
        {
          playerId: "player-2",
          displayName: "Bob",
          avatar: "sushi" as const,
          score: 0,
          guessData: { assignments: { "1": 2000, "2": 1000 } },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 200 },
        { playerId: "player-2", displayName: "Bob", avatar: "sushi" as const, totalScore: 0 },
      ],
    });

    // Render for Player 1 (Alice) — 1 of 2 correct
    const { unmount: unmount1 } = renderWithProviders(
      <MPRoundResultOverlay
        results={pmResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    // Player 1 got Product A correct, Product B wrong (guessed $30.00)
    expect(screen.getByText("1 of 2 correct")).toBeInTheDocument();
    expect(screen.getByText("$30.00")).toBeInTheDocument(); // Player 1's wrong guess
    unmount1();

    // Render for Player 2 (Bob) — 0 of 2 correct
    renderWithProviders(
      <MPRoundResultOverlay
        results={pmResults}
        currentPlayerId="player-2"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    // Player 2 got both wrong — different personal message from Player 1
    expect(screen.getByText("No matches!")).toBeInTheDocument();
    // Both wrong guesses rendered in red (text-red class)
    const redValues = screen.getAllByText(/\$/, { selector: ".text-red" });
    expect(redValues.length).toBe(2); // Player 2's 2 wrong guesses
    // Verify "is-you" class is on Bob's row, not Alice's
    const youRow = document.querySelector(".mp-result-row.is-you .mp-result-name");
    expect(youRow?.textContent).toBe("Bob");
  });

  it("sort-it-out: two players see different personalized results", () => {
    const sioResults = makeRoundResultsPayload({
      gameMode: "sort-it-out",
      revealData: {
        mode: "sort-it-out",
        products: [
          makeProductWithPrice({ id: 1, title: "Cheap", priceCents: 500 }),
          makeProductWithPrice({ id: 2, title: "Mid", priceCents: 1500 }),
          makeProductWithPrice({ id: 3, title: "Pricey", priceCents: 3000 }),
        ],
        correctOrder: [1, 2, 3],
      },
      playerResults: [
        {
          playerId: "player-1",
          displayName: "Alice",
          avatar: "wizard" as const,
          score: 1000,
          guessData: { submittedOrder: [1, 2, 3] },
        },
        {
          playerId: "player-2",
          displayName: "Bob",
          avatar: "sushi" as const,
          score: 333,
          guessData: { submittedOrder: [3, 2, 1] },
        },
      ],
      standings: [
        { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 1000 },
        { playerId: "player-2", displayName: "Bob", avatar: "sushi" as const, totalScore: 333 },
      ],
    });

    // Render for Player 1 — perfect order
    const { unmount: unmount1 } = renderWithProviders(
      <MPRoundResultOverlay
        results={sioResults}
        currentPlayerId="player-1"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Perfect order!")).toBeInTheDocument();
    unmount1();

    // Render for Player 2 — partially right
    renderWithProviders(
      <MPRoundResultOverlay
        results={sioResults}
        currentPlayerId="player-2"
        onContinue={vi.fn()}
        isGameOver={false}
      />
    );
    expect(screen.getByText("Partially right")).toBeInTheDocument();
    // Player 2 put Pricey at #1 instead of #3
    expect(screen.getByText("You put #1")).toBeInTheDocument();
  });

  describe("budget-builder mode reveal", () => {
    function makeBBResults(selectedIds: number[], score = 600): RoundResultsPayload {
      return makeRoundResultsPayload({
        gameMode: "budget-builder",
        revealData: {
          mode: "budget-builder",
          products: [
            makeProductWithPrice({ id: 1, title: "Laptop", priceCents: 5000 }),
            makeProductWithPrice({ id: 2, title: "Mouse", priceCents: 1500 }),
            makeProductWithPrice({ id: 3, title: "Keyboard", priceCents: 2500 }),
            makeProductWithPrice({ id: 4, title: "Monitor", priceCents: 8000 }),
            makeProductWithPrice({ id: 5, title: "USB Hub", priceCents: 1000 }),
            makeProductWithPrice({ id: 6, title: "Webcam", priceCents: 4500 }),
          ],
          budgetCents: 10000,
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score,
            guessData: { selectedProductIds: selectedIds },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: score },
        ],
      });
    }

    it("renders 'Your cart' section listing only selected items, not all six products", () => {
      // Player picked Mouse (1500) + Keyboard (2500) = 4000 of 10000 budget
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBBResults([2, 3], 700)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("Your cart")).toBeInTheDocument();
      // Subtotal renders the cart total
      expect(screen.getByText("Subtotal")).toBeInTheDocument();
      expect(screen.getAllByText("$40.00").length).toBeGreaterThanOrEqual(1);
      // Budget renders next to it
      expect(screen.getAllByText("Budget").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("$100.00").length).toBeGreaterThanOrEqual(1);
      // Full product set still listed below
      expect(screen.getByText("All products this round")).toBeInTheDocument();
      // All 6 products surface in the "all products" section (Mouse + Keyboard
      // appear twice because they're also in the cart).
      expect(screen.getAllByText("Mouse").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Keyboard").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Laptop")).toBeInTheDocument();
      expect(screen.getByText("Monitor")).toBeInTheDocument();
      expect(screen.getByText("Webcam")).toBeInTheDocument();
      expect(screen.getByText("USB Hub")).toBeInTheDocument();
    });

    it("flags 'Over budget' when subtotal exceeds budget", () => {
      // Picked Laptop (5000) + Monitor (8000) = 13000 > 10000 budget
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBBResults([1, 4], 0)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      // "Over budget by $30.00" appears in the reveal status
      expect(screen.getByText(/Over budget by/)).toBeInTheDocument();
    });

    it("renders empty-cart copy when player picked nothing", () => {
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBBResults([], 0)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("You didn't pick any items.")).toBeInTheDocument();
    });
  });

  describe("chain-reaction mode reveal", () => {
    function makeCRResults(chainGuesses: ("more" | "less")[], score = 813): RoundResultsPayload {
      return makeRoundResultsPayload({
        gameMode: "chain-reaction",
        revealData: {
          mode: "chain-reaction",
          products: [
            // Actual relationships: 100->200 (more), 200->150 (less), 150->300 (more), 300->400 (more)
            makeProductWithPrice({ id: 1, title: "Item A", priceCents: 100 }),
            makeProductWithPrice({ id: 2, title: "Item B", priceCents: 200 }),
            makeProductWithPrice({ id: 3, title: "Item C", priceCents: 150 }),
            makeProductWithPrice({ id: 4, title: "Item D", priceCents: 300 }),
            makeProductWithPrice({ id: 5, title: "Item E", priceCents: 400 }),
          ],
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score,
            guessData: { chainGuesses },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: score },
        ],
      });
    }

    it("renders ✓ for each correct link and ✗ for each wrong one", () => {
      // Guess: more, less, more, more — all 4 correct.
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeCRResults(["more", "less", "more", "more"], 1313)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      // 4 ✓ marks, 0 ✗
      const checks = document.querySelectorAll(".cr-link-badge-correct");
      expect(checks.length).toBe(4);
      const xes = document.querySelectorAll(".cr-link-badge-wrong");
      expect(xes.length).toBe(0);
      // No "Chain broke" message when nothing broke.
      expect(screen.queryByText(/Chain broke/)).not.toBeInTheDocument();
    });

    it("marks the first wrong link with a 'Chain broke at link N' label", () => {
      // Guess: more, MORE (wrong, actual is less), more, more
      // First wrong link = link #2.
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeCRResults(["more", "more", "more", "more"], 250)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("Chain broke at link 2")).toBeInTheDocument();
      // Only L2 is wrong: L1 (100→200 more, guess more ✓), L2 (200→150 less,
      // guess more ✗), L3 (150→300 more, guess more ✓), L4 (300→400 more,
      // guess more ✓) → 3 correct + 1 wrong.
      expect(document.querySelectorAll(".cr-link-badge-correct").length).toBe(3);
      expect(document.querySelectorAll(".cr-link-badge-wrong").length).toBe(1);
    });

    it("renders no badges when player has no chain guesses (e.g. timed out)", () => {
      // Guess: empty array via timed-out path.
      const cr = makeRoundResultsPayload({
        gameMode: "chain-reaction",
        revealData: {
          mode: "chain-reaction",
          products: [
            makeProductWithPrice({ id: 1, title: "Item A", priceCents: 100 }),
            makeProductWithPrice({ id: 2, title: "Item B", priceCents: 200 }),
          ],
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score: 0,
            guessData: { timedOut: true },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 0 },
        ],
      });
      renderWithProviders(
        <MPRoundResultOverlay
          results={cr}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(document.querySelectorAll(".cr-link-badge-correct").length).toBe(0);
      expect(document.querySelectorAll(".cr-link-badge-wrong").length).toBe(0);
      expect(screen.queryByText(/Chain broke/)).not.toBeInTheDocument();
    });
  });

  describe("bidding mode labels", () => {
    function makeBiddingResults(bidCents: number, priceCents: number, score: number): RoundResultsPayload {
      return makeRoundResultsPayload({
        gameMode: "bidding",
        revealData: {
          mode: "bidding",
          product: makeProductWithPrice({ priceCents }),
          bids: [{ playerId: "player-1", displayName: "Alice", bidCents }],
        },
        playerResults: [
          {
            playerId: "player-1",
            displayName: "Alice",
            avatar: "wizard" as const,
            score,
            guessData: { bidCents },
          },
        ],
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: score },
        ],
      });
    }

    it("labels a $0.01 lowball bid with deep snark, not 'Decent bid!'", () => {
      // Bid $0.01 on a $30 item. Under the fix, score is ~0, and label
      // should reflect how far off the bid was — NOT "Decent bid!".
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBiddingResults(1, 3000, 0)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.queryByText("Decent bid!")).not.toBeInTheDocument();
      expect(screen.queryByText("Won the bid!")).not.toBeInTheDocument();
      // pctOff ~= 0.9997 → "Things Cost Money, Friend" tier.
      expect(screen.getByText("Things Cost Money, Friend")).toBeInTheDocument();
    });

    it("labels a close valid bid with 'Sharpshooter'", () => {
      // $29.20 bid on $30 → pctOff ~0.0267 → Sharpshooter tier.
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBiddingResults(2920, 3000, 951)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("Sharpshooter")).toBeInTheDocument();
    });

    it("labels an overbid as 'Overbid!'", () => {
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBiddingResults(3500, 3000, 0)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("Overbid!")).toBeInTheDocument();
    });

    it("labels an exact bid as PIXEL PERFECT", () => {
      renderWithProviders(
        <MPRoundResultOverlay
          results={makeBiddingResults(3000, 3000, 1500)}
          currentPlayerId="player-1"
          onContinue={vi.fn()}
          isGameOver={false}
        />
      );
      expect(screen.getByText("PIXEL PERFECT!")).toBeInTheDocument();
    });
  });
});
