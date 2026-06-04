/**
 * Socket.IO event handler orchestrator.
 *
 * Wires socket events to focused handler modules.
 * Business logic lives in roomHandlers, gameHandlers, and disconnectHandler.
 */
import { Server, Socket } from "socket.io";
import { SOCKET_EVENTS } from "@price-game/shared";
import { checkSocketRateLimit, touchSocketActivity } from "./socketState";
import {
  handleRoomCreate,
  handleRoomJoin,
  handleRoomRejoin,
  handleRoomKick,
  handleRoomSettings,
  handleBotConfig,
  handleReady,
  handleHostStartCountdown,
} from "./roomHandlers";
import {
  handleStartRound,
  handleSubmitGuess,
  handleSubmitBid,
  handleContinue,
  handlePlayAgain,
  handleTimerExpire,
} from "./gameHandlers";
import { handleDisconnect } from "./disconnectHandler";
import { validateUserSession } from "../services/userAuth";
import { config } from "../config";
import db from "../db";
import { detectStreamerBotFromHeaders } from "../middleware/streamerBot";

/**
 * Parse a specific cookie value from a raw Cookie header string.
 *
 * @param header - The raw Cookie header (e.g. "a=1; b=2").
 * @param name - The cookie name to extract.
 * @returns The cookie value, or undefined if not found.
 */
function parseCookie(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function setupSocketHandlers(io: Server): void {
  const onTimerExpire = (roomCode: string) => handleTimerExpire(io, roomCode);

  // User session + visitor cookie extraction middleware — runs before the
  // connection handler. Extracts a valid user session from the cookie header
  // and attaches it to socket.data.user. Also extracts the visitor_id cookie
  // (if it matches a UUID) and attaches it as socket.data.visitorId so that
  // end-of-round code can credit anonymous game plays to the visitor cohort.
  //
  // Unlike the REST middleware, sockets cannot SET a cookie on the response —
  // if the handshake arrives without a visitor_id cookie, it stays undefined.
  // In practice this is fine: any visitor who reaches the multiplayer lobby
  // has already hit / via HTTP and been issued the cookie there.
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  io.use((socket, next) => {
    // Streamer-bot detection (mirror of the Express middleware). The bot's
    // Playwright context sets `X-Streamer-Bot: <secret>` on every request,
    // including the WebSocket upgrade handshake. When matched, downstream
    // analytics emits skip so the bot's gameplay does not pollute counters.
    if (
      detectStreamerBotFromHeaders(
        socket.handshake.headers as Record<string, string | string[] | undefined>,
        config.streamerBotSecret,
      )
    ) {
      socket.data.isStreamerBot = true;
    }

    const cookieHeader = socket.handshake.headers.cookie;
    if (cookieHeader) {
      const token = parseCookie(cookieHeader, config.userCookieName);
      if (token) {
        const user = validateUserSession(db, token);
        if (user) {
          socket.data.user = user;
        }
      }
      const visitorId = parseCookie(cookieHeader, config.visitorCookieName);
      if (visitorId && UUID_REGEX.test(visitorId)) {
        socket.data.visitorId = visitorId;
      }
      // pg_inv: lobby-invite token issued by /r/:token. Attached here so the
      // join handler can attribute the joiner back to the inviter when the
      // socket connects mid-redirect.
      const inviteToken = parseCookie(cookieHeader, "pg_inv");
      if (inviteToken && /^[A-Za-z0-9]{10}$/.test(inviteToken)) {
        socket.data.inviteToken = inviteToken;
      }
    }
    next();
  });

  io.on("connection", (socket: Socket) => {
    // Join a user-specific room for targeted notification delivery
    if (socket.data.user?.id) {
      socket.join(`user:${socket.data.user.id}`);
    }

    // Per-event rate limiting (runs before event handlers)
    socket.use((_event, next) => {
      if (!checkSocketRateLimit(socket.id)) {
        next(new Error("Rate limit exceeded"));
        socket.disconnect(true);
        return;
      }
      touchSocketActivity(socket.id);
      next();
    });

    // Room management
    socket.on(SOCKET_EVENTS.ROOM_CREATE, (data, cb) => handleRoomCreate(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_JOIN, (data, cb) => handleRoomJoin(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_REJOIN, (data, cb) => handleRoomRejoin(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_KICK, (data, cb) => handleRoomKick(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_SETTINGS, (data, cb) => handleRoomSettings(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_BOT_CONFIG, (data, cb) => handleBotConfig(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.ROOM_READY, (data, cb) => handleReady(io, socket, data, cb, onTimerExpire));

    // Gameplay
    socket.on(SOCKET_EVENTS.ROOM_START_ROUND, (data, cb) => handleStartRound(io, socket, data, cb, onTimerExpire));
    socket.on(SOCKET_EVENTS.ROOM_HOST_START_COUNTDOWN, (data, cb) => handleHostStartCountdown(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.GAME_SUBMIT_GUESS, (data, cb) => handleSubmitGuess(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.GAME_SUBMIT_BID, (data, cb) => handleSubmitBid(io, socket, data, cb));
    socket.on(SOCKET_EVENTS.GAME_CONTINUE, (data, cb) => handleContinue(io, socket, data, cb, onTimerExpire));
    socket.on(SOCKET_EVENTS.ROOM_PLAY_AGAIN, (data, cb) => handlePlayAgain(io, socket, data, cb));

    // App-level liveness probe. The client emits this with an ack on
    // tab-resume to detect "zombie" sockets — WebSocket readyState may
    // report OPEN on iOS Safari long after the underlying transport is
    // dead. A fast reply here proves the tunnel is really alive.
    socket.on(SOCKET_EVENTS.MP_HEARTBEAT, (_data, cb) => {
      try { cb?.({ t: Date.now() }); } catch { /* client disappeared */ }
    });

    // Lifecycle
    socket.on("disconnect", () => handleDisconnect(io, socket));
  });
}
