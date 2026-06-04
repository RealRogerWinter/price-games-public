/**
 * Public profile service for the leaderboard v2.
 *
 * Provides functions for querying the lifetime leaderboard, user ranks,
 * and public player profiles. All data is read-only and requires no auth.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  tzDateString,
  ADMIN_TIMEZONE,
  padDateSeries,
  addDays,
  getUtcDateString,
} from "@price-game/shared";
import {
  ghostsVisibleOnLeaderboard,
  getGhostLifetimeEntries,
  getGhostStreakEntries,
  countGhostScorers,
} from "./ghostUsers/leaderboard";
import type {
  LeaderboardAvailability,
  LeaderboardGameType,
  LeaderboardPeriod,
  LifetimeLeaderboardEntry,
  LongestStreakLeaderboardEntry,
  PeriodLeaderboardEntry,
  PublicPlayerProfile,
  PublicGameHistoryEntry,
  UserScoreHistoryDay,
  UserRankResponse,
  UserRankHistoryDay,
} from "@price-game/shared";

/**
 * Map a public-facing `LeaderboardGameType` to the internal
 * `user_game_history.game_type` value. Returns null for "all", signalling
 * "no game-type predicate" to callers (i.e. include both kinds).
 */
function gameTypePredicate(
  gameType: LeaderboardGameType,
): "single" | "multiplayer" | null {
  if (gameType === "sp") return "single";
  if (gameType === "mp") return "multiplayer";
  return null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Clamp a `days` window to a sane range [1, 365]. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.floor(days), 1), 365);
}

/**
 * Get the lifetime leaderboard ranked by lifetime_score.
 *
 * For `gameType="all"` this returns the canonical lifetime board: it ranks by
 * the pre-aggregated `users.lifetime_score`, which is the running sum of every
 * recorded game (both single-player and multiplayer). The column is kept
 * moderation-aware by `excludeEntry`/`restoreEntry` in the admin service —
 * excluding a `user_game_history` row decrements the user's `lifetime_score`
 * by the row's score so the visible board, rank queries, and stored column
 * stay in sync. For "sp"/"mp" we sum `user_game_history.score` filtered by
 * `game_type` AND `excluded_at IS NULL` (no per-mode pre-aggregated column
 * exists, so the slice queries do their own moderation filtering).
 *
 * @param db - Database instance.
 * @param limit - Max entries to return (default 50, capped at 100).
 * @param offset - Number of entries to skip for pagination (default 0).
 * @param gameType - Filter by game kind (default "all").
 * @returns Array of leaderboard entries with rank, username, score, and game count.
 */
export function getLifetimeLeaderboard(
  db: DatabaseType,
  limit: number = 50,
  offset: number = 0,
  gameType: LeaderboardGameType = "all",
): LifetimeLeaderboardEntry[] {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);
  const typePred = gameTypePredicate(gameType);

  if (typePred === null) {
    // Exclude players with zero lifetime score from the leaderboard — a
    // zero-point player has no standing on the board and creates visual
    // noise at the bottom of the list once the registered-user count grows.
    //
    // When ghosts are toggled visible, UNION ALL with ghost_users so the
    // long tail of the leaderboard is populated by synthetic players
    // (the percentile cap inside creditGhostScore keeps ghost scores in
    // the bottom 30%, so the podium stays real-user). The two SELECTs
    // share the same wire shape; the outer ORDER BY paginates across
    // both tables.
    // PR1 perf F2: read totalGames from the cached u.total_games column
    // instead of LEFT JOINing user_game_history + GROUP BY u.id. The
    // column is maintained at write-time inside the same transactions
    // that bump lifetime_score (recordSinglePlayerGame /
    // recordMultiplayerGame / excludeEntry / restoreEntry), so it
    // tracks the join-count-with-`excluded_at IS NULL` exactly. Without
    // the join the query walks idx_users_leaderboard (lifetime_score
    // DESC, username ASC partial) and stops at LIMIT — no temp B-tree.
    const includeGhosts = ghostsVisibleOnLeaderboard(db);
    const sql = includeGhosts
      ? `SELECT username, lifetimeScore, avatar, totalGames FROM (
           SELECT u.username AS username, u.lifetime_score AS lifetimeScore,
                  u.avatar AS avatar, u.total_games AS totalGames
             FROM users u
            WHERE u.is_active = 1 AND u.lifetime_score > 0
              AND u.leaderboard_banned_at IS NULL
              AND u.is_test_account = 0
           UNION ALL
           SELECT g.username AS username, g.lifetime_score AS lifetimeScore,
                  g.avatar AS avatar, COUNT(gh.id) AS totalGames
             FROM ghost_users g
             LEFT JOIN ghost_game_history gh ON gh.ghost_user_id = g.id
            WHERE g.is_active = 1 AND g.lifetime_score > 0
            GROUP BY g.id
         )
         ORDER BY lifetimeScore DESC, username ASC
         LIMIT ? OFFSET ?`
      : `SELECT u.username, u.lifetime_score AS lifetimeScore, u.avatar, u.total_games AS totalGames
           FROM users u
          WHERE u.is_active = 1 AND u.lifetime_score > 0
            AND u.leaderboard_banned_at IS NULL
            AND u.is_test_account = 0
          ORDER BY u.lifetime_score DESC, u.username ASC
          LIMIT ? OFFSET ?`;

    const rows = db
      .prepare(sql)
      .all(safeLimit, safeOffset) as {
        username: string;
        lifetimeScore: number;
        totalGames: number;
        avatar: string | null;
      }[];

    return rows.map((row, i) => ({
      rank: safeOffset + i + 1,
      username: row.username,
      lifetimeScore: row.lifetimeScore,
      totalGames: row.totalGames,
      avatar: (row.avatar as import("@price-game/shared").Avatar | null) ?? null,
    }));
  }

  // SP/MP slice: sum from user_game_history filtered by game_type.
  // When ghosts are toggled visible, UNION ALL with ghost_users
  // aggregated over ghost_game_history (same shape: game_type column)
  // so the SP/MP boards include ghost activity in the matching slice.
  const includeGhostsSlice = ghostsVisibleOnLeaderboard(db);
  const sliceSql = includeGhostsSlice
    ? `SELECT username, avatar, lifetimeScore, totalGames FROM (
         SELECT u.username AS username, u.avatar AS avatar,
                COALESCE(SUM(ugh.score), 0) AS lifetimeScore,
                COUNT(ugh.id) AS totalGames
           FROM users u
           JOIN user_game_history ugh
             ON ugh.user_id = u.id
            AND ugh.game_type = ?
            AND ugh.excluded_at IS NULL
          WHERE u.is_active = 1
            AND u.leaderboard_banned_at IS NULL
            AND u.is_test_account = 0
          GROUP BY u.id
          HAVING lifetimeScore > 0
         UNION ALL
         SELECT g.username AS username, g.avatar AS avatar,
                COALESCE(SUM(gh.score), 0) AS lifetimeScore,
                COUNT(gh.id) AS totalGames
           FROM ghost_users g
           JOIN ghost_game_history gh
             ON gh.ghost_user_id = g.id AND gh.game_type = ?
          WHERE g.is_active = 1
          GROUP BY g.id
          HAVING lifetimeScore > 0
       )
       ORDER BY lifetimeScore DESC, username ASC
       LIMIT ? OFFSET ?`
    : `SELECT u.username, u.avatar,
              COALESCE(SUM(ugh.score), 0) AS lifetimeScore,
              COUNT(ugh.id) AS totalGames
         FROM users u
         JOIN user_game_history ugh
           ON ugh.user_id = u.id
          AND ugh.game_type = ?
          AND ugh.excluded_at IS NULL
        WHERE u.is_active = 1
          AND u.leaderboard_banned_at IS NULL
          AND u.is_test_account = 0
        GROUP BY u.id
        HAVING lifetimeScore > 0
        ORDER BY lifetimeScore DESC, u.username ASC
        LIMIT ? OFFSET ?`;

  const sliceParams: (string | number)[] = includeGhostsSlice
    ? [typePred, typePred, safeLimit, safeOffset]
    : [typePred, safeLimit, safeOffset];
  const rows = db
    .prepare(sliceSql)
    .all(...sliceParams) as {
      username: string;
      lifetimeScore: number;
      totalGames: number;
      avatar: string | null;
    }[];

  return rows.map((row, i) => ({
    rank: safeOffset + i + 1,
    username: row.username,
    lifetimeScore: row.lifetimeScore,
    totalGames: row.totalGames,
    avatar: (row.avatar as import("@price-game/shared").Avatar | null) ?? null,
  }));
}

/**
 * Build the UTC cutoff ISO timestamp for a bounded-window leaderboard period.
 *
 * Rolling windows — day = last 24h, week = last 7d, month = last 30d —
 * measured from the current wall-clock moment. Returns null for "all",
 * signalling "no cutoff" to callers.
 *
 * @param period - The window to compute a cutoff for.
 * @param now - Optional reference "now" (ms since epoch) for deterministic tests.
 * @returns ISO-8601 UTC cutoff timestamp, or null for "all".
 */
export function getLeaderboardPeriodCutoff(
  period: LeaderboardPeriod,
  now: number = Date.now(),
): string | null {
  if (period === "all") return null;
  const ms =
    period === "day"
      ? 24 * 60 * 60 * 1000
      : period === "week"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return new Date(now - ms).toISOString();
}

/**
 * Get the score leaderboard for a bounded time window.
 *
 * Sums `user_game_history.score` for games played within the period's
 * rolling window, joins with `users` for display fields, and ranks by
 * in-period score descending. Users who played nothing in the window
 * drop off the board entirely (HAVING score > 0) — the whole point of
 * this view is to surface *current* activity, so a dormant account
 * with a huge lifetime score should not appear on the day board.
 *
 * @param db - Database instance.
 * @param period - Time window ("day" | "week" | "month"). For "all",
 *   callers should route to `getLifetimeLeaderboard` instead; this
 *   function still handles it (cutoff=null ⇒ no cutoff predicate) but
 *   returns the sum of `user_game_history`, which differs subtly from
 *   `users.lifetime_score` if rows were ever deleted.
 * @param limit - Max entries (default 50, capped at 100).
 * @param offset - Pagination offset.
 * @param now - Optional reference "now" for deterministic tests.
 * @param gameType - Filter by game kind (default "all"). "sp" / "mp"
 *   restrict the join to `user_game_history` rows where `game_type` is
 *   `'single'` / `'multiplayer'` respectively. The filter composes with
 *   the period cutoff: a player must have at least one in-window row of
 *   the requested kind to appear.
 * @returns Ranked entries with in-period score and games played.
 */
export function getPeriodLeaderboard(
  db: DatabaseType,
  period: LeaderboardPeriod,
  limit: number = 50,
  offset: number = 0,
  now: number = Date.now(),
  gameType: LeaderboardGameType = "all",
): PeriodLeaderboardEntry[] {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);
  const cutoff = getLeaderboardPeriodCutoff(period, now);
  const typePred = gameTypePredicate(gameType);

  // Build the join predicate dynamically. The cutoff and the game-type
  // filter are both applied in the JOIN ON clause so users without any
  // matching rows drop out via the inner join (HAVING score > 0 is the
  // belt-and-braces check). `excluded_at IS NULL` is always applied so
  // admin-moderated rows drop out of every period view.
  const userJoin: string[] = ["ugh.user_id = u.id", "ugh.excluded_at IS NULL"];
  const ghostJoin: string[] = ["gh.ghost_user_id = g.id"];
  const cutoffParams: string[] = [];
  const typeParams: string[] = [];
  if (cutoff !== null) {
    userJoin.push("ugh.played_at >= ?");
    ghostJoin.push("gh.played_at >= ?");
    cutoffParams.push(cutoff);
  }
  if (typePred !== null) {
    userJoin.push("ugh.game_type = ?");
    ghostJoin.push("gh.game_type = ?");
    typeParams.push(typePred);
  }

  // When ghosts are toggled visible, UNION ALL with ghost_users + the
  // parallel ghost_game_history table. Same column shape, same time +
  // type filters in the inner JOIN; outer ORDER BY paginates across
  // both. Ghost activity rows naturally satisfy `played_at >= cutoff`
  // for whatever rounds they finished in the window.
  const includeGhostsPeriod = ghostsVisibleOnLeaderboard(db);
  const userBranch = `SELECT u.username AS username, u.avatar AS avatar,
                             COALESCE(SUM(ugh.score), 0) AS score,
                             COUNT(ugh.id) AS totalGames
                        FROM users u
                        JOIN user_game_history ugh ON ${userJoin.join(" AND ")}
                       WHERE u.is_active = 1
                         AND u.leaderboard_banned_at IS NULL
                         AND u.is_test_account = 0
                       GROUP BY u.id
                       HAVING score > 0`;
  const ghostBranch = `SELECT g.username AS username, g.avatar AS avatar,
                              COALESCE(SUM(gh.score), 0) AS score,
                              COUNT(gh.id) AS totalGames
                         FROM ghost_users g
                         JOIN ghost_game_history gh ON ${ghostJoin.join(" AND ")}
                        WHERE g.is_active = 1
                        GROUP BY g.id
                        HAVING score > 0`;

  const sql = includeGhostsPeriod
    ? `SELECT username, avatar, score, totalGames FROM (
         ${userBranch}
         UNION ALL
         ${ghostBranch}
       )
       ORDER BY score DESC, username ASC
       LIMIT ? OFFSET ?`
    : `${userBranch}
       ORDER BY score DESC, u.username ASC
       LIMIT ? OFFSET ?`;

  const params: (string | number)[] = includeGhostsPeriod
    ? [...cutoffParams, ...typeParams, ...cutoffParams, ...typeParams, safeLimit, safeOffset]
    : [...cutoffParams, ...typeParams, safeLimit, safeOffset];

  const rows = db.prepare(sql).all(...params) as {
    username: string;
    avatar: string | null;
    score: number;
    totalGames: number;
  }[];

  return rows.map((row, i) => ({
    rank: safeOffset + i + 1,
    username: row.username,
    avatar: (row.avatar as import("@price-game/shared").Avatar | null) ?? null,
    score: row.score,
    totalGames: row.totalGames,
  }));
}

/**
 * Count total leaderboard rows for the given period + gameType filter.
 *
 * Drives numbered pagination on the leaderboard page — the client needs
 * a row count to render "Page N of M" controls. Mirrors the visibility
 * filters and ghost-merge logic of `getLifetimeLeaderboard` /
 * `getPeriodLeaderboard` exactly so `total / pageSize` matches what the
 * paginated reads return.
 *
 * @param db - Database instance.
 * @param period - Same period semantics as the read functions.
 * @param gameType - Same game-type slice semantics as the read functions.
 * @param now - Optional reference "now" for deterministic bounded-window tests.
 * @returns Total number of rows that the corresponding read would yield
 *   if `limit` and `offset` were unbounded.
 */
export function getLeaderboardCount(
  db: DatabaseType,
  period: LeaderboardPeriod,
  gameType: LeaderboardGameType = "all",
  now: number = Date.now(),
): number {
  const typePred = gameTypePredicate(gameType);
  const includeGhosts = ghostsVisibleOnLeaderboard(db);

  // period=all + gameType=all: count from the pre-aggregated lifetime_score
  // column on users (+ ghost_users when ghosts are visible). This matches
  // the row filter in getLifetimeLeaderboard's typePred===null branch.
  if (period === "all" && typePred === null) {
    const realCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM users
          WHERE is_active = 1
            AND lifetime_score > 0
            AND leaderboard_banned_at IS NULL
            AND is_test_account = 0`,
      )
      .get() as { n: number }).n;
    if (!includeGhosts) return realCount;
    return realCount + countGhostScorers(db);
  }

  // period=all + gameType slice: count distinct users with a positive
  // sum on the requested game_type slice (mirrors the HAVING in
  // getLifetimeLeaderboard's slice branch).
  if (period === "all" && typePred !== null) {
    const realCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT u.id
             FROM users u
             JOIN user_game_history ugh
               ON ugh.user_id = u.id
              AND ugh.game_type = ?
              AND ugh.excluded_at IS NULL
            WHERE u.is_active = 1
              AND u.leaderboard_banned_at IS NULL
              AND u.is_test_account = 0
            GROUP BY u.id
            HAVING COALESCE(SUM(ugh.score), 0) > 0
         )`,
      )
      .get(typePred) as { n: number }).n;
    if (!includeGhosts) return realCount;
    const ghostCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT g.id
             FROM ghost_users g
             JOIN ghost_game_history gh
               ON gh.ghost_user_id = g.id AND gh.game_type = ?
            WHERE g.is_active = 1
            GROUP BY g.id
            HAVING COALESCE(SUM(gh.score), 0) > 0
         )`,
      )
      .get(typePred) as { n: number }).n;
    return realCount + ghostCount;
  }

  // Bounded period (day/week/month): count distinct users with a
  // positive in-window sum, optionally restricted by game_type. Mirrors
  // getPeriodLeaderboard's join/having structure.
  const cutoff = getLeaderboardPeriodCutoff(period, now)!;
  const userJoin: string[] = ["ugh.user_id = u.id", "ugh.excluded_at IS NULL", "ugh.played_at >= ?"];
  const ghostJoin: string[] = ["gh.ghost_user_id = g.id", "gh.played_at >= ?"];
  const params: string[] = [cutoff];
  const ghostParams: string[] = [cutoff];
  if (typePred !== null) {
    userJoin.push("ugh.game_type = ?");
    ghostJoin.push("gh.game_type = ?");
    params.push(typePred);
    ghostParams.push(typePred);
  }

  const realCount = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT u.id
           FROM users u
           JOIN user_game_history ugh ON ${userJoin.join(" AND ")}
          WHERE u.is_active = 1
            AND u.leaderboard_banned_at IS NULL
            AND u.is_test_account = 0
          GROUP BY u.id
          HAVING COALESCE(SUM(ugh.score), 0) > 0
       )`,
    )
    .get(...params) as { n: number }).n;
  if (!includeGhosts) return realCount;

  const ghostCount = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT g.id
           FROM ghost_users g
           JOIN ghost_game_history gh ON ${ghostJoin.join(" AND ")}
          WHERE g.is_active = 1
          GROUP BY g.id
          HAVING COALESCE(SUM(gh.score), 0) > 0
       )`,
    )
    .get(...ghostParams) as { n: number }).n;
  return realCount + ghostCount;
}

/**
 * Count players with any recorded score in each leaderboard period.
 *
 * Drives the leaderboard page's pill visibility — a period with zero
 * players should not be clickable, so the client hides that pill.
 * "all" counts players with `lifetime_score > 0` (matches the row
 * filter in `getLifetimeLeaderboard`); the bounded periods count
 * distinct users whose summed `user_game_history.score` in the window
 * is positive. Bounded windows return existence flags (0 or 1) computed
 * via indexed EXISTS — see PR1 perf F1 for the rewrite reasoning. Only
 * `all` is a real count, used for the lifetime board's player caption.
 *
 * @param db - Database instance.
 * @param now - Optional reference "now" for deterministic tests.
 * @returns 0/1 for day/week/month, real count for all.
 */
export function getLeaderboardAvailability(
  db: DatabaseType,
  now: number = Date.now(),
): LeaderboardAvailability {
  const dayCut = getLeaderboardPeriodCutoff("day", now)!;
  const weekCut = getLeaderboardPeriodCutoff("week", now)!;
  const monthCut = getLeaderboardPeriodCutoff("month", now)!;

  // PR1 perf F1: bounded-period flags use indexed EXISTS rather than a
  // per-user aggregate. The leaderboard page consumes these as truthiness
  // checks only — exact counts were never used, but the old aggregate
  // scanned the entire user_game_history table on every probe and was the
  // single biggest blocker on the event loop under mixed REST load.
  // Migration 61 adds idx_user_game_history_played_active so each EXISTS
  // resolves at the first qualifying row.
  const realExistsStmt = db.prepare(
    `SELECT EXISTS(
       SELECT 1
         FROM user_game_history ugh
         JOIN users u ON u.id = ugh.user_id
        WHERE u.is_active = 1
          AND ugh.excluded_at IS NULL
          AND ugh.score > 0
          AND ugh.played_at >= ?
        LIMIT 1
     ) AS hit`,
  );
  const realDay = (realExistsStmt.get(dayCut) as { hit: number }).hit;
  const realWeek = (realExistsStmt.get(weekCut) as { hit: number }).hit;
  const realMonth = (realExistsStmt.get(monthCut) as { hit: number }).hit;

  // Mirror the visibility filters used by getLifetimeLeaderboard so the
  // "N players" caption tracks the actual board: banned users and test
  // accounts shouldn't inflate the count when they're hidden from the
  // listing. Pre-PR1 the count omitted these filters and silently
  // disagreed with the row count visible to users.
  const realAll = (db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM users
        WHERE is_active = 1
          AND lifetime_score > 0
          AND leaderboard_banned_at IS NULL
          AND is_test_account = 0`,
    )
    .get() as { cnt: number }).cnt;

  const includeGhosts = ghostsVisibleOnLeaderboard(db);

  // When ghosts are toggled visible they appear on every public board
  // (lifetime + day/week/month + SP/MP slices). OR-merge ghost-side
  // existence so the pill stays visible if either real users or ghosts
  // qualify. `all` keeps a real count — that one IS displayed in the
  // lifetime board's "N players" caption.
  let ghostDay = 0, ghostWeek = 0, ghostMonth = 0, ghostAll = 0;
  if (includeGhosts) {
    const ghostExistsStmt = db.prepare(
      `SELECT EXISTS(
         SELECT 1
           FROM ghost_game_history gh
           JOIN ghost_users g ON g.id = gh.ghost_user_id
          WHERE g.is_active = 1
            AND gh.score > 0
            AND gh.played_at >= ?
          LIMIT 1
       ) AS hit`,
    );
    ghostDay = (ghostExistsStmt.get(dayCut) as { hit: number }).hit;
    ghostWeek = (ghostExistsStmt.get(weekCut) as { hit: number }).hit;
    ghostMonth = (ghostExistsStmt.get(monthCut) as { hit: number }).hit;
    ghostAll = countGhostScorers(db);
  }

  return {
    day: realDay || ghostDay,
    week: realWeek || ghostWeek,
    month: realMonth || ghostMonth,
    all: realAll + ghostAll,
  };
}

/**
 * Get the top players by longest daily-challenge streak.
 *
 * Ranks on `daily_streak_best` (their all-time best streak), with the
 * current streak as a tiebreaker. Users with no streak history (best = 0)
 * are excluded — they have no standing on this board.
 *
 * `currentStreak` is decayed at read time: the stored column is only
 * refreshed when a user completes another daily, so a user who built a
 * streak and then went silent would otherwise appear to still be on it
 * forever. If `daily_streak_last_date` is older than yesterday (UTC), the
 * reported current is 0 regardless of the stored value.
 *
 * @param db - Database instance.
 * @param limit - Max entries to return (default 20, capped at 100).
 * @param today - Optional UTC date string (YYYY-MM-DD) used as the
 *   reference point for streak-decay evaluation. Defaults to the current
 *   UTC date; exposed for tests that freeze "today".
 * @returns Array of entries ranked by longest streak.
 */
export function getLongestStreakLeaderboard(
  db: DatabaseType,
  limit: number = 20,
  today: string = getUtcDateString(new Date()),
): LongestStreakLeaderboardEntry[] {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const yesterday = addDays(today, -1);

  // The CASE mirrors getStreakForUser's decay: treat the stored current
  // as live only when the last play was yesterday or later (lexicographic
  // YYYY-MM-DD compare; accepts today's date and, defensively, anything
  // after). The tiebreaker in ORDER BY uses the same decayed value so a
  // stale streak doesn't out-rank a truly active one on a tie in `best`.
  //
  // When ghosts are toggled visible, UNION ALL with ghost_users so the
  // streak leaderboard isn't all-real-user. Ghost streaks are advanced
  // synthetically (services/ghostUsers/dailySim.ts) at the same UTC-day
  // cadence as real-user streaks; the same decay CASE applies.
  const includeGhosts = ghostsVisibleOnLeaderboard(db);
  const sql = includeGhosts
    ? `SELECT username, avatar, longestStreak, currentStreak FROM (
         SELECT username, avatar,
                daily_streak_best AS longestStreak,
                CASE WHEN daily_streak_last_date >= ? THEN daily_streak_current ELSE 0 END AS currentStreak
           FROM users
          WHERE is_active = 1 AND daily_streak_best > 0
            AND leaderboard_banned_at IS NULL
            AND is_test_account = 0
         UNION ALL
         SELECT username, avatar,
                daily_streak_best AS longestStreak,
                CASE WHEN daily_streak_last_date >= ? THEN daily_streak_current ELSE 0 END AS currentStreak
           FROM ghost_users
          WHERE is_active = 1 AND daily_streak_best > 0
            AND last_played_at IS NOT NULL
       )
       ORDER BY longestStreak DESC, currentStreak DESC, username ASC
       LIMIT ?`
    : `SELECT username, avatar,
              daily_streak_best AS longestStreak,
              CASE WHEN daily_streak_last_date >= ? THEN daily_streak_current ELSE 0 END AS currentStreak
         FROM users
        WHERE is_active = 1 AND daily_streak_best > 0
          AND leaderboard_banned_at IS NULL
          AND is_test_account = 0
        ORDER BY daily_streak_best DESC,
                 CASE WHEN daily_streak_last_date >= ? THEN daily_streak_current ELSE 0 END DESC,
                 username ASC
        LIMIT ?`;

  // Both SQL variants take the same three bind params (yesterday cutoff
  // used twice in the CASE-decay clauses + the limit), so a single param
  // tuple covers both branches.
  const rows = db
    .prepare(sql)
    .all(yesterday, yesterday, safeLimit) as {
      username: string;
      avatar: string | null;
      longestStreak: number;
      currentStreak: number;
    }[];

  return rows.map((row, i) => ({
    rank: i + 1,
    username: row.username,
    avatar: (row.avatar as import("@price-game/shared").Avatar | null) ?? null,
    longestStreak: row.longestStreak,
    currentStreak: row.currentStreak,
  }));
}

/**
 * Get a user's rank on the lifetime leaderboard.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @returns Rank and total player count, or null if user not found or inactive.
 */
export function getUserRank(
  db: DatabaseType,
  userId: string,
): UserRankResponse | null {
  const user = db
    .prepare("SELECT lifetime_score, best_rank FROM users WHERE id = ? AND is_active = 1")
    .get(userId) as { lifetime_score: number; best_rank: number | null } | undefined;

  if (!user) return null;

  // Both halves of the rank calculation intentionally count against the
  // same pool (all active users). Keeping them in sync guarantees the
  // response is coherent — "Rank N of M" always satisfies N ≤ M — even
  // though the leaderboard view itself hides zero-score users. A prior
  // attempt to also hide zero-score users from the total count produced
  // rows like "Rank 11 of 10" for brand-new accounts.
  const rankRow = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1 AND lifetime_score > ?",
    )
    .get(user.lifetime_score) as { cnt: number };

  const totalRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1")
    .get() as { cnt: number };

  const currentRank = rankRow.cnt + 1;

  return {
    rank: currentRank,
    totalPlayers: totalRow.cnt,
    bestRank: user.best_rank !== null
      ? Math.min(user.best_rank, currentRank)
      : currentRank,
  };
}

/**
 * Resolve a user ID from a username (case-insensitive, active only).
 *
 * @param db - Database instance.
 * @param username - The username to look up.
 * @returns The user row or null.
 */
function resolveUser(
  db: DatabaseType,
  username: string,
): { id: string; username: string; lifetime_score: number; created_at: string; avatar: string | null } | null {
  return (
    (db
      .prepare(
        "SELECT id, username, lifetime_score, created_at, avatar FROM users WHERE username_normalized = LOWER(?) AND is_active = 1",
      )
      .get(username) as {
        id: string;
        username: string;
        lifetime_score: number;
        created_at: string;
        avatar: string | null;
      } | undefined) ?? null
  );
}

/** Look up a ghost by username for the public-profile route. Mirrors
 *  the shape returned by resolveUser so the caller can branch cleanly.
 *  `created_at` is the synthetic `account_created_at` (so the profile's
 *  "member since" reads naturally); only returns a row when the ghost
 *  is active AND ghosts are currently visible on the leaderboard. The
 *  visibility gate prevents typing a known ghost username into the URL
 *  bar from leaking a profile while the system is dark. */
function resolveGhost(
  db: DatabaseType,
  username: string,
): { id: string; username: string; lifetime_score: number; created_at: string; avatar: string | null } | null {
  if (!ghostsVisibleOnLeaderboard(db)) return null;
  const row = db
    .prepare(
      `SELECT id, username, lifetime_score, account_created_at AS created_at, avatar
         FROM ghost_users
        WHERE username_normalized = LOWER(?) AND is_active = 1`,
    )
    .get(username) as {
      id: string;
      username: string;
      lifetime_score: number;
      created_at: string;
      avatar: string | null;
    } | undefined;
  return row ?? null;
}

/**
 * Get a public player profile by username.
 *
 * @param db - Database instance.
 * @param username - Username (case-insensitive).
 * @returns Public profile or null if user not found or inactive.
 */
export function getPublicPlayerProfile(
  db: DatabaseType,
  username: string,
): PublicPlayerProfile | null {
  const user = resolveUser(db, username);
  if (user) {
    const agg = db
      .prepare(
        `SELECT
           COUNT(*) AS total_games,
           COALESCE(MAX(score), 0) AS best_score,
           COALESCE(AVG(score), 0) AS avg_score
         FROM user_game_history WHERE user_id = ?`,
      )
      .get(user.id) as { total_games: number; best_score: number; avg_score: number };

    const modeRows = db
      .prepare(
        "SELECT game_mode, COUNT(*) AS count FROM user_game_history WHERE user_id = ? GROUP BY game_mode",
      )
      .all(user.id) as { game_mode: string; count: number }[];

    const gamesByMode: Record<string, number> = {};
    for (const row of modeRows) gamesByMode[row.game_mode] = row.count;

    const winsRow = db
      .prepare(
        "SELECT COUNT(*) AS wins FROM user_game_history WHERE user_id = ? AND game_type = 'multiplayer' AND placement = 1",
      )
      .get(user.id) as { wins: number };

    const winRecordRow = db
      .prepare(
        `SELECT lifetime_wins   AS wins,
                lifetime_losses AS losses,
                current_streak  AS currentStreak,
                best_win_streak AS bestStreak
           FROM users WHERE id = ?`,
      )
      .get(user.id) as
      | { wins: number; losses: number; currentStreak: number; bestStreak: number }
      | undefined;

    return {
      username: user.username,
      avatar: (user.avatar as import("@price-game/shared").Avatar | null) ?? null,
      lifetimeScore: user.lifetime_score,
      totalGames: agg.total_games,
      bestScore: agg.best_score,
      averageScore: Math.round(agg.avg_score),
      gamesByMode,
      multiplayerWins: winsRow.wins,
      memberSince: user.created_at.split("T")[0],
      winRecord: winRecordRow ?? {
        wins: 0,
        losses: 0,
        currentStreak: 0,
        bestStreak: 0,
      },
    };
  }

  // No real-user match — try ghosts. The visibility gate inside
  // resolveGhost ensures this only fires when the admin has explicitly
  // opted ghosts in. Profile shape is identical to a real-user profile
  // so the public client renders both branches with the same component.
  const ghost = resolveGhost(db, username);
  if (!ghost) return null;

  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS total_games,
         COALESCE(MAX(score), 0) AS best_score,
         COALESCE(AVG(score), 0) AS avg_score
       FROM ghost_game_history WHERE ghost_user_id = ?`,
    )
    .get(ghost.id) as { total_games: number; best_score: number; avg_score: number };

  const modeRows = db
    .prepare(
      "SELECT game_mode, COUNT(*) AS count FROM ghost_game_history WHERE ghost_user_id = ? GROUP BY game_mode",
    )
    .all(ghost.id) as { game_mode: string; count: number }[];

  const gamesByMode: Record<string, number> = {};
  for (const row of modeRows) gamesByMode[row.game_mode] = row.count;

  const winsRow = db
    .prepare(
      "SELECT COUNT(*) AS wins FROM ghost_game_history WHERE ghost_user_id = ? AND game_type = 'multiplayer' AND placement = 1",
    )
    .get(ghost.id) as { wins: number };

  return {
    username: ghost.username,
    avatar: (ghost.avatar as import("@price-game/shared").Avatar | null) ?? null,
    lifetimeScore: ghost.lifetime_score,
    totalGames: agg.total_games,
    bestScore: agg.best_score,
    averageScore: Math.round(agg.avg_score),
    gamesByMode,
    multiplayerWins: winsRow.wins,
    memberSince: ghost.created_at.split("T")[0],
    // Ghosts don't track W/L; return zeros so the frontend renders the
    // strip without special-casing the ghost branch.
    winRecord: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
  };
}

/**
 * Get daily score history for a user by username (public).
 *
 * @param db - Database instance.
 * @param username - Username (case-insensitive).
 * @param days - Number of days to look back (default 30).
 * @returns Array of daily score aggregates, or empty if user not found.
 */
export function getPublicScoreHistory(
  db: DatabaseType,
  username: string,
  days: number = 30,
  timeZone: string = ADMIN_TIMEZONE,
): UserScoreHistoryDay[] {
  const user = resolveUser(db, username);
  const ghost = user ? null : resolveGhost(db, username);
  if (!user && !ghost) return [];

  const safeDays = clampDays(days);
  const end = new Date();
  // Generous SQL filter buffer — padDateSeries trims to exactly
  // `safeDays` entries via calendar-day arithmetic below.
  const sinceIso = new Date(end.getTime() - (safeDays + 2) * MS_PER_DAY).toISOString();

  const rows = user
    ? (db
        .prepare(
          `SELECT played_at, score
             FROM user_game_history
            WHERE user_id = ? AND played_at >= ?
            ORDER BY played_at ASC`,
        )
        .all(user.id, sinceIso) as { played_at: string; score: number }[])
    : (db
        .prepare(
          `SELECT played_at, score
             FROM ghost_game_history
            WHERE ghost_user_id = ? AND played_at >= ?
            ORDER BY played_at ASC`,
        )
        .all(ghost!.id, sinceIso) as { played_at: string; score: number }[]);

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

/**
 * Get paginated game history for a user by username (public, date-only).
 *
 * @param db - Database instance.
 * @param username - Username (case-insensitive).
 * @param limit - Max entries per page (default 20, capped at 100).
 * @param offset - Number of entries to skip (default 0).
 * @returns Entries with date-only and total count, or empty if user not found.
 */
export function getPublicGameHistory(
  db: DatabaseType,
  username: string,
  limit: number = 20,
  offset: number = 0,
  timeZone: string = ADMIN_TIMEZONE,
): { entries: PublicGameHistoryEntry[]; total: number } {
  const user = resolveUser(db, username);
  const ghost = user ? null : resolveGhost(db, username);
  if (!user && !ghost) return { entries: [], total: 0 };

  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safeOffset = Math.max(offset, 0);

  const countRow = user
    ? (db
        .prepare("SELECT COUNT(*) AS total FROM user_game_history WHERE user_id = ?")
        .get(user.id) as { total: number })
    : (db
        .prepare("SELECT COUNT(*) AS total FROM ghost_game_history WHERE ghost_user_id = ?")
        .get(ghost!.id) as { total: number });

  // Fetch raw played_at so the date bucket can be computed in the caller's
  // timezone — the old SQLite DATE() wrapper returned UTC, which drifted
  // by a day around midnight for non-UTC viewers. Ghosts have no share_id
  // (their game results aren't shareable artifacts) so the projection is
  // identical to the user-side; ghost rows return share_id = NULL.
  const rows = user
    ? (db
        .prepare(
          `SELECT id, game_type, game_mode, score, placement, players_count, played_at, share_id
             FROM user_game_history
            WHERE user_id = ?
            ORDER BY played_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(user.id, safeLimit, safeOffset) as {
          id: number;
          game_type: string;
          game_mode: string;
          score: number;
          placement: number | null;
          players_count: number | null;
          played_at: string;
          share_id: string | null;
        }[])
    : (db
        .prepare(
          `SELECT id, game_type, game_mode, score, placement, players_count, played_at, NULL AS share_id
             FROM ghost_game_history
            WHERE ghost_user_id = ?
            ORDER BY played_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(ghost!.id, safeLimit, safeOffset) as {
          id: number;
          game_type: string;
          game_mode: string;
          score: number;
          placement: number | null;
          players_count: number | null;
          played_at: string;
          share_id: string | null;
        }[]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      gameType: r.game_type as "single" | "multiplayer",
      gameMode: r.game_mode,
      score: r.score,
      placement: r.placement ?? null,
      playersCount: r.players_count ?? null,
      playedDate: tzDateString(r.played_at, timeZone),
      shareId: r.share_id ?? null,
    })),
    total: countRow.total,
  };
}

/**
 * Get daily rank history for the authenticated user's rank-over-time chart.
 *
 * Takes the last rank recorded on each day within the given window.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param days - Number of days to look back (default 30, max 365).
 * @returns Array of daily rank snapshots sorted by date ascending.
 */
export function getRankHistory(
  db: DatabaseType,
  userId: string,
  days: number = 30,
  timeZone: string = ADMIN_TIMEZONE,
): UserRankHistoryDay[] {
  const safeDays = clampDays(days);
  const end = new Date();
  const start = new Date(end.getTime() - (safeDays - 1) * MS_PER_DAY);
  // Widen the SQL filter by one day so rows that belong to the first
  // tz-day in the window but whose UTC timestamp dips just earlier are
  // still caught. recorded_at is ISO-8601 UTC.
  const sinceIso = new Date(start.getTime() - MS_PER_DAY).toISOString();

  // Fetch raw rows in ascending order, then keep the LAST rank for each
  // tz-bucketed day (the rank after the most recent game that day).
  // Rank history is NOT zero-filled — a "no rank recorded" bucket has
  // no meaningful rank value, so we return only days that have a row.
  const rows = db
    .prepare(
      `SELECT recorded_at, rank, total_players
       FROM user_rank_history
       WHERE user_id = ? AND recorded_at >= ?
       ORDER BY recorded_at ASC`,
    )
    .all(userId, sinceIso) as {
      recorded_at: string;
      rank: number;
      total_players: number;
    }[];

  // Walk rows in chronological order; for each tz-day bucket, overwrite
  // with the latest entry so the final map holds last-rank-per-day.
  const byDate = new Map<string, { rank: number; totalPlayers: number }>();
  for (const row of rows) {
    const bucket = tzDateString(row.recorded_at, timeZone);
    if (!bucket) continue;
    byDate.set(bucket, { rank: row.rank, totalPlayers: row.total_players });
  }

  return Array.from(byDate.entries())
    .map(([date, v]) => ({ date, rank: v.rank, totalPlayers: v.totalPlayers }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
