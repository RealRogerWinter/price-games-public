import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  countActiveAutoLobbies,
  countVisibleLobbies,
  spawnAutoLobby,
  closeIdleAutoLobby,
  pickModeForSpawn,
  decideSpawnTarget,
  runAutoLobbyTick,
} from "./manager";
import { setAutoLobbySettings } from "./settings";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

function insertRoom(opts: {
  code: string;
  status?: string;
  isPublic?: number;
  isAuto?: number;
  bots?: number;
  humans?: number;
  humansConnected?: number;
}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mp_rooms
       (code, host_player_id, creator_player_id, game_mode, category, password,
        status, current_round, total_rounds, created_at, last_activity_at,
        is_public, bot_count, bot_difficulty, is_daily_game, daily_date,
        is_auto_lobby)
     VALUES (?, 'host', 'host', 'classic', NULL, NULL, ?, 0, 6, ?, ?, ?, ?,
             'medium', 0, NULL, ?)`
  ).run(
    opts.code,
    opts.status ?? "lobby",
    now,
    now,
    opts.isPublic ?? 1,
    opts.bots ?? 0,
    opts.isAuto ?? 0,
  );
  for (let i = 0; i < (opts.humans ?? 0); i++) {
    const connected = i < (opts.humansConnected ?? opts.humans ?? 0) ? 1 : 0;
    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                               is_host, connected, joined_at, is_bot, is_disguised)
       VALUES (?, ?, ?, 'silhouette', ?, 0, ?, ?, 0, 0)`
    ).run(`h${opts.code}${i}`, opts.code, `human${i}`, `tok-${opts.code}-${i}`, connected, now);
  }
  for (let i = 0; i < (opts.bots ?? 0); i++) {
    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                               is_host, connected, joined_at, is_bot, is_disguised)
       VALUES (?, ?, ?, 'silhouette', ?, 0, 1, ?, 1, 0)`
    ).run(`b${opts.code}${i}`, opts.code, `bot${i}`, `bot-tok-${opts.code}-${i}`, now);
  }
}

describe("countActiveAutoLobbies", () => {
  it("counts only auto-lobby rooms in 'lobby' status", () => {
    insertRoom({ code: "a1", isAuto: 1, status: "lobby" });
    insertRoom({ code: "a2", isAuto: 1, status: "playing" }); // excluded
    insertRoom({ code: "r1", isAuto: 0, status: "lobby" }); // excluded
    expect(countActiveAutoLobbies(db)).toBe(1);
  });
});

describe("countVisibleLobbies", () => {
  it("counts public lobby rooms regardless of auto vs real", () => {
    insertRoom({ code: "a1", isAuto: 1, isPublic: 1, status: "lobby" });
    insertRoom({ code: "r1", isAuto: 0, isPublic: 1, status: "lobby" });
    insertRoom({ code: "r2", isAuto: 0, isPublic: 0, status: "lobby" }); // excluded (private)
    insertRoom({ code: "p1", isAuto: 0, isPublic: 1, status: "playing" }); // excluded (not joinable)
    expect(countVisibleLobbies(db)).toBe(2);
  });
});

describe("decideSpawnTarget", () => {
  it("returns a positive deficit (capped to burst limit) when below target", () => {
    // visible=2, target=6 → deficit 4, capped at SPAWN_BURST_CAP (3).
    expect(decideSpawnTarget({ visible: 2, target: 6 })).toBe(3);
    expect(decideSpawnTarget({ visible: 4, target: 6 })).toBe(2);
  });

  it("returns 0 when at or above target", () => {
    expect(decideSpawnTarget({ visible: 6, target: 6 })).toBe(0);
    expect(decideSpawnTarget({ visible: 8, target: 6 })).toBe(0);
  });

  it("never returns more than the spawn-burst cap", () => {
    expect(decideSpawnTarget({ visible: 0, target: 100 })).toBeLessThanOrEqual(3);
  });
});

describe("pickModeForSpawn", () => {
  it("returns one of the allowed modes when allowlist is non-empty", () => {
    const mode = pickModeForSpawn({ allowlist: ["classic", "bidding"], disabled: [] });
    expect(["classic", "bidding"]).toContain(mode);
  });

  it("falls back to all enabled modes when allowlist is empty", () => {
    const mode = pickModeForSpawn({ allowlist: [], disabled: ["bidding"] });
    expect(mode).not.toBe("bidding");
    expect(typeof mode).toBe("string");
  });

  it("returns null if every candidate is disabled", () => {
    const mode = pickModeForSpawn({
      allowlist: ["bidding"],
      disabled: ["bidding"],
    });
    expect(mode).toBeNull();
  });
});

describe("spawnAutoLobby round counts", () => {
  it("only ever uses values from {3, 5, 10, 15, 20}", () => {
    const valid = new Set([3, 5, 10, 15, 20]);
    for (let i = 0; i < 200; i++) {
      const code = spawnAutoLobby(db, { mode: "classic", botCount: 3, disguiseRatio: 50 });
      const row = db.prepare("SELECT total_rounds FROM mp_rooms WHERE code = ?").get(code!) as { total_rounds: number };
      expect(valid.has(row.total_rounds)).toBe(true);
    }
  });

  it("≥85% of spawns are 3 or 5 rounds (weight target is 90%)", () => {
    let shortCount = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      const code = spawnAutoLobby(db, { mode: "classic", botCount: 3, disguiseRatio: 50 });
      const row = db.prepare("SELECT total_rounds FROM mp_rooms WHERE code = ?").get(code!) as { total_rounds: number };
      if (row.total_rounds === 3 || row.total_rounds === 5) shortCount++;
    }
    // Wide bound below 90% to keep the test stable across seeds.
    expect(shortCount / N).toBeGreaterThan(0.85);
  });
});

describe("spawnAutoLobby", () => {
  it("creates a public lobby with is_auto_lobby=1, disguised + labeled bots, status=lobby", () => {
    const code = spawnAutoLobby(db, { mode: "classic", botCount: 4, disguiseRatio: 75 });
    expect(code).toBeTruthy();

    const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code!) as Record<string, unknown>;
    expect(room.is_auto_lobby).toBe(1);
    expect(room.is_public).toBe(1);
    expect(room.status).toBe("lobby");
    // bot_count records labeled bots only — disguised bots are excluded
    // so the wire payload can't be used to back-derive that "humans" are
    // actually bots. Players table still has 4 rows total.
    expect(room.bot_count).toBe(1);

    const players = db.prepare("SELECT * FROM mp_players WHERE room_code = ?").all(code!) as Array<Record<string, unknown>>;
    expect(players.length).toBe(4);
    for (const p of players) {
      expect(p.is_bot).toBe(1);
    }
    const disguised = players.filter((p) => p.is_disguised === 1);
    // 75% of 4 → 3 disguised; allow ±1 for rounding paths.
    expect(disguised.length).toBeGreaterThanOrEqual(2);
    expect(disguised.length).toBeLessThanOrEqual(4);
  });

  it("rejects invalid bot counts", () => {
    expect(spawnAutoLobby(db, { mode: "classic", botCount: 0, disguiseRatio: 50 })).toBeNull();
    expect(spawnAutoLobby(db, { mode: "classic", botCount: 99, disguiseRatio: 50 })).toBeNull();
  });

  it("does not leak the disguised count via mp_rooms.bot_count", () => {
    // A client doing playerCount - humanCount - botCount must NOT be able
    // to back-derive the disguise. Spawning a fully-disguised lobby and
    // asserting bot_count===0 (rather than 4) keeps that property locked
    // in regressing-ly.
    const code = spawnAutoLobby(db, { mode: "classic", botCount: 4, disguiseRatio: 100 });
    expect(code).toBeTruthy();
    const room = db.prepare("SELECT bot_count FROM mp_rooms WHERE code = ?").get(code!) as { bot_count: number };
    expect(room.bot_count).toBe(0);
    const players = db.prepare("SELECT COUNT(*) AS n FROM mp_players WHERE room_code = ?").get(code!) as { n: number };
    expect(players.n).toBe(4);
  });

  it("uses human-style names for disguised bots, Adjective-Animal for labeled", () => {
    const code = spawnAutoLobby(db, { mode: "classic", botCount: 5, disguiseRatio: 50 });
    expect(code).toBeTruthy();
    const players = db.prepare("SELECT display_name, is_disguised FROM mp_players WHERE room_code = ?").all(code!) as Array<{ display_name: string; is_disguised: number }>;
    for (const p of players) {
      const looksLikeAdjAnimal = /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(p.display_name);
      if (p.is_disguised === 1) {
        expect(looksLikeAdjAnimal).toBe(false);
      } else {
        expect(looksLikeAdjAnimal).toBe(true);
      }
    }
  });
});

describe("closeIdleAutoLobby", () => {
  it("deletes auto-lobby rooms with no human players", () => {
    insertRoom({ code: "a1", isAuto: 1, bots: 3 });
    expect(closeIdleAutoLobby(db, "a1")).toBe(true);
    const row = db.prepare("SELECT code FROM mp_rooms WHERE code = ?").get("a1");
    expect(row).toBeUndefined();
  });

  it("refuses to close a room with at least one human", () => {
    insertRoom({ code: "a1", isAuto: 1, bots: 2, humans: 1 });
    expect(closeIdleAutoLobby(db, "a1")).toBe(false);
    const row = db.prepare("SELECT code FROM mp_rooms WHERE code = ?").get("a1");
    expect(row).toBeTruthy();
  });

  it("refuses to close non-auto rooms even when idle", () => {
    insertRoom({ code: "r1", isAuto: 0, bots: 3 });
    expect(closeIdleAutoLobby(db, "r1")).toBe(false);
    const row = db.prepare("SELECT code FROM mp_rooms WHERE code = ?").get("r1");
    expect(row).toBeTruthy();
  });
});

describe("runAutoLobbyTick", () => {
  it("spawns nothing when admin master toggle is off", () => {
    setAutoLobbySettings(db, { enabled: false, targetCount: 6 });
    const result = runAutoLobbyTick(db);
    expect(result.spawned).toEqual([]);
    expect(result.churned).toBeNull();
    expect(countActiveAutoLobbies(db)).toBe(0);
  });

  it("spawns up to the burst cap toward the target when enabled", () => {
    setAutoLobbySettings(db, { enabled: true, targetCount: 6 });
    const result = runAutoLobbyTick(db);
    expect(result.spawned.length).toBeGreaterThan(0);
    expect(result.spawned.length).toBeLessThanOrEqual(3);
    expect(countActiveAutoLobbies(db)).toBe(result.spawned.length);
  });

  it("does not spawn beyond the target across multiple ticks", () => {
    setAutoLobbySettings(db, { enabled: true, targetCount: 4 });
    runAutoLobbyTick(db);
    runAutoLobbyTick(db);
    runAutoLobbyTick(db);
    expect(countVisibleLobbies(db)).toBeLessThanOrEqual(4);
  });

  it("counts existing real lobbies toward the visible target", () => {
    setAutoLobbySettings(db, { enabled: true, targetCount: 3 });
    insertRoom({ code: "real1", isAuto: 0, isPublic: 1, status: "lobby", humans: 1, humansConnected: 1 });
    insertRoom({ code: "real2", isAuto: 0, isPublic: 1, status: "lobby", humans: 1, humansConnected: 1 });
    runAutoLobbyTick(db);
    runAutoLobbyTick(db);
    // Real lobbies count toward the target (2), so at most 1 auto-lobby should spawn total.
    expect(countActiveAutoLobbies(db)).toBeLessThanOrEqual(1);
  });

  it("never churns auto-lobbies that have a connected human seated", () => {
    // Plant 8 auto-lobbies, half with humans seated. Run many ticks; humans
    // must never be evicted via churn even at p=0.20 per tick.
    setAutoLobbySettings(db, { enabled: true, targetCount: 8 });
    for (let i = 0; i < 4; i++) {
      insertRoom({ code: `auto-h${i}`, isAuto: 1, isPublic: 1, status: "lobby", bots: 3, humans: 1, humansConnected: 1 });
    }
    for (let i = 0; i < 4; i++) {
      insertRoom({ code: `auto-e${i}`, isAuto: 1, isPublic: 1, status: "lobby", bots: 3 });
    }
    for (let t = 0; t < 30; t++) runAutoLobbyTick(db);
    for (let i = 0; i < 4; i++) {
      const row = db.prepare("SELECT code FROM mp_rooms WHERE code = ?").get(`auto-h${i}`);
      expect(row).toBeTruthy();
    }
  });

  it("eventually churns idle auto-lobbies across many ticks", () => {
    // Statistical bound — across ~50 ticks with p=0.20, P(0 churns) is
    // ~1.4e-5. Test would be flaky at p too low, so cover the larger band.
    setAutoLobbySettings(db, { enabled: true, targetCount: 6 });
    runAutoLobbyTick(db);
    runAutoLobbyTick(db);
    const codesAfterSpawn = (db.prepare("SELECT code FROM mp_rooms WHERE is_auto_lobby = 1").all() as { code: string }[]).map((r) => r.code);
    const seenChurns = new Set<string>();
    for (let t = 0; t < 50; t++) {
      const result = runAutoLobbyTick(db);
      if (result.churned) seenChurns.add(result.churned);
    }
    // We didn't get pinned at zero churns over 50 ticks.
    expect(seenChurns.size).toBeGreaterThan(0);
    // Sanity: the codes we used to seed are at least valid 7-char nanoids.
    // We don't assert membership in `codesAfterSpawn` because the spawner
    // may have created new ones to refill after a churn, and those replacements
    // are valid churn targets in subsequent ticks.
    for (const code of seenChurns) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });
});
