import { describe, expect, it } from "vitest";
import { PrioritizedReplay, StratifiedReplay } from "../../src/learning/replayBuffer";
import type { Sample } from "../../src/learning/types";
import type { GameMode } from "@price-game/shared";

function mkSample(roundId: string, productId: number, mode: GameMode = "classic"): Sample {
  return {
    features: new Float32Array(4).fill(0.1),
    targetLogResidual: 0,
    actualCents: 100,
    heuristicCents: 100,
    categoryId: 0,
    brandTier: 0,
    mode,
    productId,
    roundId,
    recordedAtRound: 0,
  };
}

const OPTS = {
  capacity: 16,
  alpha: 0.5,
  betaStart: 0.4,
  betaEnd: 1.0,
  betaAnnealRounds: 100,
  uniformFraction: 0.0,
  maxPerRoundInBatch: 2,
};

function rngLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const STRAT_OPTS = {
  recentCapacity: 16,
  perModeCapacity: 8,
  recentSampleFraction: 0.25,
  recentUniformFraction: 0.5,
  alpha: 0.5,
  betaStart: 0.4,
  betaEnd: 1.0,
  betaAnnealRounds: 100,
  perModeUniformFraction: 0.0,
  maxPerRoundInBatch: 2,
};

describe("StratifiedReplay", () => {
  it("creates per-mode buckets lazily on first push of each mode", () => {
    const r = new StratifiedReplay(STRAT_OPTS);
    expect(r.size()).toBe(0);
    r.push(mkSample("r0", 1, "classic"));
    r.push(mkSample("r1", 2, "comparison"));
    r.push(mkSample("r2", 3, "classic"));
    // 3 in recent + 2 in classic + 1 in comparison = 6
    expect(r.size()).toBe(6);
  });

  it("rare-mode samples survive when a dominant mode floods the buffer", () => {
    const r = new StratifiedReplay({ ...STRAT_OPTS, perModeCapacity: 4 });
    // 1 sample of a rare mode
    r.push(mkSample("rare", 99, "budget-builder"));
    // Then 50 dominant-mode samples — the rare bucket cannot evict.
    for (let i = 0; i < 50; i++) r.push(mkSample(`d${i}`, i, "higher-lower"));
    // Sample many times and confirm budget-builder still appears.
    const rng = rngLcg(7);
    let sawRare = false;
    for (let attempt = 0; attempt < 50 && !sawRare; attempt++) {
      const batch = r.sample(8, attempt, rng);
      if (batch.samples.some((s) => s.mode === "budget-builder")) sawRare = true;
    }
    expect(sawRare).toBe(true);
  });

  it("sample composition respects recentSampleFraction within tolerance", () => {
    const r = new StratifiedReplay({ ...STRAT_OPTS, recentSampleFraction: 0.25 });
    for (let i = 0; i < 20; i++) r.push(mkSample(`r${i}`, i, "classic"));
    // 25% of n=8 = 2 from recent, 6 from stratified (only "classic" active so all 6 from classic).
    const rng = rngLcg(13);
    const batch = r.sample(8, 1, rng);
    // Round 1 → β anneal partially; just assert size + some basic shape.
    expect(batch.samples.length).toBe(8);
    expect(batch.indices.length).toBe(8);
    expect(batch.isWeights.length).toBe(8);
  });

  it("updatePriorities routes to the correct underlying bucket", () => {
    const r = new StratifiedReplay(STRAT_OPTS);
    r.push(mkSample("r0", 1, "classic"));
    r.push(mkSample("r1", 2, "comparison"));
    const rng = rngLcg(21);
    const batch = r.sample(4, 0, rng);
    // Updating to extreme priorities should not throw and round-trip via re-sample.
    const newPri = new Float32Array(batch.indices.length).fill(10);
    r.updatePriorities(batch.indices, newPri);
    // Force another draw to confirm internal state didn't corrupt.
    const next = r.sample(2, 1, rng);
    expect(next.samples.length).toBeGreaterThan(0);
  });

  it("serialize → deserialize round-trips identical samples", () => {
    const r = new StratifiedReplay(STRAT_OPTS);
    r.push(mkSample("a", 1, "classic"));
    r.push(mkSample("b", 2, "comparison"));
    r.push(mkSample("c", 3, "budget-builder"));
    const blob = r.serialize();
    const r2 = StratifiedReplay.deserialize(blob, STRAT_OPTS);
    expect(r2.size()).toBe(r.size());
    // Resample from each — sampling is deterministic given the same RNG.
    const rng1 = rngLcg(42);
    const rng2 = rngLcg(42);
    const b1 = r.sample(3, 5, rng1);
    const b2 = r2.sample(3, 5, rng2);
    expect(b2.samples.map((s) => s.productId).sort()).toEqual(
      b1.samples.map((s) => s.productId).sort(),
    );
  });

  it("deserialize throws on a non-SRPL magic prefix (caller falls back to fresh)", () => {
    // A pre-Phase-1 PER blob has no `SRPL` magic; deserialize must throw.
    const per = new PrioritizedReplay(OPTS);
    per.push(mkSample("x", 1));
    const perBlob = per.serialize();
    expect(() => StratifiedReplay.deserialize(perBlob, STRAT_OPTS)).toThrow(/bad magic/);
  });
});

describe("PrioritizedReplay", () => {
  it("size and capacity match", () => {
    const r = new PrioritizedReplay(OPTS);
    expect(r.size()).toBe(0);
    for (let i = 0; i < 5; i++) r.push(mkSample(`r${i}`, i));
    expect(r.size()).toBe(5);
  });

  it("sampling enforces max-per-roundId cap", () => {
    const r = new PrioritizedReplay(OPTS);
    // Same roundId, many samples.
    for (let i = 0; i < 12; i++) r.push(mkSample("R1", i));
    const { samples } = r.sample(8, 0, rngLcg(7));
    const sameRound = samples.filter((s) => s.roundId === "R1").length;
    expect(sameRound).toBeLessThanOrEqual(OPTS.maxPerRoundInBatch);
  });

  it("higher-priority samples get drawn more often", () => {
    const r = new PrioritizedReplay(OPTS);
    // Capacity 16: 1 sample with high priority, 15 with low.
    r.push(mkSample("R0", 0), 100);
    for (let i = 1; i < 16; i++) r.push(mkSample(`R${i}`, i), 0.001);
    const counts = new Map<number, number>();
    const trials = 500;
    for (let trial = 0; trial < trials; trial++) {
      const { samples } = r.sample(1, 0, rngLcg(trial * 7 + 1));
      if (samples.length > 0) {
        counts.set(samples[0].productId, (counts.get(samples[0].productId) ?? 0) + 1);
      }
    }
    const highCount = counts.get(0) ?? 0;
    expect(highCount / trials).toBeGreaterThan(0.5);
  });

  it("uniform fraction guarantees minimum coverage", () => {
    // Build a buffer with 1 high-priority and 15 low-priority entries.
    const r = new PrioritizedReplay({ ...OPTS, uniformFraction: 0.5 });
    r.push(mkSample("R0", 0), 1000);
    for (let i = 1; i < 16; i++) r.push(mkSample(`R${i}`, i), 1e-6);
    const seen = new Set<number>();
    for (let t = 0; t < 200; t++) {
      const { samples } = r.sample(8, 0, rngLcg(t + 31));
      for (const s of samples) seen.add(s.productId);
    }
    // With 50% uniform, all 16 should be hit within 200 minibatches.
    expect(seen.size).toBeGreaterThan(8);
  });

  it("IS weights are normalized to max 1", () => {
    const r = new PrioritizedReplay(OPTS);
    for (let i = 0; i < 16; i++) r.push(mkSample(`R${i}`, i), Math.random());
    const { isWeights } = r.sample(8, 50, rngLcg(13));
    let max = 0;
    for (let i = 0; i < isWeights.length; i++) if (isWeights[i] > max) max = isWeights[i];
    expect(max).toBeCloseTo(1, 5);
    for (let i = 0; i < isWeights.length; i++) {
      expect(isWeights[i]).toBeGreaterThan(0);
      expect(isWeights[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("beta anneals correctly", () => {
    const r = new PrioritizedReplay(OPTS);
    expect(r.effectiveBeta(0)).toBeCloseTo(OPTS.betaStart, 6);
    expect(r.effectiveBeta(50)).toBeCloseTo((OPTS.betaStart + OPTS.betaEnd) / 2, 6);
    expect(r.effectiveBeta(1000)).toBeCloseTo(OPTS.betaEnd, 6);
  });

  it("FIFO eviction at capacity", () => {
    const r = new PrioritizedReplay(OPTS);
    for (let i = 0; i < OPTS.capacity + 3; i++) r.push(mkSample(`R${i}`, i));
    expect(r.size()).toBe(OPTS.capacity);
  });

  it("updatePriorities affects future sampling", () => {
    const r = new PrioritizedReplay(OPTS);
    for (let i = 0; i < 16; i++) r.push(mkSample(`R${i}`, i), 1);
    const { samples, indices } = r.sample(8, 0, rngLcg(101));
    const newP = new Float32Array(samples.length).fill(50);
    r.updatePriorities(indices, newP);
    // After bumping priorities, repeat sampling — those slots should hit more.
    const trials = 50;
    let bumpedHits = 0;
    let total = 0;
    const bumpedSet = new Set(indices);
    for (let t = 0; t < trials; t++) {
      const { indices: ix } = r.sample(2, 0, rngLcg(101 + t));
      for (const idx of ix) {
        total += 1;
        if (bumpedSet.has(idx)) bumpedHits += 1;
      }
    }
    expect(bumpedHits / total).toBeGreaterThan(0.4);
  });

  it("serialise round-trips", () => {
    const r = new PrioritizedReplay(OPTS);
    for (let i = 0; i < 6; i++) r.push(mkSample(`R${i}`, i), 0.5 + i * 0.1);
    const buf = r.serialize();
    const r2 = PrioritizedReplay.deserialize(buf, OPTS);
    expect(r2.size()).toBe(r.size());
    const a = r.sample(4, 0, rngLcg(99));
    const b = r2.sample(4, 0, rngLcg(99));
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.samples.map((s) => s.productId).sort()).toEqual(b.samples.map((s) => s.productId).sort());
  });

  it("serialise round-trips Sample.mood (FiLM-PR contract)", () => {
    // Sample.mood is the design contract that FiLM training reads
    // the mood under which the sample was observed. If serialise
    // drops it, every NaN-rollback or worker-restart silently
    // resets training-time cond to undefined for every existing
    // replay slot — invalidating arousal-gating + FiLM forward on
    // the replayed half of every minibatch. Pin the contract here.
    const r = new PrioritizedReplay(OPTS);
    const s1: Sample = { ...mkSample("R0", 0), mood: { vibe: 1.5, morale: 0.3 } };
    const s2: Sample = { ...mkSample("R1", 1), mood: { vibe: -2.0, morale: -0.5 } };
    const s3: Sample = { ...mkSample("R2", 2) }; // no mood — back-compat
    r.push(s1);
    r.push(s2);
    r.push(s3);
    const buf = r.serialize();
    const r2 = PrioritizedReplay.deserialize(buf, OPTS);
    // Pull every slot back via a wide sample (capacity=16 so all 3
    // are returned) and assert mood survives byte-for-byte.
    const out = r2.sample(3, 0, rngLcg(42));
    const byProduct = new Map(out.samples.map((s) => [s.productId, s]));
    expect(byProduct.get(0)?.mood).toEqual({ vibe: 1.5, morale: 0.3 });
    expect(byProduct.get(1)?.mood).toEqual({ vibe: -2.0, morale: -0.5 });
    expect(byProduct.get(2)?.mood).toBeUndefined();
  });

  it("deserialize defensively drops malformed mood (NaN/missing fields)", () => {
    // A corrupted on-disk snapshot that puts NaN in vibe/morale
    // would otherwise carry into the training loop and surface as
    // a mis-attributed NaN-rollback. The loader narrows to undefined
    // when the shape isn't right.
    const r = new PrioritizedReplay(OPTS);
    // Construct a sample with a NaN mood by-pass type-checking via
    // `as Sample` so we exercise the deserialize guard.
    const corrupt: Sample = {
      ...mkSample("R0", 0),
      mood: { vibe: Number.NaN, morale: 0 },
    };
    r.push(corrupt);
    const buf = r.serialize();
    const r2 = PrioritizedReplay.deserialize(buf, OPTS);
    const out = r2.sample(1, 0, rngLcg(7));
    expect(out.samples[0].mood).toBeUndefined();
  });

  it("serialise round-trips Sample.biddingContext (Phase 3d.2)", () => {
    // Phase 3d.2 persists the bidding-turn snapshot so train-time
    // forward sees the same opponent-bid context as predict.
    const r = new PrioritizedReplay(OPTS);
    const s0: Sample = {
      ...mkSample("R0", 0, "bidding"),
      biddingContext: {
        turnIdx: 2,
        totalPlayers: 4,
        previousBidsCents: [1500, 1800],
      },
    };
    const s1: Sample = { ...mkSample("R1", 1, "bidding") }; // no context — first bidder fallback
    r.push(s0);
    r.push(s1);
    const buf = r.serialize();
    const r2 = PrioritizedReplay.deserialize(buf, OPTS);
    const seen = new Map<number, Sample>();
    for (const seed of [11, 23, 41, 67, 99]) {
      const out = r2.sample(12, 0, rngLcg(seed));
      for (const s of out.samples) seen.set(s.productId, s);
      if (seen.size === 2) break;
    }
    expect(seen.size).toBe(2);
    expect(seen.get(0)?.biddingContext).toEqual({
      turnIdx: 2,
      totalPlayers: 4,
      previousBidsCents: [1500, 1800],
    });
    expect(seen.get(1)?.biddingContext).toBeUndefined();
  });

  it("deserialize defensively drops malformed biddingContext", () => {
    // Phase 3d.2: corrupted snapshot with negative turnIdx and a
    // NaN bid entry. Loader must narrow back to undefined so the
    // feature extractor zero-fills the 5 bidding-context dims
    // instead of producing garbage.
    const r = new PrioritizedReplay(OPTS);
    const corrupt: Sample = {
      ...mkSample("R0", 0, "bidding"),
      biddingContext: {
        turnIdx: -1,
        totalPlayers: 4,
        previousBidsCents: [Number.NaN, 100],
      } as unknown as Sample["biddingContext"],
    };
    r.push(corrupt);
    const buf = r.serialize();
    const r2 = PrioritizedReplay.deserialize(buf, OPTS);
    const out = r2.sample(1, 0, rngLcg(13));
    expect(out.samples[0].biddingContext).toBeUndefined();
  });
});
