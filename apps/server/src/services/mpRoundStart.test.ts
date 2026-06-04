/**
 * mpRoundStart analytics-emission tests.
 *
 * Pins down the three load-bearing invariants on `mp_game_started`:
 *   1. Fires only on the `lobby → playing` transition (not on subsequent
 *      `between_rounds → playing` round flips).
 *   2. Fires once per *real* player — bots and ghost-backed players are
 *      filtered so v2 counts match the per-real-player completion semantics
 *      enforced in `mpRoundEnd.saveToLeaderboard`.
 *   3. Skips real players with no `visitor_id` (the ingest pipeline requires
 *      visitor_id; emitting without one would silently no-op anyway).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 20);

  const dbMod = await import("../db");
  (dbMod as any).default = testDb;
});

const { startRound } = await import("./mpRoundStart");

function seedRoom(opts: {
  status: "lobby" | "between_rounds";
  currentRound?: number;
  totalRounds?: number;
  isDaily?: boolean;
}) {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO mp_rooms
        (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at, is_daily_game, daily_date)
       VALUES ('ROOM', 'host1', 'classic', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.status,
      opts.currentRound ?? 0,
      opts.totalRounds ?? 5,
      now,
      now,
      opts.isDaily ? 1 : 0,
      opts.isDaily ? "2026-04-28" : null,
    );
}

function seedPlayer(opts: {
  id: string;
  isHost?: boolean;
  visitorId?: string | null;
  userId?: string | null;
  isBot?: boolean;
  ghostUserId?: string | null;
  displayName?: string;
}) {
  testDb
    .prepare(
      `INSERT INTO mp_players
        (id, room_code, display_name, avatar, token, is_host, total_score, joined_at, user_id, visitor_id, is_bot, ghost_user_id)
       VALUES (?, 'ROOM', ?, 'wizard', ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.displayName ?? opts.id,
      `tok-${opts.id}`,
      opts.isHost ? 1 : 0,
      new Date().toISOString(),
      opts.userId ?? null,
      opts.visitorId ?? null,
      opts.isBot ? 1 : 0,
      opts.ghostUserId ?? null,
    );
}

describe("mp_game_started emission", () => {
  it("emits one event per real player on the lobby → playing transition", () => {
    seedRoom({ status: "lobby" });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });
    seedPlayer({ id: "p2", visitorId: "vis-p2" });
    seedPlayer({ id: "p3", visitorId: "vis-p3" });

    const result = startRound("ROOM", "host1", () => {});
    expect(result).not.toBeNull();

    const events = testDb
      .prepare("SELECT visitor_id, properties FROM events WHERE event_name = 'mp_game_started' ORDER BY visitor_id")
      .all() as Array<{ visitor_id: string; properties: string | null }>;
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.visitor_id)).toEqual(["vis-host", "vis-p2", "vis-p3"]);
    const props = JSON.parse(events[0].properties!);
    expect(props.room_code).toBe("ROOM");
    expect(props.game_mode).toBe("classic");
    expect(props.real_player_count).toBe(3);
  });

  it("does NOT emit on the between_rounds → playing transition (subsequent round)", () => {
    // Prior round already happened; status is now between_rounds. Starting a
    // new round must NOT count as a fresh game start — it's a round transition.
    seedRoom({ status: "between_rounds", currentRound: 1, totalRounds: 5 });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });
    seedPlayer({ id: "p2", visitorId: "vis-p2" });

    startRound("ROOM", "host1", () => {});

    const count = (
      testDb
        .prepare("SELECT COUNT(*) as c FROM events WHERE event_name = 'mp_game_started'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("filters out bot and ghost players", () => {
    // Ghost FK target — production schema enforces ghost_user_id REFERENCES
    // ghost_users(id). The test schema is permissive but we mirror semantics.
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS ghost_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_normalized TEXT NOT NULL,
        avatar TEXT NOT NULL,
        lifetime_score INTEGER NOT NULL DEFAULT 0,
        account_created_at TEXT NOT NULL,
        on_shift INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        daily_streak_current INTEGER NOT NULL DEFAULT 0,
        daily_streak_best INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString();
    testDb
      .prepare(
        `INSERT INTO ghost_users (id, username, username_normalized, avatar, account_created_at, created_at, updated_at)
         VALUES ('g1', 'Ghost', 'ghost', 'wizard', ?, ?, ?)`,
      )
      .run(now, now, now);

    seedRoom({ status: "lobby" });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-real" });
    seedPlayer({ id: "p2", isBot: true, visitorId: "vis-bot" });
    seedPlayer({ id: "p3", isBot: true, ghostUserId: "g1", visitorId: "vis-ghost" });

    startRound("ROOM", "host1", () => {});

    const events = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'mp_game_started'")
      .all() as Array<{ visitor_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].visitor_id).toBe("vis-real");
    // The properties' real_player_count should reflect the post-filter total.
    const propsRow = testDb
      .prepare("SELECT properties FROM events WHERE event_name = 'mp_game_started'")
      .get() as { properties: string };
    expect(JSON.parse(propsRow.properties).real_player_count).toBe(1);
  });

  it("skips real players with no visitor_id (anonymous-no-cookie players)", () => {
    seedRoom({ status: "lobby" });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });
    seedPlayer({ id: "p2", visitorId: null });

    startRound("ROOM", "host1", () => {});

    const events = testDb
      .prepare("SELECT visitor_id FROM events WHERE event_name = 'mp_game_started'")
      .all() as Array<{ visitor_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].visitor_id).toBe("vis-host");
  });

  // PR 6a — deterministic game_id assignment on the lobby→playing transition.

  it("mints a fresh current_game_id on lobby→playing and surfaces it in the dedup key + event properties", () => {
    seedRoom({ status: "lobby" });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });

    startRound("ROOM", "host1", () => {});

    const room = testDb
      .prepare("SELECT current_game_id FROM mp_rooms WHERE code = 'ROOM'")
      .get() as { current_game_id: string | null };
    expect(room.current_game_id).toBeTruthy();
    expect(room.current_game_id).toMatch(/^[0-9a-f-]{36}$/);

    const event = testDb
      .prepare(
        "SELECT client_event_id, properties FROM events WHERE event_name = 'mp_game_started'",
      )
      .get() as { client_event_id: string; properties: string };
    expect(event.client_event_id).toBe(
      `srv:mp_game_started:${room.current_game_id}:vis-host`,
    );
    expect(JSON.parse(event.properties).game_id).toBe(room.current_game_id);
  });

  it("preserves current_game_id across between_rounds → playing transitions (no double-emit of mp_game_started)", () => {
    seedRoom({ status: "lobby" });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });

    startRound("ROOM", "host1", () => {});
    const afterFirst = testDb
      .prepare("SELECT current_game_id FROM mp_rooms WHERE code = 'ROOM'")
      .get() as { current_game_id: string | null };
    const gameId1 = afterFirst.current_game_id!;

    // Simulate end-of-round: set status='between_rounds'.
    testDb
      .prepare("UPDATE mp_rooms SET status = 'between_rounds' WHERE code = 'ROOM'")
      .run();

    startRound("ROOM", "host1", () => {});
    const afterSecond = testDb
      .prepare("SELECT current_game_id FROM mp_rooms WHERE code = 'ROOM'")
      .get() as { current_game_id: string | null };
    expect(afterSecond.current_game_id).toBe(gameId1);

    // Only ONE mp_game_started — between_rounds doesn't fire a fresh start event.
    const count = (
      testDb
        .prepare("SELECT COUNT(*) as c FROM events WHERE event_name = 'mp_game_started'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("flags daily MP rooms in the event properties", () => {
    seedRoom({ status: "lobby", isDaily: true });
    seedPlayer({ id: "host1", isHost: true, visitorId: "vis-host" });

    startRound("ROOM", "host1", () => {});

    const propsRow = testDb
      .prepare("SELECT properties FROM events WHERE event_name = 'mp_game_started'")
      .get() as { properties: string };
    const props = JSON.parse(propsRow.properties);
    expect(props.is_daily_game).toBe(true);
  });
});
