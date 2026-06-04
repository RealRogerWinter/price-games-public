/**
 * User game history service.
 *
 * Records single-player and multiplayer game results linked to user accounts.
 * Provides paginated history retrieval and aggregate stats.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  tzDateString,
  ADMIN_TIMEZONE,
  padDateSeries,
  getPerRoundMaxScore,
  computeIsWin,
  type IsWin,
} from "@price-game/shared";
import type { GameHistoryEntry, UserStats, UserScoreHistoryDay, GameMode } from "@price-game/shared";
import { buildSPRecap, buildMPRecap, createShareRow } from "./historyRecap";
import { applyUserWinUpdate } from "./winRecordWriter";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Clamp a `days` window to a sane range [1, 365]. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.floor(days), 1), 365);
}

/**
 * Options for filtering and paginating game history queries.
 */
export interface HistoryQueryOptions {
  limit?: number;
  offset?: number;
  gameType?: "single" | "multiplayer";
  gameMode?: string;
}

/**
 * Record a completed single-player game for a user.
 *
 * Inserts a row into user_game_history, increments the user's lifetime_score,
 * records a rank snapshot for the rank-over-time chart, and proactively builds
 * a `shared_games` snapshot + stamps `share_id` on the new row so the row is
 * immediately clickable on the scoreboard and player-profile panels.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param sessionId - The game session id.
 * @param gameMode - The game mode (e.g. "classic", "higher-lower").
 * @param score - The final score.
 * @param playedAt - Optional ISO timestamp for the history row's `played_at`.
 *   Defaults to the current time. Pass the session's original `completed_at`
 *   when recording a historical round (e.g. an anonymous round claimed on
 *   signup) so the history feed and rank-over-time chart reflect when the
 *   round was actually played. The rank snapshot always uses `now` regardless,
 *   since rank is computed from the *current* lifetime_score.
 */
export function recordSinglePlayerGame(
  db: DatabaseType,
  userId: string,
  sessionId: string,
  gameMode: string,
  score: number,
  playedAt?: string,
): IsWin {
  const played = playedAt ?? new Date().toISOString();
  const snapshotAt = new Date().toISOString();
  let outcome: IsWin = null;

  db.transaction(() => {
    // Read the session's total_rounds + the user's bot flag in the same
    // transaction so the W/L classification matches the row we're about
    // to write. `total_rounds` is the immutable round-count stamped on
    // session creation by `gameEngine.startGame` and never updated
    // afterwards, so reading it here gives the same value the player
    // actually played against. `is_bot` short-circuits W/L for any
    // future bot user accounts (the streamer-bot doesn't currently
    // auth, so this is defense in depth).
    const sessionRow = db
      .prepare("SELECT total_rounds FROM game_sessions WHERE id = ?")
      .get(sessionId) as { total_rounds: number | null } | undefined;
    const userRow = db
      .prepare("SELECT is_bot FROM users WHERE id = ?")
      .get(userId) as { is_bot: number } | undefined;
    outcome = computeIsWin({
      gameType: "single",
      gameMode: gameMode as GameMode,
      score,
      totalRounds: sessionRow?.total_rounds ?? 0,
      placement: null,
      playersCount: null,
      isBotPlayer: (userRow?.is_bot ?? 0) === 1,
    });
    const isWinCol = outcome === null ? null : outcome ? 1 : 0;

    // INSERT OR IGNORE prevents duplicate recording on request retries
    const result = db.prepare(
      `INSERT OR IGNORE INTO user_game_history (user_id, game_type, game_mode, session_id, score, played_at, is_win)
       VALUES (?, 'single', ?, ?, ?, ?, ?)`,
    ).run(userId, gameMode, sessionId, score, played, isWinCol);

    // Only increment lifetime_score if the row was actually inserted.
    // total_games is incremented in lock-step (PR1 perf F2): the cached
    // column drives the lifetime-leaderboard query without needing a
    // LEFT JOIN onto user_game_history.
    if (result.changes > 0) {
      db.prepare(
        "UPDATE users SET lifetime_score = lifetime_score + ?, total_games = total_games + 1 WHERE id = ?",
      ).run(score, userId);

      // W/L cache + signed streak. No-ops when outcome is null.
      applyUserWinUpdate(db, userId, outcome);

      recordRankSnapshot(db, userId, snapshotAt);

      // Proactively build + persist a shared_games snapshot for this game so
      // its History row is immediately clickable and opens a round-by-round
      // recap. Wrapped in try/catch: a builder failure must not break history
      // recording — the on-demand endpoint will retry on first click.
      try {
        stampShareForHistoryRow(db, userId, gameMode as GameMode, score, {
          kind: "sp",
          sessionId,
        });
      } catch (err) {
        // Non-critical: proceed without share_id stamping. Log so we can
        // spot systematic failures instead of discovering them via missing
        // recaps months later.
        console.error(
          `[recordSinglePlayerGame] share-id stamp failed for session ${sessionId}:`,
          err,
        );
      }
    }
  })();
  return outcome;
}

/**
 * Record a completed multiplayer game for a user.
 *
 * Inserts a row into user_game_history with placement data, increments the
 * user's lifetime_score, and proactively builds a `shared_games` snapshot of
 * this player's view of the game + stamps `share_id` so the row is clickable
 * on the scoreboard and player-profile panels.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param roomCode - The multiplayer room code.
 * @param gameMode - The game mode.
 * @param score - The final score.
 * @param placement - The player's ranking (1-based).
 * @param playersCount - Total number of players in the game.
 */
export function recordMultiplayerGame(
  db: DatabaseType,
  userId: string,
  roomCode: string,
  gameMode: string,
  score: number,
  placement: number,
  playersCount: number,
  /** Total round count for the room. Used to satisfy the shared computeIsWin
   *  signature, but MP win-vs-loss is purely placement-based so the value
   *  has no effect on classification — it's safe to default to 0. */
  totalRounds: number,
  /** True for streamer-bot or otherwise-flagged bot rows; suppresses W/L. */
  isBotPlayer: boolean,
  /** When a buff was applied to `score`, pass the pre-buff score here for analytics. */
  buffMeta?: { wasBuffed: boolean; rawScore: number },
): IsWin {
  const now = new Date().toISOString();
  const wasBuffed = buffMeta?.wasBuffed ? 1 : 0;
  const rawScore = buffMeta?.rawScore ?? null;
  let outcome: IsWin = null;

  db.transaction(() => {
    outcome = computeIsWin({
      gameType: "multiplayer",
      gameMode: gameMode as GameMode,
      score,
      totalRounds,
      placement,
      playersCount,
      isBotPlayer,
    });
    const isWinCol = outcome === null ? null : outcome ? 1 : 0;

    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, room_code, score, placement, players_count, played_at, was_buffed, raw_score, is_win)
       VALUES (?, 'multiplayer', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, gameMode, roomCode, score, placement, playersCount, now, wasBuffed, rawScore, isWinCol);

    // total_games bumps with lifetime_score so the cached column stays
    // in lock-step with the leaderboard query's row count (PR1 perf F2).
    db.prepare(
      "UPDATE users SET lifetime_score = lifetime_score + ?, total_games = total_games + 1 WHERE id = ?",
    ).run(score, userId);

    // W/L cache + signed streak. No-ops when outcome is null.
    applyUserWinUpdate(db, userId, outcome);

    recordRankSnapshot(db, userId, now);

    // Same proactive-share behavior as SP — see comment in recordSinglePlayerGame.
    try {
      stampShareForHistoryRow(db, userId, gameMode as GameMode, score, {
        kind: "mp",
        roomCode,
      });
    } catch (err) {
      // Non-critical: the lazy `/api/user/history/:id/recap` path will
      // synthesize on first click now that finished-room DB rows are
      // preserved. We still log so systematic failures surface.
      console.error(
        `[recordMultiplayerGame] share-id stamp failed for room ${roomCode} user ${userId}:`,
        err,
      );
    }
  })();
  return outcome;
}

/**
 * Build a share snapshot for a just-recorded history row and link it via
 * `share_id`. Called from both SP and MP record paths inside their existing
 * transactions. Silently no-ops when the builder returns an empty array
 * (e.g. the underlying session was trimmed before the record call could
 * read it) — the recap endpoint will fill in lazily on first click.
 *
 * @internal — not exported; consumed only by the record functions above.
 */
function stampShareForHistoryRow(
  db: DatabaseType,
  userId: string,
  gameMode: GameMode,
  score: number,
  source: { kind: "sp"; sessionId: string } | { kind: "mp"; roomCode: string },
): void {
  const roundData =
    source.kind === "sp"
      ? buildSPRecap(db, source.sessionId)
      : buildMPRecap(db, source.roomCode, userId);
  if (roundData.length === 0) return;

  const userRow = db
    .prepare("SELECT username FROM users WHERE id = ?")
    .get(userId) as { username: string } | undefined;

  const shareId = createShareRow(
    db,
    gameMode,
    score,
    getPerRoundMaxScore(gameMode),
    userRow?.username ?? null,
    roundData,
  );

  if (source.kind === "sp") {
    db.prepare(
      "UPDATE user_game_history SET share_id = ? WHERE user_id = ? AND session_id = ? AND share_id IS NULL",
    ).run(shareId, userId, source.sessionId);
  } else {
    // Scope to the most-recent row for this room so Play-Again doesn't clobber
    // an older game's share_id. Mirrors POST /api/share's roomCode update.
    db.prepare(
      `UPDATE user_game_history SET share_id = ?
       WHERE id = (
         SELECT id FROM user_game_history
         WHERE user_id = ? AND room_code = ? AND share_id IS NULL
         ORDER BY played_at DESC LIMIT 1
       )`,
    ).run(shareId, userId, source.roomCode);
  }
}

/**
 * Get paginated game history for a user.
 *
 * Returns entries sorted by played_at descending (most recent first).
 * Supports optional filtering by game type.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param options - Pagination and filter options.
 * @returns Array of GameHistoryEntry objects.
 */
export function getUserGameHistory(
  db: DatabaseType,
  userId: string,
  options?: HistoryQueryOptions,
): GameHistoryEntry[] {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  const gameType = options?.gameType;
  const gameMode = options?.gameMode;

  let sql = "SELECT * FROM user_game_history WHERE user_id = ?";
  const params: unknown[] = [userId];

  if (gameType) {
    sql += " AND game_type = ?";
    params.push(gameType);
  }
  if (gameMode) {
    sql += " AND game_mode = ?";
    params.push(gameMode);
  }

  sql += " ORDER BY played_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as number,
    gameType: row.game_type as "single" | "multiplayer",
    gameMode: row.game_mode as string,
    score: row.score as number,
    placement: (row.placement as number) ?? null,
    playersCount: (row.players_count as number) ?? null,
    playedAt: row.played_at as string,
    shareId: (row.share_id as string) ?? null,
  }));
}

/**
 * Get aggregate statistics for a user's game history.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @returns Aggregate stats including totals, best, average, by-mode, and MP wins.
 */
export function getUserStats(
  db: DatabaseType,
  userId: string,
): UserStats {
  // Total games, total score, best score, avg score
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) as total_games,
         COALESCE(SUM(score), 0) as total_score,
         COALESCE(MAX(score), 0) as best_score,
         COALESCE(AVG(score), 0) as avg_score
       FROM user_game_history WHERE user_id = ?`,
    )
    .get(userId) as Record<string, number>;

  // Games by mode
  const modeRows = db
    .prepare(
      "SELECT game_mode, COUNT(*) as count FROM user_game_history WHERE user_id = ? GROUP BY game_mode",
    )
    .all(userId) as { game_mode: string; count: number }[];

  const gamesByMode: Record<string, number> = {};
  for (const row of modeRows) {
    gamesByMode[row.game_mode] = row.count;
  }

  // Multiplayer wins (placement = 1)
  const winsRow = db
    .prepare(
      "SELECT COUNT(*) as wins FROM user_game_history WHERE user_id = ? AND game_type = 'multiplayer' AND placement = 1",
    )
    .get(userId) as { wins: number };

  return {
    totalGames: agg.total_games,
    totalScore: agg.total_score,
    bestScore: agg.best_score,
    averageScore: Math.round(agg.avg_score),
    gamesByMode,
    multiplayerWins: winsRow.wins,
  };
}

/**
 * Compute and record the user's current leaderboard rank after a game.
 *
 * Inserts a row into user_rank_history and updates users.best_rank if the
 * new rank is the best achieved so far. Must be called inside a transaction
 * that has already updated lifetime_score.
 *
 * @param db - Database instance (called within an active transaction).
 * @param userId - The user's id.
 * @param recordedAt - ISO timestamp for the snapshot.
 */
function recordRankSnapshot(
  db: DatabaseType,
  userId: string,
  recordedAt: string,
): void {
  const user = db
    .prepare("SELECT lifetime_score, best_rank FROM users WHERE id = ?")
    .get(userId) as { lifetime_score: number; best_rank: number | null } | undefined;
  if (!user) return;

  const rankRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1 AND lifetime_score > ?")
    .get(user.lifetime_score) as { cnt: number };
  const totalRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1")
    .get() as { cnt: number };

  const rank = rankRow.cnt + 1;
  const totalPlayers = totalRow.cnt;

  db.prepare(
    "INSERT INTO user_rank_history (user_id, rank, total_players, recorded_at) VALUES (?, ?, ?, ?)",
  ).run(userId, rank, totalPlayers, recordedAt);

  // Update best_rank if this rank is better (lower) or first time
  if (user.best_rank === null || rank < user.best_rank) {
    db.prepare("UPDATE users SET best_rank = ? WHERE id = ?").run(rank, userId);
  }

  // Trim rank history older than 365 days to bound table growth
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  db.prepare(
    "DELETE FROM user_rank_history WHERE user_id = ? AND recorded_at < ?",
  ).run(userId, cutoff.toISOString());
}

/**
 * Get daily score aggregates for a user's score history chart.
 *
 * Groups scores by date for the specified number of past days.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param days - Number of days to look back (default 30).
 * @returns Array of daily score aggregates sorted by date ascending.
 */
export function getUserScoreHistory(
  db: DatabaseType,
  userId: string,
  days: number = 30,
  timeZone: string = ADMIN_TIMEZONE,
): UserScoreHistoryDay[] {
  const safeDays = clampDays(days);
  const end = new Date();
  // Generous SQL filter buffer — padDateSeries trims to exactly
  // `safeDays` entries via calendar-day arithmetic below, so DST
  // transitions cannot shift the row count.
  const sinceIso = new Date(end.getTime() - (safeDays + 2) * MS_PER_DAY).toISOString();

  const rows = db
    .prepare(
      `SELECT played_at, score
       FROM user_game_history
       WHERE user_id = ? AND played_at >= ?
       ORDER BY played_at ASC`,
    )
    .all(userId, sinceIso) as { played_at: string; score: number }[];

  const byDate = new Map<string, { totalScore: number; gamesPlayed: number }>();
  for (const row of rows) {
    const bucket = tzDateString(row.played_at, timeZone);
    if (!bucket) continue;
    const existing = byDate.get(bucket);
    if (existing) {
      existing.totalScore += row.score;
      existing.gamesPlayed += 1;
    } else {
      byDate.set(bucket, { totalScore: row.score, gamesPlayed: 1 });
    }
  }

  const sparse: UserScoreHistoryDay[] = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, totalScore: v.totalScore, gamesPlayed: v.gamesPlayed }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return padDateSeries(
    sparse,
    end,
    safeDays,
    timeZone,
    (date) => ({ date, totalScore: 0, gamesPlayed: 0 }),
  );
}
