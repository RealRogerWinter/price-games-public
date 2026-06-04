import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import ResultPage from "../pages/ResultPage";
import { renderWithAllProviders, makeSession, makeProductWithPrice } from "./testUtils";

vi.mock("../api/client", () => ({
  getUserRank: vi.fn().mockResolvedValue({ rank: 5, totalPlayers: 100 }),
}));

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn().mockRejectedValue(new Error("401")),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: vi.fn(() => ({ user: null })),
  UserAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const defaultSession = makeSession({ totalScore: 1000, completed: true });
const defaultOnPlayAgain = vi.fn();
const defaultOnShowLeaderboard = vi.fn();

describe("ResultPage — extended breakdown coverage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ rates: {} })));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ── OddOneOutBreakdown ───────────────────────────────────────────────────

  describe("OddOneOutBreakdown (gameMode='odd-one-out')", () => {
    const oddOneOutResults = [
      {
        correct: true,
        score: 500,
        outlierProductId: 1,
        guessedProductId: 1,
        products: [
          {
            id: 1,
            title: "Outlier Item",
            imageUrl: "a.jpg",
            description: "",
            category: "X",
            priceCents: 5000,
            amazonUrl: "http://amz.com/a",
          },
          {
            id: 2,
            title: "Normal B",
            imageUrl: "b.jpg",
            description: "",
            category: "X",
            priceCents: 2000,
          },
          {
            id: 3,
            title: "Normal C",
            imageUrl: "c.jpg",
            description: "",
            category: "X",
            priceCents: 2100,
          },
          {
            id: 4,
            title: "Normal D",
            imageUrl: "d.jpg",
            description: "",
            category: "X",
            priceCents: 1900,
          },
        ],
      },
    ];

    it("renders 'Odd One Out' mode label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={oddOneOutResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Odd One Out")).toBeInTheDocument();
    });

    it("renders all product titles in the breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={oddOneOutResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Outlier Item")).toBeInTheDocument();
      expect(screen.getByText("Normal B")).toBeInTheDocument();
      expect(screen.getByText("Normal C")).toBeInTheDocument();
      expect(screen.getByText("Normal D")).toBeInTheDocument();
    });

    it("shows 'Correct' outcome when guess is right", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={oddOneOutResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Correct")).toBeInTheDocument();
    });

    it("shows 'Wrong' outcome when guess is incorrect", () => {
      const wrongResults = [
        {
          ...oddOneOutResults[0],
          correct: false,
          guessedProductId: 2,
          score: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={wrongResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Wrong")).toBeInTheDocument();
    });

    it("shows the Outlier stat label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={oddOneOutResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Outlier")).toBeInTheDocument();
    });

    it("shows Points stat", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={oddOneOutResults}
          gameMode="odd-one-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("500")).toBeInTheDocument();
    });
  });

  // ── MarketBasketBreakdown ────────────────────────────────────────────────

  describe("MarketBasketBreakdown (gameMode='market-basket')", () => {
    const marketBasketResults = [
      {
        score: 600,
        pctOff: 5,
        actualTotalCents: 10000,
        guessedTotalCents: 10500,
        products: [
          {
            id: 1,
            title: "Basket Item 1",
            imageUrl: "p1.jpg",
            description: "",
            category: "X",
            priceCents: 5000,
          },
          {
            id: 2,
            title: "Basket Item 2",
            imageUrl: "p2.jpg",
            description: "",
            category: "X",
            priceCents: 5000,
          },
        ],
      },
    ];

    it("renders 'Market Basket' mode label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Market Basket")).toBeInTheDocument();
    });

    it("renders product titles in breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Basket Item 1")).toBeInTheDocument();
      expect(screen.getByText("Basket Item 2")).toBeInTheDocument();
    });

    it("shows Total and Guess stat labels", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Total")).toBeInTheDocument();
      expect(screen.getByText("Guess")).toBeInTheDocument();
    });

    it("shows the formatted total price", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      // actualTotalCents = 10000 -> $100.00
      expect(screen.getByText("$100.00")).toBeInTheDocument();
    });

    it("shows the formatted guessed total price", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      // guessedTotalCents = 10500 -> $105.00
      expect(screen.getByText("$105.00")).toBeInTheDocument();
    });

    it("shows score points", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={marketBasketResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("600")).toBeInTheDocument();
    });

    it("handles row-ok branch when score > 0 but < 500", () => {
      const okResults = [
        {
          ...marketBasketResults[0],
          score: 200,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={okResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("200")).toBeInTheDocument();
    });

    it("handles row-miss branch when score is 0", () => {
      const missResults = [
        {
          ...marketBasketResults[0],
          score: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={missResults}
          gameMode="market-basket"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("0")).toBeInTheDocument();
    });
  });

  // ── SortItOutBreakdown ───────────────────────────────────────────────────

  describe("SortItOutBreakdown (gameMode='sort-it-out')", () => {
    const sortResults = [
      {
        score: 700,
        correctCount: 3,
        correctOrder: [1, 2, 3],
        submittedOrder: [1, 3, 2],
        products: [
          {
            id: 1,
            title: "Sort Item 1",
            imageUrl: "s1.jpg",
            description: "",
            category: "X",
            priceCents: 1000,
          },
          {
            id: 2,
            title: "Sort Item 2",
            imageUrl: "s2.jpg",
            description: "",
            category: "X",
            priceCents: 2000,
          },
          {
            id: 3,
            title: "Sort Item 3",
            imageUrl: "s3.jpg",
            description: "",
            category: "X",
            priceCents: 3000,
          },
        ],
      },
    ];

    it("renders 'Sort It Out' mode label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={sortResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Sort It Out")).toBeInTheDocument();
    });

    it("renders all product titles in breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={sortResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Sort Item 1")).toBeInTheDocument();
      expect(screen.getByText("Sort Item 2")).toBeInTheDocument();
      expect(screen.getByText("Sort Item 3")).toBeInTheDocument();
    });

    it("shows Correct count out of total", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={sortResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
    });

    it("shows Points stat", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={sortResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("700")).toBeInTheDocument();
    });

    it("applies row-miss class when correctCount is 0 (miss branch)", () => {
      const missResults = [
        {
          ...sortResults[0],
          score: 0,
          correctCount: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={missResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("0 / 3")).toBeInTheDocument();
    });

    it("applies row-ok class when some correct but not all (row-ok branch)", () => {
      const partialResults = [
        {
          ...sortResults[0],
          correctCount: 1,
          score: 200,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={partialResults}
          gameMode="sort-it-out"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });
  });

  // ── BudgetBuilderBreakdown ───────────────────────────────────────────────

  describe("BudgetBuilderBreakdown (gameMode='budget-builder')", () => {
    const budgetResults = [
      {
        score: 500,
        budgetCents: 5000,
        cartTotalCents: 4800,
        selectedProductIds: [1, 2],
        products: [
          {
            id: 1,
            title: "Budget Item 1",
            imageUrl: "b1.jpg",
            description: "",
            category: "X",
            priceCents: 2500,
          },
          {
            id: 2,
            title: "Budget Item 2",
            imageUrl: "b2.jpg",
            description: "",
            category: "X",
            priceCents: 2300,
          },
        ],
      },
    ];

    it("renders 'Budget Builder' mode label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={budgetResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Budget Builder")).toBeInTheDocument();
    });

    it("shows per-round Budget stat label with formatted budget", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={budgetResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      // Per-round label includes the round number so a multi-round recap
      // is scannable without re-counting cards.
      expect(screen.getByText("Round 1 Budget")).toBeInTheDocument();
      expect(screen.getByText("$50.00")).toBeInTheDocument();
    });

    it("shows Cart Total stat label with formatted cart total", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={budgetResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      // Renamed from "Cart" → "Cart Total" in PR fixing the BB recap layout
      // so the stat reads on its own without context from a sibling label.
      expect(screen.getByText("Cart Total")).toBeInTheDocument();
      expect(screen.getByText("$48.00")).toBeInTheDocument();
    });

    it("shows 'Under' status when cartTotal is within budget", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={budgetResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Under")).toBeInTheDocument();
    });

    it("shows 'OVER' status when cartTotal exceeds budget", () => {
      const overResults = [
        {
          ...budgetResults[0],
          cartTotalCents: 6000, // over budget of 5000
          score: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={overResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("OVER")).toBeInTheDocument();
    });

    it("shows Points stat", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={budgetResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("500")).toBeInTheDocument();
    });

    it("shows row-ok branch when cartTotal within budget and score > 0 but < 500", () => {
      const okResults = [
        {
          ...budgetResults[0],
          cartTotalCents: 3000, // under budget of 5000
          score: 200,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={okResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      // Status should be Under since cartTotal <= budget
      expect(screen.getByText("Under")).toBeInTheDocument();
      expect(screen.getByText("200")).toBeInTheDocument();
    });

    it("shows row-miss branch when cartTotal within budget but score is 0", () => {
      const missResults = [
        {
          ...budgetResults[0],
          cartTotalCents: 4800,
          score: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={missResults}
          gameMode="budget-builder"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Under")).toBeInTheDocument();
      expect(screen.getByText("0")).toBeInTheDocument();
    });
  });

  // ── ChainReactionBreakdown ───────────────────────────────────────────────

  describe("ChainReactionBreakdown (gameMode='chain-reaction')", () => {
    const chainResults = [
      {
        score: 600,
        correctCount: 2,
        chainLength: 3,
        chainGuesses: ["more", "less", "more"] as ("more" | "less")[],
        products: [
          {
            id: 1,
            title: "Chain Product A",
            imageUrl: "c1.jpg",
            description: "",
            category: "X",
            priceCents: 1000,
          },
          {
            id: 2,
            title: "Chain Product B",
            imageUrl: "c2.jpg",
            description: "",
            category: "X",
            priceCents: 1500,
          },
          {
            id: 3,
            title: "Chain Product C",
            imageUrl: "c3.jpg",
            description: "",
            category: "X",
            priceCents: 2000,
          },
        ],
      },
    ];

    it("renders 'Chain Reaction' mode label", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={chainResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Chain Reaction")).toBeInTheDocument();
    });

    it("renders all product titles in breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={chainResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("Chain Product A")).toBeInTheDocument();
      expect(screen.getByText("Chain Product B")).toBeInTheDocument();
      expect(screen.getByText("Chain Product C")).toBeInTheDocument();
    });

    it("shows Correct count out of chainLength", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={chainResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });

    it("shows Points stat", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={chainResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("600")).toBeInTheDocument();
    });

    it("applies row-good class when all correct (correctCount === chainLength)", () => {
      const allCorrectResults = [
        {
          ...chainResults[0],
          correctCount: 3,
          chainLength: 3,
          score: 1000,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={allCorrectResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
    });

    it("applies row-miss class when correctCount is 0", () => {
      const zeroResults = [
        {
          ...chainResults[0],
          correctCount: 0,
          score: 0,
        },
      ];
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={zeroResults}
          gameMode="chain-reaction"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />
      );
      expect(screen.getByText("0 / 3")).toBeInTheDocument();
    });
  });

  // ── Leaderboard V2 behavior ────────────────────────────────────────────
  describe("Leaderboard V2 post-game section", () => {
    it("logged-in user does NOT see 'Save Your Score' heading", async () => {
      const { useUserAuth } = await import("../context/UserAuthContext");
      (useUserAuth as ReturnType<typeof vi.fn>).mockReturnValue({
        user: { id: "u1", username: "alice", lifetimeScore: 5000 },
      });

      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={[]}
          gameMode="classic"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />,
      );

      expect(screen.queryByText("Save Your Score")).not.toBeInTheDocument();

      // Reset mock for subsequent tests
      (useUserAuth as ReturnType<typeof vi.fn>).mockReturnValue({ user: null });
    });

    it("logged-out user sees sign-up prompt", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={[]}
          gameMode="classic"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
          onOpenAuth={vi.fn()}
        />,
      );

      expect(
        screen.getByText(/Claim your/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Create free account/i }),
      ).toBeInTheDocument();
    });

    it("logged-out user does NOT see name input", () => {
      renderWithAllProviders(
        <ResultPage
          session={defaultSession}
          roundResults={[]}
          gameMode="classic"
          onPlayAgain={defaultOnPlayAgain}
          onShowLeaderboard={defaultOnShowLeaderboard}
        />,
      );

      expect(
        screen.queryByPlaceholderText("Enter your name"),
      ).not.toBeInTheDocument();
    });
  });
});
