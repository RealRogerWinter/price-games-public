/**
 * Public daily challenge routes.
 *
 * - GET  /api/daily/today    — current puzzle metadata + per-user state
 * - POST /api/daily/start    — create a new daily session for the current UTC date
 * - GET  /api/daily/history  — last 30 daily plays for the authenticated user
 *
 * All routes are gated by the `daily_enabled` site setting (default OFF).
 * The actual once-per-day enforcement and streak update happen inside
 * `submitGuess` (services/gameGuess.ts), not here.
 */

import { Router, Request, Response } from "express";
import db from "../db";
import {
  DAILY_TOTAL_ROUNDS,
  getGameModeName,
  getPerRoundMaxScore,
  getUtcDateString,
  type DailyHistoryResponse,
  type DailyPlay,
  type DailyRecapResponse,
  type DailyTodayResponse,
  type GameMode,
  type SharedRoundSnapshot,
} from "@price-game/shared";
import { isDailyEnabled } from "../services/siteSettings";
import { DailyUnavailableError, getOrCreateDailyPuzzle } from "../services/dailyPuzzle";
import { getStreakForUser } from "../services/dailyStreak";
import { startDailyGame } from "../services/gameSession";
import { getProductsWithPriceForRound } from "../services/productMapper";
import { optionalUser, requireUser } from "../middleware/userAuth";
import { safeErrorMessage } from "../services/errors";
import { recordEventFromRequest } from "../services/eventLog";
import { ANALYTICS_EVENTS } from "@price-game/shared";

const router = Router();

router.use(optionalUser);

// =============================================================================
// GET /api/daily/today
// =============================================================================
router.get("/today", (req: Request, res: Response) => {
  if (!isDailyEnabled(db)) {
    res.status(404).json({ error: "daily_disabled" });
    return;
  }

  const date = getUtcDateString(new Date());

  let puzzle;
  try {
    puzzle = getOrCreateDailyPuzzle(db, date);
  } catch (err) {
    if (err instanceof DailyUnavailableError) {
      res.status(404).json({ error: "no_available_mode" });
      return;
    }
    res.status(500).json({ error: safeErrorMessage(err) });
    return;
  }

  const response: DailyTodayResponse = {
    date,
    gameMode: puzzle.game_mode,
    modeName: getGameModeName(puzzle.game_mode),
    totalRounds: DAILY_TOTAL_ROUNDS,
  };

  // Mirror the OR-axis filter used by /start and the notification scheduler:
  // `alreadyPlayed` is true if *either* the logged-in user OR this browser
  // (visitor_id) has a daily_plays row for today. Without this, a user whose
  // device played as a guest would see the Play button on /today, click it,
  // and get a 409 from /start — the exact inconsistency the device-aware
  // fix is supposed to prevent end-to-end.
  const userId = req.user?.id ?? null;
  const visitorId = req.visitorId ?? null;
  if (userId || visitorId) {
    const played = db
      .prepare(
        `SELECT 1 FROM daily_plays
          WHERE daily_date = ?
            AND (
              (? IS NOT NULL AND user_id = ?)
              OR (? IS NOT NULL AND visitor_id = ?)
            )
          LIMIT 1`,
      )
      .get(date, userId, userId, visitorId, visitorId);
    if (req.user) {
      response.alreadyPlayed = !!played;
      response.streak = getStreakForUser(db, req.user.id);
    } else if (played) {
      // Anonymous visitor whose device already played today. Surface
      // alreadyPlayed so the client doesn't show "Play" only to 409.
      // Streak stays omitted (anonymous streaks live in localStorage).
      response.alreadyPlayed = true;
    }
  }

  res.json(response);
});

// =============================================================================
// POST /api/daily/start
// =============================================================================
router.post("/start", (req: Request, res: Response) => {
  if (!isDailyEnabled(db)) {
    res.status(404).json({ error: "daily_disabled" });
    return;
  }

  const date = getUtcDateString(new Date());

  // UX-only pre-check: short-circuit with 409 if either the user OR the
  // device already has a daily_plays row for today. The partial unique
  // indexes in submitGuess are still the actual enforcement point. The
  // visitor axis catches guest double-plays AND the case where a logged-in
  // user's device previously played as a guest (the reported bug's mirror).
  const userId = req.user?.id ?? null;
  const visitorId = req.visitorId ?? null;
  if (userId || visitorId) {
    const played = db
      .prepare(
        `SELECT 1 FROM daily_plays
          WHERE daily_date = ?
            AND (
              (? IS NOT NULL AND user_id = ?)
              OR (? IS NOT NULL AND visitor_id = ?)
            )
          LIMIT 1`,
      )
      .get(date, userId, userId, visitorId, visitorId);
    if (played) {
      res.status(409).json({ error: "already_played", date });
      return;
    }
  }

  try {
    const session = startDailyGame(date, req.user?.id, req.visitorId);
    recordEventFromRequest(req, {
      eventName: ANALYTICS_EVENTS.DAILY_STARTED,
      eventType: "game",
      gameMode: session.gameMode,
      gameSessionId: session.id,
      // Dedup key: scoped on the freshly-minted session id. A retried
      // POST /api/daily/start won't double-emit.
      clientEventId: `srv:daily_started:${session.id}`,
      properties: { date },
    });
    res.json(session);
  } catch (err) {
    if (err instanceof DailyUnavailableError) {
      res.status(404).json({ error: "no_available_mode" });
      return;
    }
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// =============================================================================
// GET /api/daily/history
// =============================================================================

interface DbDailyPlayRow {
  daily_date: string;
  game_mode: string;
  score: number;
  per_round_scores: string | null;
  completed_at: string;
  streak_at_completion: number | null;
}

router.get("/history", requireUser, (req: Request, res: Response) => {
  const rawLimit = parseInt(req.query.limit as string, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 90)) : 30;

  const rows = db
    .prepare(
      `SELECT daily_date, game_mode, score, per_round_scores, completed_at, streak_at_completion
       FROM daily_plays
       WHERE user_id = ? AND completed_at IS NOT NULL
       ORDER BY daily_date DESC
       LIMIT ?`
    )
    .all(req.user!.id, limit) as DbDailyPlayRow[];

  const plays: DailyPlay[] = rows.map((row) => ({
    date: row.daily_date,
    gameMode: row.game_mode as DailyPlay["gameMode"],
    score: row.score,
    completedAt: row.completed_at,
    streakAtCompletion: row.streak_at_completion ?? 0,
    perRoundScores: row.per_round_scores ? (JSON.parse(row.per_round_scores) as number[]) : [],
  }));

  const response: DailyHistoryResponse = { plays };
  res.json(response);
});

// =============================================================================
// GET /api/daily/recap/:date
// =============================================================================
//
// Returns a rich recap for a daily that the player has already completed.
// Accepts either a logged-in user (via session cookie) or an anonymous
// visitor (via visitor_id cookie) — the same OR-axis pattern used by
// /today and /start. Joins per-round scores (from `daily_plays`) with the
// deterministic, shared-across-users product lineup from `daily_puzzles` so
// the client can render a share card with real titles, thumbnails, and
// Amazon affiliate links — the exact same products the player saw during
// the round.
//
// 401 if neither user nor visitor cookie is present, 400 on malformed date,
// 404 if the player has not completed that date or the puzzle row no longer
// exists (e.g., pruned).
//
// Note: after claimAnonymousDailyPlays, claimed rows retain their original
// visitor_id. This means a subsequent user on the same browser could match
// the row by visitor_id. The data exposed is only game scores and the
// shared public product lineup (no PII), consistent with the existing
// device-tracking model.
// =============================================================================

interface DbDailyPuzzleRow {
  game_mode: string;
  round_data: string | null;
}

router.get("/recap/:date", (req: Request, res: Response) => {
  const userId = req.user?.id ?? null;
  const visitorId = req.visitorId ?? null;

  // Must have at least one identifier to look up the play.
  if (!userId && !visitorId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const rawDate = req.params.date;
  const date = typeof rawDate === "string" ? rawDate : "";
  // Validate strictly before touching the DB to avoid opaque SQL parameter
  // coercion and to produce a clean 400 for clearly-bogus client calls.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "invalid_date" });
    return;
  }

  // Must have completed the daily for that date — otherwise nothing to
  // recap. Uses the same OR-axis pattern as /today and /start: match
  // either the logged-in user or the device's visitor_id. This allows
  // anonymous users who completed a daily to view their recap.
  const playRow = db
    .prepare(
      `SELECT score, per_round_scores
       FROM daily_plays
       WHERE daily_date = ?
         AND completed_at IS NOT NULL
         AND (
           (? IS NOT NULL AND user_id = ?)
           OR (? IS NOT NULL AND visitor_id = ?)
         )`
    )
    .get(date, userId, userId, visitorId, visitorId) as { score: number; per_round_scores: string | null } | undefined;

  if (!playRow) {
    res.status(404).json({ error: "not_completed" });
    return;
  }

  const puzzleRow = db
    .prepare("SELECT game_mode, round_data FROM daily_puzzles WHERE daily_date = ?")
    .get(date) as DbDailyPuzzleRow | undefined;

  if (!puzzleRow || !puzzleRow.round_data) {
    // Puzzle row was cleaned up (admin prune) or never existed. Fall back
    // to a graceful 404 rather than a 500 — the client can show the
    // scores-only recap.
    res.status(404).json({ error: "puzzle_missing" });
    return;
  }

  const gameMode = puzzleRow.game_mode as GameMode;

  // Both per_round_scores and round_data come straight from the DB.
  // They *should* be valid JSON (inserted by server code), but a manual
  // admin edit or a partial write could leave a corrupt row. Wrap both
  // parses in try/catch so the client gets a clean 404 ("corrupt_puzzle")
  // rather than an uncaught exception turning into a bare 500.
  let perRoundScores: number[] = [];
  let roundData: Record<string, { productIds?: number[] }> = {};
  try {
    if (playRow.per_round_scores) {
      perRoundScores = JSON.parse(playRow.per_round_scores) as number[];
    }
    // round_data is a map keyed by round number ("1", "2", ..., "5") with
    // a `productIds: number[]` entry per round. Walk it in order and
    // build the SharedRoundSnapshot array the client expects.
    roundData = JSON.parse(puzzleRow.round_data) as Record<
      string,
      { productIds?: number[] }
    >;
  } catch {
    res.status(404).json({ error: "corrupt_puzzle" });
    return;
  }

  const rounds: SharedRoundSnapshot[] = [];
  for (let i = 1; i <= DAILY_TOTAL_ROUNDS; i++) {
    const entry = roundData[String(i)];
    const productIds = entry?.productIds ?? [];
    const products = getProductsWithPriceForRound(productIds).map((p) => ({
      title: p.title,
      imageUrl: p.imageUrl,
      priceCents: p.priceCents,
      ...(p.amazonUrl ? { amazonUrl: p.amazonUrl } : {}),
    }));
    rounds.push({
      roundNumber: i,
      score: perRoundScores[i - 1] ?? 0,
      products,
    });
  }

  const response: DailyRecapResponse = {
    date,
    gameMode,
    modeName: getGameModeName(gameMode),
    totalScore: playRow.score,
    perRoundMax: getPerRoundMaxScore(gameMode),
    perRoundScores,
    rounds,
  };
  res.json(response);
});

export default router;
