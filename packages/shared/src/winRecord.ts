import type { GameMode } from "./types.js";
import { getPerRoundMaxScore } from "./shareGrid.js";

/**
 * Single-player win threshold: a final score is a win when it reaches at
 * least this fraction of the maximum possible score for the mode and round
 * count. 0.5 corresponds to the boundary between "Not bad!" and "Nice work!"
 * tiers in `getResultHeadline`.
 */
export const WIN_RATIO_THRESHOLD = 0.5;

/**
 * Outcome of a single completed game for the W/L tracker.
 *
 * - `true` — counts as a win; bumps `lifetime_wins` and the streak.
 * - `false` — counts as a loss; bumps `lifetime_losses` and the streak.
 * - `null` — does NOT count (disconnect, solo MP room, bot, excluded). The
 *   game still gets a history row for analytics/replay, but the cached
 *   counters and streak are left untouched.
 */
export type IsWin = true | false | null;

/**
 * Snapshot of a player's lifetime W/L state. Returned by the `/api/user/win-record`
 * endpoint and embedded in game-completion responses.
 */
export interface WinRecord {
  wins: number;
  losses: number;
  /** Signed integer. Positive = win streak, negative = loss streak, 0 = neutral. */
  currentStreak: number;
  /** Highest positive streak ever reached. Loss-direction peaks are not tracked. */
  bestStreak: number;
  totalGames: number;
}

export interface ComputeIsWinArgs {
  gameType: "single" | "multiplayer";
  gameMode: GameMode;
  /** Final total score across all rounds. */
  score: number;
  /** Number of rounds played; used to derive max score for single-player. */
  totalRounds: number;
  /** Final placement (1-based). MP-only; pass null for SP. */
  placement: number | null;
  /** Number of players in the MP room. <2 means a solo room (skipped). */
  playersCount: number | null;
  /** True for streamer-bot rows or any user flagged `is_bot=1`. */
  isBotPlayer: boolean;
}

/**
 * Decide whether a completed game counts as a win, a loss, or is skipped.
 *
 * Rules:
 *   - Bot players never count.
 *   - Multiplayer with no placement (disconnect / not yet ranked) does not count.
 *   - Multiplayer in a solo room (playersCount < 2) does not count — prevents
 *     trivial streak farming.
 *   - Multiplayer otherwise: placement === 1 wins; everything else is a loss.
 *     Ties at placement 1 produce a win for every tied player (matches existing
 *     `multiplayerWins` semantics).
 *   - Single-player: score / (perRoundMax × totalRounds) ≥ {@link WIN_RATIO_THRESHOLD}
 *     is a win. Anything below is a loss.
 *
 * @param args - The game-end details required to classify the outcome.
 * @returns `true` for a win, `false` for a loss, `null` to skip the streak.
 */
export function computeIsWin(args: ComputeIsWinArgs): IsWin {
  if (args.isBotPlayer) return null;
  if (args.gameType === "multiplayer") {
    if (!args.placement) return null;
    if ((args.playersCount ?? 0) < 2) return null;
    return args.placement === 1;
  }
  if (args.totalRounds <= 0) return null;
  const max = getPerRoundMaxScore(args.gameMode) * args.totalRounds;
  if (max <= 0) return null;
  return args.score / max >= WIN_RATIO_THRESHOLD;
}

/**
 * Apply a single game outcome to the previous streak. Win extends a positive
 * streak by +1 (or flips a negative streak to +1); loss extends a negative
 * streak by -1 (or flips a positive streak to -1). Null leaves the streak
 * unchanged.
 *
 * Pure function — no DB side effects. The server uses this same logic via a
 * SQL `CASE` chain, but it's exported for unit tests, the claim-merge path,
 * and any backfill scripts.
 *
 * @param previous - The signed streak before this game.
 * @param outcome - The classified outcome from {@link computeIsWin}.
 * @returns The new signed streak after applying the outcome.
 */
export function nextStreak(previous: number, outcome: IsWin): number {
  if (outcome === null) return previous;
  if (outcome === true) {
    return previous >= 0 ? previous + 1 : 1;
  }
  return previous <= 0 ? previous - 1 : -1;
}
