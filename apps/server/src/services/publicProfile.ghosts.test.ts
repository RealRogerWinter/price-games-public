import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import {
  getLifetimeLeaderboard,
  getLongestStreakLeaderboard,
  getLeaderboardAvailability,
  getPeriodLeaderboard,
  getPublicPlayerProfile,
  getPublicScoreHistory,
  getPublicGameHistory,
} from "./publicProfile";
import { setGhostSettings } from "./ghostUsers/settings";

let db: DatabaseType;

function insertUser(opts: {
  username: string;
  lifetimeScore?: number;
  streakBest?: number;
  streakCurrent?: number;
  streakLastDate?: string | null;
}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash,
                        created_at, updated_at, is_active, lifetime_score,
                        daily_streak_current, daily_streak_best, daily_streak_last_date)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    opts.username.toLowerCase(),
    `${opts.username}@x.com`,
    now,
    now,
    opts.lifetimeScore ?? 0,
    opts.streakCurrent ?? 0,
    opts.streakBest ?? 0,
    opts.streakLastDate ?? null,
  );
  return id;
}

function insertGhost(opts: {
  username: string;
  lifetimeScore?: number;
  streakBest?: number;
  streakCurrent?: number;
  streakLastDate?: string | null;
  active?: number;
  accountCreatedAt?: string;
  lastPlayedAt?: string | null;
}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  // Default: ghost has played at least once. Tests for the never-played
  // ghost regression pass `lastPlayedAt: null` explicitly.
  const lastPlayedAt = opts.lastPlayedAt === undefined ? now : opts.lastPlayedAt;
  db.prepare(
    `INSERT INTO ghost_users
       (id, username, username_normalized, avatar, lifetime_score,
        account_created_at, on_shift, is_active, last_played_at,
        daily_streak_current, daily_streak_best, daily_streak_last_date,
        created_at, updated_at)
     VALUES (?, ?, ?, 'silhouette', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    opts.username.toLowerCase(),
    opts.lifetimeScore ?? 0,
    opts.accountCreatedAt ?? now,
    opts.active ?? 1,
    lastPlayedAt,
    opts.streakCurrent ?? 0,
    opts.streakBest ?? 0,
    opts.streakLastDate ?? null,
    now,
    now,
  );
  return id;
}

beforeEach(() => {
  db = createTestDb();
});

describe("getLifetimeLeaderboard with ghosts", () => {
  it("does NOT include ghosts when the visibility toggle is off (default)", () => {
    insertUser({ username: "real_alice", lifetimeScore: 5000 });
    insertGhost({ username: "ghost_bob", lifetimeScore: 8000 });
    const board = getLifetimeLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["real_alice"]);
  });

  it("interleaves ghost rows when showOnLeaderboard=true", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertUser({ username: "real_alice", lifetimeScore: 5000 });
    insertGhost({ username: "ghost_bob", lifetimeScore: 8000 });
    insertUser({ username: "real_carol", lifetimeScore: 3000 });
    const board = getLifetimeLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["ghost_bob", "real_alice", "real_carol"]);
  });

  it("excludes inactive ghosts even when toggle is on", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertGhost({ username: "active_one", lifetimeScore: 5000 });
    insertGhost({ username: "retired_one", lifetimeScore: 9000, active: 0 });
    const board = getLifetimeLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["active_one"]);
  });

  it("respects killSwitch — even with showOnLeaderboard=true, no ghosts visible", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true, killSwitch: true });
    insertUser({ username: "real_alice", lifetimeScore: 5000 });
    insertGhost({ username: "ghost_bob", lifetimeScore: 8000 });
    const board = getLifetimeLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["real_alice"]);
  });
});

describe("getLongestStreakLeaderboard with ghosts", () => {
  it("includes ghost streaks when toggle is on", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertUser({ username: "real_streak", lifetimeScore: 100, streakBest: 5 });
    insertGhost({ username: "ghost_streak", streakBest: 10 });
    const board = getLongestStreakLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["ghost_streak", "real_streak"]);
  });

  it("excludes ghost streaks by default", () => {
    insertUser({ username: "real_streak", lifetimeScore: 100, streakBest: 5 });
    insertGhost({ username: "ghost_streak", streakBest: 10 });
    const board = getLongestStreakLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["real_streak"]);
  });

  it("excludes ghosts with a streak but no game history (last_played_at IS NULL)", () => {
    // Regression: a ghost that has never been credited a game (so
    // last_played_at is NULL and ghost_game_history has zero rows) used
    // to surface on the streak board as "Longest Streak: 1" because the
    // synthetic streak advancement bumped daily_streak_best for every
    // active ghost. The leaderboard query now filters those rows out as
    // a defense-in-depth backstop in case stale data still exists.
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertUser({ username: "real_streak", lifetimeScore: 100, streakBest: 5 });
    insertGhost({ username: "ghost_no_history", streakBest: 1, lastPlayedAt: null });
    const board = getLongestStreakLeaderboard(db);
    expect(board.map((e) => e.username)).toEqual(["real_streak"]);
  });
});

describe("getPeriodLeaderboard with ghosts", () => {
  function insertUserHistory(userId: string, score: number, playedAt: string, gameType: "single" | "multiplayer" = "multiplayer") {
    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
       VALUES (?, ?, 'classic', ?, ?)`,
    ).run(userId, gameType, score, playedAt);
  }
  function insertGhostHistory(ghostId: string, score: number, playedAt: string, gameType: "multiplayer" = "multiplayer") {
    db.prepare(
      `INSERT INTO ghost_game_history (ghost_user_id, game_type, game_mode, score, played_at)
       VALUES (?, ?, 'classic', ?, ?)`,
    ).run(ghostId, gameType, score, playedAt);
  }

  it("does NOT include ghosts on the day board when toggle is off", () => {
    const userId = insertUser({ username: "real_alice", lifetimeScore: 5000 });
    const ghostId = insertGhost({ username: "ghost_eve", lifetimeScore: 5000 });
    const playedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    insertUserHistory(userId, 1000, playedAt);
    insertGhostHistory(ghostId, 2000, playedAt);

    const day = getPeriodLeaderboard(db, "day");
    expect(day.map((e) => e.username)).toEqual(["real_alice"]);
  });

  it("interleaves ghosts on the day board when toggle is on", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const userId = insertUser({ username: "real_alice", lifetimeScore: 5000 });
    const ghostId = insertGhost({ username: "ghost_eve", lifetimeScore: 5000 });
    const playedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    insertUserHistory(userId, 1000, playedAt);
    insertGhostHistory(ghostId, 2500, playedAt);

    const day = getPeriodLeaderboard(db, "day");
    expect(day.map((e) => e.username)).toEqual(["ghost_eve", "real_alice"]);
  });

  it("respects the period cutoff for ghosts (rows outside window excluded)", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const ghostId = insertGhost({ username: "ghost_eve", lifetimeScore: 5000 });
    // 5 days ago — outside the day window
    const oldPlay = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    insertGhostHistory(ghostId, 5000, oldPlay);

    const day = getPeriodLeaderboard(db, "day");
    expect(day.map((e) => e.username)).not.toContain("ghost_eve");
  });

  it("respects gameType filter for ghosts", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const ghostId = insertGhost({ username: "ghost_mp_only", lifetimeScore: 1000 });
    const playedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    insertGhostHistory(ghostId, 1000, playedAt, "multiplayer");

    const sp = getPeriodLeaderboard(db, "day", 50, 0, Date.now(), "sp");
    expect(sp.map((e) => e.username)).not.toContain("ghost_mp_only");

    const mp = getPeriodLeaderboard(db, "day", 50, 0, Date.now(), "mp");
    expect(mp.map((e) => e.username)).toContain("ghost_mp_only");
  });
});

describe("getLeaderboardAvailability with ghosts", () => {
  it("counts ghost contributors in the 'all' pill when visible", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertUser({ username: "u1", lifetimeScore: 5000 });
    insertGhost({ username: "g1", lifetimeScore: 3000 });
    insertGhost({ username: "g2", lifetimeScore: 1000 });
    const availability = getLeaderboardAvailability(db);
    expect(availability.all).toBe(3);
  });

  it("does not count ghosts when toggle is off", () => {
    insertUser({ username: "u1", lifetimeScore: 5000 });
    insertGhost({ username: "g1", lifetimeScore: 3000 });
    const availability = getLeaderboardAvailability(db);
    expect(availability.all).toBe(1);
  });
});

describe("getPublicPlayerProfile with ghosts", () => {
  it("returns null for a ghost username when toggle is off (system-dark UX)", () => {
    insertGhost({ username: "ghost_ann", lifetimeScore: 1000 });
    expect(getPublicPlayerProfile(db, "ghost_ann")).toBeNull();
  });

  it("returns a full profile for a ghost username when toggle is on", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const ghostId = insertGhost({
      username: "ghost_ann",
      lifetimeScore: 4500,
      accountCreatedAt: "2025-12-01T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO ghost_game_history
         (ghost_user_id, game_type, game_mode, score, placement, players_count, played_at)
       VALUES (?, 'multiplayer', 'classic', 100, 1, 4, ?)`,
    ).run(ghostId, new Date().toISOString());

    const profile = getPublicPlayerProfile(db, "ghost_ann");
    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("ghost_ann");
    expect(profile!.lifetimeScore).toBe(4500);
    expect(profile!.totalGames).toBe(1);
    expect(profile!.bestScore).toBe(100);
    expect(profile!.gamesByMode).toEqual({ classic: 1 });
    expect(profile!.multiplayerWins).toBe(1);
    expect(profile!.memberSince).toBe("2025-12-01");
  });

  it("real users still resolve correctly when toggle is on", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    insertUser({ username: "real_dan", lifetimeScore: 7000 });
    const profile = getPublicPlayerProfile(db, "real_dan");
    expect(profile?.username).toBe("real_dan");
    expect(profile?.lifetimeScore).toBe(7000);
  });
});

describe("getPublicGameHistory + getPublicScoreHistory with ghosts", () => {
  it("returns ghost game history when ghost is visible", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const ghostId = insertGhost({ username: "ghost_eve", lifetimeScore: 2000 });
    const playedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO ghost_game_history
         (ghost_user_id, game_type, game_mode, score, placement, players_count, played_at)
       VALUES (?, 'multiplayer', 'classic', 250, 2, 4, ?)`,
    ).run(ghostId, playedAt);

    const history = getPublicGameHistory(db, "ghost_eve");
    expect(history.total).toBe(1);
    expect(history.entries[0].score).toBe(250);
    expect(history.entries[0].gameMode).toBe("classic");
  });

  it("getPublicScoreHistory returns a padded series for a visible ghost", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    const ghostId = insertGhost({ username: "ghost_fay", lifetimeScore: 100 });
    db.prepare(
      `INSERT INTO ghost_game_history
         (ghost_user_id, game_type, game_mode, score, played_at)
       VALUES (?, 'multiplayer', 'classic', 100, ?)`,
    ).run(ghostId, new Date().toISOString());

    const series = getPublicScoreHistory(db, "ghost_fay", 7);
    expect(series).toHaveLength(7);
    const totalScore = series.reduce((acc, d) => acc + d.totalScore, 0);
    expect(totalScore).toBe(100);
  });

  it("returns empty when ghost is invisible (toggle off)", () => {
    insertGhost({ username: "ghost_gus", lifetimeScore: 100 });
    expect(getPublicGameHistory(db, "ghost_gus").entries).toEqual([]);
    expect(getPublicScoreHistory(db, "ghost_gus", 7)).toEqual([]);
  });
});
