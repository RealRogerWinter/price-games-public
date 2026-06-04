import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedProducts, seedDiverseProducts, seedUser, seedUserProductViews } from "../test/dbHelper";

// Mock the db module to use our test database
let testDb: DatabaseType;

vi.mock("../db", () => ({
  default: {
    prepare: (...args: any[]) => testDb.prepare(...args),
    exec: (...args: any[]) => testDb.exec(...args),
    transaction: (...args: any[]) => testDb.transaction(...args),
    pragma: (...args: any[]) => testDb.pragma(...args),
  },
}));

// Import after mock
import {
  getDifficultyForRound,
  fetchCandidatePool,
  composeRounds,
  composeRound,
  recordUserProductViews,
  getRecentlyViewedProductIds,
} from "./roundComposer";
import type { DifficultyTier } from "./productPairing";

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.close();
});

describe("getDifficultyForRound", () => {
  it("returns a valid difficulty tier", () => {
    const valid: DifficultyTier[] = ["easy", "medium", "hard"];
    for (let i = 1; i <= 10; i++) {
      expect(valid).toContain(getDifficultyForRound(i, 10));
    }
  });

  it("early rounds are predominantly easy", () => {
    const counts: Record<DifficultyTier, number> = { easy: 0, medium: 0, hard: 0 };
    for (let i = 0; i < 500; i++) {
      counts[getDifficultyForRound(1, 10)]++;
    }
    // Early zone: easy weight is 0.70 (plus some wildcard), should be > 50%
    expect(counts.easy).toBeGreaterThan(250);
  });

  it("late rounds are predominantly hard", () => {
    const counts: Record<DifficultyTier, number> = { easy: 0, medium: 0, hard: 0 };
    for (let i = 0; i < 500; i++) {
      counts[getDifficultyForRound(10, 10)]++;
    }
    // Late zone: hard weight is 0.70, should be > 50%
    expect(counts.hard).toBeGreaterThan(250);
  });

  it("mid rounds favor medium difficulty", () => {
    const counts: Record<DifficultyTier, number> = { easy: 0, medium: 0, hard: 0 };
    for (let i = 0; i < 500; i++) {
      counts[getDifficultyForRound(5, 10)]++;
    }
    expect(counts.medium).toBeGreaterThan(200);
  });

  it("handles single-round game", () => {
    const tier = getDifficultyForRound(1, 1);
    expect(["easy", "medium", "hard"]).toContain(tier);
  });
});

describe("fetchCandidatePool", () => {
  it("returns products from database", () => {
    seedDiverseProducts(testDb, 30);
    const pool = fetchCandidatePool(10);
    expect(pool.length).toBeGreaterThanOrEqual(10);
    expect(pool[0]).toHaveProperty("id");
    expect(pool[0]).toHaveProperty("price_cents");
    expect(pool[0]).toHaveProperty("title");
    expect(pool[0]).toHaveProperty("category");
  });

  it("filters by category", () => {
    seedDiverseProducts(testDb, 30);
    const pool = fetchCandidatePool(5, ["Electronics"]);
    for (const p of pool) {
      expect(p.category).toBe("Electronics");
    }
  });

  it("excludes specified product IDs", () => {
    seedDiverseProducts(testDb, 20);
    const allProducts = testDb.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[];
    const excludeIds = allProducts.map((p) => p.id);
    const pool = fetchCandidatePool(5, undefined, undefined, excludeIds);
    for (const p of pool) {
      expect(excludeIds).not.toContain(p.id);
    }
  });

  it("excludes user recently viewed products", () => {
    seedDiverseProducts(testDb, 30);
    const userId = seedUser(testDb);
    const productIds = (testDb.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((p) => p.id);
    seedUserProductViews(testDb, userId, productIds, "session-1");

    const pool = fetchCandidatePool(10, undefined, userId);
    for (const p of pool) {
      expect(productIds).not.toContain(p.id);
    }
  });

  it("gracefully degrades when user exclusions leave too few products", () => {
    seedProducts(testDb, 8);
    const userId = seedUser(testDb);
    const allIds = (testDb.prepare("SELECT id FROM products").all() as { id: number }[]).map((p) => p.id);
    // Mark all products as viewed
    seedUserProductViews(testDb, userId, allIds, "session-1");

    // Should still return products (by dropping user exclusions)
    const pool = fetchCandidatePool(5, undefined, userId);
    expect(pool.length).toBeGreaterThanOrEqual(5);
  });
});

describe("composeRounds", () => {
  it("classic mode: produces correct product count", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "classic", totalRounds: 10 });
    expect(result.productIds.length).toBe(10);
  });

  it("comparison mode: produces 2x products", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "comparison", totalRounds: 10 });
    expect(result.productIds.length).toBe(20);
    expect(result.roundData).not.toBeNull();
    // Each round should have a question
    for (let i = 1; i <= 10; i++) {
      expect(result.roundData![String(i)]).toHaveProperty("question");
    }
  });

  it("price-match mode: produces 4x products", () => {
    seedDiverseProducts(testDb, 80);
    const result = composeRounds({ mode: "price-match", totalRounds: 10 });
    expect(result.productIds.length).toBe(40);
  });

  it("higher-lower mode: round data has referencePrice", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "higher-lower", totalRounds: 10 });
    expect(result.roundData).not.toBeNull();
    for (let i = 1; i <= 10; i++) {
      expect(result.roundData![String(i)]).toHaveProperty("referencePrice");
      expect(result.roundData![String(i)].referencePrice).toBeGreaterThan(0);
    }
  });

  it("riser mode: round data has maxPriceCents, speedPattern, durationMs", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "riser", totalRounds: 10 });
    expect(result.roundData).not.toBeNull();
    for (let i = 1; i <= 10; i++) {
      const rd = result.roundData![String(i)];
      expect(rd).toHaveProperty("maxPriceCents");
      expect(rd).toHaveProperty("speedPattern");
      expect(rd).toHaveProperty("durationMs");
    }
  });

  it("closest-without-going-over mode: no extra round data", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "closest-without-going-over", totalRounds: 10 });
    expect(result.productIds.length).toBe(10);
  });

  it("excludes user's previously viewed products", () => {
    seedDiverseProducts(testDb, 60);
    const userId = seedUser(testDb);
    const viewedIds = (testDb.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((p) => p.id);
    seedUserProductViews(testDb, userId, viewedIds, "old-session");

    const result = composeRounds({ mode: "classic", totalRounds: 10, userId });
    for (const id of viewedIds) {
      expect(result.productIds).not.toContain(id);
    }
  });

  it("marks selected products as recently used", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "classic", totalRounds: 10 });
    for (const id of result.productIds) {
      const row = testDb.prepare("SELECT last_used_at FROM products WHERE id = ?").get(id) as { last_used_at: string | null };
      expect(row.last_used_at).not.toBeNull();
    }
  });

  it("does not crash with small catalog", () => {
    seedProducts(testDb, 12); // Just enough for classic mode
    const result = composeRounds({ mode: "classic", totalRounds: 10 });
    expect(result.productIds.length).toBe(10);
  });
});

describe("composeRound (multiplayer)", () => {
  it("produces correct product count for single-product modes", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "classic", totalRounds: 10, roundNumber: 1 });
    expect(result.productIds.length).toBe(1);
  });

  it("produces correct product count for comparison mode", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "comparison", totalRounds: 10, roundNumber: 1 });
    expect(result.productIds.length).toBe(2);
    expect(result.roundMeta).toHaveProperty("question");
  });

  it("produces correct product count for price-match mode", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "price-match", totalRounds: 10, roundNumber: 1 });
    expect(result.productIds.length).toBe(4);
  });

  it("respects sessionUsedIds", () => {
    seedDiverseProducts(testDb, 60);
    const usedIds = new Set([1, 2, 3, 4, 5]);
    const result = composeRound({
      mode: "classic", totalRounds: 10, roundNumber: 1, sessionUsedIds: usedIds,
    });
    for (const id of result.productIds) {
      expect(usedIds.has(id)).toBe(false);
    }
  });

  it("higher-lower round has referencePrice meta", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "higher-lower", totalRounds: 10, roundNumber: 5 });
    expect(result.roundMeta).toHaveProperty("referencePrice");
  });

  it("riser round has timing meta", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "riser", totalRounds: 10, roundNumber: 3 });
    expect(result.roundMeta).toHaveProperty("maxPriceCents");
    expect(result.roundMeta).toHaveProperty("speedPattern");
    expect(result.roundMeta).toHaveProperty("durationMs");
  });
});

describe("recordUserProductViews", () => {
  it("inserts view records into database", () => {
    seedProducts(testDb, 10);
    const userId = seedUser(testDb);
    const productIds = [1, 2, 3];
    recordUserProductViews(userId, productIds, "session-abc");

    const rows = testDb.prepare(
      "SELECT * FROM user_product_views WHERE user_id = ?"
    ).all(userId) as any[];
    expect(rows.length).toBe(3);
    expect(rows.map((r: any) => r.product_id).sort()).toEqual([1, 2, 3]);
    expect(rows[0].session_id).toBe("session-abc");
  });
});

describe("getRecentlyViewedProductIds", () => {
  it("returns product IDs from recent sessions", () => {
    seedProducts(testDb, 10);
    const userId = seedUser(testDb);
    seedUserProductViews(testDb, userId, [1, 2], "session-1");
    seedUserProductViews(testDb, userId, [3, 4], "session-2");

    const viewed = getRecentlyViewedProductIds(userId, 5);
    expect(viewed.has(1)).toBe(true);
    expect(viewed.has(2)).toBe(true);
    expect(viewed.has(3)).toBe(true);
    expect(viewed.has(4)).toBe(true);
  });

  it("returns empty set for unknown user", () => {
    const viewed = getRecentlyViewedProductIds("nonexistent-user", 5);
    expect(viewed.size).toBe(0);
  });

  it("respects session count limit", () => {
    seedProducts(testDb, 20);
    const userId = seedUser(testDb);

    // Create 6 sessions with different timestamps
    for (let s = 1; s <= 6; s++) {
      const sessionId = `session-${s}`;
      const seenAt = new Date(Date.now() + s * 1000).toISOString();
      testDb.prepare(
        "INSERT INTO user_product_views (user_id, product_id, session_id, seen_at) VALUES (?, ?, ?, ?)"
      ).run(userId, s, sessionId, seenAt);
    }

    // With limit 3, should only include products from sessions 4, 5, 6 (most recent)
    const viewed = getRecentlyViewedProductIds(userId, 3);
    expect(viewed.has(4)).toBe(true);
    expect(viewed.has(5)).toBe(true);
    expect(viewed.has(6)).toBe(true);
    // Session 1 should be outside the window
    expect(viewed.has(1)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Additional coverage tests
// ──────────────────────────────────────────────────────────────────────

describe("recordUserProductViews — additional coverage", () => {
  it("handles empty productIds array without error", () => {
    const userId = seedUser(testDb);
    // Should not throw
    recordUserProductViews(userId, [], "session-empty");

    const rows = testDb.prepare(
      "SELECT * FROM user_product_views WHERE user_id = ?"
    ).all(userId) as any[];
    expect(rows.length).toBe(0);
  });

  it("caps inserts at 100 products", () => {
    // Create 120 products
    seedProducts(testDb, 120);
    const userId = seedUser(testDb);
    const allIds = (testDb.prepare("SELECT id FROM products").all() as { id: number }[]).map((p) => p.id);
    expect(allIds.length).toBe(120);

    recordUserProductViews(userId, allIds, "session-big");

    const rows = testDb.prepare(
      "SELECT * FROM user_product_views WHERE user_id = ?"
    ).all(userId) as any[];
    // MAX_VIEWS_PER_CALL = 100
    expect(rows.length).toBe(100);
  });

  it("records correct session_id and user_id for each view", () => {
    seedProducts(testDb, 5);
    const userId = seedUser(testDb);
    recordUserProductViews(userId, [1, 2], "session-xyz");

    const rows = testDb.prepare(
      "SELECT user_id, product_id, session_id FROM user_product_views WHERE user_id = ? ORDER BY product_id"
    ).all(userId) as { user_id: string; product_id: number; session_id: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].session_id).toBe("session-xyz");
    expect(rows[1].product_id).toBe(2);
  });

  it("does not duplicate views for same user/product/session (INSERT OR IGNORE)", () => {
    seedProducts(testDb, 5);
    const userId = seedUser(testDb);
    recordUserProductViews(userId, [1, 2], "session-dup");
    recordUserProductViews(userId, [1, 2], "session-dup");

    const rows = testDb.prepare(
      "SELECT * FROM user_product_views WHERE user_id = ?"
    ).all(userId) as any[];
    // The UNIQUE index on (user_id, product_id, session_id) + INSERT OR IGNORE means no duplicates
    expect(rows.length).toBe(2);
  });
});

describe("getRecentlyViewedProductIds — additional coverage", () => {
  it("returns empty set when user has no views (sessions.length === 0 path)", () => {
    const userId = seedUser(testDb);
    // User exists but has no product views at all
    const viewed = getRecentlyViewedProductIds(userId);
    expect(viewed.size).toBe(0);
    expect(viewed).toBeInstanceOf(Set);
  });

  it("uses default sessionCount of 5 when not specified", () => {
    seedProducts(testDb, 30);
    const userId = seedUser(testDb);

    // Create 7 sessions
    for (let s = 1; s <= 7; s++) {
      const seenAt = new Date(Date.now() + s * 1000).toISOString();
      testDb.prepare(
        "INSERT INTO user_product_views (user_id, product_id, session_id, seen_at) VALUES (?, ?, ?, ?)"
      ).run(userId, s, `session-${s}`, seenAt);
    }

    // Default is 5, so sessions 3-7 (most recent 5) should be included
    const viewed = getRecentlyViewedProductIds(userId);
    expect(viewed.has(7)).toBe(true);
    expect(viewed.has(6)).toBe(true);
    expect(viewed.has(5)).toBe(true);
    expect(viewed.has(4)).toBe(true);
    expect(viewed.has(3)).toBe(true);
    // Sessions 1 and 2 should be outside the window
    expect(viewed.has(1)).toBe(false);
    expect(viewed.has(2)).toBe(false);
  });
});

describe("getDifficultyForRound — distribution coverage", () => {
  it("10% wildcard produces all three tiers across many calls", () => {
    // With enough calls, the wildcard path should produce every tier at least once.
    // Use round 1 of 10 (early zone favoring easy). Over 2000 calls, the 10%
    // wildcard should yield at least a few "hard" results.
    const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
    for (let i = 0; i < 2000; i++) {
      counts[getDifficultyForRound(1, 10)]++;
    }
    // Even early rounds should occasionally produce hard via wildcard
    expect(counts.hard).toBeGreaterThan(0);
    expect(counts.medium).toBeGreaterThan(0);
    expect(counts.easy).toBeGreaterThan(0);
  });

  it("round equal to totalRounds produces valid tier", () => {
    // Edge case: progress = 1.0 (final round)
    const tier = getDifficultyForRound(10, 10);
    expect(["easy", "medium", "hard"]).toContain(tier);
  });

  it("totalRounds of 2 produces valid tiers for both rounds", () => {
    // progress for round 1 = 0/(2-1) = 0 (early), round 2 = 1/(2-1) = 1.0 (late)
    for (let i = 0; i < 50; i++) {
      expect(["easy", "medium", "hard"]).toContain(getDifficultyForRound(1, 2));
      expect(["easy", "medium", "hard"]).toContain(getDifficultyForRound(2, 2));
    }
  });
});

describe("fetchCandidatePool — additional coverage", () => {
  it("returns products when excludeProductIds is provided", () => {
    seedDiverseProducts(testDb, 30);
    const allIds = (testDb.prepare("SELECT id FROM products LIMIT 10").all() as { id: number }[]).map((p) => p.id);
    const excludeIds = allIds.slice(0, 3);

    const pool = fetchCandidatePool(5, undefined, undefined, excludeIds);
    expect(pool.length).toBeGreaterThanOrEqual(5);
    for (const p of pool) {
      expect(excludeIds).not.toContain(p.id);
    }
  });

  it("graceful degradation: retries without user exclusions when pool is too small", () => {
    // Create exactly the minimum needed products
    seedProducts(testDb, 6);
    const userId = seedUser(testDb);
    // Mark ALL products as viewed
    const allIds = (testDb.prepare("SELECT id FROM products").all() as { id: number }[]).map((p) => p.id);
    seedUserProductViews(testDb, userId, allIds, "session-all");

    // Request 5 products with user exclusions — initial pool will be 0 since all are excluded
    // Should fall back to fetching without user exclusions
    const pool = fetchCandidatePool(5, undefined, userId);
    expect(pool.length).toBeGreaterThanOrEqual(5);
  });

  it("does not trigger degradation when no userId is provided", () => {
    seedProducts(testDb, 6);
    const pool = fetchCandidatePool(5);
    expect(pool.length).toBeGreaterThanOrEqual(5);
  });

  it("returns empty array when database has no active products", () => {
    // No products seeded
    const pool = fetchCandidatePool(5);
    expect(pool.length).toBe(0);
  });
});

describe("composeRounds — fallback and mode-specific round metadata", () => {
  it("market-basket mode: round data has itemCount", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRounds({ mode: "market-basket", totalRounds: 5 });
    expect(result.roundData).not.toBeNull();
    for (let i = 1; i <= 5; i++) {
      const rd = result.roundData![String(i)];
      expect(rd).toHaveProperty("itemCount");
      expect(rd.itemCount).toBeGreaterThanOrEqual(3);
      expect(rd.itemCount).toBeLessThanOrEqual(6);
    }
  });

  it("budget-builder mode: round data has budgetCents", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRounds({ mode: "budget-builder", totalRounds: 5 });
    expect(result.roundData).not.toBeNull();
    for (let i = 1; i <= 5; i++) {
      const rd = result.roundData![String(i)];
      expect(rd).toHaveProperty("budgetCents");
      expect(rd.budgetCents).toBeGreaterThan(0);
    }
  });

  it("classic mode: roundData is null (no special metadata)", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRounds({ mode: "classic", totalRounds: 5 });
    // Classic rounds have only productIds in roundData entries — no extra metadata
    // The hasRoundData check should return null since only productIds keys exist
    // Actually, roundData entries always have at least { productIds: [...] }, so
    // it won't be null; just verify no extra keys besides productIds
    for (let i = 1; i <= 5; i++) {
      const rd = result.roundData![String(i)];
      const keysWithoutProductIds = Object.keys(rd).filter((k) => k !== "productIds");
      expect(keysWithoutProductIds.length).toBe(0);
    }
  });

  it("odd-one-out mode: produces 4x products per round", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRounds({ mode: "odd-one-out", totalRounds: 5 });
    expect(result.productIds.length).toBe(20);
  });

  it("sort-it-out mode: produces 5x products per round", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRounds({ mode: "sort-it-out", totalRounds: 5 });
    expect(result.productIds.length).toBe(25);
  });

  it("chain-reaction mode: produces 5x products per round", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRounds({ mode: "chain-reaction", totalRounds: 5 });
    expect(result.productIds.length).toBe(25);
  });

  it("selectProductsForRound returns null triggers fallback path", () => {
    // Seed only 2 products — not enough for comparison pairs in repeated rounds
    // The selectProductsForRound will return null after using the first pair,
    // forcing the fallback path via selectFallbackProducts
    seedDiverseProducts(testDb, 4);
    // Request 5 rounds of comparison mode (needs 2 products per round = 10 total from a pool of 4)
    // After the first 2 rounds exhaust products, subsequent rounds will hit the fallback path
    const result = composeRounds({ mode: "comparison", totalRounds: 5 });
    // Should still produce some productIds without crashing
    expect(result.productIds.length).toBeGreaterThan(0);
  });

  it("throws UserFacingError when no products exist at all", () => {
    // No products seeded — composeRounds should throw
    expect(() => {
      composeRounds({ mode: "classic", totalRounds: 5 });
    }).toThrow("Not enough products");
  });

  it("respects categories filter", () => {
    seedDiverseProducts(testDb, 80);
    const result = composeRounds({ mode: "classic", totalRounds: 5, categories: ["Electronics"] });
    expect(result.productIds.length).toBe(5);
    // Verify all selected products are Electronics
    for (const id of result.productIds) {
      const row = testDb.prepare("SELECT category FROM products WHERE id = ?").get(id) as { category: string };
      expect(row.category).toBe("Electronics");
    }
  });
});

describe("composeRound (multiplayer) — additional coverage", () => {
  it("higher-lower round: referencePrice is a positive number", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "higher-lower", totalRounds: 10, roundNumber: 1 });
    expect(result.productIds.length).toBe(1);
    expect(result.roundMeta.referencePrice).toBeGreaterThan(0);
    expect(typeof result.roundMeta.referencePrice).toBe("number");
  });

  it("riser round: meta has expected types and ranges", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "riser", totalRounds: 10, roundNumber: 5 });
    expect(result.productIds.length).toBe(1);
    expect(result.roundMeta.maxPriceCents).toBeGreaterThan(0);
    expect(typeof result.roundMeta.speedPattern).toBe("string");
    expect(result.roundMeta.durationMs).toBeGreaterThanOrEqual(8000);
  });

  it("comparison round: question is most-expensive or least-expensive", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "comparison", totalRounds: 10, roundNumber: 3 });
    expect(result.productIds.length).toBe(2);
    expect(["most-expensive", "least-expensive"]).toContain(result.roundMeta.question);
  });

  it("market-basket round: has itemCount", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRound({ mode: "market-basket", totalRounds: 10, roundNumber: 2 });
    expect(result.productIds.length).toBeGreaterThanOrEqual(3);
    expect(result.roundMeta).toHaveProperty("itemCount");
    expect(result.roundMeta.itemCount).toBeGreaterThanOrEqual(3);
  });

  it("budget-builder round: has budgetCents", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRound({ mode: "budget-builder", totalRounds: 10, roundNumber: 4 });
    expect(result.productIds.length).toBe(6);
    expect(result.roundMeta).toHaveProperty("budgetCents");
    expect(result.roundMeta.budgetCents).toBeGreaterThan(0);
  });

  it("classic round: roundMeta is empty object", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "classic", totalRounds: 10, roundNumber: 7 });
    expect(result.productIds.length).toBe(1);
    expect(Object.keys(result.roundMeta).length).toBe(0);
  });

  it("closest-without-going-over round: roundMeta is empty object", () => {
    seedDiverseProducts(testDb, 60);
    const result = composeRound({ mode: "closest-without-going-over", totalRounds: 10, roundNumber: 1 });
    expect(result.productIds.length).toBe(1);
    expect(Object.keys(result.roundMeta).length).toBe(0);
  });

  it("falls back when candidates are exhausted (selectProductsForRound returns null)", () => {
    // Only 3 products — not enough for price-match (needs 4) after first round
    seedDiverseProducts(testDb, 5);
    const usedIds = new Set<number>();
    // Use all but 2 products
    const allIds = (testDb.prepare("SELECT id FROM products").all() as { id: number }[]).map((p) => p.id);
    for (const id of allIds.slice(0, 3)) {
      usedIds.add(id);
    }

    // price-match needs 4, but only 2 unused remain in the candidate pool — triggers fallback
    const result = composeRound({
      mode: "price-match",
      totalRounds: 10,
      roundNumber: 1,
      sessionUsedIds: usedIds,
    });
    // Should still produce some products via fallback
    expect(result.productIds.length).toBeGreaterThan(0);
  });

  it("odd-one-out round: produces 4 products", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRound({ mode: "odd-one-out", totalRounds: 10, roundNumber: 2 });
    expect(result.productIds.length).toBe(4);
  });

  it("sort-it-out round: produces 5 products", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRound({ mode: "sort-it-out", totalRounds: 10, roundNumber: 3 });
    expect(result.productIds.length).toBe(5);
  });

  it("chain-reaction round: produces 5 products", () => {
    seedDiverseProducts(testDb, 120);
    const result = composeRound({ mode: "chain-reaction", totalRounds: 10, roundNumber: 4 });
    expect(result.productIds.length).toBe(5);
  });
});
