import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import PriceMatchPage from "../pages/PriceMatchPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { PriceMatchGuessResponse } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Builds a PriceMatchData payload (the shape returned by getProduct for this mode). */
function makePriceMatchData(
  overrides: Partial<{
    products: { id: number; title: string; imageUrl: string; description: string; category: string; amazonUrl?: string }[];
    prices: number[];
  }> = {}
) {
  return {
    products: [
      { id: 1, title: "Widget A", imageUrl: "https://example.com/a.jpg", description: "Product A", category: "Electronics" },
      { id: 2, title: "Widget B", imageUrl: "https://example.com/b.jpg", description: "Product B", category: "Home" },
      { id: 3, title: "Widget C", imageUrl: "https://example.com/c.jpg", description: "Product C", category: "Books" },
    ],
    prices: [1500, 2500, 3500],
    ...overrides,
  };
}

/** Builds a PriceMatchGuessResponse matching a perfect score. */
function makePriceMatchResponse(
  overrides: Partial<PriceMatchGuessResponse> = {}
): PriceMatchGuessResponse {
  return {
    result: {
      products: [
        makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg" }),
        makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
        makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
      ],
      assignments: { 1: 1500, 2: 2500, 3: 3500 },
      correctCount: 3,
      score: 900,
    },
    session: makeSession({ currentRound: 2, totalScore: 900 }),
    ...overrides,
  };
}

describe("PriceMatchPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makePriceMatchData() as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "price-match" as any }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  /** Helper: assign a price to a product by clicking product then price button. */
  function assignPrice(productTitle: string, priceText: string) {
    fireEvent.click(screen.getByText(productTitle));
    fireEvent.click(screen.getByRole("button", { name: priceText }));
  }

  /** Helper: assign all three default products to their default prices in order. */
  function assignAllDefaults() {
    assignPrice("Widget A", "$15.00");
    assignPrice("Widget B", "$25.00");
    assignPrice("Widget C", "$35.00");
  }

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  describe("loading state", () => {
    it("shows loading text while fetching data", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      expect(screen.getByText("Loading round...")).toBeInTheDocument();
    });

    it("hides loading text after data arrives", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading round...")).not.toBeInTheDocument();
    });

    it("renders nothing when data fails to load", async () => {
      mockedApi.getProduct.mockRejectedValue(new Error("network error"));
      const { container } = renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      // Should not show loading, and no product data → returns null
      expect(screen.queryByText("Loading round...")).not.toBeInTheDocument();
      expect(container.querySelector(".pm-products")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Scoreboard
  // ---------------------------------------------------------------------------
  describe("scoreboard", () => {
    it("shows round and total score", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("1 / 10")).toBeInTheDocument();
      expect(screen.getByText("0")).toBeInTheDocument();
    });

    it("reflects session starting score", async () => {
      const session = makeSession({ currentRound: 3, totalScore: 1200, gameMode: "price-match" as any });
      renderWithProviders(
        <PriceMatchPage session={session} onRoundComplete={vi.fn()} onGameEnd={vi.fn()} />
      );
      await flushMicrotasks();
      expect(screen.getByText("3 / 10")).toBeInTheDocument();
      expect(screen.getByText("1200")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Product and price display
  // ---------------------------------------------------------------------------
  describe("product and price display", () => {
    it("displays all product titles", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Widget A")).toBeInTheDocument();
      expect(screen.getByText("Widget B")).toBeInTheDocument();
      expect(screen.getByText("Widget C")).toBeInTheDocument();
    });

    it("displays product images", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      // Product images carry alt text; the scoreboard's player-chip
      // silhouette uses a role="img" span with no alt, so scoping by
      // alt text excludes the chip without brittle count offsets.
      const images = screen.getAllByAltText(/^Widget/);
      expect(images).toHaveLength(3);
      expect(images[0]).toHaveAttribute("alt", "Widget A");
    });

    it("displays all price buttons", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "$15.00" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "$25.00" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "$35.00" })).toBeInTheDocument();
    });

    it("shows the title 'Match each product to its price'", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Match each product to its price")).toBeInTheDocument();
    });

    it("shows initial instruction to tap a product", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      expect(
        screen.getByText("Tap a product, then tap a price to assign it")
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Matching interactions
  // ---------------------------------------------------------------------------
  describe("matching interactions", () => {
    it("price buttons are disabled when no product is selected", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      const priceBtn = screen.getByRole("button", { name: "$15.00" });
      expect(priceBtn).toBeDisabled();
    });

    it("shows instruction to pick a price after selecting a product", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByText("Widget A"));

      expect(
        screen.getByText("Now pick a price for the highlighted product")
      ).toBeInTheDocument();
    });

    it("price buttons become enabled after selecting a product", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      fireEvent.click(screen.getByText("Widget A"));

      const priceBtn = screen.getByRole("button", { name: "$15.00" });
      expect(priceBtn).not.toBeDisabled();
    });

    it("assigns a price to the selected product and shows it", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignPrice("Widget A", "$25.00");

      // The assigned price should appear as text on the product card
      expect(screen.getByText("$25.00")).toBeInTheDocument();
    });

    it("removes the assigned price from available prices", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignPrice("Widget A", "$25.00");

      // $25.00 should no longer be a button in the price list
      expect(screen.queryByRole("button", { name: "$25.00" })).not.toBeInTheDocument();
      // Other prices remain
      expect(screen.getByRole("button", { name: "$15.00" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "$35.00" })).toBeInTheDocument();
    });

    it("allows unassigning a price by clicking the product again", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignPrice("Widget A", "$25.00");
      // Click Widget A again to unassign
      fireEvent.click(screen.getByText("Widget A"));

      // $25.00 should be back as a price button
      expect(screen.getByRole("button", { name: "$25.00" })).toBeInTheDocument();
    });

    it("allows assigning all products", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignAllDefaults();

      // No price buttons remaining
      expect(screen.queryByRole("button", { name: "$15.00" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "$25.00" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "$35.00" })).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Submit button visibility and behavior
  // ---------------------------------------------------------------------------
  describe("submission", () => {
    it("does not show submit button before all products are assigned", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignPrice("Widget A", "$15.00");

      expect(screen.queryByRole("button", { name: "Lock In Answers" })).not.toBeInTheDocument();
    });

    it("shows submit button once all products are assigned", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignAllDefaults();

      expect(screen.getByRole("button", { name: "Lock In Answers" })).toBeInTheDocument();
    });

    it("calls submitPriceMatchGuess with correct assignments on submit", async () => {
      mockedApi.submitPriceMatchGuess.mockResolvedValue(makePriceMatchResponse());

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      expect(mockedApi.submitPriceMatchGuess).toHaveBeenCalledWith("session-1", {
        1: 1500,
        2: 2500,
        3: 3500,
      });
    });

    it("shows 'Checking...' while submitting", async () => {
      mockedApi.submitPriceMatchGuess.mockReturnValue(new Promise(() => {}));

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });

      expect(screen.getByRole("button", { name: "Checking..." })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    });

    it("calls onRoundComplete after successful submit", async () => {
      const onRoundComplete = vi.fn();
      const response = makePriceMatchResponse();
      mockedApi.submitPriceMatchGuess.mockResolvedValue(response);

      renderWithProviders(
        <PriceMatchPage
          session={defaultProps.session}
          onRoundComplete={onRoundComplete}
          onGameEnd={vi.fn()}
        />
      );
      await flushMicrotasks();

      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Result display
  // ---------------------------------------------------------------------------
  describe("result display", () => {
    async function submitAndGetResult(response?: PriceMatchGuessResponse) {
      const resp = response ?? makePriceMatchResponse();
      mockedApi.submitPriceMatchGuess.mockResolvedValue(resp);

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();
    }

    it("shows 'Perfect Match!' when all correct", async () => {
      await submitAndGetResult();
      expect(screen.getByText("Perfect Match!")).toBeInTheDocument();
    });

    it("shows partial correct message when some correct", async () => {
      const resp = makePriceMatchResponse({
        result: {
          products: [
            makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg" }),
            makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
            makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
          ],
          assignments: { 1: 1500, 2: 3500, 3: 2500 },
          correctCount: 1,
          score: 300,
        },
        session: makeSession({ currentRound: 2, totalScore: 300 }),
      });
      await submitAndGetResult(resp);
      expect(screen.getByText("1 of 3 Correct")).toBeInTheDocument();
    });

    it("shows 'No Matches!' when none correct", async () => {
      const resp = makePriceMatchResponse({
        result: {
          products: [
            makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg" }),
            makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
            makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
          ],
          assignments: { 1: 3500, 2: 1500, 3: 2500 },
          correctCount: 0,
          score: 0,
        },
        session: makeSession({ currentRound: 2, totalScore: 0 }),
      });
      await submitAndGetResult(resp);
      expect(screen.getByText("No Matches!")).toBeInTheDocument();
    });

    it("shows actual prices for each product in results", async () => {
      await submitAndGetResult();
      // "Actual:" labels appear on the product cards in the main area
      const actualLabels = screen.getAllByText(/^Actual:/);
      expect(actualLabels.length).toBeGreaterThanOrEqual(3);
    });

    it("hides price buttons after result", async () => {
      await submitAndGetResult();
      expect(screen.queryByRole("button", { name: "$15.00" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "$25.00" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "$35.00" })).not.toBeInTheDocument();
    });

    it("hides submit button after result", async () => {
      await submitAndGetResult();
      expect(screen.queryByRole("button", { name: "Lock In Answers" })).not.toBeInTheDocument();
    });

    it("shows 'Points Earned' label in result", async () => {
      await submitAndGetResult();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("animates score from 0 to final value", async () => {
      await submitAndGetResult();

      // Initially the animated score starts at 0
      expect(screen.getByText("+0")).toBeInTheDocument();

      // Advance timers to let the score animation complete (800ms total)
      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByText("+900")).toBeInTheDocument();
    });

    it("shows animated score as 0 when score is 0", async () => {
      const resp = makePriceMatchResponse({
        result: {
          products: [
            makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg" }),
            makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
            makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
          ],
          assignments: { 1: 3500, 2: 1500, 3: 2500 },
          correctCount: 0,
          score: 0,
        },
        session: makeSession({ currentRound: 2, totalScore: 0 }),
      });
      await submitAndGetResult(resp);
      expect(screen.getByText("+0")).toBeInTheDocument();
    });

    it("shows result reveal cards with product titles", async () => {
      await submitAndGetResult();
      // The reveal section shows product titles
      const revealTitles = screen.getAllByText("Widget A");
      // Widget A appears in both product card and reveal card
      expect(revealTitles.length).toBeGreaterThanOrEqual(2);
    });

    it("shows Amazon links for products that have them", async () => {
      const resp = makePriceMatchResponse({
        result: {
          products: [
            makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg", amazonUrl: "https://amazon.com/a" }),
            makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
            makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
          ],
          assignments: { 1: 1500, 2: 2500, 3: 3500 },
          correctCount: 3,
          score: 900,
        },
        session: makeSession({ currentRound: 2, totalScore: 900 }),
      });
      await submitAndGetResult(resp);

      const amazonLink = screen.getByRole("link", { name: /see it on amazon/i });
      expect(amazonLink).toBeInTheDocument();
      expect(amazonLink).toHaveAttribute("href", "https://amazon.com/a");
      expect(amazonLink).toHaveAttribute("target", "_blank");
    });

    it("shows wrong guess price in red for incorrect matches", async () => {
      const resp = makePriceMatchResponse({
        result: {
          products: [
            makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 1500, imageUrl: "https://example.com/a.jpg" }),
            makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2500, imageUrl: "https://example.com/b.jpg" }),
            makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 3500, imageUrl: "https://example.com/c.jpg" }),
          ],
          assignments: { 1: 1500, 2: 3500, 3: 2500 },
          correctCount: 1,
          score: 300,
        },
        session: makeSession({ currentRound: 2, totalScore: 300 }),
      });
      await submitAndGetResult(resp);

      // "Your guess:" labels appear for incorrect assignments
      const guessLabels = screen.getAllByText("Your guess:");
      expect(guessLabels.length).toBe(2); // 2 wrong assignments
    });

    it("does not show 'Your guess:' for correct matches", async () => {
      await submitAndGetResult(); // All correct
      expect(screen.queryByText("Your guess:")).not.toBeInTheDocument();
    });

    it("updates total score after result", async () => {
      await submitAndGetResult();
      expect(screen.getByText("900")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Next round / game end
  // ---------------------------------------------------------------------------
  describe("next round and game end", () => {
    it("shows 'Next Round' button after result when game is not over", async () => {
      mockedApi.submitPriceMatchGuess.mockResolvedValue(makePriceMatchResponse());

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("loads new round data when 'Next Round' is clicked", async () => {
      mockedApi.submitPriceMatchGuess.mockResolvedValue(makePriceMatchResponse());

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      // Reset the mock to track the next call
      mockedApi.getProduct.mockClear();
      mockedApi.getProduct.mockResolvedValue(makePriceMatchData() as any);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      await flushMicrotasks();

      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("shows 'See Final Results' button when game is completed", async () => {
      const resp = makePriceMatchResponse({
        session: makeSession({ currentRound: 10, totalScore: 5000, completed: true }),
      });
      mockedApi.submitPriceMatchGuess.mockResolvedValue(resp);

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("calls onGameEnd when 'See Final Results' is clicked", async () => {
      const onGameEnd = vi.fn();
      const resp = makePriceMatchResponse({
        session: makeSession({ currentRound: 10, totalScore: 5000, completed: true }),
      });
      mockedApi.submitPriceMatchGuess.mockResolvedValue(resp);

      renderWithProviders(
        <PriceMatchPage
          session={defaultProps.session}
          onRoundComplete={vi.fn()}
          onGameEnd={onGameEnd}
        />
      );
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
      });

      expect(onGameEnd).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // Interaction guards
  // ---------------------------------------------------------------------------
  describe("interaction guards", () => {
    it("ignores product clicks after result is shown", async () => {
      mockedApi.submitPriceMatchGuess.mockResolvedValue(makePriceMatchResponse());

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      // Click product after result - should not show "pick a price" instruction
      // Use getAllByText since "Widget A" appears in both the product card and the reveal card
      const widgetAs = screen.getAllByText("Widget A");
      fireEvent.click(widgetAs[0]);
      expect(
        screen.queryByText("Now pick a price for the highlighted product")
      ).not.toBeInTheDocument();
    });

    it("does not submit when not all products are assigned", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      const callCountBefore = mockedApi.submitPriceMatchGuess.mock.calls.length;

      // Only assign one product
      assignPrice("Widget A", "$15.00");

      // Submit button should not exist
      expect(screen.queryByRole("button", { name: "Lock In Answers" })).not.toBeInTheDocument();
      // No new calls should have been made
      expect(mockedApi.submitPriceMatchGuess.mock.calls.length).toBe(callCountBefore);
    });

    it("clicking a price with no product selected does nothing", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      // Try clicking a price button without selecting a product first
      // Buttons should be disabled
      const priceBtn = screen.getByRole("button", { name: "$15.00" });
      fireEvent.click(priceBtn);

      // Price should still be available (not assigned)
      expect(screen.getByRole("button", { name: "$15.00" })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Image modal
  // ---------------------------------------------------------------------------
  describe("image modal", () => {
    it("opens image modal when product image is clicked", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      const images = screen.getAllByAltText(/^Widget/);
      fireEvent.click(images[0]);

      // ImageModal opens with dialog role
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("closes image modal when close button is clicked", async () => {
      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      const images = screen.getAllByAltText(/^Widget/);
      fireEvent.click(images[0]);

      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  describe("error handling", () => {
    it("handles submit API error gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedApi.submitPriceMatchGuess.mockRejectedValue(new Error("server error"));

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();
      assignAllDefaults();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });
      await flushMicrotasks();

      // Should not crash; result should not be shown
      expect(screen.queryByText("Perfect Match!")).not.toBeInTheDocument();
      // Submit button should reappear (submitting is reset to false)
      expect(screen.getByRole("button", { name: "Lock In Answers" })).toBeInTheDocument();
      consoleError.mockRestore();
    });

    it("handles loadProduct error gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedApi.getProduct.mockRejectedValue(new Error("fetch failed"));

      renderWithProviders(<PriceMatchPage {...defaultProps} />);
      await flushMicrotasks();

      // Should not crash, should not show loading
      expect(screen.queryByText("Loading round...")).not.toBeInTheDocument();
      consoleError.mockRestore();
    });
  });
});
