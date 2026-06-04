import { describe, expect, it } from "vitest";
import { OpponentTracker, __opponentTrackerInternals } from "../src/strategies/biddingOpponents";

const { ARCHETYPES, ARCHETYPE_PARAMS, POSTERIOR_SIGMA_FLOOR } = __opponentTrackerInternals;

describe("OpponentTracker — prior", () => {
  it("returns a per-difficulty prior over archetypes for a fresh opponent", () => {
    const tracker = new OpponentTracker("hard");
    const [snap] = tracker.snapshot(["p1"]);
    // Hard prior: 0.5 expert, 0.2 average-joe, 0.15 overbidder, 0.10 lowballer, 0.05 anchored, 0 wild-card.
    expect(snap.archetypeProbs.length).toBe(ARCHETYPES.length);
    const sum = snap.archetypeProbs.reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(snap.observed).toBe(0);
  });

  it("hard prior puts the most mass on expert; easy prior on wild-card / average-joe", () => {
    const hard = new OpponentTracker("hard").snapshot(["p1"])[0];
    const easy = new OpponentTracker("easy").snapshot(["p1"])[0];
    const expertIdx = ARCHETYPES.indexOf("expert");
    const wildIdx = ARCHETYPES.indexOf("wild-card");
    expect(hard.archetypeProbs[expertIdx]).toBeGreaterThan(0.4);
    expect(easy.archetypeProbs[expertIdx]).toBeLessThan(0.1);
    expect(easy.archetypeProbs[wildIdx]).toBeGreaterThan(0.1);
  });
});

describe("OpponentTracker — Bayes update", () => {
  it("after several near-zero residuals, posterior concentrates on expert", () => {
    const tracker = new OpponentTracker("medium");
    // Synthetic: 4 rounds of an opponent who bids almost exactly the
    // actual price (residuals ≈ 0). Expert (σ=0.08) has the highest
    // likelihood at the mode; the posterior should shift toward it.
    const samples = [
      { actual: 1000, bid: 1000 },
      { actual: 2500, bid: 2520 },
      { actual: 700, bid: 695 },
      { actual: 4000, bid: 4030 },
    ];
    for (const s of samples) {
      tracker.noteBid({ playerId: "expert-bot", bidCents: s.bid, actualCents: s.actual });
    }
    const [snap] = tracker.snapshot(["expert-bot"]);
    expect(snap.topArchetype).toBe("expert");
    expect(snap.observed).toBe(samples.length);
    const expertIdx = ARCHETYPES.indexOf("expert");
    expect(snap.archetypeProbs[expertIdx]).toBeGreaterThan(0.5);
  });

  it("estimatedSigma is floored at POSTERIOR_SIGMA_FLOOR even with high-confidence expert posterior", () => {
    const tracker = new OpponentTracker("hard");
    // Drive posterior almost entirely onto expert (σ=0.08 < floor).
    for (let i = 0; i < 8; i++) {
      tracker.noteBid({ playerId: "p", bidCents: 1000, actualCents: 1000 });
    }
    const [snap] = tracker.snapshot(["p"]);
    // Even if posterior put 100% on expert, σ should be floored.
    expect(snap.estimatedSigma).toBeGreaterThanOrEqual(POSTERIOR_SIGMA_FLOOR - 1e-9);
  });

  it("ignores invalid (non-finite, non-positive) inputs without corrupting state", () => {
    const tracker = new OpponentTracker("medium");
    tracker.noteBid({ playerId: "p", bidCents: 0, actualCents: 1000 });
    tracker.noteBid({ playerId: "p", bidCents: 1000, actualCents: 0 });
    tracker.noteBid({ playerId: "p", bidCents: NaN, actualCents: 1000 });
    const [snap] = tracker.snapshot(["p"]);
    expect(snap.observed).toBe(0);
    // Posterior should equal the prior.
    const fresh = new OpponentTracker("medium").snapshot(["p"])[0];
    for (let i = 0; i < snap.archetypeProbs.length; i++) {
      expect(snap.archetypeProbs[i]).toBeCloseTo(fresh.archetypeProbs[i], 5);
    }
  });

  it("a sustained positive bias (overbidder pattern) shifts posterior toward overbidder", () => {
    const tracker = new OpponentTracker("medium");
    // Overbidder: bias=+0.15, σ=0.15. Sample residuals ~ +0.15.
    const overbidderBias = ARCHETYPE_PARAMS.overbidder.bias;
    for (let i = 0; i < 5; i++) {
      const actual = 1000 + i * 200;
      const bid = Math.round(actual * Math.exp(overbidderBias));
      tracker.noteBid({ playerId: "o", bidCents: bid, actualCents: actual });
    }
    const [snap] = tracker.snapshot(["o"]);
    expect(snap.estimatedBias).toBeGreaterThan(0.05);
  });

  it("reset() returns posteriors to the prior", () => {
    const tracker = new OpponentTracker("medium");
    tracker.noteBid({ playerId: "p", bidCents: 1000, actualCents: 1000 });
    tracker.noteBid({ playerId: "p", bidCents: 1000, actualCents: 1000 });
    tracker.reset();
    const [snap] = tracker.snapshot(["p"]);
    expect(snap.observed).toBe(0);
  });
});
