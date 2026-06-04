import { describe, it, expect } from "vitest";
import { estimatePriceCents, __priceEstimatorInternals } from "../src/heuristics/priceEstimator";
import { seeded } from "./_rng";

const { MIN_CENTS, MAX_CENTS, DEFAULT_BASELINE_CENTS } = __priceEstimatorInternals;

describe("estimatePriceCents", () => {
  it("returns the category baseline for a plain product", () => {
    const cents = estimatePriceCents({
      title: "USB cable",
      category: "Electronics",
      description: "Standard USB-A to USB-C cable",
    });
    // Token bumps: none. Electronics baseline is $75 (7500 cents).
    expect(cents).toBeGreaterThanOrEqual(5000);
    expect(cents).toBeLessThanOrEqual(10000);
  });

  it("nudges higher when the title contains premium tokens", () => {
    const plain = estimatePriceCents({
      title: "Speaker",
      category: "Electronics",
      description: "",
    });
    const premium = estimatePriceCents({
      title: "Pro Wireless Speaker",
      category: "Electronics",
      description: "Professional gaming-grade audio",
    });
    expect(premium).toBeGreaterThan(plain);
  });

  it("nudges lower when discount tokens dominate", () => {
    const plain = estimatePriceCents({ title: "Speaker", category: "Electronics", description: "" });
    const cheap = estimatePriceCents({
      title: "Mini Refurbished Speaker",
      category: "Electronics",
      description: "Basic generic speaker",
    });
    expect(cheap).toBeLessThan(plain);
  });

  it("falls back to a default baseline for unknown categories", () => {
    const cents = estimatePriceCents({
      title: "Mystery item",
      category: "VeryUnusualCategory",
      description: "",
    });
    // No tokens → ratio == 1.0 → exactly DEFAULT_BASELINE_CENTS.
    expect(cents).toBe(DEFAULT_BASELINE_CENTS);
  });

  it("matches partial categories like 'Electronics > Audio'", () => {
    const partial = estimatePriceCents({
      title: "Speaker",
      category: "Electronics > Audio",
      description: "",
    });
    const direct = estimatePriceCents({
      title: "Speaker",
      category: "Electronics",
      description: "",
    });
    expect(partial).toBe(direct);
  });

  it("clamps to [MIN_CENTS, MAX_CENTS]", () => {
    // Stack discount tokens to push the estimate as low as possible.
    const tiny = estimatePriceCents({
      title: "mini basic refurbished generic single",
      category: "Books", // already a low baseline
      description: "sample travel size",
    });
    expect(tiny).toBeGreaterThanOrEqual(MIN_CENTS);
    expect(tiny).toBeLessThanOrEqual(MAX_CENTS);
  });

  it("is deterministic when noise is unset and unstable when noise > 0", () => {
    const a = estimatePriceCents({ title: "x", category: "Electronics", description: "" });
    const b = estimatePriceCents({ title: "x", category: "Electronics", description: "" });
    expect(a).toBe(b);
    const c = estimatePriceCents(
      { title: "x", category: "Electronics", description: "" },
      { rng: seeded(1), noise: 0.2 },
    );
    const d = estimatePriceCents(
      { title: "x", category: "Electronics", description: "" },
      { rng: seeded(2), noise: 0.2 },
    );
    expect(c).not.toBe(d);
  });
});
