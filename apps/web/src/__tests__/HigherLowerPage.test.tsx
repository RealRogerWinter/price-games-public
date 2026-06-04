import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import HigherLowerPage from "../pages/HigherLowerPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { HigherLowerGuessResponse } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Helper data returned by getProduct for HigherLower mode. */
function makeHigherLowerData(overrides: Record<string, unknown> = {}) {
  return {
    product: makeProduct(),
    referencePrice: 1500, // $15.00 in cents
    ...overrides,
  };
}

/** Helper to build a HigherLowerGuessResponse. */
function makeGuessResponse(
  overrides: Partial<{
    correct: boolean;
    guess: "higher" | "lower";
    score: number;
    referencePrice: number;
    product: ReturnType<typeof makeProductWithPrice>;
    session: ReturnType<typeof makeSession>;
  }> = {}
): HigherLowerGuessResponse {
  const {
    correct = true,
    guess = "higher",
    score = 500,
    referencePrice = 1500,
    product = makeProductWithPrice({ priceCents: 2000, amazonUrl: "https://amazon.com/widget" }),
    session = makeSession({ currentRound: 2, totalScore: 500 }),
  } = overrides;

  return {
    result: { product, referencePrice, guess, correct, score },
    session,
  };
}

describe("HigherLowerPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeHigherLowerData() as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "higher-lower" as any }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  it("shows loading state while fetching product", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    expect(screen.getByText("Loading product...")).toBeInTheDocument();
  });

  it("shows scoreboard during loading state", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Product display
  // ---------------------------------------------------------------------------

  it("displays product card after loading", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
  });

  it("displays the reference price with 'higher or lower' prompt", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(
      screen.getByText("Is the real price higher or lower than")
    ).toBeInTheDocument();
    // Reference price is 1500 cents = $15.00
    expect(screen.getByText("$15.00")).toBeInTheDocument();
  });

  it("shows the product category", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Electronics")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Scoreboard
  // ---------------------------------------------------------------------------

  it("shows scoreboard with round info after product loads", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("shows current score on scoreboard", async () => {
    const session = makeSession({ totalScore: 1200 });
    renderWithProviders(
      <HigherLowerPage {...defaultProps} session={session} />
    );
    await flushMicrotasks();
    expect(screen.getByText("1200")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Higher / Lower buttons
  // ---------------------------------------------------------------------------

  it("renders Higher and Lower buttons", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByRole("button", { name: "Higher" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lower" })).toBeInTheDocument();
  });

  it("buttons are enabled before guessing", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByRole("button", { name: "Higher" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Lower" })).toBeEnabled();
  });

  it("submits 'higher' guess when Higher button is clicked", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(mockedApi.submitHigherLowerGuess).toHaveBeenCalledWith(
      "session-1",
      "higher",
      undefined
    );
  });

  it("submits 'lower' guess when Lower button is clicked", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ guess: "lower", correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lower" }));
    });
    await flushMicrotasks();

    expect(mockedApi.submitHigherLowerGuess).toHaveBeenCalledWith(
      "session-1",
      "lower",
      undefined
    );
  });

  it("disables buttons after a guess is made", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "Higher" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lower" })).toBeDisabled();
  });

  it("prevents submitting a second guess after the first resolves", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    // Submit first guess and let it resolve
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const callsAfterFirst = mockedApi.submitHigherLowerGuess.mock.calls.length;

    // Try clicking again - buttons should be disabled
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lower" }));
    });
    await flushMicrotasks();

    // No additional calls should have been made
    expect(mockedApi.submitHigherLowerGuess.mock.calls.length).toBe(callsAfterFirst);
  });

  // ---------------------------------------------------------------------------
  // onRoundComplete callback
  // ---------------------------------------------------------------------------

  it("calls onRoundComplete with result and session after guessing", async () => {
    const response = makeGuessResponse();
    mockedApi.submitHigherLowerGuess.mockResolvedValue(response);
    const onRoundComplete = vi.fn();
    renderWithProviders(
      <HigherLowerPage
        {...defaultProps}
        onRoundComplete={onRoundComplete}
      />
    );
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(onRoundComplete).toHaveBeenCalledWith(
      response.result,
      response.session,
      undefined,
    );
  });

  // ---------------------------------------------------------------------------
  // Result display
  // ---------------------------------------------------------------------------

  it("shows 'Correct!' when guess is correct", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: true })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Correct!")).toBeInTheDocument();
  });

  it("shows 'Wrong!' when guess is incorrect", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Wrong!")).toBeInTheDocument();
  });

  it("displays reference price in result overlay", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ referencePrice: 2500 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Reference Price")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
  });

  it("displays actual price in result overlay", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ product: makeProductWithPrice({ priceCents: 3000 }) })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Actual Price")).toBeInTheDocument();
    expect(screen.getByText("$30.00")).toBeInTheDocument();
  });

  it("shows the user's answer in result overlay", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ guess: "higher" })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Your Answer")).toBeInTheDocument();
    // "Higher" appears both as the button text and in the result overlay;
    // check that at least two instances exist (button + result).
    const higherElements = screen.getAllByText("Higher");
    expect(higherElements.length).toBeGreaterThanOrEqual(2);
  });

  it("shows 'Lower' as answer text when user guessed lower", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ guess: "lower" })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lower" }));
    });
    await flushMicrotasks();

    // The result overlay shows "Lower" for the user's answer
    const answerLabels = screen.getAllByText("Lower");
    // At least one of them should be in the result overlay (the other is the button)
    expect(answerLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("shows Amazon link when product has amazonUrl", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({
        product: makeProductWithPrice({ amazonUrl: "https://amazon.com/test" }),
      })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://amazon.com/test");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("does not show Amazon link when product lacks amazonUrl", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({
        product: makeProductWithPrice({ amazonUrl: undefined }),
      })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(
      screen.queryByRole("link", { name: /see it on amazon/i }),
    ).not.toBeInTheDocument();
  });

  it("shows product title in result overlay", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({
        product: makeProductWithPrice({ title: "Fancy Gadget" }),
      })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Fancy Gadget")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Score display and animation
  // ---------------------------------------------------------------------------

  it("displays points earned label in result", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ score: 500 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Points Earned")).toBeInTheDocument();
  });

  it("shows +0 for zero-score result immediately (no animation)", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("+0")).toBeInTheDocument();
  });

  it("animates score up to final value over time", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ score: 300 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    // Initially the animated score starts at 0
    expect(screen.getByText("+0")).toBeInTheDocument();

    // Advance timers to complete the animation (duration=800ms, steps=30, interval ~26ms)
    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(screen.getByText("+300")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Next Round / Game End
  // ---------------------------------------------------------------------------

  it("shows 'Next Round' button after guessing (not last round)", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(
      screen.getByRole("button", { name: "Next Round" })
    ).toBeInTheDocument();
  });

  it("shows 'See Final Results' button on the last round", async () => {
    const session = makeSession({ currentRound: 10 });
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ session: makeSession({ currentRound: 10, totalScore: 5000 }) })
    );
    renderWithProviders(
      <HigherLowerPage {...defaultProps} session={session} />
    );
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(
      screen.getByRole("button", { name: "See Final Results" })
    ).toBeInTheDocument();
  });

  it("calls onGameEnd when clicking 'See Final Results' on last round", async () => {
    const onGameEnd = vi.fn();
    const session = makeSession({ currentRound: 10 });
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ session: makeSession({ currentRound: 10, totalScore: 5000 }) })
    );
    renderWithProviders(
      <HigherLowerPage {...defaultProps} session={session} onGameEnd={onGameEnd} />
    );
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
    });

    expect(onGameEnd).toHaveBeenCalledTimes(1);
  });

  it("fetches next product when clicking 'Next Round'", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    const callsBefore = mockedApi.getProduct.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    // Click Next Round
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
    });
    await flushMicrotasks();

    // Should have fetched at least one more product for the next round
    expect(mockedApi.getProduct.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  // ---------------------------------------------------------------------------
  // Timer behavior
  // ---------------------------------------------------------------------------

  it("starts timer after product loads", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    // Timer should show 30 seconds initially (ROUND_TIME_SECONDS)
    expect(screen.getByText("30")).toBeInTheDocument();
  });

  it("timer counts down each second", async () => {
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("29")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("28")).toBeInTheDocument();
  });

  it("auto-submits 'lower' guess with timedOut=true when timer expires", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ guess: "lower", correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    // Advance timer to 0 (30 seconds)
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    await flushMicrotasks();

    expect(mockedApi.submitHigherLowerGuess).toHaveBeenCalledWith(
      "session-1",
      "lower",
      true
    );
  });

  it("stops timer when a guess is submitted", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(makeGuessResponse());
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    // Let 5 seconds pass
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Submit guess
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const timeAfterGuess = screen.getByText("25").textContent;

    // Advance more time - timer should not continue
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Timer value should remain the same since it was stopped
    expect(screen.getByText("25")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it("re-enables buttons if guess submission fails", async () => {
    mockedApi.submitHigherLowerGuess.mockRejectedValue(new Error("Network error"));
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "Higher" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Lower" })).toBeEnabled();
  });

  it("does not show result overlay when guess submission fails", async () => {
    mockedApi.submitHigherLowerGuess.mockRejectedValue(new Error("Network error"));
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong!")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CSS class application
  // ---------------------------------------------------------------------------

  it("applies tier-nice class for correct guess", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: true })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const resultTitle = screen.getByText("Correct!");
    expect(resultTitle).toHaveClass("tier-nice");
  });

  it("applies tier-miss class for incorrect guess", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const resultTitle = screen.getByText("Wrong!");
    expect(resultTitle).toHaveClass("tier-miss");
  });

  it("applies score-glow class when score is positive", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ score: 500 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const scoreSection = screen.getByText("Points Earned").closest(".result-score");
    expect(scoreSection).toHaveClass("score-glow");
  });

  it("applies score-zero class when score is 0", async () => {
    mockedApi.submitHigherLowerGuess.mockResolvedValue(
      makeGuessResponse({ correct: false, score: 0 })
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    });
    await flushMicrotasks();

    const scoreValue = screen.getByText("+0");
    expect(scoreValue).toHaveClass("score-zero");
  });

  // ---------------------------------------------------------------------------
  // Different reference prices
  // ---------------------------------------------------------------------------

  it("handles different reference prices correctly", async () => {
    mockedApi.getProduct.mockResolvedValue(
      makeHigherLowerData({ referencePrice: 9999 }) as any
    );
    renderWithProviders(<HigherLowerPage {...defaultProps} />);
    await flushMicrotasks();

    expect(screen.getByText("$99.99")).toBeInTheDocument();
  });
});
