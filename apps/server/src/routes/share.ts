import { Router, Request, Response } from "express";
import type {
  GameMode,
  SharedRoundSnapshot,
  SharedGameRecord,
  CreateShareResponse,
} from "@price-game/shared";
import { VALID_GAME_MODES, getPerRoundMaxScore } from "@price-game/shared";
import { sanitizeName } from "../services/inputSanitizer";
import { safeErrorMessage, UserFacingError } from "../services/errors";
import { optionalUser } from "../middleware/userAuth";
import { createShareRow } from "../services/historyRecap";
import db from "../db";

const router = Router();

// Populate req.user when a session cookie is present so the POST handler
// can link new shares to the authenticated user's game-history entry.
router.use(optionalUser);

// =============================================================================
// Shareable game view — POST creates a decorative snapshot of a completed
// game (no trust surface; not tied to leaderboards or gameplay). GET resolves
// a share id back to the stored snapshot so the /s/:id client page can render
// a read-only view of what the player actually saw.
// =============================================================================

/** Max total score we'll accept on a share. Real games cap around 13,130; 100k gives plenty of headroom. */
const MAX_TOTAL_SCORE = 100_000;
/** Lower/upper bounds on how many rounds a share can contain. */
const MIN_ROUND_COUNT = 1;
const MAX_ROUND_COUNT = 20;
/** Max products surfaced in a single round (market-basket has 6; budget-builder has 6; chain-reaction has 5). */
const MAX_PRODUCTS_PER_ROUND = 10;
/** Max serialized roundData size. Stricter than the global express.json limit. */
const MAX_ROUND_DATA_BYTES = 16 * 1024;
const SHARE_ID_REGEX = /^[A-Za-z0-9_-]{8}$/;

/** Row shape returned by the SELECT query. Separate from SharedGameRecord because of snake_case columns. */
interface SharedGameRow {
  id: string;
  game_mode: string;
  total_score: number;
  per_round_max: number;
  player_name: string | null;
  round_data: string;
  created_at: number;
}

/**
 * Validate a single SharedRoundSnapshot object structurally. Does not trust
 * mode-specific fields — those are stored as-is — but enforces the required
 * minimum shape the SharePage renderer depends on.
 *
 * @throws Error with a user-facing message if the snapshot is malformed
 */
function validateRoundSnapshot(snap: unknown, index: number): SharedRoundSnapshot {
  if (!snap || typeof snap !== "object") {
    throw new UserFacingError(`roundData[${index}] must be an object`);
  }
  const s = snap as Record<string, unknown>;
  if (typeof s.score !== "number" || !Number.isFinite(s.score) || s.score < 0) {
    throw new UserFacingError(`roundData[${index}].score must be a non-negative number`);
  }
  if (typeof s.roundNumber !== "number" || !Number.isFinite(s.roundNumber)) {
    throw new UserFacingError(`roundData[${index}].roundNumber must be a number`);
  }
  if (!Array.isArray(s.products)) {
    throw new UserFacingError(`roundData[${index}].products must be an array`);
  }
  if (s.products.length === 0 || s.products.length > MAX_PRODUCTS_PER_ROUND) {
    throw new UserFacingError(
      `roundData[${index}].products must contain 1..${MAX_PRODUCTS_PER_ROUND} items`
    );
  }
  for (let pi = 0; pi < s.products.length; pi++) {
    const p = s.products[pi] as Record<string, unknown> | null;
    if (!p || typeof p !== "object") {
      throw new UserFacingError(`roundData[${index}].products[${pi}] must be an object`);
    }
    if (typeof p.title !== "string" || typeof p.imageUrl !== "string") {
      throw new UserFacingError(`roundData[${index}].products[${pi}] must have string title + imageUrl`);
    }
    if (typeof p.priceCents !== "number" || !Number.isFinite(p.priceCents)) {
      throw new UserFacingError(`roundData[${index}].products[${pi}].priceCents must be a number`);
    }
  }
  return s as unknown as SharedRoundSnapshot;
}

/**
 * POST /api/share — create a new shared game record. Client-supplied payload
 * is validated and sanitized; server computes authoritative `perRoundMax`
 * from `gameMode` (ignoring any client-supplied value).
 */
router.post("/", (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const { gameMode, totalScore, playerName, roundData } = body;

    // --- gameMode ---
    if (typeof gameMode !== "string" || !VALID_GAME_MODES.has(gameMode)) {
      res.status(400).json({ error: "Invalid gameMode" });
      return;
    }

    // --- totalScore ---
    if (
      typeof totalScore !== "number" ||
      !Number.isFinite(totalScore) ||
      totalScore < 0 ||
      totalScore > MAX_TOTAL_SCORE
    ) {
      res.status(400).json({ error: `totalScore must be a number between 0 and ${MAX_TOTAL_SCORE}` });
      return;
    }

    // --- roundData ---
    if (!Array.isArray(roundData)) {
      res.status(400).json({ error: "roundData must be an array" });
      return;
    }
    if (roundData.length < MIN_ROUND_COUNT || roundData.length > MAX_ROUND_COUNT) {
      res.status(400).json({
        error: `roundData must contain ${MIN_ROUND_COUNT}..${MAX_ROUND_COUNT} entries`,
      });
      return;
    }
    const validatedRounds: SharedRoundSnapshot[] = [];
    for (let i = 0; i < roundData.length; i++) {
      try {
        validatedRounds.push(validateRoundSnapshot(roundData[i], i));
      } catch (err: unknown) {
        res.status(400).json({ error: safeErrorMessage(err) });
        return;
      }
    }

    // --- payload size cap (stricter than express.json's 100kb) ---
    const serialized = JSON.stringify(validatedRounds);
    if (serialized.length > MAX_ROUND_DATA_BYTES) {
      res.status(400).json({
        error: `roundData serialized size exceeds ${MAX_ROUND_DATA_BYTES} bytes`,
      });
      return;
    }

    // --- playerName (optional, sanitized) ---
    let sanitizedName: string | null = null;
    if (playerName !== undefined && playerName !== null && playerName !== "") {
      if (typeof playerName !== "string") {
        res.status(400).json({ error: "playerName must be a string" });
        return;
      }
      try {
        sanitizedName = sanitizeName(playerName, 30);
      } catch (err: unknown) {
        res.status(400).json({ error: safeErrorMessage(err) });
        return;
      }
    }

    // --- Insert with collision retry (shared with the auto-share path in
    //     recordSinglePlayerGame / recordMultiplayerGame via createShareRow). ---
    const id = createShareRow(
      db,
      gameMode as GameMode,
      totalScore,
      getPerRoundMaxScore(gameMode as GameMode),
      sanitizedName,
      validatedRounds,
    );

    // If authenticated and a linking identifier was provided, associate the
    // share with the user's game-history entry so the scoreboard can link to it.
    const userId = req.user?.id ?? null;
    if (userId) {
      const { sessionId, roomCode } = body;
      if (typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 64) {
        db.prepare(
          "UPDATE user_game_history SET share_id = ? WHERE user_id = ? AND session_id = ?"
        ).run(id, userId, sessionId);
      } else if (typeof roomCode === "string" && roomCode.length > 0 && roomCode.length <= 16) {
        // A user can play multiple games in the same room via "Play Again",
        // so scope the UPDATE to only the most recent history entry.
        db.prepare(
          `UPDATE user_game_history SET share_id = ?
           WHERE id = (
             SELECT id FROM user_game_history
             WHERE user_id = ? AND room_code = ?
             ORDER BY played_at DESC LIMIT 1
           )`
        ).run(id, userId, roomCode);
      }
    }

    const response: CreateShareResponse = { id, url: `/s/${id}` };
    res.status(201).json(response);
  } catch (err: unknown) {
    console.error("POST /api/share error:", err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

/**
 * GET /api/share/:id — fetch a previously-created share record. Returns 400
 * for malformed ids (to avoid wildcard DB scans) and 404 for missing ones.
 */
router.get("/:id", (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = req.params.id;
    if (typeof id !== "string" || !SHARE_ID_REGEX.test(id)) {
      res.status(400).json({ error: "Invalid share id" });
      return;
    }

    const row = db
      .prepare(
        `SELECT id, game_mode, total_score, per_round_max, player_name, round_data, created_at
         FROM shared_games WHERE id = ?`
      )
      .get(id) as SharedGameRow | undefined;

    if (!row) {
      res.status(404).json({ error: "Share not found" });
      return;
    }

    let parsedRoundData: SharedRoundSnapshot[];
    try {
      parsedRoundData = JSON.parse(row.round_data) as SharedRoundSnapshot[];
    } catch {
      // Corrupted row — log and return 500 rather than leak a parse error.
      console.error(`Corrupted round_data for share ${id}`);
      res.status(500).json({ error: "Failed to read share" });
      return;
    }

    const record: SharedGameRecord = {
      id: row.id,
      gameMode: row.game_mode as GameMode,
      totalScore: row.total_score,
      perRoundMax: row.per_round_max,
      playerName: row.player_name,
      roundData: parsedRoundData,
      createdAt: row.created_at,
    };
    res.json(record);
  } catch (err: unknown) {
    console.error("GET /api/share/:id error:", err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

export default router;
