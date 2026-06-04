/**
 * Admin user management service.
 *
 * Provides CRUD operations and listing with pagination, search, filtering,
 * and sorting for the admin user management dashboard. Also includes
 * deactivation/reactivation, forced password resets, game history,
 * aggregate stats, and activity tracking.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  tzDateString,
  ADMIN_TIMEZONE,
  padDateSeries,
} from "@price-game/shared";
import type {
  AdminUserListParams,
  AdminUserListResponse,
  AdminUserSummary,
  AdminUserDetail,
  AdminUserUpdateRequest,
  AdminUserGameHistoryResponse,
  GameHistoryEntry,
  UserStats,
  AdminUserActivityDay,
} from "@price-game/shared";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Clamp a `days` window to a sane range [1, 365]. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.floor(days), 1), 365);
}

/** Whitelist of valid columns for sorting, mapped to their SQL column names. */
const VALID_SORT_COLUMNS: Record<string, string> = {
  username: "u.username",
  email: "u.email",
  created_at: "u.created_at",
  lifetime_score: "u.lifetime_score",
  last_login_at: "u.last_login_at",
  referrals: "credited_referrals",
};

/**
 * Map a database row to an AdminUserSummary object.
 *
 * @param row - Raw database row from the users table with total_games.
 * @returns Mapped AdminUserSummary.
 */
function toAdminUserSummary(row: Record<string, unknown>): AdminUserSummary {
  return {
    id: row.id as string,
    username: row.username as string,
    email: row.email as string,
    avatar: (row.avatar as import("@price-game/shared").Avatar | null) ?? null,
    isActive: (row.is_active as number) === 1,
    lifetimeScore: (row.lifetime_score as number) ?? 0,
    createdAt: row.created_at as string,
    lastLoginAt: (row.last_login_at as string) ?? null,
    totalGames: (row.total_games as number) ?? 0,
    creditedReferrals: (row.credited_referrals as number) ?? 0,
    totalReferrals: (row.total_referrals as number) ?? 0,
  };
}

/**
 * Map a database row to an AdminUserDetail object.
 *
 * @param row - Raw database row from the users table with total_games.
 * @returns Mapped AdminUserDetail.
 */
function toAdminUserDetail(row: Record<string, unknown>): AdminUserDetail {
  return {
    ...toAdminUserSummary(row),
    emailVerified: (row.email_verified as number) === 1,
    updatedAt: row.updated_at as string,
    oauthProvider: (row.oauth_provider as string) ?? null,
  };
}

/**
 * List users with pagination, search, filtering, and sorting.
 *
 * Supports searching by username or email, filtering by active status,
 * and sorting by whitelisted columns. Includes a totalGames subquery count.
 *
 * @param db - Database instance.
 * @param params - Query parameters for filtering, sorting, and pagination.
 * @returns Paginated user list with total count.
 */
export function listUsers(
  db: DatabaseType,
  params: AdminUserListParams,
): AdminUserListResponse {
  const page = Math.max(params.page ?? 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (params.search) {
    conditions.push("(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
    const escaped = params.search.replace(/[%_\\]/g, "\\$&");
    const term = `%${escaped}%`;
    bindings.push(term, term);
  }

  if (params.isActive !== undefined) {
    conditions.push("u.is_active = ?");
    bindings.push(params.isActive ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sortCol = VALID_SORT_COLUMNS[params.sortBy ?? "created_at"] ?? "u.created_at";
  const sortOrder = params.sortOrder === "desc" ? "DESC" : "ASC";

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM users u ${whereClause}`)
    .get(...bindings) as { total: number };
  const total = countRow.total;

  // u.total_games is the cached column (PR1 perf F2) — counts only
  // non-excluded user_game_history rows. Aligns admin display with
  // leaderboard semantics: excluded rows disappear from every count.
  // Referral subqueries are unrelated to total_games and stay inline.
  const rows = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id) as total_referrals,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id AND status = 'credited') as credited_referrals
       FROM users u
       ${whereClause}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
    )
    .all(...bindings, pageSize, offset) as Record<string, unknown>[];

  return {
    users: rows.map(toAdminUserSummary),
    total,
    page,
    pageSize,
    totalPages: total > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

/**
 * Get detailed user information by ID.
 *
 * Returns full user details including email verification status, update
 * timestamp, and OAuth provider. Includes totalGames via subquery.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @returns The AdminUserDetail, or null if not found.
 */
export function getUserById(
  db: DatabaseType,
  id: string,
): AdminUserDetail | null {
  // u.total_games is the cached column (PR1 perf F2) — same semantics
  // as the list query, exclusions are not counted.
  const row = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id) as total_referrals,
              (SELECT COUNT(*) FROM referrals WHERE referrer_id = u.id AND status = 'credited') as credited_referrals
       FROM users u
       WHERE u.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  return row ? toAdminUserDetail(row) : null;
}

/**
 * Update a user's profile fields.
 *
 * Supports updating username and email. Checks for duplicate
 * username_normalized and email before applying changes. Updates the
 * updated_at timestamp.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @param updates - Partial update data (username, email, isActive).
 * @returns The updated AdminUserDetail, or null if the user does not exist.
 * @throws If the new username or email is already taken by another user.
 */
export function updateUser(
  db: DatabaseType,
  id: string,
  updates: AdminUserUpdateRequest,
): AdminUserDetail | null {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    const normalized = updates.username.toLowerCase();
    // Check for duplicate (different user with same normalized username)
    const dup = db
      .prepare("SELECT id FROM users WHERE username_normalized = ? AND id != ?")
      .get(normalized, id) as { id: string } | undefined;
    if (dup) {
      throw new Error("Username is already taken");
    }
    fields.push("username = ?", "username_normalized = ?");
    values.push(updates.username, normalized);
  }

  if (updates.email !== undefined) {
    const emailLower = updates.email.toLowerCase();
    const dup = db
      .prepare("SELECT id FROM users WHERE email = ? AND id != ?")
      .get(emailLower, id) as { id: string } | undefined;
    if (dup) {
      throw new Error("Email is already in use");
    }
    fields.push("email = ?");
    values.push(emailLower);
  }

  if (updates.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(updates.isActive ? 1 : 0);
  }

  if (fields.length === 0) {
    return getUserById(db, id);
  }

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  return getUserById(db, id);
}

/**
 * Permanently delete a user and all related data.
 *
 * Removes rows from every table with a non-cascading FK reference to users —
 * user_sessions, user_game_history, user_rewards, user_product_views,
 * email_verification_tokens, password_reset_tokens, reward_awards, referrals,
 * daily_plays, and user_rank_history — then the users row itself, all within
 * a single transaction. Tables with `ON DELETE CASCADE` FKs (e.g. push
 * subscriptions) are cleaned up automatically by SQLite when the users row
 * is removed.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @returns true if the user was deleted, false if the user was not found.
 */
export function deleteUser(db: DatabaseType, id: string): boolean {
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) return false;

  db.transaction(() => {
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_game_history WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_rewards WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_product_views WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM reward_awards WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?").run(id, id);
    db.prepare("DELETE FROM daily_plays WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_rank_history WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  })();

  return true;
}

/**
 * Deactivate a user account.
 *
 * Sets is_active to 0 and destroys all active sessions so the user is
 * immediately logged out.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @returns The updated AdminUserDetail, or null if the user was not found.
 */
export function deactivateUser(
  db: DatabaseType,
  id: string,
): AdminUserDetail | null {
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) return null;

  db.transaction(() => {
    db.prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
  })();

  return getUserById(db, id);
}

/**
 * Reactivate a previously deactivated user account.
 *
 * Sets is_active to 1 so the user can log in again.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @returns The updated AdminUserDetail, or null if the user was not found.
 */
export function reactivateUser(
  db: DatabaseType,
  id: string,
): AdminUserDetail | null {
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) return null;

  db.prepare("UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );

  return getUserById(db, id);
}

/**
 * Force-reset a user's password to a random temporary password.
 *
 * Generates a cryptographically random 16-character alphanumeric password,
 * hashes it with bcrypt (10 rounds), updates the user's password_hash, and
 * destroys all active sessions. Returns the plaintext temporary password
 * so the admin can share it with the user.
 *
 * @param db - Database instance.
 * @param id - The user's ID.
 * @returns The plaintext temporary password, or null if the user was not found.
 */
export function forceResetPassword(
  db: DatabaseType,
  id: string,
): string | null {
  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) return null;

  const tempPassword = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  const hash = bcrypt.hashSync(tempPassword, 10);

  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      hash,
      new Date().toISOString(),
      id,
    );
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
  })();

  return tempPassword;
}

/**
 * Get paginated game history for a specific user.
 *
 * Returns entries sorted by played_at descending (most recent first).
 *
 * @param db - Database instance.
 * @param userId - The user's ID.
 * @param page - Page number (1-based).
 * @param pageSize - Number of entries per page.
 * @returns Paginated game history response.
 */
export function getUserGameHistoryPaginated(
  db: DatabaseType,
  userId: string,
  page: number,
  pageSize: number,
): AdminUserGameHistoryResponse {
  const safePage = Math.max(page, 1);
  const safePageSize = Math.min(Math.max(pageSize, 1), 200);
  const offset = (safePage - 1) * safePageSize;

  const countRow = db
    .prepare("SELECT COUNT(*) as total FROM user_game_history WHERE user_id = ?")
    .get(userId) as { total: number };
  const total = countRow.total;

  const rows = db
    .prepare(
      "SELECT * FROM user_game_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ? OFFSET ?",
    )
    .all(userId, safePageSize, offset) as Record<string, unknown>[];

  const history: GameHistoryEntry[] = rows.map((row) => ({
    id: row.id as number,
    gameType: row.game_type as "single" | "multiplayer",
    gameMode: row.game_mode as string,
    score: row.score as number,
    placement: (row.placement as number) ?? null,
    playersCount: (row.players_count as number) ?? null,
    playedAt: row.played_at as string,
  }));

  return {
    history,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: total > 0 ? Math.ceil(total / safePageSize) : 0,
  };
}

/**
 * Get aggregate game statistics for a specific user.
 *
 * Returns totals, best/average scores, games by mode, and multiplayer wins.
 *
 * @param db - Database instance.
 * @param userId - The user's ID.
 * @returns Aggregate UserStats.
 */
export function getUserStatsById(
  db: DatabaseType,
  userId: string,
): UserStats {
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

  const modeRows = db
    .prepare(
      "SELECT game_mode, COUNT(*) as count FROM user_game_history WHERE user_id = ? GROUP BY game_mode",
    )
    .all(userId) as { game_mode: string; count: number }[];

  const gamesByMode: Record<string, number> = {};
  for (const row of modeRows) {
    gamesByMode[row.game_mode] = row.count;
  }

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
 * Get daily game activity for a user over a specified number of days.
 *
 * Returns a zero-filled array of `{ date, gamesPlayed }` entries — one row
 * for every calendar day in the window, bucketed by `timeZone` (default
 * `ADMIN_TIMEZONE`). Raw `played_at` ISO timestamps are aggregated in
 * application code so DST and cross-midnight cases are handled correctly.
 *
 * Prior to the chart-accuracy fix this used SQLite's `DATE(played_at)`,
 * which returned UTC days and caused the "user's last-played timestamp
 * says 4/9 but the activity chart shows 3 games on 4/10" regression.
 *
 * @param db - Database instance.
 * @param userId - The user's ID.
 * @param days - Number of days to look back (clamped to [1, 365]).
 * @param timeZone - IANA timezone for day bucketing (default `ADMIN_TIMEZONE`).
 * @returns Zero-filled array with one entry per day in the window.
 */
export function getUserActivity(
  db: DatabaseType,
  userId: string,
  days: number,
  timeZone: string = ADMIN_TIMEZONE,
): AdminUserActivityDay[] {
  const safeDays = clampDays(days);
  const end = new Date();
  // Generous SQL filter buffer (2 extra days beyond the exact window)
  // so every row whose tz-bucket might land inside the final window is
  // fetched. `padDateSeries` below trims to exactly `safeDays` entries
  // via calendar-day arithmetic, immune to DST boundary drift.
  const sinceIso = new Date(end.getTime() - (safeDays + 2) * MS_PER_DAY).toISOString();

  const rows = db
    .prepare(
      `SELECT played_at AS played_at, COUNT(*) AS games_played
       FROM user_game_history
       WHERE user_id = ? AND played_at >= ?
       GROUP BY played_at`,
    )
    .all(userId, sinceIso) as { played_at: string; games_played: number }[];

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const bucket = tzDateString(row.played_at, timeZone);
    if (!bucket) continue;
    byDate.set(bucket, (byDate.get(bucket) ?? 0) + row.games_played);
  }

  const sparse: AdminUserActivityDay[] = Array.from(byDate.entries())
    .map(([date, gamesPlayed]) => ({ date, gamesPlayed }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return padDateSeries(
    sparse,
    end,
    safeDays,
    timeZone,
    (date) => ({ date, gamesPlayed: 0 }),
  );
}
