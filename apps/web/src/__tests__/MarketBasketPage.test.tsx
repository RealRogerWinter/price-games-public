import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import MarketBasketPage from "../pages/MarketBasketPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { MarketBasketRoundResult, MarketBasketGuessResponse, GameSession } from "@price-game/shared";
import { TOTAL_ROUNDS } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Returns 3 products with priceRange metadata as returned by the market basket endpoint. */
function makeMarketBasketData() {
  return {
    products: [
      makeProduct({ id: 1, title: "Basket Item A", category: "Electronics", priceRange: { min: 1000, max: 3000 } }),
      makeProduct({ id: 2, title: "Basket Item B", category: "Home", priceRange: { min: 500, max: 2000 } }),
      makeProduct({ id: 3, title: "Basket Item C", category: "Sports", priceRange: { min: 200, max: 1500 } }),
    ],
    itemCount: 3,
  };
}

/** Creates a minimal MarketBasketRoundResult for tests. */
function makeMarketBasketResult(overrides: Partial<MarketBasketRoundResult> = {}): MarketBasketRoundResult {
  return {
    products: [
      makeProductWithPrice({ id: 1, title: "Basket Item A", priceCents: 2000 }),
      makeProductWithPrice({ id: 2, title: "Basket Item B", priceCents: 1500 }),
      makeProductWithPrice({ id: 3, title: "Basket Item C", priceCents: 800 }),
    ],
    actualTotalCents: 4300,
    guessedTotalCents: 4500,
    pctOff: 0.047,
    score: 700,
    ...overrides,
  };
}

/** Creates a MarketBasketGuessResponse wrapping a result and session. */
function makeMarketBasketResponse(
  resultOverrides: Partial<MarketBasketRoundResult> = {},
  sessionOverrides: Partial<GameSession> = {}
): MarketBasketGuessResponse {
  return {
    result: makeMarketBasketResult(resultOverrides),
    session: makeSession(sessionOverrides),
  };
}

describe("MarketBasketPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeMarketBasketData() as unknown as ReturnType<typeof makeProduct>);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "market-basket" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  /** Submit the price form. */
  async function submitPriceForm() {
    const form = screen.getByText("Your Total Estimate").closest("form") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
    });
    await flushMicrotasks();
  }

  // ── Loading state ──────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading text while fetching products", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("shows scoreboard during loading", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      expect(screen.getAllByText("1 / 10").length).toBeGreaterThanOrEqual(1);
    });

    it("removes loading text after products are fetched", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading products...")).not.toBeInTheDocument();
    });

    it("fetches products with the correct session id", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });
  });

  // ── Product rendering ──────────────────────────────────────────────

  describe("product rendering", () => {
    it("renders all product titles after loading", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Basket Item A")).toBeInTheDocument();
      expect(screen.getByText("Basket Item B")).toBeInTheDocument();
      expect(screen.getByText("Basket Item C")).toBeInTheDocument();
    });

    it("shows TOTAL PRICE question with item count", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/TOTAL PRICE/)).toBeInTheDocument();
      expect(screen.getByText(/3 items/)).toBeInTheDocument();
    });

    it("shows the price estimate label", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Your Total Estimate")).toBeInTheDocument();
    });

    it("shows the Lock In Total submit button", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Lock In Total" })).toBeInTheDocument();
    });

    it("renders a price slider", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("slider")).toBeInTheDocument();
    });

    it("renders a text input for price entry", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });

  // ── Guess submission ───────────────────────────────────────────────

  describe("guess submission", () => {
    it("calls submitMarketBasketGuess on form submit", async () => {
      const response = makeMarketBasketResponse();
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(mockedApi.submitMarketBasketGuess).toHaveBeenCalledWith(
        "session-1",
        expect.any(Number),
        undefined
      );
    });

    it("calls onRoundComplete with result and session", async () => {
      const response = makeMarketBasketResponse();
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <MarketBasketPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await submitPriceForm();

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });

    it("hides the Lock In Total button after submission", async () => {
      const response = makeMarketBasketResponse();
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.queryByRole("button", { name: "Lock In Total" })).not.toBeInTheDocument();
    });

    it("updates cents value when text input is changed", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      const input = screen.getByRole("textbox") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: "50" } });
      });

      // Input value should have changed
      expect(input.value).toBe("50");
    });

    it("updates cents when slider is moved", async () => {
      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      const slider = screen.getByRole("slider") as HTMLInputElement;
      const initialValue = slider.value;

      await act(async () => {
        fireEvent.change(slider, { target: { value: "5000" } });
      });

      expect(slider.value).not.toBe(initialValue);
    });

    it("submits with timedOut=true when timer expires", async () => {
      const response = makeMarketBasketResponse({ score: 0 });
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        vi.advanceTimersByTime(46_000);
      });
      await flushMicrotasks();

      expect(mockedApi.submitMarketBasketGuess).toHaveBeenCalledWith(
        "session-1",
        expect.any(Number),
        true
      );
    });
  });

  // ── Result overlay ─────────────────────────────────────────────────

  describe("result overlay", () => {
    async function renderAndGuess(
      resultOverrides: Partial<MarketBasketRoundResult> = {},
      sessionOverrides: Partial<GameSession> = {}
    ) {
      const response = makeMarketBasketResponse(resultOverrides, sessionOverrides);
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      return response;
    }

    it("shows result overlay after submitting a guess", async () => {
      await renderAndGuess();
      expect(screen.queryByText(/Great Estimate!|Not Bad!|Way Off!/)).toBeInTheDocument();
    });

    it("shows 'Great Estimate!' when pctOff <= 0.10", async () => {
      await renderAndGuess({ pctOff: 0.05 });
      expect(screen.getByText("Great Estimate!")).toBeInTheDocument();
    });

    it("shows 'Not Bad!' when pctOff <= 0.30", async () => {
      await renderAndGuess({ pctOff: 0.20 });
      expect(screen.getByText("Not Bad!")).toBeInTheDocument();
    });

    it("shows 'Way Off!' when pctOff > 0.30", async () => {
      await renderAndGuess({ pctOff: 0.45, score: 100 });
      expect(screen.getByText("Way Off!")).toBeInTheDocument();
    });

    it("shows Actual Total price", async () => {
      await renderAndGuess({ actualTotalCents: 4300 });
      expect(screen.getByText("Actual Total:")).toBeInTheDocument();
    });

    it("shows Your Guess price", async () => {
      await renderAndGuess({ guessedTotalCents: 4500 });
      expect(screen.getByText("Your Guess:")).toBeInTheDocument();
    });

    it("shows Off by percentage", async () => {
      await renderAndGuess({ pctOff: 0.047 });
      expect(screen.getByText("Off by:")).toBeInTheDocument();
      expect(screen.getByText("4.7%")).toBeInTheDocument();
    });

    it("shows Points Earned label", async () => {
      await renderAndGuess();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("shows score +0 initially before animation completes", async () => {
      await renderAndGuess({ score: 700 });
      expect(screen.getByText("+0")).toBeInTheDocument();
    });

    it("animates score to final value", async () => {
      await renderAndGuess({ score: 700 });

      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByText("+700")).toBeInTheDocument();
    });

    it("applies tier-nice class when pctOff <= 0.10", async () => {
      await renderAndGuess({ pctOff: 0.05 });
      const title = screen.getByText("Great Estimate!");
      expect(title).toHaveClass("tier-nice");
    });

    it("applies tier-ok class when pctOff is between 0.10 and 0.30", async () => {
      await renderAndGuess({ pctOff: 0.20 });
      const title = screen.getByText("Not Bad!");
      expect(title).toHaveClass("tier-ok");
    });

    it("applies tier-miss class when pctOff > 0.30", async () => {
      await renderAndGuess({ pctOff: 0.45, score: 100 });
      const title = screen.getByText("Way Off!");
      expect(title).toHaveClass("tier-miss");
    });

    it("shows all product titles in the reveal", async () => {
      await renderAndGuess();
      // Both game grid and reveal overlay show titles; use getAllByText
      expect(screen.getAllByText("Basket Item A").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Basket Item B").length).toBeGreaterThanOrEqual(1);
    });

    it("shows Amazon link when result product has amazonUrl", async () => {
      await renderAndGuess({
        products: [
          makeProductWithPrice({ id: 1, title: "Basket Item A", priceCents: 2000, amazonUrl: "https://amazon.com/a" }),
          makeProductWithPrice({ id: 2, title: "Basket Item B", priceCents: 1500 }),
          makeProductWithPrice({ id: 3, title: "Basket Item C", priceCents: 800 }),
        ],
      });
      const link = screen.getByRole("link", { name: /see it on amazon/i });
      expect(link).toHaveAttribute("href", "https://amazon.com/a");
    });

    it("applies score-glow class when score > 0", async () => {
      await renderAndGuess({ score: 700 });
      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).toHaveClass("score-glow");
    });

    it("applies score-zero class when score is 0", async () => {
      await renderAndGuess({ score: 0, pctOff: 0.60 });
      const scoreEl = screen.getByText("+0");
      expect(scoreEl).toHaveClass("score-zero");
    });
  });

  // ── Round navigation ───────────────────────────────────────────────

  describe("round navigation", () => {
    async function renderAndGuess(sessionOverrides: Partial<GameSession> = {}) {
      const response = makeMarketBasketResponse({}, sessionOverrides);
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ gameMode: "market-basket" as const, ...sessionOverrides }),
      };
      renderWithProviders(<MarketBasketPage {...props} />);
      await flushMicrotasks();

      await submitPriceForm();
    }

    it("shows 'Next Round' button on non-final rounds", async () => {
      await renderAndGuess();
      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("shows 'See Final Results' on the last round", async () => {
      await renderAndGuess({ currentRound: TOTAL_ROUNDS });
      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("fetches next product when Next Round is clicked", async () => {
      await renderAndGuess();
      mockedApi.getProduct.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      await flushMicrotasks();

      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("calls onGameEnd when See Final Results is clicked", async () => {
      const onGameEnd = vi.fn();
      const response = makeMarketBasketResponse();
      mockedApi.submitMarketBasketGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: TOTAL_ROUNDS, gameMode: "market-basket" as const }),
        onGameEnd,
      };
      renderWithProviders(<MarketBasketPage {...props} />);
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
      mockedApi.submitMarketBasketGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.getByRole("button", { name: "Lock In Total" })).toBeInTheDocument();
    });

    it("does not show result overlay if submission fails", async () => {
      mockedApi.submitMarketBasketGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<MarketBasketPage {...defaultProps} />);
      await flushMicrotasks();

      await submitPriceForm();

      expect(screen.queryByText(/Great Estimate!|Not Bad!|Way Off!/)).not.toBeInTheDocument();
    });
  });

  // ── Scoreboard ─────────────────────────────────────────────────────

  describe("scoreboard", () => {
    it("shows score from session", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 1800, gameMode: "market-basket" as const }),
      };
      renderWithProviders(<MarketBasketPage {...props} />);
      await flushMicrotasks();
      expect(screen.getByText("1800")).toBeInTheDocument();
    });
  });
});
