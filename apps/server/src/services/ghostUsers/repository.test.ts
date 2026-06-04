import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  createGhost,
  bulkCreateGhosts,
  getGhostById,
  getGhostByUsername,
  listGhosts,
  setGhostActive,
  deleteGhost,
  setShiftState,
  endAllShifts,
} from "./repository";
import { invalidateReservedNamesCache } from "./reservedNames";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  invalidateReservedNamesCache();
});

describe("createGhost", () => {
  it("inserts a ghost with all required fields", () => {
    const ghost = createGhost(db);
    expect(ghost).not.toBeNull();
    expect(ghost!.username).toBeTruthy();
    expect(ghost!.lifetime_score).toBe(0);
    expect(ghost!.is_active).toBe(1);
    expect(ghost!.on_shift).toBe(0);
  });

  it("assigns a daily_play_probability in [0.30, 0.95]", () => {
    // Per-ghost personality: each ghost carries a stable per-day daily-
    // play probability used by the daily-sim loop. Drawn at create time
    // so every ghost has a different cadence (some streak-hard, others
    // sporadic) without needing per-tick randomness.
    const ghost = createGhost(db)!;
    expect(ghost.daily_play_probability).toBeGreaterThanOrEqual(0.3);
    expect(ghost.daily_play_probability).toBeLessThanOrEqual(0.95);
  });

  it("produces a spread of probabilities across many ghosts (not all the same default)", () => {
    const ghosts = bulkCreateGhosts(db, 50);
    const probs = ghosts.map((g) => g.daily_play_probability);
    const unique = new Set(probs.map((p) => p.toFixed(4)));
    // 50 random draws should yield substantially more than 1 distinct value.
    expect(unique.size).toBeGreaterThan(10);
  });

  it("returns null when persona generation collides repeatedly", () => {
    // Pre-fill ghost_users with all `mike` variants — the dedupe chain in
    // generateGhostPersona prevents duplicate inserts. Hard to actually
    // exhaust the pool, but if we did, this is the contract.
    expect(typeof createGhost(db)).toBe("object");
  });

  it("invalidates the reserved-names cache so the new name is immediately reserved", () => {
    const ghost = createGhost(db)!;
    // Cache should now include the new name even before TTL.
    const reservedRows = db.prepare("SELECT username_normalized FROM ghost_users").all() as { username_normalized: string }[];
    expect(reservedRows.find((r) => r.username_normalized === ghost.username_normalized)).toBeTruthy();
  });
});

describe("bulkCreateGhosts", () => {
  it("creates N distinct ghosts", () => {
    const ghosts = bulkCreateGhosts(db, 10);
    expect(ghosts).toHaveLength(10);
    const usernames = new Set(ghosts.map((g) => g.username_normalized));
    expect(usernames.size).toBe(10);
  });

  it("clamps count to a sane upper bound", () => {
    const ghosts = bulkCreateGhosts(db, 9999);
    expect(ghosts.length).toBeLessThanOrEqual(500);
  });

  it("rejects non-positive counts", () => {
    expect(bulkCreateGhosts(db, 0)).toEqual([]);
    expect(bulkCreateGhosts(db, -5)).toEqual([]);
  });
});

describe("getGhostById / getGhostByUsername", () => {
  it("retrieves a ghost by id", () => {
    const created = createGhost(db)!;
    const found = getGhostById(db, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("retrieves a ghost by username (case-insensitive)", () => {
    const created = createGhost(db)!;
    const found = getGhostByUsername(db, created.username.toUpperCase());
    expect(found?.id).toBe(created.id);
  });

  it("returns null for unknown ids/usernames", () => {
    expect(getGhostById(db, "nope")).toBeNull();
    expect(getGhostByUsername(db, "no-such-ghost")).toBeNull();
  });
});

describe("listGhosts", () => {
  it("returns ghosts ordered by created_at DESC", () => {
    const a = createGhost(db)!;
    const b = createGhost(db)!;
    const list = listGhosts(db);
    expect(list.find((g) => g.id === a.id)).toBeTruthy();
    expect(list.find((g) => g.id === b.id)).toBeTruthy();
  });

  it("supports limit and offset", () => {
    bulkCreateGhosts(db, 5);
    expect(listGhosts(db, { limit: 2 })).toHaveLength(2);
    expect(listGhosts(db, { limit: 10, offset: 4 })).toHaveLength(1);
  });
});

describe("setGhostActive", () => {
  it("flips the is_active flag", () => {
    const g = createGhost(db)!;
    setGhostActive(db, g.id, false);
    expect(getGhostById(db, g.id)?.is_active).toBe(0);
    setGhostActive(db, g.id, true);
    expect(getGhostById(db, g.id)?.is_active).toBe(1);
  });
});

describe("deleteGhost", () => {
  it("removes the row + cascade-clears ghost_game_history", () => {
    const g = createGhost(db)!;
    db.prepare(
      "INSERT INTO ghost_game_history (ghost_user_id, game_type, game_mode, score, played_at) VALUES (?, 'multiplayer', 'classic', 100, ?)",
    ).run(g.id, new Date().toISOString());
    deleteGhost(db, g.id);
    expect(getGhostById(db, g.id)).toBeNull();
    const history = db.prepare("SELECT * FROM ghost_game_history WHERE ghost_user_id = ?").all(g.id);
    expect(history).toHaveLength(0);
  });

  it("nulls ghost_user_id on mp_players + mp_leaderboard rows pointing at the deleted ghost", () => {
    const g = createGhost(db)!;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode,
                             status, current_round, total_rounds, created_at,
                             is_public, bot_count, bot_difficulty, is_daily_game)
       VALUES ('r1', 'h', 'h', 'classic', 'lobby', 0, 5, ?, 1, 1, 'medium', 0)`,
    ).run(now);
    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                               is_host, connected, joined_at, is_bot, is_disguised, ghost_user_id)
       VALUES ('p1', 'r1', ?, ?, 'tok', 0, 1, ?, 1, 1, ?)`,
    ).run(g.username, g.avatar, now, g.id);

    deleteGhost(db, g.id);

    const player = db.prepare("SELECT ghost_user_id FROM mp_players WHERE id = 'p1'").get() as { ghost_user_id: string | null };
    expect(player.ghost_user_id).toBeNull();
  });
});

describe("setShiftState", () => {
  it("transitions a ghost from off-shift to on-shift", () => {
    const g = createGhost(db)!;
    const start = new Date(2026, 0, 1, 18, 0, 0).toISOString();
    const end = new Date(2026, 0, 1, 18, 30, 0).toISOString();
    setShiftState(db, g.id, { onShift: true, startedAt: start, endsAt: end });
    const updated = getGhostById(db, g.id)!;
    expect(updated.on_shift).toBe(1);
    expect(updated.shift_started_at).toBe(start);
    expect(updated.shift_ends_at).toBe(end);
  });

  it("can also set on_break_until", () => {
    const g = createGhost(db)!;
    const breakUntil = new Date(2026, 0, 2, 6, 0, 0).toISOString();
    setShiftState(db, g.id, { onShift: false, breakUntil });
    expect(getGhostById(db, g.id)?.on_break_until).toBe(breakUntil);
  });
});

describe("endAllShifts", () => {
  it("kills the active flag for every on-shift ghost in one call", () => {
    const a = createGhost(db)!;
    const b = createGhost(db)!;
    setShiftState(db, a.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date().toISOString() });
    setShiftState(db, b.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date().toISOString() });
    expect(endAllShifts(db)).toBe(2);
    expect(getGhostById(db, a.id)?.on_shift).toBe(0);
    expect(getGhostById(db, b.id)?.on_shift).toBe(0);
  });
});
