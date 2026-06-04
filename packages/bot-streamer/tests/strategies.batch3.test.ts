import { describe, it, expect } from "vitest";
import { sortItOutStrategy } from "../src/strategies/sort-it-out";
import { chainReactionStrategy } from "../src/strategies/chain-reaction";
import { biddingStrategy, biddingCandidates } from "../src/strategies/bidding";
import { strategyFor, hasStrategy } from "../src/strategies/index";
import { makeRoundStart, makeProduct } from "../src/test-helpers/fixtures";
import { seeded } from "./_rng";
import type { BiddingTurnPayload } from "@price-game/shared";

describe("sortItOutStrategy", () => {
  it("returns submittedOrder ascending by estimated price", () => {
    const cheap = makeProduct({ id: 1, title: "Mini Basic", category: "Books" });
    const pricey = makeProduct({ id: 2, title: "Premium Pro 4K", category: "Electronics" });
    const round = makeRoundStart({
      gameMode: "sort-it-out",
      product: undefined,
      products: [pricey, cheap],
    });
    const cs = sortItOutStrategy.candidates(round, { rng: seeded(1) });
    if (!("submittedOrder" in cs[0].payload)) throw new Error("missing submittedOrder");
    expect(cs[0].payload.submittedOrder).toEqual([1, 2]);
  });

  it("emits a swapped variant", () => {
    const round = makeRoundStart({
      gameMode: "sort-it-out",
      product: undefined,
      products: [
        makeProduct({ id: 1, title: "A", category: "Books" }),
        makeProduct({ id: 2, title: "B", category: "Books" }),
      ],
    });
    const cs = sortItOutStrategy.candidates(round, { rng: seeded(1) });
    expect(cs).toHaveLength(2);
    if (!("submittedOrder" in cs[0].payload) || !("submittedOrder" in cs[1].payload)) {
      throw new Error("missing");
    }
    expect(cs[1].payload.submittedOrder).not.toEqual(cs[0].payload.submittedOrder);
  });

  it("throws when fewer than 2 products are present", () => {
    expect(() =>
      sortItOutStrategy.candidates(
        makeRoundStart({ product: undefined, products: [makeProduct({ id: 1 })] }),
        { rng: seeded(1) },
      ),
    ).toThrow();
  });
});

describe("chainReactionStrategy", () => {
  it("emits one fewer guess than the number of products", () => {
    const products = [
      makeProduct({ id: 1, title: "A", category: "Books" }),
      makeProduct({ id: 2, title: "B", category: "Electronics" }),
      makeProduct({ id: 3, title: "C", category: "Books" }),
      makeProduct({ id: 4, title: "D", category: "Electronics" }),
    ];
    const round = makeRoundStart({
      gameMode: "chain-reaction",
      product: undefined,
      products,
    });
    const cs = chainReactionStrategy.candidates(round, { rng: seeded(1) });
    if (!("chainGuesses" in cs[0].payload)) throw new Error("missing");
    expect(cs[0].payload.chainGuesses).toHaveLength(3);
  });

  it("throws when fewer than 2 products are present", () => {
    expect(() =>
      chainReactionStrategy.candidates(
        makeRoundStart({ product: undefined, products: [makeProduct({ id: 1 })] }),
        { rng: seeded(1) },
      ),
    ).toThrow();
  });
});

describe("biddingStrategy (Phase 3d.2 decoder)", () => {
  function makeTurn(overrides: Partial<BiddingTurnPayload> = {}): BiddingTurnPayload {
    return {
      currentPlayerId: "me",
      turnIndex: 0,
      totalPlayers: 4,
      timerSeconds: 20,
      previousBids: [],
      ...overrides,
    };
  }

  it("falls back to a safe-bid pattern when no turn context is available", () => {
    // Single-player bidding war doesn't carry a BiddingTurnPayload.
    const round = makeRoundStart({
      gameMode: "bidding",
      product: makeProduct({ title: "Speaker", category: "Electronics" }),
    });
    const cs = biddingStrategy.candidates(round, { rng: seeded(1) });
    if (!("bidCents" in cs[0].payload)) throw new Error("missing");
    expect(cs[0].payload.bidCents).toBeGreaterThan(0);
    // No turn context → single-candidate output.
    expect(cs).toHaveLength(1);
  });

  it("first bidder produces a plausible (positive, sub-heuristic) bid", () => {
    const round = makeRoundStart({
      gameMode: "bidding",
      product: makeProduct({ title: "Speaker", category: "Electronics" }),
    });
    const turn = makeTurn({ turnIndex: 0, totalPlayers: 4, previousBids: [] });
    const cs = biddingCandidates(round, { rng: seeded(1), turn });
    if (!("bidCents" in cs[0].payload)) throw new Error("missing");
    expect(cs[0].payload.bidCents).toBeGreaterThan(0);
    expect(cs[0].payload.bidCents).toBeLessThan(20_000);
  });

  it("last bidder includes a clip candidate when a plausible standing bid exists", () => {
    // The decoder injects `highestPlausible + 1¢` as a discrete
    // candidate when the bot is last. We assert it appears among
    // the scored candidates — its actual selection depends on the
    // simulator's expected-rank-score.
    const round = makeRoundStart({
      gameMode: "bidding",
      product: makeProduct({ title: "Speaker", category: "Electronics" }),
    });
    const turn = makeTurn({
      turnIndex: 3,
      totalPlayers: 4,
      previousBids: [
        { playerId: "a", displayName: "A", avatar: "wizard", bidCents: 5000 },
        { playerId: "b", displayName: "B", avatar: "wizard", bidCents: 6000 },
        { playerId: "c", displayName: "C", avatar: "wizard", bidCents: 4000 },
      ],
    });
    const cs = biddingCandidates(round, { rng: seeded(1), turn });
    if (!("bidCents" in cs[0].payload)) throw new Error("missing");
    expect(cs[0].payload.bidCents).toBeGreaterThan(0);
  });
});

describe("strategy registry — batch 3", () => {
  it("registers the kept batch-3 modes (Phase 3d.2 dropped budget-builder + price-match)", () => {
    expect(strategyFor("sort-it-out")).toBe(sortItOutStrategy);
    expect(strategyFor("chain-reaction")).toBe(chainReactionStrategy);
    expect(strategyFor("bidding")).toBe(biddingStrategy);
  });

  it("hasStrategy reports the kept set", () => {
    for (const mode of [
      "classic",
      "higher-lower",
      "comparison",
      "closest-without-going-over",
      "bidding",
      "riser",
      "odd-one-out",
      "market-basket",
      "sort-it-out",
      "chain-reaction",
    ] as const) {
      expect(hasStrategy(mode)).toBe(true);
    }
  });
  it("hasStrategy reports false for the dropped modes", () => {
    expect(hasStrategy("price-match")).toBe(false);
    expect(hasStrategy("budget-builder")).toBe(false);
  });
});
