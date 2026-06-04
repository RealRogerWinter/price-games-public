import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import OddOneOutPage from "../pages/OddOneOutPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { OddOneOutRoundResult, OddOneOutGuessResponse, GameSession } from "@price-game/shared";
import { TOTAL_ROUNDS } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Four products returned by the odd-one-out endpoint. */
function makeOddOneOutData() {
  return {
    products: [
      makeProduct({ id: 1, title: "Widget A", category: "Electronics" }),
      makeProduct({ id: 2, title: "Widget B", category: "Electronics" }),
      makeProduct({ id: 3, title: "Widget C", category: "Electronics" }),
      makeProduct({ id: 4, title: "Widget D", category: "Home" }),
    ],
  };
}

/** Creates a minimal OddOneOutRoundResult for tests. */
function makeOddOneOutResult(overrides: Partial<OddOneOutRoundResult> = {}): OddOneOutRoundResult {
  return {
    products: [
      makeProductWithPrice({ id: 1, title: "Widget A", priceCents: 2000 }),
      makeProductWithPrice({ id: 2, title: "Widget B", priceCents: 2100 }),
      makeProductWithPrice({ id: 3, title: "Widget C", priceCents: 1900 }),
      makeProductWithPrice({ id: 4, title: "Widget D", priceCents: 9500 }),
    ],
    outlierProductId: 4,
    guessedProductId: 4,
    correct: true,
    score: 500,
    ...overrides,
  };
}

/** Creates an OddOneOutGuessResponse wrapping a result and session. */
function makeOddOneOutResponse(
  resultOverrides: Partial<OddOneOutRoundResult> = {},
  sessionOverrides: Partial<GameSession> = {}
): OddOneOutGuessResponse {
  return {
    result: makeOddOneOutResult(resultOverrides),
    session: makeSession(sessionOverrides),
  };
}

describe("OddOneOutPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeOddOneOutData() as unknown as ReturnType<typeof makeProduct>);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "odd-one-out" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  // ── Loading state ──────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading text while fetching products", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("shows scoreboard during loading", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      expect(screen.getByText("1 / 10")).toBeInTheDocument();
    });

    it("removes loading text after products are fetched", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading products...")).not.toBeInTheDocument();
    });
  });

  // ── Product rendering ──────────────────────────────────────────────

  describe("product rendering", () => {
    it("renders all four products after loading", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Widget A")).toBeInTheDocument();
      expect(screen.getByText("Widget B")).toBeInTheDocument();
      expect(screen.getByText("Widget C")).toBeInTheDocument();
      expect(screen.getByText("Widget D")).toBeInTheDocument();
    });

    it("fetches products with the correct session id", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("renders product category badges", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      const badges = screen.getAllByText("Electronics");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });

    it("shows the ODD ONE OUT question", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/ODD ONE OUT/i)).toBeInTheDocument();
    });

    it("renders four clickable product buttons", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      // Scope to product-card buttons only; the anon player-chip in the
      // scoreboard also renders as a button when no user is signed in.
      const buttons = document.querySelectorAll(".odd-one-out-grid button");
      expect(buttons).toHaveLength(4);
    });
  });

  // ── Guess submission ───────────────────────────────────────────────

  describe("guess submission", () => {
    it("calls submitOddOneOutGuess when a product is clicked", async () => {
      const response = makeOddOneOutResponse();
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget D")[0].closest("button")!);
      });
      await flushMicrotasks();

      expect(mockedApi.submitOddOneOutGuess).toHaveBeenCalledWith("session-1", 4, undefined);
    });

    it("calls onRoundComplete with result and session", async () => {
      const response = makeOddOneOutResponse();
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <OddOneOutPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });

    it("disables all product buttons after a guess", async () => {
      const response = makeOddOneOutResponse();
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      // The 4 product buttons should all be disabled (Next Round is not disabled)
      const disabledButtons = screen.getAllByRole("button").filter((btn) => btn.hasAttribute("disabled"));
      expect(disabledButtons).toHaveLength(4);
      disabledButtons.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });

    it("buttons are disabled after a guess preventing further clicks", async () => {
      const response = makeOddOneOutResponse();
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      // Click once and let state update
      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      // All 4 product cards should now be disabled, preventing further guesses
      const disabledButtons = screen.getAllByRole("button").filter((btn) => btn.hasAttribute("disabled"));
      expect(disabledButtons).toHaveLength(4);
      disabledButtons.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });
  });

  // ── Timer expiry ───────────────────────────────────────────────────

  describe("timer expiry", () => {
    it("auto-guesses first product when timer expires", async () => {
      const response = makeOddOneOutResponse({ guessedProductId: 1 });
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      await flushMicrotasks();

      expect(mockedApi.submitOddOneOutGuess).toHaveBeenCalledWith("session-1", 1, true);
    });
  });

  // ── Result overlay ─────────────────────────────────────────────────

  describe("result overlay", () => {
    async function renderAndGuess(
      resultOverrides: Partial<OddOneOutRoundResult> = {},
      sessionOverrides: Partial<GameSession> = {}
    ) {
      const response = makeOddOneOutResponse(resultOverrides, sessionOverrides);
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        // Use getAllByText to handle case where multiple elements share the title
        fireEvent.click(screen.getAllByText("Widget D")[0].closest("button")!);
      });
      await flushMicrotasks();

      return response;
    }

    it("shows result overlay after guessing", async () => {
      await renderAndGuess();
      expect(screen.queryByText("Correct!") ?? screen.queryByText("Wrong!")).toBeInTheDocument();
    });

    it("shows 'Correct!' when guess is right", async () => {
      await renderAndGuess({ correct: true, guessedProductId: 4, outlierProductId: 4 });
      expect(screen.getByText("Correct!")).toBeInTheDocument();
    });

    it("shows 'Wrong!' when guess is wrong", async () => {
      await renderAndGuess({
        correct: false,
        guessedProductId: 1,
        outlierProductId: 4,
        score: 0,
      });
      expect(screen.getByText("Wrong!")).toBeInTheDocument();
    });

    it("shows 'Outlier' badge on the correct outlier product", async () => {
      await renderAndGuess({ correct: true, outlierProductId: 4, guessedProductId: 4 });
      expect(screen.getByText("Outlier")).toBeInTheDocument();
    });

    it("shows Points Earned label", async () => {
      await renderAndGuess();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("applies tier-nice class on correct guess", async () => {
      await renderAndGuess({ correct: true });
      const title = screen.getByText("Correct!");
      expect(title).toHaveClass("tier-nice");
    });

    it("applies tier-miss class on wrong guess", async () => {
      await renderAndGuess({ correct: false, guessedProductId: 1, score: 0 });
      const title = screen.getByText("Wrong!");
      expect(title).toHaveClass("tier-miss");
    });

    it("shows all revealed product titles in the result", async () => {
      await renderAndGuess();
      // Both the game grid (h3) and reveal overlay (h4) may show the same titles
      const widgetAEls = screen.getAllByText("Widget A");
      expect(widgetAEls.length).toBeGreaterThanOrEqual(1);
      const widgetDEls = screen.getAllByText("Widget D");
      expect(widgetDEls.length).toBeGreaterThanOrEqual(1);
    });

    it("shows Amazon link when product has amazonUrl", async () => {
      await renderAndGuess({
        products: [
          makeProductWithPrice({ id: 4, title: "Widget D", priceCents: 9500, amazonUrl: "https://amazon.com/d" }),
          makeProductWithPrice({ id: 1, priceCents: 2000 }),
          makeProductWithPrice({ id: 2, priceCents: 2100 }),
          makeProductWithPrice({ id: 3, priceCents: 1900 }),
        ],
      });
      const link = screen.getByRole("link", { name: /see it on amazon/i });
      expect(link).toHaveAttribute("href", "https://amazon.com/d");
    });

    it("shows score +0 initially before animation completes", async () => {
      await renderAndGuess({ score: 500 });
      expect(screen.getByText("+0")).toBeInTheDocument();
    });

    it("animates score to final value", async () => {
      await renderAndGuess({ score: 500 });

      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByText("+500")).toBeInTheDocument();
    });

    it("applies score-glow class when score > 0", async () => {
      await renderAndGuess({ score: 500 });
      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).toHaveClass("score-glow");
    });

    it("applies score-zero class when score is 0", async () => {
      await renderAndGuess({ score: 0, correct: false, guessedProductId: 1 });
      const scoreEl = screen.getByText("+0");
      expect(scoreEl).toHaveClass("score-zero");
    });
  });

  // ── Round navigation ───────────────────────────────────────────────

  describe("round navigation", () => {
    async function renderAndGuess(sessionOverrides: Partial<GameSession> = {}) {
      const response = makeOddOneOutResponse({}, sessionOverrides);
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ gameMode: "odd-one-out" as const, ...sessionOverrides }),
      };
      renderWithProviders(<OddOneOutPage {...props} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget D")[0].closest("button")!);
      });
      await flushMicrotasks();
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
      const response = makeOddOneOutResponse();
      mockedApi.submitOddOneOutGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: TOTAL_ROUNDS, gameMode: "odd-one-out" as const }),
        onGameEnd,
      };
      renderWithProviders(<OddOneOutPage {...props} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
      });

      expect(onGameEnd).toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("re-enables buttons if submission fails", async () => {
      mockedApi.submitOddOneOutGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      // After error, hasGuessed resets, so buttons should be enabled
      const buttons = screen.getAllByRole("button");
      buttons.forEach((btn) => {
        expect(btn).not.toBeDisabled();
      });
    });

    it("does not show result overlay if submission fails", async () => {
      mockedApi.submitOddOneOutGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getAllByText("Widget A")[0].closest("button")!);
      });
      await flushMicrotasks();

      expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
      expect(screen.queryByText("Wrong!")).not.toBeInTheDocument();
    });
  });

  // ── Scoreboard ─────────────────────────────────────────────────────

  describe("scoreboard", () => {
    it("shows score from session", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 1200, gameMode: "odd-one-out" as const }),
      };
      renderWithProviders(<OddOneOutPage {...props} />);
      await flushMicrotasks();
      expect(screen.getByText("1200")).toBeInTheDocument();
    });

    it("shows round info", async () => {
      renderWithProviders(<OddOneOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("1 / 10")).toBeInTheDocument();
    });
  });
});
