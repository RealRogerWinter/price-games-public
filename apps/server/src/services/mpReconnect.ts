/**
 * Multiplayer reconnection and round-status query helpers.
 */
import db from "../db";
import type { GameMode, RoundStartPayload } from "@price-game/shared";
import { buildRoundStartPayload } from "./mpRoundStart";
import { getRoundStartTime } from "./mpTimerState";
import type { DbRoom } from "./dbTypes";

export function getRoundGuessCount(roomCode: string): { guessed: number; total: number } {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room) return { guessed: 0, total: 0 };

  const activePlayers = db
    .prepare("SELECT COUNT(*) as count FROM mp_players WHERE room_code = ? AND is_kicked = 0")
    .get(roomCode) as { count: number };
  const guessCount = db
    .prepare("SELECT COUNT(*) as count FROM mp_guesses WHERE room_code = ? AND round_number = ?")
    .get(roomCode, room.current_round) as { count: number };

  return { guessed: guessCount.count, total: activePlayers.count };
}

/** Get the current round payload for a reconnecting player. */
export function getCurrentRoundPayload(roomCode: string): RoundStartPayload | null {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room || room.status !== "playing") return null;

  const mode = room.game_mode as GameMode;
  const roundData = room.round_data ? JSON.parse(room.round_data) : {};
  const roundInfo = roundData[String(room.current_round)] || {};
  const productIds: number[] = roundInfo.productIds || JSON.parse(room.selected_products || "[]");

  const payload = buildRoundStartPayload(roomCode, room.current_round, mode, productIds, roundInfo);

  // Adjust timer to reflect elapsed time
  const startTime = getRoundStartTime(roomCode);
  if (startTime) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    payload.timerSeconds = Math.max(1, Math.round(payload.timerSeconds - elapsedSec));
  }

  return payload;
}

/** Get IDs of players who have already submitted a guess this round. */
export function getGuessedPlayerIds(roomCode: string): string[] {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room) return [];

  const guesses = db
    .prepare("SELECT player_id FROM mp_guesses WHERE room_code = ? AND round_number = ?")
    .all(roomCode, room.current_round) as { player_id: string }[];
  return guesses.map((g) => g.player_id);
}

/** Check if all currently connected players have submitted their guess. */
export function checkAllConnectedPlayersGuessed(roomCode: string): boolean {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room) return false;

  const connectedPlayers = db
    .prepare("SELECT id FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND connected = 1")
    .all(roomCode) as { id: string }[];

  if (connectedPlayers.length === 0) return true;

  const guessedIds = new Set(
    (db.prepare("SELECT player_id FROM mp_guesses WHERE room_code = ? AND round_number = ?")
      .all(roomCode, room.current_round) as { player_id: string }[]).map((g) => g.player_id)
  );

  return connectedPlayers.every((p) => guessedIds.has(p.id));
}
