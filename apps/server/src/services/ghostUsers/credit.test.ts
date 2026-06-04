import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import { creditGhostScore } from "./credit";
import { createGhost } from "./repository";
import { setGhostSettings } from "./settings";
import { invalidateCapCache } from "./cap";

let db: DatabaseType;

function insertUser(score: number, sessions = 10) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash,
                        created_at, updated_at, is_active, lifetime_score, total_sessions)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 1, ?, ?)`,
  ).run(uuidv4(), `u${score}`, `u${score}`, `u${score}@x.com`, now, now, score, sessions);
}

beforeEach(() => {
  db = createTestDb();
  invalidateCapCache();
  setGhostSettings(db, { percentileCap: 70 });
});

describe("creditGhostScore", () => {
  it("credits the full score when the new total stays under the cap", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    // Cap is 7000 (70th percentile of 1000..10000). Crediting 100 should
    // be a no-op vs the cap.
    const result = creditGhostScore(db, ghost.id, {
      addedScore: 100,
      gameType: "multiplayer",
      gameMode: "classic",
      roomCode: "abc",
      placement: 1,
      playersCount: 4,
    });
    expect(result.credited).toBe(100);
    expect(result.cappedTo).toBeNull();
    const updated = db.prepare("SELECT lifetime_score FROM ghost_users WHERE id = ?").get(ghost.id) as { lifetime_score: number };
    expect(updated.lifetime_score).toBe(100);
  });

  it("soft-caps when the new total would exceed the percentile cap", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    // Cap is 7000. Pre-set ghost score to 6500, then add 1000 — should cap to 7000 (credit 500).
    db.prepare("UPDATE ghost_users SET lifetime_score = 6500 WHERE id = ?").run(ghost.id);
    const result = creditGhostScore(db, ghost.id, {
      addedScore: 1000,
      gameType: "multiplayer",
      gameMode: "classic",
    });
    expect(result.credited).toBe(500);
    expect(result.cappedTo).toBe(7000);
    const updated = db.prepare("SELECT lifetime_score FROM ghost_users WHERE id = ?").get(ghost.id) as { lifetime_score: number };
    expect(updated.lifetime_score).toBe(7000);
  });

  it("credits zero when already at or above the cap", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    db.prepare("UPDATE ghost_users SET lifetime_score = 7500 WHERE id = ?").run(ghost.id);
    const result = creditGhostScore(db, ghost.id, {
      addedScore: 1000,
      gameType: "multiplayer",
      gameMode: "classic",
    });
    expect(result.credited).toBe(0);
    expect(result.cappedTo).toBe(7000);
    const updated = db.prepare("SELECT lifetime_score FROM ghost_users WHERE id = ?").get(ghost.id) as { lifetime_score: number };
    // Stays exactly where it was — never push down on a backstop overshoot.
    expect(updated.lifetime_score).toBe(7500);
  });

  it("writes a ghost_game_history row with the credited (post-cap) score", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    db.prepare("UPDATE ghost_users SET lifetime_score = 6500 WHERE id = ?").run(ghost.id);

    creditGhostScore(db, ghost.id, {
      addedScore: 1000,
      gameType: "multiplayer",
      gameMode: "classic",
      roomCode: "abc",
      placement: 1,
      playersCount: 4,
    });

    const history = db
      .prepare("SELECT * FROM ghost_game_history WHERE ghost_user_id = ?")
      .all(ghost.id) as Array<{ score: number; game_mode: string; room_code: string | null }>;
    expect(history).toHaveLength(1);
    // Score recorded is the credited (capped) value, not the pre-cap addedScore.
    expect(history[0].score).toBe(500);
    expect(history[0].game_mode).toBe("classic");
    expect(history[0].room_code).toBe("abc");
  });

  it("rejects negative or non-finite added scores", () => {
    const ghost = createGhost(db)!;
    expect(creditGhostScore(db, ghost.id, { addedScore: -10, gameType: "multiplayer", gameMode: "classic" })).toEqual({ credited: 0, cappedTo: null });
    expect(creditGhostScore(db, ghost.id, { addedScore: NaN, gameType: "multiplayer", gameMode: "classic" })).toEqual({ credited: 0, cappedTo: null });
  });

  it("returns { credited: 0 } when the ghost id doesn't exist", () => {
    expect(creditGhostScore(db, "nope", { addedScore: 100, gameType: "multiplayer", gameMode: "classic" })).toEqual({ credited: 0, cappedTo: null });
  });

  it("accepts gameType: 'single' (used by the daily-play simulator)", () => {
    // creditGhostScore was originally typed for multiplayer-only because
    // mp was the first ghost surface. The daily-play simulator routes
    // through this same helper to enforce the percentile cap on lifetime_
    // score and to write the ghost_game_history row, so the type union
    // includes "single". Behavior for the new variant is identical apart
    // from the game_type column written.
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    const result = creditGhostScore(db, ghost.id, {
      addedScore: 1500,
      gameType: "single",
      gameMode: "daily",
    });
    expect(result.credited).toBe(1500);
    const row = db.prepare(
      "SELECT game_type, game_mode FROM ghost_game_history WHERE ghost_user_id = ?",
    ).get(ghost.id) as { game_type: string; game_mode: string };
    expect(row.game_type).toBe("single");
    expect(row.game_mode).toBe("daily");
  });

  it("never compounds when already above cap (hard backstop, no growth)", () => {
    // Pre-condition: cap ≈ 7000 and the ghost is already above (admin
    // manual override, schema drift, etc.). Additional credit must not
    // grow the score; we don't pull it down (no flicker), but we never
    // let it move further from the cap.
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    const ghost = createGhost(db)!;
    db.prepare("UPDATE ghost_users SET lifetime_score = 7500 WHERE id = ?").run(ghost.id);
    creditGhostScore(db, ghost.id, { addedScore: 999_999, gameType: "multiplayer", gameMode: "classic" });
    const updated = db.prepare("SELECT lifetime_score FROM ghost_users WHERE id = ?").get(ghost.id) as { lifetime_score: number };
    expect(updated.lifetime_score).toBe(7500);
  });
});
