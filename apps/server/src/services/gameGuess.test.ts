import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { getUtcDateString } from "@price-game/shared";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));
vi.mock("./gameHints", () => ({
  cleanupSessionHints: vi.fn(),
}));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { getSessionProduct, submitGuess, cleanupSessionTimers } = await import("./gameGuess");

function createSession(mode: string, productIds: number[], roundData?: any, currentRound = 1) {
  const id = `session-${Date.now()}-${Math.random()}`;
  testDb.prepare(
    `INSERT INTO game_sessions (id, current_round, total_score, selected_products, started_at, game_mode, round_data)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
  ).run(id, currentRound, JSON.stringify(productIds), new Date().toISOString(), mode, roundData ? JSON.stringify(roundData) : null);
  return id;
}

function getProductIds(count: number): number[] {
  return (testDb.prepare("SELECT id FROM products LIMIT ?").all(count) as { id: number }[]).map(r => r.id);
}

function getProduct(id: number) {
  return testDb.prepare("SELECT * FROM products WHERE id = ?").get(id) as any;
}

// ---------------------------------------------------------------------------
// getSessionProduct
// ---------------------------------------------------------------------------
describe("getSessionProduct", () => {
  it("classic — returns product object", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    const result = getSessionProduct(sid);
    expect(result).toBeTruthy();
    expect(result.id).toBe(ids[0]);
    expect(result.title).toBeDefined();
    expect(result).not.toHaveProperty("priceCents");
  });

  it("comparison — returns products array and question", () => {
    const ids = getProductIds(20);
    const roundData = { "1": { question: "most-expensive" } };
    const sid = createSession("comparison", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(2);
    expect(result.question).toBe("most-expensive");
  });

  it("price-match — returns products and shuffled prices", () => {
    const ids = getProductIds(40);
    const sid = createSession("price-match", ids);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(4);
    expect(result.prices).toHaveLength(4);
    result.prices.forEach((p: number) => expect(typeof p).toBe("number"));
  });

  it("odd-one-out — returns products", () => {
    const ids = getProductIds(10);
    const roundData = { "1": { productIds: ids.slice(0, 4) } };
    const sid = createSession("odd-one-out", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(4);
  });

  it("market-basket — returns products and itemCount", () => {
    const ids = getProductIds(10);
    const roundData = { "1": { productIds: ids.slice(0, 3), itemCount: 3 } };
    const sid = createSession("market-basket", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(3);
    expect(result.itemCount).toBe(3);
  });

  it("sort-it-out — returns products", () => {
    const ids = getProductIds(50);
    const roundData = { "1": { productIds: ids.slice(0, 5) } };
    const sid = createSession("sort-it-out", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(5);
  });

  it("budget-builder — returns products and budgetCents", () => {
    const ids = getProductIds(10);
    const roundData = { "1": { productIds: ids.slice(0, 6), budgetCents: 50000 } };
    const sid = createSession("budget-builder", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(6);
    expect(result.budgetCents).toBe(50000);
  });

  it("chain-reaction — returns products", () => {
    const ids = getProductIds(50);
    const roundData = { "1": { productIds: ids.slice(0, 5) } };
    const sid = createSession("chain-reaction", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.products).toHaveLength(5);
  });

  it("higher-lower — returns product and referencePrice", () => {
    const ids = getProductIds(10);
    const roundData = { "1": { referencePrice: 5000 } };
    const sid = createSession("higher-lower", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.product).toBeTruthy();
    expect(result.product.id).toBe(ids[0]);
    expect(result.referencePrice).toBe(5000);
  });

  it("riser — returns product, maxPriceCents, speedPattern, durationMs", () => {
    const ids = getProductIds(10);
    const roundData = { "1": { maxPriceCents: 20000, speedPattern: "linear", durationMs: 10000 } };
    const sid = createSession("riser", ids, roundData);
    const result = getSessionProduct(sid);
    expect(result.product).toBeTruthy();
    expect(result.maxPriceCents).toBe(20000);
    expect(result.speedPattern).toBe("linear");
    expect(result.durationMs).toBe(10000);
  });

  it("completed session returns null", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    testDb.prepare("UPDATE game_sessions SET completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sid);
    expect(getSessionProduct(sid)).toBeNull();
  });

  it("nonexistent session returns null", () => {
    expect(getSessionProduct("no-such-session")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitGuess
// ---------------------------------------------------------------------------
describe("submitGuess", () => {
  it("classic — returns result with score, pctOff, product with price", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents });
    expect(result).toBeTruthy();
    expect(result.result.score).toBeGreaterThanOrEqual(0);
    expect(typeof result.result.pctOff).toBe("number");
    expect(result.result.product.priceCents).toBe(product.price_cents);
  });

  it("higher-lower — returns correct/incorrect and score", () => {
    const ids = getProductIds(10);
    const product = getProduct(ids[0]);
    const referencePrice = product.price_cents - 100;
    const roundData = { "1": { referencePrice } };
    const sid = createSession("higher-lower", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { guess: "higher" });
    expect(result).toBeTruthy();
    expect(typeof result.result.correct).toBe("boolean");
    expect(typeof result.result.score).toBe("number");
  });

  it("comparison — returns correctProductId, guessedProductId, score", () => {
    const ids = getProductIds(20);
    const roundData = { "1": { question: "most-expensive" } };
    const sid = createSession("comparison", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { guessedProductId: ids[0] });
    expect(result).toBeTruthy();
    expect(result.result.correctProductId).toBeDefined();
    expect(result.result.guessedProductId).toBe(ids[0]);
    expect(typeof result.result.score).toBe("number");
  });

  it("closest-without-going-over — returns wentOver flag", () => {
    const ids = getProductIds(10);
    const sid = createSession("closest-without-going-over", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents + 1000 });
    expect(result).toBeTruthy();
    expect(typeof result.result.wentOver).toBe("boolean");
    expect(typeof result.result.pctOff).toBe("number");
  });

  it("price-match — returns correctCount", () => {
    const ids = getProductIds(40);
    const sid = createSession("price-match", ids);
    getSessionProduct(sid);
    const assignments: Record<string, number> = {};
    for (let i = 0; i < 4; i++) {
      const p = getProduct(ids[i]);
      assignments[String(ids[i])] = p.price_cents;
    }
    const result = submitGuess(sid, { assignments });
    expect(result).toBeTruthy();
    expect(result.result.correctCount).toBe(4);
    expect(typeof result.result.score).toBe("number");
  });

  it("riser — returns wentOver flag", () => {
    const ids = getProductIds(10);
    const product = getProduct(ids[0]);
    const roundData = { "1": { maxPriceCents: 20000, speedPattern: "linear", durationMs: 10000 } };
    const sid = createSession("riser", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { stoppedPriceCents: product.price_cents + 5000 });
    expect(result).toBeTruthy();
    expect(typeof result.result.wentOver).toBe("boolean");
    expect(typeof result.result.score).toBe("number");
  });

  it("odd-one-out — returns outlier and correctness", () => {
    const ids = getProductIds(10);
    const roundProductIds = ids.slice(0, 4);
    const roundData = { "1": { productIds: roundProductIds } };
    const sid = createSession("odd-one-out", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { guessedProductId: roundProductIds[0] });
    expect(result).toBeTruthy();
    expect(result.result.outlierProductId).toBeDefined();
    expect(typeof result.result.correct).toBe("boolean");
    expect(typeof result.result.score).toBe("number");
  });

  it("market-basket — returns actual total and pctOff", () => {
    const ids = getProductIds(10);
    const roundProductIds = ids.slice(0, 3);
    const roundData = { "1": { productIds: roundProductIds, itemCount: 3 } };
    const sid = createSession("market-basket", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { guessedTotalCents: 10000 });
    expect(result).toBeTruthy();
    expect(typeof result.result.actualTotalCents).toBe("number");
    expect(typeof result.result.pctOff).toBe("number");
    expect(typeof result.result.score).toBe("number");
  });

  it("sort-it-out — returns correctOrder and correctCount", () => {
    const ids = getProductIds(10);
    const roundProductIds = ids.slice(0, 5);
    const roundData = { "1": { productIds: roundProductIds } };
    const sid = createSession("sort-it-out", ids, roundData);
    getSessionProduct(sid);
    // Submit in the order we have (may or may not be correct)
    const result = submitGuess(sid, { submittedOrder: roundProductIds });
    expect(result).toBeTruthy();
    expect(Array.isArray(result.result.correctOrder)).toBe(true);
    expect(typeof result.result.correctCount).toBe("number");
  });

  it("budget-builder — returns cartTotal and budgetCents", () => {
    const ids = getProductIds(10);
    const roundProductIds = ids.slice(0, 6);
    const roundData = { "1": { productIds: roundProductIds, budgetCents: 50000 } };
    const sid = createSession("budget-builder", ids, roundData);
    getSessionProduct(sid);
    const result = submitGuess(sid, { selectedProductIds: [roundProductIds[0], roundProductIds[1]] });
    expect(result).toBeTruthy();
    expect(typeof result.result.cartTotalCents).toBe("number");
    expect(result.result.budgetCents).toBe(50000);
    expect(typeof result.result.score).toBe("number");
  });

  it("chain-reaction — returns correctCount and chainLength", () => {
    const ids = getProductIds(10);
    const roundProductIds = ids.slice(0, 5);
    const roundData = { "1": { productIds: roundProductIds } };
    const sid = createSession("chain-reaction", ids, roundData);
    getSessionProduct(sid);
    const guesses = ["more", "more", "more", "more"] as const;
    const result = submitGuess(sid, { chainGuesses: [...guesses] });
    expect(result).toBeTruthy();
    expect(typeof result.result.correctCount).toBe("number");
    expect(result.result.chainLength).toBe(4);
    expect(typeof result.result.score).toBe("number");
  });

  // --- Bidding (single-player — daily challenge) ---
  it("bidding — under-price bid uses proximity scoring (ClosestPage-shaped result)", () => {
    const ids = getProductIds(10);
    const sid = createSession("bidding", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    // Bid $1 under the actual price → very close → high (but not perfect) score.
    const under = Math.max(1, product.price_cents - 100);
    const result = submitGuess(sid, { guessedPriceCents: under });
    expect(result).toBeTruthy();
    // Proximity-based: a close underbid scores high but below 1000 (no exact bonus).
    expect(result.result.score).toBeGreaterThan(500);
    expect(result.result.score).toBeLessThan(1000);
    expect(result.result.guessedPriceCents).toBe(under);
    expect(result.result.wentOver).toBe(false);
    expect(typeof result.result.pctOff).toBe("number");
    expect(result.result.product.priceCents).toBe(product.price_cents);
  });

  it("bidding — exact bid applies the +500 exact-match bonus", () => {
    const ids = getProductIds(10);
    const sid = createSession("bidding", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents });
    expect(result).toBeTruthy();
    expect(result.result.score).toBe(1500);
    expect(result.result.wentOver).toBe(false);
  });

  it("bidding — over-price bid returns score 0 and wentOver: true", () => {
    const ids = getProductIds(10);
    const sid = createSession("bidding", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const over = product.price_cents + 1;
    const result = submitGuess(sid, { guessedPriceCents: over });
    expect(result).toBeTruthy();
    expect(result.result.score).toBe(0);
    expect(result.result.wentOver).toBe(true);
  });

  it("bidding — persists the bid in game_rounds with guessed_price_cents", () => {
    const ids = getProductIds(10);
    const sid = createSession("bidding", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const under = Math.max(1, product.price_cents - 250);
    submitGuess(sid, { guessedPriceCents: under });
    const row = testDb
      .prepare("SELECT product_id, guessed_price_cents, score FROM game_rounds WHERE session_id = ?")
      .get(sid) as { product_id: number; guessed_price_cents: number; score: number };
    expect(row.product_id).toBe(ids[0]);
    expect(row.guessed_price_cents).toBe(under);
    // Proximity-based score for a close under-bid — positive and < 1000 (no exact bonus).
    expect(row.score).toBeGreaterThan(0);
    expect(row.score).toBeLessThan(1000);
  });

  it("bidding — advances to round 2 using the second selected product", () => {
    const ids = getProductIds(10);
    const sid = createSession("bidding", ids);
    getSessionProduct(sid);
    const p1 = getProduct(ids[0]);
    submitGuess(sid, { guessedPriceCents: Math.max(1, p1.price_cents - 100) });
    const round2 = getSessionProduct(sid);
    expect(round2.id).toBe(ids[1]);
  });

  it("double-submit prevention — existing guess returns null", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const first = submitGuess(sid, { guessedPriceCents: product.price_cents });
    expect(first).toBeTruthy();
    // Second submit for same round
    getSessionProduct(sid); // fetch for round 2 now
    // Manually insert a duplicate round row for round 2 to trigger double-submit guard
    testDb.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sid, 2, ids[1], 0, 0, new Date().toISOString());
    const second = submitGuess(sid, { guessedPriceCents: 1000 });
    expect(second).toBeNull();
  });

  it("completed session returns null", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    testDb.prepare("UPDATE game_sessions SET completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), sid);
    const result = submitGuess(sid, { guessedPriceCents: 1000 });
    expect(result).toBeNull();
  });

  it("nonexistent session returns null", () => {
    expect(submitGuess("no-such-session", { guessedPriceCents: 1000 })).toBeNull();
  });

  it("timedOut flag forces score to 0", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    getSessionProduct(sid);
    const product = getProduct(ids[0]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents, timedOut: true });
    expect(result).toBeTruthy();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });

  it("last round completes the session", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids, null, 10);
    getSessionProduct(sid);
    const product = getProduct(ids[9]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents });
    expect(result).toBeTruthy();
    expect(result.session.completed).toBe(true);
    const dbSession = testDb.prepare("SELECT completed_at FROM game_sessions WHERE id = ?").get(sid) as any;
    expect(dbSession.completed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cleanupSessionTimers
// ---------------------------------------------------------------------------
describe("cleanupSessionTimers", () => {
  it("does not throw for unknown session", () => {
    expect(() => cleanupSessionTimers("nonexistent")).not.toThrow();
  });

  it("cleans up after getSessionProduct was called", () => {
    const ids = getProductIds(10);
    const sid = createSession("classic", ids);
    getSessionProduct(sid);
    cleanupSessionTimers(sid);
    // After cleanup, submitGuess should treat it as no-fetch (serverTimedOut) -> score 0
    const product = getProduct(ids[0]);
    const result = submitGuess(sid, { guessedPriceCents: product.price_cents });
    expect(result).toBeTruthy();
    expect(result.result.score).toBe(0);
    expect(result.result.timedOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Daily challenge integration: first-guess commit + final-round payload
// ---------------------------------------------------------------------------
describe("submitGuess — daily challenge integration", () => {
  /**
   * Helper: create a daily session row directly. We bypass startDailyGame
   * to avoid the daily_enabled gate (this test is exercising the guess
   * pipeline, not the start path).
   */
  function createDailySession(opts: {
    userId?: string | null;
    productIds: number[];
    roundData?: Record<string, unknown>;
    currentRound?: number;
    dailyDate?: string;
    visitorId?: string | null;
  }): string {
    const id = `daily-session-${Date.now()}-${Math.random()}`;
    testDb.prepare(
      `INSERT INTO game_sessions
         (id, current_round, total_score, selected_products, started_at, game_mode, round_data, user_id, is_daily, daily_date, visitor_id)
       VALUES (?, ?, 0, ?, ?, 'classic', ?, ?, 1, ?, ?)`
    ).run(
      id,
      opts.currentRound ?? 1,
      JSON.stringify(opts.productIds),
      new Date().toISOString(),
      opts.roundData ? JSON.stringify(opts.roundData) : null,
      opts.userId ?? null,
      opts.dailyDate ?? "2026-04-15",
      opts.visitorId ?? null,
    );
    return id;
  }

  it("inserts a daily_plays row on the FIRST guess (round 1)", () => {
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids, dailyDate: "2026-04-15" });
    getSessionProduct(sid); // prime the round timer
    const product = getProduct(ids[0]);
    submitGuess(sid, { guessedPriceCents: product.price_cents });
    const row = testDb.prepare("SELECT * FROM daily_plays WHERE session_id = ?").get(sid) as any;
    expect(row).toBeDefined();
    expect(row.daily_date).toBe("2026-04-15");
    expect(row.completed_at).toBeNull();
  });

  it("does NOT insert a second daily_plays row on subsequent guesses", () => {
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids });
    getSessionProduct(sid);
    submitGuess(sid, { guessedPriceCents: 1 });
    // Round 2 — call getSessionProduct first, then guess
    getSessionProduct(sid);
    submitGuess(sid, { guessedPriceCents: 1 });
    const count = testDb.prepare("SELECT COUNT(*) as c FROM daily_plays WHERE session_id = ?").get(sid) as { c: number };
    expect(count.c).toBe(1);
  });

  it("blocks the first guess of a SECOND session for the same logged-in user / date (race-safety)", () => {
    const userId = seedUser(testDb, "race-tester");
    const ids = getProductIds(10); // enough for two sessions
    const sidA = createDailySession({ productIds: ids.slice(0, 5), userId, dailyDate: "2026-04-15" });
    const sidB = createDailySession({ productIds: ids.slice(0, 5), userId, dailyDate: "2026-04-15" });

    getSessionProduct(sidA);
    const aResult = submitGuess(sidA, { guessedPriceCents: 1 });
    expect(aResult).toBeTruthy();

    getSessionProduct(sidB);
    const bResult = submitGuess(sidB, { guessedPriceCents: 1 });
    expect(bResult).toBeTruthy();
    // The second session's commit should have failed via 409 sentinel.
    expect(bResult.error).toBe("already_played");
  });

  it("two anonymous sessions for the same date are both allowed (no user uniqueness)", () => {
    const ids = getProductIds(10);
    const sidA = createDailySession({ productIds: ids.slice(0, 5), dailyDate: "2026-04-15" });
    const sidB = createDailySession({ productIds: ids.slice(0, 5), dailyDate: "2026-04-15" });

    getSessionProduct(sidA);
    const aResult = submitGuess(sidA, { guessedPriceCents: 1 });
    expect(aResult).toBeTruthy();
    expect(aResult.error).toBeUndefined();

    getSessionProduct(sidB);
    const bResult = submitGuess(sidB, { guessedPriceCents: 1 });
    expect(bResult).toBeTruthy();
    expect(bResult.error).toBeUndefined();
  });

  // Device-aware notifications depend on daily_plays carrying the browser's
  // visitor_id so the scheduler can tell whether the device already played.
  // The session row stores visitor_id at start; submitGuess must copy it
  // onto daily_plays on the first guess.
  it("writes visitor_id from the session onto daily_plays on the first guess", () => {
    const ids = getProductIds(5);
    const sid = createDailySession({
      productIds: ids,
      dailyDate: "2026-04-15",
      visitorId: "visitor-for-daily",
    });
    getSessionProduct(sid);
    submitGuess(sid, { guessedPriceCents: 1 });

    const row = testDb
      .prepare("SELECT visitor_id FROM daily_plays WHERE session_id = ?")
      .get(sid) as { visitor_id: string };
    expect(row.visitor_id).toBe("visitor-for-daily");
  });

  // Guest double-play protection via the new UNIQUE (visitor_id, daily_date)
  // index. Two daily sessions for the same visitor on the same date cannot
  // both commit; the second surfaces the same `already_played` sentinel as
  // logged-in double-plays.
  it("blocks the first guess of a SECOND guest session for the same visitor / date", () => {
    const ids = getProductIds(10);
    const sidA = createDailySession({
      productIds: ids.slice(0, 5),
      dailyDate: "2026-04-15",
      visitorId: "visitor-repeat",
    });
    const sidB = createDailySession({
      productIds: ids.slice(0, 5),
      dailyDate: "2026-04-15",
      visitorId: "visitor-repeat",
    });

    getSessionProduct(sidA);
    const aResult = submitGuess(sidA, { guessedPriceCents: 1 });
    expect(aResult).toBeTruthy();
    expect(aResult.error).toBeUndefined();

    getSessionProduct(sidB);
    const bResult = submitGuess(sidB, { guessedPriceCents: 1 });
    expect(bResult).toBeTruthy();
    expect(bResult.error).toBe("already_played");
  });

  it("on the FINAL round, updates daily_plays with score + per_round_scores + completed_at", () => {
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids });
    // Walk through all 5 rounds
    for (let r = 1; r <= 5; r++) {
      getSessionProduct(sid);
      submitGuess(sid, { guessedPriceCents: 1 });
    }
    const row = testDb.prepare("SELECT * FROM daily_plays WHERE session_id = ?").get(sid) as any;
    expect(row.completed_at).not.toBeNull();
    expect(row.per_round_scores).not.toBeNull();
    const scores = JSON.parse(row.per_round_scores);
    expect(scores).toHaveLength(5);
  });

  it("on the FINAL round of a logged-in daily, updates the user's streak columns", () => {
    // Note: lifetime_score is updated via recordSinglePlayerGame in
    // routes/game.ts after submitGuess returns; submitGuess itself only
    // touches the streak. We verify the streak path here and rely on
    // routes/game.test.ts to cover the lifetime_score path.
    const userId = seedUser(testDb, "winner");
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids, userId, dailyDate: "2026-04-15" });

    for (let r = 1; r <= 5; r++) {
      getSessionProduct(sid);
      submitGuess(sid, { guessedPriceCents: 1 });
    }

    const user = testDb
      .prepare("SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?")
      .get(userId) as any;
    expect(user.daily_streak_current).toBe(1);
    expect(user.daily_streak_best).toBe(1);
    expect(user.daily_streak_last_date).toBe("2026-04-15");
  });

  it("the FINAL-round response payload includes a `daily` block for logged-in users", () => {
    // Use today's real UTC date for the daily so `getStreakForUser`
    // (which decays `current` to 0 when `lastDate < today - 1`, per the
    // fix in #129) still reports the fresh streak back through the
    // response payload. A hardcoded fixture date would silently go stale
    // once the wall clock advanced past it.
    const today = getUtcDateString(new Date());
    const userId = seedUser(testDb, "payloader");
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids, userId, dailyDate: today });

    let last;
    for (let r = 1; r <= 5; r++) {
      getSessionProduct(sid);
      last = submitGuess(sid, { guessedPriceCents: 1 });
    }
    expect(last.session.completed).toBe(true);
    expect(last.daily).toBeDefined();
    expect(last.daily.streak.current).toBe(1);
    expect(last.daily.isNewStreak).toBe(true);
    expect(last.daily.isNewBest).toBe(true);
  });

  it("the FINAL-round response payload omits `daily` for anonymous users", () => {
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids, dailyDate: "2026-04-15" });

    let last;
    for (let r = 1; r <= 5; r++) {
      getSessionProduct(sid);
      last = submitGuess(sid, { guessedPriceCents: 1 });
    }
    expect(last.session.completed).toBe(true);
    expect(last.daily).toBeUndefined();
  });

  it("uses DAILY_TOTAL_ROUNDS=5 (not TOTAL_ROUNDS=10) for the final-round check", () => {
    const userId = seedUser(testDb, "fiveround");
    const ids = getProductIds(5);
    const sid = createDailySession({ productIds: ids, userId });
    // After exactly 5 rounds the session should be marked completed.
    for (let r = 1; r <= 5; r++) {
      getSessionProduct(sid);
      submitGuess(sid, { guessedPriceCents: 1 });
    }
    const session = testDb.prepare("SELECT completed_at FROM game_sessions WHERE id = ?").get(sid) as any;
    expect(session.completed_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // nextRoundImageUrls hint — preload-next-product optimization
  // -------------------------------------------------------------------------

  describe("nextRoundImageUrls preload hint", () => {
    it("includes next round's image URLs on a non-terminal classic guess", () => {
      const ids = getProductIds(10);
      const sid = createSession("classic", ids);
      getSessionProduct(sid);
      const product = getProduct(ids[0]);
      const res = submitGuess(sid, { guessedPriceCents: product.price_cents });
      expect(res?.nextRoundImageUrls).toEqual([`/api/image/${ids[1]}`]);
    });

    it("returns multiple URLs for modes that show multiple products per round", () => {
      const ids = getProductIds(20);
      // comparison serves COMPARISON_PRODUCTS_PER_ROUND (2) products per round.
      const sid = createSession("comparison", ids);
      getSessionProduct(sid);
      const res = submitGuess(sid, { guessedProductId: ids[0] });
      // Second round's products come from indices 2 and 3.
      expect(res?.nextRoundImageUrls).toEqual([
        `/api/image/${ids[2]}`,
        `/api/image/${ids[3]}`,
      ]);
    });

    it("omits the hint on the final round (no next round to preload)", () => {
      const ids = getProductIds(3);
      // 3-round game: play rounds 1 and 2, then the third should have no hint.
      const sid = createSession("classic", ids);
      testDb.prepare("UPDATE game_sessions SET total_rounds = 3 WHERE id = ?").run(sid);
      for (let r = 1; r <= 2; r++) {
        getSessionProduct(sid);
        submitGuess(sid, { guessedPriceCents: 1 });
      }
      getSessionProduct(sid);
      const finalRes = submitGuess(sid, { guessedPriceCents: 1 });
      expect(finalRes?.nextRoundImageUrls).toBeUndefined();
    });
  });
});
