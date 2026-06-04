import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { claimAnonymousGameHistory } from "./gameHistoryClaim";

let testDb: DatabaseType;

beforeEach(() => {
  testDb = createTestDb();
});

/**
 * Insert an anonymous (user_id = NULL) game_sessions row for testing.
 */
function seedAnonSession(
  visitorId: string,
  sessionId: string,
  opts: {
    completed?: boolean;
    score?: number;
    gameMode?: string;
    isDaily?: boolean;
  } = {},
) {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO game_sessions
         (id, current_round, total_score, started_at, completed_at, game_mode, user_id, is_daily, visitor_id)
       VALUES (?, 10, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      sessionId,
      opts.score ?? 5000,
      now,
      opts.completed !== false ? now : null,
      opts.gameMode ?? "classic",
      opts.isDaily ? 1 : 0,
      visitorId,
    );
}

/** Insert a completed session already tied to a user. */
function seedUserSession(userId: string, sessionId: string, score = 4000) {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO game_sessions
         (id, current_round, total_score, started_at, completed_at, game_mode, user_id, is_daily)
       VALUES (?, 10, ?, ?, ?, 'classic', ?, 0)`,
    )
    .run(sessionId, score, now, now, userId);
}

describe("claimAnonymousGameHistory", () => {
  it("transfers completed anonymous sessions to the user and sums points", () => {
    const userId = seedUser(testDb, "claimer");
    seedAnonSession("visitor-abc", "sess-1", { score: 3000 });
    seedAnonSession("visitor-abc", "sess-2", { score: 4500, gameMode: "higher-lower" });

    const result = claimAnonymousGameHistory(testDb, userId, "visitor-abc");
    expect(result.claimed).toBe(2);
    expect(result.pointsTransferred).toBe(7500);

    // Both sessions now reference the user
    const sessionRows = testDb
      .prepare("SELECT user_id FROM game_sessions WHERE visitor_id = ? ORDER BY id")
      .all("visitor-abc") as { user_id: string | null }[];
    expect(sessionRows.every((r) => r.user_id === userId)).toBe(true);

    // user_game_history has both rows with correct modes & scores
    const history = testDb
      .prepare(
        "SELECT session_id, game_mode, score FROM user_game_history WHERE user_id = ? ORDER BY session_id",
      )
      .all(userId) as { session_id: string; game_mode: string; score: number }[];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ session_id: "sess-1", game_mode: "classic", score: 3000 });
    expect(history[1]).toMatchObject({ session_id: "sess-2", game_mode: "higher-lower", score: 4500 });

    // lifetime_score bumped by the total
    const user = testDb
      .prepare("SELECT lifetime_score FROM users WHERE id = ?")
      .get(userId) as { lifetime_score: number };
    expect(user.lifetime_score).toBe(7500);
  });

  it("skips incomplete anonymous sessions", () => {
    const userId = seedUser(testDb, "skippy");
    seedAnonSession("visitor-skip", "sess-incomplete", { completed: false, score: 2000 });
    seedAnonSession("visitor-skip", "sess-done", { completed: true, score: 1500 });

    const result = claimAnonymousGameHistory(testDb, userId, "visitor-skip");
    expect(result.claimed).toBe(1);
    expect(result.pointsTransferred).toBe(1500);

    // The incomplete session stays anonymous
    const incomplete = testDb
      .prepare("SELECT user_id FROM game_sessions WHERE id = ?")
      .get("sess-incomplete") as { user_id: string | null };
    expect(incomplete.user_id).toBeNull();
  });

  it("skips daily sessions (owned by claimAnonymousDailyPlays)", () => {
    const userId = seedUser(testDb, "dailyskip");
    seedAnonSession("visitor-daily", "sess-daily", { isDaily: true, score: 9000 });
    seedAnonSession("visitor-daily", "sess-regular", { score: 1000 });

    const result = claimAnonymousGameHistory(testDb, userId, "visitor-daily");
    expect(result.claimed).toBe(1);
    expect(result.pointsTransferred).toBe(1000);

    // Daily session remains anonymous (will be handled by dailyClaim separately)
    const daily = testDb
      .prepare("SELECT user_id FROM game_sessions WHERE id = ?")
      .get("sess-daily") as { user_id: string | null };
    expect(daily.user_id).toBeNull();
  });

  it("does not claim sessions belonging to a different visitor", () => {
    const userId = seedUser(testDb, "wrongvisitor");
    seedAnonSession("visitor-other", "sess-other", { score: 1000 });

    const result = claimAnonymousGameHistory(testDb, userId, "visitor-mine");
    expect(result.claimed).toBe(0);
    expect(result.pointsTransferred).toBe(0);

    const row = testDb
      .prepare("SELECT user_id FROM game_sessions WHERE id = ?")
      .get("sess-other") as { user_id: string | null };
    expect(row.user_id).toBeNull();
  });

  it("returns zero when visitorId is null or undefined", () => {
    const userId = seedUser(testDb, "noninvisitor");
    expect(
      claimAnonymousGameHistory(testDb, userId, null as unknown as string),
    ).toEqual({ claimed: 0, pointsTransferred: 0 });
    expect(
      claimAnonymousGameHistory(testDb, userId, undefined as unknown as string),
    ).toEqual({ claimed: 0, pointsTransferred: 0 });
  });

  it("is idempotent — running twice produces the same totals", () => {
    const userId = seedUser(testDb, "idempotent");
    seedAnonSession("visitor-twice", "sess-twice", { score: 2500 });

    const first = claimAnonymousGameHistory(testDb, userId, "visitor-twice");
    const second = claimAnonymousGameHistory(testDb, userId, "visitor-twice");

    expect(first.claimed).toBe(1);
    expect(first.pointsTransferred).toBe(2500);
    // Session already has user_id set, so it no longer matches the claim query
    expect(second.claimed).toBe(0);
    expect(second.pointsTransferred).toBe(0);

    // Only one history row; lifetime_score bumped only once
    const historyCount = testDb
      .prepare("SELECT COUNT(*) as cnt FROM user_game_history WHERE user_id = ?")
      .get(userId) as { cnt: number };
    expect(historyCount.cnt).toBe(1);

    const user = testDb
      .prepare("SELECT lifetime_score FROM users WHERE id = ?")
      .get(userId) as { lifetime_score: number };
    expect(user.lifetime_score).toBe(2500);
  });

  it("does not double-count when the user already has a history row for the session", () => {
    // Simulates a race where the round completed as authenticated *and* the
    // session was anon-tagged somehow; recordSinglePlayerGame's INSERT OR
    // IGNORE must protect lifetime_score from double-counting.
    const userId = seedUser(testDb, "racy");
    seedUserSession(userId, "sess-existing", 3000);
    // Manually stage the existing history row recorded at play time
    testDb
      .prepare(
        `INSERT INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at)
         VALUES (?, 'single', 'classic', ?, 3000, ?)`,
      )
      .run(userId, "sess-existing", new Date().toISOString());
    testDb
      .prepare("UPDATE users SET lifetime_score = 3000 WHERE id = ?")
      .run(userId);

    // Now stage an anon row for the SAME session_id (pretend claim path)
    testDb
      .prepare("UPDATE game_sessions SET user_id = NULL, visitor_id = ? WHERE id = ?")
      .run("visitor-race", "sess-existing");

    const result = claimAnonymousGameHistory(testDb, userId, "visitor-race");
    // The claim walks one session and sets user_id, but the history insert is
    // a no-op thanks to the unique index on (user_id, session_id).
    expect(result.claimed).toBe(1);

    const historyCount = testDb
      .prepare("SELECT COUNT(*) as cnt FROM user_game_history WHERE user_id = ?")
      .get(userId) as { cnt: number };
    expect(historyCount.cnt).toBe(1);

    const user = testDb
      .prepare("SELECT lifetime_score FROM users WHERE id = ?")
      .get(userId) as { lifetime_score: number };
    expect(user.lifetime_score).toBe(3000);
  });

  it("returns zero when the visitor has no anonymous sessions at all", () => {
    const userId = seedUser(testDb, "empty");
    const result = claimAnonymousGameHistory(testDb, userId, "visitor-empty");
    expect(result).toEqual({ claimed: 0, pointsTransferred: 0 });
  });
});
