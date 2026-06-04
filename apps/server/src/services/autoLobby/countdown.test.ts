import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  startCountdown,
  cancelCountdown,
  getCountdownState,
  pickCountdownSeconds,
  findElapsedCountdowns,
} from "./countdown";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode,
                           status, current_round, total_rounds, created_at,
                           last_activity_at, is_public, bot_count, bot_difficulty,
                           is_daily_game, daily_date, is_auto_lobby)
     VALUES ('a1', 'h', 'h', 'classic', 'lobby', 0, 6, ?, ?, 1, 3, 'medium', 0, NULL, 1)`
  ).run(now, now);
});

describe("pickCountdownSeconds", () => {
  it("returns a value in [min, max]", () => {
    for (let i = 0; i < 100; i++) {
      const s = pickCountdownSeconds({ min: 15, max: 45 });
      expect(s).toBeGreaterThanOrEqual(15);
      expect(s).toBeLessThanOrEqual(45);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it("collapses to the bound when min===max", () => {
    expect(pickCountdownSeconds({ min: 30, max: 30 })).toBe(30);
  });

  it("swaps inverted bounds defensively", () => {
    const s = pickCountdownSeconds({ min: 45, max: 15 });
    expect(s).toBeGreaterThanOrEqual(15);
    expect(s).toBeLessThanOrEqual(45);
  });
});

describe("startCountdown", () => {
  it("writes started_at and target_at when no countdown is active", () => {
    const result = startCountdown(db, "a1", { min: 20, max: 30 });
    expect(result).not.toBeNull();
    const state = getCountdownState(db, "a1");
    expect(state.startedAt).toBeTruthy();
    expect(state.targetAt).toBeTruthy();
    const target = new Date(state.targetAt!).getTime();
    const start = new Date(state.startedAt!).getTime();
    const diff = (target - start) / 1000;
    expect(diff).toBeGreaterThanOrEqual(20);
    expect(diff).toBeLessThanOrEqual(30);
  });

  it("resets (extends) when called on an active countdown", () => {
    const first = startCountdown(db, "a1", { min: 15, max: 15 });
    expect(first).not.toBeNull();
    // Sleep is unnecessary — the second call deterministically picks a new target_at.
    const second = startCountdown(db, "a1", { min: 30, max: 30 });
    expect(second).not.toBeNull();
    const state = getCountdownState(db, "a1");
    const target = new Date(state.targetAt!).getTime();
    const now = Date.now();
    expect((target - now) / 1000).toBeGreaterThan(20);
  });

  it("refuses to start on a non-auto-lobby room", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode,
                             status, current_round, total_rounds, created_at,
                             is_public, bot_count, bot_difficulty, is_daily_game,
                             is_auto_lobby)
       VALUES ('r1', 'h', 'h', 'classic', 'lobby', 0, 6, ?, 1, 0, 'medium', 0, 0)`
    ).run(now);
    expect(startCountdown(db, "r1", { min: 15, max: 30 })).toBeNull();
  });

  it("refuses to start if the room has moved past 'lobby'", () => {
    db.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = 'a1'").run();
    expect(startCountdown(db, "a1", { min: 15, max: 30 })).toBeNull();
  });
});

describe("cancelCountdown", () => {
  it("clears started_at and target_at", () => {
    startCountdown(db, "a1", { min: 15, max: 30 });
    cancelCountdown(db, "a1");
    const state = getCountdownState(db, "a1");
    expect(state.startedAt).toBeNull();
    expect(state.targetAt).toBeNull();
  });

  it("is a no-op on rooms that don't exist", () => {
    expect(() => cancelCountdown(db, "nonexistent")).not.toThrow();
  });
});

describe("getCountdownState", () => {
  it("returns null fields for a fresh auto-lobby room", () => {
    const s = getCountdownState(db, "a1");
    expect(s.startedAt).toBeNull();
    expect(s.targetAt).toBeNull();
  });

  it("returns null fields for a missing room", () => {
    const s = getCountdownState(db, "missing");
    expect(s.startedAt).toBeNull();
    expect(s.targetAt).toBeNull();
  });
});

describe("findElapsedCountdowns", () => {
  function seatPlayer(roomCode: string, opts: { id?: string; isBot?: number; connected?: number }) {
    const id = opts.id ?? `p-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                               is_host, connected, joined_at, is_bot, is_disguised)
       VALUES (?, ?, ?, 'silhouette', ?, 0, ?, ?, ?, 0)`,
    ).run(id, roomCode, id, `tok-${id}`, opts.connected ?? 1, now, opts.isBot ?? 0);
  }

  it("returns rooms whose target_at has passed and have a connected human", () => {
    seatPlayer("a1", { isBot: 0, connected: 1 });
    seatPlayer("a1", { isBot: 1, connected: 1 });
    db.prepare(
      "UPDATE mp_rooms SET countdown_target_at = ? WHERE code = 'a1'",
    ).run(new Date(Date.now() - 1000).toISOString());

    expect(findElapsedCountdowns(db)).toContain("a1");
  });

  it("excludes rooms with no connected humans (so bots don't play themselves)", () => {
    // Only bots seated — explicit cover of the TOCTOU concern: even though
    // the countdown elapsed, an empty room must not surface as elapsed.
    seatPlayer("a1", { isBot: 1, connected: 1 });
    db.prepare(
      "UPDATE mp_rooms SET countdown_target_at = ? WHERE code = 'a1'",
    ).run(new Date(Date.now() - 1000).toISOString());

    expect(findElapsedCountdowns(db)).not.toContain("a1");
  });

  it("excludes rooms with disconnected-only humans", () => {
    seatPlayer("a1", { isBot: 0, connected: 0 });
    db.prepare(
      "UPDATE mp_rooms SET countdown_target_at = ? WHERE code = 'a1'",
    ).run(new Date(Date.now() - 1000).toISOString());

    expect(findElapsedCountdowns(db)).not.toContain("a1");
  });

  it("excludes rooms whose target_at is still in the future", () => {
    seatPlayer("a1", { isBot: 0, connected: 1 });
    db.prepare(
      "UPDATE mp_rooms SET countdown_target_at = ? WHERE code = 'a1'",
    ).run(new Date(Date.now() + 60_000).toISOString());

    expect(findElapsedCountdowns(db)).not.toContain("a1");
  });
});
