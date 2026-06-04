import { nanoid } from "nanoid";
import { v4 as uuidv4 } from "uuid";
import { hash, compare } from "bcryptjs";
import db from "../db";
import {
  GameMode,
  Avatar,
  AVATARS,
  RANDOMIZABLE_AVATARS,
  MAX_PLAYERS,
  MIN_ROUNDS,
  MAX_ROUNDS,
  MultiplayerPlayer,
  MultiplayerRoom,
  RoomStatus,
  TOTAL_ROUNDS,
  VALID_GAME_MODES,
  BOT_DIFFICULTIES,
  type BotDifficulty,
  type JoinSource,
  ANALYTICS_EVENTS,
} from "@price-game/shared";
import { recordEvent } from "./eventLog";
import { generateBotNames } from "./botNames";
import { sanitizeName, sanitizePassword } from "./inputSanitizer";
import { UserFacingError } from "./errors";
import { isGameModeEnabled, getDisabledAvatars } from "./siteSettings";
import { getValidCategoryNames } from "./categoriesCache";
import { getAutoLobbySettings } from "./autoLobby/settings";
import { startCountdown, cancelCountdown } from "./autoLobby/countdown";
import { isReservedByGhost } from "./ghostUsers/reservedNames";
import type { DbRoom, DbPlayer } from "./dbTypes";

const BCRYPT_ROUNDS = 10;

function toPlayer(row: DbPlayer): MultiplayerPlayer {
  return {
    id: row.id,
    displayName: row.display_name,
    avatar: row.avatar as Avatar,
    isHost: row.is_host === 1,
    // Bots have no socket so reapDisconnectedPlayers periodically marks
    // them connected=0 in the DB. From the room's perspective they're
    // always present though, so the wire payload always reports them as
    // connected — this prevents the "offline" badge from flashing on
    // labeled bots and (more importantly) prevents disguised bots from
    // betraying the disguise by showing up offline.
    isConnected: row.is_bot === 1 ? true : row.connected === 1,
    totalScore: row.total_score,
    // Disguised bots intentionally appear as humans on the wire. Server-side
    // logic uses isServerSideBot() against the DB row; this is purely the
    // client-facing presentation. See services/autoLobby/identity.ts.
    isBot: row.is_bot === 1 && row.is_disguised !== 1,
  };
}

function parseCategories(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Legacy single-category string
    return [raw];
  }
  return null;
}

function toRoom(room: DbRoom, players: DbPlayer[]): MultiplayerRoom {
  const out: MultiplayerRoom = {
    code: room.code,
    gameMode: room.game_mode as GameMode,
    categories: parseCategories(room.category),
    hasPassword: !!room.password,
    status: room.status as RoomStatus,
    currentRound: room.current_round,
    totalRounds: room.total_rounds,
    players: players.filter((p) => p.is_kicked === 0).map(toPlayer),
    hostPlayerId: room.host_player_id,
    isPublic: room.is_public === 1,
    botCount: room.bot_count,
    botDifficulty: room.bot_difficulty as import("@price-game/shared").BotDifficulty,
  };
  if (room.is_daily_game === 1) {
    out.isDailyGame = true;
    if (room.daily_date) out.dailyDate = room.daily_date;
  }
  if (room.countdown_target_at) {
    out.countdownTargetAt = room.countdown_target_at;
  }
  return out;
}

/**
 * Return true if `name` collides with a registered user's username (case-
 * insensitive — uses the same `username_normalized` column the auth code
 * uses for uniqueness). Guests are blocked from claiming a registered
 * username so they can't impersonate real accounts in multiplayer rooms.
 */
function isReservedUsername(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  const row = db
    .prepare("SELECT 1 FROM users WHERE username_normalized = ?")
    .get(normalized) as { 1: number } | undefined;
  return !!row;
}

function sanitizeDisplayName(name: string): string {
  return sanitizeName(name, 20);
}

function getUserPreferredAvatar(userId: string | undefined | null): Avatar | null {
  if (!userId) return null;
  const row = db.prepare("SELECT avatar FROM users WHERE id = ?").get(userId) as { avatar: string | null } | undefined;
  const val = row?.avatar;
  if (!val || !AVATARS.includes(val as Avatar)) return null;
  return val as Avatar;
}

function pickAvatar(roomCode: string): Avatar {
  const taken = db
    .prepare("SELECT avatar FROM mp_players WHERE room_code = ? AND is_kicked = 0")
    .all(roomCode) as { avatar: string }[];
  const takenSet = new Set(taken.map((t) => t.avatar));
  const disabledSet = new Set(getDisabledAvatars(db));
  // Prefer unused, enabled RANDOMIZABLE_AVATARS so two players in the same
  // room don't accidentally get the same sticker. Excludes the blank
  // silhouette option and admin-disabled avatars.
  const available = RANDOMIZABLE_AVATARS.filter((a) => !takenSet.has(a) && !disabledSet.has(a));
  // Fall back to any randomizable avatar if all enabled ones are taken
  const fallback = RANDOMIZABLE_AVATARS.filter((a) => !takenSet.has(a));
  const pool = available.length > 0 ? available : fallback.length > 0 ? fallback : RANDOMIZABLE_AVATARS;
  return pool[Math.floor(Math.random() * pool.length)] as Avatar;
}

/**
 * Normalize a client-supplied preferred avatar to a usable `Avatar` value
 * for anonymous-player join/create flows. Accepts the value when it's a
 * valid randomizable avatar, not admin-disabled, and not already taken by
 * another connected player in the room. Returns `null` otherwise — the
 * caller should fall back to `pickAvatar` so anon players still get a
 * real sticker instead of the blank silhouette placeholder.
 *
 * @param roomCode - The target room; used to load the taken-avatar set.
 * @param preferred - Raw value from the socket payload (untrusted).
 * @param extraTaken - Avatars already known to be taken in the current
 *                     transaction (e.g. during joinRoom's capacity check)
 *                     so we don't need to re-query the same data.
 */
function resolvePreferredAvatar(
  roomCode: string,
  preferred: unknown,
  extraTaken?: Set<string>
): Avatar | null {
  if (typeof preferred !== "string" || preferred.length === 0) return null;
  // RANDOMIZABLE_AVATARS is a readonly tuple whose element type excludes
  // "silhouette"; widen to `readonly string[]` so the untrusted string can
  // be checked against it without a `Avatar`-shaped cast.
  if (!(RANDOMIZABLE_AVATARS as readonly string[]).includes(preferred)) return null;
  const disabledSet = new Set(getDisabledAvatars(db));
  if (disabledSet.has(preferred)) return null;
  const taken = extraTaken
    ? extraTaken
    : new Set(
        (
          db
            .prepare("SELECT avatar FROM mp_players WHERE room_code = ? AND is_kicked = 0")
            .all(roomCode) as { avatar: string }[]
        ).map((t) => t.avatar)
      );
  if (taken.has(preferred)) return null;
  return preferred as Avatar;
}

/**
 * Validate that all provided categories exist as active product categories in the DB.
 *
 * @param categories - Array of category names to validate, or null/undefined for all.
 * @returns JSON-stringified array, or null for all categories.
 * @throws UserFacingError if any category is invalid.
 */
function validateCategories(categories: string[] | undefined | null): string | null {
  if (!categories || categories.length === 0) return null;
  if (categories.length > 50) throw new UserFacingError("Too many categories");
  // H2 fix: fail-fast if any category is invalid instead of silently dropping.
  // Cached set (PR1 perf F4) — invalidated on admin product mutations.
  const validSet = getValidCategoryNames(db);
  for (const c of categories) {
    if (!validSet.has(c)) {
      throw new UserFacingError(`Invalid category: ${c}`);
    }
  }
  return JSON.stringify(categories);
}

function clampRounds(n: number | undefined, gameMode?: GameMode): number {
  if (n === undefined || !Number.isFinite(n)) {
    // Bidding War defaults to 5 rounds because each round is a full
    // turn-taking sequence — 10 rounds (the default for other modes) is
    // too long in practice.
    return gameMode === "bidding" ? 5 : TOTAL_ROUNDS;
  }
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(n)));
}

/**
 * Update the last_activity_at timestamp for a room, used by cleanup to detect abandoned rooms.
 *
 * IMPORTANT: Callers must verify the acting player is an authorized member of the
 * room before calling this function. It performs no authorization check itself.
 *
 * @param code - The room code to touch.
 */
export function touchRoomActivity(code: string, isoNow?: string): void {
  getTouchRoomActivityStmt().run(isoNow ?? new Date().toISOString(), code);
}

// Lazy-initialized cached prepared statement (PR1 perf F6). The same SQL
// was previously `db.prepare(...)` inline at four call sites in this
// file, allocating a fresh Statement wrapper each call. With concurrent
// multiplayer traffic (room create/join/rejoin/disconnect every socket
// event) the re-prepare overhead showed up as a top SQL contributor.
//
// Lazy because tests vi.mock the `db` import to null at module-load time
// and swap it in beforeEach. The db-identity check re-prepares against
// the current `db` if a test replaced it — without this, integration
// tests that build a fresh DB per test would call prepared.run() against
// a closed handle.
let touchRoomActivityStmt: import("better-sqlite3").Statement<[string, string]> | null = null;
let touchRoomActivityStmtDb: typeof db | null = null;
function getTouchRoomActivityStmt(): import("better-sqlite3").Statement<[string, string]> {
  if (touchRoomActivityStmt === null || touchRoomActivityStmtDb !== db) {
    touchRoomActivityStmtDb = db;
    touchRoomActivityStmt = db.prepare<[string, string]>(
      "UPDATE mp_rooms SET last_activity_at = ? WHERE code = ?",
    );
  }
  return touchRoomActivityStmt;
}

/**
 * Lightweight request context attached to room create/join calls so the
 * downstream `recordEvent` emission can populate device/geo/UA dimensions
 * AND honor the caller's privacy preferences. Sockets don't carry an
 * Express `Request`, so we pass these fields explicitly. All optional —
 * events still record without them, just with those dimensions set to
 * 'unknown'.
 *
 * `dnt` propagates the client's Do-Not-Track / Sec-GPC signal so server-
 * emitted MP events store the same DNT-stripped row shape as client-beacon
 * events. Without this, a player who set DNT on their browser would have
 * gameplay events stored with full UA/IP/country/properties anyway.
 */
export interface RoomEventContext {
  userAgent?: string | null;
  ip?: string | null;
  country?: string | null;
  dnt?: boolean;
  /**
   * True when the socket creating/joining the room carried a valid
   * `X-Streamer-Bot` shared-secret header. Stamped onto `mp_players.is_streamer_bot`
   * by joinRoom/createRoom so end-of-round and start-of-round analytics
   * emits can skip the bot's seat without affecting gameplay.
   */
  isStreamerBot?: boolean;
}

export async function createRoom(
  displayName: string,
  gameMode: GameMode = "classic",
  options?: {
    categories?: string[];
    password?: string;
    totalRounds?: number;
    isPublic?: boolean;
    /** When set, marks the room as a daily-challenge MP room scoped to that YYYY-MM-DD. */
    dailyDate?: string;
    /**
     * Anonymous client's requested avatar (e.g. from the guest identity
     * card). Used only for anon callers and only when the value is a
     * valid, enabled, untaken randomizable avatar — otherwise we fall
     * back to a random pick. Logged-in users' saved preference always
     * wins over this value.
     */
    preferredAvatar?: string;
  },
  userId?: string,
  visitorId?: string,
  eventContext?: RoomEventContext,
): Promise<{ room: MultiplayerRoom; playerId: string; playerToken: string }> {
  const safeName = sanitizeDisplayName(displayName);
  if (!safeName) throw new UserFacingError("Display name is required");
  if (!userId && isReservedUsername(safeName)) {
    throw new UserFacingError(
      "That name belongs to a registered account. Please choose another.",
    );
  }
  // Block ghost-reserved names so anonymous players can't impersonate a
  // synthetic identity that already appears on the leaderboard. Real
  // users get the same check on signup, so logged-in callers won't hit
  // this branch in practice.
  if (isReservedByGhost(db, safeName)) {
    throw new UserFacingError("That display name is taken");
  }
  if (!VALID_GAME_MODES.has(gameMode)) throw new UserFacingError("Invalid game mode");
  if (!isGameModeEnabled(db, gameMode)) throw new UserFacingError("This game mode is currently disabled");

  const code = nanoid(7);
  const playerId = uuidv4();
  const playerToken = uuidv4();
  const now = new Date().toISOString();
  // Logged-in users: saved preference, else random. Anonymous users: honor
  // their guest-identity avatar when valid (so the sticker they see on the
  // SP IdentityCard matches what other players see in the room), falling
  // back to a random pick instead of the blank silhouette.
  let avatar: Avatar;
  if (userId) {
    avatar = getUserPreferredAvatar(userId) ?? pickAvatar(code);
  } else {
    avatar = resolvePreferredAvatar(code, options?.preferredAvatar) ?? pickAvatar(code);
  }
  const categoryJson = validateCategories(options?.categories);
  const totalRounds = clampRounds(options?.totalRounds, gameMode);
  const rawPassword = sanitizePassword(options?.password);
  const password = rawPassword ? await hash(rawPassword, BCRYPT_ROUNDS) : null;

  const isPublic = options?.isPublic ? 1 : 0;
  const dailyDate = typeof options?.dailyDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.dailyDate)
    ? options.dailyDate
    : null;
  const isDailyGame = dailyDate ? 1 : 0;

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, creator_player_id, game_mode, category, password, status, current_round, total_rounds, created_at, last_activity_at, is_public, is_daily_game, daily_date)
       VALUES (?, ?, ?, ?, ?, ?, 'lobby', 0, ?, ?, ?, ?, ?, ?)`
    ).run(code, playerId, playerId, gameMode, categoryJson, password, totalRounds, now, now, isPublic, isDailyGame, dailyDate);

    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, user_id, visitor_id, join_source, is_streamer_bot)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'create', ?)`
    ).run(
      playerId,
      code,
      safeName,
      avatar,
      playerToken,
      now,
      userId ?? null,
      visitorId ?? null,
      eventContext?.isStreamerBot ? 1 : 0,
    );
  });
  create();

  // Emit the analytics event AFTER the transaction commits so a recordEvent
  // failure can never roll back room creation. recordEvent itself never
  // throws (catches and logs internally) but the post-commit placement makes
  // the invariant explicit.
  if (visitorId) {
    recordEvent({
      eventName: ANALYTICS_EVENTS.MP_ROOM_CREATED,
      eventType: "mp",
      visitorId,
      userId: userId ?? null,
      userAgent: eventContext?.userAgent ?? null,
      ip: eventContext?.ip ?? null,
      country: eventContext?.country ?? null,
      dnt: eventContext?.dnt,
      isStreamerBot: eventContext?.isStreamerBot,
      gameMode,
      mpRoomCode: code,
      // Dedup key: room codes are unique (`nanoid(7)`) and never reused
      // across rooms, so `<roomCode>` alone is a stable scope key for the
      // creation event. Guards against an accidental retry of the create
      // path producing a phantom second `mp_room_created` row.
      clientEventId: `srv:mp_room_created:${code}`,
      properties: {
        room_code: code,
        game_mode: gameMode,
        total_rounds: totalRounds,
        is_public: isPublic === 1,
        is_daily_game: isDailyGame === 1,
        is_logged_in: !!userId,
      },
    });
  }

  const room = getRoom(code)!;
  return { room, playerId, playerToken };
}

export async function joinRoom(
  code: string,
  displayName: string,
  password?: string,
  userId?: string,
  visitorId?: string,
  /**
   * Anonymous client's requested avatar (e.g. from the guest identity
   * card). Only honored for anon callers when valid + untaken — logged-in
   * users' saved preference still wins.
   */
  preferredAvatar?: string,
  /**
   * How this player ended up in this room. Persisted on the `mp_players`
   * row + carried through to the `mp_room_joined` event so analytics can
   * break down room arrivals by acquisition path. Defaults to `'browser'`
   * — the conservative bucket for any join that doesn't tell us otherwise.
   */
  joinSource: JoinSource = "browser",
  eventContext?: RoomEventContext,
): Promise<{ room: MultiplayerRoom; playerId: string; playerToken: string }> {
  const safeName = sanitizeDisplayName(displayName);
  if (!safeName) throw new UserFacingError("Display name is required");
  if (isReservedByGhost(db, safeName)) {
    throw new UserFacingError("That display name is taken");
  }

  // Block guests from impersonating registered accounts. Logged-in users
  // pass through unchanged because their username is their own to use.
  if (!userId && isReservedUsername(safeName)) {
    throw new UserFacingError(
      "That name belongs to a registered account. Please choose another.",
    );
  }

  const roomRow = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!roomRow) throw new UserFacingError("Room not found");
  if (roomRow.status !== "lobby" && roomRow.status !== "between_rounds") {
    throw new UserFacingError("Game is already in progress");
  }

  if (roomRow.password) {
    if (!password || !(await compare(password, roomRow.password))) {
      throw new UserFacingError("Incorrect password");
    }
  }

  // Wrap capacity check + insert in a transaction to prevent race conditions
  // where concurrent joins both pass the capacity check before either inserts.
  // The password check (async) must stay outside the transaction.
  const { playerId, playerToken } = db.transaction(() => {
    const players = db
      .prepare("SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0")
      .all(code) as DbPlayer[];
    if (players.length >= MAX_PLAYERS) throw new UserFacingError("Room is full");

    // Block self-rejoin via the join flow. If a player with the same
    // identity (user_id when logged in, visitor_id otherwise) is already
    // in this room and not kicked, reject — the caller should be using
    // the rejoin/resume path instead. Without this guard, the lobby
    // browser would let a user join their own room and end up with two
    // mp_players rows under the same name.
    //
    // Invariant: under the production /api mount the visitor-cookie
    // middleware always populates `visitorId`, so the {!userId &&
    // !visitorId} fall-through is unreachable in real traffic. If a
    // future refactor moves a join path outside that mount, the gate
    // would silently no-op — harden by re-asserting the invariant or
    // failing closed before relying on this branch elsewhere.
    if (userId) {
      const existing = players.find((p) => p.user_id === userId);
      if (existing) {
        throw new UserFacingError("You are already in this room");
      }
    } else if (visitorId) {
      const existing = players.find((p) => p.visitor_id === visitorId);
      if (existing) {
        throw new UserFacingError("You are already in this room");
      }
    }

    const id = uuidv4();
    const token = uuidv4();
    const now = new Date().toISOString();
    const preferred = getUserPreferredAvatar(userId);
    const takenSet = new Set(players.map((p) => p.avatar));
    // Logged-in users: their preference if available + untaken, else random.
    // Anonymous users: honor the client-supplied preferredAvatar (their
    // guest-identity avatar) when valid + untaken, else random. This replaces
    // the legacy silhouette fallback so anon players appear with the same
    // sticker shown on their IdentityCard.
    let avatar: Avatar;
    if (userId) {
      avatar = preferred && !takenSet.has(preferred) ? preferred : pickAvatar(code);
    } else {
      avatar =
        resolvePreferredAvatar(code, preferredAvatar, takenSet) ?? pickAvatar(code);
    }

    db.prepare(
      `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, user_id, visitor_id, join_source, is_streamer_bot)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`
    ).run(
      id,
      code,
      safeName,
      avatar,
      token,
      now,
      userId ?? null,
      visitorId ?? null,
      joinSource,
      eventContext?.isStreamerBot ? 1 : 0,
    );

    // If current host is disconnected and no other connected human is host,
    // promote the joining player to host
    const currentHost = players.find((p) => p.is_host === 1);
    if (currentHost && currentHost.connected === 0) {
      db.prepare("UPDATE mp_players SET is_host = 0 WHERE room_code = ? AND is_host = 1").run(code);
      db.prepare("UPDATE mp_players SET is_host = 1 WHERE id = ?").run(id);
      db.prepare("UPDATE mp_rooms SET host_player_id = ? WHERE code = ?").run(id, code);
    }

    touchRoomActivity(code, now);

    return { playerId: id, playerToken: token };
  })();

  // Auto-lobby pre-game countdown: when a real human walks into a bot-only
  // auto-lobby, start (or extend) the timer that fires startRound() once it
  // elapses. Resetting the countdown on every fresh human join lets later
  // arrivals make the room feel "filling up" before the game kicks off.
  if (roomRow.is_auto_lobby === 1) {
    const settings = getAutoLobbySettings(db);
    startCountdown(db, code, {
      min: settings.countdownMinSeconds,
      max: settings.countdownMaxSeconds,
    });
  }

  if (visitorId) {
    recordEvent({
      eventName: ANALYTICS_EVENTS.MP_ROOM_JOINED,
      eventType: "mp",
      visitorId,
      userId: userId ?? null,
      userAgent: eventContext?.userAgent ?? null,
      ip: eventContext?.ip ?? null,
      country: eventContext?.country ?? null,
      dnt: eventContext?.dnt,
      isStreamerBot: eventContext?.isStreamerBot,
      gameMode: roomRow.game_mode,
      mpRoomCode: code,
      // Dedup key: scoped on `playerId` which is a fresh UUID minted by
      // the join transaction. A subsequent leave/rejoin produces a new
      // playerId (and thus a legitimate second join event). A retried
      // socket call with the same playerId would emit the same key and
      // dedup correctly.
      clientEventId: `srv:mp_room_joined:${playerId}`,
      properties: {
        room_code: code,
        game_mode: roomRow.game_mode,
        join_source: joinSource,
        is_logged_in: !!userId,
      },
    });
  }

  const room = getRoom(code)!;
  return { room, playerId, playerToken };
}

export type RejoinResult =
  | {
      ok: true;
      room: MultiplayerRoom;
      playerId: string;
      hostChanged?: boolean;
      newHostId?: string;
    }
  | { ok: false; code: import("@price-game/shared").RejoinErrorCode };

/**
 * Attempt to rejoin a room with a previously-issued player token.
 *
 * Returns a discriminated result so the caller can map each failure
 * mode to a specific user-facing message instead of a single generic
 * "could not rejoin" error.
 *
 * @param code - Room code.
 * @param playerToken - Token issued to the player on create/join.
 * @returns Success payload with the rehydrated room + playerId, or a
 *          typed failure (`room_expired`, `kicked`, `invalid_token`).
 */
export function rejoinRoom(
  code: string,
  playerToken: string
): RejoinResult {
  const player = db
    .prepare("SELECT * FROM mp_players WHERE room_code = ? AND token = ?")
    .get(code, playerToken) as DbPlayer | undefined;
  if (!player) return { ok: false, code: "invalid_token" };
  // Reject rejoin attempts using a bot's token. Bot tokens are never sent to
  // clients today (they live only in the `mp_players` row), so this is
  // hardening rather than fixing a known leak — but the disguise layer
  // depends on bots staying server-side-only, so guarding here removes a
  // latent risk if a future feature ever emits a bot token by accident.
  if (player.is_bot === 1) return { ok: false, code: "invalid_token" };
  if (player.is_kicked === 1) return { ok: false, code: "kicked" };

  const roomRow = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!roomRow) return { ok: false, code: "room_expired" };
  // Finished rooms are now retained indefinitely for the history-recap path
  // (see cleanupStaleRooms). Don't let a client with a stale token flip
  // `connected = 1` on an archived room — there's no live game to rejoin.
  if (roomRow.status === "finished") return { ok: false, code: "room_expired" };

  let hostChanged = false;
  let newHostId: string | undefined;

  const doRejoin = db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare("UPDATE mp_players SET connected = 1 WHERE id = ?").run(player.id);
    touchRoomActivity(code, now);

    if (player.id === roomRow.creator_player_id) {
      // Reassign host to the original creator
      db.prepare("UPDATE mp_players SET is_host = 0 WHERE room_code = ? AND is_host = 1").run(code);
      db.prepare("UPDATE mp_players SET is_host = 1 WHERE id = ?").run(player.id);
      db.prepare("UPDATE mp_rooms SET host_player_id = ? WHERE code = ?").run(player.id, code);
      hostChanged = true;
      newHostId = player.id;
    }
  });
  doRejoin();

  const room = getRoom(code);
  if (!room) return { ok: false, code: "room_expired" };
  return { ok: true, room, playerId: player.id, hostChanged, newHostId };
}

export function kickPlayer(code: string, hostPlayerId: string, targetPlayerId: string): boolean {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return false;
  if (targetPlayerId === hostPlayerId) return false;

  db.prepare("UPDATE mp_players SET is_kicked = 1, connected = 0 WHERE id = ? AND room_code = ?")
    .run(targetPlayerId, code);
  touchRoomActivity(code);
  return true;
}

export async function updateSettings(
  code: string,
  hostPlayerId: string,
  settings: {
    gameMode?: GameMode;
    categories?: string[] | null;
    totalRounds?: number;
    password?: string | null;
    /** Toggle public visibility on/off. Honors both true and false explicitly
     *  (do not coerce to truthy/falsy — `false` must be persisted). */
    isPublic?: boolean;
  }
): Promise<MultiplayerRoom | null> {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return null;
  if (room.status !== "lobby" && room.status !== "between_rounds") return null;

  if (settings.gameMode !== undefined) {
    if (!VALID_GAME_MODES.has(settings.gameMode)) return null;
    if (!isGameModeEnabled(db, settings.gameMode)) throw new UserFacingError("This game mode is currently disabled");
    db.prepare("UPDATE mp_rooms SET game_mode = ? WHERE code = ?").run(settings.gameMode, code);
  }
  if (settings.categories !== undefined) {
    const categoryJson = settings.categories === null ? null : validateCategories(settings.categories);
    db.prepare("UPDATE mp_rooms SET category = ? WHERE code = ?").run(categoryJson, code);
  }
  if (settings.totalRounds !== undefined) {
    const rounds = clampRounds(settings.totalRounds);
    db.prepare("UPDATE mp_rooms SET total_rounds = ? WHERE code = ?").run(rounds, code);
  }
  if (settings.password !== undefined) {
    const rawPw = sanitizePassword(settings.password);
    const pw = rawPw ? await hash(rawPw, BCRYPT_ROUNDS) : null;
    db.prepare("UPDATE mp_rooms SET password = ? WHERE code = ?").run(pw, code);
  }
  if (settings.isPublic !== undefined) {
    db.prepare("UPDATE mp_rooms SET is_public = ? WHERE code = ?").run(settings.isPublic ? 1 : 0, code);
  }

  touchRoomActivity(code);

  return getRoom(code);
}

export function disconnectPlayer(playerId: string): { roomCode: string; newHostId?: string } | null {
  const player = db
    .prepare("SELECT * FROM mp_players WHERE id = ?")
    .get(playerId) as DbPlayer | undefined;
  if (!player) return null;

  let newHostId: string | undefined;

  const doDisconnect = db.transaction(() => {
    db.prepare("UPDATE mp_players SET connected = 0 WHERE id = ?").run(playerId);
    touchRoomActivity(player.room_code);

    // If host disconnected, promote next connected human player (never promote a bot)
    if (player.is_host === 1) {
      const nextHost = db
        .prepare(
          "SELECT * FROM mp_players WHERE room_code = ? AND id != ? AND is_kicked = 0 AND connected = 1 AND is_bot = 0 ORDER BY joined_at ASC LIMIT 1"
        )
        .get(player.room_code, playerId) as DbPlayer | undefined;

      if (nextHost) {
        db.prepare("UPDATE mp_players SET is_host = 0 WHERE id = ?").run(playerId);
        db.prepare("UPDATE mp_players SET is_host = 1 WHERE id = ?").run(nextHost.id);
        db.prepare("UPDATE mp_rooms SET host_player_id = ? WHERE code = ?").run(nextHost.id, player.room_code);
        newHostId = nextHost.id;
      }
    }
  });
  doDisconnect();

  return { roomCode: player.room_code, newHostId };
}

export function getRoom(code: string): MultiplayerRoom | null {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!room) return null;

  const players = db
    .prepare("SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0 ORDER BY joined_at ASC")
    .all(code) as DbPlayer[];

  return toRoom(room, players);
}

export function getPlayerByToken(token: string): DbPlayer | null {
  const player = db
    .prepare("SELECT * FROM mp_players WHERE token = ?")
    .get(token) as DbPlayer | undefined;
  return player || null;
}

export function getPlayerById(playerId: string): DbPlayer | null {
  const player = db
    .prepare("SELECT * FROM mp_players WHERE id = ?")
    .get(playerId) as DbPlayer | undefined;
  return player || null;
}

/**
 * Reset a finished room back to the lobby state for a "Play Again" flow.
 *
 * Behavior:
 * - Clears scores, guesses, current round, and `finished_at`.
 * - Re-creates bot players using the saved `bot_count` + `bot_difficulty`
 *   from `mp_rooms` so the host doesn't have to re-add them every round.
 *   Existing bot rows are deleted first to avoid duplicate-ID conflicts
 *   from the previous game's bots; fresh IDs/avatars are assigned. The
 *   host can still remove bots manually between rounds via `removeBots`.
 *
 * @param code - Room code.
 * @param hostPlayerId - Caller's player ID. Must equal the room's host.
 * @returns The updated room, or null if the caller is not the host.
 */
export function resetRoom(code: string, hostPlayerId: string): MultiplayerRoom | null {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(code) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return null;

  const now = new Date().toISOString();
  // Capture the prior bot config BEFORE we mutate room state so the
  // re-add below preserves whatever the host had configured last round.
  const savedBotCount = Number.isInteger(room.bot_count) ? room.bot_count : 0;
  const savedBotDifficulty = (
    BOT_DIFFICULTIES as readonly string[]
  ).includes(room.bot_difficulty)
    ? (room.bot_difficulty as BotDifficulty)
    : "medium";

  db.transaction(() => {
    // Clearing `current_game_id` here is load-bearing for analytics dedup:
    // mpRoundStart mints a fresh id on the next lobby→playing transition,
    // so the second game's `mp_game_started` / `mp_game_completed` events
    // get distinct dedup keys from the first game's events even though the
    // room code is identical.
    db.prepare("UPDATE mp_rooms SET status = 'lobby', current_round = 0, finished_at = NULL, last_activity_at = ?, current_game_id = NULL WHERE code = ?").run(now, code);
    // Reset only HUMAN scores. Bots get rebuilt below with fresh rows
    // so their score state comes from INSERT defaults, not from this UPDATE.
    db.prepare("UPDATE mp_players SET total_score = 0 WHERE room_code = ?").run(code);
    db.prepare("DELETE FROM mp_guesses WHERE room_code = ?").run(code);
    // Always purge bot rows even when count is 0 — handles the edge case
    // where stale bot rows linger from a partial write or earlier bug. The
    // `bot_count` column is the source of truth; rows must match.
    db.prepare("DELETE FROM mp_players WHERE room_code = ? AND is_bot = 1").run(code);
  })();

  // Re-add bots OUTSIDE the transaction above because addBots() opens its
  // own transaction; nesting better-sqlite3 transactions throws. addBots
  // re-stamps `bot_count` + `bot_difficulty` and updates `last_activity_at`.
  //
  // Cap the re-add against current human count: if more humans joined
  // between rounds (`between_rounds` state allows late joins), the saved
  // bot count could now exceed remaining capacity. Trim down rather than
  // throwing so Play Again always succeeds.
  if (savedBotCount > 0) {
    const humanCount = (
      db
        .prepare(
          "SELECT COUNT(*) as count FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND is_bot = 0",
        )
        .get(code) as { count: number }
    ).count;
    const cappedBotCount = Math.max(0, Math.min(savedBotCount, MAX_PLAYERS - humanCount));
    if (cappedBotCount > 0) {
      addBots(code, hostPlayerId, cappedBotCount, savedBotDifficulty);
    }
  }

  return getRoom(code);
}

/**
 * Delete a room and all associated data (players, guesses).
 *
 * @param code - The room code to delete.
 */
export function deleteRoom(code: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM mp_guesses WHERE room_code = ?").run(code);
    db.prepare("DELETE FROM mp_players WHERE room_code = ?").run(code);
    db.prepare("DELETE FROM mp_rooms WHERE code = ?").run(code);
  })();
}

/**
 * Clean up in-memory state for a finished room while preserving all DB rows.
 *
 * Previously this helper deleted `mp_guesses` and `mp_players`, but doing so
 * breaks the lazy recap path in `buildMPRecap` — once those rows are gone,
 * the `GET /api/user/history/:historyId/recap` endpoint can no longer
 * reconstruct the round-by-round breakdown for any legacy `user_game_history`
 * row whose `share_id` never got stamped proactively. mp_rooms was already
 * preserved for analytics; we now extend the same treatment to players and
 * guesses so every finished MP game stays replayable.
 *
 * In-memory timer/bidding state is cleared by the caller via
 * `cleanupRoomMemory`; this function is now effectively a no-op on the DB
 * and is kept as an explicit call site for clarity + future hook.
 *
 * @param _code - The room code (unused; retained for API compatibility).
 */
export function cleanupFinishedRoom(_code: string): void {
  // Retained intentionally as a no-op so the disconnect handler's explicit
  // "finished vs non-finished" branch keeps reading naturally. If we later
  // want to TTL finished-room data (e.g. drop after 90 days), add it here
  // or in cleanupStaleRooms rather than re-introducing the immediate purge.
}

/**
 * Mark players as disconnected in the DB if their socket no longer exists.
 *
 * The socket TTL eviction clears in-memory socket metadata after 30 min of
 * inactivity, but does not update the DB. This leaves ghost players with
 * `connected = 1` that prevent room cleanup rules from firing.
 *
 * @param livePlayerIds - Set of player IDs that currently have a live socket.
 * @returns Number of players marked as disconnected.
 */
export function reapDisconnectedPlayers(livePlayerIds: Set<string>): number {
  const connectedInDb = db
    .prepare("SELECT id, room_code FROM mp_players WHERE connected = 1 AND is_kicked = 0")
    .all() as { id: string; room_code: string }[];

  let reaped = 0;
  for (const player of connectedInDb) {
    if (!livePlayerIds.has(player.id)) {
      db.prepare("UPDATE mp_players SET connected = 0 WHERE id = ?").run(player.id);
      reaped++;
    }
  }
  return reaped;
}

/**
 * Delete stale multiplayer rooms that are no longer active.
 *
 * Cleanup rules:
 * 1. Empty lobby rooms with no connected players older than 5 min — full purge.
 * 2. Finished rooms older than 10 min — evict from in-memory tracking, but
 *    preserve all DB rows (mp_rooms + mp_players + mp_guesses) so the history
 *    recap endpoint can reconstruct a round-by-round breakdown at any time.
 * 3. Orphaned 'ending' rooms older than 5 min (server crash recovery) — full purge.
 * 4. Abandoned rooms (playing/between_rounds) with 0 connected players,
 *    inactive 5+ min — full purge.
 * 5. Hard cap: any non-finished room inactive for 2+ hours — full purge.
 *
 * "Finished" rooms are treated as archival: mp_rooms already persisted for
 * analytics before this change, and we now extend the same retention to
 * mp_players + mp_guesses so `buildMPRecap` always has the source data
 * needed to render a recap. Storage grows O(games · avg_players · rounds),
 * which is small compared to existing analytics tables.
 *
 * @returns Array of room codes whose in-memory state should be cleaned up.
 *   For non-finished rooms this matches the set of codes whose DB rows were
 *   deleted; for finished rooms the DB rows stay but the room is still
 *   returned so the caller can free sockets/timers/bidding state.
 */
export function cleanupStaleRooms(): string[] {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // 2 hours — generous hard cap; a 20-round game should finish within ~30 min
  const hardCapAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // Gather candidates and delete in a single transaction to prevent a race
  // where a room receives new activity between the SELECT and DELETE.
  const toEvict = db.transaction(() => {
    // 1. Delete lobby rooms with no connected players, inactive 5+ min.
    //    Auto-lobbies seat bots with connected=1, so the "no connected
    //    players" clause would never fire for them — they'd survive until
    //    the 2-hour hard cap. Add a parallel branch that reaps auto-lobbies
    //    once they have no connected *humans* so they recycle on the same
    //    5-min cadence as user-created empty lobbies.
    const lobbies = db
      .prepare(
        `SELECT code FROM mp_rooms WHERE status = 'lobby' AND COALESCE(last_activity_at, created_at) < ?
         AND (
           NOT EXISTS (SELECT 1 FROM mp_players WHERE room_code = mp_rooms.code AND connected = 1 AND is_kicked = 0)
           OR (
             is_auto_lobby = 1
             AND NOT EXISTS (
               SELECT 1 FROM mp_players
                WHERE room_code = mp_rooms.code
                  AND connected = 1
                  AND is_kicked = 0
                  AND is_bot = 0
             )
           )
         )`
      )
      .all(fiveMinAgo) as { code: string }[];

    // 2. Finished rooms older than 10 min: evict in-memory state only —
    //    preserve DB rows so recap synthesis keeps working.
    const finished = db
      .prepare("SELECT code FROM mp_rooms WHERE status = 'finished' AND finished_at < ?")
      .all(tenMinAgo) as { code: string }[];

    // 3. Clean up orphaned 'ending' rooms (server crash during round-end transition)
    const orphanedEnding = db
      .prepare(
        `SELECT code FROM mp_rooms WHERE status = 'ending' AND COALESCE(last_activity_at, created_at) < ?`
      )
      .all(fiveMinAgo) as { code: string }[];

    // 4. Abandoned rooms in active states with no connected players, inactive 5+ min
    const abandoned = db
      .prepare(
        `SELECT code FROM mp_rooms WHERE status IN ('playing', 'between_rounds')
         AND COALESCE(last_activity_at, created_at) < ?
         AND NOT EXISTS (SELECT 1 FROM mp_players WHERE room_code = mp_rooms.code AND connected = 1 AND is_kicked = 0)`
      )
      .all(fiveMinAgo) as { code: string }[];

    // 5. Hard cap: any non-finished room inactive for 2+ hours regardless of player state
    const hardCap = db
      .prepare(
        `SELECT code FROM mp_rooms WHERE status != 'finished'
         AND COALESCE(last_activity_at, created_at) < ?`
      )
      .all(hardCapAgo) as { code: string }[];

    const seen = new Set<string>();
    const codes: string[] = [];
    for (const r of [...lobbies, ...finished, ...orphanedEnding, ...abandoned, ...hardCap]) {
      if (!seen.has(r.code)) {
        seen.add(r.code);
        codes.push(r.code);
      }
    }

    // Finished rooms keep ALL their DB rows; non-finished rooms get purged
    // (players + guesses + the room row itself). Both categories are still
    // returned so the caller can evict in-memory socket/timer state.
    const finishedCodes = new Set(finished.map((r) => r.code));

    for (const code of codes) {
      if (finishedCodes.has(code)) continue;
      db.prepare("DELETE FROM mp_guesses WHERE room_code = ?").run(code);
      db.prepare("DELETE FROM mp_players WHERE room_code = ?").run(code);
      db.prepare("DELETE FROM mp_rooms WHERE code = ?").run(code);
    }

    return codes;
  })();

  return toEvict;
}

/**
 * Add bot players to a room.
 *
 * @param roomCode - The room code
 * @param hostPlayerId - The host player's ID (authorization check)
 * @param botCount - Number of bots to add
 * @param difficulty - Bot difficulty level
 * @returns Updated room, or null if unauthorized/invalid
 * @throws UserFacingError if room would exceed MAX_PLAYERS
 */
export function addBots(
  roomCode: string,
  hostPlayerId: string,
  botCount: number,
  difficulty: BotDifficulty,
): MultiplayerRoom | null {
  // Runtime validation — callers may pass unvalidated input
  if (!Number.isInteger(botCount) || botCount < 0) return null;
  if (!(BOT_DIFFICULTIES as readonly string[]).includes(difficulty)) return null;

  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return null;
  if (room.status !== "lobby" && room.status !== "between_rounds") return null;

  return db.transaction(() => {
    const players = db
      .prepare("SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0")
      .all(roomCode) as DbPlayer[];
    if (players.length + botCount > MAX_PLAYERS) {
      throw new UserFacingError("Adding bots would exceed room capacity");
    }

    const existingNames = new Set(players.map((p) => p.display_name));
    // Honor the global ghost-name reservation: even though the labeled
    // bot-name generator uses an Adjective-Animal pool that's unlikely to
    // collide with handle-style ghost names, pre-populate the dedupe set
    // so a future generator change can't accidentally produce a ghost-
    // owned name.
    const ghostNames = db
      .prepare("SELECT username FROM ghost_users")
      .all() as { username: string }[];
    for (const g of ghostNames) existingNames.add(g.username);
    const botNames = generateBotNames(botCount, existingNames);
    const now = new Date().toISOString();

    for (const name of botNames) {
      const botId = uuidv4();
      const botToken = `bot-${uuidv4()}`;
      const avatar = pickAvatar(roomCode);
      db.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, is_bot)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, 1)`
      ).run(botId, roomCode, name, avatar, botToken, now);
    }

    db.prepare("UPDATE mp_rooms SET bot_count = ?, bot_difficulty = ?, last_activity_at = ? WHERE code = ?")
      .run(botCount, difficulty, now, roomCode);

    return getRoom(roomCode)!;
  })();
}

/**
 * Remove all bot players from a room.
 *
 * @param roomCode - The room code
 * @param hostPlayerId - The host player's ID (authorization check)
 * @returns Updated room, or null if unauthorized
 */
export function removeBots(roomCode: string, hostPlayerId: string): MultiplayerRoom | null {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return null;

  db.transaction(() => {
    db.prepare("DELETE FROM mp_players WHERE room_code = ? AND is_bot = 1").run(roomCode);
    db.prepare("UPDATE mp_rooms SET bot_count = 0, last_activity_at = ? WHERE code = ?")
      .run(new Date().toISOString(), roomCode);
  })();

  return getRoom(roomCode);
}

/**
 * Update bot configuration: removes existing bots and adds new ones atomically.
 *
 * @param roomCode - The room code
 * @param hostPlayerId - The host player's ID (authorization check)
 * @param botCount - New number of bots (0 removes all)
 * @param difficulty - New bot difficulty level
 * @returns Updated room, or null if unauthorized
 */
export function updateBotConfig(
  roomCode: string,
  hostPlayerId: string,
  botCount: number,
  difficulty: BotDifficulty,
): MultiplayerRoom | null {
  // Runtime validation — callers may be untyped (socket handlers)
  if (!Number.isInteger(botCount) || botCount < 0) return null;
  if (!(BOT_DIFFICULTIES as readonly string[]).includes(difficulty)) return null;

  if (botCount === 0) return removeBots(roomCode, hostPlayerId);

  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room || room.host_player_id !== hostPlayerId) return null;
  if (room.status !== "lobby" && room.status !== "between_rounds") return null;

  return db.transaction(() => {
    // Remove existing bots
    db.prepare("DELETE FROM mp_players WHERE room_code = ? AND is_bot = 1").run(roomCode);

    // Count remaining human players
    const humans = db
      .prepare("SELECT COUNT(*) as count FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND is_bot = 0")
      .get(roomCode) as { count: number };
    if (humans.count + botCount > MAX_PLAYERS) {
      throw new UserFacingError("Adding bots would exceed room capacity");
    }

    const existingNames = new Set(
      (db.prepare("SELECT display_name FROM mp_players WHERE room_code = ? AND is_kicked = 0").all(roomCode) as { display_name: string }[])
        .map((p) => p.display_name)
    );
    // Honor the global ghost-name reservation: even though the labeled
    // bot-name generator uses an Adjective-Animal pool that's unlikely to
    // collide with handle-style ghost names, pre-populate the dedupe set
    // so a future generator change can't accidentally produce a ghost-
    // owned name.
    const ghostNames = db
      .prepare("SELECT username FROM ghost_users")
      .all() as { username: string }[];
    for (const g of ghostNames) existingNames.add(g.username);
    const botNames = generateBotNames(botCount, existingNames);
    const now = new Date().toISOString();

    for (const name of botNames) {
      const botId = uuidv4();
      const botToken = `bot-${uuidv4()}`;
      const avatar = pickAvatar(roomCode);
      db.prepare(
        `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, connected, joined_at, is_bot)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, 1)`
      ).run(botId, roomCode, name, avatar, botToken, now);
    }

    db.prepare("UPDATE mp_rooms SET bot_count = ?, bot_difficulty = ?, last_activity_at = ? WHERE code = ?")
      .run(botCount, difficulty, now, roomCode);

    return getRoom(roomCode)!;
  })();
}
