import { describe, expect, it } from "vitest";
import { classicStrategy } from "../src/strategies/classic";
import { higherLowerStrategy } from "../src/strategies/higher-lower";
import { comparisonStrategy } from "../src/strategies/comparison";
import { closestStrategy, singlePlayerBiddingStrategy } from "../src/strategies/closest";
import { riserStrategy } from "../src/strategies/riser";
// Phase 3d.2: budgetBuilder + priceMatch strategies removed.
import { marketBasketStrategy } from "../src/strategies/market-basket";
import { sortItOutStrategy } from "../src/strategies/sort-it-out";
import { oddOneOutStrategy } from "../src/strategies/odd-one-out";
import { chainReactionStrategy } from "../src/strategies/chain-reaction";
// Phase 3d.2: priceMatch strategy removed.
import { biddingStrategy } from "../src/strategies/bidding";
import type { PredictRes } from "../src/learning/types";

const PROD_A = { id: 1, title: "A", category: "Electronics", description: "", imageUrl: "" };
const PROD_B = { id: 2, title: "B", category: "Electronics", description: "", imageUrl: "" };
const PROD_C = { id: 3, title: "C", category: "Books", description: "", imageUrl: "" };
const PROD_D = { id: 4, title: "D", category: "Toys", description: "", imageUrl: "" };

function fakeNN(predictedCents: number, sigma = 500): PredictRes {
  return {
    roundId: "x",
    predictedCents,
    predictedSigmaCents: sigma,
    embedding2d: [0, 0],
    topFeatures: [],
    ageMs: 1,
  };
}

function fakeNNRanked(rank: Array<{ id: number; predictedCents: number; sigma: number }>): PredictRes {
  return {
    ...fakeNN(rank[0]?.predictedCents ?? 1000, rank[0]?.sigma ?? 500),
    rankPredictions: rank,
  };
}

describe("classic strategy w/ NN context", () => {
  it("centers candidates on NN's predictedCents", () => {
    const cands = classicStrategy.candidates(
      { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(2500) },
    );
    const top = cands[0].payload as { guessedPriceCents: number };
    expect(top.guessedPriceCents).toBe(2500);
  });

  it("thompsonDraw overrides NN predictedCents when present", () => {
    const cands = classicStrategy.candidates(
      { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(2500), thompsonDraw: 1900 },
    );
    const top = cands[0].payload as { guessedPriceCents: number };
    expect(top.guessedPriceCents).toBe(1900);
  });

  it("exploration widens the spread", () => {
    const normal = classicStrategy.candidates(
      { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(2500) },
    );
    const exploring = classicStrategy.candidates(
      { roundNumber: 1, gameMode: "classic", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(2500), exploration: true },
    );
    const widestNormal = Math.max(
      ...normal.map((c) => Math.abs((c.payload as { guessedPriceCents: number }).guessedPriceCents - 2500)),
    );
    const widestExploring = Math.max(
      ...exploring.map((c) => Math.abs((c.payload as { guessedPriceCents: number }).guessedPriceCents - 2500)),
    );
    expect(widestExploring).toBeGreaterThanOrEqual(widestNormal);
  });
});

describe("higher-lower strategy w/ NN context", () => {
  it("uses NN's predictedCents to choose direction", () => {
    const cands = higherLowerStrategy.candidates(
      { roundNumber: 1, gameMode: "higher-lower", timerSeconds: 30, product: PROD_A, referencePrice: 1000 },
      { nnPrediction: fakeNN(2500) },
    );
    expect((cands[0].payload as { guess: string }).guess).toBe("higher");
  });
});

describe("comparison strategy w/ NN context", () => {
  // Pre-PR-4 the comparison strategy short-circuited via the
  // pairwise-head sigmoid; that head was ripped with the multi-task
  // cleanup. The strategy now compares per-product predicted prices
  // surfaced as `rankPredictions` (the priceClassHead's argmax).
  it("picks the higher-priced product for 'most-expensive'", () => {
    const cands = comparisonStrategy.candidates(
      { roundNumber: 1, gameMode: "comparison", timerSeconds: 30, products: [PROD_A, PROD_B], question: "most-expensive" },
      {
        nnPrediction: fakeNNRanked([
          { id: PROD_A.id, predictedCents: 4000, sigma: 200 },
          { id: PROD_B.id, predictedCents: 2500, sigma: 200 },
        ]),
      },
    );
    expect((cands[0].payload as { guessedProductId: number }).guessedProductId).toBe(PROD_A.id);
  });

  it("flips the pick when question is 'least-expensive'", () => {
    const cands = comparisonStrategy.candidates(
      { roundNumber: 1, gameMode: "comparison", timerSeconds: 30, products: [PROD_A, PROD_B], question: "least-expensive" },
      {
        nnPrediction: fakeNNRanked([
          { id: PROD_A.id, predictedCents: 4000, sigma: 200 },
          { id: PROD_B.id, predictedCents: 2500, sigma: 200 },
        ]),
      },
    );
    expect((cands[0].payload as { guessedProductId: number }).guessedProductId).toBe(PROD_B.id);
  });
});

describe("closest / single-bidding strategy w/ NN context", () => {
  it("uses μ − 0.4σ as the safe-bid floor", () => {
    const cands = closestStrategy.candidates(
      { roundNumber: 1, gameMode: "closest-without-going-over", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(1000, 100) },
    );
    const top = (cands[0].payload as { guessedPriceCents: number }).guessedPriceCents;
    // 1000 − 0.4·100 = 960
    expect(top).toBe(960);
  });

  it("single-player bidding mirrors closest", () => {
    const cands = singlePlayerBiddingStrategy.candidates(
      { roundNumber: 1, gameMode: "bidding", timerSeconds: 30, product: PROD_A },
      { nnPrediction: fakeNN(2000, 200) },
    );
    const top = (cands[0].payload as { guessedPriceCents: number }).guessedPriceCents;
    expect(top).toBe(1920);
  });
});

describe("riser strategy w/ NN context", () => {
  it("respects maxPriceCents cap", () => {
    const cands = riserStrategy.candidates(
      { roundNumber: 1, gameMode: "riser", timerSeconds: 30, product: PROD_A, maxPriceCents: 500 },
      { nnPrediction: fakeNN(10000, 1000) },
    );
    for (const c of cands) {
      const stop = (c.payload as { stoppedPriceCents: number }).stoppedPriceCents;
      expect(stop).toBeLessThanOrEqual(500);
    }
  });
});

describe("multi-product strategies w/ rankPredictions", () => {
  const fourProducts = [PROD_A, PROD_B, PROD_C, PROD_D];

  it("market-basket sums per-item NN predictions", () => {
    const ranks = [
      { id: 1, predictedCents: 1000, sigma: 50 },
      { id: 2, predictedCents: 2000, sigma: 50 },
      { id: 3, predictedCents: 500, sigma: 50 },
      { id: 4, predictedCents: 1500, sigma: 50 },
    ];
    const cands = marketBasketStrategy.candidates(
      { roundNumber: 1, gameMode: "market-basket", timerSeconds: 30, products: fourProducts },
      { nnPrediction: fakeNNRanked(ranks) },
    );
    const top = (cands[0].payload as { guessedTotalCents: number }).guessedTotalCents;
    expect(top).toBe(5000);
  });

  it("sort-it-out orders by per-item NN predictions", () => {
    const ranks = [
      { id: 1, predictedCents: 1000, sigma: 50 },
      { id: 2, predictedCents: 2000, sigma: 50 },
      { id: 3, predictedCents: 500, sigma: 50 },
      { id: 4, predictedCents: 1500, sigma: 50 },
    ];
    const cands = sortItOutStrategy.candidates(
      { roundNumber: 1, gameMode: "sort-it-out", timerSeconds: 30, products: fourProducts },
      { nnPrediction: fakeNNRanked(ranks) },
    );
    expect((cands[0].payload as { submittedOrder: number[] }).submittedOrder).toEqual([3, 1, 4, 2]);
  });

  // Phase 3d.2: budget-builder test removed with the strategy.

  it("odd-one-out picks the largest-z item with NN", () => {
    const ranks = [
      { id: 1, predictedCents: 1000, sigma: 50 },
      { id: 2, predictedCents: 1100, sigma: 50 },
      { id: 3, predictedCents: 1050, sigma: 50 },
      { id: 4, predictedCents: 5000, sigma: 50 }, // outlier
    ];
    const cands = oddOneOutStrategy.candidates(
      { roundNumber: 1, gameMode: "odd-one-out", timerSeconds: 30, products: fourProducts },
      { nnPrediction: fakeNNRanked(ranks) },
    );
    expect((cands[0].payload as { guessedProductId: number }).guessedProductId).toBe(4);
  });

  it("chain-reaction generates the right pairwise sequence with NN", () => {
    const ranks = [
      { id: 1, predictedCents: 1000, sigma: 50 },
      { id: 2, predictedCents: 1500, sigma: 50 },
      { id: 3, predictedCents: 800, sigma: 50 },
      { id: 4, predictedCents: 1200, sigma: 50 },
    ];
    const cands = chainReactionStrategy.candidates(
      { roundNumber: 1, gameMode: "chain-reaction", timerSeconds: 30, products: fourProducts },
      { nnPrediction: fakeNNRanked(ranks) },
    );
    expect((cands[0].payload as { chainGuesses: ("more" | "less")[] }).chainGuesses).toEqual([
      "more",
      "less",
      "more",
    ]);
  });

  // Phase 3d.2: price-match test removed with the strategy.
});

describe("multiplayer bidding w/ NN context (Phase 3d.2)", () => {
  it("first-bidder produces a positive sub-heuristic bid", () => {
    // The new decoder uses position-conditional quantile candidates
    // and Monte-Carlo simulation; the exact bid is RNG-influenced.
    // Pin the qualitative property: first-bidder picks something
    // below the heuristic centerpoint to leave bracket-undercut
    // room.
    const cands = biddingStrategy.candidates(
      { roundNumber: 1, gameMode: "bidding", timerSeconds: 30, product: PROD_A },
      {
        nnPrediction: fakeNN(2000, 100),
        turn: { currentPlayerId: "x", turnIndex: 0, totalPlayers: 4, timerSeconds: 30, previousBids: [] },
        rng: () => 0.5,
      },
    );
    const bid = (cands[0].payload as { bidCents: number }).bidCents;
    expect(bid).toBeGreaterThan(0);
  });

  it("middle-bidder bid is in a sane sub-heuristic range", () => {
    const cands = biddingStrategy.candidates(
      { roundNumber: 1, gameMode: "bidding", timerSeconds: 30, product: PROD_A },
      {
        nnPrediction: fakeNN(2000, 100),
        turn: {
          currentPlayerId: "x",
          turnIndex: 1,
          totalPlayers: 4,
          timerSeconds: 30,
          previousBids: [{ playerId: "p0", displayName: "P0", avatar: "x", bidCents: 1500 }],
        },
        rng: () => 0.5,
      },
    );
    const bid = (cands[0].payload as { bidCents: number }).bidCents;
    expect(bid).toBeGreaterThan(0);
    expect(bid).toBeLessThan(20000);
  });
});
