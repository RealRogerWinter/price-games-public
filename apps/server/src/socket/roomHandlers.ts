/**
 * Socket event handlers for room management operations.
 */
import type { Server, Socket } from "socket.io";
import type { GameMode } from "@price-game/shared";
import { VALID_GAME_MODES, SOCKET_EVENTS, MAX_PLAYERS, BOT_DIFFICULTIES, isValidDailyDate, getUtcDateString, MP_HOST_START_COUNTDOWN_MS, asJoinSource } from "@price-game/shared";
import { isDailyEnabled, isGameModeEnabled, getDailySchedule, getDisabledGameModes } from "../services/siteSettings";
import { getDailyModeForDate } from "@price-game/shared";
import db from "../db";
import { safeErrorMessage } from "../services/errors";
import {
  createRoom,
  joinRoom,
  rejoinRoom,
  kickPlayer,
  updateSettings,
  type RoomEventContext,
} from "../services/roomManager";

/**
 * Pull the analytics context (UA, IP, country, DNT) off a Socket.IO socket
 * so the downstream `recordEvent` call can populate device/geo dimensions
 * AND honor the caller's privacy preferences on room create/join events.
 * Sockets don't carry an Express `Request`, so we extract from the
 * underlying handshake. Returns an empty context when fields are missing —
 * events still record, just with those dimensions resolving to 'unknown'.
 */
function buildEventContext(socket: Socket): RoomEventContext {
  const headers = (socket.handshake?.headers ?? {}) as Record<
    string,
    string | string[] | undefined
  >;
  const ua = headers["user-agent"];
  const country = headers["cf-ipcountry"];
  // Match the Express `recordEventFromRequest` semantics — either DNT=1 or
  // Sec-GPC=1 strips PII from the stored event row.
  const dnt = headers["dnt"] === "1" || headers["sec-gpc"] === "1";
  return {
    userAgent: typeof ua === "string" ? ua : null,
    country: typeof country === "string" ? country : null,
    ip: getClientIp(socket) ?? null,
    dnt,
    // Forwarded from the io.use() handshake middleware in handlers.ts —
    // stamps mp_players.is_streamer_bot and short-circuits any analytics
    // emit that flows through this context.
    isStreamerBot: socket.data?.isStreamerBot === true,
  };
}
import type { DbRoom } from "../services/dbTypes";
import { attributeJoin } from "../services/inviteRewards";

/**
 * Return true if the requester has already completed today's daily (mirrors
 * the OR-axis logic in `/api/daily/start` and `/api/mp/quickplay`). Either
 * the logged-in user OR the device's visitor id blocks the attempt.
 */
function hasPlayedDailyForDate(
  userId: string | undefined | null,
  visitorId: string | undefined | null,
  dailyDate: string,
): boolean {
  if (!userId && !visitorId) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM daily_plays
        WHERE daily_date = ?
          AND (
            (? IS NOT NULL AND user_id = ?)
            OR (? IS NOT NULL AND visitor_id = ?)
          )
        LIMIT 1`,
    )
    .get(dailyDate, userId ?? null, userId ?? null, visitorId ?? null, visitorId ?? null);
  return !!row;
}
import { getCurrentRoundPayload, getGuessedPlayerIds, playerReady, clearReadyTracker } from "../services/multiplayerEngine";
import { startRound } from "../services/multiplayerEngine";
import { updateBotConfig, getRoom } from "../services/roomManager";
import { triggerPostRoundStart } from "./gameHandlers";
import type { BotDifficulty } from "@price-game/shared";
import {
  getSocketMeta,
  setSocketMeta,
  deleteSocketMeta,
  getPlayerSocketId,
  setPlayerSocket,
  deletePlayerSocket,
  deleteSocketEventCounter,
  checkCreateRoomLimit,
  checkRoomJoinLimit,
  getClientIp,
  cancelPendingDisconnect,
} from "./socketState";

export async function handleRoomCreate(
  io: Server,
  socket: Socket,
  data: { displayName: string; gameMode?: GameMode; categories?: string[]; password?: string; totalRounds?: number; isPublic?: boolean; dailyDate?: string; preferredAvatar?: string },
  callback: any
): Promise<void> {
  try {
    // If authenticated, use the user's username as display name
    const displayName = socket.data.user?.username || data.displayName;
    if (!displayName?.trim()) {
      return callback?.({ error: "Display name is required" });
    }
    if (data.gameMode && !VALID_GAME_MODES.has(data.gameMode)) {
      return callback?.({ error: "Invalid game mode" });
    }
    const effectiveMode = data.gameMode || "classic";
    if (!isGameModeEnabled(db, effectiveMode)) {
      return callback?.({ error: "This game mode is currently disabled" });
    }

    const ip = getClientIp(socket);
    if (!checkCreateRoomLimit(ip)) {
      return callback?.({ error: "Too many rooms created. Please wait." });
    }

    const userId = socket.data.user?.id;
    const visitorId = socket.data.visitorId as string | undefined;

    // Daily-challenge rooms carry extra constraints: the feature must be
    // enabled, the date must be a real YYYY-MM-DD, the game mode must
    // match what the admin schedule picks for that date, and the player
    // cannot already have played today. These mirror the REST daily gates
    // so a direct socket call can't skip them.
    let dailyDate: string | undefined;
    if (typeof data.dailyDate === "string" && data.dailyDate.length > 0) {
      if (!isDailyEnabled(db)) {
        return callback?.({ error: "Daily challenge is disabled" });
      }
      if (!isValidDailyDate(data.dailyDate)) {
        return callback?.({ error: "Invalid daily date" });
      }
      // Only today's UTC date is routable. Past/future dates would pre-create
      // (or collide with) `daily_puzzles` rows and let a client consume a
      // once-per-day slot outside the legitimate window.
      if (data.dailyDate !== getUtcDateString(new Date())) {
        return callback?.({ error: "Invalid daily date" });
      }
      // Block mode/date mismatch: the daily puzzle for this date uses a
      // specific mode; letting a crafted client create (e.g.) a "comparison"
      // daily room on a bidding day would load the wrong puzzle data.
      const schedule = getDailySchedule(db);
      const disabled = new Set(getDisabledGameModes(db) as GameMode[]);
      const scheduledMode = getDailyModeForDate(data.dailyDate, schedule, disabled);
      if (!scheduledMode) {
        return callback?.({ error: "Daily not scheduled for this date" });
      }
      if (scheduledMode !== effectiveMode) {
        return callback?.({ error: "Game mode does not match the daily schedule" });
      }
      if (hasPlayedDailyForDate(userId, visitorId, data.dailyDate)) {
        return callback?.({ error: "already_played" });
      }
      dailyDate = data.dailyDate;
    }

    const { room, playerId, playerToken } = await createRoom(
      displayName,
      data.gameMode || "classic",
      {
        categories: data.categories,
        password: data.password,
        totalRounds: data.totalRounds,
        isPublic: data.isPublic,
        dailyDate,
        preferredAvatar: data.preferredAvatar,
      },
      userId,
      visitorId,
      buildEventContext(socket),
    );
    socket.join(room.code);
    setSocketMeta(socket.id, { playerId, roomCode: room.code, playerToken, userId });
    setPlayerSocket(playerId, socket.id);
    callback?.({ room, playerId, playerToken });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export async function handleRoomJoin(
  io: Server,
  socket: Socket,
  data: {
    roomCode: string;
    displayName: string;
    password?: string;
    preferredAvatar?: string;
    /**
     * How the client got to this join point. Validated server-side via
     * `asJoinSource()` and forwarded to `roomManager.joinRoom`. Anything
     * unrecognized falls back to 'browser' — the most conservative bucket.
     */
    source?: string;
  },
  callback: any
): Promise<void> {
  try {
    // If authenticated, use the user's username as display name
    const displayName = socket.data.user?.username || data.displayName;
    if (!displayName?.trim()) {
      return callback?.({ error: "Display name is required" });
    }
    if (!checkRoomJoinLimit(data.roomCode)) {
      return callback?.({ error: "Too many join attempts for this room. Please wait." });
    }
    const userId = socket.data.user?.id;
    const visitorId = socket.data.visitorId as string | undefined;

    // Gate daily-room joins on once-per-day so matchmaking can't route a
    // returning player into a fresh attempt. Checked here (pre-join) rather
    // than at game end so the player gets immediate feedback.
    const targetRow = db
      .prepare("SELECT is_daily_game, daily_date FROM mp_rooms WHERE code = ?")
      .get(data.roomCode) as Pick<DbRoom, "is_daily_game" | "daily_date"> | undefined;
    if (targetRow?.is_daily_game === 1 && targetRow.daily_date) {
      if (hasPlayedDailyForDate(userId, visitorId, targetRow.daily_date)) {
        return callback?.({ error: "already_played" });
      }
    }

    const { room, playerId, playerToken } = await joinRoom(
      data.roomCode,
      displayName,
      data.password,
      userId,
      visitorId,
      data.preferredAvatar,
      asJoinSource(data.source) ?? "browser",
      buildEventContext(socket),
    );
    socket.join(room.code);

    // C2 fix: disconnect any existing socket for this player
    const oldSocketId = getPlayerSocketId(playerId);
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        deleteSocketMeta(oldSocketId);
        deleteSocketEventCounter(oldSocketId);
        oldSocket.disconnect(true);
      }
    }

    setSocketMeta(socket.id, { playerId, roomCode: room.code, playerToken, userId });
    setPlayerSocket(playerId, socket.id);

    // Lobby-invite attribution. The pg_inv cookie set by /r/:token is
    // attached to socket.data.inviteToken in the connection middleware. If
    // present and the joiner passes every abuse gate, we record a pending
    // attribution that will earn the host buff once the joiner completes
    // INVITE_REWARD_TRIGGER_ROUNDS rounds. Rejection is silent — the joiner
    // never knows the attribution failed.
    const inviteToken = socket.data.inviteToken as string | undefined;
    if (inviteToken && visitorId) {
      try {
        const ip = getClientIp(socket);
        const attr = attributeJoin(db, {
          token: inviteToken,
          joiner: {
            playerId,
            userId: userId ?? null,
            visitorId,
            ip,
            fp: null,
          },
        });
        if (attr.status === "pending") {
          // Stash on socket.data so mpRoundEnd can find this joiner without
          // re-querying. Cleared on disconnect / kick.
          socket.data.inviteAttributionId = attr.attributionId;
        }
      } catch (err) {
        // Never block the join on a reward-attribution error.
        console.error("[invite] attributeJoin failed", err);
      }
      // Clear the token from socket.data so a subsequent rejoin/join on the
      // same socket can't replay it. The pair_dedup gate in attributeJoin
      // already blocks re-earn, but clearing here makes the defense explicit.
      delete socket.data.inviteToken;
    }

    socket.to(room.code).emit(SOCKET_EVENTS.ROOM_PLAYER_JOINED, {
      player: room.players.find((p) => p.id === playerId),
    });

    callback?.({ room, playerId, playerToken });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export function handleRoomRejoin(
  io: Server,
  socket: Socket,
  data: { roomCode: string; playerToken: string },
  callback: any
): void {
  try {
    const result = rejoinRoom(data.roomCode, data.playerToken);
    if (!result.ok) {
      return callback?.({ error: true, code: result.code });
    }

    const { room, playerId } = result;
    socket.join(room.code);

    // If a pending-disconnect timer was armed for this player, cancel
    // it. When cancelled, the rest of the room never saw a leave, so
    // we also skip the "reconnected" broadcast to keep the roster
    // smooth — `hadPendingDisconnect === true` means "quick blip".
    const hadPendingDisconnect = cancelPendingDisconnect(playerId);

    // C2 fix: disconnect any existing socket for this player
    const oldSocketId = getPlayerSocketId(playerId);
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        deleteSocketMeta(oldSocketId);
        deleteSocketEventCounter(oldSocketId);
        oldSocket.disconnect(true);
      }
    }

    setSocketMeta(socket.id, { playerId, roomCode: room.code, playerToken: data.playerToken });
    setPlayerSocket(playerId, socket.id);

    // Only announce reconnection if the room actually saw the player
    // drop (i.e., the grace timer already fired and the DB flipped
    // `connected=0`). For sub-grace reconnects, skip the event.
    if (!hadPendingDisconnect) {
      socket.to(room.code).emit(SOCKET_EVENTS.ROOM_PLAYER_RECONNECTED, { playerId });
    }

    if (result.hostChanged) {
      io.to(room.code).emit(SOCKET_EVENTS.ROOM_HOST_CHANGED, { newHostId: result.newHostId });
    }

    let currentRoundData = null;
    let guessedPlayerIds: string[] = [];
    if (room.status === "playing") {
      currentRoundData = getCurrentRoundPayload(room.code);
      guessedPlayerIds = getGuessedPlayerIds(room.code);
    }

    callback?.({ room, playerId, currentRoundData, guessedPlayerIds });
  } catch (err: unknown) {
    callback?.({ error: true, code: "unknown", message: safeErrorMessage(err) });
  }
}

export function handleRoomKick(
  io: Server,
  socket: Socket,
  data: { playerId: string },
  callback: any
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    const success = kickPlayer(meta.roomCode, meta.playerId, data.playerId);
    if (!success) return callback?.({ error: "Cannot kick player" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_PLAYER_KICKED, { playerId: data.playerId });

    const kickedSocketId = getPlayerSocketId(data.playerId);
    if (kickedSocketId) {
      const kickedSocket = io.sockets.sockets.get(kickedSocketId);
      if (kickedSocket) {
        kickedSocket.leave(meta.roomCode);
        deleteSocketMeta(kickedSocketId);
        // H4 fix: clean up event counter immediately
        deleteSocketEventCounter(kickedSocketId);
      }
      deletePlayerSocket(data.playerId);
    }

    callback?.({ success: true });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export async function handleRoomSettings(
  io: Server,
  socket: Socket,
  data: { gameMode?: GameMode; categories?: string[] | null; totalRounds?: number; password?: string | null; isPublic?: boolean },
  callback: any
): Promise<void> {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    if (data.gameMode && !VALID_GAME_MODES.has(data.gameMode)) {
      return callback?.({ error: "Invalid game mode" });
    }
    if (data.gameMode && !isGameModeEnabled(db, data.gameMode)) {
      return callback?.({ error: "This game mode is currently disabled" });
    }

    const room = await updateSettings(meta.roomCode, meta.playerId, data);
    if (!room) return callback?.({ error: "Cannot update settings" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, {
      gameMode: room.gameMode,
      categories: room.categories,
      totalRounds: room.totalRounds,
      hasPassword: room.hasPassword,
      isPublic: room.isPublic,
    });

    callback?.({ success: true });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

/**
 * Handle bot configuration changes from the host.
 */
export function handleBotConfig(
  io: Server,
  socket: Socket,
  data: { botCount: number; botDifficulty: BotDifficulty },
  callback: any,
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    // Validate botCount: must be a non-negative integer within capacity bounds.
    // Guards against NaN, Infinity, negatives, fractions, and overflow.
    if (
      typeof data?.botCount !== "number" ||
      !Number.isInteger(data.botCount) ||
      data.botCount < 0 ||
      data.botCount > MAX_PLAYERS
    ) {
      return callback?.({ error: "Invalid bot count" });
    }
    if (!BOT_DIFFICULTIES.includes(data.botDifficulty)) {
      return callback?.({ error: "Invalid bot difficulty" });
    }

    const room = updateBotConfig(meta.roomCode, meta.playerId, data.botCount, data.botDifficulty);
    if (!room) return callback?.({ error: "Cannot update bot config" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_BOTS_UPDATED, {
      botCount: room.botCount,
      botDifficulty: room.botDifficulty,
      players: room.players,
    });

    callback?.({ success: true });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

/**
 * Handle a player marking themselves as ready in the lobby.
 * If all connected human players are ready, auto-starts the round.
 */
export function handleReady(
  io: Server,
  socket: Socket,
  _data: any,
  callback: any,
  handleTimerExpire: (roomCode: string) => void,
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    // Verify the player is an active, non-kicked, non-bot member of the room
    // before allowing them to contribute to the ready count. Guards against
    // spoofed room:ready events with stale or invalid playerIds.
    const playerRow = db
      .prepare(
        "SELECT is_kicked, is_bot FROM mp_players WHERE id = ? AND room_code = ?"
      )
      .get(meta.playerId, meta.roomCode) as { is_kicked: number; is_bot: number } | undefined;
    if (!playerRow || playerRow.is_kicked === 1 || playerRow.is_bot === 1) {
      return callback?.({ error: "Not a valid player" });
    }

    const result = playerReady(meta.roomCode, meta.playerId);
    callback?.({ success: true });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_PLAYER_READY, { playerId: meta.playerId });

    if (result.allReady) {
      const room = getRoom(meta.roomCode);
      if (room && room.status === "lobby") {
        clearReadyTracker(meta.roomCode);
        const payload = startRound(meta.roomCode, room.hostPlayerId, handleTimerExpire);
        if (payload) {
          io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_ROUND_START, payload);
          // Schedule bot guesses / bidding turn advancement (parity with handleStartRound)
          triggerPostRoundStart(io, meta.roomCode, payload);
        }
      }
    }
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

/**
 * Handle the host clicking "Start Game" with a 10-second pre-game
 * countdown. Sets `mp_rooms.countdown_target_at` (and started_at) so
 * every connected client picks up the new value via a follow-up
 * `ROOM_UPDATED` broadcast and renders the existing AutoLobbyCountdown
 * component. The actual `startRound` fires when the countdown driver
 * tick (in `index.ts`) sees the elapsed timer.
 *
 * Refuses to act when:
 *   - The acting player isn't the host of their room.
 *   - The room is not in lobby status.
 *   - A countdown is already running (idempotent under double-click).
 */
export function handleHostStartCountdown(
  io: Server,
  socket: Socket,
  _data: unknown,
  callback: (resp: unknown) => void,
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });
    const room = getRoom(meta.roomCode);
    if (!room) return callback?.({ error: "Room not found" });
    if (room.status !== "lobby") return callback?.({ error: "Game already in progress" });
    if (room.hostPlayerId !== meta.playerId) {
      return callback?.({ error: "Only the host can start the game" });
    }
    if (room.countdownTargetAt) {
      // Already counting down — silent success so a double-click on
      // the Start button doesn't error out the UI.
      return callback?.({ success: true });
    }

    const now = new Date();
    const startedAt = now.toISOString();
    const targetAt = new Date(now.getTime() + MP_HOST_START_COUNTDOWN_MS).toISOString();
    db.prepare(
      "UPDATE mp_rooms SET countdown_started_at = ?, countdown_target_at = ?, last_activity_at = ? WHERE code = ?",
    ).run(startedAt, targetAt, startedAt, meta.roomCode);

    callback?.({ success: true });

    // Broadcast updated room state so every client renders the
    // countdown banner. Reuses `ROOM_UPDATED` so the existing client
    // patch path applies the new countdownTargetAt without a
    // bespoke socket event.
    const updated = getRoom(meta.roomCode);
    if (updated) {
      io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_UPDATED, updated);
    }
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}
