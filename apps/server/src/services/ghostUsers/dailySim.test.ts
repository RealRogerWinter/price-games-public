import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import {
  sampleGhostDailyScore,
  getRealUserStreakCap,
  simulateGhostDailyPlays,
  _resetSimLatchForTesting,
  GHOST_DAILY_SCORE_FALLBACK_MIN,
  GHOST_DAILY_SCORE_FALLBACK_MAX,
} from "./dailySim";
import { setGhostSettings } from "./settings";
import { invalidateCapCache } from "./cap";

let db: DatabaseType;

function insertUser(opts: {
  username: string;
  active?: number;
  banned?: boolean;
  testAccount?: boolean;
  streakBest?: number;
  lifetimeScore?: number;
  totalSessions?: number;
}): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash,
                        created_at, updated_at, is_active, lifetime_score, total_sessions,
                        daily_streak_best, leaderboard_banned_at, is_test_account)
     VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    opts.username.toLowerCase(),
    `${opts.username}@x.com`,
    now,
    now,
    opts.active ?? 1,
    opts.lifetimeScore ?? 0,
    opts.totalSessions ?? 0,
    opts.streakBest ?? 0,
    opts.banned ? now : null,
    opts.testAccount ? 1 : 0,
  );
  return id;
}

/** Seed enough real users to establish a non-zero percentile cap so
 *  creditGhostScore can actually credit the simulator's sampled score.
 *  Ten users with lifetime_score 1000..10000 and total_sessions=10 each
 *  yields a 70th-percentile cap of 7000. */
function seedBaselineUsers(): void {
  for (let i = 1; i <= 10; i++) {
    insertUser({
      username: `baseline_${i}`,
      lifetimeScore: i * 1000,
      totalSessions: 10,
    });
  }
}

function insertUserDaily(userId: string, score: number, playedAt: string): void {
  db.prepare(
    `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
     VALUES (?, 'single', 'daily', ?, ?)`,
  ).run(userId, score, playedAt);
}

function insertGhost(opts: {
  username?: string;
  isActive?: number;
  onShift?: number;
  lastPlayedAt?: string | null;
  current?: number;
  best?: number;
  lastDate?: string | null;
  dailyPlayProbability?: number;
  lastDecisionDate?: string | null;
}): string {
  const id = uuidv4();
  const username = opts.username ?? `g_${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  const lastPlayedAt = opts.lastPlayedAt === undefined ? now : opts.lastPlayedAt;
  // Default ghosts to on_shift=1. The simulator defaults to onShiftOnly,
  // so off-shift ghosts would be filtered out unless tests opt in. Tests
  // for the off-shift filter can pass `onShift: 0` explicitly.
  db.prepare(
    `INSERT INTO ghost_users
       (id, username, username_normalized, avatar, lifetime_score,
        account_created_at, on_shift, is_active, last_played_at,
        daily_streak_current, daily_streak_best, daily_streak_last_date,
        daily_play_probability, last_daily_decision_date, created_at, updated_at)
     VALUES (?, ?, ?, 'silhouette', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    username,
    username.toLowerCase(),
    now,
    opts.onShift ?? 1,
    opts.isActive ?? 1,
    lastPlayedAt,
    opts.current ?? 0,
    opts.best ?? 0,
    opts.lastDate ?? null,
    opts.dailyPlayProbability ?? 0.7,
    opts.lastDecisionDate ?? null,
    now,
    now,
  );
  return id;
}

function getGhost(id: string): {
  current: number;
  best: number;
  last: string | null;
  lifetime_score: number;
  last_played_at: string | null;
} {
  const row = db
    .prepare(
      `SELECT daily_streak_current, daily_streak_best, daily_streak_last_date,
              lifetime_score, last_played_at
         FROM ghost_users WHERE id = ?`,
    )
    .get(id) as {
      daily_streak_current: number;
      daily_streak_best: number;
      daily_streak_last_date: string | null;
      lifetime_score: number;
      last_played_at: string | null;
    };
  return {
    current: row.daily_streak_current,
    best: row.daily_streak_best,
    last: row.daily_streak_last_date,
    lifetime_score: row.lifetime_score,
    last_played_at: row.last_played_at,
  };
}

beforeEach(() => {
  db = createTestDb();
  invalidateCapCache();
  _resetSimLatchForTesting(); // back-compat no-op; per-ghost markers replaced the latch.
  setGhostSettings(db, { enabled: true, percentileCap: 70 });
});

describe("sampleGhostDailyScore", () => {
  it("samples from the bottom 30% of real-user dailies for that date when present", () => {
    // Five real-user daily scores for 2026-04-28: [200, 600, 1200, 2000, 3000].
    // Bottom 30% → first 1.5 rounded = 1 row → score 200. Sampler should
    // therefore return 200 regardless of the random draw.
    const u = insertUser({ username: "u1" });
    insertUserDaily(u, 200, "2026-04-28T05:00:00Z");
    insertUserDaily(u, 600, "2026-04-28T06:00:00Z");
    insertUserDaily(u, 1200, "2026-04-28T07:00:00Z");
    insertUserDaily(u, 2000, "2026-04-28T08:00:00Z");
    insertUserDaily(u, 3000, "2026-04-28T09:00:00Z");

    const score = sampleGhostDailyScore(db, "2026-04-28", () => 0);
    expect(score).toBe(200);
  });

  it("draws across the entire bottom-30% slice (random=0.99 picks the high end of the slice)", () => {
    const u = insertUser({ username: "u1" });
    // 10 dailies; bottom 30% = 3 rows → [100, 200, 300].
    [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].forEach((s, i) =>
      insertUserDaily(u, s, `2026-04-28T0${i}:00:00Z`),
    );
    const score = sampleGhostDailyScore(db, "2026-04-28", () => 0.999);
    expect([100, 200, 300]).toContain(score);
  });

  it("falls back to a fixed band when no real-user dailies exist for the date", () => {
    const lo = sampleGhostDailyScore(db, "2026-04-28", () => 0);
    const hi = sampleGhostDailyScore(db, "2026-04-28", () => 0.999999);
    expect(lo).toBe(GHOST_DAILY_SCORE_FALLBACK_MIN);
    expect(hi).toBeLessThanOrEqual(GHOST_DAILY_SCORE_FALLBACK_MAX);
    expect(hi).toBeGreaterThanOrEqual(GHOST_DAILY_SCORE_FALLBACK_MIN);
  });

  it("ignores dailies outside the requested UTC date", () => {
    const u = insertUser({ username: "u1" });
    insertUserDaily(u, 9999, "2026-04-27T23:59:00Z");
    insertUserDaily(u, 9998, "2026-04-29T00:01:00Z");
    // No real dailies for 2026-04-28 → fallback band.
    const score = sampleGhostDailyScore(db, "2026-04-28", () => 0);
    expect(score).toBe(GHOST_DAILY_SCORE_FALLBACK_MIN);
  });
});

describe("getRealUserStreakCap", () => {
  it("returns MAX(daily_streak_best) over leaderboard-eligible real users", () => {
    insertUser({ username: "alice", streakBest: 5 });
    insertUser({ username: "bob", streakBest: 12 });
    insertUser({ username: "carol", streakBest: 3 });
    expect(getRealUserStreakCap(db)).toBe(12);
  });

  it("ignores banned users", () => {
    insertUser({ username: "alice", streakBest: 5 });
    insertUser({ username: "huge", streakBest: 999, banned: true });
    expect(getRealUserStreakCap(db)).toBe(5);
  });

  it("ignores test accounts", () => {
    insertUser({ username: "alice", streakBest: 5 });
    insertUser({ username: "test_acct", streakBest: 999, testAccount: true });
    expect(getRealUserStreakCap(db)).toBe(5);
  });

  it("ignores inactive users", () => {
    insertUser({ username: "alice", streakBest: 5 });
    insertUser({ username: "deactivated", streakBest: 999, active: 0 });
    expect(getRealUserStreakCap(db)).toBe(5);
  });

  it("returns 0 when no eligible real user exists", () => {
    expect(getRealUserStreakCap(db)).toBe(0);
  });
});

describe("simulateGhostDailyPlays", () => {
  it("no-ops when ghosts are disabled (master flag)", () => {
    setGhostSettings(db, { enabled: false });
    const id = insertGhost({});
    insertUser({ username: "human", streakBest: 10 });
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(0);
    expect(getGhost(id).best).toBe(0);
  });

  it("no-ops when killSwitch is set even with enabled=true", () => {
    setGhostSettings(db, { enabled: true, killSwitch: true });
    const id = insertGhost({});
    insertUser({ username: "human", streakBest: 10 });
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(0);
    expect(getGhost(id).best).toBe(0);
  });

  it("runs even when showOnLeaderboard is off (data accrues regardless of visibility)", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: false });
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({});
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(1);
    expect(result.played).toBe(1);
    expect(getGhost(id).best).toBe(1);
  });

  it("honors per-ghost daily_play_probability", () => {
    insertUser({ username: "human", streakBest: 10 });
    const lazy = insertGhost({ dailyPlayProbability: 0.4 });
    const eager = insertGhost({ dailyPlayProbability: 0.95 });
    // Random returns 0.5: lazy (0.4) skips; eager (0.95) plays.
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0.5 });
    expect(getGhost(lazy).best).toBe(0);
    expect(getGhost(eager).best).toBe(1);
  });

  it("on a 'played' tick, inserts a daily ghost_game_history row using the daily_puzzles game_mode", () => {
    // The daily challenge isn't its own game mode — each UTC day rotates
    // between real modes (classic, higher-lower, bidding, …) and
    // `daily_puzzles.game_mode` is the canonical record. Real-user daily
    // plays write that mode to user_game_history.game_mode, so ghost
    // daily plays must do the same — otherwise their profile shows
    // "Daily: 7" while real users show "Higher-Lower: 7".
    seedBaselineUsers();
    insertUser({ username: "human", streakBest: 10 });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO daily_puzzles (daily_date, game_mode, product_ids, round_data, created_at)
       VALUES (?, ?, '[]', '[]', ?)`,
    ).run("2026-04-28", "higher-lower", now);
    const id = insertGhost({ lastPlayedAt: "2025-01-01T00:00:00Z" });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    const rows = db
      .prepare(
        "SELECT game_type, game_mode, played_at, score FROM ghost_game_history WHERE ghost_user_id = ?",
      )
      .all(id) as { game_type: string; game_mode: string; played_at: string; score: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].game_type).toBe("single");
    expect(rows[0].game_mode).toBe("higher-lower");
    expect(rows[0].played_at.startsWith("2026-04-28")).toBe(true);
    expect(rows[0].score).toBeGreaterThan(0);
    expect(getGhost(id).last_played_at).not.toBe("2025-01-01T00:00:00Z");
  });

  it("falls back to 'classic' when no daily_puzzles row exists for the date", () => {
    seedBaselineUsers();
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({});
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    const row = db
      .prepare("SELECT game_mode FROM ghost_game_history WHERE ghost_user_id = ?")
      .get(id) as { game_mode: string } | undefined;
    expect(row?.game_mode).toBe("classic");
  });

  it("clamps newCurrent + newBest at the top real-user streak cap", () => {
    insertUser({ username: "leader", streakBest: 10 });
    const id = insertGhost({ current: 10, best: 10, lastDate: "2026-04-27" });
    // Coin says "play" → would normally bump to 11. Cap is 10 → stays at 10.
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    const s = getGhost(id);
    expect(s.current).toBe(10);
    expect(s.best).toBe(10);
  });

  it("does not advance any ghost streak when no real user has a streak", () => {
    // No real users with a streak → cap is 0.
    const id = insertGhost({});
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    const s = getGhost(id);
    expect(s.current).toBe(0);
    expect(s.best).toBe(0);
  });

  it("zeros out stale streak data on never-played ghosts (defensive cleanup)", () => {
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({
      lastPlayedAt: null,
      current: 1,
      best: 1,
      lastDate: "2026-04-27",
    });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    const s = getGhost(id);
    expect(s.current).toBe(0);
    expect(s.best).toBe(0);
    expect(s.last).toBeNull();
  });

  it("breaks the streak on a 'didn't play' day (no row written)", () => {
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({
      current: 5,
      best: 5,
      lastDate: "2026-04-27",
      dailyPlayProbability: 0.5,
    });
    // random=0.99 > 0.5 → didn't play; current resets, best preserved.
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0.99 });
    const s = getGhost(id);
    expect(s.current).toBe(0);
    expect(s.best).toBe(5);
    expect(s.last).toBe("2026-04-27");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM ghost_game_history WHERE ghost_user_id = ?").get(id) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("is idempotent within the same UTC day (per-ghost decision marker)", () => {
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({ current: 5, best: 5, lastDate: "2026-04-27" });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(getGhost(id).current).toBe(6);
    // Second call the same day is a no-op for the ghost: the SELECT
    // filters out rows with last_daily_decision_date = today, so the
    // ghost isn't even considered. No double-credit.
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(0);
    expect(getGhost(id).current).toBe(6);
  });

  it("records last_daily_decision_date on no-play days too (so a no-play decision is final)", () => {
    // The hourly tick may run multiple times per UTC day. Once a ghost
    // rolls "didn't play", the next tick must skip them — otherwise their
    // effective daily-play probability inflates by N (one re-roll per
    // tick) instead of being one-shot per day.
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({ dailyPlayProbability: 0.5 });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0.99 }); // first tick: no-play
    expect(db.prepare("SELECT last_daily_decision_date AS d FROM ghost_users WHERE id = ?").get(id)).toMatchObject({ d: "2026-04-28" });
    // Second tick the same day with random=0 (would normally play). Must
    // skip because the ghost already decided.
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(0);
  });

  it("re-evaluates after a UTC day rollover", () => {
    insertUser({ username: "human", streakBest: 10 });
    const id = insertGhost({ current: 5, best: 5, lastDate: "2026-04-27" });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(getGhost(id).current).toBe(6);
    simulateGhostDailyPlays(db, "2026-04-29", { random: () => 0 });
    expect(getGhost(id).current).toBe(7);
  });

  it("returns a result summary with counts", () => {
    insertUser({ username: "human", streakBest: 10 });
    const a = insertGhost({ dailyPlayProbability: 0.95 });
    const b = insertGhost({ dailyPlayProbability: 0.05 });
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0.5 });
    expect(result.ghostsConsidered).toBe(2);
    expect(result.played).toBe(1);
    expect(result.skippedNoPlay).toBe(1);
    expect(getGhost(a).best).toBeGreaterThan(0);
    expect(getGhost(b).best).toBe(0);
  });

  it("counts streakCapped when cap clamps the increment", () => {
    insertUser({ username: "leader", streakBest: 5 });
    insertGhost({ current: 5, best: 5, lastDate: "2026-04-27", dailyPlayProbability: 0.95 });
    insertGhost({ current: 2, best: 2, lastDate: "2026-04-27", dailyPlayProbability: 0.95 });
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.played).toBe(2);
    expect(result.streakCapped).toBe(1);
  });

  it("does NOT count streakCapped when cap=0 (avoid misleading counter inflation)", () => {
    // No real user has a streak ⇒ cap=0 ⇒ every ghost stays at 0. We
    // don't want streakCapped to count "every ghost was clamped to 0"
    // since that's the pre-launch baseline state, not interesting
    // capping behavior.
    const id = insertGhost({ current: 0, best: 0, dailyPlayProbability: 0.95 });
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.played).toBe(1);
    expect(result.streakCapped).toBe(0);
    expect(getGhost(id).best).toBe(0);
  });

  it("filters out off-shift ghosts by default (production trickle behavior)", () => {
    // Production hourly tick uses default `onShiftOnly: true`. Off-shift
    // ghosts must not get a daily play this tick — they'll be picked up
    // by a later tick when shift rotation puts them on the floor.
    insertUser({ username: "human", streakBest: 10 });
    const offShift = insertGhost({ onShift: 0 });
    const onShift = insertGhost({ onShift: 1 });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(getGhost(offShift).best).toBe(0);
    expect(getGhost(onShift).best).toBe(1);
  });

  it("processes off-shift ghosts when onShiftOnly: false (admin manual trigger path)", () => {
    insertUser({ username: "human", streakBest: 10 });
    const offShift = insertGhost({ onShift: 0 });
    const onShift = insertGhost({ onShift: 1 });
    simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0, onShiftOnly: false });
    expect(getGhost(offShift).best).toBe(1);
    expect(getGhost(onShift).best).toBe(1);
  });

  it("trickles plays across multiple ticks: each tick processes only the on-shift slice", () => {
    // Simulate the trickle pattern: at hour 1, ghost A is on shift, B
    // and C are off; the tick fires and only A decides. At hour 2, B
    // comes on shift and A goes off; the tick fires and only B decides
    // (A is skipped because their decision was made at hour 1). And so on.
    insertUser({ username: "human", streakBest: 10 });
    const a = insertGhost({ onShift: 1 });
    const b = insertGhost({ onShift: 0 });
    const c = insertGhost({ onShift: 0 });

    // Hour 1: only A on shift.
    let r = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(r.ghostsConsidered).toBe(1);
    expect(getGhost(a).best).toBe(1);
    expect(getGhost(b).best).toBe(0);

    // Hour 2: A clocks out, B clocks in.
    db.prepare("UPDATE ghost_users SET on_shift = 0 WHERE id = ?").run(a);
    db.prepare("UPDATE ghost_users SET on_shift = 1 WHERE id = ?").run(b);
    r = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(r.ghostsConsidered).toBe(1); // only B (A already decided)
    expect(getGhost(b).best).toBe(1);
    expect(getGhost(c).best).toBe(0);

    // Hour 3: C clocks in.
    db.prepare("UPDATE ghost_users SET on_shift = 0 WHERE id = ?").run(b);
    db.prepare("UPDATE ghost_users SET on_shift = 1 WHERE id = ?").run(c);
    r = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(r.ghostsConsidered).toBe(1);
    expect(getGhost(c).best).toBe(1);
  });

  it("treats out-of-range daily_play_probability as clamped (defensive)", () => {
    // The repository never writes out-of-range values, but if an admin
    // SQL update or schema drift introduced one, the simulator should
    // degrade gracefully rather than blow up (NaN<x is always false,
    // negative<x is always true, etc.). Forcing the values via direct
    // UPDATE lets us exercise the clamp without touching the insert
    // path's NOT NULL constraint.
    insertUser({ username: "human", streakBest: 10 });
    const a = insertGhost({});
    const b = insertGhost({});
    db.prepare("UPDATE ghost_users SET daily_play_probability = -1 WHERE id = ?").run(a);
    db.prepare("UPDATE ghost_users SET daily_play_probability = 999 WHERE id = ?").run(b);
    const result = simulateGhostDailyPlays(db, "2026-04-28", { random: () => 0 });
    expect(result.ghostsConsidered).toBe(2);
    // -1 → clamped to 0 → no play; 999 → clamped to 1 → play.
    expect(getGhost(a).best).toBe(0);
    expect(getGhost(b).best).toBe(1);
  });
});
