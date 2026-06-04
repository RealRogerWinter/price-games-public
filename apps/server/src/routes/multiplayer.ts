import { Router, Request, Response } from "express";
import { VALID_GAME_MODES, MAX_PLAYERS, isValidRoundCount, isValidDailyDate, getUtcDateString, type PublicLobbyEntry, type GameMode } from "@price-game/shared";
import { getRoom } from "../services/roomManager";
import { isDailyEnabled } from "../services/siteSettings";
import { optionalUser } from "../middleware/userAuth";
import db from "../db";

const router = Router();

type CodeParams = { code: string };

// GET /api/mp/room/:code — get room state (for initial page load before socket connects)
router.get("/room/:code", (req: Request<CodeParams>, res: Response) => {
  const room = getRoom(req.params.code);
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.json(room);
});

// GET /api/mp/leaderboard — multiplayer leaderboard
router.get("/leaderboard", (req: Request, res: Response) => {
  const mode = (typeof req.query.mode === "string" ? req.query.mode : undefined) as string | undefined;
  let rows;

  // Validate mode against known game modes to prevent querying with arbitrary values
  if (mode && mode !== "all" && !VALID_GAME_MODES.has(mode)) {
    res.json({ entries: [] });
    return;
  }

  if (mode && mode !== "all") {
    rows = db
      .prepare(
        `SELECT * FROM mp_leaderboard WHERE game_mode = ? ORDER BY score DESC LIMIT 20`
      )
      .all(mode);
  } else {
    rows = db
      .prepare("SELECT * FROM mp_leaderboard ORDER BY score DESC LIMIT 20")
      .all();
  }

  const entries = (rows as any[]).map((row, idx) => ({
    rank: idx + 1,
    playerName: row.player_name,
    score: row.score,
    placement: row.placement,
    playersCount: row.players_count,
    gameMode: row.game_mode,
    playedAt: row.played_at,
  }));

  res.json({ entries });
});

// GET /api/mp/lobbies — list public lobbies with available capacity
router.get("/lobbies", (req: Request, res: Response) => {
  const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
  if (mode && !VALID_GAME_MODES.has(mode)) {
    res.json({ lobbies: [] });
    return;
  }

  const baseQuery = `
    SELECT
      r.code,
      r.game_mode,
      r.total_rounds,
      r.password IS NOT NULL as has_password,
      r.bot_count,
      r.bot_difficulty,
      -- Resolve host identity by host_player_id (the source of truth) rather
      -- than is_host=1. Auto-lobbies seat their stand-in host with is_host=0
      -- so the existing "all humans ready" auto-start logic doesn't get
      -- confused by a fake host; the original (is_host=1) lookup would
      -- return null/Unknown for those rooms — a strong fake-activity tell.
      (SELECT display_name FROM mp_players WHERE id = r.host_player_id AND is_kicked = 0 LIMIT 1) as host_name,
      (SELECT avatar FROM mp_players WHERE id = r.host_player_id AND is_kicked = 0 LIMIT 1) as host_avatar,
      (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0) as player_count,
      -- "Human" here mirrors wirePayloadIsBot in services/autoLobby/identity.ts:
      -- a disguised bot (is_bot=1, is_disguised=1) is presented to clients as
      -- a human, so it must be counted under humanCount. Counting only
      -- is_bot=0 here would leak the disguise — a client subtracting
      -- humanCount and botCount from playerCount would back-derive that the
      -- remaining "humans" are actually bots.
      (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0 AND NOT (is_bot = 1 AND is_disguised = 0)) as human_count,
      (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0 AND is_bot = 0 AND connected = 1) as connected_human_count
    FROM mp_rooms r
    WHERE r.is_public = 1
      AND r.status = 'lobby'
      AND (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0) < ?
      -- Auto-lobbies are bot-only by construction and would always be filtered
      -- out by the "needs ≥1 connected human" rule below; relax the rule for
      -- them so they actually surface in the browser. Real (user-created)
      -- lobbies still require a connected human so zombie rooms stay hidden.
      AND (r.is_auto_lobby = 1
           OR (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0 AND is_bot = 0 AND connected = 1) > 0)
      ${mode ? "AND r.game_mode = ?" : ""}
    ORDER BY human_count DESC, r.created_at DESC
    LIMIT 50
  `;

  const params: any[] = [MAX_PLAYERS];
  if (mode) params.push(mode);

  const rows = db.prepare(baseQuery).all(...params) as any[];

  const lobbies: PublicLobbyEntry[] = rows.map((row) => ({
    code: row.code,
    hostName: row.host_name ?? "Unknown",
    hostAvatar: (row.host_avatar as import("@price-game/shared").Avatar | null) ?? null,
    gameMode: row.game_mode as GameMode,
    playerCount: row.player_count,
    humanCount: row.human_count,
    botCount: row.bot_count,
    maxPlayers: MAX_PLAYERS,
    totalRounds: row.total_rounds,
    hasPassword: !!row.has_password,
  }));

  res.json({ lobbies });
});

// POST /api/mp/quickplay — find a public lobby to join or signal to create one.
// When the caller passes `isDailyGame: true` + a `dailyDate`, matchmaking is
// scoped to daily rooms for the same date (so daily players only pair with
// daily players — products are preset, mixing would break parity). We also
// gate on daily_enabled and enforce once-per-day up front so the client
// can branch cleanly (create/join vs. 409).
router.post("/quickplay", optionalUser, (req: Request, res: Response) => {
  const { gameMode, totalRounds, isDailyGame, dailyDate } = (req.body ?? {}) as {
    gameMode?: string;
    totalRounds?: number;
    isDailyGame?: boolean;
    dailyDate?: string;
  };
  if (gameMode && !VALID_GAME_MODES.has(gameMode)) {
    res.status(400).json({ error: "Invalid game mode" });
    return;
  }

  // Validate totalRounds against the canonical shared allowlist. Anything
  // outside ROUND_COUNT_OPTIONS (3/5/10) is treated as "no preference".
  const roundsFilter = isValidRoundCount(totalRounds) ? totalRounds : null;

  const dailyRequested = isDailyGame === true;
  let dailyDateFilter: string | null = null;
  if (dailyRequested) {
    if (!isDailyEnabled(db)) {
      res.status(404).json({ error: "daily_disabled" });
      return;
    }
    if (typeof dailyDate !== "string" || !isValidDailyDate(dailyDate)) {
      res.status(400).json({ error: "invalid_daily_date" });
      return;
    }
    // Only today's UTC date is matchmakable — accepting past dates lets a
    // client pre-consume their once-per-day slot on an old entry, and
    // accepting future dates pre-creates a `daily_puzzles` row that
    // conflicts with the legitimate generation on that date.
    if (dailyDate !== getUtcDateString(new Date())) {
      res.status(400).json({ error: "invalid_daily_date" });
      return;
    }
    dailyDateFilter = dailyDate;

    // Once-per-day guard. Mirrors /api/daily/start's OR-axis logic — a 409
    // here short-circuits the client before it wastes a createRoom call
    // that the socket-level guard would also reject.
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
        .get(dailyDateFilter, userId, userId, visitorId, visitorId);
      if (played) {
        res.status(409).json({ error: "already_played", date: dailyDateFilter });
        return;
      }
    }
  }

  // Prefer rooms that match both the game mode AND the requested round
  // count. If nothing matches, the caller's Quick Play flow falls back to
  // creating a new room with bots. Daily rooms match only same-date daily
  // rooms; non-daily matchmaking explicitly excludes daily rooms.
  const query = `
    SELECT r.code
    FROM mp_rooms r
    WHERE r.is_public = 1
      AND r.status = 'lobby'
      AND (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0) < ?
      AND (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0 AND is_bot = 0 AND connected = 1) > 0
      ${gameMode ? "AND r.game_mode = ?" : ""}
      ${roundsFilter !== null ? "AND r.total_rounds = ?" : ""}
      ${dailyRequested ? "AND r.is_daily_game = 1 AND r.daily_date = ?" : "AND r.is_daily_game = 0"}
    ORDER BY
      (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code AND is_kicked = 0 AND is_bot = 0 AND connected = 1) DESC,
      r.created_at ASC
    LIMIT 1
  `;

  const params: any[] = [MAX_PLAYERS];
  if (gameMode) params.push(gameMode);
  if (roundsFilter !== null) params.push(roundsFilter);
  if (dailyRequested && dailyDateFilter) params.push(dailyDateFilter);

  const row = db.prepare(query).get(...params) as { code: string } | undefined;

  if (row) {
    res.json({ action: "join", roomCode: row.code });
  } else {
    res.json({ action: "create" });
  }
});

export default router;
