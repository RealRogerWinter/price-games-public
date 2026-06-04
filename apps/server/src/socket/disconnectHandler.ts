/**
 * Socket disconnect handler.
 *
 * When a socket drops, the bulk of the bookkeeping is deferred by
 * `MP_DISCONNECT_GRACE_MS` so transient mobile-backgrounding blips can
 * be hidden from the rest of the room. If the player reconnects inside
 * the grace window, the rejoin handler cancels the pending timer and
 * `ROOM_PLAYER_LEFT` is never broadcast.
 */
import type { Server, Socket } from "socket.io";
import { SOCKET_EVENTS } from "@price-game/shared";
import { disconnectPlayer, getRoom, deleteRoom, cleanupFinishedRoom } from "../services/roomManager";
import {
  endRound,
  hasRoundEnded,
  checkAllConnectedPlayersGuessed,
  cleanupRoomMemory,
} from "../services/multiplayerEngine";
import {
  getSocketMeta,
  getPlayerSocketId,
  deleteSocketMeta,
  deletePlayerSocket,
  deleteSocketEventCounter,
  schedulePendingDisconnect,
} from "./socketState";

/**
 * Run the actual disconnect bookkeeping: flip `connected=0`, broadcast
 * `ROOM_PLAYER_LEFT`, promote host if needed, end the round early if
 * all remaining players have guessed, and clean up the room if no
 * connected players remain. Extracted so it can run inside a deferred
 * `setTimeout` callback.
 */
function finalizeDisconnect(io: Server, playerId: string): void {
  // Defensive: the normal rejoin path calls `cancelPendingDisconnect`
  // before the timer fires, so this callback should not run for a
  // reconnected player. But if a rejoin raced past the cancel (e.g.,
  // the rejoin handler threw between `setPlayerSocket` and
  // `cancelPendingDisconnect`), skipping the leave broadcast keeps
  // the room in a consistent state — the live socket is the
  // authoritative source of truth.
  const liveSocket = getPlayerSocketId(playerId);
  if (liveSocket) {
    return;
  }

  const result = disconnectPlayer(playerId);
  if (!result) return;

  io.to(result.roomCode).emit(SOCKET_EVENTS.ROOM_PLAYER_LEFT, { playerId });

  if (result.newHostId) {
    io.to(result.roomCode).emit(SOCKET_EVENTS.ROOM_HOST_CHANGED, { newHostId: result.newHostId });
  }

  const room = getRoom(result.roomCode);

  // If no connected human players remain, clean up the room. Bots now
  // always wire-mask isConnected:true (so labeled and disguised bots don't
  // flicker to "offline"), so we have to ignore them explicitly here. Auto-
  // lobbies with disguised bots still get reaped via cleanupStaleRooms,
  // but user-created rooms with labeled bots keep the same instant-cleanup
  // behavior they had before the override.
  if (room && room.players.every((p) => p.isBot || !p.isConnected)) {
    if (room.status === "finished") {
      cleanupFinishedRoom(result.roomCode);
    } else {
      deleteRoom(result.roomCode);
    }
    cleanupRoomMemory(result.roomCode);
    return;
  }

  // If disconnecting during a round, check if we should end it early.
  if (room && room.status === "playing" && !hasRoundEnded(result.roomCode)) {
    if (checkAllConnectedPlayersGuessed(result.roomCode)) {
      const results = endRound(result.roomCode, io);
      if (results) {
        const updatedRoom = getRoom(result.roomCode);
        if (updatedRoom && updatedRoom.currentRound >= updatedRoom.totalRounds) {
          io.to(result.roomCode).emit(SOCKET_EVENTS.GAME_OVER, { results, roomCode: result.roomCode });
        } else {
          io.to(result.roomCode).emit(SOCKET_EVENTS.GAME_ROUND_END, results);
        }
      }
    }
  }
}

export function handleDisconnect(io: Server, socket: Socket): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return;

    // Stale disconnect: a newer socket has already replaced this one.
    // Drop this socket's bookkeeping and bail — the newer socket owns
    // the player's room membership now.
    const currentSocketId = getPlayerSocketId(meta.playerId);
    if (currentSocketId && currentSocketId !== socket.id) {
      deleteSocketMeta(socket.id);
      deleteSocketEventCounter(socket.id);
      return;
    }

    const playerId = meta.playerId;

    // Release this specific socket's bookkeeping immediately — the
    // socket is gone, reusing its ID makes no sense. We deliberately
    // also clear the playerId → socketId mapping so a same-tick rejoin
    // on a new socket isn't confused by the stale entry.
    deletePlayerSocket(playerId);
    deleteSocketMeta(socket.id);
    deleteSocketEventCounter(socket.id);

    // Defer the "player left" broadcast + DB/room cleanup. If the
    // player rejoins inside the grace window, `cancelPendingDisconnect`
    // in roomHandlers will clear this timer. Delay is the runtime
    // grace default (configured at startup and overridable in tests).
    schedulePendingDisconnect(
      playerId,
      () => finalizeDisconnect(io, playerId)
    );
  } catch {
    // Best-effort cleanup on unexpected error.
    deleteSocketMeta(socket.id);
    deleteSocketEventCounter(socket.id);
  }
}
