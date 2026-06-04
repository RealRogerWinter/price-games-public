import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { SOCKET_EVENTS, MP_HOST_START_COUNTDOWN_MS } from "@price-game/shared";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  const dbMod = await import("../db");
  (dbMod as any).default = testDb;
  const stateMod = await import("./socketState");
  // Reset the per-test socket state so meta from a prior test never leaks.
  stateMod.cancelAllPendingDisconnects();
  // setSocketMeta is mutated in tests below; clear via setSocketMeta with
  // a sentinel and then delete is not exposed — easier to just create
  // unique socket IDs per test, which we do.
});

const { handleHostStartCountdown } = await import("./roomHandlers");
const { setSocketMeta } = await import("./socketState");

interface SeedRoomOpts {
  hostPlayerId?: string;
  status?: string;
  countdownTargetAt?: string | null;
}

function seedRoom(opts: SeedRoomOpts = {}): { code: string; hostPlayerId: string } {
  const hostPlayerId = opts.hostPlayerId ?? "host-p1";
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, selected_products, created_at, last_activity_at, countdown_target_at, countdown_started_at)
       VALUES ('ROOM', ?, 'classic', ?, 0, 10, '[]', ?, ?, ?, ?)`,
    )
    .run(
      hostPlayerId,
      opts.status ?? "lobby",
      now,
      now,
      opts.countdownTargetAt ?? null,
      opts.countdownTargetAt ? now : null,
    );
  testDb
    .prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at)
       VALUES (?, 'ROOM', 'Host', 'wizard', 'tok-host', 1, 0, ?)`,
    )
    .run(hostPlayerId, now);
  return { code: "ROOM", hostPlayerId };
}

function makeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as any, emit, to };
}

describe("handleHostStartCountdown", () => {
  it("rejects when caller is not the host", () => {
    const { hostPlayerId } = seedRoom();
    setSocketMeta("sock-imposter", {
      socketId: "sock-imposter",
      playerId: "p2-not-host",
      roomCode: "ROOM",
    } as any);
    const { io, emit } = makeIo();
    const cb = vi.fn();

    handleHostStartCountdown(io, { id: "sock-imposter" } as any, {}, cb);

    expect(cb).toHaveBeenCalledWith({ error: "Only the host can start the game" });
    expect(emit).not.toHaveBeenCalled();
    const row = testDb
      .prepare("SELECT countdown_target_at FROM mp_rooms WHERE code = 'ROOM'")
      .get() as { countdown_target_at: string | null };
    expect(row.countdown_target_at).toBeNull();
    void hostPlayerId;
  });

  it("rejects when room is past lobby status", () => {
    const { hostPlayerId } = seedRoom({ status: "playing" });
    setSocketMeta("sock-host-1", {
      socketId: "sock-host-1",
      playerId: hostPlayerId,
      roomCode: "ROOM",
    } as any);
    const { io, emit } = makeIo();
    const cb = vi.fn();

    handleHostStartCountdown(io, { id: "sock-host-1" } as any, {}, cb);

    expect(cb).toHaveBeenCalledWith({ error: "Game already in progress" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("writes countdown_target_at and emits ROOM_UPDATED with the room bare (not wrapped)", () => {
    const { hostPlayerId } = seedRoom();
    setSocketMeta("sock-host-2", {
      socketId: "sock-host-2",
      playerId: hostPlayerId,
      roomCode: "ROOM",
    } as any);
    const { io, to, emit } = makeIo();
    const cb = vi.fn();

    const before = Date.now();
    handleHostStartCountdown(io, { id: "sock-host-2" } as any, {}, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    const row = testDb
      .prepare(
        "SELECT countdown_target_at, countdown_started_at FROM mp_rooms WHERE code = 'ROOM'",
      )
      .get() as { countdown_target_at: string; countdown_started_at: string };
    expect(row.countdown_target_at).toBeTruthy();
    expect(row.countdown_started_at).toBeTruthy();
    const targetMs = new Date(row.countdown_target_at).getTime();
    expect(targetMs).toBeGreaterThanOrEqual(before + MP_HOST_START_COUNTDOWN_MS - 100);
    expect(targetMs).toBeLessThanOrEqual(before + MP_HOST_START_COUNTDOWN_MS + 1500);

    expect(to).toHaveBeenCalledWith("ROOM");
    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emit.mock.calls[0];
    expect(eventName).toBe(SOCKET_EVENTS.ROOM_UPDATED);
    // Critical: the payload must be the room object directly, not
    // wrapped in { room: ... } — the client patcher reads fields off
    // the first argument, and a wrapped payload would clobber state.
    expect(payload).toBeTruthy();
    expect((payload as any).code).toBe("ROOM");
    expect((payload as any).countdownTargetAt).toBe(row.countdown_target_at);
    expect((payload as any).room).toBeUndefined();
  });

  it("is idempotent under double-click (no-op when countdown is already set)", () => {
    const existingTarget = new Date(Date.now() + 5000).toISOString();
    const { hostPlayerId } = seedRoom({ countdownTargetAt: existingTarget });
    setSocketMeta("sock-host-3", {
      socketId: "sock-host-3",
      playerId: hostPlayerId,
      roomCode: "ROOM",
    } as any);
    const { io, emit } = makeIo();
    const cb = vi.fn();

    handleHostStartCountdown(io, { id: "sock-host-3" } as any, {}, cb);

    expect(cb).toHaveBeenCalledWith({ success: true });
    expect(emit).not.toHaveBeenCalled();
    const row = testDb
      .prepare("SELECT countdown_target_at FROM mp_rooms WHERE code = 'ROOM'")
      .get() as { countdown_target_at: string };
    expect(row.countdown_target_at).toBe(existingTarget);
  });
});
