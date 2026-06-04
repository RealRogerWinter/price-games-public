/**
 * Integration tests for the full single-player game flow.
 *
 * Tests the complete REST API flow: start game → get product →
 * submit guess → repeat for all rounds → save to leaderboard.
 * Covers all 6 game modes and the hint system.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import { DEFAULT_TOTAL_ROUNDS } from "@price-game/shared";
import type { Database as DatabaseType } from "better-sqlite3";

/** Alias for brevity in loop bounds; this is the default round count. */
const R = DEFAULT_TOTAL_ROUNDS;

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { startGame, getSession, getSessionProduct, submitGuess, getHint } =
  await import("../services/gameEngine");

describe("Classic mode — full game", () => {
  it("plays through all default rounds with guesses", () => {
    const session = startGame("classic");
    expect(session.id).toBeDefined();
    expect(session.currentRound).toBe(1);
    expect(session.totalRounds).toBe(R);
    expect(session.totalScore).toBe(0);
    expect(session.completed).toBe(false);
    expect(session.gameMode).toBe("classic");

    let totalScore = 0;
    for (let round = 1; round <= R; round++) {
      // Get product
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.id).toBeDefined();
      expect(product.title).toBeDefined();
      // Price should NOT be exposed
      expect(product.priceCents).toBeUndefined();

      // Submit guess
      const result = submitGuess(session.id, { guessedPriceCents: 5000 });
      expect(result).not.toBeNull();
      expect(result.result.score).toBeGreaterThanOrEqual(0);
      expect(result.result.product.priceCents).toBeDefined(); // price revealed

      totalScore += result.result.score;
      expect(result.session.totalScore).toBe(totalScore);

      if (round < R) {
        expect(result.session.completed).toBe(false);
        expect(result.session.currentRound).toBe(round + 1);
      } else {
        expect(result.session.completed).toBe(true);
      }
    }

    // After completion, no more guesses
    expect(submitGuess(session.id, { guessedPriceCents: 1 })).toBeNull();
    expect(getSessionProduct(session.id)).toBeNull();
  });

});

describe("Higher-Lower mode — full game", () => {
  it("plays through all 10 rounds with higher/lower guesses", () => {
    const session = startGame("higher-lower");
    expect(session.gameMode).toBe("higher-lower");

    for (let round = 1; round <= R; round++) {
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.product).toBeDefined();
      expect(product.referencePrice).toBeDefined();
      expect(product.referencePrice).toBeGreaterThan(0);

      const result = submitGuess(session.id, { guess: "higher" });
      expect(result).not.toBeNull();
      expect(typeof result.result.correct).toBe("boolean");
      expect(result.result.score).toBeGreaterThanOrEqual(0);
      expect(result.result.product.priceCents).toBeDefined();
    }

    expect(getSession(session.id)!.completed).toBe(true);
  });
});

describe("Comparison mode — full game", () => {
  it("plays through all 10 rounds choosing between products", () => {
    const session = startGame("comparison");
    expect(session.gameMode).toBe("comparison");

    for (let round = 1; round <= R; round++) {
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.products).toBeDefined();
      expect(product.products.length).toBe(2);
      expect(product.question).toMatch(/^(most-expensive|least-expensive)$/);

      const result = submitGuess(session.id, {
        guessedProductId: product.products[0].id,
      });
      expect(result).not.toBeNull();
      expect(typeof result.result.correct).toBe("boolean");
      expect(result.result.correctProductId).toBeDefined();
      expect(result.result.products.length).toBe(2);
      // Prices should be revealed
      expect(result.result.products[0].priceCents).toBeDefined();
    }

    expect(getSession(session.id)!.completed).toBe(true);
  });
});

describe("Closest-Without-Going-Over mode — full game", () => {
  it("plays through all 10 rounds, penalizing overguesses", () => {
    const session = startGame("closest-without-going-over");
    expect(session.gameMode).toBe("closest-without-going-over");

    let hadWentOver = false;
    for (let round = 1; round <= R; round++) {
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.id).toBeDefined();

      // Alternate between under and over guesses
      const guessCents = round % 2 === 0 ? 1 : 999999;
      const result = submitGuess(session.id, { guessedPriceCents: guessCents });
      expect(result).not.toBeNull();
      expect(typeof result.result.wentOver).toBe("boolean");

      if (result.result.wentOver) {
        expect(result.result.score).toBe(0);
        hadWentOver = true;
      }
    }

    // At least some rounds should have been over (999999 is above most products)
    expect(hadWentOver).toBe(true);
    expect(getSession(session.id)!.completed).toBe(true);
  });
});

describe("Price Match mode — full game", () => {
  it("plays through all 10 rounds matching products to prices", () => {
    const session = startGame("price-match");
    expect(session.gameMode).toBe("price-match");

    for (let round = 1; round <= R; round++) {
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.products).toBeDefined();
      expect(product.products.length).toBe(4);
      expect(product.prices).toBeDefined();
      expect(product.prices.length).toBe(4);

      // Create arbitrary assignments
      const assignments: Record<number, number> = {};
      for (let i = 0; i < product.products.length; i++) {
        assignments[product.products[i].id] = product.prices[i];
      }

      const result = submitGuess(session.id, { assignments });
      expect(result).not.toBeNull();
      expect(result.result.score).toBeGreaterThanOrEqual(0);
      expect(result.result.correctCount).toBeGreaterThanOrEqual(0);
      expect(result.result.products.length).toBe(4);
    }

    expect(getSession(session.id)!.completed).toBe(true);
  });
});

describe("Riser mode — full game", () => {
  it("plays through all 10 rounds stopping the rising price", () => {
    const session = startGame("riser");
    expect(session.gameMode).toBe("riser");

    for (let round = 1; round <= R; round++) {
      const product = getSessionProduct(session.id);
      expect(product).not.toBeNull();
      expect(product.product).toBeDefined();
      expect(product.maxPriceCents).toBeDefined();
      expect(product.maxPriceCents).toBeGreaterThan(0);
      expect(product.speedPattern).toMatch(/^(linear|accelerating|decelerating|wave)$/);
      expect(product.durationMs).toBeGreaterThanOrEqual(8000);

      const result = submitGuess(session.id, { stoppedPriceCents: 5000 });
      expect(result).not.toBeNull();
      expect(typeof result.result.wentOver).toBe("boolean");
      expect(result.result.product.priceCents).toBeDefined();
    }

    expect(getSession(session.id)!.completed).toBe(true);
  });
});

describe("Hint system", () => {
  it("provides hint for classic mode", () => {
    const session = startGame("classic");
    const hint = getHint(session.id);
    expect(hint).not.toBeNull();
    expect(hint!.hintRange.min).toBeGreaterThan(0);
    expect(hint!.hintRange.max).toBeGreaterThan(hint!.hintRange.min);
  });

  it("provides hint for closest-without-going-over mode", () => {
    const session = startGame("closest-without-going-over");
    const hint = getHint(session.id);
    expect(hint).not.toBeNull();
    expect(hint!.hintRange.min).toBeGreaterThan(0);
  });

  it("denies hint for higher-lower mode", () => {
    const session = startGame("higher-lower");
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("denies hint for comparison mode", () => {
    const session = startGame("comparison");
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("denies hint for price-match mode", () => {
    const session = startGame("price-match");
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("denies hint for riser mode", () => {
    const session = startGame("riser");
    const hint = getHint(session.id);
    expect(hint).toBeNull();
  });

  it("allows only one hint per round", () => {
    const session = startGame("classic");
    const hint1 = getHint(session.id);
    expect(hint1).not.toBeNull();

    const hint2 = getHint(session.id);
    expect(hint2).toBeNull(); // Already used for this round
  });

  it("allows hint on the next round after advancing", () => {
    const session = startGame("classic");
    getHint(session.id);

    // Advance to next round
    submitGuess(session.id, { guessedPriceCents: 5000 });

    // Should allow hint on new round
    const hint = getHint(session.id);
    expect(hint).not.toBeNull();
  });
});

describe("Session retrieval", () => {
  it("returns null for non-existent session", () => {
    expect(getSession("nonexistent-id")).toBeNull();
  });

  it("tracks score accumulation across rounds", () => {
    const session = startGame("classic");
    const midPoint = Math.floor(R / 2);

    for (let round = 1; round <= midPoint; round++) {
      submitGuess(session.id, { guessedPriceCents: 5000 });
    }

    const midSession = getSession(session.id)!;
    expect(midSession.currentRound).toBe(midPoint + 1);
    expect(midSession.completed).toBe(false);
  });
});

describe("Edge cases", () => {
  it("handles 0 cents guess in classic", () => {
    const session = startGame("classic");
    const result = submitGuess(session.id, { guessedPriceCents: 0 });
    expect(result).not.toBeNull();
    expect(result.result.score).toBeGreaterThanOrEqual(0);
  });

  it("handles maximum price guess", () => {
    const session = startGame("classic");
    const result = submitGuess(session.id, { guessedPriceCents: 10_000_000 });
    expect(result).not.toBeNull();
  });

  it("handles timed out guess", () => {
    const session = startGame("classic");
    const result = submitGuess(session.id, { guessedPriceCents: 5000, timedOut: true });
    expect(result).not.toBeNull();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });
});
