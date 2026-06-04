import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import ResultPage, { getResultHeadline } from "../pages/ResultPage";
import * as api from "../api/client";
import { renderWithAllProviders, makeSession, makeProductWithPrice, makeUser } from "./testUtils";
import type { RoundResult } from "@price-game/shared";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);

function makeRoundResult(overrides: Partial<RoundResult> = {}): RoundResult {
  return {
    product: makeProductWithPrice(),
    guessedPriceCents: 2200,
    score: 500,
    pctOff: 0.1,
    ...overrides,
  };
}

describe("getResultHeadline", () => {
  const MAX = 10_000;
  it.each([
    [MAX, "Masterful!"],
    [9000, "Masterful!"],
    [8999, "Great game!"],
    [7000, "Great game!"],
    [6999, "Nice work!"],
    [5000, "Nice work!"],
    [4999, "Not bad!"],
    [2500, "Not bad!"],
    [2499, "Tough round!"],
    [1, "Tough round!"],
    [0, "Game Over!"],
  ])("score %i of %i → %s", (score, expected) => {
    expect(getResultHeadline(score, MAX)).toBe(expected);
  });

  it("returns 'Game Over!' when max score is zero (e.g. empty session)", () => {
    expect(getResultHeadline(0, 0)).toBe("Game Over!");
    expect(getResultHeadline(500, 0)).toBe("Game Over!");
  });

  it("returns 'Game Over!' on negative totals", () => {
    expect(getResultHeadline(-1, MAX)).toBe("Game Over!");
  });
});

describe("ResultPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockGetMe.mockRejectedValue(new Error("401"));
    // ShareModal POSTs to /api/share on open — default to a resolving stub so
    // tests don't crash on `undefined.then(...)`. Individual tests can override.
    mockedApi.createShare.mockResolvedValue({ id: "mocksha1", url: "/s/mocksha1" });
    // getUserRank is called in a useEffect when user is logged in
    mockedApi.getUserRank.mockResolvedValue({ rank: 1, totalPlayers: 10 });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession({ totalScore: 5000, completed: true }),
    roundResults: [makeRoundResult()],
    gameMode: "classic" as const,
    onPlayAgain: vi.fn(),
    onShowLeaderboard: vi.fn(),
  };

  it("displays a score-tier headline and final score", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    // 5000 / (1000 * 10) = 0.5 → "Nice work!"
    expect(screen.getByText("Nice work!")).toBeInTheDocument();
    expect(screen.getByText("5000")).toBeInTheDocument();
  });

  it("falls back to 'Game Over!' when the player scores zero", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        session={makeSession({ totalScore: 0, completed: true })}
      />,
    );
    expect(screen.getByText("Game Over!")).toBeInTheDocument();
  });

  it("shows an encouraging headline near the score ceiling", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        session={makeSession({ totalScore: 9500, completed: true })}
      />,
    );
    // 9500 / 10000 = 0.95 → "Masterful!"
    expect(screen.getByText("Masterful!")).toBeInTheDocument();
  });

  it("shows the game mode label", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    expect(screen.getByText("Precision")).toBeInTheDocument();
  });

  it("calls onPlayAgain when Play Again is clicked", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    const buttons = screen.getAllByRole("button", { name: "Play Again" });
    fireEvent.click(buttons[0]);
    expect(defaultProps.onPlayAgain).toHaveBeenCalledOnce();
  });

  it("shows round breakdown with actual and guessed prices", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    expect(screen.getByText("Round-by-Round Breakdown")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("$22.00")).toBeInTheDocument();
  });

  it("logged-out user sees sign-up prompt instead of save form", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} onOpenAuth={vi.fn()} />);
    expect(screen.getByText(/Claim your/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create free account/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Enter your name")).not.toBeInTheDocument();
  });

  it("logged-out user sees signup CTA above the round breakdown", () => {
    const { container } = renderWithAllProviders(
      <ResultPage {...defaultProps} onOpenAuth={vi.fn()} />,
    );
    const cta = container.querySelector(".signup-claim-cta");
    const breakdown = container.querySelector(".breakdown");
    expect(cta).not.toBeNull();
    expect(breakdown).not.toBeNull();
    // compareDocumentPosition returns DOCUMENT_POSITION_FOLLOWING (4) when the
    // argument appears AFTER the reference node in document order.
    expect(cta!.compareDocumentPosition(breakdown!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("logged-out user sees exactly one signup CTA", () => {
    const { container } = renderWithAllProviders(
      <ResultPage {...defaultProps} onOpenAuth={vi.fn()} />,
    );
    expect(container.querySelectorAll(".signup-claim-cta")).toHaveLength(1);
  });

  it("logged-out user does not see a View Leaderboard button in the signup CTA", () => {
    // The signup CTA intentionally focuses on the single conversion action
    // (create account) — the old "View Leaderboard" link inside the CTA
    // distracted from signup and has been removed.
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    expect(screen.queryByText("View Leaderboard")).not.toBeInTheDocument();
  });

  it("shows optional Change Game Mode button", () => {
    const onBackToModes = vi.fn();
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        onBackToModes={onBackToModes}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Change Game Mode" }));
    expect(onBackToModes).toHaveBeenCalledOnce();
  });

  it("shows higher-lower breakdown for that mode", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="higher-lower"
        roundResults={[
          {
            product: makeProductWithPrice({ priceCents: 3000 }),
            referencePrice: 2500,
            guess: "higher" as const,
            correct: true,
            score: 800,
          },
        ]}
      />
    );
    expect(screen.getByText("Higher or Lower")).toBeInTheDocument();
    expect(screen.getByText("Higher")).toBeInTheDocument();
  });

  it("shows comparison breakdown for that mode", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="comparison"
        roundResults={[
          {
            products: [
              makeProductWithPrice({ id: 1, title: "Item A", priceCents: 5000 }),
              makeProductWithPrice({ id: 2, title: "Item B", priceCents: 3000 }),
            ],
            question: "most-expensive" as const,
            chosenProductId: 1,
            correct: true,
            score: 1000,
          },
        ]}
      />
    );
    expect(screen.getByText("Comparison")).toBeInTheDocument();
    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText("Item B")).toBeInTheDocument();
    expect(screen.getByText("Correct")).toBeInTheDocument();
    expect(screen.getByText("More $")).toBeInTheDocument();
  });

  it("shows comparison breakdown with least-expensive question", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="comparison"
        roundResults={[
          {
            products: [
              makeProductWithPrice({ id: 1, title: "Cheap", priceCents: 1000 }),
              makeProductWithPrice({ id: 2, title: "Expensive", priceCents: 5000 }),
            ],
            question: "least-expensive" as const,
            chosenProductId: 2,
            correct: false,
            score: 0,
          },
        ]}
      />
    );
    expect(screen.getByText("Less $")).toBeInTheDocument();
    expect(screen.getByText("Wrong")).toBeInTheDocument();
  });

  it("shows closest breakdown for that mode", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="closest-without-going-over"
        roundResults={[
          {
            product: makeProductWithPrice({ priceCents: 2000 }),
            guessedPriceCents: 1900,
            wentOver: false,
            score: 900,
          },
        ]}
      />
    );
    expect(screen.getByText("Underbid")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("900")).toBeInTheDocument();
  });

  it("shows closest breakdown with went-over result", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="closest-without-going-over"
        roundResults={[
          {
            product: makeProductWithPrice({ priceCents: 2000 }),
            guessedPriceCents: 2100,
            wentOver: true,
            score: 0,
          },
        ]}
      />
    );
    expect(screen.getByText("OVER")).toBeInTheDocument();
  });

  it("shows price-match breakdown for that mode", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="price-match"
        roundResults={[
          {
            products: [
              makeProductWithPrice({ id: 1, title: "Match A", priceCents: 1000 }),
              makeProductWithPrice({ id: 2, title: "Match B", priceCents: 2000 }),
            ],
            correctCount: 2,
            score: 1000,
          },
        ]}
      />
    );
    expect(screen.getByText("Price Match")).toBeInTheDocument();
    expect(screen.getByText("Match A")).toBeInTheDocument();
    expect(screen.getByText("Match B")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("shows riser breakdown for that mode", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="riser"
        roundResults={[
          {
            product: makeProductWithPrice({ priceCents: 3000 }),
            stoppedPriceCents: 2800,
            wentOver: false,
            score: 800,
          },
        ]}
      />
    );
    expect(screen.getByText("Riser")).toBeInTheDocument();
    expect(screen.getByText("$28.00")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("shows riser breakdown with went-over result", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        gameMode="riser"
        roundResults={[
          {
            product: makeProductWithPrice({ priceCents: 3000 }),
            stoppedPriceCents: 3200,
            wentOver: true,
            score: 0,
          },
        ]}
      />
    );
    expect(screen.getByText("OVER")).toBeInTheDocument();
  });

  it("logged-out user sign-up button triggers onOpenAuth", () => {
    const onOpenAuth = vi.fn();
    renderWithAllProviders(<ResultPage {...defaultProps} onOpenAuth={onOpenAuth} />);
    fireEvent.click(screen.getByRole("button", { name: /Create free account/i }));
    expect(onOpenAuth).toHaveBeenCalledOnce();
  });

  it("claim CTA headline names the user's score when > 0", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        session={makeSession({ totalScore: 4321, completed: true })}
        onOpenAuth={vi.fn()}
      />,
    );
    // Score is rendered inside the headline's highlighted span and formatted
    // with a thousands separator via toLocaleString().
    expect(screen.getByText("4,321")).toBeInTheDocument();
  });

  it("claim CTA falls back to neutral copy when score is zero", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        session={makeSession({ totalScore: 0, completed: true })}
        onOpenAuth={vi.fn()}
      />,
    );
    expect(screen.getByText(/Save this game to your account/i)).toBeInTheDocument();
  });

  it("shows Amazon link when product has amazonUrl", () => {
    renderWithAllProviders(
      <ResultPage
        {...defaultProps}
        roundResults={[
          makeRoundResult({
            product: makeProductWithPrice({ amazonUrl: "https://amazon.com/dp/123" }),
          }),
        ]}
      />
    );
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link).toHaveAttribute("href", "https://amazon.com/dp/123");
    expect(link).toHaveAttribute("target", "_blank");
  });

  // ---------------------------------------------------------------------------
  // Amazon CTA parity — every SP mode breakdown should expose the affiliate
  // link when the round's product carries an `amazonUrl`. This guards against
  // the regression where the link was wired only into Bidding / Riser /
  // Higher-Lower / Closest after the original CTA rollout (PR #161).
  // ---------------------------------------------------------------------------

  describe("AmazonCTA in mode breakdowns", () => {
    const AMZN = "https://amazon.com/dp/PARITY";

    it("renders an Amazon CTA in the odd-one-out breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="odd-one-out"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "Outlier Item", priceCents: 9000, amazonUrl: AMZN }),
                makeProductWithPrice({ id: 2, title: "Cluster A", priceCents: 1000 }),
                makeProductWithPrice({ id: 3, title: "Cluster B", priceCents: 1100 }),
              ],
              outlierProductId: 1,
              guessedProductId: 1,
              correct: true,
              score: 1000,
            },
          ]}
        />
      );
      const link = screen.getByRole("link", { name: /see it on amazon.*outlier item/i });
      expect(link).toHaveAttribute("href", AMZN);
    });

    it("renders an Amazon CTA in the market-basket breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="market-basket"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "Basket Item One", priceCents: 1500, amazonUrl: AMZN }),
                makeProductWithPrice({ id: 2, title: "Basket Item Two", priceCents: 2500 }),
              ],
              guessedTotalCents: 3800,
              actualTotalCents: 4000,
              pctOff: 0.05,
              score: 750,
            },
          ]}
        />
      );
      const link = screen.getByRole("link", { name: /see it on amazon.*basket item one/i });
      expect(link).toHaveAttribute("href", AMZN);
    });

    it("renders an Amazon CTA in the sort-it-out breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="sort-it-out"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "Sort Cheapest", priceCents: 1000, amazonUrl: AMZN }),
                makeProductWithPrice({ id: 2, title: "Sort Mid", priceCents: 2000 }),
                makeProductWithPrice({ id: 3, title: "Sort Pricey", priceCents: 3000 }),
              ],
              submittedOrder: [1, 2, 3],
              correctOrder: [1, 2, 3],
              correctCount: 3,
              score: 1000,
            },
          ]}
        />
      );
      const link = screen.getByRole("link", { name: /see it on amazon.*sort cheapest/i });
      expect(link).toHaveAttribute("href", AMZN);
    });

    it("renders an Amazon CTA in the chain-reaction breakdown", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="chain-reaction"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "Chain Anchor", priceCents: 2000, amazonUrl: AMZN }),
                makeProductWithPrice({ id: 2, title: "Chain Two", priceCents: 2500 }),
                makeProductWithPrice({ id: 3, title: "Chain Three", priceCents: 3000 }),
              ],
              chainGuesses: ["more", "more"],
              correctCount: 2,
              chainLength: 2,
              score: 1000,
            },
          ]}
        />
      );
      const link = screen.getByRole("link", { name: /see it on amazon.*chain anchor/i });
      expect(link).toHaveAttribute("href", AMZN);
    });

    it("renders an Amazon CTA in the budget-builder breakdown for selected products", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="budget-builder"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "BB Selected", priceCents: 1500, amazonUrl: AMZN }),
                makeProductWithPrice({ id: 2, title: "BB Skipped", priceCents: 2500 }),
                makeProductWithPrice({ id: 3, title: "BB Other", priceCents: 1000 }),
              ],
              selectedProductIds: [1],
              budgetCents: 2000,
              cartTotalCents: 1500,
              score: 800,
            },
          ]}
        />
      );
      const link = screen.getByRole("link", { name: /see it on amazon.*bb selected/i });
      expect(link).toHaveAttribute("href", AMZN);
    });

    it("budget-builder breakdown only renders the products the player put in the cart", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="budget-builder"
          roundResults={[
            {
              products: [
                makeProductWithPrice({ id: 1, title: "BB In Cart" }),
                makeProductWithPrice({ id: 2, title: "BB Not Picked" }),
              ],
              selectedProductIds: [1],
              budgetCents: 2000,
              cartTotalCents: 2000,
              score: 1000,
            },
          ]}
        />
      );
      expect(screen.getByText("BB In Cart")).toBeInTheDocument();
      expect(screen.queryByText("BB Not Picked")).not.toBeInTheDocument();
    });

    it("budget-builder breakdown surfaces budget, cart total, status and points per round", () => {
      renderWithAllProviders(
        <ResultPage
          {...defaultProps}
          gameMode="budget-builder"
          roundResults={[
            {
              products: [makeProductWithPrice({ id: 1, title: "BB Item" })],
              selectedProductIds: [1],
              budgetCents: 5000,
              cartTotalCents: 6000, // over budget on purpose
              score: 0,
            },
          ]}
        />
      );
      // Per-round budget label includes the round number for at-a-glance scanning.
      expect(screen.getByText("Round 1 Budget")).toBeInTheDocument();
      expect(screen.getByText("Cart Total")).toBeInTheDocument();
      // Status reflects over-budget runs.
      expect(screen.getByText("OVER")).toBeInTheDocument();
      // The cart total ($60.00) and the budget ($50.00) both appear so the
      // delta is human-verifiable without doing math in your head.
      expect(screen.getByText("$60.00")).toBeInTheDocument();
      expect(screen.getByText("$50.00")).toBeInTheDocument();
    });
  });

  it("logged-in user sees rank display instead of save form", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser({ username: "alice" }) });
    mockedApi.getUserRank.mockResolvedValue({ rank: 3, totalPlayers: 50 });
    renderWithAllProviders(<ResultPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/ranked/)).toBeInTheDocument();
    });
    expect(screen.getByText("#3")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Enter your name")).not.toBeInTheDocument();
    expect(screen.queryByText(/Save to Leaderboard/)).not.toBeInTheDocument();
  });

  it("logged-out user does not see rank display", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    expect(screen.queryByText(/ranked/)).not.toBeInTheDocument();
  });

  it("personalizes the headline with the player's name when signed in", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser({ username: "marcus" }) });
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    // 5000/10000 = 0.5 → "Nice work!" → "Nice work, marcus!" after
    // stripping the trailing "!" and appending the name-suffix.
    await waitFor(() => {
      expect(screen.getByText("Nice work, marcus!")).toBeInTheDocument();
    });
    // The un-personalized form should no longer be present on screen.
    expect(screen.queryByText("Nice work!")).not.toBeInTheDocument();
  });

  it("keeps the neutral headline for anonymous players (no invented name)", () => {
    renderWithAllProviders(<ResultPage {...defaultProps} />);
    expect(screen.getByText("Nice work!")).toBeInTheDocument();
    expect(screen.queryByText(/Nice work,/)).not.toBeInTheDocument();
  });

  describe("Share Results button", () => {
    it("renders a Share Results button", () => {
      renderWithAllProviders(<ResultPage {...defaultProps} />);
      expect(screen.getByText("Share Results")).toBeInTheDocument();
    });

    it("opens the ShareModal when clicked", () => {
      renderWithAllProviders(<ResultPage {...defaultProps} />);
      fireEvent.click(screen.getByText("Share Results"));
      expect(screen.getByRole("dialog", { name: "Share your results" })).toBeInTheDocument();
    });

    it("passes the current session's scores into the share grid", () => {
      const props = {
        ...defaultProps,
        session: makeSession({ totalScore: 7500, completed: true }),
        roundResults: [
          makeRoundResult({ score: 1000 }),
          makeRoundResult({ score: 1000 }),
          makeRoundResult({ score: 750 }),
          makeRoundResult({ score: 1000 }),
          makeRoundResult({ score: 0 }),
          makeRoundResult({ score: 500 }),
          makeRoundResult({ score: 1000 }),
          makeRoundResult({ score: 1000 }),
          makeRoundResult({ score: 300 }),
          makeRoundResult({ score: 950 }),
        ],
      };
      renderWithAllProviders(<ResultPage {...props} />);
      fireEvent.click(screen.getByText("Share Results"));
      expect(
        screen.getByText(/Price Games \| Precision \| 7,500\/10,000/)
      ).toBeInTheDocument();
    });
  });
});
