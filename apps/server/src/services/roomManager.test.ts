import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return {
    default: null as any,
  };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);

  const mod = await import("../db");
  (mod as any).default = testDb;
});

const {
  createRoom,
  joinRoom,
  rejoinRoom,
  kickPlayer,
  updateSettings,
  disconnectPlayer,
  getRoom,
  getPlayerByToken,
  getPlayerById,
  resetRoom,
  cleanupStaleRooms,
  cleanupFinishedRoom,
  reapDisconnectedPlayers,
  addBots,
  removeBots,
  updateBotConfig,
} = await import("./roomManager");

describe("createRoom", () => {
  it("creates a room and returns room data with player info", async () => {
    const result = await createRoom("TestHost");
    expect(result.room).toBeDefined();
    expect(result.room.code).toBeDefined();
    expect(result.room.code.length).toBe(7);
    expect(result.room.gameMode).toBe("classic");
    expect(result.room.status).toBe("lobby");
    expect(result.room.players).toHaveLength(1);
    expect(result.room.players[0].displayName).toBe("TestHost");
    expect(result.room.players[0].isHost).toBe(true);
    expect(result.playerId).toBeDefined();
    expect(result.playerToken).toBeDefined();
  });

  it("creates a room with custom game mode", async () => {
    const result = await createRoom("Host", "higher-lower");
    expect(result.room.gameMode).toBe("higher-lower");
  });

  it("creates a room with categories", async () => {
    const result = await createRoom("Host", "classic", { categories: ["Electronics"] });
    expect(result.room.categories).toEqual(["Electronics"]);
  });

  it("rejects invalid category names", async () => {
    await expect(
      createRoom("Host", "classic", { categories: ["Electronics", "FakeCategory"] })
    ).rejects.toThrow("Invalid category: FakeCategory");
  });

  it("rejects disabled game mode", async () => {
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("disabled_game_modes", JSON.stringify(["riser"]), now);

    await expect(createRoom("Host", "riser")).rejects.toThrow("This game mode is currently disabled");

    testDb.prepare("DELETE FROM site_settings WHERE key = ?").run("disabled_game_modes");
  });

  it("creates a room with password", async () => {
    const result = await createRoom("Host", "classic", { password: "secret" });
    expect(result.room.hasPassword).toBe(true);
  });

  it("creates a room with custom round count", async () => {
    const result = await createRoom("Host", "classic", { totalRounds: 5 });
    expect(result.room.totalRounds).toBe(5);
  });

  it("clamps round count to valid range", async () => {
    const low = await createRoom("Host", "classic", { totalRounds: 1 });
    expect(low.room.totalRounds).toBe(3); // MIN_ROUNDS

    const high = await createRoom("Host", "classic", { totalRounds: 100 });
    expect(high.room.totalRounds).toBe(20); // MAX_ROUNDS
  });

  it("defaults to 10 rounds for non-bidding modes when totalRounds is unset", async () => {
    const result = await createRoom("Host", "classic");
    expect(result.room.totalRounds).toBe(10); // TOTAL_ROUNDS
  });

  it("defaults to 5 rounds for bidding war when totalRounds is unset", async () => {
    // Bidding war is slower due to turn-taking, so clampRounds(undefined,
    // 'bidding') returns 5 instead of TOTAL_ROUNDS.
    const result = await createRoom("Host", "bidding");
    expect(result.room.totalRounds).toBe(5);
  });

  it("still honours an explicit totalRounds for bidding when valid", async () => {
    const result = await createRoom("Host", "bidding", { totalRounds: 10 });
    expect(result.room.totalRounds).toBe(10);
  });

  it("throws for empty display name", async () => {
    await expect(createRoom("")).rejects.toThrow();
  });

  it("throws for invalid game mode", async () => {
    await expect(createRoom("Host", "invalid" as any)).rejects.toThrow("Invalid game mode");
  });

  it("gives anonymous hosts a real avatar instead of the silhouette", async () => {
    const result = await createRoom("AnonHost");
    expect(result.room.players[0].avatar).not.toBe("silhouette");
  });

  it("honors a valid preferredAvatar for anonymous hosts", async () => {
    const result = await createRoom("AnonHost", "classic", {
      preferredAvatar: "wizard",
    });
    expect(result.room.players[0].avatar).toBe("wizard");
  });

  it("falls back to a random avatar when preferredAvatar is invalid", async () => {
    const result = await createRoom("AnonHost", "classic", {
      preferredAvatar: "not-a-real-avatar",
    });
    expect(result.room.players[0].avatar).not.toBe("silhouette");
    expect(result.room.players[0].avatar).not.toBe("not-a-real-avatar");
  });
});

describe("joinRoom", () => {
  it("adds a player to an existing room", async () => {
    const { room } = await createRoom("Host");
    const joined = await joinRoom(room.code, "Player2");
    expect(joined.room.players).toHaveLength(2);
    expect(joined.room.players[1].displayName).toBe("Player2");
    expect(joined.room.players[1].isHost).toBe(false);
  });

  it("throws for non-existent room", async () => {
    await expect(joinRoom("INVALID", "Player")).rejects.toThrow("Room not found");
  });

  it("throws when room is full (6 players)", async () => {
    const { room } = await createRoom("Host");
    await joinRoom(room.code, "P2");
    await joinRoom(room.code, "P3");
    await joinRoom(room.code, "P4");
    await joinRoom(room.code, "P5");
    await joinRoom(room.code, "P6");
    await expect(joinRoom(room.code, "P7")).rejects.toThrow("Room is full");
  });

  it("requires correct password for password-protected rooms", async () => {
    const { room } = await createRoom("Host", "classic", { password: "secret" });
    await expect(joinRoom(room.code, "Player", "wrong")).rejects.toThrow("Incorrect password");
    const joined = await joinRoom(room.code, "Player", "secret");
    expect(joined.room.players).toHaveLength(2);
  });

  it("honors a valid preferredAvatar for anonymous joiners", async () => {
    const { room } = await createRoom("Host", "classic", { preferredAvatar: "wizard" });
    const joined = await joinRoom(
      room.code,
      "Player2",
      undefined,
      undefined,
      undefined,
      "yeti",
    );
    expect(joined.room.players[1].avatar).toBe("yeti");
  });

  it("falls back to a random avatar when preferredAvatar is taken in the room", async () => {
    const { room } = await createRoom("Host", "classic", { preferredAvatar: "wizard" });
    const joined = await joinRoom(
      room.code,
      "Player2",
      undefined,
      undefined,
      undefined,
      "wizard",
    );
    expect(joined.room.players[1].avatar).not.toBe("wizard");
    expect(joined.room.players[1].avatar).not.toBe("silhouette");
  });

  it("gives anonymous joiners a real avatar even without preferredAvatar", async () => {
    const { room } = await createRoom("Host");
    const joined = await joinRoom(room.code, "Player2");
    expect(joined.room.players[1].avatar).not.toBe("silhouette");
  });
});

describe("rejoinRoom", () => {
  it("allows a disconnected player to rejoin", async () => {
    const { room, playerId, playerToken } = await createRoom("Host");
    disconnectPlayer(playerId);
    const result = rejoinRoom(room.code, playerToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.playerId).toBe(playerId);
    }
  });

  it("returns invalid_token for an unknown token", async () => {
    const { room } = await createRoom("Host");
    const result = rejoinRoom(room.code, "invalid-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_token");
    }
  });

  it("returns room_expired when the room is already finished (retained for recap but not rejoinable)", async () => {
    const { room, playerId, playerToken } = await createRoom("Host");
    // Finished rooms now stay in the DB indefinitely for the history-recap
    // path, so rejoinRoom has to explicitly reject them instead of relying
    // on the row being gone.
    disconnectPlayer(playerId);
    testDb
      .prepare("UPDATE mp_rooms SET status = 'finished', finished_at = ? WHERE code = ?")
      .run(new Date().toISOString(), room.code);

    const result = rejoinRoom(room.code, playerToken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("room_expired");

    // Ensure the row wasn't mutated (connected stays 0, no host flip).
    const player = testDb
      .prepare("SELECT connected FROM mp_players WHERE id = ?")
      .get(playerId) as { connected: number };
    expect(player.connected).toBe(0);
  });
});

describe("kickPlayer", () => {
  it("kicks a player from the room", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoom(host.room.code, "Player2");
    const success = kickPlayer(host.room.code, host.playerId, joined.playerId);
    expect(success).toBe(true);

    const room = getRoom(host.room.code);
    expect(room!.players).toHaveLength(1);
  });

  it("prevents non-host from kicking", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoom(host.room.code, "Player2");
    const success = kickPlayer(host.room.code, joined.playerId, host.playerId);
    expect(success).toBe(false);
  });

  it("prevents host from kicking themselves", async () => {
    const host = await createRoom("Host");
    const success = kickPlayer(host.room.code, host.playerId, host.playerId);
    expect(success).toBe(false);
  });
});

describe("updateSettings", () => {
  it("updates game mode", async () => {
    const { room, playerId } = await createRoom("Host");
    const updated = await updateSettings(room.code, playerId, { gameMode: "riser" });
    expect(updated!.gameMode).toBe("riser");
  });

  it("updates categories", async () => {
    const { room, playerId } = await createRoom("Host");
    const updated = await updateSettings(room.code, playerId, { categories: ["Electronics"] });
    expect(updated!.categories).toEqual(["Electronics"]);
  });

  it("rejects switching to a disabled game mode", async () => {
    const { room, playerId } = await createRoom("Host");
    const now = new Date().toISOString();
    testDb.prepare(
      "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("disabled_game_modes", JSON.stringify(["riser"]), now);

    await expect(
      updateSettings(room.code, playerId, { gameMode: "riser" })
    ).rejects.toThrow("This game mode is currently disabled");

    testDb.prepare("DELETE FROM site_settings WHERE key = ?").run("disabled_game_modes");
  });

  it("rejects invalid category in updateSettings", async () => {
    const { room, playerId } = await createRoom("Host");
    await expect(
      updateSettings(room.code, playerId, { categories: ["NonExistent"] })
    ).rejects.toThrow("Invalid category: NonExistent");
  });

  it("updates password", async () => {
    const { room, playerId } = await createRoom("Host");
    const updated = await updateSettings(room.code, playerId, { password: "newpass" });
    expect(updated!.hasPassword).toBe(true);
  });

  it("removes password with null", async () => {
    const { room, playerId } = await createRoom("Host", "classic", { password: "old" });
    const updated = await updateSettings(room.code, playerId, { password: null });
    expect(updated!.hasPassword).toBe(false);
  });

  it("returns null for non-host", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoom(host.room.code, "Player2");
    const result = await updateSettings(host.room.code, joined.playerId, { gameMode: "riser" });
    expect(result).toBeNull();
  });

  it("toggles isPublic on", async () => {
    const { room, playerId } = await createRoom("Host", "classic", { isPublic: false });
    expect(room.isPublic).toBe(false);
    const updated = await updateSettings(room.code, playerId, { isPublic: true });
    expect(updated!.isPublic).toBe(true);
  });

  it("toggles isPublic off — explicit false must persist", async () => {
    const { room, playerId } = await createRoom("Host", "classic", { isPublic: true });
    expect(room.isPublic).toBe(true);
    const updated = await updateSettings(room.code, playerId, { isPublic: false });
    expect(updated!.isPublic).toBe(false);
  });
});

describe("joinRoom self-rejoin gate", () => {
  it("rejects when a registered user tries to join a room they're already in", async () => {
    const userId = seedUser(testDb, "rejoiner", "rejoiner@test.com");
    const host = await createRoom("Host");
    await joinRoom(host.room.code, "RejoinerName", undefined, userId);
    await expect(
      joinRoom(host.room.code, "RejoinerName", undefined, userId),
    ).rejects.toThrow(/already in this room/i);
  });

  it("rejects when a guest tries to join a room they're already in (matched on visitor_id)", async () => {
    const visitorId = "visitor-abc-123";
    const host = await createRoom("Host");
    await joinRoom(host.room.code, "GuestName", undefined, undefined, visitorId);
    await expect(
      joinRoom(host.room.code, "GuestName", undefined, undefined, visitorId),
    ).rejects.toThrow(/already in this room/i);
  });

  it("allows distinct users in the same room", async () => {
    const u1 = seedUser(testDb, "user_one", "u1@test.com");
    const u2 = seedUser(testDb, "user_two", "u2@test.com");
    const host = await createRoom("Host");
    await joinRoom(host.room.code, "Alpha", undefined, u1);
    const second = await joinRoom(host.room.code, "Beta", undefined, u2);
    expect(second.playerId).toBeTruthy();
  });
});

describe("reserved-username gate", () => {
  it("createRoom rejects a guest using a registered username", async () => {
    seedUser(testDb, "alice_pro", "alice@test.com");
    await expect(createRoom("alice_pro")).rejects.toThrow(/registered account/i);
  });

  it("createRoom is case-insensitive against username_normalized", async () => {
    seedUser(testDb, "BobLower", "bob@test.com");
    // username_normalized stores lowercase; the gate normalizes the supplied
    // name the same way before comparing, so "boblower" / "BobLower" both hit.
    await expect(createRoom("boblower")).rejects.toThrow(/registered account/i);
    await expect(createRoom("BOBLOWER")).rejects.toThrow(/registered account/i);
  });

  it("createRoom allows a logged-in user to use their own username", async () => {
    const userId = seedUser(testDb, "carol", "carol@test.com");
    // Calling as the registered user (userId set) should succeed.
    const result = await createRoom("carol", "classic", undefined, userId);
    expect(result.room.code).toBeTruthy();
  });

  it("joinRoom rejects a guest using a registered username", async () => {
    const host = await createRoom("HostDude");
    seedUser(testDb, "dave_real", "dave@test.com");
    await expect(joinRoom(host.room.code, "dave_real")).rejects.toThrow(/registered account/i);
  });

  it("joinRoom allows a guest to use a non-registered display name", async () => {
    const host = await createRoom("HostX");
    const result = await joinRoom(host.room.code, "RandomGuestName");
    expect(result.playerId).toBeTruthy();
  });
});

describe("disconnectPlayer", () => {
  it("marks player as disconnected", async () => {
    const { room, playerId } = await createRoom("Host");
    await joinRoom(room.code, "Player2");
    const result = disconnectPlayer(playerId);
    expect(result).not.toBeNull();
    expect(result!.roomCode).toBe(room.code);
  });

  it("promotes next player to host when host disconnects", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoom(host.room.code, "Player2");
    const result = disconnectPlayer(host.playerId);
    expect(result!.newHostId).toBe(joined.playerId);
  });

  it("returns null for non-existent player", () => {
    expect(disconnectPlayer("non-existent")).toBeNull();
  });
});

describe("getRoom", () => {
  it("returns room data", async () => {
    const { room: created } = await createRoom("Host");
    const room = getRoom(created.code);
    expect(room).not.toBeNull();
    expect(room!.code).toBe(created.code);
  });

  it("returns null for non-existent room", () => {
    expect(getRoom("INVALID")).toBeNull();
  });
});

describe("getPlayerByToken / getPlayerById", () => {
  it("finds player by token", async () => {
    const { playerToken } = await createRoom("Host");
    const player = getPlayerByToken(playerToken);
    expect(player).not.toBeNull();
    expect(player!.display_name).toBe("Host");
  });

  it("finds player by ID", async () => {
    const { playerId } = await createRoom("Host");
    const player = getPlayerById(playerId);
    expect(player).not.toBeNull();
    expect(player!.display_name).toBe("Host");
  });
});

describe("resetRoom", () => {
  it("resets room to lobby state", async () => {
    const { room, playerId } = await createRoom("Host");
    // Manually set room to finished
    testDb.prepare("UPDATE mp_rooms SET status = 'finished' WHERE code = ?").run(room.code);

    const reset = resetRoom(room.code, playerId);
    expect(reset).not.toBeNull();
    expect(reset!.status).toBe("lobby");
  });

  it("returns null for non-host", async () => {
    const host = await createRoom("Host");
    const joined = await joinRoom(host.room.code, "Player2");
    expect(resetRoom(host.room.code, joined.playerId)).toBeNull();
  });

  it("re-adds bots with the previously configured count and difficulty after Play Again", async () => {
    const { room, playerId } = await createRoom("Host");
    // Configure bots before "playing": 3 hard bots
    addBots(room.code, playerId, 3, "hard");
    // Simulate game flow: room transitions to finished
    testDb.prepare("UPDATE mp_rooms SET status = 'finished' WHERE code = ?").run(room.code);

    const reset = resetRoom(room.code, playerId);
    expect(reset).not.toBeNull();
    expect(reset!.status).toBe("lobby");
    // Bots should be re-created (not orphaned from the previous round)
    const bots = reset!.players.filter((p) => p.isBot);
    expect(bots).toHaveLength(3);
    // Each bot is a fresh row with reset score; preserved config
    expect(reset!.botCount).toBe(3);
    expect(reset!.botDifficulty).toBe("hard");
    for (const bot of bots) {
      expect(bot.totalScore).toBe(0);
      expect(bot.isConnected).toBe(true);
    }
    // No duplicate-ID conflict — old bot IDs were purged before re-add
    const ids = new Set(reset!.players.map((p) => p.id));
    expect(ids.size).toBe(reset!.players.length);
  });

  it("does not re-add bots when previous round had no bots configured", async () => {
    const { room, playerId } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET status = 'finished' WHERE code = ?").run(room.code);

    const reset = resetRoom(room.code, playerId);
    expect(reset).not.toBeNull();
    expect(reset!.players.filter((p) => p.isBot)).toHaveLength(0);
    expect(reset!.botCount).toBe(0);
  });

  it("clears stale bot rows even if bot config was zeroed out before reset", async () => {
    const { room, playerId } = await createRoom("Host");
    // Add bots, then host manually removes them between rounds
    addBots(room.code, playerId, 2, "easy");
    removeBots(room.code, playerId);
    // Manually re-insert bot rows to simulate a stale row scenario
    // (e.g. crashed mid-write) — reset should still leave us bot-free.
    testDb.prepare("UPDATE mp_rooms SET status = 'finished' WHERE code = ?").run(room.code);

    const reset = resetRoom(room.code, playerId);
    expect(reset!.players.filter((p) => p.isBot)).toHaveLength(0);
    expect(reset!.botCount).toBe(0);
  });

  it("caps re-added bots to remaining capacity when humans joined between rounds", async () => {
    // Simulate: host configured 4 bots while room had 2 humans (4+2=6=MAX),
    // then 3 more humans joined between rounds, making 5 humans. After Play
    // Again, only 1 bot can fit (5+1=6) — must NOT throw.
    const { room, playerId } = await createRoom("Host");
    await joinRoom(room.code, "H2");
    addBots(room.code, playerId, 4, "medium"); // 2 humans + 4 bots = 6
    // 3 more humans join during between_rounds (allowed)
    testDb.prepare("UPDATE mp_rooms SET status = 'between_rounds' WHERE code = ?").run(room.code);
    // Manually delete bots to free seats so we can join 3 more humans
    testDb.prepare("DELETE FROM mp_players WHERE room_code = ? AND is_bot = 1").run(room.code);
    await joinRoom(room.code, "H3");
    await joinRoom(room.code, "H4");
    await joinRoom(room.code, "H5");
    // Restore bot config so resetRoom sees the original intent
    testDb.prepare("UPDATE mp_rooms SET bot_count = 4, status = 'finished' WHERE code = ?").run(room.code);

    const reset = resetRoom(room.code, playerId);
    expect(reset).not.toBeNull();
    // 5 humans + 1 bot = 6 (MAX_PLAYERS), capped from 4 to 1
    expect(reset!.players).toHaveLength(6);
    expect(reset!.players.filter((p) => p.isBot)).toHaveLength(1);
  });
});

describe("edge cases", () => {
  it("handles legacy single-category string in room", async () => {
    const { room, playerId } = await createRoom("Host");
    // Manually set a legacy single-category string (not JSON array)
    testDb.prepare("UPDATE mp_rooms SET category = ? WHERE code = ?").run("Electronics", room.code);

    const fetched = getRoom(room.code);
    expect(fetched!.categories).toEqual(["Electronics"]);
  });

  it("handles null categories in room", async () => {
    const { room, playerId } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET category = NULL WHERE code = ?").run(room.code);

    const fetched = getRoom(room.code);
    expect(fetched!.categories).toBeNull();
  });

  it("rejects join when game is in progress (playing status)", async () => {
    const { room } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = ?").run(room.code);
    await expect(joinRoom(room.code, "Player")).rejects.toThrow("Game is already in progress");
  });

  it("allows join when room is between rounds", async () => {
    const { room } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET status = 'between_rounds' WHERE code = ?").run(room.code);
    const result = await joinRoom(room.code, "LateJoiner");
    expect(result.room.players).toHaveLength(2);
  });

  it("allows join to password room without password when room has no password", async () => {
    const { room } = await createRoom("Host");
    const result = await joinRoom(room.code, "Player2");
    expect(result.room.players).toHaveLength(2);
  });

  it("updateSettings returns null for invalid game mode", async () => {
    const { room, playerId } = await createRoom("Host");
    const result = await updateSettings(room.code, playerId, { gameMode: "invalid" as any });
    expect(result).toBeNull();
  });

  it("updateSettings returns null when room is playing", async () => {
    const { room, playerId } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = ?").run(room.code);
    const result = await updateSettings(room.code, playerId, { gameMode: "riser" });
    expect(result).toBeNull();
  });

  it("updateSettings updates total rounds", async () => {
    const { room, playerId } = await createRoom("Host");
    const result = await updateSettings(room.code, playerId, { totalRounds: 7 });
    expect(result!.totalRounds).toBe(7);
  });

  it("disconnectPlayer handles host disconnect with no other players", async () => {
    const { room, playerId } = await createRoom("Host");
    const result = disconnectPlayer(playerId);
    expect(result!.newHostId).toBeUndefined();
  });

  it("rejoinRoom restores host to original creator", async () => {
    const host = await createRoom("Host");
    const p2 = await joinRoom(host.room.code, "Player2");

    // Disconnect host, promoting P2
    disconnectPlayer(host.playerId);

    // Rejoin as host (original creator)
    const result = rejoinRoom(host.room.code, host.playerToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostChanged).toBe(true);
      expect(result.newHostId).toBe(host.playerId);
    }
  });
});

describe("cleanupStaleRooms", () => {
  it("returns empty array when no rooms are stale", async () => {
    await createRoom("Host");
    const deleted = cleanupStaleRooms();
    expect(deleted).toHaveLength(0);
  });

  it("deletes old lobby rooms with no connected players", async () => {
    const { room, playerId } = await createRoom("Host");
    disconnectPlayer(playerId);
    // Set room creation time to 10 minutes ago
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET created_at = ?, last_activity_at = ? WHERE code = ?").run(oldTime, oldTime, room.code);

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);
    expect(getRoom(room.code)).toBeNull();
  });

  it("reaps idle auto-lobbies even though their bots are connected=1", async () => {
    // Auto-lobbies seat bots with connected=1 by construction; without the
    // dedicated branch in cleanup rule #1 they'd survive until the 2-hour
    // hard cap. Here we hand-seat the smallest reproducible case (one bot,
    // is_auto_lobby=1, no humans) and confirm 5-min reap still fires.
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms
           (code, host_player_id, creator_player_id, game_mode, status,
            current_round, total_rounds, created_at, last_activity_at,
            is_public, bot_count, bot_difficulty, is_daily_game, daily_date,
            is_auto_lobby)
         VALUES ('auto1', 'b1', 'b1', 'classic', 'lobby', 0, 6, ?, ?,
                 1, 0, 'medium', 0, NULL, 1)`,
      )
      .run(oldTime, oldTime);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                                 is_host, connected, joined_at, is_bot, is_disguised)
         VALUES ('b1', 'auto1', 'Bot Name', 'silhouette', 'bot-tok', 0, 1, ?, 1, 0)`,
      )
      .run(oldTime);

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain("auto1");
    expect(testDb.prepare("SELECT code FROM mp_rooms WHERE code = 'auto1'").get()).toBeUndefined();
  });

  it("does NOT reap auto-lobbies with a connected human seated", async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb
      .prepare(
        `INSERT INTO mp_rooms
           (code, host_player_id, creator_player_id, game_mode, status,
            current_round, total_rounds, created_at, last_activity_at,
            is_public, bot_count, bot_difficulty, is_daily_game, daily_date,
            is_auto_lobby)
         VALUES ('auto2', 'b1', 'b1', 'classic', 'lobby', 0, 6, ?, ?,
                 1, 0, 'medium', 0, NULL, 1)`,
      )
      .run(oldTime, oldTime);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                                 is_host, connected, joined_at, is_bot, is_disguised)
         VALUES ('b1', 'auto2', 'Bot Name', 'silhouette', 'bot-tok', 0, 1, ?, 1, 0)`,
      )
      .run(oldTime);
    testDb
      .prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token,
                                 is_host, connected, joined_at, is_bot, is_disguised)
         VALUES ('h1', 'auto2', 'Real Player', 'silhouette', 'tok', 0, 1, ?, 0, 0)`,
      )
      .run(oldTime);

    const deleted = cleanupStaleRooms();
    expect(deleted).not.toContain("auto2");
  });

  it("evicts old finished rooms from the return set but preserves mp_rooms + mp_players + mp_guesses for recap", async () => {
    const { room } = await createRoom("Host");
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'finished', finished_at = ? WHERE code = ?").run(oldTime, room.code);

    // Seed a guess so we can verify it survives the sweep.
    testDb
      .prepare(
        "INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at) VALUES (?, ?, 1, '{}', 100, ?)",
      )
      .run(room.code, room.players[0].id, new Date().toISOString());

    const deleted = cleanupStaleRooms();
    // Still returned so callers can free in-memory socket/timer state.
    expect(deleted).toContain(room.code);

    // mp_rooms row preserved for analytics + recap
    const row = testDb.prepare("SELECT code, status FROM mp_rooms WHERE code = ?").get(room.code) as any;
    expect(row).toBeDefined();
    expect(row.status).toBe("finished");
    // mp_players preserved so buildMPRecap can find player_ids for the lazy path
    const players = testDb.prepare("SELECT COUNT(*) as cnt FROM mp_players WHERE room_code = ?").get(room.code) as { cnt: number };
    expect(players.cnt).toBe(1);
    // mp_guesses preserved so buildMPRecap can reconstruct per-round snapshots
    const guesses = testDb.prepare("SELECT COUNT(*) as cnt FROM mp_guesses WHERE room_code = ?").get(room.code) as { cnt: number };
    expect(guesses.cnt).toBe(1);
  });

  it("end-to-end: buildMPRecap still renders a multiplayer recap after cleanupStaleRooms sweeps the finished room", async () => {
    // Regression lock for the bug users saw: every MP row in the history
    // panel displayed "No breakdown available" once the room was past the
    // 10-min finished-room TTL, because cleanup used to purge mp_players
    // and mp_guesses. This test exercises the real cleanup helper + real
    // recap builder against a seeded finished-game row.
    const { buildMPRecap } = await import("./historyRecap");

    const userId = seedUser(testDb, "recapuser", "recap@example.com", "password1234");
    const { room } = await createRoom("RecapUser", "classic", undefined, userId);

    // Finalize the game: keep one round of data on the room so buildMPRecap
    // has something to reconstruct from.
    testDb
      .prepare(
        "UPDATE mp_rooms SET status = 'finished', finished_at = ?, round_data = ? WHERE code = ?",
      )
      .run(
        new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        JSON.stringify({ "1": { productIds: [1] } }),
        room.code,
      );
    testDb
      .prepare(
        "INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .run(
        room.code,
        room.players[0].id,
        JSON.stringify({ guessedPriceCents: 1050 }),
        800,
        new Date().toISOString(),
      );

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);

    // Room was created with the default 10 rounds; we only seeded round 1,
    // so the recap returns 10 snapshots with score 0 for the unpopulated
    // rounds. The load-bearing assertion is that the round-1 guess survived
    // the cleanup sweep.
    const recap = buildMPRecap(testDb, room.code, userId);
    expect(recap).toHaveLength(10);
    expect(recap[0].score).toBe(800);
    expect(recap[0].products.length).toBeGreaterThan(0);
  });

  it("deletes abandoned 'playing' rooms with no connected players", async () => {
    const { room, playerId } = await createRoom("Host");
    // Disconnect first, then backdate — disconnectPlayer now touches last_activity_at
    disconnectPlayer(playerId);
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'playing', last_activity_at = ? WHERE code = ?").run(oldTime, room.code);

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);
    expect(getRoom(room.code)).toBeNull();
  });

  it("deletes abandoned 'between_rounds' rooms with no connected players", async () => {
    const { room, playerId } = await createRoom("Host");
    // Disconnect first, then backdate — disconnectPlayer now touches last_activity_at
    disconnectPlayer(playerId);
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'between_rounds', last_activity_at = ? WHERE code = ?").run(oldTime, room.code);

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);
    expect(getRoom(room.code)).toBeNull();
  });

  it("does not delete abandoned rooms with recent activity", async () => {
    const { room, playerId } = await createRoom("Host");
    // Room is 'playing' but last_activity_at is recent (just created)
    testDb.prepare("UPDATE mp_rooms SET status = 'playing' WHERE code = ?").run(room.code);
    disconnectPlayer(playerId);

    const deleted = cleanupStaleRooms();
    expect(deleted).not.toContain(room.code);
  });

  it("does not delete rooms that still have connected players", async () => {
    const host = await createRoom("Host");
    await joinRoom(host.room.code, "Player2");
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'playing', last_activity_at = ? WHERE code = ?").run(oldTime, host.room.code);
    // Host disconnects but Player2 is still connected
    disconnectPlayer(host.playerId);

    const deleted = cleanupStaleRooms();
    expect(deleted).not.toContain(host.room.code);
  });

  it("deletes any non-finished room past the hard cap (2 hours) even with connected players", async () => {
    const { room } = await createRoom("Host");
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'between_rounds', last_activity_at = ?, created_at = ? WHERE code = ?")
      .run(threeHoursAgo, threeHoursAgo, room.code);

    // Verify the host is still connected before cleanup
    const roomBefore = getRoom(room.code);
    expect(roomBefore!.players.some((p) => p.isConnected)).toBe(true);

    const deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);
  });

  it("does not duplicate room codes when room matches multiple rules", async () => {
    const { room, playerId } = await createRoom("Host");
    // Disconnect first, then backdate — disconnectPlayer now touches last_activity_at
    disconnectPlayer(playerId);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    // Matches both "abandoned playing" and "hard cap"
    testDb.prepare("UPDATE mp_rooms SET status = 'playing', last_activity_at = ?, created_at = ? WHERE code = ?")
      .run(threeHoursAgo, threeHoursAgo, room.code);

    const deleted = cleanupStaleRooms();
    const occurrences = deleted.filter((c) => c === room.code);
    expect(occurrences).toHaveLength(1);
  });
});

describe("cleanupFinishedRoom", () => {
  it("is a no-op on the DB — preserves players + guesses so the recap endpoint keeps working", async () => {
    const { room } = await createRoom("Host");
    testDb.prepare("UPDATE mp_rooms SET status = 'finished', finished_at = ? WHERE code = ?")
      .run(new Date().toISOString(), room.code);
    testDb
      .prepare(
        "INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at) VALUES (?, ?, 1, '{}', 100, ?)",
      )
      .run(room.code, room.players[0].id, new Date().toISOString());

    cleanupFinishedRoom(room.code);

    // Room row preserved
    const row = testDb.prepare("SELECT code, status FROM mp_rooms WHERE code = ?").get(room.code) as any;
    expect(row).toBeDefined();
    expect(row.status).toBe("finished");
    // Players preserved (previously this helper purged them)
    const players = testDb.prepare("SELECT COUNT(*) as cnt FROM mp_players WHERE room_code = ?").get(room.code) as { cnt: number };
    expect(players.cnt).toBe(1);
    // Guesses preserved
    const guesses = testDb.prepare("SELECT COUNT(*) as cnt FROM mp_guesses WHERE room_code = ?").get(room.code) as { cnt: number };
    expect(guesses.cnt).toBe(1);
  });
});

describe("reapDisconnectedPlayers", () => {
  it("marks players as disconnected when their socket is gone", async () => {
    const { room, playerId } = await createRoom("Host");
    // Player is connected in DB but NOT in the live set (simulates ghost)
    const livePlayerIds = new Set<string>();

    const reaped = reapDisconnectedPlayers(livePlayerIds);
    expect(reaped).toBe(1);

    const player = getPlayerById(playerId);
    expect(player!.connected).toBe(0);
  });

  it("does not mark players as disconnected when their socket exists", async () => {
    const { room, playerId } = await createRoom("Host");
    const livePlayerIds = new Set([playerId]);

    const reaped = reapDisconnectedPlayers(livePlayerIds);
    expect(reaped).toBe(0);

    const player = getPlayerById(playerId);
    expect(player!.connected).toBe(1);
  });

  it("skips already-disconnected players", async () => {
    const { room, playerId } = await createRoom("Host");
    disconnectPlayer(playerId);
    const livePlayerIds = new Set<string>();

    const reaped = reapDisconnectedPlayers(livePlayerIds);
    expect(reaped).toBe(0);
  });

  it("enables room cleanup after reaping ghost players", async () => {
    const { room, playerId } = await createRoom("Host");
    // Room is 'playing' with player connected in DB but no live socket
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    testDb.prepare("UPDATE mp_rooms SET status = 'playing', last_activity_at = ? WHERE code = ?").run(oldTime, room.code);

    // Before reap: cleanup skips because player appears connected
    let deleted = cleanupStaleRooms();
    expect(deleted).not.toContain(room.code);

    // Reap the ghost player, then backdate the activity again
    reapDisconnectedPlayers(new Set<string>());
    testDb.prepare("UPDATE mp_rooms SET last_activity_at = ? WHERE code = ?").run(oldTime, room.code);

    // After reap: cleanup now catches the abandoned room
    deleted = cleanupStaleRooms();
    expect(deleted).toContain(room.code);
  });
});

describe("addBots", () => {
  it("adds bots to a room", async () => {
    const { room, playerId } = await createRoom("Host");
    const updated = addBots(room.code, playerId, 2, "medium");
    expect(updated).toBeDefined();
    expect(updated!.players).toHaveLength(3); // 1 host + 2 bots
    expect(updated!.botCount).toBe(2);
    expect(updated!.botDifficulty).toBe("medium");
    const bots = updated!.players.filter((p) => p.isBot);
    expect(bots).toHaveLength(2);
    for (const bot of bots) {
      expect(bot.isBot).toBe(true);
      expect(bot.isHost).toBe(false);
      expect(bot.isConnected).toBe(true);
      expect(bot.displayName.split(" ").length).toBe(2); // "Adjective Animal"
    }
  });

  it("rejects adding bots that would exceed MAX_PLAYERS", async () => {
    const { room, playerId } = await createRoom("Host");
    // Room already has 1 player, adding 6 would exceed max of 6
    expect(() => addBots(room.code, playerId, 6, "medium")).toThrow("exceed room capacity");
  });

  it("rejects non-host caller", async () => {
    const { room } = await createRoom("Host");
    const result = addBots(room.code, "fake-player-id", 2, "medium");
    expect(result).toBeNull();
  });

  it("allows up to MAX_PLAYERS total (humans + bots)", async () => {
    const { room, playerId } = await createRoom("Host");
    // 1 host + 5 bots = 6 total = MAX_PLAYERS
    const updated = addBots(room.code, playerId, 5, "hard");
    expect(updated!.players).toHaveLength(6);
  });
});

describe("removeBots", () => {
  it("removes all bots from a room", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 3, "easy");
    const updated = removeBots(room.code, playerId);
    expect(updated!.players).toHaveLength(1); // only host remains
    expect(updated!.players.every((p) => !p.isBot)).toBe(true);
    expect(updated!.botCount).toBe(0);
  });
});

describe("updateBotConfig", () => {
  it("replaces bots atomically", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 2, "easy");
    const updated = updateBotConfig(room.code, playerId, 3, "hard");
    expect(updated!.players).toHaveLength(4); // 1 host + 3 new bots
    expect(updated!.botCount).toBe(3);
    expect(updated!.botDifficulty).toBe("hard");
  });

  it("removes all bots when count is 0", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 2, "easy");
    const updated = updateBotConfig(room.code, playerId, 0, "medium");
    expect(updated!.players).toHaveLength(1);
  });
});

describe("public lobbies", () => {
  it("creates a public room", async () => {
    const { room } = await createRoom("Host", "classic", { isPublic: true });
    expect(room.isPublic).toBe(true);
  });

  it("creates a private room by default", async () => {
    const { room } = await createRoom("Host");
    expect(room.isPublic).toBe(false);
  });
});

describe("bot + host promotion", () => {
  it("does not promote a bot to host when host disconnects", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 2, "medium");
    // Disconnect the host
    const result = disconnectPlayer(playerId);
    expect(result).toBeDefined();
    // No new host should be assigned (only bots remain connected)
    expect(result!.newHostId).toBeUndefined();
  });

  it("promotes a human over bots when host disconnects", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 2, "medium");
    // Add a human player
    const { playerId: humanId } = await joinRoom(room.code, "Human");
    // Disconnect the host
    const result = disconnectPlayer(playerId);
    expect(result!.newHostId).toBe(humanId);
  });
});

describe("joinRoom with bots", () => {
  it("respects capacity including bots", async () => {
    const { room, playerId } = await createRoom("Host");
    addBots(room.code, playerId, 4, "medium"); // 1 host + 4 bots = 5
    // 6th slot should work
    const { room: updated } = await joinRoom(room.code, "Player2");
    expect(updated.players).toHaveLength(6);
    // 7th should fail
    await expect(joinRoom(room.code, "Player3")).rejects.toThrow("Room is full");
  });
});

// ── Avatar preference in multiplayer ─────────────────────────────────────

describe("avatar preference", () => {
  it("createRoom uses user's saved avatar when userId has a preference", async () => {
    const uid = seedUser(testDb, "avatarhost", "host@test.com");
    testDb.prepare("UPDATE users SET avatar = 'yeti' WHERE id = ?").run(uid);

    const result = await createRoom("AvatarHost", "classic", undefined, uid);
    expect(result.room.players[0].avatar).toBe("yeti");
  });

  it("createRoom uses random avatar when user has no preference", async () => {
    const uid = seedUser(testDb, "noavatar", "noav@test.com");
    // avatar is NULL by default
    const result = await createRoom("NoAvatar", "classic", undefined, uid);
    expect(result.room.players[0].avatar).toBeDefined();
  });

  it("joinRoom uses user's saved avatar when available", async () => {
    // Seed the host with a fixed non-conflicting avatar so the joiner's
    // preferred 'owl' is guaranteed to still be available. (Without this,
    // anonymous host creation picks a random avatar from PROFILE_AVATARS
    // and can occasionally land on 'owl', making the test flaky.)
    const hostUid = seedUser(testDb, "host_for_join_test", "hftj@test.com");
    testDb.prepare("UPDATE users SET avatar = 'bear' WHERE id = ?").run(hostUid);
    const { room } = await createRoom("Host", "classic", undefined, hostUid);

    const uid = seedUser(testDb, "joiner", "joiner@test.com");
    testDb.prepare("UPDATE users SET avatar = 'fancy-ghost' WHERE id = ?").run(uid);

    const joinResult = await joinRoom(room.code, "Joiner", undefined, uid);
    const joiner = joinResult.room.players.find((p) => p.displayName === "Joiner");
    expect(joiner!.avatar).toBe("fancy-ghost");
  });

  it("joinRoom falls back to random when preferred avatar is already taken", async () => {
    const hostUid = seedUser(testDb, "host2", "host2@test.com");
    testDb.prepare("UPDATE users SET avatar = 'sushi' WHERE id = ?").run(hostUid);
    const { room } = await createRoom("Host2", "classic", undefined, hostUid);
    expect(room.players[0].avatar).toBe("sushi");

    const joinerUid = seedUser(testDb, "joiner2", "joiner2@test.com");
    testDb.prepare("UPDATE users SET avatar = 'sushi' WHERE id = ?").run(joinerUid);

    const joinResult = await joinRoom(room.code, "Joiner2", undefined, joinerUid);
    const joiner = joinResult.room.players.find((p) => p.displayName === "Joiner2");
    // Should NOT be "sushi" since host already has it
    expect(joiner!.avatar).not.toBe("sushi");
  });
});

describe("analytics instrumentation", () => {
  // Each MP event flow lands rows in the `events` table via recordEvent.
  // The room manager only emits when a visitor_id is present; otherwise
  // the event is suppressed (the ingest pipeline requires visitor_id).
  it("createRoom emits an mp_room_created event with room context", async () => {
    const visitorId = "vis-create-1";
    const { room } = await createRoom(
      "Host",
      "classic",
      { isPublic: true },
      undefined,
      visitorId,
    );

    const events = testDb
      .prepare(
        "SELECT event_name, mp_room_code, properties, visitor_id FROM events WHERE event_name = 'mp_room_created'",
      )
      .all() as Array<{
        event_name: string;
        mp_room_code: string;
        properties: string | null;
        visitor_id: string;
      }>;
    expect(events).toHaveLength(1);
    expect(events[0].mp_room_code).toBe(room.code);
    expect(events[0].visitor_id).toBe(visitorId);
    const props = JSON.parse(events[0].properties!);
    expect(props.room_code).toBe(room.code);
    expect(props.game_mode).toBe("classic");
    expect(props.is_public).toBe(true);
    expect(props.is_logged_in).toBe(false);
  });

  it("createRoom does NOT emit when visitorId is missing", async () => {
    await createRoom("AnonHost"); // no visitorId
    const count = (
      testDb
        .prepare("SELECT COUNT(*) as c FROM events WHERE event_name = 'mp_room_created'")
        .get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("createRoom persists join_source='create' on the host's mp_players row", async () => {
    const visitorId = "vis-create-2";
    const { room, playerId } = await createRoom(
      "Host",
      "classic",
      undefined,
      undefined,
      visitorId,
    );
    const row = testDb
      .prepare("SELECT join_source FROM mp_players WHERE id = ?")
      .get(playerId) as { join_source: string | null };
    expect(row.join_source).toBe("create");
    expect(room.players[0].isHost).toBe(true);
  });

  it("joinRoom emits mp_room_joined with the supplied join_source", async () => {
    const hostVisitor = "vis-host-1";
    const joinerVisitor = "vis-join-1";
    const { room } = await createRoom("Host", "classic", undefined, undefined, hostVisitor);
    await joinRoom(
      room.code,
      "Joiner",
      undefined,
      undefined,
      joinerVisitor,
      undefined,
      "share_link",
    );

    const events = testDb
      .prepare(
        `SELECT properties, visitor_id FROM events
          WHERE event_name = 'mp_room_joined' AND visitor_id = ?`,
      )
      .all(joinerVisitor) as Array<{ properties: string | null; visitor_id: string }>;
    expect(events).toHaveLength(1);
    const props = JSON.parse(events[0].properties!);
    expect(props.join_source).toBe("share_link");
    expect(props.room_code).toBe(room.code);
  });

  it("joinRoom persists join_source on the joiner's mp_players row", async () => {
    const { room } = await createRoom("Host", "classic", undefined, undefined, "vis-host-2");
    const joinResult = await joinRoom(
      room.code,
      "Joiner",
      undefined,
      undefined,
      "vis-join-2",
      undefined,
      "browser",
    );
    const row = testDb
      .prepare("SELECT join_source FROM mp_players WHERE id = ?")
      .get(joinResult.playerId) as { join_source: string | null };
    expect(row.join_source).toBe("browser");
  });

  it("joinRoom defaults join_source to 'browser' when omitted", async () => {
    const { room } = await createRoom("Host", "classic", undefined, undefined, "vis-host-3");
    const joinResult = await joinRoom(
      room.code,
      "Joiner",
      undefined,
      undefined,
      "vis-join-3",
    );
    const row = testDb
      .prepare("SELECT join_source FROM mp_players WHERE id = ?")
      .get(joinResult.playerId) as { join_source: string | null };
    expect(row.join_source).toBe("browser");
  });

  it("createRoom honors a DNT signal in eventContext (UA/properties stripped from event row)", async () => {
    const visitorId = "vis-dnt-1";
    await createRoom(
      "Host",
      "classic",
      { isPublic: true },
      undefined,
      visitorId,
      { userAgent: "Mozilla/5.0", country: "US", ip: "1.2.3.4", dnt: true },
    );
    const row = testDb
      .prepare(
        "SELECT properties, country, browser, ip_hash, dnt FROM events WHERE event_name = 'mp_room_created'",
      )
      .get() as {
        properties: string | null;
        country: string | null;
        browser: string | null;
        ip_hash: string | null;
        dnt: number;
      };
    expect(row.dnt).toBe(1);
    expect(row.properties).toBeNull();
    expect(row.country).toBeNull();
    expect(row.browser).toBeNull();
    expect(row.ip_hash).toBeNull();
  });

  // PR 6a — deterministic dedup keys. The events table has a partial UNIQUE
  // index on (visitor_id, client_event_id); these tests pin the keys we use
  // so a regression in the keying logic shows up here, not in dashboard
  // metrics months later.

  it("createRoom writes a deterministic client_event_id scoped on the room code", async () => {
    const { room } = await createRoom(
      "Host",
      "classic",
      undefined,
      undefined,
      "vis-dedup-1",
    );
    const row = testDb
      .prepare(
        "SELECT client_event_id FROM events WHERE event_name = 'mp_room_created'",
      )
      .get() as { client_event_id: string };
    expect(row.client_event_id).toBe(`srv:mp_room_created:${room.code}`);
  });

  it("joinRoom writes a deterministic client_event_id scoped on the freshly-minted playerId", async () => {
    const { room } = await createRoom("Host", "classic", undefined, undefined, "vis-host-dedup");
    const joinResult = await joinRoom(
      room.code,
      "Joiner",
      undefined,
      undefined,
      "vis-join-dedup",
      undefined,
      "share_link",
    );
    const row = testDb
      .prepare(
        "SELECT client_event_id FROM events WHERE event_name = 'mp_room_joined' AND visitor_id = ?",
      )
      .get("vis-join-dedup") as { client_event_id: string };
    expect(row.client_event_id).toBe(`srv:mp_room_joined:${joinResult.playerId}`);
  });

  it("resetRoom clears mp_rooms.current_game_id so the next game gets a fresh id", async () => {
    const { room } = await createRoom("Host", "classic", undefined, undefined, "vis-reset-1");
    // Simulate a game in progress: set status='finished' + a current_game_id.
    testDb
      .prepare("UPDATE mp_rooms SET status = 'finished', finished_at = ?, current_game_id = ? WHERE code = ?")
      .run(new Date().toISOString(), "game-id-A", room.code);

    const reset = resetRoom(room.code, room.players[0].id);
    expect(reset).not.toBeNull();

    const after = testDb
      .prepare("SELECT current_game_id FROM mp_rooms WHERE code = ?")
      .get(room.code) as { current_game_id: string | null };
    expect(after.current_game_id).toBeNull();
  });
});
