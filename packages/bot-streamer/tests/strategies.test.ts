import { describe, it, expect } from "vitest";
import { classicStrategy } from "../src/strategies/classic";
import { higherLowerStrategy } from "../src/strategies/higher-lower";
import { comparisonStrategy } from "../src/strategies/comparison";
import { closestStrategy } from "../src/strategies/closest";
import { strategyFor, hasStrategy } from "../src/strategies/index";
import { makeRoundStart, makeProduct } from "../src/test-helpers/fixtures";
import { seeded } from "./_rng";

describe("classicStrategy", () => {
  it("returns at least one candidate with a numeric guessedPriceCents", () => {
    const round = makeRoundStart({
      gameMode: "classic",
      product: makeProduct({ title: "Bluetooth Speaker", category: "Electronics" }),
    });
    const cs = classicStrategy.candidates(round, { rng: seeded(1) });
    expect(cs.length).toBeGreaterThan(0);
    expect(cs[0].score).toBe(1.0);
    const top = cs[0].payload;
    if ("guessedPriceCents" in top) {
      expect(top.guessedPriceCents).toBeGreaterThan(0);
    } else {
      throw new Error("classic candidate missing guessedPriceCents");
    }
  });

  it("throws when the round is missing a product", () => {
    expect(() =>
      classicStrategy.candidates(makeRoundStart({ product: undefined }), { rng: seeded(1) }),
    ).toThrow();
  });
});

describe("higherLowerStrategy", () => {
  it("ranks 'higher' above 'lower' when the estimate exceeds the reference", () => {
    const round = makeRoundStart({
      gameMode: "higher-lower",
      product: makeProduct({ title: "Premium Pro 4K Speaker", category: "Electronics" }),
      referencePrice: 500, // $5 — wildly under any estimate
    });
    const cs = higherLowerStrategy.candidates(round, { rng: seeded(1) });
    expect(cs[0].payload).toEqual({ guess: "higher" });
  });

  it("ranks 'lower' above 'higher' when the reference is wildly over", () => {
    const round = makeRoundStart({
      gameMode: "higher-lower",
      product: makeProduct({ title: "Mini Basic Speaker", category: "Books" }),
      referencePrice: 50_000_00, // $50,000 — way over any estimate
    });
    const cs = higherLowerStrategy.candidates(round, { rng: seeded(1) });
    expect(cs[0].payload).toEqual({ guess: "lower" });
  });

  it("returns near-equal scores when the estimate is close to the reference", () => {
    const product = makeProduct({ title: "USB cable", category: "Electronics" });
    // Electronics baseline is $75 = 7500 cents.
    const round = makeRoundStart({
      gameMode: "higher-lower",
      product,
      referencePrice: 7500,
    });
    const cs = higherLowerStrategy.candidates(round, { rng: seeded(1) });
    const [top, second] = cs;
    expect(Math.abs(top.score - second.score)).toBeLessThan(0.5);
  });

  it("throws when the reference is missing", () => {
    const round = makeRoundStart({
      gameMode: "higher-lower",
      product: makeProduct(),
      referencePrice: undefined,
    });
    expect(() => higherLowerStrategy.candidates(round, { rng: seeded(1) })).toThrow();
  });

  it("never produces negative scores even on extreme gaps", () => {
    // Reference is wildly off from any plausible estimate. The loser's
    // score must stay >= 0 to satisfy ScoredCandidate's contract.
    const round = makeRoundStart({
      gameMode: "higher-lower",
      product: makeProduct({ title: "Mini Basic Speaker", category: "Books" }),
      referencePrice: 10_000_000_00,
    });
    const cs = higherLowerStrategy.candidates(round, { rng: seeded(1) });
    for (const c of cs) {
      expect(c.score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("comparisonStrategy", () => {
  it("picks the most-expensive product by default", () => {
    const cheap = makeProduct({ id: 1, title: "Mini Basic", category: "Books" });
    const pricey = makeProduct({ id: 2, title: "Premium Pro 4K", category: "Electronics" });
    const round = makeRoundStart({
      gameMode: "comparison",
      product: undefined,
      products: [cheap, pricey],
      question: "most-expensive",
    });
    const cs = comparisonStrategy.candidates(round, { rng: seeded(1) });
    expect(cs[0].payload).toEqual({ guessedProductId: 2 });
  });

  it("picks the least-expensive when the question asks for it", () => {
    const cheap = makeProduct({ id: 1, title: "Mini Basic", category: "Books" });
    const pricey = makeProduct({ id: 2, title: "Premium Pro 4K", category: "Electronics" });
    const round = makeRoundStart({
      gameMode: "comparison",
      product: undefined,
      products: [cheap, pricey],
      question: "least-expensive",
    });
    const cs = comparisonStrategy.candidates(round, { rng: seeded(1) });
    expect(cs[0].payload).toEqual({ guessedProductId: 1 });
  });

  it("throws when fewer than two products are present", () => {
    const round = makeRoundStart({ gameMode: "comparison", product: undefined, products: [makeProduct()] });
    expect(() => comparisonStrategy.candidates(round, { rng: seeded(1) })).toThrow();
  });
});

describe("closestStrategy", () => {
  it("submits a guess that is a fraction of the heuristic estimate", () => {
    const round = makeRoundStart({
      gameMode: "closest-without-going-over",
      product: makeProduct({ title: "Speaker", category: "Electronics" }),
    });
    const cs = closestStrategy.candidates(round, { rng: seeded(1) });
    const top = cs[0].payload;
    if (!("guessedPriceCents" in top)) throw new Error("missing cents");
    // Electronics baseline is $75 = 7500 cents. Strategy uses ~7%
    // multiplicative noise; top variant is estimate × 0.85, so the
    // landing range is roughly $55 - $80 (5500 - 8000 cents). Bound
    // the test tightly enough that a regression in baseline math is
    // caught, loose enough that the noise doesn't make it flaky.
    expect(top.guessedPriceCents).toBeGreaterThan(4000);
    expect(top.guessedPriceCents).toBeLessThan(8500);
  });

  it("throws when product is missing", () => {
    expect(() =>
      closestStrategy.candidates(makeRoundStart({ product: undefined }), { rng: seeded(1) }),
    ).toThrow();
  });
});

describe("strategy registry", () => {
  it("returns the right strategy for each registered mode", () => {
    expect(strategyFor("classic")).toBe(classicStrategy);
    expect(strategyFor("higher-lower")).toBe(higherLowerStrategy);
    expect(strategyFor("comparison")).toBe(comparisonStrategy);
    expect(strategyFor("closest-without-going-over")).toBe(closestStrategy);
  });

  it("registers a bidding strategy that uses the closest scoring rules", () => {
    // Regression: the bot's rotation can hit single-player bidding
    // (daily challenge) and was previously crashing because no
    // strategy was registered for "bidding".
    const bid = strategyFor("bidding");
    expect(bid.mode).toBe("bidding");
    const round = makeRoundStart({
      gameMode: "bidding",
      product: makeProduct({ title: "Speaker", category: "Electronics" }),
    });
    const cs = bid.candidates(round, { rng: seeded(1) });
    expect(cs.length).toBeGreaterThan(0);
  });

  it("throws for a mode that is not a real GameMode", () => {
    // All 12 production modes are now supported. Use a bogus value
    // to exercise the throw path.
    expect(() => strategyFor("not-a-real-mode" as never)).toThrow();
  });

  it("hasStrategy reports support flags for the canonical modes", () => {
    expect(hasStrategy("classic")).toBe(true);
    expect(hasStrategy("bidding")).toBe(true);
    expect(hasStrategy("not-a-real-mode" as never)).toBe(false);
  });
});
