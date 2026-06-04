import { Router, Request, Response } from "express";
import type { GameMode } from "@price-game/shared";
import { VALID_GAME_MODES, MULTIPLAYER_ONLY_MODES, isValidRoundCount } from "@price-game/shared";
import { isGameModeEnabled } from "../services/siteSettings";

type Params = { sessionId: string };
import {
  startGame,
  getSession,
  getSessionProduct,
  submitGuess,
  getHint,
} from "../services/gameEngine";
import { safeErrorMessage } from "../services/errors";
import { optionalUser } from "../middleware/userAuth";
import { recordSinglePlayerGame } from "../services/userGameHistory";
import { recordVisitorGamePlay } from "../services/visitorAttribution";
import {
  classifySinglePlayerOutcome,
  applyVisitorWinUpdateEnsureRow,
} from "../services/winRecordWriter";
import { getUserWinRecord, getVisitorWinRecord } from "../services/winRecordRead";
import { recordEventFromRequest } from "../services/eventLog";
import { ANALYTICS_EVENTS, asStartSource, type IsWin } from "@price-game/shared";
import { getCategoriesWithCounts, getValidCategoryNames } from "../services/categoriesCache";
import db from "../db";

const router = Router();

// Attach optional user to all game routes
router.use(optionalUser);

// GET /api/game/categories — list selectable categories with product counts.
// Only returns categories that (a) have a non-empty, non-whitespace name and
// (b) contain at least MIN_CATEGORY_PRODUCTS active products.
// Backed by a 60s in-process cache (PR1 perf F4) — invalidated on admin
// product mutations.
router.get("/categories", (_req: Request, res: Response) => {
  try {
    const categories = getCategoriesWithCounts(db);
    res.json({ categories });
  } catch (err: unknown) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/game/start — start a new game
router.post("/start", (req: Request, res: Response) => {
  try {
    const { categories, mode, excludeProductIds, rounds, startSource } = req.body as {
      categories?: string[];
      mode?: string;
      excludeProductIds?: number[];
      rounds?: number;
      startSource?: string;
    };
    const gameMode = (mode || "classic") as GameMode;
    // Untrusted; narrow to the canonical bucket. Unknown / missing values
    // are stored as null so the dashboard can show an "unknown" tile rather
    // than fabricating a bucket. Only `homepage` and `game-browser` reach
    // here in practice — MP sources flow through the multiplayer paths.
    const validatedStartSource = asStartSource(startSource);
    // Validate rounds against the user-selectable allowlist (3, 5, 10).
    // Undefined is allowed and falls through to the server-side default.
    if (rounds !== undefined && !isValidRoundCount(rounds)) {
      res.status(400).json({ error: "Invalid rounds value" });
      return;
    }
    if (!VALID_GAME_MODES.has(gameMode)) {
      res.status(400).json({ error: "Invalid game mode" });
      return;
    }
    if (MULTIPLAYER_ONLY_MODES.has(gameMode)) {
      res.status(400).json({ error: "This game mode is multiplayer-only" });
      return;
    }
    if (!isGameModeEnabled(db, gameMode)) {
      res.status(400).json({ error: "This game mode is currently disabled" });
      return;
    }
    // S3 fix: validate categories against active DB categories (same as multiplayer does)
    if (categories !== undefined) {
      if (!Array.isArray(categories)) {
        res.status(400).json({ error: "Categories must be an array" });
        return;
      }
      if (categories.length > 50) {
        res.status(400).json({ error: "Too many categories" });
        return;
      }
      // Cached set (PR1 perf F4) — invalidated on admin product mutations.
      const validCategorySet = getValidCategoryNames(db);
      for (const c of categories) {
        if (typeof c !== "string" || !validCategorySet.has(c)) {
          res.status(400).json({ error: "Invalid category" });
          return;
        }
      }
    }
    // Validate excludeProductIds
    if (excludeProductIds !== undefined) {
      if (!Array.isArray(excludeProductIds)) {
        res.status(400).json({ error: "excludeProductIds must be an array" });
        return;
      }
      if (excludeProductIds.length > 200) {
        res.status(400).json({ error: "Too many excludeProductIds (max 200)" });
        return;
      }
      const MAX_PRODUCT_ID = 10_000_000;
      for (const id of excludeProductIds) {
        if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > MAX_PRODUCT_ID) {
          res.status(400).json({ error: "excludeProductIds must contain valid positive integers" });
          return;
        }
      }
    }
    const session = startGame(gameMode, categories, req.user?.id, excludeProductIds, rounds, req.visitorId);
    recordEventFromRequest(req, {
      eventName: ANALYTICS_EVENTS.GAME_STARTED,
      eventType: "game",
      gameMode,
      gameSessionId: session.id,
      // Dedup key: scoped on the freshly-minted session id so a retry of
      // POST /api/game/start won't double-count starts.
      clientEventId: `srv:game_started:${session.id}`,
      properties: {
        totalRounds: rounds,
        categories: categories ?? null,
        start_source: validatedStartSource,
      },
    });
    res.json(session);
  } catch (err: unknown) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GET /api/game/:sessionId — get session state
router.get("/:sessionId", (req: Request<Params>, res: Response) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

// GET /api/game/:sessionId/product — get current round product(s)
router.get("/:sessionId/product", (req: Request<Params>, res: Response) => {
  const product = getSessionProduct(req.params.sessionId);
  if (!product) {
    res.status(404).json({ error: "No product available for current round" });
    return;
  }
  res.json(product);
});

// POST /api/game/:sessionId/hint — get a price hint (classic & closest only)
router.post("/:sessionId/hint", (req: Request<Params>, res: Response) => {
  try {
    const hint = getHint(req.params.sessionId);
    if (!hint) {
      res.status(400).json({ error: "Hint not available" });
      return;
    }
    res.json(hint);
  } catch (err: unknown) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/game/:sessionId/guess — submit a guess (mode-aware)
router.post("/:sessionId/guess", (req: Request<Params>, res: Response) => {
  try {
    // PR3 sec L1: when a session was started by an authenticated user,
    // only that user can submit guesses against it. A logged-in
    // attacker who learned (or guessed) a leaked session id would
    // otherwise have that game's score credited to their own
    // `users.lifetime_score` (recordSinglePlayerGame below uses
    // req.user.id, not session.user_id). Server-computed scoring caps
    // the upside, but the principle of least-privilege still applies.
    if (req.user) {
      const ownerRow = db
        .prepare("SELECT user_id FROM game_sessions WHERE id = ?")
        .get(req.params.sessionId) as { user_id: string | null } | undefined;
      if (ownerRow?.user_id && ownerRow.user_id !== req.user.id) {
        res.status(403).json({ error: "Session belongs to another user" });
        return;
      }
    }

    const result = submitGuess(req.params.sessionId, req.body);
    if (!result) {
      res.status(404).json({ error: "Session not found or game already completed" });
      return;
    }
    // Daily challenge race-loser: another tab already committed today's
    // play for this user.
    if (result.error === "already_played") {
      res.status(409).json({ error: "already_played" });
      return;
    }

    // Auto-record game history for logged-in users when the game completes.
    // Streamer-bot is excluded — the bot runs as a guest so this branch is
    // already a no-op for it in practice, but the explicit guard documents
    // the invariant alongside the analytics gates below.
    let userOutcome: IsWin = null;
    if (result.session?.completed && req.user && !req.isStreamerBot) {
      try {
        userOutcome = recordSinglePlayerGame(
          db,
          req.user.id,
          req.params.sessionId,
          result.session.gameMode,
          result.session.totalScore,
        );
      } catch (historyErr) {
        // Non-critical: don't fail the guess response, but log for visibility
        console.error("Failed to record game history:", historyErr);
      }
    }

    // Anonymous attribution + W/L credit. Two paths, split on the
    // streamer-bot flag:
    //   - Real visitors run `recordVisitorGamePlay`, which bumps the
    //     UTM-cohort counters (`games_played`, `first_game_*`) AND the
    //     W/L cache + signed streak.
    //   - The streamer-bot still gets its W/L cache + streak bumped so
    //     the HUD chip on the bot's own UI can render real numbers, but
    //     stays out of UTM cohort accounting and the GAME_COMPLETED
    //     analytics emit (the latter is filtered by `recordEventFromRequest`
    //     downstream via `req.isStreamerBot`). Without this split the
    //     bot's W/L permanently shows zeros — the previous gate dropped
    //     the entire visitor branch for the bot.
    if (result.session?.completed && req.visitorId) {
      try {
        // Reuse the user-side classification when present (avoids a redundant
        // session-row read). For anonymous-only flows we classify directly.
        // `isBotPlayer: false` is intentional even for the streamer-bot —
        // we WANT to count its W/L; the bot guard in `computeIsWin` exists
        // for labeled auto-lobby bots that we don't track.
        const outcome =
          userOutcome ??
          classifySinglePlayerOutcome(
            db,
            req.params.sessionId,
            result.session.gameMode as GameMode,
            result.session.totalScore,
            false,
          );
        if (req.isStreamerBot) {
          applyVisitorWinUpdateEnsureRow(db, req.visitorId, outcome);
        } else {
          recordVisitorGamePlay(
            db,
            req.visitorId,
            "single",
            result.session.gameMode,
            outcome,
          );
        }
      } catch (visitorErr) {
        console.error("Failed to record visitor game play:", visitorErr);
      }
    }

    // Analytics event emission — per-round on every guess, completion on last round.
    // Dedup keys: GAME_COMPLETED scopes on session id (fires once per session);
    // GAME_ROUND_SUBMITTED scopes on (session id, round number) so distinct
    // rounds emit distinct rows but a retried guess collapses.
    recordEventFromRequest(req, {
      eventName: result.session?.completed
        ? ANALYTICS_EVENTS.GAME_COMPLETED
        : ANALYTICS_EVENTS.GAME_ROUND_SUBMITTED,
      eventType: "game",
      gameMode: result.session?.gameMode,
      gameSessionId: req.params.sessionId,
      clientEventId: result.session?.completed
        ? `srv:game_completed:${req.params.sessionId}`
        : `srv:game_round_submitted:${req.params.sessionId}:${result.session?.currentRound ?? "?"}`,
      properties: {
        roundNumber: result.session?.currentRound ?? null,
        totalScore: result.session?.totalScore ?? null,
      },
    });

    // Additional semantic marker for daily completions. The headline counter
    // is already bumped by GAME_COMPLETED above; DAILY_COMPLETED lets the
    // dashboard query "how many daily completions" without joining
    // game_sessions.is_daily. Fires alongside, not instead of.
    //
    // We can't gate on `result.daily` because gameGuess only populates that
    // payload for logged-in users (it carries streak data, which is user-only).
    // Anonymous daily completions still need to fire the event, so we read
    // is_daily from game_sessions on completion. Single SELECT, only on the
    // last guess of a session — negligible.
    if (result.session?.completed) {
      const dailyMeta = db
        .prepare("SELECT is_daily, daily_date FROM game_sessions WHERE id = ?")
        .get(req.params.sessionId) as { is_daily: number; daily_date: string | null } | undefined;
      if (dailyMeta?.is_daily === 1) {
        recordEventFromRequest(req, {
          eventName: ANALYTICS_EVENTS.DAILY_COMPLETED,
          eventType: "game",
          gameMode: result.session.gameMode,
          gameSessionId: req.params.sessionId,
          clientEventId: `srv:daily_completed:${req.params.sessionId}`,
          properties: {
            daily_date: dailyMeta.daily_date,
            score: result.session.totalScore ?? null,
            via: "single_player",
            streak: result.daily?.streak ?? null,
          },
        });
      }
    }

    // Attach the post-game W/L snapshot so the HUD chip can update
    // without a separate fetch. Only on completion — mid-round responses
    // would force a redundant DB read on every guess.
    let winRecord = undefined;
    if (result.session?.completed && !req.isStreamerBot) {
      try {
        if (req.user) {
          winRecord = getUserWinRecord(db, req.user.id);
        } else if (req.visitorId) {
          winRecord = getVisitorWinRecord(db, req.visitorId);
        }
      } catch (wrErr) {
        console.error("Failed to fetch win record:", wrErr);
      }
    }

    res.json(winRecord ? { ...result, winRecord } : result);
  } catch (err: unknown) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

export default router;
