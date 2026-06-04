import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import { DEFAULT_TOTAL_ROUNDS } from "@price-game/shared";
import { invalidateCategoriesCache } from "../services/categoriesCache";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return { default: null as any };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);
  const mod = await import("../db");
  (mod as any).default = testDb;
  // PR1 perf F4: the categories cache is module-level state, so it
  // outlives the beforeEach DB swap and would otherwise return stale data
  // from the previous test. Drop it explicitly per test.
  invalidateCategoriesCache();
});

const { startGame, getSession, submitGuess: doGuess } = await import("../services/gameEngine");
const { default: router } = await import("./game");

function getHandler(path: string, method: string = "get") {
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path) {
      const methodStack = layer.route.stack.find((s: any) =>
        method === "get" ? s.method === "get" : s.method === "post"
      );
      return methodStack?.handle;
    }
  }
  return undefined;
}

function mockReq(params: Record<string, string> = {}, body: any = {}, query: Record<string, string> = {}) {
  return { params, body, query } as any;
}

function mockRes() {
  const data: { statusCode?: number; body?: any } = {};
  const res = {
    json(d: any) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
  } as any;
  return { res, data };
}

describe("GET /categories", () => {
  it("returns categories with counts", () => {
    const handler = getHandler("/categories");
    const { res, data } = mockRes();
    handler(mockReq(), res);

    expect(data.body).toBeDefined();
    expect(data.body.categories).toBeDefined();
    expect(data.body.categories.length).toBeGreaterThan(0);
    expect(data.body.categories[0].name).toBe("Electronics");
    expect(data.body.categories[0].count).toBe(50);
  });

  it("excludes categories with fewer than 15 products", () => {
    // Seed a second category with only 14 products — should NOT appear.
    seedProducts(testDb, 14, { category: "Tiny Category" });
    // Seed a third category with exactly 15 products — SHOULD appear.
    seedProducts(testDb, 15, { category: "Threshold Category" });

    const handler = getHandler("/categories");
    const { res, data } = mockRes();
    handler(mockReq(), res);

    const names = (data.body.categories as { name: string }[]).map((c) => c.name);
    expect(names).toContain("Electronics");
    expect(names).toContain("Threshold Category");
    expect(names).not.toContain("Tiny Category");
  });

  it("excludes categories with empty or whitespace-only names", () => {
    // Seed a blank-category batch big enough that a counts-only filter would admit it.
    seedProducts(testDb, 50, { category: "" });
    seedProducts(testDb, 50, { category: "   " });

    const handler = getHandler("/categories");
    const { res, data } = mockRes();
    handler(mockReq(), res);

    const names = (data.body.categories as { name: string }[]).map((c) => c.name);
    expect(names).toContain("Electronics");
    expect(names).not.toContain("");
    expect(names.some((n) => n.trim() === "")).toBe(false);
  });
});

describe("POST /start", () => {
  it("starts a classic game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic" }), res);

    expect(data.body).toBeDefined();
    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("classic");
    expect(data.body.currentRound).toBe(1);
  });

  it("starts game with default mode when none specified", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, {}), res);

    expect(data.body.gameMode).toBe("classic");
  });

  it("rejects invalid game mode", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "invalid" }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("Invalid game mode");
  });

  it("rejects disabled game mode", () => {
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("disabled_game_modes", JSON.stringify(["classic"]), now);

    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic" }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("This game mode is currently disabled");

    testDb.prepare("DELETE FROM site_settings WHERE key = ?").run("disabled_game_modes");
  });

  it("rejects non-array categories", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", categories: "Electronics" }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("Categories must be an array");
  });

  it("rejects invalid category names", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", categories: ["Electronics", "FakeCategory"] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toContain("Invalid category");
  });

  it("rejects non-string values in categories array", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", categories: [123] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toContain("Invalid category");
  });

  it("accepts valid categories", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", categories: ["Electronics"] }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("classic");
  });

  it("rejects invalid rounds value", () => {
    const handler = getHandler("/start", "post");
    for (const rounds of [0, 1, 7, -1, 100, "five"]) {
      const { res, data } = mockRes();
      handler(mockReq({}, { mode: "classic", rounds }), res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid rounds value");
    }
  });

  it("accepts valid rounds values (3, 5, 10)", () => {
    const handler = getHandler("/start", "post");
    for (const rounds of [3, 5, 10]) {
      const { res, data } = mockRes();
      handler(mockReq({}, { mode: "classic", rounds }), res);
      expect(data.body.id).toBeDefined();
      expect(data.body.totalRounds).toBe(rounds);
    }
  });

  it("defaults to DEFAULT_TOTAL_ROUNDS when rounds is omitted", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic" }), res);
    expect(data.body.totalRounds).toBe(DEFAULT_TOTAL_ROUNDS);
  });
});

describe("GET /:sessionId", () => {
  it("returns session data", () => {
    const session = startGame("classic");
    const handler = getHandler("/:sessionId");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.id).toBe(session.id);
    expect(data.body.gameMode).toBe("classic");
  });

  it("returns 404 for non-existent session", () => {
    const handler = getHandler("/:sessionId");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: "nonexistent" }), res);

    expect(data.statusCode).toBe(404);
  });
});

describe("GET /:sessionId/product", () => {
  it("returns product for current round", () => {
    const session = startGame("classic");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body).toBeDefined();
    expect(data.body.id).toBeDefined();
    expect(data.body.title).toBeDefined();
  });

  it("returns 404 for non-existent session", () => {
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: "nonexistent" }), res);

    expect(data.statusCode).toBe(404);
  });
});

describe("POST /:sessionId/hint", () => {
  it("returns a hint for classic mode", () => {
    const session = startGame("classic");
    const handler = getHandler("/:sessionId/hint", "post");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body).toBeDefined();
    expect(data.body.hintRange).toBeDefined();
  });

  it("returns 400 when hint not available", () => {
    const session = startGame("higher-lower");
    const handler = getHandler("/:sessionId/hint", "post");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.statusCode).toBe(400);
  });
});

describe("POST /:sessionId/guess", () => {
  it("submits a guess and returns result", () => {
    const session = startGame("classic");
    const handler = getHandler("/:sessionId/guess", "post");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 }), res);

    expect(data.body).toBeDefined();
    expect(data.body.result).toBeDefined();
    expect(data.body.session).toBeDefined();
  });

  it("returns 404 for non-existent session", () => {
    const handler = getHandler("/:sessionId/guess", "post");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: "nonexistent" }, { guessedPriceCents: 1000 }), res);

    expect(data.statusCode).toBe(404);
  });

  it("returns 403 when an authed user submits against another user's session (PR3 sec L1)", () => {
    // Pre-PR3, the route did not verify session ownership before
    // calling submitGuess + recordSinglePlayerGame(req.user.id, ...).
    // A logged-in user with a leaked sessionId could have that game's
    // score credited to their own users.lifetime_score. Server-computed
    // scoring caps the upside but the principle of least-privilege
    // still applies.
    const session = startGame("classic");
    // Simulate a session that was originally started by user "alice".
    testDb
      .prepare("UPDATE game_sessions SET user_id = ? WHERE id = ?")
      .run("alice-user-id", session.id);

    // Now an attacker bob tries to submit a guess against alice's session.
    const handler = getHandler("/:sessionId/guess", "post");
    const { res, data } = mockRes();
    const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
    (req as { user: { id: string } }).user = { id: "bob-user-id" };
    handler(req, res);

    expect(data.statusCode).toBe(403);
    expect(data.body.error).toBe("Session belongs to another user");
  });

  it("permits an authed user to submit when the session has no owner (anonymous-then-link path)", () => {
    // Anonymous play created a session with user_id NULL. A user logging
    // in mid-game should still be able to submit; the ownership check
    // only fires when session.user_id is set.
    const session = startGame("classic");
    // session.user_id stays NULL by default

    const handler = getHandler("/:sessionId/guess", "post");
    const { res, data } = mockRes();
    const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
    (req as { user: { id: string } }).user = { id: "newly-logged-in-user" };
    handler(req, res);

    // Either succeeds (200) or returns the normal session-already-completed
    // path, but never the 403 ownership rejection.
    expect(data.statusCode).not.toBe(403);
  });
});

// ── Additional branch coverage tests ──

describe("POST /start — excludeProductIds validation", () => {
  it("rejects non-array excludeProductIds", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: "not-an-array" }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must be an array");
  });

  it("rejects too many excludeProductIds", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
    handler(mockReq({}, { mode: "classic", excludeProductIds: tooMany }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("Too many excludeProductIds (max 200)");
  });

  it("rejects non-integer excludeProductIds values", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: [1.5] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must contain valid positive integers");
  });

  it("rejects non-number excludeProductIds values", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: ["abc"] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must contain valid positive integers");
  });

  it("rejects zero in excludeProductIds", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: [0] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must contain valid positive integers");
  });

  it("rejects negative excludeProductIds", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: [-1] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must contain valid positive integers");
  });

  it("rejects excludeProductIds exceeding max id", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: [10_000_001] }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("excludeProductIds must contain valid positive integers");
  });

  it("accepts valid excludeProductIds", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "classic", excludeProductIds: [1, 2, 3] }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("classic");
  });
});

describe("POST /start — too many categories", () => {
  it("rejects more than 50 categories", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    const manyCats = Array.from({ length: 51 }, (_, i) => `Cat${i}`);
    handler(mockReq({}, { mode: "classic", categories: manyCats }), res);

    expect(data.statusCode).toBe(400);
    expect(data.body.error).toBe("Too many categories");
  });
});

describe("POST /start — different game modes", () => {
  it("starts a higher-lower game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "higher-lower" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("higher-lower");
  });

  it("starts a comparison game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "comparison" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("comparison");
  });

  it("starts a price-match game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "price-match" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("price-match");
  });

  it("starts a closest-without-going-over game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "closest-without-going-over" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("closest-without-going-over");
  });

  it("starts a riser game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "riser" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("riser");
  });

  it("starts an odd-one-out game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "odd-one-out" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("odd-one-out");
  });

  it("starts a market-basket game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "market-basket" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("market-basket");
  });

  it("starts a sort-it-out game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "sort-it-out" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("sort-it-out");
  });

  it("starts a budget-builder game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "budget-builder" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("budget-builder");
  });

  it("starts a chain-reaction game", () => {
    const handler = getHandler("/start", "post");
    const { res, data } = mockRes();
    handler(mockReq({}, { mode: "chain-reaction" }), res);

    expect(data.body.id).toBeDefined();
    expect(data.body.gameMode).toBe("chain-reaction");
  });
});

describe("GET /:sessionId/product — multi-product modes", () => {
  it("returns multiple products for comparison mode", () => {
    const session = startGame("comparison");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(data.body.products.length).toBeGreaterThan(1);
    expect(data.body.question).toBeDefined();
  });

  it("returns multiple products and prices for price-match mode", () => {
    const session = startGame("price-match");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(data.body.products.length).toBeGreaterThan(1);
    expect(data.body.prices).toBeDefined();
    expect(data.body.prices.length).toBe(data.body.products.length);
  });

  it("returns product with referencePrice for higher-lower mode", () => {
    const session = startGame("higher-lower");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.product).toBeDefined();
    expect(typeof data.body.referencePrice).toBe("number");
  });

  it("returns product with riser data for riser mode", () => {
    const session = startGame("riser");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.product).toBeDefined();
    expect(typeof data.body.maxPriceCents).toBe("number");
    expect(data.body.speedPattern).toBeDefined();
    expect(typeof data.body.durationMs).toBe("number");
  });

  it("returns products for odd-one-out mode", () => {
    const session = startGame("odd-one-out");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(data.body.products.length).toBeGreaterThan(1);
  });

  it("returns products for market-basket mode", () => {
    const session = startGame("market-basket");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(typeof data.body.itemCount).toBe("number");
  });

  it("returns products for sort-it-out mode", () => {
    const session = startGame("sort-it-out");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(data.body.products.length).toBeGreaterThan(1);
  });

  it("returns products for budget-builder mode", () => {
    const session = startGame("budget-builder");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(typeof data.body.budgetCents).toBe("number");
  });

  it("returns products for chain-reaction mode", () => {
    const session = startGame("chain-reaction");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body.products).toBeDefined();
    expect(data.body.products.length).toBeGreaterThan(1);
  });

  it("returns single product for closest-without-going-over mode", () => {
    const session = startGame("closest-without-going-over");
    const handler = getHandler("/:sessionId/product");
    const { res, data } = mockRes();
    handler(mockReq({ sessionId: session.id }), res);

    expect(data.body).toBeDefined();
    expect(data.body.id).toBeDefined();
    expect(data.body.title).toBeDefined();
  });
});

describe("POST /:sessionId/guess — auto-record for logged-in users", () => {
  it("records game history when logged-in user completes a game", () => {
    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    // Play through all rounds
    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res, data } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      // Simulate logged-in user
      req.user = { id: "test-user-id", username: "testplayer" };
      guessHandler(req, res);

      if (i === DEFAULT_TOTAL_ROUNDS - 1) {
        // Last round should complete the game
        expect(data.body.session.completed).toBe(true);
      }
    }
  });

  it("handles game history recording error gracefully", () => {
    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    // Play through all rounds with a user whose id will cause a recording error
    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res, data } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      // Simulate a user - recordSinglePlayerGame may throw but the guess should still succeed
      req.user = { id: "nonexistent-user-for-history", username: "ghost" };
      guessHandler(req, res);

      // The response should still be valid even if history recording fails
      expect(data.body.result).toBeDefined();
    }
  });

  it("credits the visitor attribution row when an anonymous visitor completes a game", () => {
    const visitorId = "11111111-2222-3333-4444-555555555555";
    // Seed a visitor_attribution row as if the client had POSTed /api/attribution/track.
    testDb
      .prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, utm_medium, utm_campaign, first_seen_at)
         VALUES (?, 'reddit', 'social', 'launch', ?)`,
      )
      .run(visitorId, new Date().toISOString());

    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res, data } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId; // anonymous — no req.user
      guessHandler(req, res);

      if (i === DEFAULT_TOTAL_ROUNDS - 1) {
        expect(data.body.session.completed).toBe(true);
      }
    }

    const row = testDb
      .prepare("SELECT * FROM visitor_attribution WHERE visitor_id = ?")
      .get(visitorId) as Record<string, unknown>;
    expect(row.first_game_at).not.toBeNull();
    expect(row.first_game_type).toBe("single");
    expect(row.first_game_mode).toBe("classic");
    expect(row.games_played).toBe(1);
  });

  it("creates a 'direct' attribution row for visitors who arrive without UTM tags", () => {
    // Upserted in v69 — the previous "no-op" behavior silently dropped
    // W/L tracking for the majority of organic / direct visitors. Now
    // they get a row stamped utm_source='direct' so the win-record
    // counters can accumulate.
    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");
    const visitorId = "22222222-3333-4444-5555-666666666666";

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      guessHandler(req, res);
    }

    const row = testDb
      .prepare("SELECT utm_source, games_played FROM visitor_attribution WHERE visitor_id = ?")
      .get(visitorId) as { utm_source: string; games_played: number };
    expect(row).toBeDefined();
    expect(row.utm_source).toBe("direct");
    expect(row.games_played).toBe(1);
  });

  it("does NOT bump visitor_attribution.games_played when req.isStreamerBot is set", () => {
    // Streamer-bot: middleware-stamped flag must short-circuit the
    // recordVisitorGamePlay call so the bot's 24/7 plays don't inflate
    // any UTM cohort's first-game-played counter.
    const visitorId = "44444444-aaaa-bbbb-cccc-dddddddddddd";
    testDb
      .prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, utm_medium, utm_campaign, first_seen_at)
         VALUES (?, 'streamer-test', 'social', 'bot-suite', ?)`,
      )
      .run(visitorId, new Date().toISOString());

    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      req.isStreamerBot = true;
      guessHandler(req, res);
    }

    const row = testDb
      .prepare("SELECT first_game_at, games_played FROM visitor_attribution WHERE visitor_id = ?")
      .get(visitorId) as { first_game_at: string | null; games_played: number };
    expect(row.first_game_at).toBeNull();
    expect(row.games_played).toBe(0);
  });

  it("bumps streamer-bot visitor W/L counters without touching cohort fields", () => {
    // The bot must drive the in-game W/L HUD chip, so its W/L cache
    // and signed streak need to update on game completion. Cohort
    // fields (`first_game_*`, `games_played`) stay frozen so the bot
    // does not contaminate UTM funnels.
    const visitorId = "55555555-aaaa-bbbb-cccc-eeeeeeeeeeee";
    testDb
      .prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, utm_medium, utm_campaign, first_seen_at)
         VALUES (?, 'streamer-test', 'social', 'bot-suite', ?)`,
      )
      .run(visitorId, new Date().toISOString());

    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      req.isStreamerBot = true;
      guessHandler(req, res);
    }

    const row = testDb
      .prepare(
        `SELECT first_game_at, games_played,
                lifetime_wins, lifetime_losses,
                current_streak, best_win_streak
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(visitorId) as {
      first_game_at: string | null;
      games_played: number;
      lifetime_wins: number;
      lifetime_losses: number;
      current_streak: number;
      best_win_streak: number;
    };
    // Cohort fields untouched.
    expect(row.first_game_at).toBeNull();
    expect(row.games_played).toBe(0);
    // W/L counters did move — exactly one game was completed, so the
    // wins+losses sum is exactly 1 and the streak is non-zero.
    expect(row.lifetime_wins + row.lifetime_losses).toBe(1);
    expect(row.current_streak).not.toBe(0);
    if (row.lifetime_wins === 1) {
      expect(row.current_streak).toBe(1);
      expect(row.best_win_streak).toBe(1);
    } else {
      expect(row.current_streak).toBe(-1);
      expect(row.best_win_streak).toBe(0);
    }
  });

  it("creates a 'direct' visitor row for the streamer-bot when none exists", () => {
    // The bot's Chromium profile starts without a UTM-tagged row. The
    // W/L bump path must self-heal: insert a `utm_source='direct'`
    // placeholder so subsequent W/L updates land on a real row.
    const visitorId = "66666666-bbbb-cccc-dddd-ffffffffffff";

    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      req.isStreamerBot = true;
      guessHandler(req, res);
    }

    const row = testDb
      .prepare(
        `SELECT utm_source, first_game_at, games_played,
                lifetime_wins, lifetime_losses
           FROM visitor_attribution WHERE visitor_id = ?`,
      )
      .get(visitorId) as
      | {
          utm_source: string;
          first_game_at: string | null;
          games_played: number;
          lifetime_wins: number;
          lifetime_losses: number;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.utm_source).toBe("direct");
    expect(row!.first_game_at).toBeNull();
    expect(row!.games_played).toBe(0);
    expect(row!.lifetime_wins + row!.lifetime_losses).toBe(1);
  });

  it("does NOT insert user_game_history when req.isStreamerBot is set even with req.user", async () => {
    // Defense-in-depth: the bot runs as a guest in practice, but if it
    // were ever pointed at a logged-in identity the gate must still skip
    // recordSinglePlayerGame. We assert the absence of the row and the
    // unchanged users.total_games / lifetime_score lock-step counters.
    const { seedUser } = await import("../test/dbHelper");
    const userId = seedUser(testDb, "stream-user", "stream-user@example.com");

    const session = startGame("classic", undefined, userId);
    const guessHandler = getHandler("/:sessionId/guess", "post");

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.user = { id: userId, username: "stream-user" };
      req.isStreamerBot = true;
      guessHandler(req, res);
    }

    const histCount = (
      testDb
        .prepare("SELECT COUNT(*) AS c FROM user_game_history WHERE user_id = ?")
        .get(userId) as { c: number }
    ).c;
    expect(histCount).toBe(0);
    const userRow = testDb
      .prepare("SELECT total_games, lifetime_score FROM users WHERE id = ?")
      .get(userId) as { total_games: number; lifetime_score: number };
    expect(userRow.total_games).toBe(0);
    expect(userRow.lifetime_score).toBe(0);
  });
});

describe("POST /:sessionId/guess — analytics emission", () => {
  // Two events fire on completion of an SP game: the existing GAME_COMPLETED
  // (counter-bumping) and the new DAILY_COMPLETED (semantic-only marker)
  // when result.daily is set. The marker must NOT fire for non-daily SP
  // games — otherwise the rollup would mis-attribute regular plays as
  // daily completions.
  it("emits GAME_COMPLETED but NOT DAILY_COMPLETED on a non-daily SP completion", async () => {
    const session = startGame("classic");
    const guessHandler = getHandler("/:sessionId/guess", "post");
    const visitorId = "33333333-4444-5555-6666-777777777777";

    for (let i = 0; i < DEFAULT_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      guessHandler(req, res);
    }

    const completedCount = (
      testDb
        .prepare(
          "SELECT COUNT(*) as c FROM events WHERE event_name = 'game_completed' AND visitor_id = ?",
        )
        .get(visitorId) as { c: number }
    ).c;
    const dailyCount = (
      testDb
        .prepare(
          "SELECT COUNT(*) as c FROM events WHERE event_name = 'daily_completed' AND visitor_id = ?",
        )
        .get(visitorId) as { c: number }
    ).c;
    expect(completedCount).toBe(1);
    expect(dailyCount).toBe(0);
  });

  it("emits BOTH GAME_COMPLETED and DAILY_COMPLETED on an SP daily completion", async () => {
    const { startDailyGame } = await import("../services/gameSession");
    const { setDailyEnabled } = await import("../services/siteSettings");
    const { DAILY_TOTAL_ROUNDS } = await import("@price-game/shared");
    setDailyEnabled(testDb, true);

    const session = startDailyGame("2026-04-15");
    const guessHandler = getHandler("/:sessionId/guess", "post");
    const visitorId = "44444444-5555-6666-7777-888888888888";

    for (let i = 0; i < DAILY_TOTAL_ROUNDS; i++) {
      const { res } = mockRes();
      const req = mockReq({ sessionId: session.id }, { guessedPriceCents: 1000 });
      req.visitorId = visitorId;
      guessHandler(req, res);
    }

    const completedCount = (
      testDb
        .prepare(
          "SELECT COUNT(*) as c FROM events WHERE event_name = 'game_completed' AND visitor_id = ?",
        )
        .get(visitorId) as { c: number }
    ).c;
    const dailyEvents = testDb
      .prepare(
        "SELECT properties FROM events WHERE event_name = 'daily_completed' AND visitor_id = ?",
      )
      .all(visitorId) as Array<{ properties: string }>;
    expect(completedCount).toBe(1);
    expect(dailyEvents).toHaveLength(1);
    const props = JSON.parse(dailyEvents[0].properties);
    expect(props.via).toBe("single_player");
  });
});

