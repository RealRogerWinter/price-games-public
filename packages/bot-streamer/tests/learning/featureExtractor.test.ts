import { describe, expect, it } from "vitest";
import {
  categoryIdOf,
  extractFeatures,
  FEATURE_NAMES,
  __featureInternals,
} from "../../src/learning/featureExtractor";
import {
  CATEGORY_BUCKETS,
  ENGINEERED_FEATURE_DIM,
  FEATURE_DIM,
  GAME_MODE_ORDER,
} from "../../src/learning/types";

const SAMPLE_PRODUCT = {
  id: 1,
  title: "Pro Wireless Gaming Mouse — Premium Edition",
  category: "Electronics",
  description: "An ultra-fast wireless mouse for pro gamers with leather grip.",
  imageUrl: "https://example.com/img.png",
};

describe("extractFeatures", () => {
  it("emits exactly FEATURE_DIM features", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    expect(v.length).toBe(FEATURE_DIM);
    // Phase 3d.2: 76 engineered (60 + 11 Phase-3a + 5 bidding) + 64 hashed bigrams.
    expect(v.length).toBe(140);
  });

  it("is deterministic for identical input", () => {
    const a = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    const b = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it("activates the correct mode one-hot", () => {
    const modeOffset = ENGINEERED_FEATURE_DIM - 1 - GAME_MODE_ORDER.length; // 49 - 12 = 37
    for (const mode of GAME_MODE_ORDER) {
      const v = extractFeatures({ mode, product: SAMPLE_PRODUCT });
      const idx = GAME_MODE_ORDER.indexOf(mode);
      // Mode block is offsets 37..48 (last 12 of the 50 engineered slots,
      // not counting hasPairRole which is the 50th slot).
      let active = -1;
      for (let i = 0; i < GAME_MODE_ORDER.length; i++) {
        const oneHotIdx = modeOffset + 1 + i; // skip the 27 token slots (10..36) is wrong
        // Recompute: tokens occupy indices 10..36 (27 entries),
        // modes occupy 37..48, hasPairRole at 49.
        if (v[37 + i] === 1) active = i;
      }
      expect(active).toBe(idx);
    }
  });

  it("hashed-bigram block is L2-normalised", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    let sumSq = 0;
    for (let i = ENGINEERED_FEATURE_DIM; i < FEATURE_DIM; i++) sumSq += v[i] * v[i];
    expect(sumSq).toBeCloseTo(1, 5);
  });

  it("token flags fire on matching titles", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    // pro, premium, professional? wireless, gaming, leather should all be present.
    // Token block lives at indices 10..36 (27 entries).
    const tokenBlock = Array.from(v.subarray(10, 10 + 27));
    expect(tokenBlock.some((x) => x === 1)).toBe(true);
  });

  it("no leading-engineered NaN/Inf", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true);
  });

  it("hasPairRole flips the slot just before the round-context block", () => {
    // Layout: 10 numeric + 27 tokens + 12 mode one-hot + 1 hasPairRole
    // + 10 round-context = 60 engineered. hasPairRole is at index 49.
    const PAIR_ROLE_IDX = 49;
    const a = extractFeatures({ mode: "comparison", product: SAMPLE_PRODUCT });
    const b = extractFeatures({ mode: "comparison", product: SAMPLE_PRODUCT, hasPairRole: true });
    expect(a[PAIR_ROLE_IDX]).toBe(0);
    expect(b[PAIR_ROLE_IDX]).toBe(1);
  });

  it("round-context features write into the last 10 engineered slots", () => {
    const ROUND_CTX_START = 50; // 10 + 27 + 12 + 1 = 50
    const v = extractFeatures({
      mode: "budget-builder",
      product: SAMPLE_PRODUCT,
      roundContext: {
        productCount: 5,
        budgetCents: 5000,
        targetPricesCents: [1000, 2000, 3000],
      },
    });
    // round_product_count = min(5,30)/10 = 0.5
    expect(v[ROUND_CTX_START + 0]).toBeCloseTo(0.5, 5);
    // round_has_budget = 1
    expect(v[ROUND_CTX_START + 1]).toBe(1);
    // round_log_budget = log(5001)/12 ≈ 0.71
    expect(v[ROUND_CTX_START + 2]).toBeGreaterThan(0);
    // round_has_targets = 1 (last 5 of the round-context block)
    expect(v[ROUND_CTX_START + 5]).toBe(1);
  });

  it("missing round-context leaves the round-context block at zero", () => {
    const ROUND_CTX_START = 50;
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    for (let i = 0; i < 10; i++) {
      expect(v[ROUND_CTX_START + i]).toBe(0);
    }
  });

  it("FEATURE_NAMES length matches feature dim", () => {
    expect(FEATURE_NAMES.length).toBe(FEATURE_DIM);
  });
});

describe("categoryIdOf", () => {
  it("hashes consistently into bucket range", () => {
    const c1 = categoryIdOf("Electronics", CATEGORY_BUCKETS);
    const c2 = categoryIdOf("electronics", CATEGORY_BUCKETS);
    const c3 = categoryIdOf("ELECTRONICS  ", CATEGORY_BUCKETS);
    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
    expect(c1).toBeGreaterThanOrEqual(0);
    expect(c1).toBeLessThan(CATEGORY_BUCKETS);
  });

  it("different categories tend to map to different buckets", () => {
    const seen = new Set<number>();
    for (const c of [
      "Electronics",
      "Home & Kitchen",
      "Toys",
      "Beauty",
      "Books",
      "Office",
      "Pet Supplies",
      "Garden",
      "Sports",
      "Automotive",
    ]) seen.add(categoryIdOf(c, CATEGORY_BUCKETS));
    expect(seen.size).toBeGreaterThanOrEqual(7); // collisions allowed but rare
  });
});

describe("token patterns count locked", () => {
  it("has exactly 27 patterns", () => {
    expect(__featureInternals.TOKEN_PATTERNS.length).toBe(27);
  });
});

describe("Phase 3a features", () => {
  // The 11 Phase 3a dims live at the tail of the engineered block.
  // Layout: [snapIdx, snapDistance, brandTier0, brandTier1, brandTier2,
  //          hasRange, logMin, logMax, logWidth, hasCap, logCap].
  const P3A_OFFSET = 60; // == ENGINEERED_FEATURE_DIM pre-Phase-3a

  it("brand-tier one-hot is all-zero when brandTier is undefined (unknown brand)", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    expect(v[P3A_OFFSET + 2]).toBe(0); // budget
    expect(v[P3A_OFFSET + 3]).toBe(0); // mid
    expect(v[P3A_OFFSET + 4]).toBe(0); // premium
  });

  it("brand-tier one-hot activates exactly the supplied tier", () => {
    for (const t of [0, 1, 2] as const) {
      const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT, brandTier: t });
      let count = 0;
      for (let i = 0; i < 3; i++) if (v[P3A_OFFSET + 2 + i] === 1) count += 1;
      expect(count).toBe(1);
      expect(v[P3A_OFFSET + 2 + t]).toBe(1);
    }
  });

  it("bound features are zero when priceRangeCents is absent", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    // hasRange + logMin + logMax + logWidth (4 dims at offsets 5-8 from P3A_OFFSET)
    for (let i = 5; i < 9; i++) expect(v[P3A_OFFSET + i]).toBe(0);
  });

  it("bound features populate when priceRangeCents is present", () => {
    const v = extractFeatures({
      mode: "classic",
      product: SAMPLE_PRODUCT,
      priceRangeCents: { min: 500, max: 2000 },
    });
    expect(v[P3A_OFFSET + 5]).toBe(1); // has-flag
    expect(v[P3A_OFFSET + 6]).toBeGreaterThan(0); // log-min
    expect(v[P3A_OFFSET + 7]).toBeGreaterThan(v[P3A_OFFSET + 6]); // log-max > log-min
    expect(v[P3A_OFFSET + 8]).toBeGreaterThan(0); // log-width
  });

  it("max-price-cap features populate when maxPriceCapCents is present", () => {
    const v = extractFeatures({
      mode: "riser",
      product: SAMPLE_PRODUCT,
      maxPriceCapCents: 5000,
    });
    expect(v[P3A_OFFSET + 9]).toBe(1); // has-cap
    expect(v[P3A_OFFSET + 10]).toBeGreaterThan(0); // log-cap
  });

  it("catalog-snap idx lands in [0, 1] and distance is non-negative", () => {
    const v = extractFeatures({ mode: "classic", product: SAMPLE_PRODUCT });
    expect(v[P3A_OFFSET + 0]).toBeGreaterThanOrEqual(0);
    expect(v[P3A_OFFSET + 0]).toBeLessThanOrEqual(1);
    expect(v[P3A_OFFSET + 1]).toBeGreaterThanOrEqual(0);
  });

  it("categoryIdOf reserves bucket 0 for empty / undefined categories", () => {
    expect(categoryIdOf("", CATEGORY_BUCKETS)).toBe(0);
    expect(categoryIdOf("   ", CATEGORY_BUCKETS)).toBe(0);
    // Real categories never collide with bucket 0.
    for (const c of ["Electronics", "Home", "Toys", "Beauty", "Books", "Office", "Garden"]) {
      expect(categoryIdOf(c, CATEGORY_BUCKETS)).toBeGreaterThan(0);
    }
  });
});
