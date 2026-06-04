/**
 * Tests for the canonical-prices catalog. The catalog defines the
 * discrete output space of the priceClass head: a sorted list of
 * realistic retail prices in cents that the model classifies into.
 */

import { describe, it, expect } from "vitest";
import {
  buildDefaultCatalog,
  buildCatalogFromObservations,
  type PriceCatalog,
} from "../../src/learning/priceCatalog";
import { topKCatalogCandidates } from "../../src/learning/workerCore";

describe("buildDefaultCatalog", () => {
  let cat: PriceCatalog;

  it("produces a non-trivial number of entries", () => {
    cat = buildDefaultCatalog();
    expect(cat.K).toBeGreaterThan(50);
    expect(cat.K).toBeLessThan(500);
    expect(cat.prices.length).toBe(cat.K);
  });

  it("is sorted ascending", () => {
    cat = buildDefaultCatalog();
    for (let i = 1; i < cat.prices.length; i++) {
      expect(cat.prices[i]).toBeGreaterThan(cat.prices[i - 1]);
    }
  });

  it("covers the typical Amazon range ($0.49 → $1000+)", () => {
    cat = buildDefaultCatalog();
    expect(cat.prices[0]).toBeLessThanOrEqual(100); // ≤ $1.00
    expect(cat.prices[cat.prices.length - 1]).toBeGreaterThanOrEqual(100_000); // ≥ $1000
  });

  it("includes the common psychological endings (.99, .49)", () => {
    cat = buildDefaultCatalog();
    expect(cat.prices).toContain(99); // $0.99
    expect(cat.prices).toContain(199); // $1.99
    expect(cat.prices).toContain(999); // $9.99
    expect(cat.prices).toContain(1999); // $19.99
  });

  it("logPrices is the natural log of prices", () => {
    cat = buildDefaultCatalog();
    for (let i = 0; i < cat.K; i++) {
      expect(cat.logPrices[i]).toBeCloseTo(Math.log(cat.prices[i]), 5);
    }
  });
});

describe("PriceCatalog.snap", () => {
  it("snaps an exact match to its own index", () => {
    const cat = buildDefaultCatalog();
    const idx = cat.prices.indexOf(999);
    expect(cat.snap(999)).toBe(idx);
  });

  it("snaps to the closest catalog price by absolute log distance", () => {
    const cat = buildDefaultCatalog();
    // 1050 is between 999 ($9.99) and 1099 ($10.99) — pick the nearer
    // log-distance match. log(1050/999) ≈ 0.0498, log(1099/1050) ≈ 0.0456 → 1099.
    const got = cat.snap(1050);
    expect(cat.prices[got]).toBe(1099);
  });

  it("clamps to first index for sub-minimum input", () => {
    const cat = buildDefaultCatalog();
    expect(cat.snap(1)).toBe(0);
    expect(cat.snap(10)).toBe(0);
  });

  it("clamps to last index for above-maximum input", () => {
    const cat = buildDefaultCatalog();
    expect(cat.snap(10_000_000)).toBe(cat.K - 1);
  });

  it("non-finite inputs snap to a stable index (no NaN propagation)", () => {
    const cat = buildDefaultCatalog();
    expect(Number.isFinite(cat.snap(Number.NaN))).toBe(true);
    expect(Number.isFinite(cat.snap(Infinity))).toBe(true);
    expect(Number.isFinite(cat.snap(-Infinity))).toBe(true);
  });
});

describe("buildCatalogFromObservations", () => {
  it("returns the default catalog when fed an empty list", () => {
    const cat = buildCatalogFromObservations([]);
    const def = buildDefaultCatalog();
    expect(cat.K).toBe(def.K);
  });

  it("includes prices observed ≥2 times that are missing from the default", () => {
    // 1234 cents is not a default-catalog entry. Observe it 3×: it
    // should appear in the resulting catalog.
    const cat = buildCatalogFromObservations([1234, 1234, 1234]);
    expect(cat.prices).toContain(1234);
  });

  it("excludes prices observed only once (avoids overfitting to outliers)", () => {
    const cat = buildCatalogFromObservations([7777]);
    expect(cat.prices).not.toContain(7777);
  });

  it("caps the catalog size at MAX_K (cost control)", () => {
    // Feed in 1000 unique prices; output K should be capped.
    const obs: number[] = [];
    for (let i = 0; i < 1000; i++) {
      obs.push(50000 + i * 7);
      obs.push(50000 + i * 7); // observed twice each
    }
    const cat = buildCatalogFromObservations(obs);
    expect(cat.K).toBeLessThanOrEqual(300);
  });

  it("output is sorted ascending and contains no duplicates", () => {
    const cat = buildCatalogFromObservations([1234, 1234, 999, 999, 999]);
    for (let i = 1; i < cat.prices.length; i++) {
      expect(cat.prices[i]).toBeGreaterThan(cat.prices[i - 1]);
    }
  });
});

describe("topKCatalogCandidates", () => {
  // Tiny synthetic catalog so the asserts pin specific cents values.
  const tiny: PriceCatalog = {
    prices: [100, 500, 999, 1999, 4999],
    K: 5,
    logPrices: [Math.log(100), Math.log(500), Math.log(999), Math.log(1999), Math.log(4999)],
    snap: () => 0,
  };

  it("returns the top-K (cents, prob) pairs sorted by probability desc", () => {
    // Float32 can't store 0.18 / 0.10 exactly so the readback loses
    // precision; assert cents exactly + probs within ε.
    const probs = new Float32Array([0.05, 0.62, 0.18, 0.10, 0.05]);
    const out = topKCatalogCandidates(probs, tiny, 3);
    expect(out.length).toBe(3);
    expect(out[0].cents).toBe(500);
    expect(out[0].prob).toBeCloseTo(0.62, 4);
    expect(out[1].cents).toBe(999);
    expect(out[1].prob).toBeCloseTo(0.18, 4);
    expect(out[2].cents).toBe(1999);
    expect(out[2].prob).toBeCloseTo(0.10, 4);
  });

  it("returns at most k entries (k < K)", () => {
    const probs = new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]);
    const out = topKCatalogCandidates(probs, tiny, 2);
    expect(out.length).toBe(2);
  });

  it("returns at most K entries when k > K", () => {
    const probs = new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]);
    const out = topKCatalogCandidates(probs, tiny, 10);
    expect(out.length).toBe(5);
  });

  it("returns [] when ANY probability is non-finite (broken-network state)", () => {
    // Mid-array NaN bail must short-circuit, not produce partial output.
    const probsNaN = new Float32Array([0.2, 0.2, Number.NaN, 0.2, 0.2]);
    expect(topKCatalogCandidates(probsNaN, tiny, 3)).toEqual([]);
    const probsInf = new Float32Array([0.2, 0.2, 0.2, 0.2, Number.POSITIVE_INFINITY]);
    expect(topKCatalogCandidates(probsInf, tiny, 3)).toEqual([]);
  });

  it("returns [] for an empty probs buffer", () => {
    expect(topKCatalogCandidates(new Float32Array(0), tiny, 3)).toEqual([]);
  });

  it("ties resolve deterministically (stable sort by index)", () => {
    // All-equal probs: with a stable sort we'd get prices in catalog
    // order; with an unstable sort the test asserts only the *count*.
    // V8's Array.prototype.sort is stable as of Node 12, so we can
    // assert order. If a future engine change breaks this we just
    // tighten to an order-independent assertion.
    const probs = new Float32Array([0.2, 0.2, 0.2, 0.2, 0.2]);
    const out = topKCatalogCandidates(probs, tiny, 5);
    expect(out.map((c) => c.cents)).toEqual([100, 500, 999, 1999, 4999]);
  });
});
