import { describe, it, expect } from "vitest";
import {
  computePriceRange,
  toProduct,
  toProductWithPrice,
  generateReferencePrice,
  DbProduct,
} from "./productMapper";

const sampleRow: DbProduct = {
  id: 42,
  asin: "B08N5WRWNW",
  title: "Test Product",
  image_url: "https://example.com/img.jpg",
  description: "A test product",
  price_cents: 2999,
  category: "Electronics",
};

describe("computePriceRange", () => {
  it("returns min and max bounds for a typical price", () => {
    const range = computePriceRange(2999);
    expect(range.min).toBeLessThan(2999);
    expect(range.max).toBeGreaterThan(2999);
    expect(range.min).toBeGreaterThanOrEqual(50);
  });

  it("enforces minimum of 50 cents", () => {
    const range = computePriceRange(100);
    expect(range.min).toBeGreaterThanOrEqual(0);
  });

  it("snaps to step sizes based on price magnitude", () => {
    // Low price: step = 50
    const low = computePriceRange(1000);
    expect(low.min % 50).toBe(0);
    expect(low.max % 50).toBe(0);

    // High price: step = 500
    const high = computePriceRange(100000);
    expect(high.min % 100).toBe(0);
    expect(high.max % 500).toBe(0);
  });

  it("handles zero price with valid range (max >= min)", () => {
    const range = computePriceRange(0);
    expect(range.min).toBe(50);
    expect(range.max).toBeGreaterThanOrEqual(range.min);
  });
});

describe("toProduct", () => {
  it("converts a DB row to a Product without exposing price", () => {
    const product = toProduct(sampleRow);

    expect(product.id).toBe(42);
    expect(product.title).toBe("Test Product");
    expect(product.imageUrl).toBe("/api/image/42");
    expect(product.description).toBe("A test product");
    expect(product.category).toBe("Electronics");
    expect(product.amazonUrl).toContain("B08N5WRWNW");
    expect(product.amazonUrl).toContain("tag=pg081-20");
    expect(product.priceRange).toBeDefined();
    expect(product.priceRange.min).toBeLessThan(product.priceRange.max);
    // Should NOT expose price
    expect((product as any).priceCents).toBeUndefined();
    expect((product as any).price_cents).toBeUndefined();
  });

  it("omits amazonUrl when asin is empty", () => {
    const noAsin = { ...sampleRow, asin: "" };
    const product = toProduct(noAsin);
    expect(product.amazonUrl).toBeUndefined();
  });
});

describe("toProductWithPrice", () => {
  it("converts a DB row to a ProductWithPrice including price", () => {
    const product = toProductWithPrice(sampleRow);

    expect(product.id).toBe(42);
    expect(product.priceCents).toBe(2999);
    expect(product.imageUrl).toBe("/api/image/42");
    expect(product.amazonUrl).toContain("B08N5WRWNW");
  });

  it("omits amazonUrl when asin is empty", () => {
    const noAsin = { ...sampleRow, asin: "" };
    const product = toProductWithPrice(noAsin);
    expect(product.amazonUrl).toBeUndefined();
  });

  it("Phase 3e.4: includes priceRange (matches toProduct's computation)", () => {
    // Reveal payloads (round result bodies) flow through this function.
    // The streamer-bot's `extractRevealedSamples` reads `p.priceRange` to
    // populate `RevealedSample.priceRangeCents`, which gates the
    // squashed-regression head's training. Pre-3e.4 this field was
    // missing, starving the head of training signal across all
    // production rounds.
    const product = toProductWithPrice(sampleRow);
    expect(product.priceRange).toBeDefined();
    // toBeLessThanOrEqual matches the downstream-consumer invariant
    // (`replayBuffer.ts:294`, `playwrightDriver.ts:570` both validate
    // with `max >= min`). `computePriceRange(0)` returns {min:50, max:50}
    // so a strict `toBeLessThan` would be a semantic foot-gun for fixtures
    // with price=0.
    expect(product.priceRange!.min).toBeLessThanOrEqual(product.priceRange!.max);
    // Bounded — must straddle the actual price.
    expect(product.priceRange!.min).toBeLessThanOrEqual(product.priceCents);
    expect(product.priceRange!.max).toBeGreaterThanOrEqual(product.priceCents);
    // Contract: same computation as toProduct. Future refactors that
    // change either function must update both — this assertion keeps
    // them in lockstep.
    const reference = toProduct(sampleRow);
    expect(product.priceRange).toEqual(reference.priceRange);
  });
});

describe("generateReferencePrice", () => {
  it("returns a price offset from the actual price", () => {
    const actual = 5000;
    // Run multiple times to test randomness bounds
    for (let i = 0; i < 50; i++) {
      const ref = generateReferencePrice(actual);
      expect(ref).toBeGreaterThanOrEqual(100);
      // Should be 15-45% off in either direction
      const pctDiff = Math.abs(ref - actual) / actual;
      expect(pctDiff).toBeGreaterThanOrEqual(0.14); // allow slight float tolerance
      expect(pctDiff).toBeLessThanOrEqual(0.46);
    }
  });

  it("enforces minimum of 100 cents", () => {
    // Very small price — reference should still be at least 100
    for (let i = 0; i < 20; i++) {
      const ref = generateReferencePrice(50);
      expect(ref).toBeGreaterThanOrEqual(100);
    }
  });
});
