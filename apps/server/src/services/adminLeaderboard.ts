/**
 * Admin leaderboard management service.
 *
 * Provides CRUD over moderation state for the public leaderboard:
 *   - Soft-exclude individual game-history rows (with reason + audit trail)
 *   - Account-level leaderboard bans (permanent or timed)
 *   - "Test account" tagging for QA/staff accounts that should never appear
 *   - Per-account drilldowns and an admin audit log
 *
 * The data source is `user_game_history` — every game played by a
 * registered user — which is the same source the public v2 lifetime
 * board reads from (via `services/publicProfile.ts`). Excluding a row
 * here also drops it from the public board because the v2 read paths
 * filter on `excluded_at IS NULL`. Anonymous/guest play does not
 * generate history rows and therefore cannot be moderated row-by-row.
 *
 * All write paths append a row to `admin_leaderboard_audit` so the
 * panel can show a complete trail of moderation actions.
 */
import type { Database as DatabaseType } from "better-sqlite3";

/** A leaderboard row as displayed in the admin panel. */
export interface AdminLeaderboardEntry {
  id: number;
  /** Display name for the row — always the user's current username. */
  playerName: string;
  score: number;
  playedAt: string | null;
  gameMode: string;
  /** "single" or "multiplayer". */
  gameType: string;
  /** Session id for SP rows, room code for MP rows. */
  sessionId: string | null;
  userId: string;
  username: string;
  /** MP placement (1-based) — null for SP rows. */
  placement: number | null;
  /** MP player count — null for SP rows. */
  playersCount: number | null;
  isExcluded: boolean;
  excludedAt: string | null;
  excludedByAdminId: string | null;
  excludedReason: string | null;
  /** True if the linked user is currently banned from the leaderboard. */
  userBanned: boolean;
  /** True if the linked user is flagged as a test account. */
  userIsTest: boolean;
}

/** Filters accepted by `listEntries`. */
export interface ListEntriesFilters {
  mode?: string;
  search?: string;
  scoreMin?: number;
  scoreMax?: number;
  dateFrom?: string;
  dateTo?: string;
  /** "active" hides excluded; "excluded" shows only excluded; "all" returns both (default). */
  status?: "active" | "excluded" | "all";
  /** Pagination limit (default 50, max 200). */
  limit?: number;
  /** Pagination offset (default 0). */
  offset?: number;
  /** Sort key (default "score"). */
  sort?: "score" | "playedAt";
  /** Sort direction (default "desc"). */
  direction?: "asc" | "desc";
}

/** Paginated list payload. */
export interface ListEntriesResult {
  entries: AdminLeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** A user as shown in the admin panel banned-accounts view. */
export interface AdminLeaderboardUserSummary {
  userId: string;
  username: string;
  email: string | null;
  lifetimeScore: number;
  totalEntries: number;
  excludedEntries: number;
  bestScore: number;
  banned: boolean;
  bannedAt: string | null;
  bannedUntil: string | null;
  bannedReason: string | null;
  bannedBy: string | null;
  isTestAccount: boolean;
  recentEntries: AdminLeaderboardEntry[];
}

/** A row in the admin moderation audit log. */
export interface AdminLeaderboardAuditEntry {
  id: number;
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: "entry" | "user";
  targetId: string;
  targetLabel: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Aggregate counts shown on the admin panel header. */
export interface AdminLeaderboardStats {
  totalEntries: number;
  excludedEntries: number;
  bannedUsers: number;
  testAccounts: number;
}

/** Identity of the admin performing an action. Captured on every audit row. */
export interface AdminActor {
  id: string;
  username: string;
}

const VALID_ACTIONS = new Set([
  "exclude_entry",
  "restore_entry",
  "ban_user",
  "unban_user",
  "set_test_flag",
]);

/**
 * Append a row to the moderation audit log.
 *
 * @internal — exported so other admin code paths can record cross-cutting
 * events; most callers should go through the `excludeEntry` / `banUser` /
 * etc. helpers below which already audit themselves.
 */
export function recordAuditEvent(
  db: DatabaseType,
  entry: {
    actor: AdminActor;
    action: string;
    targetType: "entry" | "user";
    targetId: string;
    targetLabel?: string | null;
    reason?: string | null;
    details?: Record<string, unknown> | null;
  },
): void {
  if (!VALID_ACTIONS.has(entry.action)) {
    throw new Error(`Unknown audit action: ${entry.action}`);
  }
  db.prepare(
    `INSERT INTO admin_leaderboard_audit
       (admin_user_id, admin_username, action, target_type, target_id,
        target_label, reason, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.actor.id,
    entry.actor.username,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.targetLabel ?? null,
    entry.reason ?? null,
    entry.details ? JSON.stringify(entry.details) : null,
    new Date().toISOString(),
  );
}

interface RawEntryRow {
  id: number;
  user_id: string;
  username: string;
  score: number;
  played_at: string;
  game_mode: string;
  game_type: string;
  session_id: string | null;
  room_code: string | null;
  placement: number | null;
  players_count: number | null;
  excluded_at: string | null;
  excluded_by_admin_id: string | null;
  excluded_reason: string | null;
  leaderboard_banned_at: string | null;
  is_test_account: number | null;
}

function mapEntry(row: RawEntryRow): AdminLeaderboardEntry {
  return {
    id: row.id,
    playerName: row.username,
    score: row.score,
    playedAt: row.played_at,
    gameMode: row.game_mode,
    gameType: row.game_type,
    sessionId: row.session_id ?? row.room_code,
    userId: row.user_id,
    username: row.username,
    placement: row.placement,
    playersCount: row.players_count,
    isExcluded: row.excluded_at !== null,
    excludedAt: row.excluded_at,
    excludedByAdminId: row.excluded_by_admin_id,
    excludedReason: row.excluded_reason,
    userBanned: row.leaderboard_banned_at !== null,
    userIsTest: row.is_test_account === 1,
  };
}

const ENTRY_SELECT = `
  SELECT ugh.id, ugh.user_id, u.username,
         ugh.score, ugh.played_at, ugh.game_mode, ugh.game_type,
         ugh.session_id, ugh.room_code,
         ugh.placement, ugh.players_count,
         ugh.excluded_at, ugh.excluded_by_admin_id, ugh.excluded_reason,
         u.leaderboard_banned_at, u.is_test_account
    FROM user_game_history ugh
    JOIN users u ON u.id = ugh.user_id
`;

/**
 * List leaderboard entries for the admin panel with filters and pagination.
 *
 * Sources rows from `user_game_history` joined with `users`. Returns
 * excluded rows when requested via `status`. Caller is responsible for
 * auth — never expose this without `requireAdmin`.
 *
 * @param db - Database instance.
 * @param filters - Optional filters and pagination params.
 * @returns Filtered, paginated entries plus a total row count.
 */
export function listEntries(
  db: DatabaseType,
  filters: ListEntriesFilters = {},
): ListEntriesResult {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const status = filters.status ?? "all";
  const sort = filters.sort === "playedAt" ? "ugh.played_at" : "ugh.score";
  const direction = filters.direction === "asc" ? "ASC" : "DESC";

  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.mode) {
    where.push("ugh.game_mode = ?");
    params.push(filters.mode);
  }
  if (filters.search) {
    where.push("u.username LIKE ?");
    params.push(`%${filters.search}%`);
  }
  if (typeof filters.scoreMin === "number") {
    where.push("ugh.score >= ?");
    params.push(filters.scoreMin);
  }
  if (typeof filters.scoreMax === "number") {
    where.push("ugh.score <= ?");
    params.push(filters.scoreMax);
  }
  if (filters.dateFrom) {
    where.push("ugh.played_at >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("ugh.played_at <= ?");
    params.push(filters.dateTo);
  }
  if (status === "active") {
    where.push("ugh.excluded_at IS NULL");
  } else if (status === "excluded") {
    where.push("ugh.excluded_at IS NOT NULL");
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM user_game_history ugh
         JOIN users u ON u.id = ugh.user_id
         ${whereSql}`,
    )
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `${ENTRY_SELECT}
       ${whereSql}
       ORDER BY ${sort} ${direction}, ugh.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RawEntryRow[];

  return {
    entries: rows.map(mapEntry),
    total: countRow.total,
    limit,
    offset,
  };
}

/**
 * Soft-exclude a leaderboard entry. Idempotent: re-excluding an already
 * excluded entry updates the reason + admin id but keeps the original
 * `excluded_at` timestamp.
 *
 * @param db - Database instance.
 * @param entryId - `user_game_history` row id.
 * @param actor - Admin performing the action.
 * @param reason - Required free-text reason (used in audit log + UI).
 * @returns The updated entry, or null if not found.
 * @throws If `reason` is empty after trimming.
 */
export function excludeEntry(
  db: DatabaseType,
  entryId: number,
  actor: AdminActor,
  reason: string,
): AdminLeaderboardEntry | null {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error("A reason is required when excluding an entry");
  }
  const existing = db
    .prepare(
      `SELECT ugh.id, ugh.user_id, u.username, ugh.score, ugh.excluded_at, ugh.is_win
         FROM user_game_history ugh
         JOIN users u ON u.id = ugh.user_id
        WHERE ugh.id = ?`,
    )
    .get(entryId) as
    | {
        id: number;
        user_id: string;
        username: string;
        score: number;
        excluded_at: string | null;
        is_win: number | null;
      }
    | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  // Wrap row UPDATE + lifetime_score UPDATE + audit INSERT in a single
  // transaction. Without this, a process kill (or any thrown exception)
  // between the two UPDATEs would leave the row marked excluded but
  // lifetime_score un-decremented; the next exclude call would take the
  // re-exclusion `else` branch and never re-attempt the decrement, so
  // the drift would be unrecoverable through the moderation API.
  //
  // Preserve original timestamp on re-exclusion so the audit story stays
  // monotonic; only flip from null → now. We also decrement
  // users.lifetime_score by the row's score so the cached column stays
  // moderation-aware — the public lifetime board, rank queries, and
  // /api/user/me all read from this column. clamp(>=0) to defend against
  // any historical drift where the cached column is below the row sum.
  db.transaction(() => {
    if (existing.excluded_at === null) {
      db.prepare(
        `UPDATE user_game_history
           SET excluded_at = ?, excluded_by_admin_id = ?, excluded_reason = ?
         WHERE id = ?`,
      ).run(now, actor.id, trimmed, entryId);
      // total_games decremented in the same statement so the cached
      // count tracks the leaderboard query's `excluded_at IS NULL`
      // filter (PR1 perf F2).
      db.prepare(
        `UPDATE users
           SET lifetime_score = MAX(0, lifetime_score - ?),
               total_games = MAX(0, total_games - 1)
         WHERE id = ?`,
      ).run(existing.score, existing.user_id);

      // Compensating decrement on the W/L cache so excluded games drop
      // out of the lifetime W/L counters too. Streak is intentionally
      // NOT rewound (would require replaying every game since the
      // excluded row); minor drift on admin actions is acceptable.
      if (existing.is_win === 1) {
        db.prepare(
          "UPDATE users SET lifetime_wins = MAX(0, lifetime_wins - 1) WHERE id = ?",
        ).run(existing.user_id);
      } else if (existing.is_win === 0) {
        db.prepare(
          "UPDATE users SET lifetime_losses = MAX(0, lifetime_losses - 1) WHERE id = ?",
        ).run(existing.user_id);
      }
    } else {
      db.prepare(
        `UPDATE user_game_history
           SET excluded_by_admin_id = ?, excluded_reason = ?
         WHERE id = ?`,
      ).run(actor.id, trimmed, entryId);
    }

    recordAuditEvent(db, {
      actor,
      action: "exclude_entry",
      targetType: "entry",
      targetId: String(entryId),
      targetLabel: `${existing.username} (${existing.score})`,
      reason: trimmed,
    });
  })();

  return getEntry(db, entryId);
}

/**
 * Reverse a soft-exclude. Idempotent: restoring an already-active entry
 * is a no-op (no audit event is recorded).
 *
 * @param db - Database instance.
 * @param entryId - `user_game_history` row id.
 * @param actor - Admin performing the action.
 * @param reason - Optional explanation written to the audit log.
 * @returns The updated entry, or null if not found.
 */
export function restoreEntry(
  db: DatabaseType,
  entryId: number,
  actor: AdminActor,
  reason?: string,
): AdminLeaderboardEntry | null {
  const existing = db
    .prepare(
      `SELECT ugh.id, ugh.user_id, u.username, ugh.score, ugh.excluded_at, ugh.is_win
         FROM user_game_history ugh
         JOIN users u ON u.id = ugh.user_id
        WHERE ugh.id = ?`,
    )
    .get(entryId) as
    | {
        id: number;
        user_id: string;
        username: string;
        score: number;
        excluded_at: string | null;
        is_win: number | null;
      }
    | undefined;
  if (!existing) return null;
  if (existing.excluded_at === null) {
    // Nothing to do; return current state without polluting the audit log.
    return getEntry(db, entryId);
  }

  // Wrap clear-exclude + lifetime_score increment + audit in one
  // transaction (mirrors the txn in `excludeEntry`) so a crash mid-write
  // can't leave the row active but lifetime_score un-credited.
  db.transaction(() => {
    db.prepare(
      `UPDATE user_game_history
         SET excluded_at = NULL, excluded_by_admin_id = NULL, excluded_reason = NULL
       WHERE id = ?`,
    ).run(entryId);
    // Mirror of the decrement in `excludeEntry` — re-credit the row's
    // score back to the user's cached lifetime_score and bump total_games
    // so both stay in lock-step with the visible board (PR1 perf F2).
    db.prepare(
      `UPDATE users
          SET lifetime_score = lifetime_score + ?,
              total_games = total_games + 1
        WHERE id = ?`,
    ).run(existing.score, existing.user_id);

    // Mirror of the W/L decrement in `excludeEntry` — re-credit the
    // wins/losses counter when the row had a recorded outcome.
    if (existing.is_win === 1) {
      db.prepare(
        "UPDATE users SET lifetime_wins = lifetime_wins + 1 WHERE id = ?",
      ).run(existing.user_id);
    } else if (existing.is_win === 0) {
      db.prepare(
        "UPDATE users SET lifetime_losses = lifetime_losses + 1 WHERE id = ?",
      ).run(existing.user_id);
    }

    recordAuditEvent(db, {
      actor,
      action: "restore_entry",
      targetType: "entry",
      targetId: String(entryId),
      targetLabel: `${existing.username} (${existing.score})`,
      reason: reason && reason.trim().length > 0 ? reason.trim() : null,
    });
  })();

  return getEntry(db, entryId);
}

/**
 * Fetch a single entry by id (admin view, includes excluded rows).
 *
 * @param db - Database instance.
 * @param entryId - `user_game_history` row id.
 * @returns The entry, or null if not found.
 */
export function getEntry(
  db: DatabaseType,
  entryId: number,
): AdminLeaderboardEntry | null {
  const row = db
    .prepare(`${ENTRY_SELECT} WHERE ugh.id = ?`)
    .get(entryId) as RawEntryRow | undefined;
  return row ? mapEntry(row) : null;
}

/**
 * Bulk-exclude entries by id. Returns counts so the UI can confirm partial
 * successes. Each excluded entry gets its own audit event.
 *
 * @param db - Database instance.
 * @param entryIds - `user_game_history` row ids to exclude.
 * @param actor - Admin performing the action.
 * @param reason - Required free-text reason applied to every entry.
 * @returns Counts of rows actually updated vs. not found.
 * @throws If `reason` is empty after trimming.
 */
export function bulkExcludeEntries(
  db: DatabaseType,
  entryIds: number[],
  actor: AdminActor,
  reason: string,
): { excluded: number; notFound: number } {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error("A reason is required when excluding entries");
  }
  let excluded = 0;
  let notFound = 0;
  const txn = db.transaction((ids: number[]) => {
    for (const id of ids) {
      const result = excludeEntry(db, id, actor, trimmed);
      if (result === null) notFound += 1;
      else excluded += 1;
    }
  });
  txn(entryIds);
  return { excluded, notFound };
}

/**
 * Resolve the per-account drilldown payload: ban state, test-flag,
 * aggregate stats, and recent entries (up to 50).
 *
 * @param db - Database instance.
 * @param userId - User id.
 * @returns Summary or null if user not found.
 */
export function getUserSummary(
  db: DatabaseType,
  userId: string,
): AdminLeaderboardUserSummary | null {
  const user = db
    .prepare(
      `SELECT id, username, email, lifetime_score,
              leaderboard_banned_at, leaderboard_banned_until,
              leaderboard_banned_reason, leaderboard_banned_by,
              is_test_account
         FROM users
        WHERE id = ?`,
    )
    .get(userId) as
    | {
        id: string;
        username: string;
        email: string | null;
        lifetime_score: number;
        leaderboard_banned_at: string | null;
        leaderboard_banned_until: string | null;
        leaderboard_banned_reason: string | null;
        leaderboard_banned_by: string | null;
        is_test_account: number;
      }
    | undefined;
  if (!user) return null;

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(MAX(score), 0) AS best,
              SUM(CASE WHEN excluded_at IS NOT NULL THEN 1 ELSE 0 END) AS excluded
         FROM user_game_history
        WHERE user_id = ?`,
    )
    .get(userId) as { total: number; best: number; excluded: number | null };

  const recentRows = db
    .prepare(
      `${ENTRY_SELECT}
       WHERE ugh.user_id = ?
       ORDER BY ugh.played_at DESC, ugh.id DESC
       LIMIT 50`,
    )
    .all(userId) as RawEntryRow[];
  const recentEntries = recentRows.map(mapEntry);

  return {
    userId: user.id,
    username: user.username,
    email: user.email,
    lifetimeScore: user.lifetime_score,
    totalEntries: counts.total,
    excludedEntries: counts.excluded ?? 0,
    bestScore: counts.best,
    banned: user.leaderboard_banned_at !== null,
    bannedAt: user.leaderboard_banned_at,
    bannedUntil: user.leaderboard_banned_until,
    bannedReason: user.leaderboard_banned_reason,
    bannedBy: user.leaderboard_banned_by,
    isTestAccount: user.is_test_account === 1,
    recentEntries,
  };
}

/**
 * Ban a user from the leaderboard. Permanent unless `durationDays` is set.
 *
 * @param db - Database instance.
 * @param userId - User id.
 * @param actor - Admin performing the action.
 * @param opts - Reason (required) and optional duration in days.
 * @returns Updated summary, or null if user not found.
 * @throws If `reason` is empty.
 */
export function banUser(
  db: DatabaseType,
  userId: string,
  actor: AdminActor,
  opts: { reason: string; durationDays?: number },
): AdminLeaderboardUserSummary | null {
  const reason = (opts.reason ?? "").trim();
  if (reason.length === 0) {
    throw new Error("A reason is required when banning a user");
  }
  const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(userId) as
    | { id: string; username: string }
    | undefined;
  if (!user) return null;

  const now = new Date().toISOString();
  let until: string | null = null;
  if (typeof opts.durationDays === "number" && opts.durationDays > 0) {
    until = new Date(Date.now() + opts.durationDays * 24 * 60 * 60 * 1000).toISOString();
  }

  db.prepare(
    `UPDATE users
        SET leaderboard_banned_at = ?,
            leaderboard_banned_until = ?,
            leaderboard_banned_reason = ?,
            leaderboard_banned_by = ?
      WHERE id = ?`,
  ).run(now, until, reason, actor.id, userId);

  recordAuditEvent(db, {
    actor,
    action: "ban_user",
    targetType: "user",
    targetId: userId,
    targetLabel: user.username,
    reason,
    details: until ? { until } : null,
  });

  return getUserSummary(db, userId);
}

/**
 * Ban a user AND exclude every game-history row they own in one shot.
 *
 * The default `banUser` action hides a user from public boards going
 * forward but leaves their individual entry rows untouched. This action
 * also marks each row excluded with the same reason, so the moderation
 * state is visible row-by-row in the admin panel and the audit log
 * captures one event per affected entry.
 *
 * Runs in a single transaction so partial failures don't leave a half-
 * banned user with partially-excluded history.
 *
 * @param db - Database instance.
 * @param userId - User id.
 * @param actor - Admin performing the action.
 * @param opts - Reason (required) and optional duration in days.
 * @returns Updated summary, or null if user not found.
 * @throws If `reason` is empty.
 */
export function banUserHistory(
  db: DatabaseType,
  userId: string,
  actor: AdminActor,
  opts: { reason: string; durationDays?: number },
): AdminLeaderboardUserSummary | null {
  const reason = (opts.reason ?? "").trim();
  if (reason.length === 0) {
    throw new Error("A reason is required when banning a user's history");
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: string }
    | undefined;
  if (!user) return null;

  const txn = db.transaction(() => {
    banUser(db, userId, actor, { reason, durationDays: opts.durationDays });
    // Skip already-excluded rows so repeat invocations of ban-history (or
    // a ban-history that follows row-level exclusions) don't pollute the
    // audit log with redundant `exclude_entry` events and don't overwrite
    // the prior moderation reason on those rows.
    const entryIds = db
      .prepare(
        "SELECT id FROM user_game_history WHERE user_id = ? AND excluded_at IS NULL",
      )
      .all(userId) as Array<{ id: number }>;
    for (const row of entryIds) {
      excludeEntry(db, row.id, actor, reason);
    }
  });
  txn();

  return getUserSummary(db, userId);
}

/**
 * Lift a leaderboard ban from a user. No-op (and no audit event) if the
 * user wasn't banned.
 *
 * @param db - Database instance.
 * @param userId - User id.
 * @param actor - Admin performing the action.
 * @param reason - Optional rationale for the audit log.
 * @returns Updated summary, or null if user not found.
 */
export function unbanUser(
  db: DatabaseType,
  userId: string,
  actor: AdminActor,
  reason?: string,
): AdminLeaderboardUserSummary | null {
  const user = db
    .prepare("SELECT id, username, leaderboard_banned_at FROM users WHERE id = ?")
    .get(userId) as
    | { id: string; username: string; leaderboard_banned_at: string | null }
    | undefined;
  if (!user) return null;
  if (user.leaderboard_banned_at === null) {
    return getUserSummary(db, userId);
  }

  db.prepare(
    `UPDATE users
        SET leaderboard_banned_at = NULL,
            leaderboard_banned_until = NULL,
            leaderboard_banned_reason = NULL,
            leaderboard_banned_by = NULL
      WHERE id = ?`,
  ).run(userId);

  recordAuditEvent(db, {
    actor,
    action: "unban_user",
    targetType: "user",
    targetId: userId,
    targetLabel: user.username,
    reason: reason && reason.trim().length > 0 ? reason.trim() : null,
  });

  return getUserSummary(db, userId);
}

/**
 * Toggle the `is_test_account` flag on a user. Test accounts are
 * permanently hidden from public leaderboards but treated separately
 * from punitive bans (different UI, different rationale).
 *
 * @param db - Database instance.
 * @param userId - User id.
 * @param isTest - New flag value.
 * @param actor - Admin performing the action.
 * @returns Updated summary, or null if user not found.
 */
export function setTestAccountFlag(
  db: DatabaseType,
  userId: string,
  isTest: boolean,
  actor: AdminActor,
): AdminLeaderboardUserSummary | null {
  const user = db
    .prepare("SELECT id, username, is_test_account FROM users WHERE id = ?")
    .get(userId) as
    | { id: string; username: string; is_test_account: number }
    | undefined;
  if (!user) return null;
  const desired = isTest ? 1 : 0;
  if (user.is_test_account === desired) {
    return getUserSummary(db, userId);
  }
  db.prepare("UPDATE users SET is_test_account = ? WHERE id = ?").run(desired, userId);
  recordAuditEvent(db, {
    actor,
    action: "set_test_flag",
    targetType: "user",
    targetId: userId,
    targetLabel: user.username,
    details: { isTest },
  });
  return getUserSummary(db, userId);
}

/**
 * List currently-banned users (paginated).
 *
 * @param db - Database instance.
 * @param opts - Pagination params.
 * @returns Array of user summaries (recentEntries omitted to keep payload small).
 */
export function listBannedUsers(
  db: DatabaseType,
  opts: { limit?: number; offset?: number } = {},
): { users: Omit<AdminLeaderboardUserSummary, "recentEntries">[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS total FROM users
        WHERE leaderboard_banned_at IS NOT NULL`,
    )
    .get() as { total: number };

  // Single query that LEFT JOINs the per-user stat rollup so we don't
  // fire N+1 follow-ups (one stat query per banned user). The aggregate
  // subquery has its own GROUP BY so the join stays cheap even when a
  // user has many history rows.
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.lifetime_score,
              u.leaderboard_banned_at, u.leaderboard_banned_until,
              u.leaderboard_banned_reason, u.leaderboard_banned_by,
              u.is_test_account,
              COALESCE(s.total, 0) AS total_entries,
              COALESCE(s.best, 0) AS best_score,
              COALESCE(s.excluded, 0) AS excluded_entries
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) AS total,
                  MAX(score) AS best,
                  SUM(CASE WHEN excluded_at IS NOT NULL THEN 1 ELSE 0 END) AS excluded
             FROM user_game_history
            GROUP BY user_id
         ) s ON s.user_id = u.id
        WHERE u.leaderboard_banned_at IS NOT NULL
        ORDER BY u.leaderboard_banned_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as {
      id: string;
      username: string;
      email: string | null;
      lifetime_score: number;
      leaderboard_banned_at: string | null;
      leaderboard_banned_until: string | null;
      leaderboard_banned_reason: string | null;
      leaderboard_banned_by: string | null;
      is_test_account: number;
      total_entries: number;
      best_score: number;
      excluded_entries: number;
    }[];

  const users = rows.map((row) => ({
    userId: row.id,
    username: row.username,
    email: row.email,
    lifetimeScore: row.lifetime_score,
    totalEntries: row.total_entries,
    excludedEntries: row.excluded_entries,
    bestScore: row.best_score,
    banned: true,
    bannedAt: row.leaderboard_banned_at,
    bannedUntil: row.leaderboard_banned_until,
    bannedReason: row.leaderboard_banned_reason,
    bannedBy: row.leaderboard_banned_by,
    isTestAccount: row.is_test_account === 1,
  }));

  return { users, total: totalRow.total };
}

/**
 * Read the moderation audit log (newest-first, paginated).
 *
 * @param db - Database instance.
 * @param opts - Pagination + optional action / target filters.
 * @returns Audit entries with parsed `details_json`.
 */
export function listAuditLog(
  db: DatabaseType,
  opts: {
    limit?: number;
    offset?: number;
    action?: string;
    targetType?: "entry" | "user";
    targetId?: string;
  } = {},
): { entries: AdminLeaderboardAuditEntry[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  if (opts.targetType) {
    where.push("target_type = ?");
    params.push(opts.targetType);
  }
  if (opts.targetId) {
    where.push("target_id = ?");
    params.push(opts.targetId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM admin_leaderboard_audit ${whereSql}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `SELECT id, admin_user_id, admin_username, action, target_type, target_id,
              target_label, reason, details_json, created_at
         FROM admin_leaderboard_audit
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
      id: number;
      admin_user_id: string;
      admin_username: string;
      action: string;
      target_type: string;
      target_id: string;
      target_label: string | null;
      reason: string | null;
      details_json: string | null;
      created_at: string;
    }[];

  const entries: AdminLeaderboardAuditEntry[] = rows.map((row) => {
    let details: Record<string, unknown> | null = null;
    if (row.details_json) {
      try {
        details = JSON.parse(row.details_json) as Record<string, unknown>;
      } catch {
        details = null;
      }
    }
    return {
      id: row.id,
      adminUserId: row.admin_user_id,
      adminUsername: row.admin_username,
      action: row.action,
      targetType: row.target_type as "entry" | "user",
      targetId: row.target_id,
      targetLabel: row.target_label,
      reason: row.reason,
      details,
      createdAt: row.created_at,
    };
  });

  return { entries, total: totalRow.total };
}

/**
 * Aggregate counts for the admin panel header strip.
 *
 * @param db - Database instance.
 * @returns Total/excluded entry counts and banned/test user counts.
 */
export function getStats(db: DatabaseType): AdminLeaderboardStats {
  const lb = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN excluded_at IS NOT NULL THEN 1 ELSE 0 END) AS excluded
         FROM user_game_history`,
    )
    .get() as { total: number; excluded: number | null };
  const users = db
    .prepare(
      `SELECT
         SUM(CASE WHEN leaderboard_banned_at IS NOT NULL THEN 1 ELSE 0 END) AS banned,
         SUM(CASE WHEN is_test_account = 1 THEN 1 ELSE 0 END) AS testAccounts
       FROM users`,
    )
    .get() as { banned: number | null; testAccounts: number | null };
  return {
    totalEntries: lb.total,
    excludedEntries: lb.excluded ?? 0,
    bannedUsers: users.banned ?? 0,
    testAccounts: users.testAccounts ?? 0,
  };
}
