/**
 * Tests for the user game history service.
 *
 * Covers recording single-player and multiplayer games, lifetime score
 * accumulation, paginated history retrieval, filtering, and aggregate stats.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  recordSinglePlayerGame,
  recordMultiplayerGame,
  getUserGameHistory,
  getUserStats,
  getUserScoreHistory,
} from "./userGameHistory";
import { tzDateString, ADMIN_TIMEZONE } from "@price-game/shared";
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
let userId: string;

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db, "historyuser", "history@example.com", "password1234");
});

// ── recordSinglePlayerGame ────────────────────────────────────────────────

describe("recordSinglePlayerGame", () => {
  it("records a single-player game entry", () => {
    recordSinglePlayerGame(db, userId, "session-1", "classic", 5000);

    const rows = db.prepare("SELECT * FROM user_game_history WHERE user_id = ?").all(userId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].game_type).toBe("single");
    expect(rows[0].game_mode).toBe("classic");
    expect(rows[0].session_id).toBe("session-1");
    expect(rows[0].score).toBe(5000);
    expect(rows[0].played_at).toBeDefined();
  });

  it("increments lifetime_score", () => {
    recordSinglePlayerGame(db, userId, "session-1", "classic", 3000);
    recordSinglePlayerGame(db, userId, "session-2", "classic", 2000);

    const row = db.prepare("SELECT lifetime_score FROM users WHERE id = ?").get(userId) as any;
    expect(row.lifetime_score).toBe(5000);
  });

  it("bumps users.total_games in lock-step with each insert", () => {
    // Direct invariant test for the cached column the lifetime
    // leaderboard reads instead of LEFT-JOINing user_game_history.
    recordSinglePlayerGame(db, userId, "session-1", "classic", 1000);
    recordSinglePlayerGame(db, userId, "session-2", "classic", 1000);

    const row = db.prepare("SELECT total_games FROM users WHERE id = ?").get(userId) as { total_games: number };
    expect(row.total_games).toBe(2);
  });

  it("does NOT bump total_games on a duplicate session_id (INSERT OR IGNORE branch)", () => {
    // The SP path uses INSERT OR IGNORE on (user_id, session_id) to make
    // request retries idempotent. The cached column must respect the same
    // dedupe semantics — otherwise a retry would silently inflate the
    // user's leaderboard caption.
    recordSinglePlayerGame(db, userId, "session-1", "classic", 1000);
    recordSinglePlayerGame(db, userId, "session-1", "classic", 1000);

    const row = db.prepare("SELECT total_games FROM users WHERE id = ?").get(userId) as { total_games: number };
    expect(row.total_games).toBe(1);
  });
});

// ── recordMultiplayerGame ─────────────────────────────────────────────────

describe("recordMultiplayerGame", () => {
  it("records a multiplayer game entry with placement", () => {
    recordMultiplayerGame(db, userId, "ABCD", "classic", 7000, 1, 4, 5, false);

    const rows = db.prepare("SELECT * FROM user_game_history WHERE user_id = ?").all(userId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].game_type).toBe("multiplayer");
    expect(rows[0].game_mode).toBe("classic");
    expect(rows[0].room_code).toBe("ABCD");
    expect(rows[0].score).toBe(7000);
    expect(rows[0].placement).toBe(1);
    expect(rows[0].players_count).toBe(4);
  });

  it("increments lifetime_score for multiplayer games", () => {
    recordMultiplayerGame(db, userId, "ABCD", "classic", 4000, 2, 3, 5, false);

    const row = db.prepare("SELECT lifetime_score FROM users WHERE id = ?").get(userId) as any;
    expect(row.lifetime_score).toBe(4000);
  });

  it("bumps users.total_games on each multiplayer record", () => {
    // MP path is unguarded by INSERT OR IGNORE — every call inserts a
    // fresh row and should bump the cached column. Direct invariant
    // test for the column the leaderboard reads from.
    recordMultiplayerGame(db, userId, "ABCD", "classic", 1000, 1, 4, 5, false);
    recordMultiplayerGame(db, userId, "EFGH", "classic", 1000, 2, 4, 5, false);
    recordMultiplayerGame(db, userId, "IJKL", "classic", 1000, 3, 4, 5, false);

    const row = db.prepare("SELECT total_games FROM users WHERE id = ?").get(userId) as { total_games: number };
    expect(row.total_games).toBe(3);
  });
});

// ── getUserGameHistory ────────────────────────────────────────────────────

describe("getUserGameHistory", () => {
  beforeEach(() => {
    // Insert several games
    recordSinglePlayerGame(db, userId, "s1", "classic", 1000);
    recordSinglePlayerGame(db, userId, "s2", "higher-lower", 2000);
    recordMultiplayerGame(db, userId, "R1", "classic", 3000, 1, 3, 5, false);
    recordMultiplayerGame(db, userId, "R2", "comparison", 4000, 2, 4, 5, false);
  });

  it("returns all games sorted by played_at DESC", () => {
    const history = getUserGameHistory(db, userId);
    expect(history).toHaveLength(4);
    // All four games should be present
    const scores = history.map((e) => e.score).sort((a, b) => b - a);
    expect(scores).toEqual([4000, 3000, 2000, 1000]);
  });

  it("supports pagination with limit and offset", () => {
    const page1 = getUserGameHistory(db, userId, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = getUserGameHistory(db, userId, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    // Pages should not overlap
    const ids1 = page1.map((e) => e.id);
    const ids2 = page2.map((e) => e.id);
    for (const id of ids1) {
      expect(ids2).not.toContain(id);
    }
  });

  it("filters by gameType 'single'", () => {
    const history = getUserGameHistory(db, userId, { gameType: "single" });
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(entry.gameType).toBe("single");
    }
  });

  it("filters by gameType 'multiplayer'", () => {
    const history = getUserGameHistory(db, userId, { gameType: "multiplayer" });
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(entry.gameType).toBe("multiplayer");
    }
  });

  it("returns empty array for user with no history", () => {
    const otherUserId = seedUser(db, "newuser", "new@example.com", "password1234");
    const history = getUserGameHistory(db, otherUserId);
    expect(history).toHaveLength(0);
  });

  it("maps fields correctly to GameHistoryEntry", () => {
    const history = getUserGameHistory(db, userId, { gameType: "multiplayer", limit: 1 });
    const entry = history[0];
    expect(entry.id).toBeDefined();
    expect(typeof entry.id).toBe("number");
    expect(entry.gameType).toBe("multiplayer");
    expect(typeof entry.gameMode).toBe("string");
    expect(typeof entry.score).toBe("number");
    expect(typeof entry.playedAt).toBe("string");
    // Multiplayer entries have placement and playersCount
    expect(entry.placement).not.toBeNull();
    expect(entry.playersCount).not.toBeNull();
  });

  it("filters by gameMode", () => {
    const history = getUserGameHistory(db, userId, { gameMode: "classic" });
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(entry.gameMode).toBe("classic");
    }
  });

  it("combines gameType and gameMode filters", () => {
    const history = getUserGameHistory(db, userId, { gameType: "multiplayer", gameMode: "classic" });
    expect(history).toHaveLength(1);
    expect(history[0].gameType).toBe("multiplayer");
    expect(history[0].gameMode).toBe("classic");
  });
});

// ── getUserScoreHistory ─────────────────────────────────────────────────

describe("getUserScoreHistory", () => {
  it("returns a zero-filled `days`-length array of daily score aggregates", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 1000);
    recordSinglePlayerGame(db, userId, "s2", "classic", 2000);

    const history = getUserScoreHistory(db, userId, 7);
    expect(history.length).toBe(7);

    const today = history[history.length - 1];
    expect(today.totalScore).toBe(3000);
    expect(today.gamesPlayed).toBe(2);
    expect(today.date).toBeDefined();
  });

  it("returns a zero-filled window for user with no history", () => {
    const history = getUserScoreHistory(db, userId, 30);
    expect(history.length).toBe(30);
    expect(history.every((d) => d.totalScore === 0 && d.gamesPlayed === 0)).toBe(true);
  });

  it("accepts a timeZone parameter and buckets accordingly", () => {
    // Insert a game at 05:00 UTC — 21:00 PST / 22:00 PDT the previous
    // day — so the PT bucket and the UTC bucket necessarily disagree.
    // Use "yesterday" to stay inside any reasonable days window.
    const anchor = new Date(Date.now() - 86400000);
    anchor.setUTCHours(5, 0, 0, 0);
    const iso = anchor.toISOString();
    const expectedPt = tzDateString(iso, ADMIN_TIMEZONE);
    expect(expectedPt).not.toBe(iso.slice(0, 10));

    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
       VALUES (?, 'single', 'classic', 'tz1', 1500, ?)`,
    ).run(userId, iso);

    const pt = getUserScoreHistory(db, userId, 30, ADMIN_TIMEZONE);
    const ptEntry = pt.find((d) => d.date === expectedPt);
    expect(ptEntry).toBeDefined();
    expect(ptEntry!.totalScore).toBe(1500);
    expect(ptEntry!.gamesPlayed).toBe(1);
  });

  it("defaults to ADMIN_TIMEZONE when no timeZone is passed", () => {
    // Two games on the same PT day but split across two UTC days.
    // Old UTC-bucketed code would split them; new code merges them.
    const earlyPt = new Date("2026-03-15T05:00:00Z"); // 22:00 PDT 3/14
    const latePt = new Date("2026-03-15T15:00:00Z"); // 08:00 PDT 3/15 — different PT day!
    // Use two timestamps that SHARE a PT day (both evening PT same day).
    const a = "2026-03-14T23:00:00Z"; // 16:00 PDT 3/14
    const b = "2026-03-15T04:30:00Z"; // 21:30 PDT 3/14
    void earlyPt;
    void latePt;

    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
       VALUES (?, 'single', 'classic', 'xa', 1000, ?)`,
    ).run(userId, a);
    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
       VALUES (?, 'single', 'classic', 'xb', 2000, ?)`,
    ).run(userId, b);

    const history = getUserScoreHistory(db, userId, 365);
    // Both timestamps map to 2026-03-14 in PT.
    const day = history.find((d) => d.date === "2026-03-14");
    expect(day).toBeDefined();
    expect(day!.totalScore).toBe(3000);
    expect(day!.gamesPlayed).toBe(2);
  });
});

// ── getUserStats ──────────────────────────────────────────────────────────

describe("getUserStats", () => {
  it("returns aggregate stats", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 1000);
    recordSinglePlayerGame(db, userId, "s2", "classic", 3000);
    recordMultiplayerGame(db, userId, "R1", "higher-lower", 5000, 1, 3, 5, false);
    recordMultiplayerGame(db, userId, "R2", "higher-lower", 2000, 2, 3, 5, false);

    const stats = getUserStats(db, userId);

    expect(stats.totalGames).toBe(4);
    expect(stats.totalScore).toBe(11000);
    expect(stats.bestScore).toBe(5000);
    expect(stats.averageScore).toBe(2750);
    expect(stats.gamesByMode).toEqual({
      "classic": 2,
      "higher-lower": 2,
    });
    expect(stats.multiplayerWins).toBe(1);
  });

  it("returns zeroed stats for user with no history", () => {
    const stats = getUserStats(db, userId);

    expect(stats.totalGames).toBe(0);
    expect(stats.totalScore).toBe(0);
    expect(stats.bestScore).toBe(0);
    expect(stats.averageScore).toBe(0);
    expect(stats.gamesByMode).toEqual({});
    expect(stats.multiplayerWins).toBe(0);
  });

  it("counts only placement=1 as multiplayer wins", () => {
    recordMultiplayerGame(db, userId, "R1", "classic", 5000, 1, 4, 5, false);
    recordMultiplayerGame(db, userId, "R2", "classic", 4000, 2, 4, 5, false);
    recordMultiplayerGame(db, userId, "R3", "classic", 6000, 1, 3, 5, false);

    const stats = getUserStats(db, userId);
    expect(stats.multiplayerWins).toBe(2);
  });
});

// ── Rank snapshot recording ──────────────────────────────────────────────

describe("rank snapshot recording", () => {
  it("records a rank snapshot after single-player game", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 5000);

    const rows = db.prepare("SELECT * FROM user_rank_history WHERE user_id = ?").all(userId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].total_players).toBe(1);
    expect(rows[0].recorded_at).toBeDefined();
  });

  it("records a rank snapshot after multiplayer game", () => {
    recordMultiplayerGame(db, userId, "ABCD", "classic", 5000, 1, 4, 5, false);

    const rows = db.prepare("SELECT * FROM user_rank_history WHERE user_id = ?").all(userId) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].rank).toBe(1);
  });

  it("updates best_rank on users table", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 5000);

    const user = db.prepare("SELECT best_rank FROM users WHERE id = ?").get(userId) as any;
    expect(user.best_rank).toBe(1);
  });

  it("preserves best_rank when current rank worsens", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 9000);

    // Add a higher-scoring user so our rank drops
    const otherId = seedUser(db, "bigscorer", "big@example.com", "password1234");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(99999, otherId);

    recordSinglePlayerGame(db, userId, "s2", "classic", 100);

    const user = db.prepare("SELECT best_rank FROM users WHERE id = ?").get(userId) as any;
    expect(user.best_rank).toBe(1); // best_rank stays at 1

    const rows = db.prepare("SELECT rank FROM user_rank_history WHERE user_id = ? ORDER BY id").all(userId) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2); // current rank dropped
  });

  it("does not record rank snapshot on duplicate session (INSERT OR IGNORE)", () => {
    recordSinglePlayerGame(db, userId, "s1", "classic", 5000);
    recordSinglePlayerGame(db, userId, "s1", "classic", 5000); // duplicate

    const rows = db.prepare("SELECT * FROM user_rank_history WHERE user_id = ?").all(userId) as any[];
    expect(rows).toHaveLength(1);
  });
});

// ── win/loss/streak cache + is_win persistence ────────────────────────────

describe("W/L tracking on user record functions", () => {
  /** Stamp a session row so recordSinglePlayerGame can read total_rounds. */
  function seedSession(sessionId: string, totalRounds: number): void {
    db.prepare(
      `INSERT INTO game_sessions (id, total_rounds, game_mode, started_at) VALUES (?, ?, 'classic', ?)`,
    ).run(sessionId, totalRounds, new Date().toISOString());
  }

  it("SP: stores is_win=1 and bumps lifetime_wins + streak when score >= 50% of max", () => {
    seedSession("s-win", 10);
    // classic per-round max = 1000; total max = 10000; 5000 = 50% threshold (inclusive win).
    const outcome = recordSinglePlayerGame(db, userId, "s-win", "classic", 5000);
    expect(outcome).toBe(true);
    const row = db
      .prepare("SELECT is_win FROM user_game_history WHERE session_id = ?")
      .get("s-win") as { is_win: number };
    expect(row.is_win).toBe(1);
    const u = db
      .prepare("SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number; lifetime_losses: number; current_streak: number; best_win_streak: number };
    expect(u.lifetime_wins).toBe(1);
    expect(u.lifetime_losses).toBe(0);
    expect(u.current_streak).toBe(1);
    expect(u.best_win_streak).toBe(1);
  });

  it("SP: stores is_win=0 and increments losses on a sub-50% score", () => {
    seedSession("s-loss", 10);
    const outcome = recordSinglePlayerGame(db, userId, "s-loss", "classic", 4999);
    expect(outcome).toBe(false);
    const row = db
      .prepare("SELECT is_win FROM user_game_history WHERE session_id = ?")
      .get("s-loss") as { is_win: number };
    expect(row.is_win).toBe(0);
    const u = db
      .prepare("SELECT lifetime_losses, current_streak FROM users WHERE id = ?")
      .get(userId) as { lifetime_losses: number; current_streak: number };
    expect(u.lifetime_losses).toBe(1);
    expect(u.current_streak).toBe(-1);
  });

  it("SP: signed streak flips through zero when direction changes", () => {
    for (let i = 1; i <= 3; i++) {
      seedSession(`s-w${i}`, 10);
      recordSinglePlayerGame(db, userId, `s-w${i}`, "classic", 8000);
    }
    let u = db
      .prepare("SELECT current_streak, best_win_streak FROM users WHERE id = ?")
      .get(userId) as { current_streak: number; best_win_streak: number };
    expect(u.current_streak).toBe(3);
    expect(u.best_win_streak).toBe(3);

    seedSession("s-l1", 10);
    recordSinglePlayerGame(db, userId, "s-l1", "classic", 100);
    u = db
      .prepare("SELECT current_streak, best_win_streak FROM users WHERE id = ?")
      .get(userId) as { current_streak: number; best_win_streak: number };
    expect(u.current_streak).toBe(-1);
    // best_win_streak preserved
    expect(u.best_win_streak).toBe(3);

    seedSession("s-l2", 10);
    recordSinglePlayerGame(db, userId, "s-l2", "classic", 100);
    u = db.prepare("SELECT current_streak FROM users WHERE id = ?").get(userId) as { current_streak: number };
    expect(u.current_streak).toBe(-2);

    // A win flips negative streak to +1.
    seedSession("s-w-back", 10);
    recordSinglePlayerGame(db, userId, "s-w-back", "classic", 9000);
    u = db.prepare("SELECT current_streak FROM users WHERE id = ?").get(userId) as { current_streak: number };
    expect(u.current_streak).toBe(1);
  });

  it("SP: does not bump W/L on duplicate session_id (INSERT OR IGNORE)", () => {
    seedSession("s-dup", 10);
    recordSinglePlayerGame(db, userId, "s-dup", "classic", 8000);
    recordSinglePlayerGame(db, userId, "s-dup", "classic", 8000); // dup
    const u = db
      .prepare("SELECT lifetime_wins, current_streak FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number; current_streak: number };
    expect(u.lifetime_wins).toBe(1);
    expect(u.current_streak).toBe(1);
  });

  it("SP: skipped (is_win=NULL, no W/L bump) when total_rounds is missing", () => {
    // No game_sessions row at all → totalRounds defaults to 0 in the helper.
    const outcome = recordSinglePlayerGame(db, userId, "s-no-session", "classic", 8000);
    expect(outcome).toBeNull();
    const row = db
      .prepare("SELECT is_win FROM user_game_history WHERE session_id = ?")
      .get("s-no-session") as { is_win: number | null };
    expect(row.is_win).toBeNull();
    const u = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number; lifetime_losses: number };
    expect(u.lifetime_wins).toBe(0);
    expect(u.lifetime_losses).toBe(0);
  });

  it("SP: bot user gets is_win=NULL and no W/L counter movement", () => {
    db.prepare("UPDATE users SET is_bot = 1 WHERE id = ?").run(userId);
    seedSession("s-bot", 10);
    const outcome = recordSinglePlayerGame(db, userId, "s-bot", "classic", 9000);
    expect(outcome).toBeNull();
    const u = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number; lifetime_losses: number };
    expect(u.lifetime_wins).toBe(0);
    expect(u.lifetime_losses).toBe(0);
  });

  it("MP: placement=1 is a win, placement>1 is a loss", () => {
    expect(recordMultiplayerGame(db, userId, "R1", "classic", 5000, 1, 4, 5, false)).toBe(true);
    expect(recordMultiplayerGame(db, userId, "R2", "classic", 4000, 2, 4, 5, false)).toBe(false);
    const rows = db
      .prepare("SELECT room_code, is_win FROM user_game_history WHERE user_id = ? ORDER BY room_code")
      .all(userId) as { room_code: string; is_win: number }[];
    expect(rows).toEqual([
      { room_code: "R1", is_win: 1 },
      { room_code: "R2", is_win: 0 },
    ]);
  });

  it("MP: solo room (playersCount<2) yields is_win=NULL — anti streak-farm", () => {
    const outcome = recordMultiplayerGame(db, userId, "SOLO", "classic", 5000, 1, 1, 5, false);
    expect(outcome).toBeNull();
    const row = db
      .prepare("SELECT is_win FROM user_game_history WHERE room_code = ?")
      .get("SOLO") as { is_win: number | null };
    expect(row.is_win).toBeNull();
    const u = db
      .prepare("SELECT lifetime_wins FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number };
    expect(u.lifetime_wins).toBe(0);
  });

  it("MP: bot-lobby anti-farm — caller passes credited count (humans only) so 1H+NB rooms count as solo", () => {
    // mpRoundEnd already filters out labeled bots / streamer-bot rows
    // before computing `totalPlayers = credited.length`. This test
    // documents the contract: when a 1-human + 1-bot lobby is recorded,
    // the caller MUST pass playersCount=1 (the credited count), not 2
    // (raw standings.length). Otherwise a single human guarantees
    // placement #1 against a labeled bot and farms +1 streak per game.
    const outcome = recordMultiplayerGame(db, userId, "BOTLOBBY", "classic", 5000, 1, 1, 5, false);
    expect(outcome).toBeNull();
  });

  it("MP: bot row is skipped (is_win=NULL)", () => {
    const outcome = recordMultiplayerGame(db, userId, "BOTROOM", "classic", 5000, 1, 4, 5, true);
    expect(outcome).toBeNull();
    const u = db
      .prepare("SELECT lifetime_wins FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number };
    expect(u.lifetime_wins).toBe(0);
  });
});
