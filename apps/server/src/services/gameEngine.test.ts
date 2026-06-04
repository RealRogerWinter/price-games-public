import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return {
    default: null as any,
  };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);

  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { startGame, getSession, getSessionProduct, submitGuess, getHint } = await import("./gameEngine");

describe("startGame", () => {
  it("creates a classic game session with default rounds", () => {
    const session = startGame("classic");
    expect(session.id).toBeDefined();
    expect(session.currentRound).toBe(1);
    expect(session.totalRounds).toBe(5);
    expect(session.totalScore).toBe(0);
    expect(session.completed).toBe(false);
    expect(session.gameMode).toBe("classic");
  });

  it("creates a session with a custom round count", () => {
    const session = startGame("classic", undefined, undefined, undefined, 10);
    expect(session.totalRounds).toBe(10);
  });

  it("creates a higher-lower game session", () => {
    const session = startGame("higher-lower");
    expect(session.gameMode).toBe("higher-lower");
  });

  it("creates a comparison game session", () => {
    const session = startGame("comparison");
    expect(session.gameMode).toBe("comparison");
  });

  it("creates a closest-without-going-over game session", () => {
    const session = startGame("closest-without-going-over");
    expect(session.gameMode).toBe("closest-without-going-over");
  });

  it("creates a price-match game session", () => {
    const session = startGame("price-match");
    expect(session.gameMode).toBe("price-match");
  });

  it("creates a riser game session", () => {
    const session = startGame("riser");
    expect(session.gameMode).toBe("riser");
  });

  it("persists session to the database", () => {
    const session = startGame("classic");
    const row = testDb.prepare("SELECT * FROM game_sessions WHERE id = ?").get(session.id) as any;
    expect(row).toBeDefined();
    expect(row.game_mode).toBe("classic");
    expect(row.current_round).toBe(1);
    expect(row.total_score).toBe(0);
  });

  it("stores selected product IDs in the session", () => {
    const session = startGame("classic");
    const row = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(session.id) as any;
    const productIds = JSON.parse(row.selected_products);
    expect(productIds).toHaveLength(5); // DEFAULT_TOTAL_ROUNDS
    expect(productIds.every((id: number) => typeof id === "number")).toBe(true);
  });
});

describe("getSession", () => {
  it("returns a session by ID", () => {
    const created = startGame("classic");
    const session = getSession(created.id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(created.id);
    expect(session!.gameMode).toBe("classic");
  });

  it("returns null for non-existent session", () => {
    const session = getSession("non-existent");
    expect(session).toBeNull();
  });
});

describe("getSessionProduct", () => {
  it("returns a product for classic mode", () => {
    const session = startGame("classic");
    const product = getSessionProduct(session.id);
    expect(product).not.toBeNull();
    expect(product.id).toBeDefined();
    expect(product.title).toBeDefined();
    expect(product.imageUrl).toBeDefined();
    expect(product.priceRange).toBeDefined();
    // Should NOT expose actual price
    expect(product.priceCents).toBeUndefined();
  });

  it("returns product + referencePrice for higher-lower mode", () => {
    const session = startGame("higher-lower");
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.product).toBeDefined();
    expect(data.referencePrice).toBeDefined();
    expect(typeof data.referencePrice).toBe("number");
  });

  it("returns products + question for comparison mode", () => {
    const session = startGame("comparison");
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.products).toBeDefined();
    expect(data.products.length).toBe(2);
    expect(["most-expensive", "least-expensive"]).toContain(data.question);
  });

  it("returns products + prices for price-match mode", () => {
    const session = startGame("price-match");
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.products).toBeDefined();
    expect(data.products.length).toBe(4);
    expect(data.prices).toBeDefined();
    expect(data.prices.length).toBe(4);
  });

  it("returns product + riser data for riser mode", () => {
    const session = startGame("riser");
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.product).toBeDefined();
    expect(data.maxPriceCents).toBeDefined();
    expect(data.speedPattern).toBeDefined();
    expect(data.durationMs).toBeDefined();
  });

  it("returns null for non-existent session", () => {
    expect(getSessionProduct("non-existent")).toBeNull();
  });
});

describe("submitGuess", () => {
  it("scores a classic guess and advances the round", () => {
    const session = startGame("classic");
    const product = getSessionProduct(session.id);

    // Get the actual price from the DB to test with
    const row = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(session.id) as any;
    const productIds = JSON.parse(row.selected_products);
    const actual = testDb.prepare("SELECT price_cents FROM products WHERE id = ?").get(productIds[0]) as any;

    const result = submitGuess(session.id, { guessedPriceCents: actual.price_cents });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(1000); // Exact match
    expect(result.session.currentRound).toBe(2);
    expect(result.session.totalScore).toBe(1000);
  });

  it("scores a higher-lower guess", () => {
    const session = startGame("higher-lower");
    const data = getSessionProduct(session.id);

    // Get actual price to determine correct answer
    const row = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(session.id) as any;
    const productIds = JSON.parse(row.selected_products);
    const actual = testDb.prepare("SELECT price_cents FROM products WHERE id = ?").get(productIds[0]) as any;

    const correctGuess = actual.price_cents > data.referencePrice ? "higher" : "lower";
    const result = submitGuess(session.id, { guess: correctGuess });
    expect(result).not.toBeNull();
    expect(result.result.correct).toBe(true);
    expect(result.result.score).toBeGreaterThan(0);
  });

  it("completes the game after DEFAULT_TOTAL_ROUNDS rounds", () => {
    const session = startGame("classic");

    for (let i = 0; i < 5; i++) {
      const result = submitGuess(session.id, { guessedPriceCents: 1000 });
      expect(result).not.toBeNull();
      if (i < 4) {
        expect(result.session.completed).toBe(false);
      } else {
        expect(result.session.completed).toBe(true);
      }
    }
  });

  it("completes a 10-round game when explicitly requested", () => {
    const session = startGame("classic", undefined, undefined, undefined, 10);
    for (let i = 0; i < 10; i++) {
      const result = submitGuess(session.id, { guessedPriceCents: 1000 });
      expect(result).not.toBeNull();
      if (i < 9) {
        expect(result.session.completed).toBe(false);
      } else {
        expect(result.session.completed).toBe(true);
      }
    }
  });

  it("returns null for completed session", () => {
    const session = startGame("classic");
    for (let i = 0; i < 5; i++) {
      submitGuess(session.id, { guessedPriceCents: 1000 });
    }
    const result = submitGuess(session.id, { guessedPriceCents: 1000 });
    expect(result).toBeNull();
  });

  it("returns null for non-existent session", () => {
    expect(submitGuess("non-existent", { guessedPriceCents: 1000 })).toBeNull();
  });

  it("handles timed-out guesses (score forced to 0)", () => {
    const session = startGame("classic");
    const result = submitGuess(session.id, { guessedPriceCents: 1000, timedOut: true });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });

  it("scores a comparison guess", () => {
    const session = startGame("comparison");
    const data = getSessionProduct(session.id);
    const guessedProductId = data.products[0].id;

    const result = submitGuess(session.id, { guessedProductId });
    expect(result).not.toBeNull();
    expect(result.result.products).toBeDefined();
    expect(result.result.question).toBeDefined();
    expect(result.result.correctProductId).toBeDefined();
    expect(typeof result.result.score).toBe("number");
  });

  it("scores a closest-without-going-over guess", () => {
    const session = startGame("closest-without-going-over");

    const result = submitGuess(session.id, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(result.result.product).toBeDefined();
    expect(result.result.pctOff).toBeDefined();
    expect(typeof result.result.wentOver).toBe("boolean");
  });

  it("scores a price-match guess", () => {
    const session = startGame("price-match");
    const data = getSessionProduct(session.id);

    // Build assignments from the products
    const assignments: Record<number, number> = {};
    for (const product of data.products) {
      assignments[product.id] = 1000; // Wrong price, but should still work
    }

    const result = submitGuess(session.id, { assignments });
    expect(result).not.toBeNull();
    expect(result.result.products).toBeDefined();
    expect(result.result.correctCount).toBeDefined();
    expect(typeof result.result.score).toBe("number");
  });

  it("scores a riser guess", () => {
    const session = startGame("riser");

    const result = submitGuess(session.id, { stoppedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(result.result.product).toBeDefined();
    expect(result.result.maxPriceCents).toBeDefined();
    expect(typeof result.result.wentOver).toBe("boolean");
    expect(typeof result.result.pctOff).toBe("number");
  });

  it("timed-out comparison guess scores 0 and correct is false", () => {
    const session = startGame("comparison");
    const data = getSessionProduct(session.id);
    const result = submitGuess(session.id, { guessedProductId: data.products[0].id, timedOut: true });
    expect(result.result.score).toBe(0);
    expect(result.result.correct).toBe(false);
  });
});

describe("getHint", () => {
  it("returns a hint range for classic mode", () => {
    const session = startGame("classic");
    const hint = getHint(session.id);
    expect(hint).not.toBeNull();
    expect(hint!.hintRange).toBeDefined();
    expect(hint!.hintRange.min).toBeLessThan(hint!.hintRange.max);
  });

  it("returns null for second hint on same round", () => {
    const session = startGame("classic");
    const first = getHint(session.id);
    expect(first).not.toBeNull();
    const second = getHint(session.id);
    expect(second).toBeNull();
  });

  it("returns hint for closest-without-going-over mode", () => {
    const session = startGame("closest-without-going-over");
    const hint = getHint(session.id);
    expect(hint).not.toBeNull();
  });

  it("returns null for modes that don't support hints", () => {
    const session = startGame("higher-lower");
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("returns null for non-existent session", () => {
    expect(getHint("non-existent")).toBeNull();
  });

  it("returns null for completed session", () => {
    const session = startGame("classic");
    // Complete all rounds
    for (let i = 0; i < 10; i++) {
      submitGuess(session.id, { guessedPriceCents: 1000 });
    }
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("returns null when product is not found", () => {
    const session = startGame("classic");
    // Corrupt the selected products to have a non-existent product ID
    testDb.prepare("UPDATE game_sessions SET selected_products = ? WHERE id = ?")
      .run(JSON.stringify([999999]), session.id);
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });
});

describe("getSessionProduct edge cases", () => {
  it("returns null when currentProductId is undefined (beyond selected products)", () => {
    const session = startGame("classic");
    // Set current_round beyond available products
    testDb.prepare("UPDATE game_sessions SET current_round = 999 WHERE id = ?").run(session.id);
    const result = getSessionProduct(session.id);
    expect(result).toBeNull();
  });

  it("returns null when product row not found in DB for single-product modes", () => {
    const session = startGame("classic");
    // Replace selected_products with a non-existent product ID
    testDb.prepare("UPDATE game_sessions SET selected_products = ? WHERE id = ?")
      .run(JSON.stringify([999999]), session.id);
    const result = getSessionProduct(session.id);
    expect(result).toBeNull();
  });

  it("returns product for closest-without-going-over mode (same as classic path)", () => {
    const session = startGame("closest-without-going-over");
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.id).toBeDefined();
    expect(data.title).toBeDefined();
  });

  it("handles null round_data gracefully for higher-lower getSessionProduct", () => {
    const session = startGame("higher-lower");
    // Clear round_data to force fallback
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.product).toBeDefined();
    expect(data.referencePrice).toBe(0); // fallback value
  });

  it("handles null round_data gracefully for riser getSessionProduct", () => {
    const session = startGame("riser");
    // Clear round_data to force fallback
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.product).toBeDefined();
    // maxPriceCents falls back to product.price_cents
    expect(data.maxPriceCents).toBeDefined();
    expect(data.speedPattern).toBe("linear");
    expect(data.durationMs).toBe(8000);
  });

  it("handles null round_data for comparison getSessionProduct", () => {
    const session = startGame("comparison");
    // Clear round_data to force question fallback
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const data = getSessionProduct(session.id);
    expect(data).not.toBeNull();
    expect(data.question).toBe("most-expensive"); // fallback
  });
});

describe("submitGuess edge cases", () => {
  it("handles null round_data for higher-lower submitGuess", () => {
    const session = startGame("higher-lower");
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const result = submitGuess(session.id, { guess: "higher" });
    expect(result).not.toBeNull();
    expect(result.result.referencePrice).toBe(0);
  });

  it("handles null round_data for comparison submitGuess", () => {
    const session = startGame("comparison");
    // Get a valid product ID from the selected products
    const row = testDb.prepare("SELECT selected_products FROM game_sessions WHERE id = ?").get(session.id) as any;
    const productIds = JSON.parse(row.selected_products);
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const result = submitGuess(session.id, { guessedProductId: productIds[0] });
    expect(result).not.toBeNull();
    expect(result.result.question).toBe("most-expensive"); // fallback
  });

  it("handles null round_data for riser submitGuess", () => {
    const session = startGame("riser");
    testDb.prepare("UPDATE game_sessions SET round_data = NULL WHERE id = ?").run(session.id);
    const result = submitGuess(session.id, { stoppedPriceCents: 1000 });
    expect(result).not.toBeNull();
    // maxPriceCents falls back to product.price_cents
    expect(result.result.maxPriceCents).toBeDefined();
  });

  it("allows guess within time limit after fetching product", () => {
    const session = startGame("classic");
    // Fetch product starts the server-side timer
    getSessionProduct(session.id);
    // Immediate guess should be within time limit
    const result = submitGuess(session.id, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(result.result.score).toBeGreaterThanOrEqual(0);
    expect(result.result.timedOut).toBeUndefined();
  });

  it("scores zero when client sends timedOut flag", () => {
    const session = startGame("classic");
    getSessionProduct(session.id);
    const result = submitGuess(session.id, { guessedPriceCents: 1000, timedOut: true });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });

  it("scores zero when guess submitted without fetching product first (H1 fix)", () => {
    const session = startGame("classic");
    // Submit directly without calling getSessionProduct — server should treat as timed out
    const result = submitGuess(session.id, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });

  it("scores zero when server-side timer has expired (S6 enforcement)", () => {
    const session = startGame("classic");
    getSessionProduct(session.id);

    // Advance time past the server-side limit (30s * 2x grace = 60s)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);

    const result = submitGuess(session.id, { guessedPriceCents: 1000 });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);

    vi.useRealTimers();
  });
});
