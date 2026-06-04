import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  const dbMod = await import("../db");
  (dbMod as any).default = testDb;
});

const { scoreGuessForMode, MAX_ARRAY_INPUT_LENGTH } = await import("./guessScoring");
import type { ScoringResult } from "./guessScoring";

function seedProducts(prices: number[]): number[] {
  const ids: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const info = testDb.prepare(
      "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    ).run(`ASIN${i}`, `Product ${i}`, `https://img/${i}.jpg`, `Desc ${i}`, prices[i], "Electronics");
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

describe("MAX_ARRAY_INPUT_LENGTH", () => {
  it("equals 20", () => {
    expect(MAX_ARRAY_INPUT_LENGTH).toBe(20);
  });
});

describe("scoreGuessForMode", () => {
  describe("input validation", () => {
    it("returns invalid result for null guessData", () => {
      const r = scoreGuessForMode("classic", null, [], {});
      expect(r.mode).toBe("invalid");
      expect(r.score).toBe(0);
    });

    it("returns invalid result for non-object guessData", () => {
      const r = scoreGuessForMode("classic", "string", [], {});
      expect(r.mode).toBe("invalid");
      expect(r.score).toBe(0);
    });

    it("returns invalid result for unknown mode", () => {
      const ids = seedProducts([1000]);
      const r = scoreGuessForMode("nonexistent" as any, { guessedPriceCents: 1000 }, ids, {});
      expect(r.mode).toBe("invalid");
      expect(r.score).toBe(0);
    });
  });

  describe("classic mode", () => {
    it("returns rich result for perfect guess", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("classic", { guessedPriceCents: 10000 }, ids, {});
      expect(r.mode).toBe("classic");
      expect(r.score).toBe(1000);
      if (r.mode === "classic") {
        expect(r.pctOff).toBe(0);
        expect(r.guessedPriceCents).toBe(10000);
      }
    });

    it("returns score 0 for negative price", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("classic", { guessedPriceCents: -1 }, ids, {});
      expect(r.mode).toBe("classic");
      expect(r.score).toBe(0);
      if (r.mode === "classic") {
        expect(r.guessedPriceCents).toBe(0);
      }
    });

    it("returns score 0 for price over 10M", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("classic", { guessedPriceCents: 10_000_001 }, ids, {});
      expect(r.mode).toBe("classic");
      expect(r.score).toBe(0);
      if (r.mode === "classic") {
        expect(r.guessedPriceCents).toBe(0);
      }
    });

    it("returns score 0 when product not found", () => {
      const r = scoreGuessForMode("classic", { guessedPriceCents: 1000 }, [99999], {});
      expect(r.mode).toBe("classic");
      expect(r.score).toBe(0);
    });

    it("returns score 0 for non-number price", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("classic", { guessedPriceCents: "abc" }, ids, {});
      expect(r.mode).toBe("classic");
      expect(r.score).toBe(0);
    });
  });

  describe("higher-lower mode", () => {
    it("returns rich result with correct flag", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("higher-lower", { guess: "higher" }, ids, { referencePrice: 5000 });
      expect(r.mode).toBe("higher-lower");
      expect(r.score).toBeGreaterThan(0);
      if (r.mode === "higher-lower") {
        expect(r.correct).toBe(true);
        expect(r.guess).toBe("higher");
      }
    });

    it("returns score 0 for invalid guess value", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("higher-lower", { guess: "sideways" }, ids, { referencePrice: 5000 });
      expect(r.mode).toBe("higher-lower");
      expect(r.score).toBe(0);
      if (r.mode === "higher-lower") {
        expect(r.correct).toBe(false);
      }
    });
  });

  describe("comparison mode", () => {
    it("returns correctProductId even for invalid guess", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("comparison", { guessedProductId: 99999 }, ids, { question: "most-expensive" });
      expect(r.mode).toBe("comparison");
      expect(r.score).toBe(0);
      if (r.mode === "comparison") {
        expect(r.correct).toBe(false);
        expect(r.correctProductId).toBeDefined();
        expect(r.guessedProductId).toBe(99999);
      }
    });

    it("returns correctProductId for non-number guessedProductId", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("comparison", { guessedProductId: "abc" }, ids, { question: "most-expensive" });
      expect(r.mode).toBe("comparison");
      if (r.mode === "comparison") {
        expect(r.guessedProductId).toBe(0);
      }
    });
  });

  describe("closest-without-going-over mode", () => {
    it("returns pctOff and wentOver", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("closest-without-going-over", { guessedPriceCents: 9500 }, ids, {});
      expect(r.mode).toBe("closest-without-going-over");
      expect(r.score).toBeGreaterThan(0);
      if (r.mode === "closest-without-going-over") {
        expect(r.wentOver).toBe(false);
        expect(r.pctOff).toBeGreaterThanOrEqual(0);
        expect(r.guessedPriceCents).toBe(9500);
      }
    });
  });

  describe("price-match mode", () => {
    it("returns correctCount and sanitized assignments", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("price-match", {
        assignments: { [ids[0]]: 1000, [ids[1]]: 2000 }
      }, ids, {});
      expect(r.mode).toBe("price-match");
      if (r.mode === "price-match") {
        expect(r.correctCount).toBe(2);
        expect(r.assignments).toBeDefined();
      }
    });

    it("returns empty result for missing assignments", () => {
      const ids = seedProducts([1000]);
      const r = scoreGuessForMode("price-match", {}, ids, {});
      expect(r.mode).toBe("price-match");
      expect(r.score).toBe(0);
    });
  });

  describe("riser mode", () => {
    it("returns pctOff and wentOver", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("riser", { stoppedPriceCents: 10000 }, ids, {});
      expect(r.mode).toBe("riser");
      if (r.mode === "riser") {
        expect(r.stoppedPriceCents).toBe(10000);
        expect(typeof r.pctOff).toBe("number");
        expect(typeof r.wentOver).toBe("boolean");
      }
    });

    it("returns score 0 for negative stoppedPriceCents", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("riser", { stoppedPriceCents: -1 }, ids, {});
      expect(r.mode).toBe("riser");
      expect(r.score).toBe(0);
    });

    it("returns score 0 for stoppedPriceCents over 10M", () => {
      const ids = seedProducts([10000]);
      const r = scoreGuessForMode("riser", { stoppedPriceCents: 10_000_001 }, ids, {});
      expect(r.mode).toBe("riser");
      expect(r.score).toBe(0);
    });
  });

  describe("odd-one-out mode", () => {
    it("returns outlierProductId even for invalid guess", () => {
      const ids = seedProducts([1000, 2000, 3000, 10000]);
      const r = scoreGuessForMode("odd-one-out", { guessedProductId: 99999 }, ids, {});
      expect(r.mode).toBe("odd-one-out");
      expect(r.score).toBe(0);
      if (r.mode === "odd-one-out") {
        expect(r.outlierProductId).toBeDefined();
        expect(r.correct).toBe(false);
      }
    });
  });

  describe("market-basket mode", () => {
    it("returns actualTotalCents and pctOff", () => {
      const ids = seedProducts([1000, 2000, 3000]);
      const r = scoreGuessForMode("market-basket", { guessedTotalCents: 6000 }, ids, {});
      expect(r.mode).toBe("market-basket");
      expect(r.score).toBe(1000);
      if (r.mode === "market-basket") {
        expect(r.actualTotalCents).toBe(6000);
        expect(r.guessedTotalCents).toBe(6000);
        expect(r.pctOff).toBe(0);
      }
    });

    it("handles zero-priced products correctly with ?? operator", () => {
      const ids = seedProducts([0, 1000]);
      const r = scoreGuessForMode("market-basket", { guessedTotalCents: 1000 }, ids, {});
      expect(r.mode).toBe("market-basket");
      expect(r.score).toBe(1000);
      if (r.mode === "market-basket") {
        expect(r.actualTotalCents).toBe(1000);
      }
    });

    it("returns score 0 for guessedTotalCents over 10M", () => {
      const ids = seedProducts([1000]);
      const r = scoreGuessForMode("market-basket", { guessedTotalCents: 10_000_001 }, ids, {});
      expect(r.mode).toBe("market-basket");
      expect(r.score).toBe(0);
    });
  });

  describe("sort-it-out mode", () => {
    it("returns correctOrder and correctCount", () => {
      const ids = seedProducts([3000, 1000, 2000]);
      const r = scoreGuessForMode("sort-it-out", { submittedOrder: [ids[1], ids[2], ids[0]] }, ids, {});
      expect(r.mode).toBe("sort-it-out");
      if (r.mode === "sort-it-out") {
        expect(r.correctOrder).toEqual([ids[1], ids[2], ids[0]]);
        expect(r.submittedOrder).toEqual([ids[1], ids[2], ids[0]]);
        expect(r.correctCount).toBe(3);
      }
    });

    it("returns empty arrays for non-array input", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("sort-it-out", { submittedOrder: "abc" }, ids, {});
      expect(r.mode).toBe("sort-it-out");
      expect(r.score).toBe(0);
      if (r.mode === "sort-it-out") {
        expect(r.submittedOrder).toEqual([]);
        expect(r.correctOrder).toEqual([]);
      }
    });

    it("truncates oversized arrays to MAX_ARRAY_INPUT_LENGTH", () => {
      const prices = Array.from({ length: 5 }, (_, i) => (i + 1) * 1000);
      const ids = seedProducts(prices);
      const oversizedOrder = [...ids, ...Array(25).fill(ids[0])];
      const r = scoreGuessForMode("sort-it-out", { submittedOrder: oversizedOrder }, ids, {});
      expect(r.mode).toBe("sort-it-out");
      if (r.mode === "sort-it-out") {
        expect(r.submittedOrder.length).toBeLessThanOrEqual(MAX_ARRAY_INPUT_LENGTH);
      }
    });
  });

  describe("budget-builder mode", () => {
    it("returns cartTotalCents and budgetCents", () => {
      const ids = seedProducts([1000, 2000, 3000]);
      const r = scoreGuessForMode("budget-builder", { selectedProductIds: [ids[0], ids[1]] }, ids, { budgetCents: 3000 });
      expect(r.mode).toBe("budget-builder");
      if (r.mode === "budget-builder") {
        expect(r.cartTotalCents).toBe(3000);
        expect(r.budgetCents).toBe(3000);
        expect(r.selectedProductIds).toEqual([ids[0], ids[1]]);
      }
    });

    it("filters out invalid product IDs", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("budget-builder", { selectedProductIds: [ids[0], 99999] }, ids, { budgetCents: 1000 });
      expect(r.mode).toBe("budget-builder");
      if (r.mode === "budget-builder") {
        expect(r.selectedProductIds).toEqual([ids[0]]);
      }
    });

    it("returns empty result for non-array input", () => {
      const ids = seedProducts([1000]);
      const r = scoreGuessForMode("budget-builder", { selectedProductIds: "abc" }, ids, { budgetCents: 1000 });
      expect(r.mode).toBe("budget-builder");
      expect(r.score).toBe(0);
    });
  });

  describe("chain-reaction mode", () => {
    it("returns correctCount and chainLength", () => {
      const ids = seedProducts([1000, 2000, 3000]);
      const r = scoreGuessForMode("chain-reaction", { chainGuesses: ["more", "more"] }, ids, {});
      expect(r.mode).toBe("chain-reaction");
      if (r.mode === "chain-reaction") {
        expect(r.correctCount).toBe(2);
        expect(r.chainLength).toBe(2);
        expect(r.chainGuesses).toEqual(["more", "more"]);
      }
    });

    it("returns empty result for non-array input", () => {
      const ids = seedProducts([1000, 2000]);
      const r = scoreGuessForMode("chain-reaction", { chainGuesses: "abc" }, ids, {});
      expect(r.mode).toBe("chain-reaction");
      expect(r.score).toBe(0);
      if (r.mode === "chain-reaction") {
        expect(r.chainGuesses).toEqual([]);
      }
    });

    it("filters out invalid guess values", () => {
      const ids = seedProducts([1000, 2000, 3000]);
      const r = scoreGuessForMode("chain-reaction", { chainGuesses: ["more", "invalid", "less"] }, ids, {});
      expect(r.mode).toBe("chain-reaction");
      if (r.mode === "chain-reaction") {
        expect(r.chainGuesses).toEqual(["more", "less"]);
      }
    });
  });

  describe("bidding mode (single-player context)", () => {
    it("scores proximity-based points for a 20%-off underbid", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 4000 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        // smoothScore(0.2, 3.0) = round(1000 * 0.8^3) = 512
        expect(r.score).toBe(512);
        expect(r.bidCents).toBe(4000);
        expect(r.pctOff).toBeCloseTo(0.2, 3);
        expect(r.wentOver).toBe(false);
        expect(r.isExact).toBe(false);
      }
    });

    it("scores 1500 (1000 + 500 exact bonus) for an exact bid", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 5000 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.score).toBe(1500);
        expect(r.bidCents).toBe(5000);
        expect(r.isExact).toBe(true);
      }
    });

    it("scores 0 and flags wentOver for an over-price bid", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 5100 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.score).toBe(0);
        expect(r.bidCents).toBe(5100);
        expect(r.wentOver).toBe(true);
      }
    });

    it("accepts guessedPriceCents as an alias for bidCents (daily challenge UI)", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { guessedPriceCents: 4500 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        // smoothScore(0.1, 3.0) = round(1000 * 0.9^3) = 729
        expect(r.score).toBe(729);
        expect(r.bidCents).toBe(4500);
      }
    });

    it("prefers bidCents when both bidCents and guessedPriceCents are present", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode(
        "bidding",
        { bidCents: 4500, guessedPriceCents: 9999 },
        ids,
        {},
      );
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.bidCents).toBe(4500);
        expect(r.score).toBe(729);
      }
    });

    it("no longer rewards ultra-low underbids ($0.01 on $30 no longer scores 1000)", () => {
      const ids = seedProducts([3000]);
      const r = scoreGuessForMode("bidding", { bidCents: 1 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.wentOver).toBe(false);
      }
    });

    it("clamps negative bid values to 0 (then scores 0, not 1000 like the old bug)", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: -1 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.bidCents).toBe(0);
        // 0 on a $50 item: pctOff = 1.0 → smoothScore(1, 3.0) = 0.
        expect(r.score).toBe(0);
      }
    });

    it("clamps out-of-range bid values to 0", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 10_000_001 }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.bidCents).toBe(0);
      }
    });

    it("returns score 0 when the product is missing from the product map", () => {
      const r = scoreGuessForMode("bidding", { bidCents: 4000 }, [99999], {});
      expect(r.mode).toBe("bidding");
      expect(r.score).toBe(0);
    });

    it("defaults to score 0 and bidCents 0 for a non-numeric bid", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: "abc" }, ids, {});
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.bidCents).toBe(0);
      }
    });
  });

  describe("bidding mode (multiplayer context)", () => {
    it("returns a placeholder score of 0 even on a valid under-price bid", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 4000 }, ids, {}, undefined, "mp");
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        // MP bidding uses deferred scoring via finalizeBiddingScores, so this
        // branch always reports 0 regardless of how "good" the bid was.
        expect(r.score).toBe(0);
        expect(r.bidCents).toBe(4000);
      }
    });

    it("still echoes the bid amount so MP can store it per player", () => {
      const ids = seedProducts([5000]);
      const r = scoreGuessForMode("bidding", { bidCents: 5000 }, ids, {}, undefined, "mp");
      expect(r.mode).toBe("bidding");
      if (r.mode === "bidding") {
        expect(r.score).toBe(0); // never applies the exact bonus in MP
        expect(r.bidCents).toBe(5000);
      }
    });
  });

  describe("error handling", () => {
    it("catches exceptions and returns invalid result", () => {
      const r = scoreGuessForMode("comparison", { guessedProductId: 1 }, [], { question: "most-expensive" });
      expect(r.score).toBe(0);
    });
  });
});
