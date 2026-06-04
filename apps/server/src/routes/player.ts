/**
 * Public player profile routes.
 *
 * All endpoints are public (no auth required) and return data by username.
 * Mounted at /api/player.
 */

import { Router, Request, Response } from "express";
import db from "../db";
import {
  getPublicPlayerProfile,
  getPublicScoreHistory,
  getPublicGameHistory,
} from "../services/publicProfile";
import { parseTimeZoneQuery } from "@price-game/shared";

type UsernameParams = { username: string };

const router = Router();

// Usernames are 3-20 chars; reject anything outside that range early.
const MAX_USERNAME_LENGTH = 20;

/**
 * GET /api/player/:username — Public player profile.
 *
 * Returns stats, games-by-mode, and member-since date.
 * 404 if user not found or inactive.
 */
router.get("/:username", (req: Request<UsernameParams>, res: Response) => {
  if (req.params.username.length > MAX_USERNAME_LENGTH) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const profile = getPublicPlayerProfile(db, req.params.username);

  if (!profile) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  res.json({ profile });
});

/**
 * GET /api/player/:username/score-history — Daily score aggregates.
 *
 * Query params:
 *   days — Number of days to look back (default 30, max 365).
 */
router.get("/:username/score-history", (req: Request<UsernameParams>, res: Response) => {
  if (req.params.username.length > MAX_USERNAME_LENGTH) {
    res.json({ history: [] });
    return;
  }
  const days = Math.min(
    Math.max(parseInt(req.query.days as string, 10) || 30, 1),
    365,
  );
  const timeZone = parseTimeZoneQuery(req.query.tz);
  const history = getPublicScoreHistory(db, req.params.username, days, timeZone);
  res.json({ history });
});

/**
 * GET /api/player/:username/history — Paginated game history (date-only).
 *
 * Query params:
 *   limit — Max entries per page (default 20, max 100).
 *   offset — Number of entries to skip (default 0).
 */
router.get("/:username/history", (req: Request<UsernameParams>, res: Response) => {
  if (req.params.username.length > MAX_USERNAME_LENGTH) {
    res.json({ entries: [], total: 0 });
    return;
  }
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string, 10) || 20, 1),
    100,
  );
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  const timeZone = parseTimeZoneQuery(req.query.tz);
  const result = getPublicGameHistory(db, req.params.username, limit, offset, timeZone);
  res.json(result);
});

export default router;
