import { describe, it, expect } from "vitest";
import type { GameMode, BotDifficulty, RoundStartPayload } from "@price-game/shared";
import { generateBotGuess, snapToRetail } from "./botGuess";

/** Helper to create product price maps */
function priceMap(entries: Array<[number, number]>): Map<number, number> {
  return new Map(entries);
}

/** Helper to build a minimal RoundStartPayload */
function payload(overrides: Partial<RoundStartPayload> = {}): RoundStartPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    timerSeconds: 30,
    product: { id: 1, title: "Widget", imageUrl: "", description: "", category: "Electronics" },
    ...overrides,
  };
}

describe("generateBotGuess", () => {
  describe("classic mode", () => {
    it("returns a guessedPriceCents number", () => {
      const guess = generateBotGuess("classic", "medium", payload(), priceMap([[1, 5000]]));
      expect(guess).toHaveProperty("guessedPriceCents");
      expect(typeof (guess as any).guessedPriceCents).toBe("number");
      expect((guess as any).guessedPriceCents).toBeGreaterThan(0);
    });
  });

  describe("higher-lower mode", () => {
    it("returns a higher or lower guess", () => {
      const p = payload({ gameMode: "higher-lower", referencePrice: 4000 });
      const guess = generateBotGuess("higher-lower", "medium", p, priceMap([[1, 5000]]));
      expect(guess).toHaveProperty("guess");
      expect(["higher", "lower"]).toContain((guess as any).guess);
    });
  });

  describe("comparison mode", () => {
    it("returns a guessedProductId", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "comparison", products, question: "most-expensive" });
      const guess = generateBotGuess("comparison", "medium", p, priceMap([[1, 3000], [2, 7000]]));
      expect(guess).toHaveProperty("guessedProductId");
      expect([1, 2]).toContain((guess as any).guessedProductId);
    });
  });

  describe("closest-without-going-over mode", () => {
    it("returns a guessedPriceCents number", () => {
      const guess = generateBotGuess("closest-without-going-over", "medium", payload({ gameMode: "closest-without-going-over" }), priceMap([[1, 5000]]));
      expect(guess).toHaveProperty("guessedPriceCents");
      expect((guess as any).guessedPriceCents).toBeGreaterThan(0);
    });
  });

  describe("price-match mode", () => {
    it("returns assignments record", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
        { id: 3, title: "C", imageUrl: "", description: "", category: "Electronics" },
        { id: 4, title: "D", imageUrl: "", description: "", category: "Electronics" },
      ];
      const prices = [1000, 2000, 3000, 4000];
      const p = payload({ gameMode: "price-match", products, prices });
      const guess = generateBotGuess("price-match", "medium", p, priceMap([[1, 1000], [2, 2000], [3, 3000], [4, 4000]]));
      expect(guess).toHaveProperty("assignments");
      const assignments = (guess as any).assignments;
      expect(Object.keys(assignments).length).toBe(4);
    });
  });

  describe("riser mode", () => {
    it("returns stoppedPriceCents", () => {
      const p = payload({ gameMode: "riser", maxPriceCents: 10000 });
      const guess = generateBotGuess("riser", "medium", p, priceMap([[1, 5000]]));
      expect(guess).toHaveProperty("stoppedPriceCents");
      expect((guess as any).stoppedPriceCents).toBeGreaterThan(0);
    });
  });

  describe("odd-one-out mode", () => {
    it("returns guessedProductId", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
        { id: 3, title: "C", imageUrl: "", description: "", category: "Electronics" },
        { id: 4, title: "D", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "odd-one-out", products });
      const guess = generateBotGuess("odd-one-out", "medium", p, priceMap([[1, 1000], [2, 1100], [3, 1050], [4, 5000]]));
      expect(guess).toHaveProperty("guessedProductId");
      expect([1, 2, 3, 4]).toContain((guess as any).guessedProductId);
    });
  });

  describe("market-basket mode", () => {
    it("returns guessedTotalCents", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "market-basket", products });
      const guess = generateBotGuess("market-basket", "medium", p, priceMap([[1, 3000], [2, 5000]]));
      expect(guess).toHaveProperty("guessedTotalCents");
      expect((guess as any).guessedTotalCents).toBeGreaterThan(0);
    });
  });

  describe("sort-it-out mode", () => {
    it("returns submittedOrder array", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
        { id: 3, title: "C", imageUrl: "", description: "", category: "Electronics" },
        { id: 4, title: "D", imageUrl: "", description: "", category: "Electronics" },
        { id: 5, title: "E", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "sort-it-out", products });
      const guess = generateBotGuess("sort-it-out", "medium", p, priceMap([[1, 1000], [2, 3000], [3, 2000], [4, 5000], [5, 4000]]));
      expect(guess).toHaveProperty("submittedOrder");
      const order = (guess as any).submittedOrder;
      expect(order.length).toBe(5);
      expect(new Set(order).size).toBe(5); // all unique IDs
    });
  });

  describe("budget-builder mode", () => {
    it("returns selectedProductIds array", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
        { id: 3, title: "C", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "budget-builder", products, budgetCents: 5000 });
      const guess = generateBotGuess("budget-builder", "medium", p, priceMap([[1, 1000], [2, 2000], [3, 3000]]));
      expect(guess).toHaveProperty("selectedProductIds");
      const ids = (guess as any).selectedProductIds;
      expect(Array.isArray(ids)).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
    });
  });

  describe("chain-reaction mode", () => {
    it("returns chainGuesses array", () => {
      const products = [
        { id: 1, title: "A", imageUrl: "", description: "", category: "Electronics" },
        { id: 2, title: "B", imageUrl: "", description: "", category: "Electronics" },
        { id: 3, title: "C", imageUrl: "", description: "", category: "Electronics" },
        { id: 4, title: "D", imageUrl: "", description: "", category: "Electronics" },
        { id: 5, title: "E", imageUrl: "", description: "", category: "Electronics" },
      ];
      const p = payload({ gameMode: "chain-reaction", products });
      const guess = generateBotGuess("chain-reaction", "medium", p, priceMap([[1, 1000], [2, 3000], [3, 2000], [4, 5000], [5, 4000]]));
      expect(guess).toHaveProperty("chainGuesses");
      const guesses = (guess as any).chainGuesses;
      expect(guesses.length).toBe(4); // N-1 comparisons
      for (const g of guesses) {
        expect(["more", "less"]).toContain(g);
      }
    });
  });

  describe("bidding mode", () => {
    it("returns bidCents number", () => {
      const guess = generateBotGuess("bidding", "medium", payload({ gameMode: "bidding" }), priceMap([[1, 5000]]));
      expect(guess).toHaveProperty("bidCents");
      expect(typeof (guess as any).bidCents).toBe("number");
      expect((guess as any).bidCents).toBeGreaterThan(0);
    });
  });

  describe("difficulty scaling", () => {
    it("hard bots produce guesses closer to correct on average (classic)", () => {
      const prices = priceMap([[1, 5000]]);
      const p = payload();
      let easyTotal = 0;
      let hardTotal = 0;
      const runs = 200;

      for (let i = 0; i < runs; i++) {
        const easyGuess = (generateBotGuess("classic", "easy", p, prices) as any).guessedPriceCents;
        const hardGuess = (generateBotGuess("classic", "hard", p, prices) as any).guessedPriceCents;
        easyTotal += Math.abs(easyGuess - 5000);
        hardTotal += Math.abs(hardGuess - 5000);
      }

      // Hard bots should be closer to the actual price on average
      expect(hardTotal / runs).toBeLessThan(easyTotal / runs);
    });
  });

  it("throws on unknown game mode", () => {
    expect(() => generateBotGuess("unknown-mode" as GameMode, "medium", payload(), priceMap([[1, 5000]]))).toThrow();
  });
});

describe("snapToRetail (human-like bot bid endings)", () => {
  /** Helper: true if cents ends in .00, .99, or .50. */
  function isRetailEnding(cents: number): boolean {
    const lastTwo = cents % 100;
    return lastTwo === 0 || lastTwo === 99 || lastTwo === 50;
  }

  it("always produces a .00, .99, or .50 ending", () => {
    for (let i = 0; i < 400; i++) {
      const raw = Math.floor(Math.random() * 50000) + 100;
      const snapped = snapToRetail(raw);
      expect(isRetailEnding(snapped)).toBe(true);
    }
  });

  it("snaps sub-$10 amounts to $1 increments (or retail-ending variants)", () => {
    for (let i = 0; i < 100; i++) {
      const raw = Math.floor(Math.random() * 900) + 100; // $1–$10
      const snapped = snapToRetail(raw);
      expect(isRetailEnding(snapped)).toBe(true);
      expect(snapped).toBeGreaterThanOrEqual(100);
    }
  });

  it("snaps mid-range ($10–$50) to $5 buckets", () => {
    // Check that whole-dollar outcomes land on $5 multiples.
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      samples.push(snapToRetail(2500));
    }
    // Every whole-dollar output should be a $5 multiple (25 / 30 / 20 etc.)
    for (const s of samples) {
      if (s % 100 === 0) {
        expect(s % 500).toBe(0);
      }
    }
  });

  it("never returns less than $1", () => {
    for (const tiny of [1, 50, 99, 100]) {
      expect(snapToRetail(tiny)).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("bot bids snap to retail & respect 'no overbid' rule", () => {
  function isRetailEnding(cents: number): boolean {
    const lastTwo = cents % 100;
    return lastTwo === 0 || lastTwo === 99 || lastTwo === 50;
  }

  it("bidding-mode bot never exceeds actual price (500-run soak)", () => {
    const prices = priceMap([[1, 2997]]); // $29.97 — tricky item
    for (let i = 0; i < 500; i++) {
      const g = generateBotGuess("bidding", "easy", payload({ gameMode: "bidding" }), prices);
      expect((g as any).bidCents).toBeLessThanOrEqual(2997);
      expect((g as any).bidCents).toBeGreaterThanOrEqual(100);
    }
  });

  it("bidding-mode bot bids almost always end in .00, .99, or .50", () => {
    const prices = priceMap([[1, 5000]]);
    let retail = 0;
    const runs = 300;
    for (let i = 0; i < runs; i++) {
      const g = generateBotGuess("bidding", "medium", payload({ gameMode: "bidding" }), prices);
      if (isRetailEnding((g as any).bidCents)) retail++;
    }
    // Snap is exact for purely-lattice outputs; the under-ceiling fallback
    // may produce a non-standard amount in rare cases, so allow ≥ 95%.
    expect(retail / runs).toBeGreaterThanOrEqual(0.95);
  });

  it("closest-mode bot never overbids (500-run soak)", () => {
    const prices = priceMap([[1, 4273]]);
    for (let i = 0; i < 500; i++) {
      const g = generateBotGuess("closest-without-going-over", "easy", payload({ gameMode: "closest-without-going-over" }), prices);
      expect((g as any).guessedPriceCents).toBeLessThanOrEqual(4273);
    }
  });

  it("riser-mode bot never overshoots (500-run soak)", () => {
    const prices = priceMap([[1, 7500]]);
    for (let i = 0; i < 500; i++) {
      const g = generateBotGuess("riser", "medium", payload({ gameMode: "riser" }), prices);
      expect((g as any).stoppedPriceCents).toBeLessThanOrEqual(7500);
    }
  });

  it("classic-mode bot bids almost always end in .00, .99, or .50", () => {
    const prices = priceMap([[1, 5000]]);
    let retail = 0;
    const runs = 300;
    for (let i = 0; i < runs; i++) {
      const g = generateBotGuess("classic", "medium", payload(), prices);
      if (isRetailEnding((g as any).guessedPriceCents)) retail++;
    }
    expect(retail / runs).toBeGreaterThanOrEqual(0.95);
  });
});
