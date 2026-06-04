import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import ClosestPage from "../pages/ClosestPage";
import * as api from "../api/client";
import { renderWithProviders, makeSession, makeProduct, makeProductWithPrice, flushMicrotasks } from "./testUtils";
import type { ClosestRoundResult, ClosestGuessResponse, GameSession } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Creates a minimal ClosestRoundResult for tests. */
function makeClosestResult(overrides: Partial<ClosestRoundResult> = {}): ClosestRoundResult {
  return {
    product: makeProductWithPrice(),
    guessedPriceCents: 1800,
    score: 700,
    pctOff: 0.1,
    wentOver: false,
    ...overrides,
  };
}

/** Creates a ClosestGuessResponse wrapping a result and session. */
function makeClosestResponse(
  resultOverrides: Partial<ClosestRoundResult> = {},
  sessionOverrides: Partial<GameSession> = {}
): ClosestGuessResponse {
  return {
    result: makeClosestResult(resultOverrides),
    session: makeSession(sessionOverrides),
  };
}

describe("ClosestPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeProduct());
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "closest" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  /** Submit the price input form. Uses fireEvent.submit on the form element. */
  async function submitPriceForm() {
    const form = document.querySelector(".price-input") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
    });
    await flushMicrotasks();
  }

  // ── Loading state ──────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading text while fetching product", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<ClosestPage {...defaultProps} />);
      expect(screen.getByText("Loading product...")).toBeInTheDocument();
    });

    it("shows scoreboard during loading", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<ClosestPage {...defaultProps} />);
      expect(screen.getByText("1 / 10")).toBeInTheDocument();
    });

    it("removes loading text after product is fetched", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading product...")).not.toBeInTheDocument();
    });
  });

  // ── Product display ────────────────────────────────────────────────

  describe("product display", () => {
    it("displays product card after loading", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Test Widget")).toBeInTheDocument();
    });

    it("fetches product with session id", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });
  });

  // ── "Underbid" label ──────────────────────────────────────────

  describe("closest warning label", () => {
    it("displays the underbid warning", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/stay under the real price/i)).toBeInTheDocument();
    });

    it("shows the full warning text", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(
        screen.getByText("Guess close — but stay under the real price!")
      ).toBeInTheDocument();
    });
  });

  // ── Scoreboard ─────────────────────────────────────────────────────

  describe("scoreboard", () => {
    it("shows round info", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("1 / 10")).toBeInTheDocument();
    });

    it("shows score from session", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 1500, gameMode: "closest" as const }),
      };
      renderWithProviders(<ClosestPage {...props} />);
      await flushMicrotasks();
      expect(screen.getByText("1500")).toBeInTheDocument();
    });
  });

  // ── Timer hint ─────────────────────────────────────────────────────

  describe("timer hint", () => {
    it("shows timer hint on round 1", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Timer starts when you interact")).toBeInTheDocument();
    });

    it("does not show timer hint on subsequent rounds", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: 2, gameMode: "closest" as const }),
      };
      renderWithProviders(<ClosestPage {...props} />);
      await flushMicrotasks();
      expect(screen.queryByText("Timer starts when you interact")).not.toBeInTheDocument();
    });
  });

  // ── Price input ────────────────────────────────────────────────────

  describe("price input", () => {
    it("shows Lock In Price button", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Lock In Price" })).toBeInTheDocument();
    });

    it("shows Your Guess label", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Your Guess")).toBeInTheDocument();
    });
  });

  // ── Hint functionality ─────────────────────────────────────────────

  describe("hints", () => {
    it("shows Use Hint button before guessing", async () => {
      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Use Hint" })).toBeInTheDocument();
    });

    it("shows hint badge after using hint", async () => {
      mockedApi.getHint.mockResolvedValue({
        hintRange: { min: 1000, max: 3000 },
      });

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
      });
      await flushMicrotasks();

      expect(screen.getByText(/Hint active/)).toBeInTheDocument();
    });

    it("hides Use Hint button after hint is used", async () => {
      mockedApi.getHint.mockResolvedValue({
        hintRange: { min: 1000, max: 3000 },
      });

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
      });
      await flushMicrotasks();

      expect(screen.queryByRole("button", { name: "Use Hint" })).not.toBeInTheDocument();
    });

    it("shows 'Getting hint...' while loading hint", async () => {
      mockedApi.getHint.mockReturnValue(new Promise(() => {}));

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
      });

      expect(screen.getByRole("button", { name: "Getting hint..." })).toBeInTheDocument();
    });
  });

  // ── Guess submission ───────────────────────────────────────────────

  describe("guess submission", () => {
    it("calls submitClosestGuess on form submit", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(mockedApi.submitClosestGuess).toHaveBeenCalledWith(
        "session-1",
        expect.any(Number),
        undefined
      );
    });

    it("calls onRoundComplete with result and session", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <ClosestPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await submitPriceForm();

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });

    it("forwards daily payload as the 3rd arg on final-round daily completion", async () => {
      // Regression guard for the bidding-war daily challenge bug: the payload
      // must propagate to App.tsx so DailyResultPage can render the streak
      // flame instead of the anonymous fallback.
      const dailyPayload = {
        streak: { current: 4, best: 6, lastDate: "2026-04-15" },
        isNewBest: false,
        isNewStreak: true,
      };
      const response: ClosestGuessResponse = {
        result: makeClosestResult(),
        session: makeSession({ gameMode: "bidding" as const, completed: true }),
        daily: dailyPayload,
      };
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <ClosestPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await submitPriceForm();

      expect(onRoundComplete).toHaveBeenCalledWith(
        response.result,
        response.session,
        dailyPayload,
      );
    });

    it("submits guess with timedOut=true when timer expires", async () => {
      const response = makeClosestResponse({ score: 0 });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      // Start on round 2 so timer auto-starts
      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: 2, gameMode: "closest" as const }),
      };
      renderWithProviders(<ClosestPage {...props} />);
      await flushMicrotasks();

      // Advance timer past the round time
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      await flushMicrotasks();

      expect(mockedApi.submitClosestGuess).toHaveBeenCalledWith(
        "session-1",
        0,
        true
      );
    });

    it("does not allow double submission", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      // Result overlay replaces the price input form
      expect(screen.queryByRole("button", { name: "Lock In Price" })).not.toBeInTheDocument();
    });
  });

  // ── Result display ─────────────────────────────────────────────────

  describe("result display", () => {
    /** Render the page, submit a guess, and return the response used. */
    async function renderAndGuess(
      resultOverrides: Partial<ClosestRoundResult> = {},
      sessionOverrides: Partial<GameSession> = {}
    ) {
      const response = makeClosestResponse(resultOverrides, sessionOverrides);
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      return response;
    }

    it("shows 'YOU WENT OVER!' when guess exceeds actual price", async () => {
      await renderAndGuess({ wentOver: true, score: 0, pctOff: 0.15 });
      expect(screen.getByText("YOU WENT OVER!")).toBeInTheDocument();
    });

    it("shows over percentage when went over", async () => {
      await renderAndGuess({ wentOver: true, score: 0, pctOff: 0.15 });
      expect(screen.getByText("Over by 15.0%")).toBeInTheDocument();
    });

    it("shows 'Incredible!' for score >= 900", async () => {
      await renderAndGuess({ score: 950, pctOff: 0.02, wentOver: false });
      expect(screen.getByText("Incredible!")).toBeInTheDocument();
    });

    it("shows 'So Close!' for score >= 750", async () => {
      await renderAndGuess({ score: 800, pctOff: 0.08, wentOver: false });
      expect(screen.getByText("So Close!")).toBeInTheDocument();
    });

    it("shows 'Nice!' for score >= 500", async () => {
      await renderAndGuess({ score: 600, pctOff: 0.15, wentOver: false });
      expect(screen.getByText("Nice!")).toBeInTheDocument();
    });

    it("shows 'Not Bad' for score >= 250", async () => {
      await renderAndGuess({ score: 300, pctOff: 0.3, wentOver: false });
      expect(screen.getByText("Not Bad")).toBeInTheDocument();
    });

    it("shows 'Way Under' for score < 250", async () => {
      await renderAndGuess({ score: 100, pctOff: 0.5, wentOver: false });
      expect(screen.getByText("Way Under")).toBeInTheDocument();
    });

    it("shows 'Spot on!' when pctOff is 0", async () => {
      await renderAndGuess({ score: 1000, pctOff: 0, wentOver: false });
      expect(screen.getByText("Spot on!")).toBeInTheDocument();
    });

    it("shows under percentage for non-zero pctOff", async () => {
      await renderAndGuess({ score: 700, pctOff: 0.1, wentOver: false });
      expect(screen.getByText("10.0% under")).toBeInTheDocument();
    });

    it("displays Actual Price label and value", async () => {
      await renderAndGuess({
        product: makeProductWithPrice({ priceCents: 5000 }),
      });
      expect(screen.getByText("Actual Price")).toBeInTheDocument();
    });

    it("displays Your Guess label in result", async () => {
      await renderAndGuess();
      expect(screen.getByText("Your Guess")).toBeInTheDocument();
    });

    it("shows product title in result card", async () => {
      await renderAndGuess({
        product: makeProductWithPrice({ title: "Fancy Gadget" }),
      });
      expect(screen.getByText("Fancy Gadget")).toBeInTheDocument();
    });

    it("shows Amazon link when product has amazonUrl", async () => {
      await renderAndGuess({
        product: makeProductWithPrice({ amazonUrl: "https://amazon.com/test" }),
      });
      const link = screen.getByRole("link", { name: /see it on amazon/i });
      expect(link).toHaveAttribute("href", "https://amazon.com/test");
      expect(link).toHaveAttribute("target", "_blank");
    });

    it("does not show Amazon link when product lacks amazonUrl", async () => {
      await renderAndGuess({
        product: makeProductWithPrice({ amazonUrl: undefined }),
      });
      expect(screen.queryByRole("link", { name: /see it on amazon/i })).not.toBeInTheDocument();
    });

    it("shows Points Earned label", async () => {
      await renderAndGuess();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("shows 'hint was used' badge when hint was used", async () => {
      mockedApi.getHint.mockResolvedValue({
        hintRange: { min: 1000, max: 3000 },
      });

      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      // Use hint first
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
      });
      await flushMicrotasks();

      // Then submit guess
      await submitPriceForm();

      expect(screen.getByText("Hint was used this round")).toBeInTheDocument();
    });

    it("does not show hint badge when hint was not used", async () => {
      await renderAndGuess();
      expect(screen.queryByText("Hint was used this round")).not.toBeInTheDocument();
    });

    it("shows score-zero class for 0-score results", async () => {
      await renderAndGuess({ score: 0, wentOver: true, pctOff: 0.2 });
      // The animated score starts at 0 and stays at 0 for score=0
      const scoreEl = screen.getByText("+0");
      expect(scoreEl).toHaveClass("score-zero");
    });
  });

  // ── Score animation ────────────────────────────────────────────────

  describe("score animation", () => {
    it("animates score from 0 to final value", async () => {
      const response = makeClosestResponse({ score: 700 });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      // Initially should show +0 (animation hasn't completed)
      expect(screen.getByText("+0")).toBeInTheDocument();

      // Advance timers to complete animation (800ms total)
      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      // Should now show the final score
      expect(screen.getByText("+700")).toBeInTheDocument();
    });

    it("shows 0 immediately for zero-score results", async () => {
      const response = makeClosestResponse({ score: 0, wentOver: true, pctOff: 0.2 });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.getByText("+0")).toBeInTheDocument();
    });
  });

  // ── Round navigation ───────────────────────────────────────────────

  describe("round navigation", () => {
    it("shows 'Next Round' button after guessing (not last round)", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("shows 'See Final Results' on last round", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: 10, gameMode: "closest" as const }),
      };
      renderWithProviders(<ClosestPage {...props} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("fetches next product when Next Round is clicked", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      // Clear the call count from initial fetch
      mockedApi.getProduct.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      await flushMicrotasks();

      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("calls onGameEnd when See Final Results is clicked", async () => {
      const response = makeClosestResponse();
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      const onGameEnd = vi.fn();
      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: 10, gameMode: "closest" as const }),
        onGameEnd,
      };
      renderWithProviders(<ClosestPage {...props} />);
      await flushMicrotasks();

      await submitPriceForm();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
      });

      expect(onGameEnd).toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("re-enables guessing if submission fails", async () => {
      mockedApi.submitClosestGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      // Should still show the input form (not the result overlay)
      expect(screen.getByRole("button", { name: "Lock In Price" })).toBeInTheDocument();
    });
  });

  // ── Image modal ────────────────────────────────────────────────────

  describe("image modal", () => {
    it("opens image modal when result product image is clicked", async () => {
      const response = makeClosestResponse({
        product: makeProductWithPrice({ title: "Gadget X" }),
      });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      const productImg = screen.getByAltText("Gadget X");
      await act(async () => {
        fireEvent.click(productImg);
      });

      // ImageModal should be rendered (look for the zoomed image)
      const images = screen.getAllByAltText("Gadget X");
      // Should have at least 2: one in result card, one in modal
      expect(images.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── CSS class variations ───────────────────────────────────────────

  describe("CSS class variations", () => {
    it("applies tier-miss class when went over", async () => {
      const response = makeClosestResponse({ wentOver: true, score: 0, pctOff: 0.15 });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      const title = screen.getByText("YOU WENT OVER!");
      expect(title).toHaveClass("tier-miss");
    });

    it("applies score-glow class for high scores", async () => {
      const response = makeClosestResponse({ score: 700, pctOff: 0.1, wentOver: false });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).toHaveClass("score-glow");
    });

    it("does not apply score-glow for low scores", async () => {
      const response = makeClosestResponse({ score: 200, pctOff: 0.4, wentOver: false });
      mockedApi.submitClosestGuess.mockResolvedValue(response);

      renderWithProviders(<ClosestPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).not.toHaveClass("score-glow");
    });
  });
});
