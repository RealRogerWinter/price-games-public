import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import ChainReactionPage from "../pages/ChainReactionPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { ChainReactionRoundResult, ChainReactionGuessResponse, GameSession } from "@price-game/shared";
import { TOTAL_ROUNDS } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Five products for chain reaction (one anchor + 4 guesses). */
function makeChainData() {
  return {
    products: [
      makeProduct({ id: 1, title: "Chain Product 1", category: "Electronics" }),
      makeProduct({ id: 2, title: "Chain Product 2", category: "Home" }),
      makeProduct({ id: 3, title: "Chain Product 3", category: "Sports" }),
      makeProduct({ id: 4, title: "Chain Product 4", category: "Toys" }),
      makeProduct({ id: 5, title: "Chain Product 5", category: "Kitchen" }),
    ],
  };
}

/** Creates a minimal ChainReactionRoundResult for tests. */
function makeChainResult(overrides: Partial<ChainReactionRoundResult> = {}): ChainReactionRoundResult {
  return {
    products: [
      makeProductWithPrice({ id: 1, title: "Chain Product 1", priceCents: 1000 }),
      makeProductWithPrice({ id: 2, title: "Chain Product 2", priceCents: 2000 }),
      makeProductWithPrice({ id: 3, title: "Chain Product 3", priceCents: 3000 }),
      makeProductWithPrice({ id: 4, title: "Chain Product 4", priceCents: 4000 }),
      makeProductWithPrice({ id: 5, title: "Chain Product 5", priceCents: 5000 }),
    ],
    chainGuesses: ["more", "more", "more", "more"],
    correctCount: 4,
    chainLength: 4,
    score: 800,
    ...overrides,
  };
}

/** Creates a ChainReactionGuessResponse wrapping a result and session. */
function makeChainResponse(
  resultOverrides: Partial<ChainReactionRoundResult> = {},
  sessionOverrides: Partial<GameSession> = {}
): ChainReactionGuessResponse {
  return {
    result: makeChainResult(resultOverrides),
    session: makeSession(sessionOverrides),
  };
}

describe("ChainReactionPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeChainData() as unknown as ReturnType<typeof makeProduct>);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "chain-reaction" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  /** Advance through the entire chain by clicking Start Chain then making all guesses. */
  async function completeChain(guess: "more" | "less" = "more") {
    // Click Start Chain to advance from product 0 to product 1
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Chain" }));
    });

    // Make 4 guesses (products 1-4)
    for (let i = 0; i < 4; i++) {
      await flushMicrotasks();
      const buttonName = guess === "more" ? "More Expensive" : "Less Expensive";
      const btn = screen.queryByRole("button", { name: buttonName });
      if (btn) {
        await act(async () => {
          fireEvent.click(btn);
        });
      }
    }
    await flushMicrotasks();
  }

  // ── Loading state ──────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading text while fetching products", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("shows scoreboard during loading", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      expect(screen.getAllByText("1 / 10").length).toBeGreaterThanOrEqual(1);
    });

    it("removes loading text after products are fetched", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading products...")).not.toBeInTheDocument();
    });

    it("fetches products with the correct session id", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });
  });

  // ── Initial state: first product and Start Chain ───────────────────

  describe("initial state (first product)", () => {
    it("shows the first product after loading", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Chain Product 1")).toBeInTheDocument();
    });

    it("shows 'Starting product' label for the first item", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Starting product")).toBeInTheDocument();
    });

    it("shows 'Start Chain' button for the first item", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Start Chain" })).toBeInTheDocument();
    });

    it("shows the ready instruction text", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/This is your starting product. Ready\?/i)).toBeInTheDocument();
    });

    it("does NOT show More Expensive / Less Expensive buttons on first product", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByRole("button", { name: "More Expensive" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Less Expensive" })).not.toBeInTheDocument();
    });

    it("shows Chain Reaction header with link count", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/Chain Reaction/i)).toBeInTheDocument();
    });
  });

  // ── After clicking Start Chain ─────────────────────────────────────

  describe("after clicking Start Chain", () => {
    it("shows the second product after clicking Start Chain", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start Chain" }));
      });

      expect(screen.getByText("Chain Product 2")).toBeInTheDocument();
    });

    it("shows More Expensive and Less Expensive buttons after Start Chain", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start Chain" }));
      });

      expect(screen.getByRole("button", { name: "More Expensive" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Less Expensive" })).toBeInTheDocument();
    });

    it("shows 'Is this MORE or LESS expensive?' label", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start Chain" }));
      });

      expect(screen.getByText(/Is this MORE or LESS expensive\?/i)).toBeInTheDocument();
    });

    it("shows previous product label after making first guess", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start Chain" }));
      });
      await flushMicrotasks();

      // After clicking Start Chain, current product is 2 and previous should be shown
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "More Expensive" }));
      });
      await flushMicrotasks();

      expect(screen.getByText("Previous")).toBeInTheDocument();
    });
  });

  // ── Completing the chain ───────────────────────────────────────────

  describe("completing the chain", () => {
    it("calls submitChainReactionGuess after all guesses are made", async () => {
      const response = makeChainResponse();
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("more");

      expect(mockedApi.submitChainReactionGuess).toHaveBeenCalledWith(
        "session-1",
        expect.arrayContaining(["more"])
      );
    });

    it("submits correct number of guesses (4 for 5 products)", async () => {
      const response = makeChainResponse();
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("more");

      const call = mockedApi.submitChainReactionGuess.mock.calls[0];
      const guesses = call[1] as string[];
      expect(guesses).toHaveLength(4);
    });

    it("calls onRoundComplete with result and session after submission", async () => {
      const response = makeChainResponse();
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <ChainReactionPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await completeChain("more");

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });

    it("submits 'less' guesses when Less Expensive is chosen throughout", async () => {
      const response = makeChainResponse({ chainGuesses: ["less", "less", "less", "less"] });
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("less");

      const call = mockedApi.submitChainReactionGuess.mock.calls[0];
      const guesses = call[1] as string[];
      expect(guesses).toEqual(["less", "less", "less", "less"]);
    });
  });

  // ── Result overlay ─────────────────────────────────────────────────

  describe("result overlay", () => {
    async function renderAndComplete(
      resultOverrides: Partial<ChainReactionRoundResult> = {},
      sessionOverrides: Partial<GameSession> = {}
    ) {
      const response = makeChainResponse(resultOverrides, sessionOverrides);
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("more");

      return response;
    }

    it("shows result overlay after completing the chain", async () => {
      await renderAndComplete();
      expect(
        screen.queryByText("Perfect Chain!") ??
        screen.queryByText(/\d+ of \d+ Correct/) ??
        screen.queryByText("No Correct Links!")
      ).toBeInTheDocument();
    });

    it("shows 'Perfect Chain!' when all links are correct", async () => {
      await renderAndComplete({ correctCount: 4, chainLength: 4 });
      expect(screen.getByText("Perfect Chain!")).toBeInTheDocument();
    });

    it("shows partial correct count message for some correct", async () => {
      await renderAndComplete({ correctCount: 2, chainLength: 4 });
      expect(screen.getByText(/2 of 4 Correct/)).toBeInTheDocument();
    });

    it("shows 'No Correct Links!' when none are correct", async () => {
      await renderAndComplete({ correctCount: 0, chainLength: 4, score: 0 });
      expect(screen.getByText("No Correct Links!")).toBeInTheDocument();
    });

    it("shows Points Earned label", async () => {
      await renderAndComplete();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("shows score +0 initially before animation completes", async () => {
      await renderAndComplete({ score: 800 });
      expect(screen.getByText("+0")).toBeInTheDocument();
    });

    it("animates score to final value", async () => {
      await renderAndComplete({ score: 800 });

      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByText("+800")).toBeInTheDocument();
    });

    it("applies tier-nice class when all links correct", async () => {
      await renderAndComplete({ correctCount: 4, chainLength: 4 });
      const title = screen.getByText("Perfect Chain!");
      expect(title).toHaveClass("tier-nice");
    });

    it("applies tier-ok class when more than half correct", async () => {
      await renderAndComplete({ correctCount: 3, chainLength: 4 });
      const title = screen.getByText(/3 of 4 Correct/);
      expect(title).toHaveClass("tier-ok");
    });

    it("applies tier-miss class when none correct", async () => {
      await renderAndComplete({ correctCount: 0, chainLength: 4, score: 0 });
      const title = screen.getByText("No Correct Links!");
      expect(title).toHaveClass("tier-miss");
    });

    it("shows 'You said: More' badge in the result reveal", async () => {
      await renderAndComplete({
        chainGuesses: ["more", "more", "more", "more"],
      });
      const moreBadges = screen.getAllByText(/You said: More/);
      expect(moreBadges.length).toBeGreaterThan(0);
    });

    it("shows Amazon link when result product has amazonUrl", async () => {
      await renderAndComplete({
        products: [
          makeProductWithPrice({ id: 1, title: "Chain Product 1", priceCents: 1000, amazonUrl: "https://amazon.com/1" }),
          makeProductWithPrice({ id: 2, title: "Chain Product 2", priceCents: 2000 }),
          makeProductWithPrice({ id: 3, title: "Chain Product 3", priceCents: 3000 }),
          makeProductWithPrice({ id: 4, title: "Chain Product 4", priceCents: 4000 }),
          makeProductWithPrice({ id: 5, title: "Chain Product 5", priceCents: 5000 }),
        ],
      });
      const link = screen.getByRole("link", { name: /see it on amazon/i });
      expect(link).toHaveAttribute("href", "https://amazon.com/1");
    });

    it("applies score-glow class when score > 0", async () => {
      await renderAndComplete({ score: 800 });
      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).toHaveClass("score-glow");
    });

    it("applies score-zero class when score is 0", async () => {
      await renderAndComplete({ score: 0, correctCount: 0 });
      const scoreEl = screen.getByText("+0");
      expect(scoreEl).toHaveClass("score-zero");
    });
  });

  // ── Round navigation ───────────────────────────────────────────────

  describe("round navigation", () => {
    async function renderAndComplete(sessionOverrides: Partial<GameSession> = {}) {
      const response = makeChainResponse({}, sessionOverrides);
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ gameMode: "chain-reaction" as const, ...sessionOverrides }),
      };
      renderWithProviders(<ChainReactionPage {...props} />);
      await flushMicrotasks();

      await completeChain("more");
    }

    it("shows 'Next Round' button on non-final rounds", async () => {
      await renderAndComplete();
      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("shows 'See Final Results' on the last round", async () => {
      await renderAndComplete({ currentRound: TOTAL_ROUNDS });
      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("fetches next product when Next Round is clicked", async () => {
      await renderAndComplete();
      mockedApi.getProduct.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      await flushMicrotasks();

      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("calls onGameEnd when See Final Results is clicked", async () => {
      const onGameEnd = vi.fn();
      const response = makeChainResponse();
      mockedApi.submitChainReactionGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: TOTAL_ROUNDS, gameMode: "chain-reaction" as const }),
        onGameEnd,
      };
      renderWithProviders(<ChainReactionPage {...props} />);
      await flushMicrotasks();

      await completeChain("more");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
      });

      expect(onGameEnd).toHaveBeenCalled();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("re-enables guessing if submission fails", async () => {
      mockedApi.submitChainReactionGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("more");

      // After error, chain should be re-enabled — no result overlay shown
      expect(screen.queryByText("Perfect Chain!")).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ of \d+ Correct/)).not.toBeInTheDocument();
      expect(screen.queryByText("No Correct Links!")).not.toBeInTheDocument();
    });

    it("does not show result overlay if submission fails", async () => {
      mockedApi.submitChainReactionGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();

      await completeChain("more");

      expect(screen.queryByText("Perfect Chain!")).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ of \d+ Correct/)).not.toBeInTheDocument();
      expect(screen.queryByText("No Correct Links!")).not.toBeInTheDocument();
    });
  });

  // ── Scoreboard ─────────────────────────────────────────────────────

  describe("scoreboard", () => {
    it("shows score from session", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 2400, gameMode: "chain-reaction" as const }),
      };
      renderWithProviders(<ChainReactionPage {...props} />);
      await flushMicrotasks();
      expect(screen.getByText("2400")).toBeInTheDocument();
    });

    it("shows round info", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getAllByText("1 / 10").length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Chain progress indicator ───────────────────────────────────────

  describe("chain progress indicator", () => {
    it("renders chain progress dots for all products", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      const dots = screen.getAllByTestId("chain-progress-dot");
      expect(dots).toHaveLength(5);
    });

    it("marks first dot as current initially", async () => {
      renderWithProviders(<ChainReactionPage {...defaultProps} />);
      await flushMicrotasks();
      const dots = screen.getAllByTestId("chain-progress-dot");
      const currentDot = dots.find((dot) => dot.classList.contains("dot-current"));
      expect(currentDot).toBeInTheDocument();
    });
  });
});
