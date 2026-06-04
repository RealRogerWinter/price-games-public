/**
 * Multiplayer round start — product selection, payload building, and timer setup.
 */
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { DbProduct, toProduct, getProductsByIds, getProductsForRound } from "./productMapper";
import {
  GameMode,
  MP_ROUND_TIME_SECONDS,
  MP_PRICE_MATCH_TIME_SECONDS,
  MP_MARKET_BASKET_TIME_SECONDS,
  MP_BUDGET_BUILDER_TIME_SECONDS,
  MP_CHAIN_REACTION_TIME_SECONDS,
  MP_BIDDING_TURN_TIME_SECONDS,
  RoundStartPayload,
} from "@price-game/shared";
import { initBiddingRound } from "./mpBiddingState";
import {
  clearContinueTracker,
  clearRoundTimer,
  setRoundEnded,
  setRoundStartTime,
  setRoundTimer,
} from "./mpTimerState";
import { touchRoomActivity } from "./roomManager";
import { composeRound } from "./roundComposer";
import { getOrCreateDailyPuzzle } from "./dailyPuzzle";
import { recordEvent } from "./eventLog";
import { ANALYTICS_EVENTS, asJoinSource, joinSourceToStartSource } from "@price-game/shared";
import type { DbRoom, DbPlayer } from "./dbTypes";

export function getActivePlayers(roomCode: string): DbPlayer[] {
  return db
    .prepare("SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0 ORDER BY joined_at ASC")
    .all(roomCode) as DbPlayer[];
}

/** Get the timer duration in seconds for a given game mode. */
export function getTimerSeconds(mode: GameMode): number {
  if (mode === "price-match") return MP_PRICE_MATCH_TIME_SECONDS;
  if (mode === "market-basket") return MP_MARKET_BASKET_TIME_SECONDS;
  if (mode === "budget-builder") return MP_BUDGET_BUILDER_TIME_SECONDS;
  if (mode === "chain-reaction") return MP_CHAIN_REACTION_TIME_SECONDS;
  if (mode === "bidding") return MP_BIDDING_TURN_TIME_SECONDS;
  return MP_ROUND_TIME_SECONDS;
}

export function startRound(
  roomCode: string,
  callerPlayerId: string,
  onTimerExpire: (code: string) => void
): RoundStartPayload | null {
  clearContinueTracker(roomCode);

  // Read room data needed for product selection (non-mutating)
  const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
  if (!room) return null;

  const mode = room.game_mode as GameMode;
  const newRound = room.current_round + 1;

  if (newRound > room.total_rounds) return null;

  let parsedCategories: string[] | undefined;
  if (room.category) {
    try {
      const arr = JSON.parse(room.category);
      if (Array.isArray(arr) && arr.length > 0) parsedCategories = arr;
    } catch {
      parsedCategories = [room.category];
    }
  }

  // Build sessionUsedIds from existing round data to avoid repeats within the game
  let existingRoundData: Record<string, any> = {};
  if (room.round_data) {
    try {
      existingRoundData = JSON.parse(room.round_data);
    } catch {
      // Corrupted round_data; start fresh
    }
  }
  const sessionUsedIds = new Set<number>();
  for (const rd of Object.values(existingRoundData)) {
    if ((rd as any).productIds) {
      for (const id of (rd as any).productIds) sessionUsedIds.add(id);
    }
  }

  // Daily rooms use the preset product lineup from `daily_puzzles` so every
  // player sees the same product on the same round (same-puzzle-for-everyone
  // parity with single-player daily). Non-daily rooms fall through to the
  // difficulty-aware composer. Any unexpected error from the daily path
  // falls back to the composer rather than aborting the round — once the
  // room is live players have already committed to the match and a blank
  // round is worse than slightly-off products.
  let productIds: number[];
  let roundMeta: Record<string, any>;
  let dailyRoundIds: number[] | null = null;
  if (room.is_daily_game === 1 && room.daily_date) {
    try {
      const puzzle = getOrCreateDailyPuzzle(db, room.daily_date);
      const puzzleRoundData = puzzle.round_data ? JSON.parse(puzzle.round_data) : {};
      const slice = puzzleRoundData[String(newRound)] as { productIds?: number[] } | undefined;
      if (Array.isArray(slice?.productIds) && slice!.productIds.length > 0) {
        dailyRoundIds = slice!.productIds;
      }
    } catch (err) {
      console.error(`[mpRoundStart] daily puzzle load failed for ${room.daily_date}`, err);
    }
  }
  if (dailyRoundIds) {
    productIds = dailyRoundIds;
    roundMeta = {};
  } else {
    const composed = composeRound({
      mode,
      totalRounds: room.total_rounds,
      roundNumber: newRound,
      categories: parsedCategories,
      sessionUsedIds,
    });
    productIds = composed.productIds;
    roundMeta = composed.roundMeta;
  }

  existingRoundData[String(newRound)] = { productIds, ...roundMeta };

  // Mint a fresh per-game UUID when transitioning out of the lobby. The
  // dedup keys for `mp_game_started` / `mp_game_completed` / daily MP
  // completion all scope on this id so a "Play Again" sequence in the
  // same room produces distinct event rows even though the room code
  // is identical. Between-rounds transitions reuse the existing id so
  // the MP_GAME_COMPLETED emit at the final round can dedup against any
  // accidental retry.
  const isLobbyToPlaying = room.status === "lobby";
  const newGameId = isLobbyToPlaying ? uuidv4() : null;

  // Atomic UPDATE that serves as both the authorization/status check and the
  // state transition. The WHERE clause enforces host identity, valid status,
  // and correct round number, preventing race conditions where two concurrent
  // startRound calls could both succeed. `COALESCE(?, current_game_id)`
  // assigns the new id only on the lobby→playing branch; between_rounds
  // passes NULL and keeps the existing id intact.
  const claimed = db.prepare(
    `UPDATE mp_rooms SET
       current_round = ?,
       status = 'playing',
       selected_products = ?,
       round_data = ?,
       current_game_id = COALESCE(?, current_game_id)
     WHERE code = ? AND host_player_id = ? AND status IN ('lobby', 'between_rounds') AND current_round = ?`
  ).run(
    newRound,
    JSON.stringify(productIds),
    JSON.stringify(existingRoundData),
    newGameId,
    roomCode,
    callerPlayerId,
    room.current_round
  );
  if (claimed.changes === 0) return null;

  // Emit one mp_game_started per real player exactly once per game — only on
  // the lobby→playing transition. Subsequent rounds land here too (the WHERE
  // clause permits 'between_rounds') but those represent round transitions,
  // not a new game starting. Bots and ghost users are filtered out so v2
  // counts match the per-real-player completion semantics in mpRoundEnd.
  if (isLobbyToPlaying && newGameId) {
    // Streamer-bot seats are filtered alongside server-side bots and ghosts
    // so the bot's join doesn't bump games_started in v2 analytics.
    const realPlayers = getActivePlayers(roomCode).filter(
      (p) => p.is_bot === 0 && !p.ghost_user_id && p.is_streamer_bot !== 1,
    );
    for (const player of realPlayers) {
      if (!player.visitor_id) continue;
      // Translate the per-player `mp_players.join_source` (set once at
      // room-entry time) into the unified `start_source` taxonomy. Players
      // with no join_source landed via a code path predating the column
      // (legacy rows) — record null rather than guessing.
      const joinSource = asJoinSource(player.join_source);
      const startSource = joinSource ? joinSourceToStartSource(joinSource) : null;
      recordEvent({
        eventName: ANALYTICS_EVENTS.MP_GAME_STARTED,
        eventType: "mp",
        visitorId: player.visitor_id,
        userId: player.user_id ?? null,
        gameMode: mode,
        mpRoomCode: roomCode,
        // Dedup key: scoped on (game_id, visitor_id, event_name) so a
        // double-fire of `startRound` for the same logical game produces
        // exactly one row per real player. The UNIQUE(visitor_id,
        // client_event_id) index on the events table absorbs the dup.
        clientEventId: `srv:mp_game_started:${newGameId}:${player.visitor_id}`,
        properties: {
          room_code: roomCode,
          game_mode: mode,
          game_id: newGameId,
          real_player_count: realPlayers.length,
          is_logged_in: !!player.user_id,
          is_daily_game: room.is_daily_game === 1,
          start_source: startSource,
        },
      });
    }
  }

  touchRoomActivity(roomCode);

  // Clear any previous timer
  clearRoundTimer(roomCode);
  setRoundEnded(roomCode, false);
  setRoundStartTime(roomCode, Date.now());

  // Build payload
  const payload = buildRoundStartPayload(roomCode, newRound, mode, productIds, roundMeta);

  if (mode === "bidding") {
    // Bidding mode: initialize turn-based state, no global round timer
    const activePlayers = getActivePlayers(roomCode);
    const playerEntries = activePlayers.map((p) => ({
      playerId: p.id,
      displayName: p.display_name,
      avatar: p.avatar,
    }));
    const biddingOrder = initBiddingRound(roomCode, playerEntries, productIds[0]);
    payload.biddingOrder = biddingOrder;
    // No round timer — per-turn timers are managed by the socket handler
  } else {
    // Standard simultaneous mode: start global round timer
    const timerMs = mode === "riser"
      ? (roundMeta.durationMs || 8000) + 3000
      : getTimerSeconds(mode) * 1000;

    const timer = setTimeout(() => {
      onTimerExpire(roomCode);
    }, timerMs);
    setRoundTimer(roomCode, timer);
  }

  return payload;
}

export function buildRoundStartPayload(
  roomCode: string,
  roundNumber: number,
  mode: GameMode,
  productIds: number[],
  roundMeta: Record<string, any>
): RoundStartPayload {
  const payload: RoundStartPayload = {
    roundNumber,
    gameMode: mode,
    timerSeconds: getTimerSeconds(mode),
  };

  if (mode === "comparison") {
    payload.products = getProductsForRound(productIds);
    payload.question = roundMeta.question;
  } else if (mode === "price-match") {
    // Shuffle prices so they don't match product order
    const productMap = getProductsByIds(productIds);
    payload.products = getProductsForRound(productIds, productMap);
    const prices = productIds
      .map((id) => productMap.get(id)?.price_cents)
      .filter((p): p is number => p !== undefined);
    for (let i = prices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [prices[i], prices[j]] = [prices[j], prices[i]];
    }
    payload.prices = prices;
  } else if (mode === "odd-one-out" || mode === "market-basket" || mode === "sort-it-out" || mode === "budget-builder" || mode === "chain-reaction") {
    payload.products = getProductsForRound(productIds);
    if (mode === "budget-builder") {
      payload.budgetCents = roundMeta.budgetCents;
    }
  } else if (mode === "riser") {
    const singleProducts = getProductsForRound([productIds[0]]);
    if (singleProducts.length > 0) {
      payload.product = singleProducts[0];
    }
    payload.maxPriceCents = roundMeta.maxPriceCents;
    payload.speedPattern = roundMeta.speedPattern;
    payload.durationMs = roundMeta.durationMs;
    payload.timerSeconds = Math.ceil((roundMeta.durationMs || 8000) / 1000) + 3;
  } else if (mode === "higher-lower") {
    const singleProducts = getProductsForRound([productIds[0]]);
    if (singleProducts.length > 0) {
      payload.product = singleProducts[0];
    }
    payload.referencePrice = roundMeta.referencePrice;
  } else if (mode === "bidding") {
    // Bidding: single product, biddingOrder is set by caller after initBiddingRound
    const singleProducts = getProductsForRound([productIds[0]]);
    if (singleProducts.length > 0) {
      payload.product = singleProducts[0];
    }
  } else {
    const singleProducts = getProductsForRound([productIds[0]]);
    if (singleProducts.length > 0) {
      payload.product = singleProducts[0];
    }
  }

  return payload;
}
