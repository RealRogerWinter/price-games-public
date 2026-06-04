/**
 * Multiplayer guess submission and scoring.
 */
import db from "../db";
import { getActivePlayers } from "./mpRoundStart";
import { scoreGuessForMode } from "./guessScoring";
import { GameMode } from "@price-game/shared";
import type { DbRoom, DbPlayer } from "./dbTypes";

export function submitGuess(
  roomCode: string,
  playerId: string,
  // Kept as `any` at the input boundary — unvalidated socket data is
  // runtime-validated per-mode inside scoreGuessForMode().
  guessData: any
): { score: number; allGuessed: boolean } | null {
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room || room.status !== "playing") return null;

  const player = db.prepare("SELECT * FROM mp_players WHERE id = ? AND room_code = ?").get(playerId, roomCode) as DbPlayer | undefined;
  if (!player || player.is_kicked === 1) return null;

  const mode = room.game_mode as GameMode;
  const roundData = room.round_data ? JSON.parse(room.round_data) : {};
  const roundMeta = roundData[String(room.current_round)] || {};
  const productIds: number[] = JSON.parse(room.selected_products || "[]");

  // Score the guess. Pass "mp" context so bidding mode returns a 0 placeholder
  // (final scores are computed later via finalizeBiddingScores across all bids).
  const { score } = scoreGuessForMode(mode, guessData, productIds, roundMeta, undefined, "mp");
  const now = new Date().toISOString();

  // Atomic check-insert-count to prevent race conditions (C1 fix)
  const result = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM mp_guesses WHERE room_code = ? AND player_id = ? AND round_number = ?")
      .get(roomCode, playerId, room.current_round);
    if (existing) return null;

    // Cap serialized guess data to prevent oversized DB rows from malicious payloads
    const MAX_GUESS_DATA_BYTES = 4096;
    const serializedGuess = JSON.stringify(guessData);
    const safeGuessData = serializedGuess.length > MAX_GUESS_DATA_BYTES
      ? serializedGuess.slice(0, MAX_GUESS_DATA_BYTES)
      : serializedGuess;

    db.prepare(
      `INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(roomCode, playerId, room.current_round, safeGuessData, score, now);

    db.prepare("UPDATE mp_players SET total_score = total_score + ? WHERE id = ?").run(score, playerId);

    db.prepare("UPDATE mp_rooms SET last_activity_at = ? WHERE code = ?").run(now, roomCode);

    const activePlayers = getActivePlayers(roomCode);
    const guessCount = db
      .prepare("SELECT COUNT(*) as count FROM mp_guesses WHERE room_code = ? AND round_number = ?")
      .get(roomCode, room.current_round) as { count: number };

    return { score, allGuessed: guessCount.count >= activePlayers.length };
  })();

  return result;
}

