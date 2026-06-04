import { describe, it, expect } from "vitest";
import {
  getProductFingerprint,
  areVariants,
  selectComparisonPair,
  selectPriceMatchGroup,
  selectSingleProduct,
  selectOddOneOutGroup,
  selectMarketBasketGroup,
  selectSortItOutGroup,
  selectBudgetBuilderGroup,
  selectChainGroup,
  isSortedByPrice,
  shuffleNonSorted,
  CandidateProduct,
  DifficultyTier,
} from "./productPairing";

function makeProduct(overrides: Partial<CandidateProduct> & { id: number; price_cents: number }): CandidateProduct {
  return {
    title: `Product ${overrides.id}`,
    category: "Electronics",
    manufacturer: null,
    ...overrides,
  };
}

describe("getProductFingerprint", () => {
  it("extracts significant tokens, lowercased", () => {
    const fp = getProductFingerprint("Wireless Bluetooth Headphones Premium");
    expect(fp).toEqual(["wireless", "bluetooth", "headphones", "premium"]);
  });

  it("removes stop words", () => {
    const fp = getProductFingerprint("The Best Set For Kitchen And Home");
    // "the", "set", "for", "and" are stop words; "best", "kitchen", "home" remain
    expect(fp).not.toContain("the");
    expect(fp).not.toContain("set");
    expect(fp).not.toContain("for");
    expect(fp).not.toContain("and");
    expect(fp).toContain("best");
    expect(fp).toContain("kitchen");
    expect(fp).toContain("home");
  });

  it("filters short words (<= 2 chars)", () => {
    const fp = getProductFingerprint("A XL TV on the Go");
    expect(fp).not.toContain("xl");
    expect(fp).not.toContain("tv");
  });

  it("strips non-alphanumeric characters", () => {
    const fp = getProductFingerprint("Super-Duper Product™ (2024)");
    expect(fp).toContain("superduper");
  });

  it("returns at most 4 tokens", () => {
    const fp = getProductFingerprint("Alpha Beta Gamma Delta Epsilon Zeta Eta");
    expect(fp.length).toBeLessThanOrEqual(4);
  });

  it("handles empty/short titles", () => {
    expect(getProductFingerprint("")).toEqual([]);
    expect(getProductFingerprint("Hi")).toEqual([]);
  });
});

describe("areVariants", () => {
  it("returns true for similar titles", () => {
    expect(areVariants(
      "Wireless Bluetooth Headphones Black",
      "Wireless Bluetooth Headphones White"
    )).toBe(true);
  });

  it("returns false for different products", () => {
    expect(areVariants(
      "Wireless Bluetooth Headphones",
      "KitchenAid Stand Mixer"
    )).toBe(false);
  });

  it("returns false with only 1 shared token", () => {
    expect(areVariants(
      "Wireless Bluetooth Headphones",
      "Wireless Router Mesh Network"
    )).toBe(false);
  });

  it("is case insensitive", () => {
    expect(areVariants(
      "WIRELESS BLUETOOTH HEADPHONES",
      "wireless bluetooth earbuds"
    )).toBe(true);
  });
});

describe("selectComparisonPair", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 1000, title: "Cheap Widget", category: "A", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 1500, title: "Mid Widget", category: "A", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 3000, title: "Pricey Gadget", category: "A", manufacturer: "Acme" }),
    makeProduct({ id: 4, price_cents: 5000, title: "Premium Device", category: "B", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 10000, title: "Luxury Item", category: "B", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 500, title: "Budget Thing", category: "C", manufacturer: "Foxtrot" }),
  ];

  it("returns a pair of products", () => {
    const pair = selectComparisonPair("medium", candidates, new Set());
    expect(pair).not.toBeNull();
    expect(pair!.length).toBe(2);
    expect(pair![0].id).not.toBe(pair![1].id);
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const pair = selectComparisonPair("easy", candidates, usedIds);
    // Only id 6 is left, not enough for a pair
    expect(pair).toBeNull();
  });

  it("rejects variant pairs when non-variant alternatives exist", () => {
    const variantCandidates: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Wireless Bluetooth Headphones Black", category: "A" }),
      makeProduct({ id: 2, price_cents: 1200, title: "Wireless Bluetooth Headphones White", category: "A" }),
      makeProduct({ id: 3, price_cents: 1300, title: "KitchenAid Stand Mixer", category: "A" }),
      makeProduct({ id: 4, price_cents: 1150, title: "Premium Coffee Maker", category: "A" }),
    ];
    // With enough non-variant alternatives at similar prices, should avoid the variant pair
    let avoidedVariants = 0;
    for (let i = 0; i < 30; i++) {
      const pair = selectComparisonPair("medium", variantCandidates, new Set());
      if (pair) {
        const ids = new Set([pair[0].id, pair[1].id]);
        if (!(ids.has(1) && ids.has(2))) avoidedVariants++;
      }
    }
    expect(avoidedVariants).toBeGreaterThan(20);
  });

  it("returns null when insufficient candidates", () => {
    expect(selectComparisonPair("easy", [candidates[0]], new Set())).toBeNull();
    expect(selectComparisonPair("easy", [], new Set())).toBeNull();
  });

  it("prefers different manufacturers", () => {
    const sameMfr: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Product Alpha", category: "A", manufacturer: "Same" }),
      makeProduct({ id: 2, price_cents: 1500, title: "Product Beta", category: "A", manufacturer: "Same" }),
      makeProduct({ id: 3, price_cents: 1400, title: "Product Gamma", category: "A", manufacturer: "Different" }),
    ];
    // Run multiple times; should often pick products with different manufacturers
    let diffMfrCount = 0;
    for (let i = 0; i < 20; i++) {
      const pair = selectComparisonPair("medium", sameMfr, new Set());
      if (pair && pair[0].manufacturer !== pair[1].manufacturer) diffMfrCount++;
    }
    expect(diffMfrCount).toBeGreaterThan(5);
  });
});

describe("selectPriceMatchGroup", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 1000, title: "Item Alpha", category: "A", manufacturer: "M1" }),
    makeProduct({ id: 2, price_cents: 2000, title: "Item Beta", category: "A", manufacturer: "M2" }),
    makeProduct({ id: 3, price_cents: 3000, title: "Item Gamma", category: "B", manufacturer: "M3" }),
    makeProduct({ id: 4, price_cents: 4000, title: "Item Delta", category: "B", manufacturer: "M4" }),
    makeProduct({ id: 5, price_cents: 5000, title: "Item Epsilon", category: "C", manufacturer: "M5" }),
    makeProduct({ id: 6, price_cents: 6000, title: "Item Zeta", category: "C", manufacturer: "M6" }),
    makeProduct({ id: 7, price_cents: 7000, title: "Item Eta", category: "D", manufacturer: "M7" }),
    makeProduct({ id: 8, price_cents: 8000, title: "Item Theta", category: "D", manufacturer: "M8" }),
  ];

  it("returns 4 products", () => {
    const group = selectPriceMatchGroup("easy", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(4);
  });

  it("easy: selects from different categories", () => {
    const group = selectPriceMatchGroup("easy", candidates, new Set());
    if (group) {
      const cats = new Set(group.map((p) => p.category));
      expect(cats.size).toBe(4);
    }
  });

  it("returns null when not enough candidates", () => {
    expect(selectPriceMatchGroup("easy", candidates.slice(0, 3), new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const group = selectPriceMatchGroup("easy", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("no duplicate prices in group", () => {
    const samePriceCandidates: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "A Alpha", category: "A" }),
      makeProduct({ id: 2, price_cents: 1000, title: "B Beta", category: "B" }),
      makeProduct({ id: 3, price_cents: 2000, title: "C Gamma", category: "C" }),
      makeProduct({ id: 4, price_cents: 3000, title: "D Delta", category: "D" }),
      makeProduct({ id: 5, price_cents: 4000, title: "E Epsilon", category: "E" }),
    ];
    const group = selectPriceMatchGroup("easy", samePriceCandidates, new Set());
    if (group) {
      const prices = group.map((p) => p.price_cents);
      expect(new Set(prices).size).toBe(prices.length);
    }
  });
});

describe("selectSingleProduct", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 300, title: "Very Cheap" }),
    makeProduct({ id: 2, price_cents: 2000, title: "Mid Range" }),
    makeProduct({ id: 3, price_cents: 10000, title: "Standard" }),
    makeProduct({ id: 4, price_cents: 60000, title: "Expensive" }),
    makeProduct({ id: 5, price_cents: 100000, title: "Luxury" }),
  ];

  it("classic easy: prefers mid-range prices (1500-15000)", () => {
    let midCount = 0;
    for (let i = 0; i < 50; i++) {
      const p = selectSingleProduct("easy", "classic", candidates, new Set());
      if (p && p.price_cents >= 1500 && p.price_cents <= 15000) midCount++;
    }
    expect(midCount).toBeGreaterThan(30);
  });

  it("classic hard: prefers extreme prices", () => {
    let extremeCount = 0;
    for (let i = 0; i < 50; i++) {
      const p = selectSingleProduct("hard", "classic", candidates, new Set());
      if (p && (p.price_cents < 500 || p.price_cents > 50000)) extremeCount++;
    }
    expect(extremeCount).toBeGreaterThan(30);
  });

  it("classic medium: any price", () => {
    const p = selectSingleProduct("medium", "classic", candidates, new Set());
    expect(p).not.toBeNull();
  });

  it("higher-lower: any price regardless of difficulty", () => {
    const p = selectSingleProduct("easy", "higher-lower", candidates, new Set());
    expect(p).not.toBeNull();
  });

  it("riser: any price regardless of difficulty", () => {
    const p = selectSingleProduct("hard", "riser", candidates, new Set());
    expect(p).not.toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const p = selectSingleProduct("medium", "classic", candidates, usedIds);
    expect(p).toBeNull();
  });

  it("returns null for empty candidates", () => {
    expect(selectSingleProduct("easy", "classic", [], new Set())).toBeNull();
  });

  it("falls back to all available when tier filter is too restrictive", () => {
    const onlyMidRange = [makeProduct({ id: 1, price_cents: 5000, title: "Only Mid" })];
    // Hard tier wants <500 or >50000, but only mid-range available — should fallback
    const p = selectSingleProduct("hard", "classic", onlyMidRange, new Set());
    expect(p).not.toBeNull();
    expect(p!.id).toBe(1);
  });
});

describe("selectOddOneOutGroup", () => {
  // Diverse candidates: a cluster of similar prices and some outliers
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 1000, title: "Widget Alpha", category: "Electronics", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 1050, title: "Widget Beta", category: "Electronics", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 1100, title: "Gadget Gamma", category: "Kitchen", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 5000, title: "Premium Delta", category: "Sports", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 8000, title: "Luxury Epsilon", category: "Fashion", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 950, title: "Budget Zeta", category: "Home", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 15000, title: "Supreme Eta", category: "Tech", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 1080, title: "Standard Theta", category: "Office", manufacturer: "Homer" }),
  ];

  it("returns 4 products", () => {
    const group = selectOddOneOutGroup("easy", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(4);
  });

  it("returns null with insufficient candidates", () => {
    expect(selectOddOneOutGroup("easy", candidates.slice(0, 3), new Set())).toBeNull();
    expect(selectOddOneOutGroup("medium", [], new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const group = selectOddOneOutGroup("easy", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("returns null when all candidates are used", () => {
    const usedIds = new Set(candidates.map((c) => c.id));
    expect(selectOddOneOutGroup("easy", candidates, usedIds)).toBeNull();
  });

  it("handles fallback when ideal cluster+outlier selection is not possible", () => {
    // All products have very similar prices — hard to find an outlier
    const similarPrices: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Item Alpha", category: "A" }),
      makeProduct({ id: 2, price_cents: 1010, title: "Item Beta", category: "B" }),
      makeProduct({ id: 3, price_cents: 1020, title: "Item Gamma", category: "C" }),
      makeProduct({ id: 4, price_cents: 1030, title: "Item Delta", category: "D" }),
    ];
    // Should still return 4 products via fallback
    const group = selectOddOneOutGroup("easy", similarPrices, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(4);
  });

  it("returns unique product ids within the group", () => {
    for (let i = 0; i < 10; i++) {
      const group = selectOddOneOutGroup("medium", candidates, new Set());
      if (group) {
        const ids = group.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("works across all difficulty levels", () => {
    for (const diff of ["easy", "medium", "hard"] as DifficultyTier[]) {
      const group = selectOddOneOutGroup(diff, candidates, new Set());
      expect(group).not.toBeNull();
      expect(group!.length).toBe(4);
    }
  });
});

describe("selectMarketBasketGroup", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 500, title: "Cheap Pen", category: "Office", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 1200, title: "Notebook Journal", category: "Office", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 2500, title: "Kitchen Knife", category: "Kitchen", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 3500, title: "Mixing Bowl", category: "Kitchen", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 5000, title: "Running Shoes", category: "Sports", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 7500, title: "Yoga Mat", category: "Sports", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 9000, title: "Desk Lamp", category: "Home", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 12000, title: "Wall Clock", category: "Home", manufacturer: "Homer" }),
    makeProduct({ id: 9, price_cents: 15000, title: "Bluetooth Speaker", category: "Electronics", manufacturer: "Ion" }),
    makeProduct({ id: 10, price_cents: 20000, title: "Wireless Earbuds", category: "Electronics", manufacturer: "Jade" }),
  ];

  it("easy returns 3 products", () => {
    const group = selectMarketBasketGroup("easy", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(3);
  });

  it("medium returns 5 products", () => {
    const group = selectMarketBasketGroup("medium", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });

  it("hard returns 6 products", () => {
    const group = selectMarketBasketGroup("hard", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(6);
  });

  it("returns null with insufficient candidates for easy", () => {
    expect(selectMarketBasketGroup("easy", candidates.slice(0, 2), new Set())).toBeNull();
  });

  it("returns null with insufficient candidates for medium", () => {
    expect(selectMarketBasketGroup("medium", candidates.slice(0, 4), new Set())).toBeNull();
  });

  it("returns null with insufficient candidates for hard", () => {
    expect(selectMarketBasketGroup("hard", candidates.slice(0, 5), new Set())).toBeNull();
  });

  it("returns null for empty candidates", () => {
    expect(selectMarketBasketGroup("easy", [], new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    const group = selectMarketBasketGroup("easy", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("returns null when too many candidates are used", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only 1 available, need 3 for easy
    expect(selectMarketBasketGroup("easy", candidates, usedIds)).toBeNull();
  });

  it("prefers diverse categories", () => {
    let diverseCount = 0;
    for (let i = 0; i < 20; i++) {
      const group = selectMarketBasketGroup("easy", candidates, new Set());
      if (group) {
        const cats = new Set(group.map((p) => p.category));
        if (cats.size === group.length) diverseCount++;
      }
    }
    // Should often pick from different categories
    expect(diverseCount).toBeGreaterThan(10);
  });

  it("returns unique product ids within the group", () => {
    for (let i = 0; i < 10; i++) {
      const group = selectMarketBasketGroup("hard", candidates, new Set());
      if (group) {
        const ids = group.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("handles fallback when fewer categories than needed", () => {
    // All same category — should still return the right count
    const sameCategory: CandidateProduct[] = Array.from({ length: 8 }, (_, i) =>
      makeProduct({ id: i + 1, price_cents: (i + 1) * 1000, title: `Item ${String.fromCharCode(65 + i)}`, category: "Same" })
    );
    const group = selectMarketBasketGroup("hard", sameCategory, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(6);
  });
});

describe("selectSortItOutGroup", () => {
  // Products with well-spread prices for easy selection, and tighter prices for harder tests
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 200, title: "Tiny Trinket", category: "Toys", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 500, title: "Small Gadget", category: "Electronics", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 1500, title: "Medium Widget", category: "Kitchen", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 4000, title: "Large Device", category: "Home", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 10000, title: "Premium Item", category: "Sports", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 25000, title: "Luxury Product", category: "Fashion", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 60000, title: "Ultra Expensive", category: "Tech", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 3000, title: "Standard Tool", category: "Office", manufacturer: "Homer" }),
    makeProduct({ id: 9, price_cents: 7500, title: "Quality Appliance", category: "Kitchen", manufacturer: "Ion" }),
    makeProduct({ id: 10, price_cents: 18000, title: "High-End Gear", category: "Sports", manufacturer: "Jade" }),
  ];

  it("returns 5 products", () => {
    const group = selectSortItOutGroup("medium", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });

  it("returns null with insufficient candidates", () => {
    expect(selectSortItOutGroup("easy", candidates.slice(0, 4), new Set())).toBeNull();
    expect(selectSortItOutGroup("hard", [], new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6]);
    const group = selectSortItOutGroup("easy", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("returns null when too many candidates used", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only 1 available, need 5
    expect(selectSortItOutGroup("easy", candidates, usedIds)).toBeNull();
  });

  it("returns unique product ids within the group", () => {
    for (let i = 0; i < 10; i++) {
      const group = selectSortItOutGroup("medium", candidates, new Set());
      if (group) {
        const ids = group.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("handles fallback when ideal spread selection is not possible", () => {
    // Very tight prices — hard to get good spread, but fallback should still work
    const tightPrices: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Item Alpha", category: "A" }),
      makeProduct({ id: 2, price_cents: 1010, title: "Item Beta", category: "B" }),
      makeProduct({ id: 3, price_cents: 1020, title: "Item Gamma", category: "C" }),
      makeProduct({ id: 4, price_cents: 1030, title: "Item Delta", category: "D" }),
      makeProduct({ id: 5, price_cents: 1040, title: "Item Epsilon", category: "E" }),
    ];
    const group = selectSortItOutGroup("easy", tightPrices, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });

  it("works across all difficulty levels", () => {
    for (const diff of ["easy", "medium", "hard"] as DifficultyTier[]) {
      const group = selectSortItOutGroup(diff, candidates, new Set());
      expect(group).not.toBeNull();
      expect(group!.length).toBe(5);
    }
  });

  it("avoids duplicate prices when possible", () => {
    const withDupes: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Alpha Gadget", category: "A" }),
      makeProduct({ id: 2, price_cents: 1000, title: "Beta Widget", category: "B" }),
      makeProduct({ id: 3, price_cents: 2000, title: "Gamma Device", category: "C" }),
      makeProduct({ id: 4, price_cents: 3000, title: "Delta Tool", category: "D" }),
      makeProduct({ id: 5, price_cents: 4000, title: "Epsilon Gear", category: "E" }),
      makeProduct({ id: 6, price_cents: 5000, title: "Zeta Product", category: "F" }),
    ];
    let noDupeCount = 0;
    for (let i = 0; i < 20; i++) {
      const group = selectSortItOutGroup("medium", withDupes, new Set());
      if (group) {
        const prices = group.map((p) => p.price_cents);
        if (new Set(prices).size === prices.length) noDupeCount++;
      }
    }
    // Should mostly avoid duplicate prices
    expect(noDupeCount).toBeGreaterThan(10);
  });
});

describe("selectBudgetBuilderGroup", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 300, title: "Pencil Set", category: "Office", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 800, title: "Notepad Bundle", category: "Office", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 1500, title: "Coffee Mug", category: "Kitchen", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 2500, title: "Water Bottle", category: "Sports", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 4000, title: "Phone Case", category: "Electronics", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 6000, title: "Desk Organizer", category: "Home", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 8500, title: "Backpack Travel", category: "Fashion", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 12000, title: "Wireless Mouse", category: "Tech", manufacturer: "Homer" }),
    makeProduct({ id: 9, price_cents: 18000, title: "Noise Cancelling Headphones", category: "Electronics", manufacturer: "Ion" }),
    makeProduct({ id: 10, price_cents: 25000, title: "Smartwatch Band", category: "Tech", manufacturer: "Jade" }),
  ];

  it("returns 6 products", () => {
    const group = selectBudgetBuilderGroup("medium", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(6);
  });

  it("returns null with insufficient candidates", () => {
    expect(selectBudgetBuilderGroup("easy", candidates.slice(0, 5), new Set())).toBeNull();
    expect(selectBudgetBuilderGroup("hard", [], new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const group = selectBudgetBuilderGroup("easy", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("returns null when too many candidates used", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only 1 available, need 6
    expect(selectBudgetBuilderGroup("easy", candidates, usedIds)).toBeNull();
  });

  it("returns unique product ids within the group", () => {
    for (let i = 0; i < 10; i++) {
      const group = selectBudgetBuilderGroup("medium", candidates, new Set());
      if (group) {
        const ids = group.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("prefers distinct prices", () => {
    let distinctPriceCount = 0;
    for (let i = 0; i < 20; i++) {
      const group = selectBudgetBuilderGroup("easy", candidates, new Set());
      if (group) {
        const prices = group.map((p) => p.price_cents);
        if (new Set(prices).size === prices.length) distinctPriceCount++;
      }
    }
    expect(distinctPriceCount).toBeGreaterThan(10);
  });

  it("handles fallback when many products are variants", () => {
    // Variant-heavy list — should still return 6 via fill logic
    const variantHeavy: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Wireless Bluetooth Headphones Black", category: "A" }),
      makeProduct({ id: 2, price_cents: 1100, title: "Wireless Bluetooth Headphones White", category: "A" }),
      makeProduct({ id: 3, price_cents: 1200, title: "Wireless Bluetooth Headphones Red", category: "A" }),
      makeProduct({ id: 4, price_cents: 2000, title: "Kitchen Stand Mixer Silver", category: "B" }),
      makeProduct({ id: 5, price_cents: 3000, title: "Premium Coffee Grinder", category: "C" }),
      makeProduct({ id: 6, price_cents: 4000, title: "Digital Alarm Clock", category: "D" }),
      makeProduct({ id: 7, price_cents: 5000, title: "Stainless Water Bottle", category: "E" }),
    ];
    const group = selectBudgetBuilderGroup("medium", variantHeavy, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(6);
  });

  it("works across all difficulty levels", () => {
    for (const diff of ["easy", "medium", "hard"] as DifficultyTier[]) {
      const group = selectBudgetBuilderGroup(diff, candidates, new Set());
      expect(group).not.toBeNull();
      expect(group!.length).toBe(6);
    }
  });

  it("returns exactly 6 even with many more candidates", () => {
    const largeCandidates: CandidateProduct[] = Array.from({ length: 50 }, (_, i) =>
      makeProduct({ id: i + 1, price_cents: (i + 1) * 500, title: `Product ${String.fromCharCode(65 + (i % 26))} ${i}`, category: `Cat${i % 10}` })
    );
    const group = selectBudgetBuilderGroup("hard", largeCandidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(6);
  });
});

describe("selectChainGroup", () => {
  // Prices with good ascending spread for chain construction
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 500, title: "Tiny Paperclip", category: "Office", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 1000, title: "Ballpoint Pen", category: "Office", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 2000, title: "Hardcover Notebook", category: "Stationery", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 4000, title: "Desk Calendar", category: "Home", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 8000, title: "Mechanical Keyboard", category: "Tech", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 16000, title: "Monitor Stand", category: "Tech", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 32000, title: "Ergonomic Chair", category: "Furniture", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 3000, title: "Ceramic Planter", category: "Home", manufacturer: "Homer" }),
    makeProduct({ id: 9, price_cents: 6000, title: "Bluetooth Adapter", category: "Electronics", manufacturer: "Ion" }),
    makeProduct({ id: 10, price_cents: 12000, title: "Portable Charger", category: "Electronics", manufacturer: "Jade" }),
  ];

  it("returns 5 products", () => {
    const group = selectChainGroup("medium", candidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });

  it("returns null with insufficient candidates", () => {
    expect(selectChainGroup("easy", candidates.slice(0, 4), new Set())).toBeNull();
    expect(selectChainGroup("hard", [], new Set())).toBeNull();
  });

  it("respects usedIds", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6]);
    const group = selectChainGroup("medium", candidates, usedIds);
    if (group) {
      for (const p of group) {
        expect(usedIds.has(p.id)).toBe(false);
      }
    }
  });

  it("returns null when too many candidates used", () => {
    const usedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only 1 available, need 5
    expect(selectChainGroup("easy", candidates, usedIds)).toBeNull();
  });

  it("returns unique product ids within the group", () => {
    for (let i = 0; i < 10; i++) {
      const group = selectChainGroup("medium", candidates, new Set());
      if (group) {
        const ids = group.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("handles fallback when ideal chain spread is not possible", () => {
    // Very tight prices — hard to get chain spread, but fallback should work
    const tightPrices: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Chain Alpha", category: "A" }),
      makeProduct({ id: 2, price_cents: 1005, title: "Chain Beta", category: "B" }),
      makeProduct({ id: 3, price_cents: 1010, title: "Chain Gamma", category: "C" }),
      makeProduct({ id: 4, price_cents: 1015, title: "Chain Delta", category: "D" }),
      makeProduct({ id: 5, price_cents: 1020, title: "Chain Epsilon", category: "E" }),
    ];
    const group = selectChainGroup("easy", tightPrices, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });

  it("works across all difficulty levels", () => {
    for (const diff of ["easy", "medium", "hard"] as DifficultyTier[]) {
      const group = selectChainGroup(diff, candidates, new Set());
      expect(group).not.toBeNull();
      expect(group!.length).toBe(5);
    }
  });

  it("avoids duplicate prices when possible", () => {
    let noDupeCount = 0;
    for (let i = 0; i < 20; i++) {
      const group = selectChainGroup("medium", candidates, new Set());
      if (group) {
        const prices = group.map((p) => p.price_cents);
        if (new Set(prices).size === prices.length) noDupeCount++;
      }
    }
    expect(noDupeCount).toBeGreaterThan(10);
  });

  it("returns exactly 5 even with many more candidates", () => {
    const largeCandidates: CandidateProduct[] = Array.from({ length: 30 }, (_, i) =>
      makeProduct({ id: i + 1, price_cents: (i + 1) * 1000, title: `Chain Link ${String.fromCharCode(65 + (i % 26))} ${i}`, category: `Cat${i % 6}` })
    );
    const group = selectChainGroup("hard", largeCandidates, new Set());
    expect(group).not.toBeNull();
    expect(group!.length).toBe(5);
  });
});

describe("isSortedByPrice", () => {
  it("returns true for ascending price order", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 200 }),
      makeProduct({ id: 3, price_cents: 300 }),
    ];
    expect(isSortedByPrice(products)).toBe(true);
  });

  it("returns true for equal prices (non-strictly sorted)", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 100 }),
      makeProduct({ id: 3, price_cents: 200 }),
    ];
    expect(isSortedByPrice(products)).toBe(true);
  });

  it("returns false for descending order", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 300 }),
      makeProduct({ id: 2, price_cents: 200 }),
      makeProduct({ id: 3, price_cents: 100 }),
    ];
    expect(isSortedByPrice(products)).toBe(false);
  });

  it("returns false when any element is out of order", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 300 }),
      makeProduct({ id: 3, price_cents: 200 }),
    ];
    expect(isSortedByPrice(products)).toBe(false);
  });

  it("returns true for single-element array", () => {
    expect(isSortedByPrice([makeProduct({ id: 1, price_cents: 500 })])).toBe(true);
  });

  it("returns true for empty array", () => {
    expect(isSortedByPrice([])).toBe(true);
  });
});

describe("shuffleNonSorted", () => {
  it("never returns products in ascending price order", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 200 }),
      makeProduct({ id: 3, price_cents: 300 }),
      makeProduct({ id: 4, price_cents: 400 }),
      makeProduct({ id: 5, price_cents: 500 }),
    ];
    for (let i = 0; i < 500; i++) {
      const copy = [...products];
      shuffleNonSorted(copy);
      expect(isSortedByPrice(copy)).toBe(false);
    }
  });

  it("produces randomized results (at least 2 distinct orderings in 20 runs)", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 200 }),
      makeProduct({ id: 3, price_cents: 300 }),
      makeProduct({ id: 4, price_cents: 400 }),
      makeProduct({ id: 5, price_cents: 500 }),
    ];
    const orderings = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const copy = [...products];
      shuffleNonSorted(copy);
      orderings.add(copy.map((p) => p.id).join(","));
    }
    expect(orderings.size).toBeGreaterThanOrEqual(2);
  });

  it("handles 2-element array", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 200 }),
    ];
    for (let i = 0; i < 100; i++) {
      const copy = [...products];
      shuffleNonSorted(copy);
      expect(isSortedByPrice(copy)).toBe(false);
    }
  });

  it("returns the same array reference (mutates in place)", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 200 }),
    ];
    const result = shuffleNonSorted(products);
    expect(result).toBe(products);
  });

  it("does not break single-element array", () => {
    const products = [makeProduct({ id: 1, price_cents: 100 })];
    const result = shuffleNonSorted(products);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(1);
  });

  it("still shuffles when all prices are equal (swap is a no-op but shuffle occurs)", () => {
    const products = [
      makeProduct({ id: 1, price_cents: 100 }),
      makeProduct({ id: 2, price_cents: 100 }),
      makeProduct({ id: 3, price_cents: 100 }),
    ];
    // With equal prices, isSortedByPrice is always true, so the swap fires
    // but doesn't break sorted order. The array is still shuffled by Fisher-Yates.
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const copy = [...products];
      shuffleNonSorted(copy);
      orderings.add(copy.map((p) => p.id).join(","));
      expect(copy.length).toBe(3);
    }
    // Fisher-Yates still randomizes element positions even with equal prices
    expect(orderings.size).toBeGreaterThanOrEqual(2);
  });
});

describe("selectSortItOutGroup — shuffle guarantee", () => {
  const candidates: CandidateProduct[] = [
    makeProduct({ id: 1, price_cents: 200, title: "Tiny Trinket", category: "Toys", manufacturer: "Acme" }),
    makeProduct({ id: 2, price_cents: 500, title: "Small Gadget", category: "Electronics", manufacturer: "Beta" }),
    makeProduct({ id: 3, price_cents: 1500, title: "Medium Widget", category: "Kitchen", manufacturer: "Cook" }),
    makeProduct({ id: 4, price_cents: 4000, title: "Large Device", category: "Home", manufacturer: "Delta" }),
    makeProduct({ id: 5, price_cents: 10000, title: "Premium Item", category: "Sports", manufacturer: "Elite" }),
    makeProduct({ id: 6, price_cents: 25000, title: "Luxury Product", category: "Fashion", manufacturer: "Foxtrot" }),
    makeProduct({ id: 7, price_cents: 60000, title: "Ultra Expensive", category: "Tech", manufacturer: "Giga" }),
    makeProduct({ id: 8, price_cents: 3000, title: "Standard Tool", category: "Office", manufacturer: "Homer" }),
    makeProduct({ id: 9, price_cents: 7500, title: "Quality Appliance", category: "Kitchen", manufacturer: "Ion" }),
    makeProduct({ id: 10, price_cents: 18000, title: "High-End Gear", category: "Sports", manufacturer: "Jade" }),
  ];

  it("never returns products in ascending price order (500 iterations)", () => {
    for (let i = 0; i < 500; i++) {
      const group = selectSortItOutGroup("medium", candidates, new Set());
      expect(group).not.toBeNull();
      const sorted = [...group!].sort((a, b) => a.price_cents - b.price_cents);
      const isAscending = group!.every((p, idx) => p.id === sorted[idx].id);
      expect(isAscending).toBe(false);
    }
  });

  it("produces randomized results (at least 2 distinct orderings in 20 runs)", () => {
    const orderings = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const group = selectSortItOutGroup("medium", candidates, new Set());
      if (group) {
        orderings.add(group.map((p) => p.id).join(","));
      }
    }
    expect(orderings.size).toBeGreaterThanOrEqual(2);
  });

  it("fallback path also shuffles (tight-priced candidates)", () => {
    const tightPrices: CandidateProduct[] = [
      makeProduct({ id: 1, price_cents: 1000, title: "Item Alpha", category: "A" }),
      makeProduct({ id: 2, price_cents: 1010, title: "Item Beta", category: "B" }),
      makeProduct({ id: 3, price_cents: 1020, title: "Item Gamma", category: "C" }),
      makeProduct({ id: 4, price_cents: 1030, title: "Item Delta", category: "D" }),
      makeProduct({ id: 5, price_cents: 1040, title: "Item Epsilon", category: "E" }),
    ];
    for (let i = 0; i < 500; i++) {
      const group = selectSortItOutGroup("easy", tightPrices, new Set());
      expect(group).not.toBeNull();
      const sorted = [...group!].sort((a, b) => a.price_cents - b.price_cents);
      const isAscending = group!.every((p, idx) => p.id === sorted[idx].id);
      expect(isAscending).toBe(false);
    }
  });
});
