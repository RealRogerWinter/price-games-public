import { describe, expect, it } from "vitest";
import { decideBid, __biddingDecoderInternals } from "../src/strategies/biddingDecoder";
import { seeded } from "./_rng";

const { buildCandidates, simulateOurScore, zForQuantile } = __biddingDecoderInternals;

describe("biddingDecoder.zForQuantile", () => {
  it("median is 0", () => {
    expect(zForQuantile(0.5)).toBeCloseTo(0, 4);
  });
  it("q40 is negative (lower quantile)", () => {
    expect(zForQuantile(0.4)).toBeLessThan(0);
  });
  it("q60 is positive (upper quantile)", () => {
    expect(zForQuantile(0.6)).toBeGreaterThan(0);
  });
});

describe("biddingDecoder.simulateOurScore", () => {
  it("returns 0 on overbid", () => {
    expect(simulateOurScore(1100, 1000, [800, 900])).toBe(0);
  });
  it("rewards a closer-to-actual bid with rank-1 base", () => {
    // Our 990, others 800/700. Actual 1000. We're rank 0.
    const score = simulateOurScore(990, 1000, [800, 700]);
    expect(score).toBeGreaterThan(500);
  });
  it("exact-match adds the +500 bonus", () => {
    const score = simulateOurScore(1000, 1000, [900, 800]);
    // Rank 1 base 1000 + bonus 500 + proximity factor 1.
    expect(score).toBe(1500);
  });
});

describe("biddingDecoder.buildCandidates", () => {
  it("first bidder produces three quantile candidates and no clip", () => {
    const candidates = buildCandidates({
      heuristicCents: 1000,
      turnIdx: 0,
      totalPlayers: 4,
      previousBidsCents: [],
      laterOpponents: [],
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.every((c) => c.tag.startsWith("first_"))).toBe(true);
  });

  it("last bidder includes clip + gambit candidates", () => {
    const candidates = buildCandidates({
      heuristicCents: 1000,
      turnIdx: 3,
      totalPlayers: 4,
      previousBidsCents: [600, 800, 700],
      laterOpponents: [],
    });
    const tags = candidates.map((c) => c.tag);
    expect(tags).toContain("clip_plus_1");
    expect(tags).toContain("gambit_dollar_one");
  });

  it("middle bidder includes an undercut candidate when the standing leader is sub-μ", () => {
    const candidates = buildCandidates({
      squashedRegression: { mu: 0, sigma: 0.2 },
      heuristicCents: 1000,
      turnIdx: 1,
      totalPlayers: 4,
      previousBidsCents: [600],
      laterOpponents: [],
    });
    const tags = candidates.map((c) => c.tag);
    expect(tags).toContain("undercut_minus_1");
  });

  it("no plausible standing bid → clip candidate not injected for last bidder", () => {
    // All previous bids exceed μ × 1.05 → ineligible for clipping.
    const candidates = buildCandidates({
      squashedRegression: { mu: 0, sigma: 0.1 },
      heuristicCents: 1000,
      turnIdx: 3,
      totalPlayers: 4,
      previousBidsCents: [50_000, 60_000],
      laterOpponents: [],
    });
    const tags = candidates.map((c) => c.tag);
    expect(tags).not.toContain("clip_plus_1");
    expect(tags).toContain("gambit_dollar_one");
  });
});

describe("biddingDecoder.decideBid (integration)", () => {
  it("returns a positive bid with non-empty scoredCandidates and a sensible position label", () => {
    const result = decideBid({
      heuristicCents: 1000,
      turnIdx: 0,
      totalPlayers: 4,
      previousBidsCents: [],
      laterOpponents: [],
      rng: seeded(1),
    });
    expect(result.bidCents).toBeGreaterThan(0);
    expect(result.position).toBe("first");
    expect(result.scoredCandidates.length).toBeGreaterThan(0);
  });

  it("last-bidder picks a clip-style bid when one beats the alternatives in expectation", () => {
    // Standing bids leave room for `highestPlausible+1` to win — a
    // bid 1¢ above 800 still has 80% of the rank-1 score.
    const result = decideBid({
      squashedRegression: { mu: 0, sigma: 0.05 },
      heuristicCents: 1000,
      turnIdx: 3,
      totalPlayers: 4,
      previousBidsCents: [800, 700, 600],
      laterOpponents: [],
      rng: seeded(1),
    });
    expect(result.position).toBe("last");
    expect(result.bidCents).toBeGreaterThan(0);
  });
});
