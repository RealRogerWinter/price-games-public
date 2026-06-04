import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import BudgetBuilderPage from "../pages/BudgetBuilderPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  flushMicrotasks,
} from "./testUtils";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Minimal budget data returned by the mocked getProduct call. */
function makeBudgetData() {
  return {
    products: [
      { id: 1, title: "Widget A", imageUrl: "a.jpg", description: "", category: "Electronics" },
      { id: 2, title: "Widget B", imageUrl: "b.jpg", description: "", category: "Electronics" },
      { id: 3, title: "Widget C", imageUrl: "c.jpg", description: "", category: "Home" },
    ],
    budgetCents: 5000,
  };
}

/** Minimal result returned by submitBudgetBuilderGuess. */
function makeBudgetResult(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      score: 500,
      budgetCents: 5000,
      cartTotalCents: 4800,
      selectedProductIds: [1, 2],
      products: [
        { id: 1, title: "Widget A", imageUrl: "a.jpg", description: "", category: "Electronics", priceCents: 2500 },
        { id: 2, title: "Widget B", imageUrl: "b.jpg", description: "", category: "Electronics", priceCents: 2300 },
        { id: 3, title: "Widget C", imageUrl: "c.jpg", description: "", category: "Home", priceCents: 3000 },
      ],
      ...overrides,
    },
    session: makeSession({ currentRound: 1, totalScore: 500, gameMode: "budget_builder" as any }),
  };
}

describe("BudgetBuilderPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const defaultProps = {
    session: makeSession({ gameMode: "budget_builder" as any }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeBudgetData() as any);
    mockedApi.submitBudgetBuilderGuess.mockResolvedValue(makeBudgetResult() as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  describe("loading state", () => {
    it("shows loading state while fetching products", () => {
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("calls getProduct with the session id", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Product rendering
  // ---------------------------------------------------------------------------

  describe("product rendering", () => {
    it("renders all products after fetch", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getAllByText("Widget A").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Widget B").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Widget C").length).toBeGreaterThanOrEqual(1);
    });

    it("shows the budget amount", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      // Budget is 5000 cents = $50.00
      const budgetTexts = screen.getAllByText(/\$50\.00/);
      expect(budgetTexts.length).toBeGreaterThan(0);
    });

    it("shows '0 items selected' initially", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByText(/0 item/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Product toggling
  // ---------------------------------------------------------------------------

  describe("product toggling", () => {
    it("toggles a product into the cart on click", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cards = screen.getAllByRole("button", { name: /Widget A/i });
      fireEvent.click(cards[0]);
      expect(screen.getByText(/1 item selected/)).toBeInTheDocument();
    });

    it("toggles product back out of cart on second click", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cards = screen.getAllByRole("button", { name: /Widget A/i });
      fireEvent.click(cards[0]);
      expect(screen.getByText(/1 item selected/)).toBeInTheDocument();
      fireEvent.click(cards[0]);
      expect(screen.getByText(/0 item/)).toBeInTheDocument();
    });

    it("shows 'In Cart' badge for selected products", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cards = screen.getAllByRole("button", { name: /Widget A/i });
      fireEvent.click(cards[0]);
      expect(screen.getByText("In Cart")).toBeInTheDocument();
    });

    it("shows plural 'items selected' when more than one selected", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      const cardB = screen.getAllByRole("button", { name: /Widget B/i })[0];
      fireEvent.click(cardA);
      fireEvent.click(cardB);
      expect(screen.getByText(/2 items selected/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Lock In Cart button
  // ---------------------------------------------------------------------------

  describe("Lock In Cart button", () => {
    it("is disabled when no products selected", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      expect(screen.getByRole("button", { name: "Lock In Cart" })).toBeDisabled();
    });

    it("is enabled after selecting a product", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cards = screen.getAllByRole("button", { name: /Widget A/i });
      fireEvent.click(cards[0]);
      expect(screen.getByRole("button", { name: "Lock In Cart" })).not.toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Submitting guess
  // ---------------------------------------------------------------------------

  describe("submitting guess", () => {
    it("calls submitBudgetBuilderGuess with selected ids", async () => {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();

      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      const cardB = screen.getAllByRole("button", { name: /Widget B/i })[0];
      fireEvent.click(cardA);
      fireEvent.click(cardB);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });

      expect(mockedApi.submitBudgetBuilderGuess).toHaveBeenCalledWith(
        "session-1",
        expect.arrayContaining([1, 2]),
        undefined
      );
    });

    it("calls onRoundComplete after successful submission", async () => {
      const onRoundComplete = vi.fn();
      renderWithProviders(
        <BudgetBuilderPage {...defaultProps} onRoundComplete={onRoundComplete} />
      );
      await flushMicrotasks();

      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });

      expect(onRoundComplete).toHaveBeenCalledWith(
        expect.objectContaining({ score: 500 }),
        expect.objectContaining({ id: "session-1" }),
        undefined,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Result overlay
  // ---------------------------------------------------------------------------

  describe("result overlay", () => {
    async function submitAndGetResult(overrides: Record<string, unknown> = {}) {
      mockedApi.submitBudgetBuilderGuess.mockResolvedValue(makeBudgetResult(overrides) as any);
      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();
      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });
    }

    it("shows 'Under Budget!' when cart total is below budget", async () => {
      // cartTotalCents=4800 < budgetCents=5000
      await submitAndGetResult();
      expect(screen.getByText("Under Budget!")).toBeInTheDocument();
    });

    it("shows 'Over Budget!' when cart total exceeds budget", async () => {
      await submitAndGetResult({ cartTotalCents: 6000 });
      expect(screen.getByText("Over Budget!")).toBeInTheDocument();
    });

    it("shows product prices in the result overlay for selected products", async () => {
      // selectedProductIds=[1,2]; Widget A priceCents=2500 → $25.00
      await submitAndGetResult();
      expect(screen.getByText("$25.00")).toBeInTheDocument();
    });

    it("shows cart total and budget labels in result overlay", async () => {
      await submitAndGetResult();
      expect(screen.getByText("Cart Total:")).toBeInTheDocument();
      expect(screen.getByText("Budget:")).toBeInTheDocument();
    });

    it("shows points earned in result overlay", async () => {
      await submitAndGetResult();
      expect(screen.getByText("Points Earned")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Next Round / See Final Results
  // ---------------------------------------------------------------------------

  describe("round navigation", () => {
    async function submitRound(session = defaultProps.session) {
      renderWithProviders(<BudgetBuilderPage {...defaultProps} session={session} />);
      await flushMicrotasks();
      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });
    }

    it("shows 'Next Round' button when not on last round", async () => {
      await submitRound();
      expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
    });

    it("shows 'See Final Results' on last round", async () => {
      const lastRoundSession = makeSession({ currentRound: 10, gameMode: "budget_builder" as any });
      await submitRound(lastRoundSession);
      expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
    });

    it("calls onGameEnd when 'See Final Results' is clicked on last round", async () => {
      const onGameEnd = vi.fn();
      const lastRoundSession = makeSession({ currentRound: 10, gameMode: "budget_builder" as any });
      renderWithProviders(
        <BudgetBuilderPage {...defaultProps} session={lastRoundSession} onGameEnd={onGameEnd} />
      );
      await flushMicrotasks();
      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });
      fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
      expect(onGameEnd).toHaveBeenCalled();
    });

    it("advances to next round when 'Next Round' is clicked", async () => {
      await submitRound();
      const callsBefore = mockedApi.getProduct.mock.calls.length;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
        await flushMicrotasks();
      });
      expect(mockedApi.getProduct.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("shows loading state between rounds after advancing", async () => {
      // Make the second getProduct call never resolve to catch loading state
      await submitRound();
      mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
      });
      expect(screen.getByText("Loading products...")).toBeInTheDocument();
    });

    it("clears any selected-card highlights when advancing to the next round", async () => {
      // Regression: after locking in a cart and clicking Next Round, the
      // green "in cart" highlight from the previous round must not bleed
      // into the new round. Resolve the second getProduct call so the new
      // round renders fully, then assert there is no "In Cart" badge in the
      // DOM.
      const { container } = renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();

      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);
      expect(screen.getByText("In Cart")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });

      // Ensure the next round's product fetch resolves so we render its cards.
      mockedApi.getProduct.mockResolvedValue(makeBudgetData() as any);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
        await flushMicrotasks();
      });

      // No "In Cart" badge anywhere in the DOM — selectedIds was cleared.
      expect(screen.queryByText("In Cart")).not.toBeInTheDocument();
      // And no card carries the budget-selected class (defensive belt + braces).
      expect(container.querySelectorAll(".budget-selected")).toHaveLength(0);
      // Counter resets to "0 items selected".
      expect(screen.getByText(/0 item/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("re-enables selection when API call fails", async () => {
      mockedApi.submitBudgetBuilderGuess.mockRejectedValue(new Error("Network error"));

      renderWithProviders(<BudgetBuilderPage {...defaultProps} />);
      await flushMicrotasks();

      const cardA = screen.getAllByRole("button", { name: /Widget A/i })[0];
      fireEvent.click(cardA);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Cart" }));
        await flushMicrotasks();
      });

      // After error, hasGuessed resets so Lock In Cart button reappears
      expect(screen.getByRole("button", { name: "Lock In Cart" })).toBeInTheDocument();
    });
  });
});
