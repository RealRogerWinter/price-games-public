/**
 * Tests for the history recap service — reconstruction of
 * SharedRoundSnapshot[] from SP session + game_rounds and MP room + guesses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import { buildSPRecap, buildMPRecap, createShareRow } from "./historyRecap";

// Controlled nanoid for the collision-retry test below. The default export
// and named export both pull from the same underlying queue so both call
// sites (route handler + builder) get the sequence we set up. Other
// nanoid exports (notably `customAlphabet`, used at module load by
// utmTags via the outboundLinks → pushNotification → notificationScheduler
// → gameGuess import chain) are forwarded from the real module so they
// keep working — overriding only what this test needs.
const nanoidQueue: string[] = [];
vi.mock("nanoid", async () => {
  const actual = await vi.importActual<typeof import("nanoid")>("nanoid");
  return {
    ...actual,
    nanoid: () => nanoidQueue.shift() ?? "fallback1",
  };
});

let db: DatabaseType;

function insertProduct(
  db: DatabaseType,
  id: number,
  title: string,
  priceCents: number,
  asin: string | null = null,
): void {
  db.prepare(
    "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  ).run(id, asin, title, "", "", priceCents, "Electronics");
}

function insertSession(
  db: DatabaseType,
  id: string,
  mode: string,
  selectedIds: number[],
  roundData: Record<string, unknown> | null,
): void {
  db.prepare(
    `INSERT INTO game_sessions (id, current_round, total_score, selected_products, started_at, game_mode, round_data, total_rounds, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    1,
    0,
    JSON.stringify(selectedIds),
    "2026-04-16T00:00:00Z",
    mode,
    roundData ? JSON.stringify(roundData) : null,
    5,
    "2026-04-16T00:05:00Z",
  );
}

function insertRound(
  db: DatabaseType,
  sessionId: string,
  roundNum: number,
  productId: number,
  score: number,
  guessedPriceCents: number | null,
  guessData: object | null,
): void {
  db.prepare(
    `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    roundNum,
    productId,
    guessedPriceCents,
    score,
    "2026-04-16T00:01:00Z",
    guessData ? JSON.stringify(guessData) : null,
  );
}

beforeEach(() => {
  db = createTestDb();
});

describe("buildSPRecap", () => {
  it("returns empty array for missing session", () => {
    expect(buildSPRecap(db, "no-such-session")).toEqual([]);
  });

  it("returns empty array when session exists but has no rounds", () => {
    insertSession(db, "s1", "classic", [1, 2, 3], null);
    expect(buildSPRecap(db, "s1")).toEqual([]);
  });

  it("reconstructs a classic round with guessedPriceCents", () => {
    insertProduct(db, 10, "Widget", 5000, "B000XYZ");
    insertSession(db, "s1", "classic", [10, 11, 12, 13, 14], null);
    insertRound(db, "s1", 1, 10, 850, 5200, null);

    const recap = buildSPRecap(db, "s1");
    expect(recap).toHaveLength(1);
    expect(recap[0]).toMatchObject({
      roundNumber: 1,
      score: 850,
      products: [{ title: "Widget", priceCents: 5000 }],
      guessedPriceCents: 5200,
    });
    expect(recap[0].products[0].amazonUrl).toContain("B000XYZ");
  });

  it("reconstructs a higher-lower round with guess + referencePrice + correct", () => {
    insertProduct(db, 20, "Thing", 10000);
    insertSession(db, "s1", "higher-lower", [20, 21, 22, 23, 24], {
      "1": { referencePrice: 8000 },
    });
    insertRound(db, "s1", 1, 20, 1000, null, { guess: "higher", referencePrice: 8000 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].guess).toBe("higher");
    expect(recap[0].referencePrice).toBe(8000);
    expect(recap[0].correct).toBe(true);
  });

  it("reconstructs a comparison round with guessedProductId", () => {
    insertProduct(db, 30, "A", 100);
    insertProduct(db, 31, "B", 200);
    // Comparison mode uses COMPARISON_PRODUCTS_PER_ROUND = 2 per round.
    insertSession(db, "s1", "comparison", [30, 31], null);
    insertRound(db, "s1", 1, 31, 0, null, { guessedProductId: 30, question: "most-expensive" });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].products.map((p) => p.title)).toEqual(["A", "B"]);
    expect(recap[0].guessedProductId).toBe(30);
    expect(recap[0].correct).toBe(false);
  });

  it("reconstructs a closest-without-going-over round with wentOver", () => {
    insertProduct(db, 40, "Gizmo", 2000);
    insertSession(db, "s1", "closest-without-going-over", [40, 41, 42, 43, 44], null);
    insertRound(db, "s1", 1, 40, 500, 1900, { wentOver: false });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0]).toMatchObject({ guessedPriceCents: 1900, wentOver: false });
  });

  it("reconstructs a price-match round with correctCount derived from guess_data", () => {
    insertProduct(db, 50, "P1", 100);
    insertProduct(db, 51, "P2", 200);
    insertProduct(db, 52, "P3", 300);
    insertProduct(db, 53, "P4", 400);
    insertSession(db, "s1", "price-match", [50, 51, 52, 53], null);
    insertRound(db, "s1", 1, 50, 800, null, { correctCount: 3 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].correctCount).toBe(3);
    expect(recap[0].products).toHaveLength(4);
  });

  it("reconstructs a riser round using stoppedPriceCents + wentOver", () => {
    insertProduct(db, 60, "Riser", 8000);
    insertSession(db, "s1", "riser", [60, 61, 62, 63, 64], {
      "1": { maxPriceCents: 10000 },
    });
    insertRound(db, "s1", 1, 60, 900, 7500, {
      stoppedPriceCents: 7500,
      maxPriceCents: 10000,
      wentOver: false,
    });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].guessedPriceCents).toBe(7500);
    expect(recap[0].wentOver).toBe(false);
  });

  it("reconstructs an odd-one-out round with outlierProductId from round_data", () => {
    insertProduct(db, 70, "X", 100);
    insertProduct(db, 71, "Y", 100);
    insertProduct(db, 72, "Z", 5000);
    insertSession(db, "s1", "odd-one-out", [70, 71, 72], {
      "1": { productIds: [70, 71, 72], outlierProductId: 72 },
    });
    insertRound(db, "s1", 1, 70, 800, null, { guessedProductId: 72 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].outlierProductId).toBe(72);
    expect(recap[0].guessedProductId).toBe(72);
    expect(recap[0].correct).toBe(true);
  });

  it("reconstructs a market-basket round with actualTotalCents summed from products", () => {
    insertProduct(db, 80, "Bread", 300);
    insertProduct(db, 81, "Milk", 500);
    insertProduct(db, 82, "Eggs", 400);
    insertSession(db, "s1", "market-basket", [80, 81, 82], {
      "1": { productIds: [80, 81, 82] },
    });
    insertRound(db, "s1", 1, 80, 500, null, { guessedTotalCents: 1300 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].guessedTotalCents).toBe(1300);
    expect(recap[0].actualTotalCents).toBe(1200);
  });

  it("reconstructs a sort-it-out round with correctCount", () => {
    insertProduct(db, 90, "A", 100);
    insertProduct(db, 91, "B", 200);
    insertProduct(db, 92, "C", 300);
    insertProduct(db, 93, "D", 400);
    insertSession(db, "s1", "sort-it-out", [90, 91, 92, 93], {
      "1": { productIds: [90, 91, 92, 93] },
    });
    insertRound(db, "s1", 1, 90, 700, null, { correctCount: 3 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].correctCount).toBe(3);
    expect(recap[0].products).toHaveLength(4);
  });

  it("reconstructs a budget-builder round with budgetCents + cartTotalCents", () => {
    insertProduct(db, 100, "Item1", 500);
    insertProduct(db, 101, "Item2", 700);
    insertProduct(db, 102, "Item3", 1200);
    insertSession(db, "s1", "budget-builder", [100, 101, 102], {
      "1": { productIds: [100, 101, 102], budgetCents: 1500 },
    });
    insertRound(db, "s1", 1, 100, 900, null, {
      selectedProductIds: [100, 101],
      cartTotalCents: 1200,
    });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].budgetCents).toBe(1500);
    expect(recap[0].cartTotalCents).toBe(1200);
  });

  it("reconstructs a chain-reaction round with correctCount", () => {
    insertProduct(db, 110, "C1", 500);
    insertProduct(db, 111, "C2", 1000);
    insertProduct(db, 112, "C3", 1500);
    insertProduct(db, 113, "C4", 2000);
    insertProduct(db, 114, "C5", 2500);
    insertSession(db, "s1", "chain-reaction", [110, 111, 112, 113, 114], {
      "1": { productIds: [110, 111, 112, 113, 114] },
    });
    insertRound(db, "s1", 1, 110, 950, null, { correctCount: 4 });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].correctCount).toBe(4);
    expect(recap[0].products).toHaveLength(5);
  });

  it("reconstructs a bidding round using bidCents from guess_data", () => {
    insertProduct(db, 130, "BidItem", 9500);
    insertSession(db, "s1", "bidding", [130, 131, 132, 133, 134], null);
    insertRound(db, "s1", 1, 130, 920, 9200, {
      bidCents: 9200,
      wentOver: false,
    });

    const recap = buildSPRecap(db, "s1");
    expect(recap[0].guessedPriceCents).toBe(9200);
    expect(recap[0].wentOver).toBe(false);
  });

  it("returns rounds sorted ascending across a 5-round game", () => {
    for (let i = 0; i < 5; i++) insertProduct(db, 200 + i, `P${i}`, 1000 + i * 100);
    insertSession(db, "s1", "classic", [200, 201, 202, 203, 204], null);
    for (let r = 5; r >= 1; r--) {
      insertRound(db, "s1", r, 200 + r - 1, r * 100, 1000, null);
    }
    const recap = buildSPRecap(db, "s1");
    expect(recap.map((r) => r.roundNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(recap.map((r) => r.score)).toEqual([100, 200, 300, 400, 500]);
  });
});

describe("buildMPRecap", () => {
  const userId = "user-mp";
  const roomCode = "ABCD";

  beforeEach(() => {
    seedUser(db, "mpuser", "mp@example.com", "password1234");
    // seedUser assigns its own id; look it up
    const row = db.prepare("SELECT id FROM users WHERE username = 'mpuser'").get() as { id: string };
    Object.defineProperty(db, "__mpUserId", { value: row.id, configurable: true });
  });

  function insertRoom(mode: string, roundData: Record<string, unknown>, totalRounds = 3) {
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, round_data, created_at, finished_at, last_activity_at)
       VALUES (?, ?, ?, 'finished', ?, ?, '[]', ?, ?, ?, ?)`,
    ).run(
      roomCode,
      "host-p",
      mode,
      totalRounds,
      totalRounds,
      JSON.stringify(roundData),
      "2026-04-16T00:00:00Z",
      "2026-04-16T00:15:00Z",
      "2026-04-16T00:15:00Z",
    );
  }

  function insertPlayer(userId: string, playerId: string, joinedAt: string = "2026-04-16T00:00:00Z"): void {
    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(playerId, roomCode, "player", "avatar-classic/pirate", `tok-${playerId}`, joinedAt, userId);
  }

  function insertGuess(playerId: string, roundNum: number, score: number, guessData: object): void {
    db.prepare(
      `INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(roomCode, playerId, roundNum, JSON.stringify(guessData), score, "2026-04-16T00:01:00Z");
  }

  it("returns empty array when room does not exist", () => {
    expect(buildMPRecap(db, "ZZZZ", userId)).toEqual([]);
  });

  it("returns empty array when player has not joined the room", () => {
    insertRoom("classic", { "1": { productIds: [1] } });
    const uid = (db as unknown as { __mpUserId: string }).__mpUserId;
    expect(buildMPRecap(db, roomCode, uid)).toEqual([]);
  });

  it("reconstructs all rounds for the player with scores and products", () => {
    insertProduct(db, 500, "P1", 1000);
    insertProduct(db, 501, "P2", 2000);
    insertProduct(db, 502, "P3", 3000);

    insertRoom("classic", {
      "1": { productIds: [500] },
      "2": { productIds: [501] },
      "3": { productIds: [502] },
    });

    const uid = (db as unknown as { __mpUserId: string }).__mpUserId;
    insertPlayer(uid, "p1");
    insertGuess("p1", 1, 800, { guessedPriceCents: 950 });
    insertGuess("p1", 2, 600, { guessedPriceCents: 1800 });
    insertGuess("p1", 3, 100, { guessedPriceCents: 1500 });

    const recap = buildMPRecap(db, roomCode, uid);
    expect(recap).toHaveLength(3);
    expect(recap[0]).toMatchObject({ roundNumber: 1, score: 800 });
    expect(recap[0].products[0].title).toBe("P1");
    expect(recap[2].score).toBe(100);
  });

  it("aggregates guesses across all mp_players rows when the user rejoined mid-game", () => {
    insertProduct(db, 700, "R1", 1000);
    insertProduct(db, 701, "R2", 2000);
    insertProduct(db, 702, "R3", 3000);

    insertRoom("classic", {
      "1": { productIds: [700] },
      "2": { productIds: [701] },
      "3": { productIds: [702] },
    });

    const uid = (db as unknown as { __mpUserId: string }).__mpUserId;
    // First incarnation (round 1 only), then rejoin as a fresh mp_players row.
    insertPlayer(uid, "p-original", "2026-04-16T00:00:00Z");
    insertGuess("p-original", 1, 750, { guessedPriceCents: 950 });

    insertPlayer(uid, "p-rejoin", "2026-04-16T00:05:00Z");
    insertGuess("p-rejoin", 2, 500, { guessedPriceCents: 1800 });
    insertGuess("p-rejoin", 3, 200, { guessedPriceCents: 1000 });

    const recap = buildMPRecap(db, roomCode, uid);
    expect(recap).toHaveLength(3);
    // The round-1 guess from the original incarnation must survive the rejoin.
    expect(recap[0].score).toBe(750);
    expect(recap[1].score).toBe(500);
    expect(recap[2].score).toBe(200);
  });

  it("keeps the best-scoring guess when both incarnations submitted the same round", () => {
    insertProduct(db, 800, "Tie", 500);
    insertRoom("classic", { "1": { productIds: [800] } }, 1);

    const uid = (db as unknown as { __mpUserId: string }).__mpUserId;
    insertPlayer(uid, "p-first");
    insertPlayer(uid, "p-second", "2026-04-16T00:10:00Z");
    insertGuess("p-first", 1, 300, { guessedPriceCents: 460 });
    insertGuess("p-second", 1, 900, { guessedPriceCents: 500 });

    const recap = buildMPRecap(db, roomCode, uid);
    expect(recap[0].score).toBe(900);
  });

  it("emits empty-product rounds for rounds the player missed", () => {
    insertProduct(db, 600, "Only", 1500);
    insertRoom("classic", { "1": { productIds: [600] } }, 2);

    const uid = (db as unknown as { __mpUserId: string }).__mpUserId;
    insertPlayer(uid, "p2");
    insertGuess("p2", 1, 700, { guessedPriceCents: 1400 });

    const recap = buildMPRecap(db, roomCode, uid);
    expect(recap).toHaveLength(2);
    expect(recap[0].score).toBe(700);
    expect(recap[1].score).toBe(0);
  });

});

describe("createShareRow", () => {
  it("inserts a row and returns an 8-char nanoid", () => {
    nanoidQueue.length = 0;
    nanoidQueue.push("abcd1234");
    const id = createShareRow(db, "classic", 5000, 1000, "Alice", [
      { roundNumber: 1, score: 1000, products: [] },
    ]);
    expect(id).toBe("abcd1234");
    const row = db.prepare("SELECT * FROM shared_games WHERE id = ?").get(id) as {
      game_mode: string;
      total_score: number;
      player_name: string | null;
    };
    expect(row.game_mode).toBe("classic");
    expect(row.total_score).toBe(5000);
    expect(row.player_name).toBe("Alice");
  });

  it("retries on primary-key collision and succeeds with the next candidate", () => {
    // Pre-seed a row so the first candidate collides.
    nanoidQueue.length = 0;
    db.prepare(
      `INSERT INTO shared_games (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
       VALUES ('dup00000', 'classic', 1, 1000, NULL, '[]', 0)`,
    ).run();

    // First candidate collides with the pre-seeded row; second candidate succeeds.
    nanoidQueue.push("dup00000", "freshOne");

    const id = createShareRow(db, "classic", 5000, 1000, null, [
      { roundNumber: 1, score: 1000, products: [] },
    ]);
    expect(id).toBe("freshOne");
    expect(nanoidQueue.length).toBe(0);
  });

  it("throws after exhausting all retry attempts", () => {
    nanoidQueue.length = 0;
    db.prepare(
      `INSERT INTO shared_games (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
       VALUES ('colliderx', 'classic', 1, 1000, NULL, '[]', 0)`,
    ).run();
    // All three attempts collide.
    nanoidQueue.push("colliderx", "colliderx", "colliderx");

    expect(() =>
      createShareRow(db, "classic", 5000, 1000, null, [
        { roundNumber: 1, score: 1000, products: [] },
      ]),
    ).toThrow(/UNIQUE/);
  });
});
