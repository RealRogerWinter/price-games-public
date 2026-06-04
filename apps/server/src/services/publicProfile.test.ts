import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  getLeaderboardAvailability,
  getLeaderboardPeriodCutoff,
  getLifetimeLeaderboard,
  getLongestStreakLeaderboard,
  getPeriodLeaderboard,
  getUserRank,
  getPublicPlayerProfile,
  getPublicScoreHistory,
  getPublicGameHistory,
  getRankHistory,
} from "./publicProfile";
import { tzDateString, ADMIN_TIMEZONE } from "@price-game/shared";

let db: DatabaseType;

/** Seed a user with a specific lifetime_score. Returns the user id. */
function seedScoredUser(
  username: string,
  lifetimeScore: number,
  options?: { isActive?: boolean },
): string {
  const id = seedUser(db, username, `${username}@test.com`);
  db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(
    lifetimeScore,
    id,
  );
  if (options?.isActive === false) {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(id);
  }
  return id;
}

/** Insert a game history entry for a user. */
function seedGameHistory(
  userId: string,
  gameMode: string,
  score: number,
  playedAt: string,
  options?: {
    gameType?: "single" | "multiplayer";
    placement?: number;
    playersCount?: number;
  },
): void {
  const gameType = options?.gameType ?? "single";
  db.prepare(
    `INSERT INTO user_game_history (user_id, game_type, game_mode, score, placement, players_count, played_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    gameType,
    gameMode,
    score,
    options?.placement ?? null,
    options?.playersCount ?? null,
    playedAt,
  );
  // Mirror production: bump the cached total_games column (PR1 perf F2).
  // Production callers do this inside the same transaction as the INSERT
  // (see services/userGameHistory.ts), but the seed helper isn't wrapped
  // — every test insert is its own statement, so a per-call UPDATE is fine.
  db.prepare("UPDATE users SET total_games = total_games + 1 WHERE id = ?").run(userId);
}

beforeEach(() => {
  db = createTestDb();
});

// ─── getLifetimeLeaderboard ───

describe("getLifetimeLeaderboard", () => {
  it("returns players sorted by lifetime_score DESC with correct ranks", () => {
    seedScoredUser("alice", 5000);
    seedScoredUser("bob", 8000);
    seedScoredUser("charlie", 3000);

    const result = getLifetimeLeaderboard(db);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ rank: 1, username: "bob", lifetimeScore: 8000 });
    expect(result[1]).toMatchObject({ rank: 2, username: "alice", lifetimeScore: 5000 });
    expect(result[2]).toMatchObject({ rank: 3, username: "charlie", lifetimeScore: 3000 });
  });

  it("respects limit parameter", () => {
    seedScoredUser("a", 100);
    seedScoredUser("b", 200);
    seedScoredUser("c", 300);

    const result = getLifetimeLeaderboard(db, 2);
    expect(result).toHaveLength(2);
    expect(result[0].username).toBe("c");
    expect(result[1].username).toBe("b");
  });

  it("respects offset parameter for pagination", () => {
    seedScoredUser("a", 100);
    seedScoredUser("b", 200);
    seedScoredUser("c", 300);

    const result = getLifetimeLeaderboard(db, 2, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ rank: 2, username: "b" });
    expect(result[1]).toMatchObject({ rank: 3, username: "a" });
  });

  it("excludes inactive users", () => {
    seedScoredUser("active", 5000);
    seedScoredUser("inactive", 9999, { isActive: false });

    const result = getLifetimeLeaderboard(db);
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("active");
  });

  it("returns empty array when no users exist", () => {
    const result = getLifetimeLeaderboard(db);
    expect(result).toEqual([]);
  });

  it("includes totalGames count per player", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-01-01T10:00:00Z");
    seedGameHistory(id, "classic", 2000, "2026-01-02T10:00:00Z");
    seedGameHistory(id, "higher-lower", 2000, "2026-01-03T10:00:00Z");

    const result = getLifetimeLeaderboard(db);
    expect(result[0].totalGames).toBe(3);
  });

  it("returns totalGames 0 for users with no game history", () => {
    // The leaderboard hides zero-score users, so give this player a
    // minimum positive score while still leaving them with no history.
    seedScoredUser("newbie", 1);

    const result = getLifetimeLeaderboard(db);
    expect(result[0].totalGames).toBe(0);
  });
});

// ─── getLifetimeLeaderboard — gameType filter ───

describe("getLifetimeLeaderboard — gameType filter", () => {
  it("gameType='all' returns the canonical lifetime board (current behavior)", () => {
    const aliceId = seedScoredUser("alice", 7000);
    seedGameHistory(aliceId, "classic", 4000, "2026-01-01T10:00:00Z", { gameType: "single" });
    seedGameHistory(aliceId, "classic", 3000, "2026-01-02T10:00:00Z", { gameType: "multiplayer" });

    const result = getLifetimeLeaderboard(db, 50, 0, "all");
    expect(result).toHaveLength(1);
    // Score is `users.lifetime_score` for "all" — set independently above.
    expect(result[0]).toMatchObject({ rank: 1, username: "alice", lifetimeScore: 7000 });
  });

  it("gameType='sp' includes only single-player rows and excludes MP-only players", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 1000, "2026-01-01T10:00:00Z", { gameType: "single" });
    seedGameHistory(aliceId, "classic", 9999, "2026-01-02T10:00:00Z", { gameType: "multiplayer" });

    // bob only ever played multiplayer — should drop off the SP board.
    const bobId = seedScoredUser("bob", 9999);
    seedGameHistory(bobId, "classic", 5000, "2026-01-01T10:00:00Z", { gameType: "multiplayer" });

    const result = getLifetimeLeaderboard(db, 50, 0, "sp");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rank: 1, username: "alice", lifetimeScore: 1000, totalGames: 1 });
  });

  it("gameType='mp' includes only multiplayer rows and excludes SP-only players", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 9999, "2026-01-01T10:00:00Z", { gameType: "single" });

    const bobId = seedScoredUser("bob", 9999);
    seedGameHistory(bobId, "classic", 1500, "2026-01-01T10:00:00Z", { gameType: "multiplayer" });
    seedGameHistory(bobId, "classic", 500, "2026-01-02T10:00:00Z", { gameType: "multiplayer" });

    const result = getLifetimeLeaderboard(db, 50, 0, "mp");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rank: 1, username: "bob", lifetimeScore: 2000, totalGames: 2 });
  });

  it("gameType='sp' orders by SP-only score, not lifetime_score", () => {
    // alice has the larger lifetime_score but a smaller SP slice; bob
    // ranks above her on the SP board even though she's #1 on "all".
    const aliceId = seedScoredUser("alice", 10000);
    seedGameHistory(aliceId, "classic", 100, "2026-01-01T10:00:00Z", { gameType: "single" });
    seedGameHistory(aliceId, "classic", 9900, "2026-01-02T10:00:00Z", { gameType: "multiplayer" });

    const bobId = seedScoredUser("bob", 5000);
    seedGameHistory(bobId, "classic", 5000, "2026-01-01T10:00:00Z", { gameType: "single" });

    const result = getLifetimeLeaderboard(db, 50, 0, "sp");
    expect(result.map((r) => r.username)).toEqual(["bob", "alice"]);
    expect(result[0]).toMatchObject({ rank: 1, username: "bob", lifetimeScore: 5000 });
  });

  it("gameType='sp' returns empty when no single-player rows exist", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 5000, "2026-01-01T10:00:00Z", { gameType: "multiplayer" });

    expect(getLifetimeLeaderboard(db, 50, 0, "sp")).toEqual([]);
  });

  it("gameType='mp' excludes inactive users", () => {
    const activeId = seedScoredUser("active", 100);
    const inactiveId = seedScoredUser("inactive", 100, { isActive: false });
    seedGameHistory(activeId, "classic", 500, "2026-01-01T10:00:00Z", { gameType: "multiplayer" });
    seedGameHistory(inactiveId, "classic", 9000, "2026-01-01T10:00:00Z", { gameType: "multiplayer" });

    const result = getLifetimeLeaderboard(db, 50, 0, "mp");
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("active");
  });
});

// ─── getLeaderboardPeriodCutoff ───

describe("getLeaderboardPeriodCutoff", () => {
  const fixedNow = Date.UTC(2026, 3, 17, 12, 0, 0); // 2026-04-17T12:00:00Z

  it("returns null for period=all", () => {
    expect(getLeaderboardPeriodCutoff("all", fixedNow)).toBeNull();
  });

  it("returns now - 24h for period=day", () => {
    const cut = getLeaderboardPeriodCutoff("day", fixedNow)!;
    expect(new Date(cut).getTime()).toBe(fixedNow - 24 * 60 * 60 * 1000);
  });

  it("returns now - 7d for period=week", () => {
    const cut = getLeaderboardPeriodCutoff("week", fixedNow)!;
    expect(new Date(cut).getTime()).toBe(fixedNow - 7 * 24 * 60 * 60 * 1000);
  });

  it("returns now - 30d for period=month", () => {
    const cut = getLeaderboardPeriodCutoff("month", fixedNow)!;
    expect(new Date(cut).getTime()).toBe(fixedNow - 30 * 24 * 60 * 60 * 1000);
  });
});

// ─── getPeriodLeaderboard ───

describe("getPeriodLeaderboard", () => {
  const fixedNow = Date.UTC(2026, 3, 17, 12, 0, 0); // 2026-04-17T12:00:00Z

  function isoDaysAgo(days: number): string {
    return new Date(fixedNow - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("sums scores within the period window and excludes older rows", () => {
    const aliceId = seedScoredUser("alice", 9999);
    const bobId = seedScoredUser("bob", 9999);

    // Within 24h: alice earns 300, bob earns 100.
    seedGameHistory(aliceId, "classic", 200, isoDaysAgo(0.2));
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(0.8));
    seedGameHistory(bobId, "classic", 100, isoDaysAgo(0.5));
    // Older than 24h: excluded from "day".
    seedGameHistory(aliceId, "classic", 5000, isoDaysAgo(3));
    seedGameHistory(bobId, "classic", 9000, isoDaysAgo(10));

    const result = getPeriodLeaderboard(db, "day", 50, 0, fixedNow);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ rank: 1, username: "alice", score: 300, totalGames: 2 });
    expect(result[1]).toMatchObject({ rank: 2, username: "bob", score: 100, totalGames: 1 });
  });

  it("expands the window for period=week and period=month", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(0.5)); // in day + week + month
    seedGameHistory(aliceId, "classic", 200, isoDaysAgo(3));   // in week + month
    seedGameHistory(aliceId, "classic", 400, isoDaysAgo(20));  // in month only
    seedGameHistory(aliceId, "classic", 800, isoDaysAgo(60));  // in none

    expect(getPeriodLeaderboard(db, "day", 50, 0, fixedNow)[0].score).toBe(100);
    expect(getPeriodLeaderboard(db, "week", 50, 0, fixedNow)[0].score).toBe(300);
    expect(getPeriodLeaderboard(db, "month", 50, 0, fixedNow)[0].score).toBe(700);
  });

  it("excludes users with zero score in the period", () => {
    const aliceId = seedScoredUser("alice", 9999);
    const bobId = seedScoredUser("bob", 9999);
    // alice: in-period. bob: old-only.
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(0.2));
    seedGameHistory(bobId, "classic", 500, isoDaysAgo(60));

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow);
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("alice");
  });

  it("orders by score DESC with username ASC as tiebreaker", () => {
    const aliceId = seedScoredUser("alice", 100);
    const bobId = seedScoredUser("bob", 100);
    seedGameHistory(aliceId, "classic", 500, isoDaysAgo(1));
    seedGameHistory(bobId, "classic", 500, isoDaysAgo(1));

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow);
    expect(result[0].username).toBe("alice");
    expect(result[1].username).toBe("bob");
  });

  it("excludes inactive users", () => {
    const activeId = seedScoredUser("active", 100);
    const inactiveId = seedScoredUser("inactive", 100, { isActive: false });
    seedGameHistory(activeId, "classic", 500, isoDaysAgo(1));
    seedGameHistory(inactiveId, "classic", 9000, isoDaysAgo(1));

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow);
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("active");
  });

  it("respects limit and offset for pagination", () => {
    for (let i = 0; i < 5; i++) {
      const id = seedScoredUser(`u${i}`, 100);
      seedGameHistory(id, "classic", (i + 1) * 100, isoDaysAgo(1));
    }

    const page1 = getPeriodLeaderboard(db, "week", 2, 0, fixedNow);
    const page2 = getPeriodLeaderboard(db, "week", 2, 2, fixedNow);

    expect(page1).toHaveLength(2);
    expect(page1[0].rank).toBe(1);
    expect(page1[0].score).toBe(500);
    expect(page2).toHaveLength(2);
    expect(page2[0].rank).toBe(3);
    expect(page2[0].score).toBe(300);
  });

  it("clamps invalid limit values", () => {
    const id = seedScoredUser("u", 100);
    seedGameHistory(id, "classic", 500, isoDaysAgo(1));
    // limit=0 → clamped to 1
    expect(getPeriodLeaderboard(db, "week", 0, 0, fixedNow)).toHaveLength(1);
    // limit=500 → clamped to 100 (we only have 1 row, so length is 1 regardless)
    expect(getPeriodLeaderboard(db, "week", 500, 0, fixedNow)).toHaveLength(1);
  });

  it("returns empty array when no games exist in the window", () => {
    const id = seedScoredUser("alice", 9999);
    seedGameHistory(id, "classic", 500, isoDaysAgo(60));

    const result = getPeriodLeaderboard(db, "day", 50, 0, fixedNow);
    expect(result).toEqual([]);
  });

  it("counts only games within the window for totalGames", () => {
    const id = seedScoredUser("alice", 9999);
    seedGameHistory(id, "classic", 100, isoDaysAgo(0.5));
    seedGameHistory(id, "classic", 200, isoDaysAgo(3));
    seedGameHistory(id, "classic", 300, isoDaysAgo(60));

    const day = getPeriodLeaderboard(db, "day", 50, 0, fixedNow);
    const week = getPeriodLeaderboard(db, "week", 50, 0, fixedNow);
    expect(day[0].totalGames).toBe(1);
    expect(week[0].totalGames).toBe(2);
  });
});

// ─── getPeriodLeaderboard — gameType filter ───

describe("getPeriodLeaderboard — gameType filter", () => {
  const fixedNow = Date.UTC(2026, 3, 17, 12, 0, 0);
  function isoDaysAgo(days: number): string {
    return new Date(fixedNow - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("gameType='all' (default) sums both single and multiplayer rows", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 200, isoDaysAgo(1), { gameType: "single" });
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(1), { gameType: "multiplayer" });

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow, "all");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ score: 300, totalGames: 2 });
  });

  it("gameType='sp' sums only single-player rows in the window", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 200, isoDaysAgo(1), { gameType: "single" });
    seedGameHistory(aliceId, "classic", 999, isoDaysAgo(1), { gameType: "multiplayer" });

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow, "sp");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ username: "alice", score: 200, totalGames: 1 });
  });

  it("gameType='mp' sums only multiplayer rows in the window", () => {
    const aliceId = seedScoredUser("alice", 9999);
    seedGameHistory(aliceId, "classic", 999, isoDaysAgo(1), { gameType: "single" });
    seedGameHistory(aliceId, "classic", 250, isoDaysAgo(1), { gameType: "multiplayer" });

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow, "mp");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ username: "alice", score: 250, totalGames: 1 });
  });

  it("gameType='sp' excludes a player whose only in-window rows are MP", () => {
    const aliceId = seedScoredUser("alice", 9999);
    const bobId = seedScoredUser("bob", 9999);
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(1), { gameType: "single" });
    seedGameHistory(bobId, "classic", 999, isoDaysAgo(1), { gameType: "multiplayer" });

    const result = getPeriodLeaderboard(db, "week", 50, 0, fixedNow, "sp");
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("alice");
  });

  it("gameType filter combines with the period cutoff (older rows excluded)", () => {
    const aliceId = seedScoredUser("alice", 9999);
    // In-window SP row, in-window MP row, and an old SP row.
    seedGameHistory(aliceId, "classic", 100, isoDaysAgo(0.5), { gameType: "single" });
    seedGameHistory(aliceId, "classic", 200, isoDaysAgo(0.5), { gameType: "multiplayer" });
    seedGameHistory(aliceId, "classic", 9000, isoDaysAgo(60), { gameType: "single" });

    const dayMp = getPeriodLeaderboard(db, "day", 50, 0, fixedNow, "mp");
    expect(dayMp).toHaveLength(1);
    expect(dayMp[0]).toMatchObject({ score: 200, totalGames: 1 });

    const daySp = getPeriodLeaderboard(db, "day", 50, 0, fixedNow, "sp");
    expect(daySp).toHaveLength(1);
    expect(daySp[0]).toMatchObject({ score: 100, totalGames: 1 });
  });
});

// ─── getLeaderboardAvailability ───

describe("getLeaderboardAvailability", () => {
  const fixedNow = Date.UTC(2026, 3, 17, 12, 0, 0);

  function isoDaysAgo(days: number): string {
    return new Date(fixedNow - days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("returns zero counts when there are no users", () => {
    expect(getLeaderboardAvailability(db, fixedNow)).toEqual({
      day: 0, week: 0, month: 0, all: 0,
    });
  });

  it("flags each rolling window where any qualifying player has scored", () => {
    // Bounded fields are existence flags (0 or 1) post-F1 — exact counts
    // were never consumed by the client, only truthiness. `all` remains
    // a real count.
    const aliceId = seedScoredUser("alice", 100);
    const bobId = seedScoredUser("bob", 100);
    const carolId = seedScoredUser("carol", 100);

    // Alice: today → flips on day, week, month
    seedGameHistory(aliceId, "classic", 50, isoDaysAgo(0.5));
    // Bob: 3 days ago → reinforces week + month
    seedGameHistory(bobId, "classic", 50, isoDaysAgo(3));
    // Carol: 20 days ago → reinforces month
    seedGameHistory(carolId, "classic", 50, isoDaysAgo(20));

    expect(getLeaderboardAvailability(db, fixedNow)).toEqual({
      day: 1, week: 1, month: 1, all: 3,
    });
  });

  it("flags only month when the only play is in-month but outside the week", () => {
    const id = seedScoredUser("midgrade", 100);
    seedGameHistory(id, "classic", 50, isoDaysAgo(20));

    expect(getLeaderboardAvailability(db, fixedNow)).toEqual({
      day: 0, week: 0, month: 1, all: 1,
    });
  });

  it("excludes inactive users from bounded-period counts", () => {
    const id = seedScoredUser("inactive", 100, { isActive: false });
    seedGameHistory(id, "classic", 50, isoDaysAgo(0.5));

    const result = getLeaderboardAvailability(db, fixedNow);
    expect(result.day).toBe(0);
    expect(result.week).toBe(0);
    expect(result.month).toBe(0);
    expect(result.all).toBe(0);
  });

  it("a user whose only games are >30d old counts toward all but no bounded period", () => {
    const id = seedScoredUser("veteran", 500);
    seedGameHistory(id, "classic", 500, isoDaysAgo(60));

    expect(getLeaderboardAvailability(db, fixedNow)).toEqual({
      day: 0, week: 0, month: 0, all: 1,
    });
  });

  it("counts a user with lifetime_score>0 but no history rows toward 'all' only", () => {
    seedScoredUser("legacy", 1000); // no game history seeded
    const result = getLeaderboardAvailability(db, fixedNow);
    expect(result.all).toBe(1);
    expect(result.day + result.week + result.month).toBe(0);
  });

  it("excludes banned users and test accounts from the 'all' count", () => {
    // Mirror the lifetime-leaderboard visibility filters so the "N players"
    // caption matches the actual board. Pre-followup the count silently
    // included banned + test users and disagreed with the listing.
    seedScoredUser("visible", 500);
    const bannedId = seedScoredUser("banned", 500);
    db.prepare(
      "UPDATE users SET leaderboard_banned_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), bannedId);
    const testId = seedScoredUser("test", 500);
    db.prepare("UPDATE users SET is_test_account = 1 WHERE id = ?").run(testId);

    const result = getLeaderboardAvailability(db, fixedNow);
    expect(result.all).toBe(1); // only "visible"
  });
});

// ─── getUserRank ───

describe("getUserRank", () => {
  it("returns rank=1 for top player", () => {
    const topId = seedScoredUser("top", 9000);
    seedScoredUser("mid", 5000);
    seedScoredUser("low", 1000);

    const result = getUserRank(db, topId);
    expect(result).toEqual({ rank: 1, totalPlayers: 3, bestRank: 1 });
  });

  it("returns correct rank for mid-ranked player", () => {
    seedScoredUser("top", 9000);
    const midId = seedScoredUser("mid", 5000);
    seedScoredUser("low", 1000);

    const result = getUserRank(db, midId);
    expect(result).toEqual({ rank: 2, totalPlayers: 3, bestRank: 2 });
  });

  it("returns correct totalPlayers count", () => {
    const id = seedScoredUser("only", 100);

    const result = getUserRank(db, id);
    expect(result).toEqual({ rank: 1, totalPlayers: 1, bestRank: 1 });
  });

  it("returns null for non-existent user ID", () => {
    seedScoredUser("exists", 100);

    const result = getUserRank(db, "non-existent-id");
    expect(result).toBeNull();
  });

  it("excludes inactive users from ranking", () => {
    seedScoredUser("inactive-top", 9999, { isActive: false });
    const activeId = seedScoredUser("active", 5000);

    const result = getUserRank(db, activeId);
    expect(result).toEqual({ rank: 1, totalPlayers: 1, bestRank: 1 });
  });

  it("returns stored best_rank when it differs from current rank", () => {
    const id = seedScoredUser("alice", 5000);
    seedScoredUser("bob", 8000);
    // Simulate a historical best rank of 1
    db.prepare("UPDATE users SET best_rank = 1 WHERE id = ?").run(id);

    const result = getUserRank(db, id);
    expect(result).toEqual({ rank: 2, totalPlayers: 2, bestRank: 1 });
  });
});

// ─── getPublicPlayerProfile ───

describe("getPublicPlayerProfile", () => {
  it("returns complete profile for valid username", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 3000, "2026-01-01T10:00:00Z");
    seedGameHistory(id, "higher-lower", 2000, "2026-01-02T10:00:00Z");

    const profile = getPublicPlayerProfile(db, "alice");
    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("alice");
    expect(profile!.lifetimeScore).toBe(5000);
    expect(profile!.totalGames).toBe(2);
    expect(profile!.bestScore).toBe(3000);
    expect(profile!.averageScore).toBe(2500);
  });

  it("returns null for non-existent username", () => {
    const profile = getPublicPlayerProfile(db, "nobody");
    expect(profile).toBeNull();
  });

  it("returns null for inactive user", () => {
    seedScoredUser("inactive", 5000, { isActive: false });

    const profile = getPublicPlayerProfile(db, "inactive");
    expect(profile).toBeNull();
  });

  it("is case-insensitive for username lookup", () => {
    const id = seedScoredUser("Alice", 5000);
    seedGameHistory(id, "classic", 5000, "2026-01-01T10:00:00Z");

    const profile = getPublicPlayerProfile(db, "ALICE");
    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("Alice");
  });

  it("returns memberSince as date-only string", () => {
    seedScoredUser("alice", 100);

    const profile = getPublicPlayerProfile(db, "alice");
    expect(profile).not.toBeNull();
    // Should be YYYY-MM-DD format
    expect(profile!.memberSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns correct gamesByMode breakdown", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-01-01T10:00:00Z");
    seedGameHistory(id, "classic", 2000, "2026-01-02T10:00:00Z");
    seedGameHistory(id, "higher-lower", 2000, "2026-01-03T10:00:00Z");

    const profile = getPublicPlayerProfile(db, "alice");
    expect(profile!.gamesByMode).toEqual({ classic: 2, "higher-lower": 1 });
  });

  it("returns correct multiplayerWins count", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-01-01T10:00:00Z", {
      gameType: "multiplayer",
      placement: 1,
      playersCount: 4,
    });
    seedGameHistory(id, "classic", 500, "2026-01-02T10:00:00Z", {
      gameType: "multiplayer",
      placement: 2,
      playersCount: 4,
    });

    const profile = getPublicPlayerProfile(db, "alice");
    expect(profile!.multiplayerWins).toBe(1);
  });
});

// ─── getPublicScoreHistory ───

describe("getPublicScoreHistory", () => {
  it("returns daily aggregates for user with game history", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-04-01T17:00:00Z");
    seedGameHistory(id, "classic", 2000, "2026-04-01T20:00:00Z");
    seedGameHistory(id, "classic", 500, "2026-04-02T17:00:00Z");

    const result = getPublicScoreHistory(db, "alice", 365);
    // Zero-fill guarantees length === days.
    expect(result.length).toBe(365);
    const day1 = result.find((d) => d.date === "2026-04-01");
    const day2 = result.find((d) => d.date === "2026-04-02");
    expect(day1).toEqual({ date: "2026-04-01", totalScore: 3000, gamesPlayed: 2 });
    expect(day2).toEqual({ date: "2026-04-02", totalScore: 500, gamesPlayed: 1 });
  });

  it("returns a zero-filled window for user with no history", () => {
    seedScoredUser("alice", 0);

    const result = getPublicScoreHistory(db, "alice");
    expect(result.length).toBe(30);
    expect(result.every((d) => d.totalScore === 0 && d.gamesPlayed === 0)).toBe(true);
  });

  it("respects days parameter", () => {
    const id = seedScoredUser("alice", 5000);
    // Old game outside the window
    seedGameHistory(id, "classic", 1000, "2020-01-01T10:00:00Z");
    // Recent game
    const today = new Date().toISOString();
    seedGameHistory(id, "classic", 2000, today);

    const result = getPublicScoreHistory(db, "alice", 7);
    expect(result.length).toBe(7);
    const total = result.reduce((s, d) => s + d.totalScore, 0);
    expect(total).toBe(2000);
  });

  it("returns empty for non-existent username", () => {
    const result = getPublicScoreHistory(db, "nobody");
    expect(result).toEqual([]);
  });

  it("accepts a timeZone parameter", () => {
    const id = seedScoredUser("alice", 5000);
    // 05:00 UTC yesterday = 22:00/21:00 PT the day before yesterday.
    const anchor = new Date(Date.now() - 86400000);
    anchor.setUTCHours(5, 0, 0, 0);
    const iso = anchor.toISOString();
    const expectedPt = tzDateString(iso, ADMIN_TIMEZONE);
    expect(expectedPt).not.toBe(iso.slice(0, 10));

    seedGameHistory(id, "classic", 1500, iso);

    const pt = getPublicScoreHistory(db, "alice", 30, ADMIN_TIMEZONE);
    expect(pt.find((d) => d.date === expectedPt)?.totalScore).toBe(1500);
  });
});

// ─── getPublicGameHistory ───

describe("getPublicGameHistory", () => {
  it("returns entries with a tz-bucketed playedDate (default PT)", () => {
    const id = seedScoredUser("alice", 5000);
    // 17:00 UTC = 10:00 PDT 4/1 — same calendar day in PT and UTC.
    seedGameHistory(id, "classic", 1000, "2026-04-01T17:30:45Z");

    const result = getPublicGameHistory(db, "alice");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].playedDate).toBe("2026-04-01");
  });

  it("buckets by tz — a 05:00 UTC game is 'yesterday' in PT", () => {
    const id = seedScoredUser("alice", 5000);
    // 2026-04-01T05:00:00Z = 22:00 PDT 2026-03-31
    seedGameHistory(id, "classic", 1000, "2026-04-01T05:00:00Z");

    const result = getPublicGameHistory(db, "alice");
    expect(result.entries[0].playedDate).toBe("2026-03-31");
  });

  it("respects limit and offset pagination", () => {
    const id = seedScoredUser("alice", 5000);
    for (let i = 1; i <= 5; i++) {
      seedGameHistory(id, "classic", i * 100, `2026-04-0${i}T10:00:00Z`);
    }

    const page1 = getPublicGameHistory(db, "alice", 2, 0);
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(5);
    // Most recent first (DESC)
    expect(page1.entries[0].score).toBe(500);

    const page2 = getPublicGameHistory(db, "alice", 2, 2);
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].score).toBe(300);
  });

  it("returns correct total count", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-04-01T10:00:00Z");
    seedGameHistory(id, "classic", 2000, "2026-04-02T10:00:00Z");

    const result = getPublicGameHistory(db, "alice", 1);
    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it("returns empty for non-existent username", () => {
    const result = getPublicGameHistory(db, "nobody");
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("is sorted by date DESC", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 100, "2026-04-01T10:00:00Z");
    seedGameHistory(id, "classic", 200, "2026-04-03T10:00:00Z");
    seedGameHistory(id, "classic", 300, "2026-04-02T10:00:00Z");

    const result = getPublicGameHistory(db, "alice");
    expect(result.entries[0].playedDate).toBe("2026-04-03");
    expect(result.entries[1].playedDate).toBe("2026-04-02");
    expect(result.entries[2].playedDate).toBe("2026-04-01");
  });

  it("includes game type and mode in entries", () => {
    const id = seedScoredUser("alice", 5000);
    seedGameHistory(id, "classic", 1000, "2026-04-01T10:00:00Z");
    seedGameHistory(id, "higher-lower", 500, "2026-04-02T10:00:00Z", {
      gameType: "multiplayer",
      placement: 2,
      playersCount: 4,
    });

    const result = getPublicGameHistory(db, "alice");
    const mpEntry = result.entries.find((e) => e.gameType === "multiplayer");
    expect(mpEntry).toBeDefined();
    expect(mpEntry!.gameMode).toBe("higher-lower");
    expect(mpEntry!.placement).toBe(2);
    expect(mpEntry!.playersCount).toBe(4);
  });
});

// ─── getRankHistory ───

/** Insert a rank history entry for a user. */
function seedRankHistory(
  userId: string,
  rank: number,
  totalPlayers: number,
  recordedAt: string,
): void {
  db.prepare(
    "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
  ).run(userId, rank, totalPlayers, recordedAt);
}

describe("getRankHistory", () => {
  /**
   * Build an ISO timestamp `daysAgo` days before now, anchored at
   * 17:00 UTC. 17:00 UTC is safely mid-afternoon PT regardless of
   * DST, so timestamps bucket to their UTC date in PT without
   * cross-midnight drift. Anchoring relative to `Date.now()` rather
   * than hardcoded calendar dates keeps these tests stable as time
   * passes — a hardcoded date that lands exactly 30 days back from
   * "today" trips the lookback window's `>=` boundary and silently
   * drops the row, surfacing as a flake exactly once per year.
   */
  function recentIsoUtc(daysAgo: number, hourUtc: number = 17): string {
    const d = new Date(Date.now() - daysAgo * 86400000);
    d.setUTCHours(hourUtc, 0, 0, 0);
    return d.toISOString();
  }

  /** UTC date string from an ISO timestamp — 'YYYY-MM-DD'. */
  function utcDate(iso: string): string {
    return iso.slice(0, 10);
  }

  it("returns daily rank snapshots sorted by date ascending", () => {
    const id = seedScoredUser("alice", 5000);
    // Seed two recent days at 17:00 UTC each. Anchor 5/4 days ago
    // gives plenty of headroom inside the 30-day window so the
    // assertion can't trip the lookback boundary.
    const earlierIso = recentIsoUtc(5);
    const laterIso = recentIsoUtc(4);
    seedRankHistory(id, 3, 10, earlierIso);
    seedRankHistory(id, 2, 10, laterIso);

    const result = getRankHistory(db, id, 30);
    // Only days with recorded ranks appear — rank history is NOT
    // zero-filled because a "no rank" bucket carries no meaningful
    // rank value (the user's rank on a quiet day is not known).
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: utcDate(earlierIso), rank: 3, totalPlayers: 10 });
    expect(result[1]).toEqual({ date: utcDate(laterIso), rank: 2, totalPlayers: 10 });
  });

  it("takes last rank of day when multiple games per day (tz-aware)", () => {
    const id = seedScoredUser("alice", 5000);
    // Three timestamps all on the same recent UTC day (17:00–19:00),
    // all bucketing to the same PT day. Anchored 5 days back so the
    // lookback boundary is irrelevant.
    seedRankHistory(id, 5, 10, recentIsoUtc(5, 17));
    seedRankHistory(id, 3, 10, recentIsoUtc(5, 18));
    seedRankHistory(id, 4, 10, recentIsoUtc(5, 19));

    const result = getRankHistory(db, id, 30);
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(4); // last entry of the PT day
  });

  it("respects days parameter", () => {
    const id = seedScoredUser("alice", 5000);
    // Old entry outside window
    seedRankHistory(id, 5, 10, "2020-01-01T10:00:00Z");
    // Recent entry
    const today = new Date().toISOString();
    seedRankHistory(id, 2, 10, today);

    const result = getRankHistory(db, id, 7);
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(2);
  });

  it("returns empty for user with no rank history", () => {
    const id = seedScoredUser("alice", 5000);
    const result = getRankHistory(db, id, 30);
    expect(result).toEqual([]);
  });

  it("accepts a timeZone parameter and buckets to the caller's calendar day", () => {
    const id = seedScoredUser("alice", 5000);
    // 05:00 UTC yesterday = 21:00/22:00 PT day-before-yesterday.
    const anchor = new Date(Date.now() - 86400000);
    anchor.setUTCHours(5, 0, 0, 0);
    const iso = anchor.toISOString();
    const expectedPt = tzDateString(iso, ADMIN_TIMEZONE);
    expect(expectedPt).not.toBe(iso.slice(0, 10));

    seedRankHistory(id, 7, 100, iso);

    const pt = getRankHistory(db, id, 30, ADMIN_TIMEZONE);
    expect(pt.find((r) => r.date === expectedPt)).toEqual({
      date: expectedPt,
      rank: 7,
      totalPlayers: 100,
    });
  });
});

// ─── Zero-point exclusion (getLifetimeLeaderboard) ───

describe("getLifetimeLeaderboard — zero-point exclusion", () => {
  it("excludes users with lifetime_score = 0", () => {
    seedScoredUser("alice", 5000);
    seedScoredUser("zero-zelda", 0);
    seedScoredUser("bob", 3000);

    const result = getLifetimeLeaderboard(db);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.username)).toEqual(["alice", "bob"]);
  });

  it("returns empty list when every user has zero score", () => {
    seedScoredUser("a", 0);
    seedScoredUser("b", 0);

    const result = getLifetimeLeaderboard(db);

    expect(result).toEqual([]);
  });
});

// ─── getUserRank — zero-point consistency ───

describe("getUserRank — zero-point consistency", () => {
  it("returns coherent rank and totalPlayers when the user has zero score", () => {
    seedScoredUser("alice", 5000);
    seedScoredUser("bob", 3000);
    const zeroId = seedScoredUser("zero", 0);

    const result = getUserRank(db, zeroId);

    // Both halves of the rank math run against all active users, so the
    // response is always coherent even though the leaderboard view hides
    // zero-score users. rank must be ≤ totalPlayers.
    expect(result).not.toBeNull();
    expect(result!.totalPlayers).toBe(3);
    expect(result!.rank).toBeLessThanOrEqual(result!.totalPlayers);
  });

  it("counts all active users in totalPlayers, not just ranked ones", () => {
    seedScoredUser("alice", 5000);
    seedScoredUser("zero1", 0);
    seedScoredUser("zero2", 0);
    const bobId = seedScoredUser("bob", 3000);

    const result = getUserRank(db, bobId);

    expect(result!.rank).toBe(2);
    expect(result!.totalPlayers).toBe(4);
  });
});

// ─── getLongestStreakLeaderboard ───

/** Seed a user with explicit daily-streak values. */
function seedStreakUser(
  username: string,
  bestStreak: number,
  currentStreak: number,
  options?: { isActive?: boolean; lastDate?: string | null },
): string {
  const id = seedUser(db, username, `${username}@test.com`);
  // Default lastDate to today UTC so the streak counts as "alive" under
  // the read-time decay in getLongestStreakLeaderboard. Callers that
  // specifically want a stale or null lastDate pass it explicitly.
  const lastDate =
    options?.lastDate === undefined
      ? new Date().toISOString().slice(0, 10)
      : options.lastDate;
  db.prepare(
    "UPDATE users SET daily_streak_best = ?, daily_streak_current = ?, daily_streak_last_date = ? WHERE id = ?",
  ).run(bestStreak, currentStreak, lastDate, id);
  if (options?.isActive === false) {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(id);
  }
  return id;
}

describe("getLongestStreakLeaderboard", () => {
  it("returns users ordered by daily_streak_best DESC", () => {
    seedStreakUser("alice", 5, 2);
    seedStreakUser("bob", 10, 0);
    seedStreakUser("charlie", 7, 7);

    const result = getLongestStreakLeaderboard(db);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ rank: 1, username: "bob", longestStreak: 10, currentStreak: 0 });
    expect(result[1]).toMatchObject({ rank: 2, username: "charlie", longestStreak: 7, currentStreak: 7 });
    expect(result[2]).toMatchObject({ rank: 3, username: "alice", longestStreak: 5, currentStreak: 2 });
  });

  it("uses currentStreak as a tiebreaker for identical longest streaks", () => {
    seedStreakUser("alice", 10, 1);
    seedStreakUser("bob", 10, 5);

    const result = getLongestStreakLeaderboard(db);

    expect(result[0].username).toBe("bob");
    expect(result[1].username).toBe("alice");
  });

  it("excludes users with daily_streak_best = 0", () => {
    seedStreakUser("alice", 7, 2);
    seedStreakUser("zero", 0, 0);

    const result = getLongestStreakLeaderboard(db);

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("alice");
  });

  it("excludes inactive users", () => {
    seedStreakUser("alice", 7, 2);
    seedStreakUser("banned", 99, 10, { isActive: false });

    const result = getLongestStreakLeaderboard(db);

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("alice");
  });

  it("respects the limit argument and clamps to [1, 100]", () => {
    for (let i = 1; i <= 5; i++) {
      seedStreakUser(`user${i}`, i, 0);
    }

    expect(getLongestStreakLeaderboard(db, 3)).toHaveLength(3);
    // Non-positive limit clamps to 1
    expect(getLongestStreakLeaderboard(db, 0)).toHaveLength(1);
    expect(getLongestStreakLeaderboard(db, -5)).toHaveLength(1);
    // Over-cap limit clamps to 100 (we only have 5 here, so just verify <=100)
    expect(getLongestStreakLeaderboard(db, 999).length).toBeLessThanOrEqual(100);
  });

  it("surfaces the avatar field (or null) for each entry", () => {
    const id = seedStreakUser("alice", 5, 2);
    db.prepare("UPDATE users SET avatar = 'wizard' WHERE id = ?").run(id);
    seedStreakUser("bob", 3, 1);

    const result = getLongestStreakLeaderboard(db);
    expect(result.find((r) => r.username === "alice")?.avatar).toBe("wizard");
    expect(result.find((r) => r.username === "bob")?.avatar).toBeNull();
  });

  it("returns empty when no streaks exist", () => {
    expect(getLongestStreakLeaderboard(db)).toEqual([]);
  });

  // ─── Read-time decay mirrors getStreakForUser ───

  it("reports currentStreak=0 for users whose lastDate is older than yesterday", () => {
    seedStreakUser("alice", 5, 5, { lastDate: "2026-04-13" });
    seedStreakUser("bob", 3, 2, { lastDate: "2026-04-15" });

    const result = getLongestStreakLeaderboard(db, 20, "2026-04-16");

    const alice = result.find((r) => r.username === "alice");
    const bob = result.find((r) => r.username === "bob");
    expect(alice?.longestStreak).toBe(5);
    expect(alice?.currentStreak).toBe(0); // stale — missed 04-14, 04-15
    expect(bob?.longestStreak).toBe(3);
    expect(bob?.currentStreak).toBe(2); // fresh — played yesterday
  });

  it("uses decayed current as the tiebreaker so active streaks rank above stale ones", () => {
    // Both have best=10. Alice's streak is stale (last played 04-10); bob's
    // is live (last played yesterday). Bob should rank first even though
    // alice's stored current (7) is higher than bob's stored current (2).
    seedStreakUser("alice", 10, 7, { lastDate: "2026-04-10" });
    seedStreakUser("bob", 10, 2, { lastDate: "2026-04-15" });

    const result = getLongestStreakLeaderboard(db, 20, "2026-04-16");

    expect(result[0].username).toBe("bob");
    expect(result[0].currentStreak).toBe(2);
    expect(result[1].username).toBe("alice");
    expect(result[1].currentStreak).toBe(0);
  });
});
