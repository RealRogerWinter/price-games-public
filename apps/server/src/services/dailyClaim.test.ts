import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { claimAnonymousDailyPlays } from "./dailyClaim";

let testDb: DatabaseType;

beforeEach(() => {
  testDb = createTestDb();
});

/**
 * Insert an anonymous (user_id = NULL) daily_plays row for testing.
 */
function seedAnonPlay(
  visitorId: string,
  date: string,
  opts: { completed?: boolean; score?: number; sessionId?: string } = {},
) {
  const sessionId = opts.sessionId ?? `sess-anon-${date}-${visitorId}`;
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO daily_plays
         (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, visitor_id)
       VALUES (NULL, ?, ?, 'classic', ?, '[1000,1000,1000,1000,1000]', ?, ?, ?)`,
    )
    .run(
      sessionId,
      date,
      opts.score ?? 5000,
      now,
      opts.completed !== false ? now : null,
      visitorId,
    );
}

/**
 * Insert a logged-in user's daily_plays row for testing.
 */
function seedUserPlay(userId: string, date: string, opts: { sessionId?: string } = {}) {
  const sessionId = opts.sessionId ?? `sess-user-${date}-${userId}`;
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO daily_plays
         (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion)
       VALUES (?, ?, ?, 'classic', 5000, '[1000,1000,1000,1000,1000]', ?, ?, 1)`,
    )
    .run(userId, sessionId, date, now, now);
}

describe("claimAnonymousDailyPlays", () => {
  it("transfers user_id onto anonymous play rows matching the visitor_id", () => {
    const userId = seedUser(testDb, "claimer");
    seedAnonPlay("visitor-abc", "2026-04-13");

    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-abc");
    expect(result.claimed).toBe(1);

    const row = testDb
      .prepare("SELECT user_id FROM daily_plays WHERE visitor_id = ?")
      .get("visitor-abc") as { user_id: string | null };
    expect(row.user_id).toBe(userId);
  });

  it("claims multiple anonymous plays across different dates", () => {
    const userId = seedUser(testDb, "multiclaimer");
    seedAnonPlay("visitor-multi", "2026-04-11");
    seedAnonPlay("visitor-multi", "2026-04-12");
    seedAnonPlay("visitor-multi", "2026-04-13");

    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-multi");
    expect(result.claimed).toBe(3);

    const rows = testDb
      .prepare("SELECT user_id FROM daily_plays WHERE visitor_id = ?")
      .all("visitor-multi") as { user_id: string | null }[];
    expect(rows.every((r) => r.user_id === userId)).toBe(true);
  });

  it("skips dates where the user already has a play (avoids unique constraint violation)", () => {
    const userId = seedUser(testDb, "conflictuser");
    // User already played on 2026-04-12 while logged in
    seedUserPlay(userId, "2026-04-12");
    // Anonymous plays on 2026-04-11 and 2026-04-12 (conflict on 04-12)
    seedAnonPlay("visitor-conflict", "2026-04-11");
    seedAnonPlay("visitor-conflict", "2026-04-12");

    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-conflict");
    expect(result.claimed).toBe(1); // Only 04-11 claimed

    // The conflicting row should remain unclaimed (user_id still NULL)
    const conflictRow = testDb
      .prepare(
        "SELECT user_id FROM daily_plays WHERE visitor_id = ? AND daily_date = ?",
      )
      .get("visitor-conflict", "2026-04-12") as { user_id: string | null };
    expect(conflictRow.user_id).toBeNull();
  });

  it("bootstraps streak by replaying each completed date in order (consecutive days build up)", () => {
    const userId = seedUser(testDb, "streakuser");
    // Anonymous plays on 3 consecutive days
    seedAnonPlay("visitor-streak", "2026-04-11");
    seedAnonPlay("visitor-streak", "2026-04-12");
    seedAnonPlay("visitor-streak", "2026-04-13");

    // Verify streak is zero before claim
    const before = testDb
      .prepare("SELECT daily_streak_current, daily_streak_last_date FROM users WHERE id = ?")
      .get(userId) as { daily_streak_current: number; daily_streak_last_date: string | null };
    expect(before.daily_streak_current).toBe(0);

    claimAnonymousDailyPlays(testDb, userId, "visitor-streak");

    // 3 consecutive days should produce a streak of 3, not 1
    const after = testDb
      .prepare("SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?")
      .get(userId) as { daily_streak_current: number; daily_streak_best: number; daily_streak_last_date: string | null };
    expect(after.daily_streak_current).toBe(3);
    expect(after.daily_streak_best).toBe(3);
    expect(after.daily_streak_last_date).toBe("2026-04-13");
  });

  it("does not overwrite a returning user's existing streak with historical claimed plays", () => {
    const userId = seedUser(testDb, "returninguser");
    // User has an active 5-day streak ending today
    testDb
      .prepare(
        "UPDATE users SET daily_streak_current = 5, daily_streak_best = 5, daily_streak_last_date = ? WHERE id = ?",
      )
      .run("2026-04-13", userId);

    // Anonymous play from 3 days ago on a different device
    seedAnonPlay("visitor-oldplay", "2026-04-10");

    claimAnonymousDailyPlays(testDb, userId, "visitor-oldplay");

    // Streak should be untouched — claiming a historical play must not reset it
    const after = testDb
      .prepare("SELECT daily_streak_current, daily_streak_best, daily_streak_last_date FROM users WHERE id = ?")
      .get(userId) as { daily_streak_current: number; daily_streak_best: number; daily_streak_last_date: string | null };
    expect(after.daily_streak_current).toBe(5);
    expect(after.daily_streak_best).toBe(5);
    expect(after.daily_streak_last_date).toBe("2026-04-13");
  });

  it("returns { claimed: 0 } when visitor_id has no unclaimed plays", () => {
    const userId = seedUser(testDb, "noplays");
    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-empty");
    expect(result.claimed).toBe(0);
  });

  it("returns { claimed: 0 } when visitorId is null or undefined", () => {
    const userId = seedUser(testDb, "nullvisitor");
    expect(claimAnonymousDailyPlays(testDb, userId, null as unknown as string).claimed).toBe(0);
    expect(claimAnonymousDailyPlays(testDb, userId, undefined as unknown as string).claimed).toBe(0);
  });

  it("does not claim plays belonging to a different visitor_id", () => {
    const userId = seedUser(testDb, "wrongvisitor");
    seedAnonPlay("visitor-other", "2026-04-13");

    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-mine");
    expect(result.claimed).toBe(0);

    const row = testDb
      .prepare("SELECT user_id FROM daily_plays WHERE visitor_id = ?")
      .get("visitor-other") as { user_id: string | null };
    expect(row.user_id).toBeNull();
  });

  it("does not claim plays that already have a user_id set", () => {
    const existingUserId = seedUser(testDb, "existing");
    const claimerId = seedUser(testDb, "claimerattempt", "claimer@test.com");

    // A play already owned by another user (same visitor, different user)
    testDb
      .prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
         VALUES (?, 'sess-owned', '2026-04-13', 'classic', 5000, ?, ?, ?)`,
      )
      .run(existingUserId, new Date().toISOString(), new Date().toISOString(), "visitor-shared");

    const result = claimAnonymousDailyPlays(testDb, claimerId, "visitor-shared");
    expect(result.claimed).toBe(0);
  });

  it("skips incomplete (not yet finished) anonymous plays for streak calculation", () => {
    const userId = seedUser(testDb, "incompleteuser");
    // One completed, one incomplete
    seedAnonPlay("visitor-incomplete", "2026-04-12", { completed: true });
    seedAnonPlay("visitor-incomplete", "2026-04-13", { completed: false });

    const result = claimAnonymousDailyPlays(testDb, userId, "visitor-incomplete");
    // Both rows are claimed (they have matching visitor_id and user_id IS NULL)
    expect(result.claimed).toBe(2);

    // But streak should only be based on completed plays
    const user = testDb
      .prepare("SELECT daily_streak_current, daily_streak_last_date FROM users WHERE id = ?")
      .get(userId) as { daily_streak_current: number; daily_streak_last_date: string | null };
    // Last completed is 04-12, not 04-13
    expect(user.daily_streak_last_date).toBe("2026-04-12");
  });
});
