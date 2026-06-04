/**
 * Tests for the admin user management service.
 *
 * Covers CRUD operations, pagination, search, filtering, sorting,
 * deactivation/reactivation, password resets, game history, stats, and activity.
 */

import { describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  listUsers,
  getUserById,
  updateUser,
  deleteUser,
  deactivateUser,
  reactivateUser,
  forceResetPassword,
  getUserGameHistoryPaginated,
  getUserStatsById,
  getUserActivity,
} from "./adminUsers";
import { tzDateString, ADMIN_TIMEZONE } from "@price-game/shared";

/**
 * Test helper: insert a referral row directly so tests can construct any
 * status/rejection-reason combination without invoking the production
 * IP-match / disposable-email logic.
 */
function insertReferral(
  db: DatabaseType,
  opts: {
    referrerId: string;
    referredId: string;
    status: "pending" | "credited" | "rejected";
    rejectionReason?: string;
    code?: string;
    createdAt?: string;
  },
): string {
  const id = uuidv4();
  const code = opts.code ?? id.slice(0, 8).toUpperCase().replace(/-/g, "A");
  const createdAt = opts.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO referrals
       (id, referrer_id, referred_id, referral_code, status, rejection_reason, created_at, credited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.referrerId,
    opts.referredId,
    code,
    opts.status,
    opts.rejectionReason ?? null,
    createdAt,
    opts.status === "credited" ? createdAt : null,
  );
  return id;
}

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ── listUsers ───────────────────────────────────────────────────────────────

describe("listUsers", () => {
  it("returns paginated user list with correct shape", () => {
    seedUser(db, "alice", "alice@example.com");
    seedUser(db, "bob", "bob@example.com");
    seedUser(db, "charlie", "charlie@example.com");

    const result = listUsers(db, { page: 1, pageSize: 2 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.users).toHaveLength(2);
    // Each user should have the expected properties
    const user = result.users[0];
    expect(user).toHaveProperty("id");
    expect(user).toHaveProperty("username");
    expect(user).toHaveProperty("email");
    expect(user).toHaveProperty("isActive");
    expect(user).toHaveProperty("lifetimeScore");
    expect(user).toHaveProperty("createdAt");
    expect(user).toHaveProperty("totalGames");
  });

  it("supports search by username", () => {
    seedUser(db, "alice", "alice@example.com");
    seedUser(db, "bob", "bob@example.com");

    const result = listUsers(db, { search: "alice" });

    expect(result.total).toBe(1);
    expect(result.users[0].username).toBe("alice");
  });

  it("supports search by email", () => {
    seedUser(db, "alice", "alice@test.com");
    seedUser(db, "bob", "bob@other.com");

    const result = listUsers(db, { search: "other.com" });

    expect(result.total).toBe(1);
    expect(result.users[0].email).toBe("bob@other.com");
  });

  it("filters by isActive", () => {
    const aliceId = seedUser(db, "alice", "alice@example.com");
    seedUser(db, "bob", "bob@example.com");
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(aliceId);

    const active = listUsers(db, { isActive: true });
    expect(active.total).toBe(1);
    expect(active.users[0].username).toBe("bob");

    const inactive = listUsers(db, { isActive: false });
    expect(inactive.total).toBe(1);
    expect(inactive.users[0].username).toBe("alice");
  });

  it("supports sortBy and sortOrder", () => {
    const aliceId = seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, aliceId);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, bobId);

    const desc = listUsers(db, { sortBy: "lifetime_score", sortOrder: "desc" });
    expect(desc.users[0].username).toBe("bob");
    expect(desc.users[1].username).toBe("alice");

    const asc = listUsers(db, { sortBy: "lifetime_score", sortOrder: "asc" });
    expect(asc.users[0].username).toBe("alice");
    expect(asc.users[1].username).toBe("bob");
  });

  it("returns totalGames count per user", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 200, ?)",
    ).run(userId, now);
    // Mirror production: bump cached total_games (PR1 perf F2). The column
    // is the source of truth post-rewrite; seed helpers that bypass the
    // production record-game path must keep it in sync.
    db.prepare("UPDATE users SET total_games = total_games + 2 WHERE id = ?").run(userId);

    const result = listUsers(db, {});
    const alice = result.users.find((u) => u.username === "alice");
    expect(alice).toBeDefined();
    expect(alice!.totalGames).toBe(2);
  });

  it("returns empty list when no users exist", () => {
    const result = listUsers(db, {});
    expect(result.users).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it("returns referral counts per user (credited + total)", () => {
    const aliceId = seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");
    const carolId = seedUser(db, "carol", "carol@example.com");

    // Alice has 2 credited + 1 pending = 3 total. Bob has 0. Carol has 1 rejected.
    insertReferral(db, { referrerId: aliceId, referredId: bobId, status: "credited" });
    insertReferral(db, { referrerId: aliceId, referredId: carolId, status: "credited" });
    const danId = seedUser(db, "dan", "dan@example.com");
    insertReferral(db, { referrerId: aliceId, referredId: danId, status: "pending" });
    const eveId = seedUser(db, "eve", "eve@example.com");
    insertReferral(db, {
      referrerId: carolId,
      referredId: eveId,
      status: "rejected",
      rejectionReason: "ip_match",
    });

    const result = listUsers(db, {});
    const alice = result.users.find((u) => u.username === "alice")!;
    const bob = result.users.find((u) => u.username === "bob")!;
    const carol = result.users.find((u) => u.username === "carol")!;

    expect(alice.creditedReferrals).toBe(2);
    expect(alice.totalReferrals).toBe(3);
    expect(bob.creditedReferrals).toBe(0);
    expect(bob.totalReferrals).toBe(0);
    expect(carol.creditedReferrals).toBe(0);
    expect(carol.totalReferrals).toBe(1);
  });

  it("supports sorting by referrals (credited)", () => {
    const aliceId = seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");
    const carolId = seedUser(db, "carol", "carol@example.com");
    const danId = seedUser(db, "dan", "dan@example.com");

    insertReferral(db, { referrerId: bobId, referredId: aliceId, status: "credited" });
    insertReferral(db, { referrerId: bobId, referredId: carolId, status: "credited" });
    insertReferral(db, { referrerId: bobId, referredId: danId, status: "credited" });
    insertReferral(db, { referrerId: aliceId, referredId: bobId, status: "credited" });

    const desc = listUsers(db, { sortBy: "referrals", sortOrder: "desc" });
    expect(desc.users[0].username).toBe("bob");

    const asc = listUsers(db, { sortBy: "referrals", sortOrder: "asc" });
    // Carol & Dan tie at 0; Bob is highest at last position
    expect(asc.users[asc.users.length - 1].username).toBe("bob");
  });
});

// ── getUserById ─────────────────────────────────────────────────────────────

describe("getUserById", () => {
  it("returns user details for a valid id", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const user = getUserById(db, userId);

    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
    expect(user!.username).toBe("alice");
    expect(user!.email).toBe("alice@example.com");
    expect(user!.isActive).toBe(true);
    expect(user!.emailVerified).toBeDefined();
    expect(user!.updatedAt).toBeDefined();
  });

  it("returns null for a non-existent id", () => {
    const result = getUserById(db, "non-existent-id");
    expect(result).toBeNull();
  });

  it("returns referral counts for the user", () => {
    const aliceId = seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");
    insertReferral(db, { referrerId: aliceId, referredId: bobId, status: "credited" });

    const detail = getUserById(db, aliceId);
    expect(detail).not.toBeNull();
    expect(detail!.creditedReferrals).toBe(1);
    expect(detail!.totalReferrals).toBe(1);
  });
});

// ── updateUser ──────────────────────────────────────────────────────────────

describe("updateUser", () => {
  it("updates username", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const updated = updateUser(db, userId, { username: "alice_new" });

    expect(updated).not.toBeNull();
    expect(updated!.username).toBe("alice_new");
  });

  it("updates email", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const updated = updateUser(db, userId, { email: "newalice@example.com" });

    expect(updated).not.toBeNull();
    expect(updated!.email).toBe("newalice@example.com");
  });

  it("rejects duplicate username", () => {
    seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");

    expect(() => updateUser(db, bobId, { username: "alice" })).toThrow(
      /username.*already.*taken/i,
    );
  });

  it("rejects duplicate email", () => {
    seedUser(db, "alice", "alice@example.com");
    const bobId = seedUser(db, "bob", "bob@example.com");

    expect(() => updateUser(db, bobId, { email: "alice@example.com" })).toThrow(
      /email.*already.*use/i,
    );
  });

  it("returns null for non-existent user", () => {
    const result = updateUser(db, "non-existent-id", { username: "ghost" });
    expect(result).toBeNull();
  });
});

// ── deleteUser ──────────────────────────────────────────────────────────────

describe("deleteUser", () => {
  it("deletes user and all related data", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();

    // Insert related data
    db.prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, now, future, now);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO user_rewards (id, user_id, reward_type, status, earned_at) VALUES (?, ?, 'badge', 'active', ?)",
    ).run(uuidv4(), userId, now);

    const result = deleteUser(db, userId);

    expect(result).toBe(true);

    // Verify user and related data are gone
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    expect(user).toBeUndefined();
    const sessions = db.prepare("SELECT * FROM user_sessions WHERE user_id = ?").all(userId);
    expect(sessions).toHaveLength(0);
    const history = db.prepare("SELECT * FROM user_game_history WHERE user_id = ?").all(userId);
    expect(history).toHaveLength(0);
    const rewards = db.prepare("SELECT * FROM user_rewards WHERE user_id = ?").all(userId);
    expect(rewards).toHaveLength(0);
  });

  it("returns false for non-existent user", () => {
    const result = deleteUser(db, "non-existent-id");
    expect(result).toBe(false);
  });

  it("also deletes sessions, game history, rewards, product views, and tokens", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();

    // Seed products so foreign key is satisfied for product views
    db.prepare(
      "INSERT INTO products (id, title, price_cents, is_active) VALUES (1, 'Widget', 999, 1)",
    ).run();

    db.prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, now, future, now);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO user_rewards (id, user_id, reward_type, status, earned_at) VALUES (?, ?, 'badge', 'active', ?)",
    ).run(uuidv4(), userId, now);
    db.prepare(
      "INSERT INTO user_product_views (user_id, product_id, session_id, seen_at) VALUES (?, 1, 'sess-1', ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO email_verification_tokens (id, user_id, token, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, "tok-1", "alice@example.com", now, future);
    db.prepare(
      "INSERT INTO password_reset_tokens (id, user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, "reset-1", now, future);
    db.prepare(
      "INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(userId, "daily-sess-1", "2026-04-15", "classic", 750, now, now);
    db.prepare(
      "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
    ).run(userId, 42, 1000, now);

    deleteUser(db, userId);

    expect(db.prepare("SELECT COUNT(*) as c FROM user_sessions WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM user_game_history WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM user_rewards WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM user_product_views WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM email_verification_tokens WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM password_reset_tokens WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM daily_plays WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM user_rank_history WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
  });

  it("deletes a user who has completed daily challenges (regression for FK 500 error)", () => {
    const userId = seedUser(db, "carol", "carol@example.com");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(userId, "daily-sess-c", "2026-04-14", "classic", 500, now, now);

    const result = deleteUser(db, userId);
    expect(result).toBe(true);
    expect(db.prepare("SELECT COUNT(*) as c FROM daily_plays WHERE user_id = ?").get(userId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) as c FROM users WHERE id = ?").get(userId)).toEqual({ c: 0 });
  });
});

// ── deactivateUser / reactivateUser ─────────────────────────────────────────

describe("deactivateUser", () => {
  it("sets is_active to 0 and destroys sessions", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();
    db.prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, now, future, now);

    const result = deactivateUser(db, userId);

    expect(result).not.toBeNull();
    expect(result!.isActive).toBe(false);
    const sessions = db.prepare("SELECT * FROM user_sessions WHERE user_id = ?").all(userId);
    expect(sessions).toHaveLength(0);
  });

  it("returns null for non-existent user", () => {
    const result = deactivateUser(db, "non-existent-id");
    expect(result).toBeNull();
  });
});

describe("reactivateUser", () => {
  it("sets is_active to 1", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(userId);

    const result = reactivateUser(db, userId);

    expect(result).not.toBeNull();
    expect(result!.isActive).toBe(true);
  });

  it("returns null for non-existent user", () => {
    const result = reactivateUser(db, "non-existent-id");
    expect(result).toBeNull();
  });
});

// ── forceResetPassword ──────────────────────────────────────────────────────

describe("forceResetPassword", () => {
  it("returns a temporary password string", () => {
    const userId = seedUser(db, "alice", "alice@example.com", "originalpass");

    const tempPassword = forceResetPassword(db, userId);

    expect(tempPassword).not.toBeNull();
    expect(typeof tempPassword).toBe("string");
    expect(tempPassword!.length).toBe(16);
  });

  it("changes the password hash so the old password no longer works", () => {
    const userId = seedUser(db, "alice", "alice@example.com", "originalpass");
    const oldRow = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };

    forceResetPassword(db, userId);

    const newRow = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    expect(newRow.password_hash).not.toBe(oldRow.password_hash);

    // Old password should not match the new hash
    expect(bcrypt.compareSync("originalpass", newRow.password_hash)).toBe(false);
  });

  it("destroys all user sessions", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();
    db.prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, now, future, now);
    db.prepare(
      "INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run(uuidv4(), userId, now, future, now);

    forceResetPassword(db, userId);

    const sessions = db.prepare("SELECT * FROM user_sessions WHERE user_id = ?").all(userId);
    expect(sessions).toHaveLength(0);
  });

  it("returns null for non-existent user", () => {
    const result = forceResetPassword(db, "non-existent-id");
    expect(result).toBeNull();
  });
});

// ── getUserGameHistoryPaginated ─────────────────────────────────────────────

describe("getUserGameHistoryPaginated", () => {
  it("returns paginated game history", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', ?, ?)",
      ).run(userId, 100 * (i + 1), now);
    }

    const result = getUserGameHistoryPaginated(db, userId, 1, 3);

    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.history).toHaveLength(3);
    // Each entry should have the expected shape
    const entry = result.history[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("gameType");
    expect(entry).toHaveProperty("gameMode");
    expect(entry).toHaveProperty("score");
    expect(entry).toHaveProperty("playedAt");
  });

  it("returns empty for user with no games", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const result = getUserGameHistoryPaginated(db, userId, 1, 10);

    expect(result.total).toBe(0);
    expect(result.history).toHaveLength(0);
    expect(result.totalPages).toBe(0);
  });
});

// ── getUserStatsById ────────────────────────────────────────────────────────

describe("getUserStatsById", () => {
  it("returns aggregate stats", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 300, ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'higher-lower', 500, ?)",
    ).run(userId, now);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, placement, players_count, played_at) VALUES (?, 'multiplayer', 'classic', 700, 1, 4, ?)",
    ).run(userId, now);

    const stats = getUserStatsById(db, userId);

    expect(stats.totalGames).toBe(3);
    expect(stats.totalScore).toBe(1500);
    expect(stats.bestScore).toBe(700);
    expect(stats.averageScore).toBe(500);
    expect(stats.gamesByMode).toEqual({ classic: 2, "higher-lower": 1 });
    expect(stats.multiplayerWins).toBe(1);
  });

  it("returns zero stats for user with no games", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const stats = getUserStatsById(db, userId);

    expect(stats.totalGames).toBe(0);
    expect(stats.totalScore).toBe(0);
    expect(stats.bestScore).toBe(0);
    expect(stats.averageScore).toBe(0);
    expect(stats.gamesByMode).toEqual({});
    expect(stats.multiplayerWins).toBe(0);
  });
});

// ── getUserActivity ─────────────────────────────────────────────────────────

describe("getUserActivity", () => {
  it("returns daily game counts within the specified range", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    // Use "now" for both the seed row and the expected bucket. An earlier
    // revision hard-coded 20:00 UTC to sit in PT mid-afternoon, but that's
    // only true when UTC-today and PT-today agree; in the UTC/PT day
    // boundary window (~00:00-08:00 UTC), UTC-today 20:00 is a PT date
    // that's in the future relative to padDateSeries's PT-today anchor,
    // and the row falls outside the window. Using `new Date()` for both
    // sides keeps the two timestamps agreeing on the same PT day.
    const todayIso = new Date().toISOString();
    const expectedDate = tzDateString(todayIso, ADMIN_TIMEZONE);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, todayIso);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 200, ?)",
    ).run(userId, todayIso);

    const activity = getUserActivity(db, userId, 7);

    // Zero-fill guarantees exactly `days` entries.
    expect(activity.length).toBe(7);
    const todayEntry = activity.find((a) => a.date === expectedDate);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.gamesPlayed).toBe(2);
  });

  it("returns a zero-filled window when the user has no games", () => {
    const userId = seedUser(db, "alice", "alice@example.com");

    const activity = getUserActivity(db, userId, 7);

    expect(activity.length).toBe(7);
    expect(activity.every((a) => a.gamesPlayed === 0)).toBe(true);
  });

  it("buckets a late-evening PT game into the PT calendar day, not the UTC day (titi bug)", () => {
    // This is the regression test for the user-reported bug: titi had
    // games at ~23:30 PT on 4/9, which is ~06:30 UTC on 4/10. The old
    // implementation used SQLite's UTC DATE() and showed those games on
    // 4/10 in the admin activity chart, while the adjacent "last played"
    // timestamp (rendered in browser local time) showed 4/9. This test
    // locks in PT-bucketing: pick a recent-ish date to stay inside the
    // 30-day window and assert the game lands on the PT day.
    const userId = seedUser(db, "titi", "titi@example.com");

    // Build a timestamp for "yesterday 23:30 PT". tzDateString tells us
    // what PT calendar day a given ISO lands in, so we can reason about
    // expected buckets without hardcoding PST/PDT offsets.
    const anchor = new Date(Date.now() - 86400000); // rough yesterday
    // Snap to 05:00 UTC to guarantee we sit firmly in the UTC->previous-PT
    // day zone regardless of DST — 22:00 PDT or 21:00 PST the previous
    // day. Seven UTC is the exact PDT midnight boundary, so we pick a
    // couple hours earlier for an unambiguous fixture. The UTC day of
    // the timestamp remains "yesterday UTC" while the PT day is
    // "yesterday-1 PT", ensuring the two disagree and the sanity check
    // below is a non-trivial assertion.
    anchor.setUTCHours(5, 0, 0, 0);
    const iso = anchor.toISOString();

    const expectedPtDay = tzDateString(iso, ADMIN_TIMEZONE);
    const expectedUtcDay = iso.slice(0, 10);
    // Sanity: the fixture is only interesting if PT and UTC disagree.
    expect(expectedPtDay).not.toBe(expectedUtcDay);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, iso);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 200, ?)",
    ).run(userId, iso);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 300, ?)",
    ).run(userId, iso);

    const activity = getUserActivity(db, userId, 30, ADMIN_TIMEZONE);

    const ptEntry = activity.find((a) => a.date === expectedPtDay);
    expect(ptEntry).toBeDefined();
    expect(ptEntry!.gamesPlayed).toBe(3);

    // And conversely: the UTC day must NOT contain the games (proof
    // the old DATE() path is gone). If the UTC day happens to exist in
    // the window it should have 0 games; if it's outside the window it
    // shouldn't exist at all.
    const utcEntry = activity.find((a) => a.date === expectedUtcDay);
    if (utcEntry) {
      expect(utcEntry.gamesPlayed).toBe(0);
    }
  });

  it("accepts a custom timezone for day bucketing", () => {
    const userId = seedUser(db, "tokyouser", "tokyo@example.com");
    // 16:00 UTC yesterday = morning PT yesterday, next day Tokyo. Using
    // yesterday avoids the "test runs before 16:00 UTC" edge case where a
    // same-day anchor could land in the future and fall outside the
    // window for the Tokyo timezone.
    const anchor = new Date(Date.now() - 86400000);
    anchor.setUTCHours(16, 0, 0, 0);
    const iso = anchor.toISOString();
    const expectedPt = tzDateString(iso, ADMIN_TIMEZONE);
    const expectedJst = tzDateString(iso, "Asia/Tokyo");
    expect(expectedPt).not.toBe(expectedJst);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'single', 'classic', 100, ?)",
    ).run(userId, iso);

    const pt = getUserActivity(db, userId, 30, ADMIN_TIMEZONE);
    expect(pt.find((a) => a.date === expectedPt)?.gamesPlayed).toBe(1);

    const jst = getUserActivity(db, userId, 30, "Asia/Tokyo");
    expect(jst.find((a) => a.date === expectedJst)?.gamesPlayed).toBe(1);
  });

  it("clamps `days` to [1, 365]", () => {
    const userId = seedUser(db, "alice", "alice@example.com");
    expect(getUserActivity(db, userId, 0).length).toBe(1);
    expect(getUserActivity(db, userId, 9999).length).toBe(365);
  });
});
