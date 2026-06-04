import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import SortItOutPage from "../pages/SortItOutPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProduct,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";
import type { SortItOutRoundResult, SortItOutGuessResponse, GameSession } from "@price-game/shared";
import { TOTAL_ROUNDS } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Five products returned by the sort-it-out endpoint. */
function makeSortItOutData() {
  return {
    products: [
      makeProduct({ id: 1, title: "Product Alpha", category: "Electronics" }),
      makeProduct({ id: 2, title: "Product Beta", category: "Home" }),
      makeProduct({ id: 3, title: "Product Gamma", category: "Sports" }),
      makeProduct({ id: 4, title: "Product Delta", category: "Toys" }),
      makeProduct({ id: 5, title: "Product Epsilon", category: "Kitchen" }),
    ],
  };
}

/** Creates a minimal SortItOutRoundResult for tests. */
function makeSortItOutResult(overrides: Partial<SortItOutRoundResult> = {}): SortItOutRoundResult {
  return {
    products: [
      makeProductWithPrice({ id: 1, title: "Product Alpha", priceCents: 1000 }),
      makeProductWithPrice({ id: 2, title: "Product Beta", priceCents: 2000 }),
      makeProductWithPrice({ id: 3, title: "Product Gamma", priceCents: 3000 }),
      makeProductWithPrice({ id: 4, title: "Product Delta", priceCents: 4000 }),
      makeProductWithPrice({ id: 5, title: "Product Epsilon", priceCents: 5000 }),
    ],
    correctOrder: [1, 2, 3, 4, 5],
    submittedOrder: [1, 2, 3, 4, 5],
    correctCount: 5,
    score: 700,
    ...overrides,
  };
}

/** Creates a SortItOutGuessResponse wrapping a result and session. */
function makeSortItOutResponse(
  resultOverrides: Partial<SortItOutRoundResult> = {},
  sessionOverrides: Partial<GameSession> = {}
): SortItOutGuessResponse {
  return {
    result: makeSortItOutResult(resultOverrides),
    session: makeSession(sessionOverrides),
  };
}

describe("SortItOutPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeSortItOutData() as unknown as ReturnType<typeof makeProduct>);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ gameMode: "sort-it-out" as const }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  // ── Loading state ──────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading text while fetching products", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("shows scoreboard during loading", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      // Use getAllByText to handle multiple scoreboard elements
      expect(screen.getAllByText("1 / 10").length).toBeGreaterThanOrEqual(1);
    });

    it("removes loading text after products are fetched", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.queryByText("Loading products...")).not.toBeInTheDocument();
    });

    it("fetches products with the correct session id", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });
  });

  // ── Product rendering ──────────────────────────────────────────────

  describe("product rendering", () => {
    it("renders all five product titles after loading", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText("Product Alpha")).toBeInTheDocument();
      expect(screen.getByText("Product Beta")).toBeInTheDocument();
      expect(screen.getByText("Product Gamma")).toBeInTheDocument();
      expect(screen.getByText("Product Delta")).toBeInTheDocument();
      expect(screen.getByText("Product Epsilon")).toBeInTheDocument();
    });

    it("renders slot numbers 1 through 5", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      // Slot numbers are rendered as text "1" through "5" inside each slot button
      for (let n = 1; n <= 5; n++) {
        expect(screen.getByText(String(n))).toBeInTheDocument();
      }
    });

    it("shows the cheapest to most expensive instruction", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/CHEAPEST/)).toBeInTheDocument();
      expect(screen.getByText(/MOST EXPENSIVE/)).toBeInTheDocument();
    });

    it("shows the tap-to-swap instruction text", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/Tap two products to swap their positions/i)).toBeInTheDocument();
    });

    it("shows the Lock In Order button", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Lock In Order" })).toBeInTheDocument();
    });

    it("renders five sortable slot buttons", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();
      // Slot buttons are all buttons except the "Lock In Order" submit button
      // Scope to the sort list so the scoreboard's anon player-chip
      // button (added by PlayerChip when the user is logged out) doesn't
      // inflate the slot count.
      const slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      expect(slots).toHaveLength(5);
    });
  });

  // ── Selection and swap mechanic ────────────────────────────────────

  describe("slot selection and swap", () => {
    it("highlights a slot when clicked (adds sort-selected class)", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      // Scope to the sort list so the scoreboard's anon player-chip
      // button (added by PlayerChip when the user is logged out) doesn't
      // inflate the slot count.
      const slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      await act(async () => {
        fireEvent.click(slots[0]);
      });

      expect(slots[0]).toHaveClass("sort-selected");
    });

    it("deselects slot when clicking it again", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      // Scope to the sort list so the scoreboard's anon player-chip
      // button (added by PlayerChip when the user is logged out) doesn't
      // inflate the slot count.
      const slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      await act(async () => {
        fireEvent.click(slots[0]);
      });
      await act(async () => {
        fireEvent.click(slots[0]);
      });

      expect(slots[0]).not.toHaveClass("sort-selected");
    });

    it("swaps two slots when different slots are clicked in sequence", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      // Get initial first slot title
      let slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      const firstSlotTitle = slots[0].querySelector(".comparison-reveal-title")?.textContent;

      await act(async () => {
        fireEvent.click(slots[0]);
      });
      await act(async () => {
        fireEvent.click(slots[1]);
      });

      // After swap, the first slot should have the second slot's content
      slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      const newFirstSlotTitle = slots[0].querySelector(".comparison-reveal-title")?.textContent;
      expect(newFirstSlotTitle).not.toBe(firstSlotTitle);
    });

    it("clears selection after swap completes", async () => {
      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      // Scope to the sort list so the scoreboard's anon player-chip
      // button (added by PlayerChip when the user is logged out) doesn't
      // inflate the slot count.
      const slots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      await act(async () => {
        fireEvent.click(slots[0]);
      });
      await act(async () => {
        fireEvent.click(slots[1]);
      });

      // Neither slot should be selected
      const updatedSlots = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".sort-it-out-list button"),
      );
      updatedSlots.forEach((slot) => {
        expect(slot).not.toHaveClass("sort-selected");
      });
    });
  });

  // ── Lock In Order submission ───────────────────────────────────────

  describe("Lock In Order submission", () => {
    it("calls submitSortItOutGuess when Lock In Order is clicked", async () => {
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      expect(mockedApi.submitSortItOutGuess).toHaveBeenCalledWith(
        "session-1",
        expect.any(Array),
        undefined
      );
    });

    it("calls onRoundComplete with result and session after submission", async () => {
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      const onRoundComplete = vi.fn();
      renderWithProviders(
        <SortItOutPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      expect(onRoundComplete).toHaveBeenCalledWith(response.result, response.session, undefined);
    });

    it("hides Lock In Order button after guessing", async () => {
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      expect(screen.queryByRole("button", { name: "Lock In Order" })).not.toBeInTheDocument();
    });

    it("submits order containing all product IDs", async () => {
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      const call = mockedApi.submitSortItOutGuess.mock.calls[0];
      const submittedOrder = call[1] as number[];
      expect(submittedOrder).toHaveLength(5);
      expect(submittedOrder.sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // ── Timer auto-submit ──────────────────────────────────────────────

  describe("timer auto-submit", () => {
    it("auto-submits current order when timer expires", async () => {
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      await flushMicrotasks();

      expect(mockedApi.submitSortItOutGuess).toHaveBeenCalledWith(
        "session-1",
        expect.any(Array),
        true
      );
    });
  });

  // ── Result overlay ─────────────────────────────────────────────────

  describe("result overlay", () => {
    async function renderAndLockIn(
      resultOverrides: Partial<SortItOutRoundResult> = {},
      sessionOverrides: Partial<GameSession> = {}
    ) {
      const response = makeSortItOutResponse(resultOverrides, sessionOverrides);
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      return response;
    }

    it("shows result overlay after locking in order", async () => {
      await renderAndLockIn();
      expect(
        screen.queryByText("Perfect Order!") ??
        screen.queryByText(/\d+ of \d+ Correct/) ??
        screen.queryByText("None Correct!")
      ).toBeInTheDocument();
    });

    it("shows 'Perfect Order!' when all positions are correct", async () => {
      await renderAndLockIn({ correctCount: 5, submittedOrder: [1, 2, 3, 4, 5] });
      expect(screen.getByText("Perfect Order!")).toBeInTheDocument();
    });

    it("shows partial correct count message when some are correct", async () => {
      await renderAndLockIn({
        correctCount: 3,
        submittedOrder: [1, 2, 4, 3, 5],
      });
      expect(screen.getByText(/3 of 5 Correct/)).toBeInTheDocument();
    });

    it("shows 'None Correct!' when no positions are correct", async () => {
      await renderAndLockIn({
        correctCount: 0,
        submittedOrder: [5, 4, 3, 2, 1],
        score: 0,
      });
      expect(screen.getByText("None Correct!")).toBeInTheDocument();
    });

    it("shows 'Correct' badge on correctly placed products", async () => {
      await renderAndLockIn({ correctCount: 5, submittedOrder: [1, 2, 3, 4, 5] });
      const correctBadges = screen.getAllByText("Correct");
      expect(correctBadges.length).toBeGreaterThan(0);
    });

    it("shows Points Earned label in result", async () => {
      await renderAndLockIn();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });

    it("shows score +0 initially before animation completes", async () => {
      await renderAndLockIn({ score: 700 });
      expect(screen.getByText("+0")).toBeInTheDocument();
    });

    it("animates score to final value", async () => {
      await renderAndLockIn({ score: 700 });

      await act(async () => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.getByText("+700")).toBeInTheDocument();
    });

    it("applies tier-nice class when all positions are correct", async () => {
      await renderAndLockIn({ correctCount: 5 });
      const title = screen.getByText("Perfect Order!");
      expect(title).toHaveClass("tier-nice");
    });

    it("applies tier-ok class when some positions are correct", async () => {
      await renderAndLockIn({
        correctCount: 3,
        submittedOrder: [1, 2, 4, 3, 5],
      });
      const title = screen.getByText(/3 of 5 Correct/);
      expect(title).toHaveClass("tier-ok");
    });

    it("applies tier-miss class when no positions are correct", async () => {
      await renderAndLockIn({
        correctCount: 0,
        submittedOrder: [5, 4, 3, 2, 1],
        score: 0,
      });
      const title = screen.getByText("None Correct!");
      expect(title).toHaveClass("tier-miss");
    });

    it("shows Amazon link when result product has amazonUrl", async () => {
      await renderAndLockIn({
        products: [
          makeProductWithPrice({ id: 1, title: "Product Alpha", priceCents: 1000, amazonUrl: "https://amazon.com/alpha" }),
          makeProductWithPrice({ id: 2, title: "Product Beta", priceCents: 2000 }),
          makeProductWithPrice({ id: 3, title: "Product Gamma", priceCents: 3000 }),
          makeProductWithPrice({ id: 4, title: "Product Delta", priceCents: 4000 }),
          makeProductWithPrice({ id: 5, title: "Product Epsilon", priceCents: 5000 }),
        ],
      });
      const link = screen.getByRole("link", { name: /see it on amazon/i });
      expect(link).toHaveAttribute("href", "https://amazon.com/alpha");
    });

    it("applies score-glow class when score > 0", async () => {
      await renderAndLockIn({ score: 700 });
      const scoreSection = screen.getByText("Points Earned").closest(".result-score");
      expect(scoreSection).toHaveClass("score-glow");
    });

    it("applies score-zero class when score is 0", async () => {
      await renderAndLockIn({ score: 0, correctCount: 0 });
      const scoreEl = screen.getByText("+0");
      expect(scoreEl).toHaveClass("score-zero");
    });
  });

  // ── Round navigation ───────────────────────────────────────────────

  describe("round navigation", () => {
    async function renderAndLockIn(sessionOverrides: Partial<GameSession> = {}) {
      const response = makeSortItOutResponse({}, sessionOverrides);
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ gameMode: "sort-it-out" as const, ...sessionOverrides }),
      };
      renderWithProviders(<SortItOutPage {...props} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();
    }

    it("shows 'Next Round' button on non-final rounds", async () => {
      await renderAndLockIn();
      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("shows 'See Final Results' on the last round", async () => {
      await renderAndLockIn({ currentRound: TOTAL_ROUNDS });
      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("fetches next product when Next Round is clicked", async () => {
      await renderAndLockIn();
      mockedApi.getProduct.mockClear();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      await flushMicrotasks();

      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });

    it("calls onGameEnd when See Final Results is clicked", async () => {
      const onGameEnd = vi.fn();
      const response = makeSortItOutResponse();
      mockedApi.submitSortItOutGuess.mockResolvedValue(response);

      const props = {
        ...defaultProps,
        session: makeSession({ currentRound: TOTAL_ROUNDS, gameMode: "sort-it-out" as const }),
        onGameEnd,
      };
      renderWithProviders(<SortItOutPage {...props} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
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
    it("re-enables the Lock In Order button if submission fails", async () => {
      mockedApi.submitSortItOutGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      expect(screen.getByRole("button", { name: "Lock In Order" })).toBeInTheDocument();
    });

    it("does not show result overlay if submission fails", async () => {
      mockedApi.submitSortItOutGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<SortItOutPage {...defaultProps} />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Order" }));
      });
      await flushMicrotasks();

      expect(screen.queryByText("Perfect Order!")).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ of \d+ Correct/)).not.toBeInTheDocument();
      expect(screen.queryByText("None Correct!")).not.toBeInTheDocument();
    });
  });

  // ── Scoreboard ─────────────────────────────────────────────────────

  describe("scoreboard", () => {
    it("shows score from session", async () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 900, gameMode: "sort-it-out" as const }),
      };
      renderWithProviders(<SortItOutPage {...props} />);
      await flushMicrotasks();
      expect(screen.getByText("900")).toBeInTheDocument();
    });
  });
});
