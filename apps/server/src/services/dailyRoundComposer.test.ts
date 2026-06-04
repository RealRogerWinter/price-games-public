import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedDiverseProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  DAILY_TOTAL_ROUNDS,
  COMPARISON_PRODUCTS_PER_ROUND,
  PRICE_MATCH_PRODUCTS_PER_ROUND,
  ODD_ONE_OUT_PRODUCTS_PER_ROUND,
  MARKET_BASKET_MAX_PRODUCTS,
  SORT_IT_OUT_PRODUCTS_PER_ROUND,
  BUDGET_BUILDER_PRODUCTS_PER_ROUND,
  CHAIN_REACTION_PRODUCTS_PER_ROUND,
  type GameMode,
} from "@price-game/shared";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedDiverseProducts(testDb, 60);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { composeDailyRounds } = await import("./dailyRoundComposer");
const { mulberry32 } = await import("./dailyPuzzle");

/**
 * Focused unit tests for composeDailyRounds, especially the newly-added
 * single-player bidding path.
 */
describe("composeDailyRounds", () => {
  describe("bidding mode (single-player daily)", () => {
    it("composes 5 rounds with exactly one product per round", () => {
      const rng = mulberry32(42);
      const composed = composeDailyRounds(testDb, "bidding", rng);

      expect(composed.productIds).toHaveLength(DAILY_TOTAL_ROUNDS);
      for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
        const meta = composed.roundData[String(round)] as {
          productIds: number[];
        };
        expect(meta).toBeDefined();
        expect(meta.productIds).toHaveLength(1);
      }
    });

    it("does not attach referencePrice or question metadata to bidding rounds", () => {
      const rng = mulberry32(7);
      const composed = composeDailyRounds(testDb, "bidding", rng);

      for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
        const meta = composed.roundData[String(round)] as Record<string, unknown>;
        expect(meta).not.toHaveProperty("referencePrice");
        expect(meta).not.toHaveProperty("question");
      }
    });

    it("is deterministic for the same seed", () => {
      const a = composeDailyRounds(testDb, "bidding", mulberry32(1234));
      const b = composeDailyRounds(testDb, "bidding", mulberry32(1234));
      expect(a.productIds).toEqual(b.productIds);
      expect(a.roundData).toEqual(b.roundData);
    });

    it("produces different product orderings for different seeds", () => {
      const a = composeDailyRounds(testDb, "bidding", mulberry32(1));
      const b = composeDailyRounds(testDb, "bidding", mulberry32(999_999));
      // Overwhelmingly likely to differ with 60 products in the pool.
      expect(a.productIds).not.toEqual(b.productIds);
    });

    it("uses distinct products across rounds (no repeats within a single puzzle)", () => {
      const composed = composeDailyRounds(testDb, "bidding", mulberry32(314));
      const unique = new Set(composed.productIds);
      expect(unique.size).toBe(composed.productIds.length);
    });
  });

  describe("all admin-selectable modes", () => {
    const cases: { mode: GameMode; productsPerRound: number }[] = [
      { mode: "classic", productsPerRound: 1 },
      { mode: "higher-lower", productsPerRound: 1 },
      { mode: "comparison", productsPerRound: COMPARISON_PRODUCTS_PER_ROUND },
      { mode: "closest-without-going-over", productsPerRound: 1 },
      { mode: "price-match", productsPerRound: PRICE_MATCH_PRODUCTS_PER_ROUND },
      { mode: "riser", productsPerRound: 1 },
      { mode: "odd-one-out", productsPerRound: ODD_ONE_OUT_PRODUCTS_PER_ROUND },
      { mode: "market-basket", productsPerRound: MARKET_BASKET_MAX_PRODUCTS },
      { mode: "sort-it-out", productsPerRound: SORT_IT_OUT_PRODUCTS_PER_ROUND },
      { mode: "budget-builder", productsPerRound: BUDGET_BUILDER_PRODUCTS_PER_ROUND },
      { mode: "chain-reaction", productsPerRound: CHAIN_REACTION_PRODUCTS_PER_ROUND },
      { mode: "bidding", productsPerRound: 1 },
    ];

    it.each(cases)(
      "composes a valid $mode puzzle with $productsPerRound products per round",
      ({ mode, productsPerRound }) => {
        const composed = composeDailyRounds(testDb, mode, mulberry32(77));
        expect(composed.productIds).toHaveLength(DAILY_TOTAL_ROUNDS * productsPerRound);
        for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
          const meta = composed.roundData[String(round)] as { productIds: number[] };
          expect(meta.productIds).toHaveLength(productsPerRound);
        }
      },
    );

    it("emits riser metadata (maxPriceCents, speedPattern, durationMs) for riser mode", () => {
      const composed = composeDailyRounds(testDb, "riser", mulberry32(5));
      for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
        const meta = composed.roundData[String(round)] as Record<string, unknown>;
        expect(meta).toHaveProperty("maxPriceCents");
        expect(meta).toHaveProperty("speedPattern");
        expect(meta).toHaveProperty("durationMs");
        expect(typeof meta.maxPriceCents).toBe("number");
      }
    });

    it("emits budgetCents metadata for budget-builder mode", () => {
      const composed = composeDailyRounds(testDb, "budget-builder", mulberry32(9));
      for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
        const meta = composed.roundData[String(round)] as Record<string, unknown>;
        expect(meta).toHaveProperty("budgetCents");
        expect(typeof meta.budgetCents).toBe("number");
        expect(meta.budgetCents).toBeGreaterThan(0);
      }
    });

    it("emits itemCount metadata for market-basket mode", () => {
      const composed = composeDailyRounds(testDb, "market-basket", mulberry32(3));
      for (let round = 1; round <= DAILY_TOTAL_ROUNDS; round++) {
        const meta = composed.roundData[String(round)] as Record<string, unknown>;
        expect(meta.itemCount).toBe(MARKET_BASKET_MAX_PRODUCTS);
      }
    });
  });

  it("throws when the active product pool is too small for the mode", () => {
    // Archive all but a couple of products so the composer cannot fill 5 rounds.
    testDb.prepare("UPDATE products SET is_active = 0").run();
    testDb.prepare("UPDATE products SET is_active = 1 WHERE id IN (SELECT id FROM products LIMIT 2)").run();

    expect(() => composeDailyRounds(testDb, "bidding", mulberry32(1))).toThrow(
      /not enough active products/,
    );
  });
});
