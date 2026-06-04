import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import {
  ghostsVisibleOnLeaderboard,
  getGhostLifetimeEntries,
  getGhostStreakEntries,
  countGhostScorers,
} from "./leaderboard";
import { setGhostSettings } from "./settings";

let db: DatabaseType;

function insertGhost(opts: {
  id?: string;
  username?: string;
  active?: number;
  lifetimeScore?: number;
  streakBest?: number;
  streakCurrent?: number;
  streakLastDate?: string | null;
  lastPlayedAt?: string | null;
}) {
  const id = opts.id ?? uuidv4();
  const username = opts.username ?? `g_${id.slice(0, 6)}`;
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
    username,
    username.toLowerCase(),
    opts.lifetimeScore ?? 0,
    now,
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

describe("ghostsVisibleOnLeaderboard", () => {
  it("returns false by default (toggle off)", () => {
    expect(ghostsVisibleOnLeaderboard(db)).toBe(false);
  });

  it("returns false when system is enabled but showOnLeaderboard is false", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: false });
    expect(ghostsVisibleOnLeaderboard(db)).toBe(false);
  });

  it("returns true only when both enabled AND showOnLeaderboard are true", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true });
    expect(ghostsVisibleOnLeaderboard(db)).toBe(true);
  });

  it("returns false when killSwitch is set even if other flags are true", () => {
    setGhostSettings(db, { enabled: true, showOnLeaderboard: true, killSwitch: true });
    expect(ghostsVisibleOnLeaderboard(db)).toBe(false);
  });
});

describe("getGhostLifetimeEntries", () => {
  it("returns active ghosts with lifetime_score > 0, ordered DESC", () => {
    insertGhost({ username: "alpha", lifetimeScore: 5000 });
    insertGhost({ username: "beta", lifetimeScore: 9000 });
    insertGhost({ username: "gamma", lifetimeScore: 1000 });
    const rows = getGhostLifetimeEntries(db, 10);
    expect(rows.map((r) => r.username)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("excludes inactive ghosts", () => {
    insertGhost({ username: "active_ghost", lifetimeScore: 5000, active: 1 });
    insertGhost({ username: "retired_ghost", lifetimeScore: 9000, active: 0 });
    const rows = getGhostLifetimeEntries(db, 10);
    expect(rows.map((r) => r.username)).toEqual(["active_ghost"]);
  });

  it("excludes zero-score ghosts (no standing yet)", () => {
    insertGhost({ username: "fresh_ghost", lifetimeScore: 0 });
    expect(getGhostLifetimeEntries(db, 10)).toEqual([]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 8; i++) {
      insertGhost({ username: `g${i}`, lifetimeScore: 1000 + i });
    }
    expect(getGhostLifetimeEntries(db, 3)).toHaveLength(3);
  });
});

describe("getGhostStreakEntries", () => {
  it("returns ghosts with daily_streak_best > 0, ordered DESC by best then current", () => {
    insertGhost({ username: "fivebest", streakBest: 5, streakCurrent: 2 });
    insertGhost({ username: "tenbest", streakBest: 10, streakCurrent: 3 });
    insertGhost({ username: "threebest", streakBest: 3, streakCurrent: 3 });
    const rows = getGhostStreakEntries(db, 10);
    expect(rows.map((r) => r.username)).toEqual(["tenbest", "fivebest", "threebest"]);
  });

  it("excludes inactive ghosts and zero-streak ghosts", () => {
    insertGhost({ username: "in_active", streakBest: 5, active: 0 });
    insertGhost({ username: "no_streak", streakBest: 0 });
    insertGhost({ username: "ok", streakBest: 1 });
    const rows = getGhostStreakEntries(db, 10);
    expect(rows.map((r) => r.username)).toEqual(["ok"]);
  });

  it("excludes never-played ghosts (last_played_at IS NULL) even if streak best > 0", () => {
    // Defense-in-depth backstop for the synthetic-streak bug: a ghost
    // with no game history should never surface on the streak board.
    insertGhost({ username: "never_played", streakBest: 1, lastPlayedAt: null });
    insertGhost({ username: "real_play", streakBest: 1 });
    const rows = getGhostStreakEntries(db, 10);
    expect(rows.map((r) => r.username)).toEqual(["real_play"]);
  });
});

describe("countGhostScorers", () => {
  it("counts active ghosts with lifetime_score > 0", () => {
    insertGhost({ lifetimeScore: 1000 });
    insertGhost({ lifetimeScore: 5000 });
    insertGhost({ lifetimeScore: 0 });           // excluded: zero-score
    insertGhost({ lifetimeScore: 5000, active: 0 }); // excluded: inactive
    expect(countGhostScorers(db)).toBe(2);
  });

  it("returns 0 when no ghosts qualify", () => {
    expect(countGhostScorers(db)).toBe(0);
  });
});
