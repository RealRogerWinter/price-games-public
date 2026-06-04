import { describe, it, expect } from "vitest";
import {
  scoreGuess,
  scoreHigherLower,
  scoreComparison,
  scoreClosest,
  scorePriceMatch,
  scoreRiser,
  scoreBidding,
  scoreBiddingSolo,
  scoreBudgetBuilder,
} from "@price-game/shared";

describe("scoreGuess (classic mode — smooth curve k=2.5)", () => {
  it("scores 1000 for exact match", () => {
    const result = scoreGuess(5000, 5000);
    expect(result.score).toBe(1000);
    expect(result.pctOff).toBe(0);
  });

  it("scores ~975 for 1% off", () => {
    const result = scoreGuess(5050, 5000);
    expect(result.score).toBe(975);
  });

  it("scores ~880 for 5% off", () => {
    const result = scoreGuess(5250, 5000);
    expect(result.score).toBe(880);
  });

  it("scores ~768 for 10% off", () => {
    const result = scoreGuess(5500, 5000);
    expect(result.score).toBe(768);
  });

  it("scores ~487 for 25% off", () => {
    const result = scoreGuess(6250, 5000);
    expect(result.score).toBe(487);
  });

  it("scores ~177 for 50% off", () => {
    const result = scoreGuess(7500, 5000);
    expect(result.score).toBe(177);
  });

  it("scores 0 for 100%+ off", () => {
    const result = scoreGuess(10000, 5000);
    expect(result.score).toBe(0);
  });

  it("handles zero actual price", () => {
    const result = scoreGuess(100, 0);
    expect(result.score).toBe(0);
    expect(result.pctOff).toBe(1);
  });

  it("works symmetrically (over and under)", () => {
    const over = scoreGuess(5500, 5000);
    const under = scoreGuess(4500, 5000);
    expect(over.score).toBe(under.score);
  });

  it("never produces perverse cliffs (9.9% ≈ 10.1% ≈ 10%)", () => {
    // Old step function cliff: 9.99% → 500, 10.01% → 250 (250-point jump).
    // Smooth curve should differ by no more than a handful of points.
    const at99 = scoreGuess(5495, 5000).score;
    const at10 = scoreGuess(5500, 5000).score;
    const at101 = scoreGuess(5505, 5000).score;
    expect(Math.abs(at99 - at10)).toBeLessThanOrEqual(3);
    expect(Math.abs(at101 - at10)).toBeLessThanOrEqual(3);
  });
});

describe("scoreHigherLower", () => {
  it("scores 1000 for a correct higher guess", () => {
    const result = scoreHigherLower(4000, 5000, "higher");
    expect(result.correct).toBe(true);
    expect(result.score).toBe(1000);
  });

  it("scores 0 for incorrect guess", () => {
    const result = scoreHigherLower(4000, 5000, "lower");
    expect(result.correct).toBe(false);
    expect(result.score).toBe(0);
  });

  it("awards the same 1000 points regardless of difficulty (binary reward)", () => {
    const hard = scoreHigherLower(4900, 5000, "higher"); // 2% diff
    const easy = scoreHigherLower(2000, 5000, "higher"); // 60% diff
    expect(hard.score).toBe(1000);
    expect(easy.score).toBe(1000);
  });

  it("scores 1000 for a correct lower guess", () => {
    const result = scoreHigherLower(5000, 4000, "lower");
    expect(result.correct).toBe(true);
    expect(result.score).toBe(1000);
  });
});

describe("scoreComparison", () => {
  const products = [
    { id: 1, priceCents: 1000 },
    { id: 2, priceCents: 5000 },
  ];

  it("scores 1000 for picking the most expensive", () => {
    const result = scoreComparison(products, "most-expensive", 2);
    expect(result.correct).toBe(true);
    expect(result.correctProductId).toBe(2);
    expect(result.score).toBe(1000);
  });

  it("scores 1000 for picking the least expensive", () => {
    const result = scoreComparison(products, "least-expensive", 1);
    expect(result.correct).toBe(true);
    expect(result.correctProductId).toBe(1);
    expect(result.score).toBe(1000);
  });

  it("scores 0 for wrong pick", () => {
    const result = scoreComparison(products, "most-expensive", 1);
    expect(result.correct).toBe(false);
    expect(result.score).toBe(0);
  });

  it("awards the same 1000 points regardless of price spread (binary reward)", () => {
    const close = [
      { id: 1, priceCents: 4500 },
      { id: 2, priceCents: 5000 },
    ];
    const far = [
      { id: 1, priceCents: 1000 },
      { id: 2, priceCents: 5000 },
    ];
    const closeResult = scoreComparison(close, "most-expensive", 2);
    const farResult = scoreComparison(far, "most-expensive", 2);
    expect(closeResult.score).toBe(1000);
    expect(farResult.score).toBe(1000);
  });
});

describe("scoreClosest (closest without going over — smooth curve k=3.0)", () => {
  it("scores 1000 for exact match", () => {
    const result = scoreClosest(5000, 5000);
    expect(result.score).toBe(1000);
    expect(result.wentOver).toBe(false);
  });

  it("scores 0 and marks wentOver when guess exceeds actual", () => {
    const result = scoreClosest(5001, 5000);
    expect(result.score).toBe(0);
    expect(result.wentOver).toBe(true);
  });

  it("scores ~857 for 5% under", () => {
    const result = scoreClosest(4750, 5000);
    expect(result.score).toBe(857);
    expect(result.wentOver).toBe(false);
  });

  it("scores ~729 for 10% under", () => {
    const result = scoreClosest(4500, 5000);
    expect(result.score).toBe(729);
  });

  it("scores ~422 for 25% under", () => {
    const result = scoreClosest(3750, 5000);
    expect(result.score).toBe(422);
  });

  it("scores ~125 for 50% under", () => {
    const result = scoreClosest(2500, 5000);
    expect(result.score).toBe(125);
  });

  it("handles zero actual price", () => {
    const result = scoreClosest(100, 0);
    expect(result.score).toBe(0);
  });

  it("NO participation floor — ultra-low underbid scores ~0", () => {
    // $0.01 on $30 used to produce a 50-pt participation floor with label
    // "Way Off". That's dishonest and over-rewards trolling.
    const result = scoreClosest(1, 3000);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.wentOver).toBe(false);
  });
});

describe("scorePriceMatch", () => {
  const products = [
    { id: 1, priceCents: 1000 },
    { id: 2, priceCents: 2000 },
    { id: 3, priceCents: 3000 },
    { id: 4, priceCents: 4000 },
  ];

  it("scores 1000 for all correct (4 * 200 + 200 bonus)", () => {
    const assignments = { 1: 1000, 2: 2000, 3: 3000, 4: 4000 };
    const result = scorePriceMatch(assignments, products);
    expect(result.score).toBe(1000);
    expect(result.correctCount).toBe(4);
  });

  it("scores 600 for 3 correct (no bonus)", () => {
    const assignments = { 1: 1000, 2: 2000, 3: 3000, 4: 9999 };
    const result = scorePriceMatch(assignments, products);
    expect(result.score).toBe(600);
    expect(result.correctCount).toBe(3);
  });

  it("scores 0 for none correct", () => {
    const assignments = { 1: 9999, 2: 9999, 3: 9999, 4: 9999 };
    const result = scorePriceMatch(assignments, products);
    expect(result.score).toBe(0);
    expect(result.correctCount).toBe(0);
  });
});

describe("scoreRiser (smooth curve k=3.5 — steeper than closest)", () => {
  it("scores 1000 for exact match", () => {
    const result = scoreRiser(5000, 5000);
    expect(result.score).toBe(1000);
    expect(result.wentOver).toBe(false);
  });

  it("scores 0 and marks wentOver when stopped above actual", () => {
    const result = scoreRiser(5100, 5000);
    expect(result.score).toBe(0);
    expect(result.wentOver).toBe(true);
  });

  it("scores ~836 for 5% under (tighter curve than classic)", () => {
    const result = scoreRiser(4750, 5000);
    expect(result.score).toBe(836);
    expect(result.wentOver).toBe(false);
  });

  it("scores ~692 for 10% under", () => {
    const result = scoreRiser(4500, 5000);
    expect(result.score).toBe(692);
  });

  it("scores ~88 for 50% under", () => {
    const result = scoreRiser(2500, 5000);
    expect(result.score).toBe(88);
  });

  it("steeper than closest at the tail (drops off faster for big misses)", () => {
    // 40% off — riser k=3.5 vs closest k=3.0: riser should score lower.
    const riserResult = scoreRiser(3000, 5000);
    const closestResult = scoreClosest(3000, 5000);
    expect(riserResult.score).toBeLessThan(closestResult.score);
  });

  it("handles zero actual price", () => {
    const result = scoreRiser(100, 0);
    expect(result.score).toBe(0);
  });

  it("NO participation floor — ultra-low stop scores 0", () => {
    const result = scoreRiser(1, 3000);
    expect(result.score).toBe(0);
  });
});

describe("scoreBudgetBuilder (smooth curve k=3.0)", () => {
  it("scores 1000 for exact budget match", () => {
    const result = scoreBudgetBuilder(10000, 10000);
    expect(result.score).toBe(1000);
  });

  it("scores 0 when over budget", () => {
    const result = scoreBudgetBuilder(10001, 10000);
    expect(result.score).toBe(0);
  });

  it("scores 0 when cart is empty", () => {
    const result = scoreBudgetBuilder(0, 10000);
    expect(result.score).toBe(0);
  });

  it("scores 0 when budget is non-positive", () => {
    expect(scoreBudgetBuilder(100, 0).score).toBe(0);
    expect(scoreBudgetBuilder(100, -10).score).toBe(0);
  });

  it("scores ~857 for 5% under budget", () => {
    const result = scoreBudgetBuilder(9500, 10000);
    expect(result.score).toBe(857);
  });

  it("scores ~125 for 50% under budget", () => {
    const result = scoreBudgetBuilder(5000, 10000);
    expect(result.score).toBe(125);
  });

  it("NO participation floor — trivially tiny cart scores ~0", () => {
    // $0.01 cart against a $30 budget used to score 50 pts.
    const result = scoreBudgetBuilder(1, 3000);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("scoreBidding (multiplayer — rank-based × proximity)", () => {
  it("top-rank valid bid earns near-full 1000 when bid is close", () => {
    // 4800 on 5000 → pctOff 4% → factor ≈ 0.903 → ≈ 903
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 4800 },
        { playerId: "b", bidCents: 4500 },
      ],
      5000
    );
    const a = results.find((r) => r.playerId === "a")!;
    const b = results.find((r) => r.playerId === "b")!;
    expect(a.score).toBeGreaterThanOrEqual(850);
    expect(a.score).toBeLessThanOrEqual(950);
    // 4500 on 5000 → pctOff 10% → 700 × 0.768 ≈ 538
    expect(b.score).toBeGreaterThanOrEqual(500);
    expect(b.score).toBeLessThan(600);
    expect(a.wentOver).toBe(false);
    expect(b.wentOver).toBe(false);
    // Rank still dominates — closer bid outscores farther bid.
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("scores 0 for bids over the actual price", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 5100 },
        { playerId: "b", bidCents: 4900 },
      ],
      5000
    );
    expect(results.find((r) => r.playerId === "a")!.score).toBe(0);
    expect(results.find((r) => r.playerId === "a")!.wentOver).toBe(true);
    // 4900 on 5000 → pctOff 2% → 1000 × 0.951 ≈ 951
    const b = results.find((r) => r.playerId === "b")!;
    expect(b.score).toBeGreaterThanOrEqual(930);
    expect(b.score).toBeLessThanOrEqual(960);
  });

  it("gives all 0 when everyone overbids", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 6000 },
        { playerId: "b", bidCents: 7000 },
        { playerId: "c", bidCents: 5500 },
      ],
      5000
    );
    expect(results.every((r) => r.score === 0)).toBe(true);
    expect(results.every((r) => r.wentOver === true)).toBe(true);
  });

  it("awards exact match bonus (exact bypasses proximity scaling)", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 5000 },
        { playerId: "b", bidCents: 4900 },
      ],
      5000
    );
    const a = results.find((r) => r.playerId === "a")!;
    expect(a.score).toBe(1500); // 1000 + 500 bonus, unscaled
    expect(a.isExact).toBe(true);
    expect(a.pctOff).toBe(0);
  });

  it("applies proximity-scaled graduated scoring for multiple valid bids", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 4900 }, // rank 0, pctOff 2%
        { playerId: "b", bidCents: 4700 }, // rank 1, pctOff 6%
        { playerId: "c", bidCents: 4500 }, // rank 2, pctOff 10%
        { playerId: "d", bidCents: 4000 }, // rank 3, pctOff 20%
        { playerId: "e", bidCents: 5500 }, // over
      ],
      5000
    );
    const a = results.find((r) => r.playerId === "a")!.score;
    const b = results.find((r) => r.playerId === "b")!.score;
    const c = results.find((r) => r.playerId === "c")!.score;
    const d = results.find((r) => r.playerId === "d")!.score;
    expect(a).toBeGreaterThanOrEqual(930);  // ~951
    expect(b).toBeGreaterThanOrEqual(560);  // 700 × 0.857 ≈ 600
    expect(b).toBeLessThan(a);
    expect(c).toBeGreaterThanOrEqual(280);  // 400 × 0.768 ≈ 307
    expect(c).toBeLessThan(b);
    expect(d).toBeGreaterThanOrEqual(100);  // 200 × 0.572 ≈ 114
    expect(d).toBeLessThan(c);
    expect(results.find((r) => r.playerId === "e")!.score).toBe(0);
  });

  it("handles a single bid (multiplayer context — proximity still applies)", () => {
    // Single bid at 4000/5000 (20% off). Rank 0 × proximity 0.572 ≈ 572.
    const results = scoreBidding(
      [{ playerId: "a", bidCents: 4000 }],
      5000
    );
    expect(results[0].score).toBeGreaterThanOrEqual(520);
    expect(results[0].score).toBeLessThanOrEqual(620);
    expect(results[0].pctOff).toBeCloseTo(0.2, 5);
  });

  it("a $0.01 lowball earns near-zero even at rank 0 (the exploit fix)", () => {
    // Previously: rank 0 alone → 1000 pts regardless of how far under.
    // Now: 1 / 3000 → pctOff ≈ 0.9997 → factor ≈ 0 → score rounds to 0.
    const results = scoreBidding(
      [{ playerId: "a", bidCents: 1 }],
      3000
    );
    expect(results[0].score).toBeLessThanOrEqual(1);
    expect(results[0].wentOver).toBe(false);
  });

  it("a $0.01 lowball stays near-zero even when everyone else overbids", () => {
    const results = scoreBidding(
      [
        { playerId: "lowballer", bidCents: 1 },
        { playerId: "overbidder1", bidCents: 3100 },
        { playerId: "overbidder2", bidCents: 3200 },
      ],
      3000
    );
    const lb = results.find((r) => r.playerId === "lowballer")!;
    expect(lb.score).toBeLessThanOrEqual(1);
    expect(lb.wentOver).toBe(false);
  });

  it("handles empty bids array", () => {
    const results = scoreBidding([], 5000);
    expect(results).toEqual([]);
  });

  it("gives tied bids the same score (not ordinal ranks)", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 4900 },
        { playerId: "b", bidCents: 4900 },
        { playerId: "c", bidCents: 4700 },
      ],
      5000
    );
    const a = results.find((r) => r.playerId === "a")!;
    const b = results.find((r) => r.playerId === "b")!;
    const c = results.find((r) => r.playerId === "c")!;
    expect(a.score).toBe(b.score); // tied
    expect(a.score).toBeGreaterThan(c.score); // tied-for-1st beats rank 2
  });

  it("tied exact matches both get exact bonus", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 5000 },
        { playerId: "b", bidCents: 5000 },
        { playerId: "c", bidCents: 4000 },
      ],
      5000
    );
    expect(results.find((r) => r.playerId === "a")!.score).toBe(1500);
    expect(results.find((r) => r.playerId === "b")!.score).toBe(1500);
  });

  it("handles more than 6 bidders (overflow uses last tier, scaled)", () => {
    const results = scoreBidding(
      [
        { playerId: "a", bidCents: 4900 },
        { playerId: "b", bidCents: 4800 },
        { playerId: "c", bidCents: 4700 },
        { playerId: "d", bidCents: 4600 },
        { playerId: "e", bidCents: 4500 },
        { playerId: "f", bidCents: 4400 },
        { playerId: "g", bidCents: 4300 }, // rank 6 → last tier (100) × ~0.686 ≈ 69
      ],
      5000
    );
    const g = results.find((r) => r.playerId === "g")!.score;
    expect(g).toBeGreaterThanOrEqual(50);
    expect(g).toBeLessThanOrEqual(100);
  });

  it("returns pctOff on every result", () => {
    const results = scoreBidding(
      [
        { playerId: "under", bidCents: 4000 },
        { playerId: "over", bidCents: 6000 },
      ],
      5000
    );
    const under = results.find((r) => r.playerId === "under")!;
    const over = results.find((r) => r.playerId === "over")!;
    expect(under.pctOff).toBeCloseTo(0.2, 5);
    expect(over.pctOff).toBeCloseTo(0.2, 5);
  });

  it("returns a safe fallback when actualPriceCents is 0", () => {
    const results = scoreBidding(
      [{ playerId: "a", bidCents: 0 }],
      0
    );
    expect(results[0].score).toBe(0);
    expect(results[0].wentOver).toBe(false);
  });
});

describe("scoreBiddingSolo (solo / daily-challenge bidding — proximity-based)", () => {
  it("scores 1500 for an exact bid (base 1000 + exact-bid bonus 500)", () => {
    const result = scoreBiddingSolo(5000, 5000);
    expect(result.score).toBe(1500);
    expect(result.isExact).toBe(true);
    expect(result.wentOver).toBe(false);
    expect(result.pctOff).toBe(0);
  });

  it("scores 0 and marks wentOver when bid exceeds actual", () => {
    const result = scoreBiddingSolo(5001, 5000);
    expect(result.score).toBe(0);
    expect(result.wentOver).toBe(true);
  });

  it("scores ~857 for a 5% underbid (matches closest curve)", () => {
    const result = scoreBiddingSolo(4750, 5000);
    expect(result.score).toBe(857);
  });

  it("scores ~125 for a 50% underbid", () => {
    const result = scoreBiddingSolo(2500, 5000);
    expect(result.score).toBe(125);
  });

  it("FIXES THE $0.01-ON-$30 BUG: ultra-low underbid now scores ~0, not 1000", () => {
    // Regression: previously, any valid underbid got rank 0 = 1000 points.
    // This made bidding $0.01 on a $30 item the optimal strategy.
    const result = scoreBiddingSolo(1, 3000);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.isExact).toBe(false);
    expect(result.wentOver).toBe(false);
  });

  it("handles zero actual price safely", () => {
    const result = scoreBiddingSolo(100, 0);
    expect(result.score).toBe(0);
  });
});

describe("smoothScore defensive behaviour (via scoreGuess)", () => {
  it("treats NaN pctOff as score 0 rather than returning NaN", () => {
    // pctOff = NaN is only reachable via bad upstream input; defense-in-depth
    // ensures we never persist a NaN score to the DB even if it slipped through.
    const result = scoreGuess(Number.NaN, 5000);
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.score).toBe(0);
  });

  it("treats a negative guess (same magnitude) symmetrically per spec", () => {
    // Dispatcher clamps negatives to 0 upstream; here we document the symmetric behaviour.
    const result = scoreGuess(-5000, 5000);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe("pctOff label-boundary behaviour (12-tier snark ladder sanity)", () => {
  // The UI's `getAccuracyLabel` is pctOff-driven and uses boundaries at
  // 0, 0.01, 0.03, 0.07, 0.12, 0.20, 0.30, 0.45, 0.60, 0.80, 1.20.
  // These tests assert the *scoring* side remains well-behaved at those
  // exact boundary values so the label can be trusted.
  const cases = [0, 0.01, 0.03, 0.07, 0.12, 0.2, 0.3, 0.45, 0.6, 0.8, 1.2];
  for (const p of cases) {
    it(`scoreGuess returns a finite score at pctOff ≈ ${p}`, () => {
      const actualCents = 10000;
      const guessed = Math.round(actualCents * (1 - p));
      const r = scoreGuess(guessed, actualCents);
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1000);
    });
  }
});

describe("ultra-low-underbid rejection (integration across asymmetric modes)", () => {
  // Core complaint: "bidding $0.01 on a $30 item" should not be rewarded.
  // Every proximity-based mode must drop to ~0 in this scenario.
  const PENNY = 1;
  const THIRTY_DOLLARS = 3000;

  it("scoreClosest($0.01 on $30) ≤ 1", () => {
    expect(scoreClosest(PENNY, THIRTY_DOLLARS).score).toBeLessThanOrEqual(1);
  });

  it("scoreRiser($0.01 on $30) ≤ 1", () => {
    expect(scoreRiser(PENNY, THIRTY_DOLLARS).score).toBeLessThanOrEqual(1);
  });

  it("scoreBudgetBuilder(cart=$0.01, budget=$30) ≤ 1", () => {
    expect(scoreBudgetBuilder(PENNY, THIRTY_DOLLARS).score).toBeLessThanOrEqual(1);
  });

  it("scoreBiddingSolo($0.01 on $30) ≤ 1", () => {
    expect(scoreBiddingSolo(PENNY, THIRTY_DOLLARS).score).toBeLessThanOrEqual(1);
  });

  it("scoreGuess($0.01 on $30) = 0 (classic, symmetric)", () => {
    expect(scoreGuess(PENNY, THIRTY_DOLLARS).score).toBe(0);
  });
});
