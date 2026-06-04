/**
 * Socket event handlers for gameplay operations.
 */
import type { Server, Socket } from "socket.io";
import { SOCKET_EVENTS } from "@price-game/shared";
import { safeErrorMessage } from "../services/errors";
import {
  startRound,
  submitGuess,
  endRound,
  hasRoundEnded,
  playerContinue,
  cleanupRoomMemory,
  getActivePlayers,
} from "../services/multiplayerEngine";
import { getRoom, getPlayerByToken, resetRoom } from "../services/roomManager";
import { getSocketMeta } from "./socketState";
import { scheduleBotGuesses, scheduleBotContinues, cancelBotTimers } from "../services/botScheduler";
import { generateBotGuess } from "../services/botGuess";
import { submitBid, finalizeBiddingScores } from "../services/mpBidding";
import {
  getBiddingState,
  getCurrentBidder,
  clearTurnTimer,
  setTurnTimer,
  cleanupBiddingState,
} from "../services/mpBiddingState";
import db from "../db";
import { MP_BIDDING_TURN_TIME_SECONDS, type BiddingTurnPayload } from "@price-game/shared";

/**
 * Look up product prices from the DB for the current round's products.
 */
function getProductPrices(productIds: number[]): Map<number, number> {
  const prices = new Map<number, number>();
  for (const id of productIds) {
    const row = db.prepare("SELECT price_cents FROM products WHERE id = ?").get(id) as { price_cents: number } | undefined;
    if (row) prices.set(id, row.price_cents);
  }
  return prices;
}

/**
 * Schedule bot guesses for a round and handle the results via the normal guess pipeline.
 */
function triggerBotGuesses(io: Server, roomCode: string, payload: import("@price-game/shared").RoundStartPayload): void {
  const players = getActivePlayers(roomCode);
  const bots = players.filter((p) => p.is_bot === 1);
  if (bots.length === 0) return;

  const room = db.prepare("SELECT bot_difficulty FROM mp_rooms WHERE code = ?").get(roomCode) as { bot_difficulty: string } | undefined;
  const difficulty = room?.bot_difficulty ?? "medium";

  // Collect product IDs from the payload
  const productIds: number[] = [];
  if (payload.product) productIds.push(payload.product.id);
  if (payload.products) productIds.push(...payload.products.map((p) => p.id));
  const productPrices = getProductPrices(productIds);

  scheduleBotGuesses(roomCode, payload, productPrices, bots, difficulty, ({ playerId, guessData }) => {
    try {
      const result = submitGuess(roomCode, playerId, guessData);
      if (!result) return;

      io.to(roomCode).emit(SOCKET_EVENTS.GAME_PLAYER_LOCKED, { playerId });

      if (result.allGuessed && !hasRoundEnded(roomCode)) {
        cancelBotTimers(roomCode);
        const results = endRound(roomCode, io);
        if (results) {
          emitRoundEndOrGameOver(io, roomCode, results);
        }
      }
    } catch {
      // Bot guess errors should not crash the server
    }
  });
}

/**
 * Schedule bot continue votes after round end.
 */
function triggerBotContinues(io: Server, roomCode: string, onTimerExpire: (code: string) => void): void {
  const players = getActivePlayers(roomCode);
  const bots = players.filter((p) => p.is_bot === 1);
  if (bots.length === 0) return;

  scheduleBotContinues(roomCode, bots, ({ playerId }) => {
    try {
      const result = playerContinue(roomCode, playerId);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_PLAYER_CONTINUED, { playerId });

      if (result.allContinued) {
        const room = getRoom(roomCode);
        if (room && room.status === "between_rounds") {
          const payload = startRound(roomCode, room.hostPlayerId, onTimerExpire);
          if (payload) {
            io.to(roomCode).emit(SOCKET_EVENTS.GAME_ROUND_START, payload);
            triggerPostRoundStart(io, roomCode, payload);
          }
        }
      }
    } catch {
      // Bot continue errors should not crash the server
    }
  });
}

/**
 * After a round starts, trigger the appropriate follow-up action:
 * - Bidding mode: delay 3s for shuffle animation then advance to first turn
 * - Standard modes: schedule bot guesses
 */
export function triggerPostRoundStart(io: Server, roomCode: string, payload: import("@price-game/shared").RoundStartPayload): void {
  if (payload.gameMode === "bidding") {
    setTimeout(() => {
      advanceBiddingTurn(io, roomCode);
    }, 3000);
  } else {
    triggerBotGuesses(io, roomCode, payload);
  }
}

/**
 * Emit round end or game over based on room status, and schedule bot
 * continues if the game is between rounds.
 */
function emitRoundEndOrGameOver(
  io: Server,
  roomCode: string,
  results: import("@price-game/shared").RoundResultsPayload,
): void {
  const room = getRoom(roomCode);
  if (room?.status === "finished") {
    io.to(roomCode).emit(SOCKET_EVENTS.GAME_OVER, { results, roomCode });
  } else {
    io.to(roomCode).emit(SOCKET_EVENTS.GAME_ROUND_END, results);
    // Schedule bot auto-continues for the between_rounds phase
    if (room && room.status === "between_rounds") {
      const onTimer = (code: string) => handleTimerExpire(io, code);
      triggerBotContinues(io, roomCode, onTimer);
    }
  }
}

/**
 * Pause after the final bid lands before emitting round results. The last bid
 * has already been broadcast via GAME_BID_PLACED; this gives players a beat
 * to actually see that bid render before the reveal overlay pops over it.
 *
 * Kept server-side so every client gets the same pacing and the server can
 * still clean up bidding state in one place.
 */
const BIDDING_REVEAL_DELAY_MS = 1500;

function scheduleBiddingRoundEnd(io: Server, roomCode: string): void {
  setTimeout(() => {
    try {
      finalizeBiddingScores(roomCode);
      const results = endRound(roomCode, io);
      if (results) {
        emitRoundEndOrGameOver(io, roomCode, results);
      }
      cleanupBiddingState(roomCode);
    } catch (err: unknown) {
      // Never crash the server on a scheduled finalize error. The room or
      // bidding state may have been reset between the schedule and the fire
      // (e.g. admin reset, crash recovery). Log so we can spot real bugs.
      console.warn(`[bidding] scheduled round-end failed for ${roomCode}:`, safeErrorMessage(err));
    }
  }, BIDDING_REVEAL_DELAY_MS);
}

export function handleStartRound(
  io: Server,
  socket: Socket,
  _data: any,
  callback: any,
  handleTimerExpire: (roomCode: string) => void
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    const payload = startRound(meta.roomCode, meta.playerId, handleTimerExpire);
    if (!payload) return callback?.({ error: "Cannot start round" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_ROUND_START, payload);
    callback?.({ success: true });

    triggerPostRoundStart(io, meta.roomCode, payload);
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export function handleSubmitGuess(
  io: Server,
  socket: Socket,
  data: { guessData: any },
  callback: any
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    const result = submitGuess(meta.roomCode, meta.playerId, data.guessData);
    if (!result) return callback?.({ error: "Cannot submit guess" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_PLAYER_LOCKED, { playerId: meta.playerId });
    callback?.({ score: result.score });

    if (result.allGuessed && !hasRoundEnded(meta.roomCode)) {
      cancelBotTimers(meta.roomCode);
      const results = endRound(meta.roomCode, io);
      if (results) {
        emitRoundEndOrGameOver(io, meta.roomCode, results);
      }
    }
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export function handleContinue(
  io: Server,
  socket: Socket,
  _data: any,
  callback: any,
  handleTimerExpire: (roomCode: string) => void
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    const player = getPlayerByToken(meta.playerToken);
    if (!player || player.is_kicked === 1) {
      return callback?.({ error: "Cannot continue" });
    }

    const result = playerContinue(meta.roomCode, meta.playerId);
    callback?.({ success: true });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_PLAYER_CONTINUED, { playerId: meta.playerId });

    if (result.allContinued) {
      const room = getRoom(meta.roomCode);
      if (room && room.status === "between_rounds") {
        const payload = startRound(meta.roomCode, room.hostPlayerId, handleTimerExpire);
        if (payload) {
          io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_ROUND_START, payload);
          triggerPostRoundStart(io, meta.roomCode, payload);
        }
      }
    }
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export function handlePlayAgain(
  io: Server,
  socket: Socket,
  _data: any,
  callback: any
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    cleanupRoomMemory(meta.roomCode);

    const room = resetRoom(meta.roomCode, meta.playerId);
    if (!room) return callback?.({ error: "Cannot reset room" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.ROOM_UPDATED, room);
    callback?.({ success: true });
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

export function handleTimerExpire(io: Server, roomCode: string): void {
  try {
    cancelBotTimers(roomCode);
    if (hasRoundEnded(roomCode)) return;

    const results = endRound(roomCode, io);
    if (!results) return;

    emitRoundEndOrGameOver(io, roomCode, results);
  } catch {
    // Timer expire errors should not crash the server
  }
}

// ── Bidding Mode Handlers ────────────────────────────────────────────

/**
 * Handle a bid submission from a player in bidding mode.
 */
export function handleSubmitBid(
  io: Server,
  socket: Socket,
  data: { bidCents: number },
  callback: any,
): void {
  try {
    const meta = getSocketMeta(socket.id);
    if (!meta) return callback?.({ error: "Not in a room" });

    const result = submitBid(meta.roomCode, meta.playerId, data.bidCents);
    if (!result) return callback?.({ error: "Cannot submit bid" });

    io.to(meta.roomCode).emit(SOCKET_EVENTS.GAME_BID_PLACED, result.bid);
    callback?.({ success: true });

    if (result.allBidsIn) {
      clearTurnTimer(meta.roomCode);
      scheduleBiddingRoundEnd(io, meta.roomCode);
    } else {
      advanceBiddingTurn(io, meta.roomCode);
    }
  } catch (err: unknown) {
    callback?.({ error: safeErrorMessage(err) });
  }
}

/**
 * Advance to the next bidder's turn in bidding mode.
 * Emits GAME_BIDDING_TURN and sets a per-turn timer.
 */
export function advanceBiddingTurn(io: Server, roomCode: string): void {
  const state = getBiddingState(roomCode);
  if (!state) return;

  clearTurnTimer(roomCode);

  const currentBidder = state.biddingOrder[state.currentTurnIndex];
  if (!currentBidder) return;

  const turnPayload: BiddingTurnPayload = {
    currentPlayerId: currentBidder.playerId,
    turnIndex: state.currentTurnIndex,
    totalPlayers: state.biddingOrder.length,
    timerSeconds: MP_BIDDING_TURN_TIME_SECONDS,
    previousBids: state.bids.map((b) => ({
      playerId: b.playerId,
      displayName: b.displayName,
      avatar: b.avatar,
      bidCents: b.bidCents,
    })),
  };

  io.to(roomCode).emit(SOCKET_EVENTS.GAME_BIDDING_TURN, turnPayload);

  // Check if current bidder is a bot — schedule auto-bid
  const playerRow = db.prepare("SELECT is_bot FROM mp_players WHERE id = ?").get(currentBidder.playerId) as { is_bot: number } | undefined;
  if (playerRow?.is_bot === 1) {
    scheduleBotBidTurn(io, roomCode);
    return;
  }

  // Per-turn timer for human players — auto-bid 1 cent on timeout
  const timer = setTimeout(() => {
    handleBiddingTurnTimeout(io, roomCode);
  }, MP_BIDDING_TURN_TIME_SECONDS * 1000);
  setTurnTimer(roomCode, timer);
}

/**
 * Handle a bidding turn timeout — auto-bid 1 cent.
 */
function handleBiddingTurnTimeout(io: Server, roomCode: string): void {
  try {
    const state = getBiddingState(roomCode);
    if (!state) return;

    const currentBidder = state.biddingOrder[state.currentTurnIndex];
    if (!currentBidder) return;

    // Auto-bid 1 cent (closest-without-going-over convention)
    const result = submitBid(roomCode, currentBidder.playerId, 1);
    if (!result) return;

    io.to(roomCode).emit(SOCKET_EVENTS.GAME_BID_PLACED, result.bid);

    if (result.allBidsIn) {
      scheduleBiddingRoundEnd(io, roomCode);
    } else {
      advanceBiddingTurn(io, roomCode);
    }
  } catch {
    // Timeout errors should not crash the server
  }
}

/**
 * Schedule a bot's bid during its turn in bidding mode.
 */
function scheduleBotBidTurn(io: Server, roomCode: string): void {
  const state = getBiddingState(roomCode);
  if (!state) return;

  const currentBidder = state.biddingOrder[state.currentTurnIndex];
  if (!currentBidder) return;

  const room = db.prepare("SELECT bot_difficulty FROM mp_rooms WHERE code = ?").get(roomCode) as { bot_difficulty: string } | undefined;
  const rawDifficulty = room?.bot_difficulty ?? "medium";
  // Normalize against the accepted set so a corrupted DB value can't propagate
  // to ARCHETYPE_WEIGHTS[undefined] and throw inside the sampler.
  const difficulty: import("@price-game/shared").BotDifficulty =
    rawDifficulty === "easy" || rawDifficulty === "hard" ? rawDifficulty : "medium";

  // Get product price for bid generation
  const product = db.prepare("SELECT price_cents FROM products WHERE id = ?").get(state.productId) as { price_cents: number } | undefined;
  if (!product) return;

  const delay = 2000 + Math.floor(Math.random() * 3000); // 2-5 seconds
  const timer = setTimeout(() => {
    try {
      const isLastBidder = state.currentTurnIndex === state.biddingOrder.length - 1;
      const previousBids = state.bids.map((b) => ({ playerId: b.playerId, bidCents: b.bidCents }));
      const guessData = generateBotGuess(
        "bidding",
        difficulty,
        {
          roundNumber: 1,
          gameMode: "bidding",
          timerSeconds: 20,
          product: { id: state.productId, title: "", imageUrl: "", description: "", category: "" },
        },
        new Map([[state.productId, product.price_cents]]),
        {
          botPlayerId: currentBidder.playerId,
          roomCode,
          bidding: { isLastBidder, previousBids },
        },
      );
      // Type-safe extraction: scoreBidding guess data has bidCents
      const bidCents = "bidCents" in guessData && typeof guessData.bidCents === "number"
        ? guessData.bidCents
        : 1;

      const result = submitBid(roomCode, currentBidder.playerId, bidCents);
      if (!result) return;

      io.to(roomCode).emit(SOCKET_EVENTS.GAME_BID_PLACED, result.bid);

      if (result.allBidsIn) {
        scheduleBiddingRoundEnd(io, roomCode);
      } else {
        advanceBiddingTurn(io, roomCode);
      }
    } catch {
      // Bot bid errors should not crash the server
    }
  }, delay);
  setTurnTimer(roomCode, timer);
}
