/**
 * Tests for the analytics-events backfill script.
 *
 * Verifies the load-bearing invariants:
 *   1. One synthetic event per source row (mp_leaderboard / mp_rooms /
 *      daily_plays).
 *   2. Idempotent — rerunning produces zero new rows (the dedupe index on
 *      visitor_id + client_event_id absorbs duplicates).
 *   3. Bot/ghost rows are filtered (mp_leaderboard.ghost_user_id IS NULL
 *      filter; mp_players.is_bot=0 filter for host lookup).
 *   4. Synthetic events carry is_synthetic = 1 + properties.synthetic = 1.
 *   5. Rows with no resolvable visitor_id are skipped (counted, not failed).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedProducts } from "../src/test/dbHelper";

let testDb: DatabaseType;

vi.mock("../src/db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 5);
  const dbMod = await import("../src/db");
  (dbMod as any).default = testDb;
});

const { runBackfill } = await import("./backfill-analytics-events");

function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedRoom(opts: {
  code: string;
  hostVisitorId: string | null;
  hostUserId?: string | null;
  hostIsBot?: boolean;
  isDaily?: boolean;
  createdAtMs?: number;
}) {
  const created = isoNow(opts.createdAtMs ?? -3_600_000);
  testDb
    .prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at, is_daily_game, daily_date)
       VALUES (?, 'host-' || ?, 'classic', 'finished', 5, 5, ?, ?, ?, ?)`,
    )
    .run(opts.code, opts.code, created, created, opts.isDaily ? 1 : 0, opts.isDaily ? "2026-04-28" : null);
  testDb
    .prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id, visitor_id, is_bot)
       VALUES (?, ?, 'Alice', 'wizard', ?, 1, 4500, ?, ?, ?, ?)`,
    )
    .run(
      "host-" + opts.code,
      opts.code,
      "tok-host-" + opts.code,
      created,
      opts.hostUserId ?? null,
      opts.hostVisitorId,
      opts.hostIsBot ? 1 : 0,
    );
}

function seedLeaderboardRow(opts: {
  roomCode: string;
  playerName: string;
  visitorId: string | null;
  userId?: string | null;
  ghostUserId?: string | null;
  score?: number;
  placement?: number;
  playedAtMs?: number;
}) {
  const played = isoNow(opts.playedAtMs ?? -3_500_000);
  testDb
    .prepare(
      `INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at, user_id, ghost_user_id)
       VALUES (?, ?, ?, ?, 2, 'classic', ?, ?, ?)`,
    )
    .run(
      opts.playerName,
      opts.roomCode,
      opts.score ?? 1000,
      opts.placement ?? 1,
      played,
      opts.userId ?? null,
      opts.ghostUserId ?? null,
    );
  if (opts.visitorId !== null) {
    // Ensure a matching mp_players row exists for the visitor lookup. The
    // backfill script joins on (room_code, display_name, user_id).
    const existing = testDb
      .prepare("SELECT id FROM mp_players WHERE room_code = ? AND display_name = ?")
      .get(opts.roomCode, opts.playerName);
    if (!existing) {
      testDb
        .prepare(
          `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id, visitor_id)
           VALUES (?, ?, ?, 'wizard', ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          `pl-${opts.roomCode}-${opts.playerName}`,
          opts.roomCode,
          opts.playerName,
          `tok-${opts.roomCode}-${opts.playerName}`,
          opts.score ?? 1000,
          played,
          opts.userId ?? null,
          opts.visitorId,
        );
    }
  }
}

function seedDailyPlay(opts: {
  visitorId: string | null;
  userId?: string | null;
  sessionId: string;
  dailyDate: string;
  completedAtMs?: number;
  score?: number;
}) {
  const completed = isoNow(opts.completedAtMs ?? -7_200_000);
  testDb
    .prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, completed_at, visitor_id)
       VALUES (?, ?, ?, 'classic', ?, ?, ?, ?)`,
    )
    .run(
      opts.userId ?? null,
      opts.sessionId,
      opts.dailyDate,
      opts.score ?? 5000,
      completed,
      completed,
      opts.visitorId,
    );
}

describe("backfill-analytics-events", () => {
  it("synthesizes one mp_game_completed event per leaderboard row, skipping rows with no resolvable visitor", () => {
    seedRoom({ code: "ROOM1", hostVisitorId: "vis-host" });
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Alice", visitorId: "vis-alice" });
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Bob", visitorId: "vis-bob" });
    // Player whose mp_players row was never created (room cleanup) — should be skipped.
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Ghost", visitorId: null });

    const stats = runBackfill({ dryRun: false, skipMp: false, skipDaily: true });

    expect(stats.mpGamesCompleted).toBe(2);
    expect(stats.skippedNoVisitor).toBeGreaterThanOrEqual(1);

    const events = testDb
      .prepare(
        "SELECT visitor_id, properties, is_synthetic, mp_room_code FROM events WHERE event_name = 'mp_game_completed' ORDER BY visitor_id",
      )
      .all() as Array<{
        visitor_id: string;
        properties: string;
        is_synthetic: number;
        mp_room_code: string;
      }>;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.visitor_id).sort()).toEqual(["vis-alice", "vis-bob"]);
    expect(events.every((e) => e.is_synthetic === 1)).toBe(true);
    const props0 = JSON.parse(events[0].properties);
    expect(props0.synthetic).toBe(1);
    expect(props0.players_count).toBe(2);
  });

  it("skips ghost-backed leaderboard rows entirely (ghost_user_id IS NOT NULL)", () => {
    seedRoom({ code: "ROOMG", hostVisitorId: "vis-host" });
    // Ghost-credited row — already excluded from real-player counts.
    seedLeaderboardRow({
      roomCode: "ROOMG",
      playerName: "GhostFox",
      visitorId: "vis-ghost",
      ghostUserId: "g1",
    });
    seedLeaderboardRow({
      roomCode: "ROOMG",
      playerName: "RealHuman",
      visitorId: "vis-real",
    });

    const stats = runBackfill({ dryRun: false, skipMp: false, skipDaily: true });

    expect(stats.mpGamesCompleted).toBe(1);
    const events = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'mp_game_completed'")
      .all() as Array<{ visitor_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].visitor_id).toBe("vis-real");
  });

  it("synthesizes one mp_room_created per finished room, attributing to the host's visitor_id", () => {
    seedRoom({ code: "ROOM1", hostVisitorId: "vis-host-1" });
    seedRoom({ code: "ROOM2", hostVisitorId: "vis-host-2" });

    const stats = runBackfill({ dryRun: false, skipMp: false, skipDaily: true });

    expect(stats.mpRoomsCreated).toBe(2);
    const events = testDb
      .prepare(
        "SELECT visitor_id, mp_room_code FROM events WHERE event_name = 'mp_room_created' ORDER BY mp_room_code",
      )
      .all() as Array<{ visitor_id: string; mp_room_code: string }>;
    expect(events.map((e) => e.mp_room_code)).toEqual(["ROOM1", "ROOM2"]);
    expect(events.map((e) => e.visitor_id)).toEqual(["vis-host-1", "vis-host-2"]);
  });

  it("synthesizes daily_completed for SP and MP daily plays with correct via discriminator", () => {
    // SP daily — session_id is a bare UUID (no colon)
    seedDailyPlay({
      visitorId: "vis-sp",
      sessionId: "abcd-1234-uuid",
      dailyDate: "2026-04-28",
    });
    // MP daily — session_id is "<roomCode>:<playerId>"
    seedDailyPlay({
      visitorId: "vis-mp",
      sessionId: "ROOM1:player-1",
      dailyDate: "2026-04-28",
    });
    // Anonymous play with no visitor_id — must be skipped (can't attribute).
    seedDailyPlay({
      visitorId: null,
      sessionId: "anon-uuid",
      dailyDate: "2026-04-28",
    });

    const stats = runBackfill({ dryRun: false, skipMp: true, skipDaily: false });

    expect(stats.dailyCompleted).toBe(2);
    expect(stats.skippedNoVisitor).toBeGreaterThanOrEqual(1);

    const events = testDb
      .prepare(
        "SELECT visitor_id, properties FROM events WHERE event_name = 'daily_completed' ORDER BY visitor_id",
      )
      .all() as Array<{ visitor_id: string; properties: string }>;
    expect(events).toHaveLength(2);
    const sp = events.find((e) => e.visitor_id === "vis-sp")!;
    const mp = events.find((e) => e.visitor_id === "vis-mp")!;
    expect(JSON.parse(sp.properties).via).toBe("single_player");
    expect(JSON.parse(mp.properties).via).toBe("multiplayer");
  });

  it("is idempotent — re-running produces zero new events", () => {
    seedRoom({ code: "ROOM1", hostVisitorId: "vis-host" });
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Alice", visitorId: "vis-alice" });
    seedDailyPlay({ visitorId: "vis-sp", sessionId: "uuid-1", dailyDate: "2026-04-28" });

    const first = runBackfill({ dryRun: false, skipMp: false, skipDaily: false });
    expect(first.mpGamesCompleted + first.mpRoomsCreated + first.dailyCompleted).toBeGreaterThan(0);

    const initialEventCount = (
      testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }
    ).c;

    const second = runBackfill({ dryRun: false, skipMp: false, skipDaily: false });

    // No new inserts on the second run; everything bumps skippedAlreadyExists.
    expect(second.mpGamesCompleted).toBe(0);
    expect(second.mpRoomsCreated).toBe(0);
    expect(second.dailyCompleted).toBe(0);
    expect(second.skippedAlreadyExists).toBeGreaterThan(0);

    const finalEventCount = (
      testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }
    ).c;
    expect(finalEventCount).toBe(initialEventCount);
  });

  it("dry-run writes nothing", () => {
    seedRoom({ code: "ROOM1", hostVisitorId: "vis-host" });
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Alice", visitorId: "vis-alice" });

    runBackfill({ dryRun: true, skipMp: false, skipDaily: false });

    const count = (testDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("--skip-mp suppresses MP backfill but still runs daily backfill", () => {
    seedRoom({ code: "ROOM1", hostVisitorId: "vis-host" });
    seedLeaderboardRow({ roomCode: "ROOM1", playerName: "Alice", visitorId: "vis-alice" });
    seedDailyPlay({ visitorId: "vis-daily", sessionId: "uuid-2", dailyDate: "2026-04-28" });

    const stats = runBackfill({ dryRun: false, skipMp: true, skipDaily: false });

    expect(stats.mpGamesCompleted).toBe(0);
    expect(stats.mpRoomsCreated).toBe(0);
    expect(stats.dailyCompleted).toBe(1);
  });

  it("skips ambiguous mp_leaderboard rows when two anon players in the same room shared a display_name", () => {
    // Two distinct anonymous players, same room, same display_name. Neither
    // has a user_id, so the (room_code + display_name + user_id-equality)
    // lookup matches BOTH. Picking either visitor_id arbitrarily would
    // mis-attribute one player's row to the other's visitor cohort —
    // skip the row instead and bump skippedNoVisitor.
    seedRoom({ code: "AMBIG", hostVisitorId: "vis-host" });
    // Manually seed two anon mp_players rows with the same display_name.
    const now = isoNow(-3_500_000);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES ('p-ambig-1', 'AMBIG', 'Player', 'wizard', 't-ambig-1', 0, 0, ?, 'vis-a')`,
      )
      .run(now);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES ('p-ambig-2', 'AMBIG', 'Player', 'wizard', 't-ambig-2', 0, 0, ?, 'vis-b')`,
      )
      .run(now);
    // Two leaderboard rows with the same display_name, one for each player.
    seedLeaderboardRow({ roomCode: "AMBIG", playerName: "Player", visitorId: null, score: 1000 });
    seedLeaderboardRow({ roomCode: "AMBIG", playerName: "Player", visitorId: null, score: 800 });

    const stats = runBackfill({ dryRun: false, skipMp: false, skipDaily: true });

    expect(stats.mpGamesCompleted).toBe(0);
    expect(stats.skippedNoVisitor).toBeGreaterThanOrEqual(2);
    const events = testDb
      .prepare("SELECT COUNT(*) AS c FROM events WHERE event_name = 'mp_game_completed'")
      .get() as { c: number };
    expect(events.c).toBe(0);
  });

  it("attributes both leaderboard rows to the same player when an anon player rejoins (one visitor_id, two mp_players rows)", () => {
    // The collapse case: same visitor_id appears twice under the same
    // display_name (player rejoined, creating a second mp_players row).
    // The Set-of-distinct-visitor_ids collapses to size 1 → use it.
    seedRoom({ code: "REJOIN", hostVisitorId: "vis-host" });
    const now = isoNow(-3_500_000);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES ('p-rejoin-1', 'REJOIN', 'Carol', 'wizard', 't-rejoin-1', 0, 0, ?, 'vis-carol')`,
      )
      .run(now);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, visitor_id)
         VALUES ('p-rejoin-2', 'REJOIN', 'Carol', 'wizard', 't-rejoin-2', 0, 0, ?, 'vis-carol')`,
      )
      .run(now);
    seedLeaderboardRow({ roomCode: "REJOIN", playerName: "Carol", visitorId: null });

    const stats = runBackfill({ dryRun: false, skipMp: false, skipDaily: true });

    expect(stats.mpGamesCompleted).toBe(1);
    const event = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'mp_game_completed'")
      .get() as { visitor_id: string };
    expect(event.visitor_id).toBe("vis-carol");
  });
});
