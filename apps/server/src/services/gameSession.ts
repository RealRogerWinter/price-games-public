/**
 * Game session lifecycle — creating, persisting, and retrieving single-player sessions.
 */
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import {
  GameMode,
  GameSession,
  DAILY_TOTAL_ROUNDS,
  DEFAULT_TOTAL_ROUNDS,
  isValidRoundCount,
  type RoundCountOption,
} from "@price-game/shared";
import { composeRounds, recordUserProductViews } from "./roundComposer";
import { getOrCreateDailyPuzzle } from "./dailyPuzzle";
import { isDailyEnabled } from "./siteSettings";

export interface DbSession {
  id: string;
  current_round: number;
  total_score: number;
  selected_products: string;
  started_at: string;
  completed_at: string | null;
  game_mode: string | null;
  round_data: string | null;
  user_id?: string | null;
  is_daily?: number;
  daily_date?: string | null;
  total_rounds: number | null;
  visitor_id?: string | null;
}

/**
 * Resolve a session row's persisted total_rounds, falling back to the default
 * for legacy rows that pre-date migration 33 (NULL column). Daily sessions
 * always use DAILY_TOTAL_ROUNDS regardless of what's stored.
 */
export function getSessionTotalRounds(row: { total_rounds: number | null; is_daily?: number }): number {
  if (row.is_daily === 1) return DAILY_TOTAL_ROUNDS;
  return row.total_rounds ?? DEFAULT_TOTAL_ROUNDS;
}

export function toGameSession(row: DbSession): GameSession {
  const isDaily = row.is_daily === 1;
  return {
    id: row.id,
    currentRound: row.current_round,
    totalRounds: getSessionTotalRounds(row),
    totalScore: row.total_score,
    completed: row.completed_at !== null,
    gameMode: (row.game_mode || "classic") as GameMode,
  };
}

/**
 * Start a new single-player game session.
 *
 * @param mode - Game mode.
 * @param categories - Optional category filter.
 * @param userId - Optional user ID for per-user product memory.
 * @param excludeProductIds - Optional product IDs to exclude.
 * @param totalRounds - Optional number of rounds (must be one of ROUND_COUNT_OPTIONS).
 *                      Defaults to DEFAULT_TOTAL_ROUNDS. Invalid values fall back to the default.
 * @param visitorId - Optional persistent browser cookie identifier; persisted
 *                    on the session row so downstream writes (e.g. daily_plays)
 *                    can correlate plays to a device even for guest sessions.
 * @returns The created game session.
 */
export function startGame(
  mode: GameMode = "classic",
  categories?: string[],
  userId?: string,
  excludeProductIds?: number[],
  totalRounds?: number,
  visitorId?: string | null,
): GameSession {
  const sessionId = uuidv4();
  const now = new Date().toISOString();

  // Defensive: validate against the allowlist even though the route already
  // validates — services may be invoked from other call sites (tests, jobs).
  const rounds: RoundCountOption = isValidRoundCount(totalRounds)
    ? totalRounds
    : DEFAULT_TOTAL_ROUNDS;

  const { productIds, roundData } = composeRounds({
    mode,
    totalRounds: rounds,
    categories,
    userId,
    excludeProductIds,
  });

  db.prepare(
    `INSERT INTO game_sessions (id, current_round, total_score, selected_products, started_at, game_mode, round_data, user_id, total_rounds, visitor_id)
     VALUES (?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    JSON.stringify(productIds),
    now,
    mode,
    roundData ? JSON.stringify(roundData) : null,
    userId || null,
    rounds,
    visitorId ?? null,
  );

  // Record product views for per-user memory
  if (userId) {
    recordUserProductViews(userId, productIds, sessionId);
  }

  return {
    id: sessionId,
    currentRound: 1,
    totalRounds: rounds,
    totalScore: 0,
    completed: false,
    gameMode: mode,
  };
}

export function getSession(sessionId: string): GameSession | null {
  const row = db
    .prepare("SELECT * FROM game_sessions WHERE id = ?")
    .get(sessionId) as DbSession | undefined;

  if (!row) return null;
  return toGameSession(row);
}

/**
 * Start a new daily challenge session for the given UTC date. Reuses the
 * cached daily puzzle so every player on the same date plays the same
 * 5 products in the same order.
 *
 * Note that this function does NOT write to `daily_plays` — that happens
 * on the FIRST guess submission. The user is free to open the intro
 * screen and back out without burning their attempt for the day.
 *
 * @param date - YYYY-MM-DD UTC date
 * @param userId - Optional user ID
 * @param visitorId - Optional persistent browser cookie identifier; persisted
 *                    on the session row and copied onto daily_plays at first
 *                    guess, so the notification scheduler can tell whether
 *                    *this device* already played today even for guest plays.
 * @returns The created game session
 * @throws Error when daily challenge mode is disabled in site_settings
 * @throws DailyUnavailableError when no pool mode is currently enabled
 */
export function startDailyGame(
  date: string,
  userId?: string,
  visitorId?: string | null,
): GameSession {
  if (!isDailyEnabled(db)) {
    throw new Error("daily challenge mode is disabled");
  }

  const puzzle = getOrCreateDailyPuzzle(db, date);
  const sessionId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO game_sessions
       (id, current_round, total_score, selected_products, started_at, game_mode, round_data, user_id, is_daily, daily_date, visitor_id)
     VALUES (?, 1, 0, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    sessionId,
    puzzle.product_ids,
    now,
    puzzle.game_mode,
    puzzle.round_data,
    userId || null,
    date,
    visitorId ?? null,
  );

  return {
    id: sessionId,
    currentRound: 1,
    totalRounds: DAILY_TOTAL_ROUNDS,
    totalScore: 0,
    completed: false,
    gameMode: puzzle.game_mode as GameMode,
  };
}
