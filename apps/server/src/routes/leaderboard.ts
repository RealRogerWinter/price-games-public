import { Router, Request, Response } from "express";
import db from "../db";
import {
  LeaderboardGameType,
  LeaderboardPeriod,
  parseTimeZoneQuery,
} from "@price-game/shared";
import {
  getLeaderboardAvailability,
  getLeaderboardCount,
  getLifetimeLeaderboard,
  getLongestStreakLeaderboard,
  getPeriodLeaderboard,
  getUserRank,
  getRankHistory,
} from "../services/publicProfile";
import { optionalUser } from "../middleware/userAuth";

const router = Router();

const VALID_PERIODS: ReadonlySet<LeaderboardPeriod> = new Set([
  "day",
  "week",
  "month",
  "all",
]);

const VALID_GAME_TYPES: ReadonlySet<LeaderboardGameType> = new Set([
  "all",
  "sp",
  "mp",
]);

/**
 * Parse the `period` query param. Unknown/missing values fall back to "all"
 * rather than 400-ing — this matches the tolerant-query convention used by
 * the other leaderboard handlers (bad `limit` falls back, bad `mode` returns
 * empty rather than erroring).
 */
function parseLeaderboardPeriod(raw: unknown): LeaderboardPeriod {
  if (typeof raw === "string" && VALID_PERIODS.has(raw as LeaderboardPeriod)) {
    return raw as LeaderboardPeriod;
  }
  return "all";
}

/**
 * Parse the `gameType` query param. Unknown/missing values fall back to
 * "all" — same tolerant-query convention as `parseLeaderboardPeriod`.
 */
function parseLeaderboardGameType(raw: unknown): LeaderboardGameType {
  if (typeof raw === "string" && VALID_GAME_TYPES.has(raw as LeaderboardGameType)) {
    return raw as LeaderboardGameType;
  }
  return "all";
}

/**
 * GET /api/leaderboard/v2 — Score leaderboard.
 *
 * Query params:
 *   period — "day" | "week" | "month" | "all" (default "all"). Rolling
 *            windows for bounded periods; "all" uses the pre-aggregated
 *            `users.lifetime_score` column when `gameType="all"` (and
 *            returns `LifetimeLeaderboardEntry` rows with `lifetimeScore`).
 *            Bounded periods sum `user_game_history.score` in-window and
 *            return `PeriodLeaderboardEntry` rows with `score`.
 *   gameType — "all" | "sp" | "mp" (default "all"). "sp" / "mp" filter
 *              `user_game_history` rows by `game_type` ('single' /
 *              'multiplayer'); "all" preserves the canonical combined view.
 *   limit — Max entries (default 50, max 100).
 *   offset — Pagination offset (default 0).
 *
 * Response includes `total` — the unpaginated row count for the current
 * period + gameType filter, so the client can render "Page N of M".
 */
router.get("/v2", (req: Request, res: Response) => {
  const period = parseLeaderboardPeriod(req.query.period);
  const gameType = parseLeaderboardGameType(req.query.gameType);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string, 10) || 50, 1),
    100,
  );
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  const now = Date.now();
  const leaderboard =
    period === "all"
      ? getLifetimeLeaderboard(db, limit, offset, gameType)
      : getPeriodLeaderboard(db, period, limit, offset, now, gameType);
  const total = getLeaderboardCount(db, period, gameType, now);
  res.json({ leaderboard, period, gameType, total });
});

/**
 * GET /api/leaderboard/v2/availability — Count of players with score > 0
 * per period. Used by the leaderboard page to hide empty-period pills.
 */
router.get("/v2/availability", (_req: Request, res: Response) => {
  res.json(getLeaderboardAvailability(db));
});

/**
 * GET /api/leaderboard/streaks — Top players by longest daily-challenge streak.
 *
 * Query params:
 *   limit — Max entries (default 20, max 100).
 */
router.get("/streaks", (req: Request, res: Response) => {
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
    100,
  );
  const leaderboard = getLongestStreakLeaderboard(db, limit);
  res.json({ leaderboard });
});

/**
 * GET /api/leaderboard/rank — Current user's rank.
 *
 * Requires authentication (user must be on req.user).
 * Returns 401 if not authenticated.
 */
router.get("/rank", optionalUser, (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const result = getUserRank(db, req.user.id);
  if (!result) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(result);
});

/**
 * GET /api/leaderboard/rank/history — Authenticated user's rank over time.
 *
 * Query params:
 *   days — Number of days to look back (default 30, max 365).
 */
router.get("/rank/history", optionalUser, (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const days = Math.min(
    Math.max(parseInt(req.query.days as string, 10) || 30, 1),
    365,
  );

  const timeZone = parseTimeZoneQuery(req.query.tz);
  const history = getRankHistory(db, req.user.id, days, timeZone);
  res.json({ history });
});

export default router;
