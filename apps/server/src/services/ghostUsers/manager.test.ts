import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { runGhostUsersTick, pickSeatableGhosts } from "./manager";
import { setGhostSettings } from "./settings";
import { createGhost, setShiftState, getGhostById, bulkCreateGhosts } from "./repository";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runGhostUsersTick", () => {
  it("does nothing when the system is disabled", () => {
    bulkCreateGhosts(db, 5);
    setGhostSettings(db, { enabled: false });
    const result = runGhostUsersTick(db);
    expect(result.shiftsStarted).toBe(0);
    expect(result.shiftsEnded).toBe(0);
    expect(result.killSwitchEvictions).toBe(0);
  });

  it("evicts every on-shift ghost when killSwitch is set", () => {
    const a = createGhost(db)!;
    const b = createGhost(db)!;
    setShiftState(db, a.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
    setShiftState(db, b.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
    setGhostSettings(db, { enabled: true, killSwitch: true });

    const result = runGhostUsersTick(db);
    expect(result.killSwitchEvictions).toBe(2);
    expect(getGhostById(db, a.id)?.on_shift).toBe(0);
    expect(getGhostById(db, b.id)?.on_shift).toBe(0);
  });

  it("ends shifts past their end time", () => {
    const g = createGhost(db)!;
    // Set up an explicit `now` at PST 4am — a deep-trough hour with
    // hourWeight = 0.05 (see `hourWeightForLocalHour`). Combined with the
    // Math.random stub below, the tick's step-3 candidate roll
    // (`Math.random() < hourWeight`) is guaranteed false, so the ghost we
    // end off-shift here cannot be re-picked into a fresh shift within
    // the same tick. Without this guard the test flakes by time-of-day
    // (peak-hour weight 1.0 ⇒ near-certain re-shift).
    // 4am PDT == 11am UTC. Using 2026-04-28 (PDT, UTC-7).
    const tickNow = new Date("2026-04-28T11:00:00Z").getTime();
    const past = new Date(tickNow - 60_000).toISOString();
    setShiftState(db, g.id, { onShift: true, startedAt: past, endsAt: past });
    setGhostSettings(db, { enabled: true });

    // Stub Math.random AFTER createGhost — persona generation indexes
    // into name/avatar arrays via `Math.floor(Math.random() * len)` and
    // a stubbed value of 1 would land on an undefined slot.
    vi.spyOn(Math, "random").mockReturnValue(0.999999);

    const result = runGhostUsersTick(db, tickNow);
    expect(result.shiftsEnded).toBeGreaterThanOrEqual(1);
    expect(getGhostById(db, g.id)?.on_shift).toBe(0);
  });

  it("does NOT end shifts whose end time is in the future", () => {
    const g = createGhost(db)!;
    const future = new Date(Date.now() + 60_000).toISOString();
    setShiftState(db, g.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: future });
    setGhostSettings(db, { enabled: true });

    runGhostUsersTick(db);
    expect(getGhostById(db, g.id)?.on_shift).toBe(1);
  });

  it("does not put inactive ghosts on shift", () => {
    bulkCreateGhosts(db, 3);
    db.prepare("UPDATE ghost_users SET is_active = 0").run();
    setGhostSettings(db, { enabled: true });

    runGhostUsersTick(db);
    const onShift = db.prepare("SELECT COUNT(*) AS n FROM ghost_users WHERE on_shift = 1").get() as { n: number };
    expect(onShift.n).toBe(0);
  });
});

describe("pickSeatableGhosts", () => {
  it("returns only on-shift active ghosts", () => {
    const a = createGhost(db)!;
    const b = createGhost(db)!;
    setShiftState(db, a.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
    // b stays off-shift

    const seatable = pickSeatableGhosts(db, 5);
    const ids = seatable.map((g) => g.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("excludes ghosts already seated in another room", () => {
    const a = createGhost(db)!;
    setShiftState(db, a.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
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
    ).run(a.username, a.avatar, now, a.id);

    const seatable = pickSeatableGhosts(db, 5);
    expect(seatable.find((g) => g.id === a.id)).toBeUndefined();
  });

  it("respects the limit parameter", () => {
    const ghosts = bulkCreateGhosts(db, 10);
    for (const g of ghosts) {
      setShiftState(db, g.id, { onShift: true, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() });
    }
    expect(pickSeatableGhosts(db, 3)).toHaveLength(3);
  });
});
