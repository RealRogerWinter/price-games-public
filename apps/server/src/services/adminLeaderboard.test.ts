/**
 * Tests for the admin leaderboard moderation service.
 *
 * Hits the in-memory test db directly (no HTTP layer); route-level
 * coverage lives in `routes/adminLeaderboard.test.ts`.
 *
 * The moderation panel sources rows from `user_game_history` — every
 * registered-user game played, the same source the public v2 board
 * reads from. Anonymous games never reach this table, so the panel
 * shows exactly the rows that contribute to a player's leaderboard
 * standing. Tests seed via `seedEntry` (inserts into
 * `user_game_history` and bumps `users.lifetime_score`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  listEntries,
  excludeEntry,
  restoreEntry,
  bulkExcludeEntries,
  getUserSummary,
  banUser,
  unbanUser,
  banUserHistory,
  setTestAccountFlag,
  listBannedUsers,
  listAuditLog,
  getStats,
} from "./adminLeaderboard";

const ADMIN = { id: "admin-1", username: "alice" };

/**
 * Insert a user_game_history row and bump the user's lifetime_score
 * by the row's score. Mirrors the production write path
 * (`recordSinglePlayerGame`) so test seeds and live data have the same
 * lifetime_score / row-sum invariant.
 */
function seedEntry(
  db: DatabaseType,
  opts: {
    userId: string;
    score: number;
    mode?: string;
    gameType?: "single" | "multiplayer";
    playedAt?: string;
    sessionId?: string;
    roomCode?: string;
    placement?: number;
    playersCount?: number;
    isWin?: 0 | 1 | null;
  },
): number {
  const gameType = opts.gameType ?? "single";
  const sessionId =
    gameType === "single"
      ? opts.sessionId ?? `s-${opts.userId}-${opts.score}`
      : null;
  const roomCode = gameType === "multiplayer" ? opts.roomCode ?? `R${opts.score}` : null;
  const isWin = opts.isWin === undefined ? null : opts.isWin;
  const result = db
    .prepare(
      `INSERT INTO user_game_history
        (user_id, game_type, game_mode, session_id, room_code,
         score, placement, players_count, played_at, is_win)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.userId,
      gameType,
      opts.mode ?? "classic",
      sessionId,
      roomCode,
      opts.score,
      opts.placement ?? null,
      opts.playersCount ?? null,
      opts.playedAt ?? "2026-01-01T00:00:00Z",
      isWin,
    );
  // Mirror production: bump cached lifetime_score AND total_games together
  // (PR1 perf F2). Production callers do this inside the transaction with
  // the INSERT; the seed helper is per-row so a separate UPDATE is fine.
  db.prepare(
    "UPDATE users SET lifetime_score = lifetime_score + ?, total_games = total_games + 1 WHERE id = ?",
  ).run(opts.score, opts.userId);
  if (isWin === 1) {
    db.prepare("UPDATE users SET lifetime_wins = lifetime_wins + 1 WHERE id = ?").run(opts.userId);
  } else if (isWin === 0) {
    db.prepare("UPDATE users SET lifetime_losses = lifetime_losses + 1 WHERE id = ?").run(opts.userId);
  }
  return Number(result.lastInsertRowid);
}

let db: DatabaseType;
let aliceId: string;
let bobId: string;

beforeEach(() => {
  db = createTestDb();
  aliceId = seedUser(db, "alice", "alice@example.com");
  bobId = seedUser(db, "bob", "bob@example.com");
  // alice: two SP rows (8000 classic + 7000 higher-lower); lifetime_score=15000
  seedEntry(db, { userId: aliceId, score: 8000 });
  seedEntry(db, { userId: aliceId, score: 7000, mode: "higher-lower" });
  // bob: one SP row (9500); lifetime_score=9500
  seedEntry(db, { userId: bobId, score: 9500 });
  // a 3rd user with a multiplayer row, to cover the MP code path
  const carolId = seedUser(db, "carol", "carol@example.com");
  seedEntry(db, {
    userId: carolId,
    score: 5000,
    gameType: "multiplayer",
    placement: 1,
    playersCount: 4,
  });
});

describe("listEntries", () => {
  it("returns all entries by default with total count", () => {
    const result = listEntries(db);
    expect(result.total).toBe(4);
    expect(result.entries.length).toBe(4);
    // default sort: score DESC
    expect(result.entries[0].score).toBe(9500);
  });

  it("filters by mode", () => {
    const result = listEntries(db, { mode: "higher-lower" });
    expect(result.total).toBe(1);
    expect(result.entries[0].username).toBe("alice");
  });

  it("filters by score range", () => {
    const result = listEntries(db, { scoreMin: 6000, scoreMax: 8500 });
    expect(result.total).toBe(2);
  });

  it("filters by username search", () => {
    const result = listEntries(db, { search: "ali" });
    expect(result.total).toBe(2);
  });

  it("paginates", () => {
    const page1 = listEntries(db, { limit: 2, offset: 0 });
    const page2 = listEntries(db, { limit: 2, offset: 2 });
    expect(page1.entries.length).toBe(2);
    expect(page2.entries.length).toBe(2);
    expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
  });

  it("hides excluded entries when status=active", () => {
    const target = listEntries(db).entries[0];
    excludeEntry(db, target.id, ADMIN, "duplicate");
    const active = listEntries(db, { status: "active" });
    expect(active.entries.find((e) => e.id === target.id)).toBeUndefined();
    expect(active.total).toBe(3);
  });

  it("shows only excluded entries when status=excluded", () => {
    const target = listEntries(db).entries[0];
    excludeEntry(db, target.id, ADMIN, "duplicate");
    const excluded = listEntries(db, { status: "excluded" });
    expect(excluded.total).toBe(1);
    expect(excluded.entries[0].id).toBe(target.id);
    expect(excluded.entries[0].isExcluded).toBe(true);
  });

  it("surfaces user ban + test-flag state on entries", () => {
    banUser(db, aliceId, ADMIN, { reason: "cheating" });
    setTestAccountFlag(db, bobId, true, ADMIN);
    const result = listEntries(db);
    const aliceRow = result.entries.find((e) => e.userId === aliceId)!;
    const bobRow = result.entries.find((e) => e.userId === bobId)!;
    expect(aliceRow.userBanned).toBe(true);
    expect(bobRow.userIsTest).toBe(true);
  });

  it("every entry has a userId + username (no NULL-user_id orphans like the legacy table)", () => {
    const result = listEntries(db);
    expect(result.entries.every((e) => typeof e.userId === "string" && e.userId.length > 0)).toBe(true);
    expect(result.entries.every((e) => typeof e.username === "string" && e.username.length > 0)).toBe(true);
    expect(result.entries.every((e) => e.username === e.playerName)).toBe(true);
  });

  it("surfaces game type, sessionId / room code, placement, and players_count for MP rows", () => {
    const mp = listEntries(db).entries.find((e) => e.gameType === "multiplayer")!;
    expect(mp.sessionId).toMatch(/^R/);
    expect(mp.placement).toBe(1);
    expect(mp.playersCount).toBe(4);
  });
});

describe("excludeEntry / restoreEntry", () => {
  it("requires a non-empty reason", () => {
    const id = listEntries(db).entries[0].id;
    expect(() => excludeEntry(db, id, ADMIN, "  ")).toThrow();
  });

  it("returns null when entry doesn't exist", () => {
    expect(excludeEntry(db, 99999, ADMIN, "any")).toBeNull();
  });

  it("soft-excludes and writes an audit row", () => {
    const id = listEntries(db).entries[0].id;
    const updated = excludeEntry(db, id, ADMIN, "duplicate")!;
    expect(updated.isExcluded).toBe(true);
    expect(updated.excludedReason).toBe("duplicate");
    const audit = listAuditLog(db, { action: "exclude_entry" });
    expect(audit.entries.length).toBe(1);
    expect(audit.entries[0].targetId).toBe(String(id));
    expect(audit.entries[0].adminUsername).toBe("alice");
  });

  it("decrements users.lifetime_score by the row's score on exclude, restores on restore", () => {
    // pick a known row: alice's 8000 classic
    const target = listEntries(db).entries.find(
      (e) => e.userId === aliceId && e.score === 8000,
    )!;

    const before = db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number };
    expect(before.s).toBe(15000);

    excludeEntry(db, target.id, ADMIN, "cheater");
    const afterExclude = db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number };
    expect(afterExclude.s).toBe(15000 - 8000);

    restoreEntry(db, target.id, ADMIN);
    const afterRestore = db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number };
    expect(afterRestore.s).toBe(15000);
  });

  it("decrements lifetime_wins / lifetime_losses on exclude and re-credits on restore", () => {
    // A new entry seeded with is_win=1; lifetime_wins should track it
    // through the exclude/restore cycle.
    const winEntryId = seedEntry(db, {
      userId: aliceId,
      score: 9500,
      mode: "classic",
      sessionId: "win-entry",
      isWin: 1,
    });
    const lossEntryId = seedEntry(db, {
      userId: aliceId,
      score: 200,
      mode: "classic",
      sessionId: "loss-entry",
      isWin: 0,
    });

    let row = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(aliceId) as { lifetime_wins: number; lifetime_losses: number };
    expect(row.lifetime_wins).toBe(1);
    expect(row.lifetime_losses).toBe(1);

    excludeEntry(db, winEntryId, ADMIN, "duplicate");
    excludeEntry(db, lossEntryId, ADMIN, "duplicate");
    row = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(aliceId) as { lifetime_wins: number; lifetime_losses: number };
    expect(row.lifetime_wins).toBe(0);
    expect(row.lifetime_losses).toBe(0);

    restoreEntry(db, winEntryId, ADMIN);
    restoreEntry(db, lossEntryId, ADMIN);
    row = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(aliceId) as { lifetime_wins: number; lifetime_losses: number };
    expect(row.lifetime_wins).toBe(1);
    expect(row.lifetime_losses).toBe(1);
  });

  it("does not touch W/L counters when the excluded row has is_win=NULL", () => {
    // Entry with no recorded outcome (legacy / pre-migration / skipped).
    const id = seedEntry(db, {
      userId: aliceId,
      score: 500,
      mode: "classic",
      sessionId: "null-outcome",
      isWin: null,
    });

    excludeEntry(db, id, ADMIN, "cleanup");
    const row = db
      .prepare("SELECT lifetime_wins, lifetime_losses FROM users WHERE id = ?")
      .get(aliceId) as { lifetime_wins: number; lifetime_losses: number };
    // Alice's seeded baseline is 0/0 (her seedEntry calls didn't set isWin),
    // so the counters stay flat.
    expect(row.lifetime_wins).toBe(0);
    expect(row.lifetime_losses).toBe(0);
  });

  it("keeps users.total_games in lock-step with the leaderboard query's row count", () => {
    // PR1 perf F2: the cached total_games column drives the lifetime
    // leaderboard's totalGames field instead of LEFT JOINing
    // user_game_history. Excluding a row must decrement; restoring must
    // re-credit. Drift between this column and the join would silently
    // misreport on the leaderboard.
    const target = listEntries(db).entries.find(
      (e) => e.userId === aliceId && e.score === 8000,
    )!;

    const before = db
      .prepare("SELECT total_games AS n FROM users WHERE id = ?")
      .get(aliceId) as { n: number };
    expect(before.n).toBe(2); // alice has 2 SP rows

    excludeEntry(db, target.id, ADMIN, "cheater");
    const afterExclude = db
      .prepare("SELECT total_games AS n FROM users WHERE id = ?")
      .get(aliceId) as { n: number };
    expect(afterExclude.n).toBe(1);

    restoreEntry(db, target.id, ADMIN);
    const afterRestore = db
      .prepare("SELECT total_games AS n FROM users WHERE id = ?")
      .get(aliceId) as { n: number };
    expect(afterRestore.n).toBe(2);
  });

  it("re-excluding preserves the original timestamp and does not double-decrement", () => {
    const id = listEntries(db).entries[0].id;
    const owner = listEntries(db).entries[0].userId;
    const baseline = (db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(owner) as { s: number }).s;

    const first = excludeEntry(db, id, ADMIN, "duplicate")!;
    const second = excludeEntry(db, id, ADMIN, "different reason")!;
    expect(second.excludedAt).toBe(first.excludedAt);
    expect(second.excludedReason).toBe("different reason");

    const after = (db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(owner) as { s: number }).s;
    // Score is the entry score; baseline minus that is what we expect after
    // a single decrement, regardless of how many times we re-exclude.
    expect(after).toBe(baseline - first.score);
  });

  it("restoreEntry clears flags and audits", () => {
    const id = listEntries(db).entries[0].id;
    excludeEntry(db, id, ADMIN, "duplicate");
    const restored = restoreEntry(db, id, ADMIN, "false positive")!;
    expect(restored.isExcluded).toBe(false);
    expect(restored.excludedAt).toBeNull();
    const audit = listAuditLog(db, { action: "restore_entry" });
    expect(audit.entries.length).toBe(1);
    expect(audit.entries[0].reason).toBe("false positive");
  });

  it("restoreEntry on already-active entry is a silent no-op", () => {
    const id = listEntries(db).entries[0].id;
    const result = restoreEntry(db, id, ADMIN);
    expect(result).not.toBeNull();
    expect(result!.isExcluded).toBe(false);
    expect(listAuditLog(db, { action: "restore_entry" }).total).toBe(0);
  });
});

describe("bulkExcludeEntries", () => {
  it("excludes multiple ids in one transaction", () => {
    const ids = listEntries(db).entries.slice(0, 2).map((e) => e.id);
    const result = bulkExcludeEntries(db, ids, ADMIN, "wave of cheaters");
    expect(result.excluded).toBe(2);
    expect(result.notFound).toBe(0);
    expect(listEntries(db, { status: "excluded" }).total).toBe(2);
  });

  it("counts not-found ids without aborting the rest", () => {
    const validId = listEntries(db).entries[0].id;
    const result = bulkExcludeEntries(db, [validId, 99999], ADMIN, "x");
    expect(result.excluded).toBe(1);
    expect(result.notFound).toBe(1);
  });

  it("requires a reason", () => {
    expect(() => bulkExcludeEntries(db, [1, 2], ADMIN, "  ")).toThrow();
  });
});

describe("banUser / unbanUser", () => {
  it("requires a reason", () => {
    expect(() => banUser(db, aliceId, ADMIN, { reason: "" })).toThrow();
  });

  it("returns null for non-existent user", () => {
    expect(banUser(db, "no-such-user", ADMIN, { reason: "x" })).toBeNull();
  });

  it("permanently bans by default", () => {
    const summary = banUser(db, aliceId, ADMIN, { reason: "cheating" })!;
    expect(summary.banned).toBe(true);
    expect(summary.bannedUntil).toBeNull();
    expect(summary.bannedReason).toBe("cheating");
  });

  it("supports timed bans via durationDays", () => {
    const summary = banUser(db, aliceId, ADMIN, { reason: "cooldown", durationDays: 7 })!;
    expect(summary.bannedUntil).not.toBeNull();
    const until = new Date(summary.bannedUntil!).getTime();
    const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(until - expected)).toBeLessThan(5000);
  });

  it("unbanUser clears state and audits", () => {
    banUser(db, aliceId, ADMIN, { reason: "cheating" });
    const summary = unbanUser(db, aliceId, ADMIN, "appeal granted")!;
    expect(summary.banned).toBe(false);
    expect(summary.bannedAt).toBeNull();
    const audit = listAuditLog(db, { action: "unban_user" });
    expect(audit.entries.length).toBe(1);
    expect(audit.entries[0].reason).toBe("appeal granted");
  });

  it("unbanUser on non-banned user does not write audit", () => {
    const summary = unbanUser(db, aliceId, ADMIN);
    expect(summary).not.toBeNull();
    expect(listAuditLog(db, { action: "unban_user" }).total).toBe(0);
  });
});

describe("banUserHistory", () => {
  it("requires a reason", () => {
    expect(() => banUserHistory(db, aliceId, ADMIN, { reason: "" })).toThrow();
  });

  it("returns null when user does not exist", () => {
    expect(banUserHistory(db, "no-such", ADMIN, { reason: "x" })).toBeNull();
  });

  it("bans the user and excludes every history row the user owns", () => {
    const summary = banUserHistory(db, aliceId, ADMIN, { reason: "wholesale fraud" })!;

    expect(summary.banned).toBe(true);
    expect(summary.bannedReason).toBe("wholesale fraud");
    // alice has 2 history rows seeded — both should now be excluded.
    expect(summary.excludedEntries).toBe(2);
    expect(summary.totalEntries).toBe(2);

    const aliceEntries = listEntries(db, { search: "alice" }).entries.filter((e) => e.userId === aliceId);
    expect(aliceEntries.every((e) => e.isExcluded)).toBe(true);
    expect(aliceEntries.every((e) => e.excludedReason === "wholesale fraud")).toBe(true);
  });

  it("zeroes the user's lifetime_score after banning their entire history", () => {
    banUserHistory(db, aliceId, ADMIN, { reason: "wholesale fraud" });
    const after = db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number };
    expect(after.s).toBe(0);
  });

  it("does not touch entries belonging to other users", () => {
    banUserHistory(db, aliceId, ADMIN, { reason: "x" });
    const bobEntries = listEntries(db).entries.filter((e) => e.userId === bobId);
    expect(bobEntries.every((e) => !e.isExcluded)).toBe(true);
  });

  it("writes ban_user + exclude_entry audit rows", () => {
    banUserHistory(db, aliceId, ADMIN, { reason: "policy" });
    const banAudit = listAuditLog(db, { action: "ban_user", targetType: "user", targetId: aliceId });
    expect(banAudit.entries.length).toBe(1);
    const excludeAudit = listAuditLog(db, { action: "exclude_entry" });
    expect(excludeAudit.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("supports timed bans via durationDays", () => {
    const summary = banUserHistory(db, aliceId, ADMIN, { reason: "cooldown", durationDays: 14 })!;
    expect(summary.bannedUntil).not.toBeNull();
  });

  it("preserves prior moderation context on rows already excluded", () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const targetId = listEntries(db).entries.find((e) => e.userId === aliceId)!.id;
    db.prepare(
      `UPDATE user_game_history SET excluded_at = ?, excluded_reason = 'old' WHERE id = ?`,
    ).run(before, targetId);

    banUserHistory(db, aliceId, ADMIN, { reason: "fresh" });

    const aliceEntries = listEntries(db).entries.filter((e) => e.userId === aliceId);
    const reused = aliceEntries.find((e) => e.excludedAt === before);
    expect(reused).toBeDefined();
    // The pre-existing reason is preserved — repeat ban-history invocations
    // (or ban-history after a row-level exclude) must not clobber prior
    // moderation context or pollute the audit log.
    expect(reused!.excludedReason).toBe("old");
  });

  it("repeat invocations do not write redundant exclude_entry audit events", () => {
    banUserHistory(db, aliceId, ADMIN, { reason: "first" });
    const firstCount = listAuditLog(db, { action: "exclude_entry" }).total;
    banUserHistory(db, aliceId, ADMIN, { reason: "second" });
    const secondCount = listAuditLog(db, { action: "exclude_entry" }).total;
    expect(secondCount).toBe(firstCount);
  });

  it("restoreEntry after banUserHistory re-credits the row's score to lifetime_score", () => {
    // Ban alice's history (zeros lifetime_score) then individually
    // restore one row — only that row's score should come back, not the
    // full pre-ban total. This guards against a re-credit bug where the
    // restore path forgets that the ban-history pass already decremented.
    banUserHistory(db, aliceId, ADMIN, { reason: "policy" });
    const banned = (db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number }).s;
    expect(banned).toBe(0);

    const target = listEntries(db).entries.find(
      (e) => e.userId === aliceId && e.score === 8000,
    )!;
    restoreEntry(db, target.id, ADMIN, "appeal partial");
    const after = (db
      .prepare("SELECT lifetime_score AS s FROM users WHERE id = ?")
      .get(aliceId) as { s: number }).s;
    expect(after).toBe(8000);
  });
});

describe("setTestAccountFlag", () => {
  it("toggles the flag and audits", () => {
    const summary = setTestAccountFlag(db, aliceId, true, ADMIN)!;
    expect(summary.isTestAccount).toBe(true);
    const audit = listAuditLog(db, { action: "set_test_flag" });
    expect(audit.entries.length).toBe(1);
    expect(audit.entries[0].details).toEqual({ isTest: true });
  });

  it("unsetting writes a separate audit event", () => {
    setTestAccountFlag(db, aliceId, true, ADMIN);
    setTestAccountFlag(db, aliceId, false, ADMIN);
    expect(listAuditLog(db, { action: "set_test_flag" }).total).toBe(2);
  });

  it("redundant set is a silent no-op (no extra audit)", () => {
    setTestAccountFlag(db, aliceId, true, ADMIN);
    setTestAccountFlag(db, aliceId, true, ADMIN);
    expect(listAuditLog(db, { action: "set_test_flag" }).total).toBe(1);
  });
});

describe("getUserSummary", () => {
  it("returns null for unknown user", () => {
    expect(getUserSummary(db, "no-such-user")).toBeNull();
  });

  it("includes total / excluded / best counts and recent entries", () => {
    const summary = getUserSummary(db, aliceId)!;
    expect(summary.totalEntries).toBe(2);
    expect(summary.bestScore).toBe(8000);
    expect(summary.excludedEntries).toBe(0);
    expect(summary.recentEntries.length).toBe(2);
    // After excluding one entry, excludedEntries should reflect it
    excludeEntry(db, summary.recentEntries[0].id, ADMIN, "x");
    const refreshed = getUserSummary(db, aliceId)!;
    expect(refreshed.excludedEntries).toBe(1);
  });

  it("recentEntries scopes strictly to user_id (no substring match on username)", () => {
    // Seed a user whose username contains alice's as a substring. The old
    // implementation used `WHERE player_name LIKE ? OR username LIKE ?`
    // and would have leaked these rows into alice's drilldown.
    const aliceCloneId = seedUser(db, "malice", "malice@example.com");
    seedEntry(db, { userId: aliceCloneId, score: 9999 });
    const summary = getUserSummary(db, aliceId)!;
    expect(summary.recentEntries.every((e) => e.userId === aliceId)).toBe(true);
    expect(summary.recentEntries.length).toBe(2);
  });

  it("recentEntries is sorted by playedAt DESC", () => {
    seedEntry(db, {
      userId: aliceId,
      score: 100,
      playedAt: "2027-12-31T00:00:00Z",
    });
    const summary = getUserSummary(db, aliceId)!;
    expect(summary.recentEntries[0].playedAt).toBe("2027-12-31T00:00:00Z");
  });
});

describe("listBannedUsers", () => {
  it("only returns banned users with stats attached", () => {
    banUser(db, aliceId, ADMIN, { reason: "cheating" });
    const result = listBannedUsers(db);
    expect(result.total).toBe(1);
    expect(result.users[0].userId).toBe(aliceId);
    expect(result.users[0].totalEntries).toBe(2);
    expect(result.users[0].bestScore).toBe(8000);
  });
});

describe("listAuditLog", () => {
  it("filters by action and target", () => {
    const id = listEntries(db).entries[0].id;
    excludeEntry(db, id, ADMIN, "x");
    banUser(db, aliceId, ADMIN, { reason: "y" });
    expect(listAuditLog(db, { action: "exclude_entry" }).total).toBe(1);
    expect(listAuditLog(db, { targetType: "user" }).total).toBe(1);
    expect(listAuditLog(db, { targetId: String(id) }).total).toBe(1);
  });

  it("paginates newest-first", () => {
    const ids = listEntries(db).entries.map((e) => e.id);
    for (const id of ids) excludeEntry(db, id, ADMIN, "x");
    const page = listAuditLog(db, { limit: 2 });
    expect(page.entries.length).toBe(2);
    expect(page.total).toBe(4);
    // newest first
    expect(page.entries[0].id).toBeGreaterThan(page.entries[1].id);
  });
});

describe("getStats", () => {
  it("rolls up counts across user_game_history + users", () => {
    expect(getStats(db)).toEqual({
      totalEntries: 4,
      excludedEntries: 0,
      bannedUsers: 0,
      testAccounts: 0,
    });
    const id = listEntries(db).entries[0].id;
    excludeEntry(db, id, ADMIN, "x");
    banUser(db, aliceId, ADMIN, { reason: "x" });
    setTestAccountFlag(db, bobId, true, ADMIN);
    expect(getStats(db)).toEqual({
      totalEntries: 4,
      excludedEntries: 1,
      bannedUsers: 1,
      testAccounts: 1,
    });
  });
});
