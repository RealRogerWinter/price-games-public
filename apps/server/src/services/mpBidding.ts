/**
 * Bidding mode — bid submission and comparative scoring.
 *
 * Unlike other modes where scoring is per-player, bidding scores all bids
 * comparatively after the last bid is in. This module handles bid validation,
 * persistence, and final score writing.
 *
 * @module mpBidding
 */
import db from "../db";
import { scoreBidding, type BidPlacedPayload } from "@price-game/shared";
import { getBiddingState, recordBid as stateRecordBid } from "./mpBiddingState";
import { touchRoomActivity } from "./roomManager";
import type { DbRoom } from "./dbTypes";

/**
 * Submit a bid for the current turn in a bidding round.
 *
 * Validates turn order via the bidding state machine and persists the bid
 * to round_data in the DB for reconnection support.
 *
 * @param roomCode - The room code
 * @param playerId - The bidding player's ID
 * @param bidCents - The bid amount in cents
 * @returns null if invalid, or { bid, allBidsIn }
 */
export function submitBid(
  roomCode: string,
  playerId: string,
  bidCents: number,
): { bid: BidPlacedPayload; allBidsIn: boolean } | null {
  // Validate room is in playing state
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ? AND status = 'playing'").get(roomCode) as DbRoom | undefined;
  if (!room) return null;

  // Clamp to valid range: 1 cent minimum, $100,000 maximum (matches MAX_BID_CENTS elsewhere)
  // Also reject non-finite values (NaN, Infinity) that could corrupt downstream math.
  if (!Number.isFinite(bidCents)) return null;
  const MAX_BID_CENTS = 10_000_000;
  const safeBid = Math.max(1, Math.min(MAX_BID_CENTS, Math.round(bidCents)));

  // Record in the state machine (validates turn order)
  const result = stateRecordBid(roomCode, playerId, safeBid);
  if (!result) return null;

  // Persist bids to round_data for reconnection support and reveal display.
  // round_data is keyed by round number string: { "1": { productIds, bids, ... }, "2": ... }
  const state = getBiddingState(roomCode);
  if (state) {
    const existingRoundData = room.round_data ? JSON.parse(room.round_data) : {};
    const roundKey = String(room.current_round);
    const currentRoundMeta = existingRoundData[roundKey] ?? {};
    currentRoundMeta.bids = state.bids;
    existingRoundData[roundKey] = currentRoundMeta;

    db.prepare("UPDATE mp_rooms SET round_data = ?, last_activity_at = ? WHERE code = ?")
      .run(JSON.stringify(existingRoundData), new Date().toISOString(), roomCode);
  }

  touchRoomActivity(roomCode);
  return result;
}

/**
 * Finalize bidding scores after all bids are in.
 *
 * Reads the actual product price, applies closest-without-going-over scoring
 * via scoreBidding(), and writes results to mp_guesses and mp_players.
 *
 * @param roomCode - The room code
 */
export function finalizeBiddingScores(roomCode: string): void {
  const state = getBiddingState(roomCode);
  if (!state) return;

  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room) return;

  // Look up actual price
  const product = db.prepare("SELECT price_cents FROM products WHERE id = ?").get(state.productId) as { price_cents: number } | undefined;
  if (!product) return;

  // Score all bids
  const bids = state.bids.map((b) => ({ playerId: b.playerId, bidCents: b.bidCents }));
  const scores = scoreBidding(bids, product.price_cents);

  // Write to DB in a transaction
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const result of scores) {
      const bid = state.bids.find((b) => b.playerId === result.playerId)!;
      const guessData = JSON.stringify({ bidCents: bid.bidCents });

      db.prepare(
        `INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(roomCode, result.playerId, room.current_round, guessData, result.score, now);

      db.prepare("UPDATE mp_players SET total_score = total_score + ? WHERE id = ?")
        .run(result.score, result.playerId);
    }
  })();
}
