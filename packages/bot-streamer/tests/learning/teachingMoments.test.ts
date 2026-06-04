import { describe, expect, it } from "vitest";
import { TeachingMoments } from "../../src/learning/teachingMoments";
import type { Sample } from "../../src/learning/types";

function mkSample(productId: number): Sample {
  return {
    features: new Float32Array(4),
    targetLogResidual: 0,
    actualCents: 100,
    heuristicCents: 100,
    categoryId: 0,
    brandTier: 0,
    mode: "classic",
    productId,
    roundId: `R-${productId}`,
    recordedAtRound: 0,
  };
}

const OPTS = {
  capacity: 4,
  recoveryPct: 0.05,
  replayMultiplier: 3,
  decayRounds: 50,
};

describe("TeachingMoments", () => {
  it("does not trigger without prior high loss", () => {
    const tm = new TeachingMoments(OPTS);
    const triggered = tm.observe(mkSample(1), 0.01, 0.5, false, 10);
    expect(triggered).toBe(false);
    expect(tm.size()).toBe(0);
  });

  it("triggers when previously high-loss and current within recoveryPct", () => {
    const tm = new TeachingMoments(OPTS);
    const triggered = tm.observe(mkSample(1), 0.04, 0.6, true, 10);
    expect(triggered).toBe(true);
    expect(tm.size()).toBe(1);
  });

  it("does not trigger when previously high but residual outside recoveryPct", () => {
    const tm = new TeachingMoments(OPTS);
    const triggered = tm.observe(mkSample(1), 0.2, 0.6, true, 10);
    expect(triggered).toBe(false);
    expect(tm.size()).toBe(0);
  });

  it("draws up to N samples and decrements replays", () => {
    const tm = new TeachingMoments(OPTS);
    tm.observe(mkSample(1), 0.01, 0.6, true, 10);
    tm.observe(mkSample(2), 0.01, 0.6, true, 10);
    let prng = 0xc0ffee;
    const rng = () => {
      prng = (prng * 1103515245 + 12345) & 0x7fffffff;
      return prng / 0x80000000;
    };
    const draws = tm.drawForReplay(11, 4, rng);
    expect(draws.length).toBe(4);
    // After 3+3=6 draws total, both entries should still be alive after 4 picks
    expect(tm.size()).toBeGreaterThan(0);
    // Drain the rest.
    let extra = 0;
    while (tm.size() > 0 && extra < 100) {
      tm.drawForReplay(11, 4, rng);
      extra += 1;
    }
    expect(tm.size()).toBe(0);
  });

  it("expires entries past decayUntilRound", () => {
    const tm = new TeachingMoments(OPTS);
    tm.observe(mkSample(1), 0.01, 0.6, true, 10);
    expect(tm.size()).toBe(1);
    const drawAfter = tm.drawForReplay(10 + OPTS.decayRounds + 1, 1, () => 0.5);
    expect(drawAfter.length).toBe(0);
    expect(tm.size()).toBe(0);
  });

  it("respects capacity (drops oldest)", () => {
    const tm = new TeachingMoments({ ...OPTS, capacity: 2 });
    tm.observe(mkSample(1), 0.01, 0.6, true, 10);
    tm.observe(mkSample(2), 0.01, 0.6, true, 10);
    tm.observe(mkSample(3), 0.01, 0.6, true, 10);
    expect(tm.size()).toBe(2);
  });

  it("serialise round-trips", () => {
    const tm = new TeachingMoments(OPTS);
    tm.observe(mkSample(1), 0.01, 0.6, true, 10);
    tm.observe(mkSample(2), 0.04, 0.5, true, 11);
    const buf = tm.serialize();
    const tm2 = TeachingMoments.deserialize(buf, OPTS);
    expect(tm2.size()).toBe(tm.size());
  });
});
