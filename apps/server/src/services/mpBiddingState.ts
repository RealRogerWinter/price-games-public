/**
 * In-memory state machine for bidding mode rounds.
 *
 * Manages the sequential turn order, tracks placed bids, and per-turn timers.
 * Parallel to mpTimerState.ts but specific to the bidding flow.
 *
 * @module mpBiddingState
 */
import type { BidPlacedPayload } from "@price-game/shared";

interface BiddingRoundState {
  roomCode: string;
  biddingOrder: Array<{ playerId: string; displayName: string; avatar: string }>;
  currentTurnIndex: number;
  bids: Array<{ playerId: string; displayName: string; avatar: string; bidCents: number }>;
  turnTimer: ReturnType<typeof setTimeout> | null;
  productId: number;
}

const activeBiddingRounds = new Map<string, BiddingRoundState>();

/**
 * Fisher-Yates shuffle (returns new array).
 */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Initialize a bidding round: shuffle player order, store state.
 *
 * @param roomCode - The room code
 * @param players - Array of { playerId, displayName, avatar }
 * @param productId - The product being bid on
 * @returns The randomized bidding order
 */
export function initBiddingRound(
  roomCode: string,
  players: Array<{ playerId: string; displayName: string; avatar: string }>,
  productId: number,
): Array<{ playerId: string; displayName: string; avatar: string }> {
  const biddingOrder = shuffle(players);

  activeBiddingRounds.set(roomCode, {
    roomCode,
    biddingOrder,
    currentTurnIndex: 0,
    bids: [],
    turnTimer: null,
    productId,
  });

  return biddingOrder;
}

/**
 * Get the current bidding state for a room.
 */
export function getBiddingState(roomCode: string): BiddingRoundState | undefined {
  return activeBiddingRounds.get(roomCode);
}

/**
 * Get the current bidder (the player whose turn it is).
 */
export function getCurrentBidder(roomCode: string): { playerId: string; displayName: string; avatar: string } | undefined {
  const state = activeBiddingRounds.get(roomCode);
  if (!state) return undefined;
  return state.biddingOrder[state.currentTurnIndex];
}

/**
 * Record a bid for the current turn.
 *
 * @param roomCode - The room code
 * @param playerId - The player submitting the bid
 * @param bidCents - The bid amount in cents
 * @returns null if invalid (wrong turn / unknown room), or { bid, allBidsIn }
 */
export function recordBid(
  roomCode: string,
  playerId: string,
  bidCents: number,
): { bid: BidPlacedPayload; allBidsIn: boolean } | null {
  const state = activeBiddingRounds.get(roomCode);
  if (!state) return null;

  const currentBidder = state.biddingOrder[state.currentTurnIndex];
  if (!currentBidder || currentBidder.playerId !== playerId) return null;

  const bid: BidPlacedPayload = {
    playerId,
    displayName: currentBidder.displayName,
    avatar: currentBidder.avatar,
    bidCents,
    turnIndex: state.currentTurnIndex,
  };

  state.bids.push({
    playerId,
    displayName: currentBidder.displayName,
    avatar: currentBidder.avatar,
    bidCents,
  });

  state.currentTurnIndex++;
  const allBidsIn = state.currentTurnIndex >= state.biddingOrder.length;

  return { bid, allBidsIn };
}

/**
 * Store a per-turn timer for the current bidding round.
 */
export function setTurnTimer(roomCode: string, timer: ReturnType<typeof setTimeout>): void {
  const state = activeBiddingRounds.get(roomCode);
  if (state) state.turnTimer = timer;
}

/**
 * Clear the per-turn timer for the current bidding round.
 */
export function clearTurnTimer(roomCode: string): void {
  const state = activeBiddingRounds.get(roomCode);
  if (state?.turnTimer) {
    clearTimeout(state.turnTimer);
    state.turnTimer = null;
  }
}

/**
 * Clean up all bidding state for a room.
 */
export function cleanupBiddingState(roomCode: string): void {
  const state = activeBiddingRounds.get(roomCode);
  if (state?.turnTimer) {
    clearTimeout(state.turnTimer);
  }
  activeBiddingRounds.delete(roomCode);
}
