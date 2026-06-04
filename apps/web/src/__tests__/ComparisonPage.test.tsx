import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import ComparisonPage from "../pages/ComparisonPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import { TOTAL_ROUNDS, ROUND_TIME_SECONDS } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Two products returned by the comparison endpoint. */
function makeComparisonData(questionType: "most-expensive" | "least-expensive" = "most-expensive") {
  return {
    products: [
      makeProduct({ id: 10, title: "Cheap Widget", category: "Electronics" }),
      makeProduct({ id: 20, title: "Fancy Gadget", category: "Home" }),
    ],
    question: questionType,
  };
}

/** Builds a ComparisonGuessResponse for a correct guess. */
function makeCorrectGuessResponse(score = 500) {
  return {
    result: {
      products: [
        makeProductWithPrice({ id: 10, title: "Cheap Widget", priceCents: 1000 }),
        makeProductWithPrice({ id: 20, title: "Fancy Gadget", priceCents: 5000, amazonUrl: "https://amazon.com/fancy" }),
      ],
      question: "most-expensive" as const,
      correctProductId: 20,
      guessedProductId: 20,
      correct: true,
      score,
    },
    session: makeSession({ currentRound: 2, totalScore: score }),
  };
}

/** Builds a ComparisonGuessResponse for an incorrect guess. */
function makeWrongGuessResponse() {
  return {
    result: {
      products: [
        makeProductWithPrice({ id: 10, title: "Cheap Widget", priceCents: 1000 }),
        makeProductWithPrice({ id: 20, title: "Fancy Gadget", priceCents: 5000 }),
      ],
      question: "most-expensive" as const,
      correctProductId: 20,
      guessedProductId: 10,
      correct: false,
      score: 0,
    },
    session: makeSession({ currentRound: 2, totalScore: 0 }),
  };
}

describe("ComparisonPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeComparisonData() as unknown as ReturnType<typeof makeProduct>);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "comparison" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  it("shows loading state while fetching products", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    expect(screen.getByText("Loading products...")).toBeInTheDocument();
  });

  it("shows scoreboard during loading", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Displaying products
  // ---------------------------------------------------------------------------

  it("displays two product cards after loading", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Cheap Widget")).toBeInTheDocument();
    expect(screen.getByText("Fancy Gadget")).toBeInTheDocument();
  });

  it("displays product categories", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Electronics")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("displays product images with correct alt text", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    // Scope by alt text to exclude the player-chip silhouette in the
    // scoreboard, which uses role="img" on a span with no alt attribute.
    const images = screen.getAllByAltText(/^(Cheap Widget|Fancy Gadget)$/);
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("alt", "Cheap Widget");
    expect(images[1]).toHaveAttribute("alt", "Fancy Gadget");
  });

  it("shows 'MORE' question for most-expensive mode", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("MORE")).toBeInTheDocument();
    expect(screen.getByText(/Which product is/)).toBeInTheDocument();
  });

  it("shows 'LESS' question for least-expensive mode", async () => {
    mockedApi.getProduct.mockResolvedValue(
      makeComparisonData("least-expensive") as unknown as ReturnType<typeof makeProduct>
    );
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("LESS")).toBeInTheDocument();
  });

  it("renders ComparisonPrompt with data-question matching the server payload", async () => {
    const { container } = renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(
      container.querySelector('.comparison-prompt[data-question="most-expensive"]')
    ).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scoreboard
  // ---------------------------------------------------------------------------

  it("shows scoreboard with current round and total rounds", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("shows updated round info when session round changes", async () => {
    const session = makeSession({ currentRound: 5, totalScore: 2000, gameMode: "comparison" as const });
    renderWithProviders(
      <ComparisonPage {...defaultProps} session={session} />
    );
    await flushMicrotasks();
    expect(screen.getByText("5 / 10")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Selection buttons (clicking products)
  // ---------------------------------------------------------------------------

  it("renders product cards as clickable buttons", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();
    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    expect(buttons).toHaveLength(2);
  });

  it("disables product buttons after making a choice", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]); // click Fancy Gadget
    });
    await flushMicrotasks();

    // After guessing, buttons should be disabled
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });

  it("calls submitComparisonGuess with correct arguments when product is clicked", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]); // click Fancy Gadget (id=20)
    });
    await flushMicrotasks();

    expect(mockedApi.submitComparisonGuess).toHaveBeenCalledWith("session-1", 20, undefined);
  });

  it("prevents double submissions", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const callsBefore = mockedApi.submitComparisonGuess.mock.calls.length;

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    // Only one additional call should have been made despite two clicks
    expect(mockedApi.submitComparisonGuess.mock.calls.length - callsBefore).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Correct result display
  // ---------------------------------------------------------------------------

  it("shows 'Correct!' when the right product is chosen", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(screen.getByText("Correct!")).toBeInTheDocument();
  });

  it("shows product prices in the result overlay", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    // formatPrice from CurrencyContext with default USD should show dollar amounts
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument();
  });

  it("shows correct-product badge with 'More Expensive' for most-expensive question", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(screen.getByText("More Expensive")).toBeInTheDocument();
  });

  it("shows 'Less Expensive' badge for least-expensive question", async () => {
    const leastExpensiveResponse = {
      result: {
        products: [
          makeProductWithPrice({ id: 10, title: "Cheap Widget", priceCents: 1000 }),
          makeProductWithPrice({ id: 20, title: "Fancy Gadget", priceCents: 5000 }),
        ],
        question: "least-expensive" as const,
        correctProductId: 10,
        guessedProductId: 10,
        correct: true,
        score: 500,
      },
      session: makeSession({ currentRound: 2, totalScore: 500 }),
    };
    mockedApi.submitComparisonGuess.mockResolvedValue(leastExpensiveResponse);
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await flushMicrotasks();

    expect(screen.getByText("Less Expensive")).toBeInTheDocument();
  });

  it("shows Amazon link for product that has one", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    const amazonLink = screen.getByRole("link", { name: /see it on amazon/i });
    expect(amazonLink).toBeInTheDocument();
    expect(amazonLink).toHaveAttribute("href", "https://amazon.com/fancy");
    expect(amazonLink).toHaveAttribute("target", "_blank");
  });

  it("calls onRoundComplete with result and session", async () => {
    const response = makeCorrectGuessResponse();
    mockedApi.submitComparisonGuess.mockResolvedValue(response);
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(defaultProps.onRoundComplete).toHaveBeenCalledWith(
      response.result,
      response.session,
      undefined,
    );
  });

  // ---------------------------------------------------------------------------
  // Wrong result display
  // ---------------------------------------------------------------------------

  it("shows 'Wrong!' when incorrect product is chosen", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeWrongGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[0]); // click Cheap Widget (wrong)
    });
    await flushMicrotasks();

    expect(screen.getByText("Wrong!")).toBeInTheDocument();
  });

  it("shows +0 score for a wrong answer", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeWrongGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await flushMicrotasks();

    expect(screen.getByText("+0")).toBeInTheDocument();
  });

  it("shows Points Earned label in result overlay", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(screen.getByText("Points Earned")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Score animation
  // ---------------------------------------------------------------------------

  it("animates score from 0 to final value", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse(600));
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    // Initially the animated score starts at 0
    expect(screen.getByText("+0")).toBeInTheDocument();

    // Advance timers to complete the animation (800ms total, 30 steps)
    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(screen.getByText("+600")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Next Round / Game End
  // ---------------------------------------------------------------------------

  it("shows 'Next Round' button after guessing when not on last round", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
  });

  it("shows 'See Final Results' on last round", async () => {
    const lastRoundSession = makeSession({
      currentRound: TOTAL_ROUNDS,
      gameMode: "comparison" as const,
    });
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(
      <ComparisonPage
        {...defaultProps}
        session={lastRoundSession}
      />
    );
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
  });

  it("calls onGameEnd when 'See Final Results' is clicked on last round", async () => {
    const lastRoundSession = makeSession({
      currentRound: TOTAL_ROUNDS,
      gameMode: "comparison" as const,
    });
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(
      <ComparisonPage
        {...defaultProps}
        session={lastRoundSession}
      />
    );
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
    });

    expect(defaultProps.onGameEnd).toHaveBeenCalledTimes(1);
  });

  it("fetches new products when 'Next Round' is clicked", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const callsBefore = mockedApi.getProduct.mock.calls.length;

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
    });
    await flushMicrotasks();

    // At least one additional fetch should have been triggered for the new round
    expect(mockedApi.getProduct.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  // ---------------------------------------------------------------------------
  // Timer expiration
  // ---------------------------------------------------------------------------

  it("auto-submits guess when timer expires", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeWrongGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    // Advance timer to expiration (ROUND_TIME_SECONDS)
    await act(async () => {
      vi.advanceTimersByTime(ROUND_TIME_SECONDS * 1000);
    });
    await flushMicrotasks();

    // Should auto-submit with the first product's id and timedOut=true
    expect(mockedApi.submitComparisonGuess).toHaveBeenCalledWith(
      "session-1",
      10,
      true
    );
  });

  it("does not auto-submit if player already guessed before timer expires", async () => {
    mockedApi.submitComparisonGuess.mockResolvedValue(makeCorrectGuessResponse());
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    // Player guesses before timer
    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[1]);
    });
    await flushMicrotasks();

    const callsAfterGuess = mockedApi.submitComparisonGuess.mock.calls.length;

    // Advance past the timer
    await act(async () => {
      vi.advanceTimersByTime(ROUND_TIME_SECONDS * 1000);
    });
    await flushMicrotasks();

    // No additional calls should have been made after the manual guess
    expect(mockedApi.submitComparisonGuess.mock.calls.length).toBe(callsAfterGuess);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it("re-enables buttons if guess submission fails", async () => {
    mockedApi.submitComparisonGuess.mockRejectedValue(new Error("Network error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const buttons = screen.getAllByRole("button", { name: /Cheap Widget|Fancy Gadget/i });
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await flushMicrotasks();

    // hasGuessed should be reset to false, so buttons should be enabled
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();

    consoleSpy.mockRestore();
  });

  it("logs error when fetch products fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedApi.getProduct.mockRejectedValue(new Error("Server down"));

    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalledWith("Failed to fetch products:", expect.any(Error));
    consoleSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Image fallback
  // ---------------------------------------------------------------------------

  it("sets fallback SVG when image fails to load", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    const images = screen.getAllByAltText(/^(Cheap Widget|Fancy Gadget)$/);
    fireEvent.error(images[0]);

    expect(images[0].getAttribute("src")).toContain("data:image/svg+xml,");
  });

  // ---------------------------------------------------------------------------
  // Image zoom modal
  // ---------------------------------------------------------------------------

  it("opens image modal when image wrapper is clicked", async () => {
    renderWithProviders(<ComparisonPage {...defaultProps} />);
    await flushMicrotasks();

    // Click the image wrapper (div containing the image)
    const images = screen.getAllByRole("img");
    await act(async () => {
      fireEvent.click(images[0].parentElement!);
    });

    // ImageModal should render with the image
    // The modal renders a larger version of the image
    const allImages = screen.getAllByRole("img");
    expect(allImages.length).toBeGreaterThan(2); // original 2 + modal image
  });
});
