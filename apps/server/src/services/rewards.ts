/**
 * Rewards service — business logic for the admin reward pool and award system.
 *
 * Manages Amazon gift card rewards: adding to the pool, manual awarding,
 * random-roll awarding based on player qualification criteria, and
 * user-facing reward retrieval.
 */

import { randomUUID, randomInt, randomBytes } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { config } from "../config";
import {
  sendRewardAwardedEmail,
  sendClaimReminderEmail,
  sendRewardExpiredEmail,
  buildGiveawayLossEmail,
} from "./email";
import { sendMarketingEmail, getEmailPreferences, getTriggerConfig } from "./emailNotification";
import type {
  Reward,
  RewardAwardSummary,
  RewardStatus,
  RewardAwardMethod,
  RandomRollCriteria,
  QualifyingPlayer,
  UserReward,
} from "@price-game/shared";

// === Row types from SQLite ===

interface RewardRow {
  id: string;
  reward_type: string;
  amount_cents: number;
  code: string;
  description: string | null;
  status: string;
  created_at: string;
  created_by: string;
}

interface AwardRow {
  id: string;
  reward_id: string;
  user_id: string;
  username: string;
  award_method: string;
  award_criteria: string | null;
  awarded_at: string;
  awarded_by: string;
  claimed_at: string | null;
  claim_token: string;
  claim_expires_at: string;
  voided_at: string | null;
  pending_review_at: string | null;
}

interface CountRow {
  count: number;
}

interface QualifyingPlayerRow {
  id: string;
  username: string;
  email: string;
  points: number;
  games_played: number;
  streak: number;
}

// === Mapping helpers ===

function mapRewardRow(row: RewardRow, award?: AwardRow | null): Reward {
  return {
    id: row.id,
    rewardType: row.reward_type,
    amountCents: row.amount_cents,
    code: row.code,
    description: row.description,
    status: row.status as RewardStatus,
    createdAt: row.created_at,
    createdBy: row.created_by,
    award: award
      ? {
          id: award.id,
          userId: award.user_id,
          username: award.username,
          awardMethod: award.award_method as RewardAwardMethod,
          awardCriteria: award.award_criteria,
          awardedAt: award.awarded_at,
          awardedBy: award.awarded_by,
          claimedAt: award.claimed_at,
          claimExpiresAt: award.claim_expires_at,
          voidedAt: award.voided_at,
          pendingReviewAt: award.pending_review_at,
        }
      : null,
  };
}

function mapQualifyingPlayer(row: QualifyingPlayerRow): QualifyingPlayer {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    points: row.points,
    gamesPlayed: row.games_played,
    streak: row.streak,
  };
}

// === Claim window ===

/** Days a winner has to claim a reward before it returns to the pool. */
export const CLAIM_WINDOW_DAYS = 30;
const CLAIM_WINDOW_MS = CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Generate an unguessable per-award claim token for the email link.
 * 32 bytes of crypto randomness — 64 hex chars, plenty against brute-force.
 */
function generateClaimToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Build the claim URL for a given token.
 * Used in transactional reward emails so the user can deep-link from
 * their inbox straight into the claim flow.
 */
function buildClaimUrl(token: string): string {
  return `${config.appUrl}/claim/${token}`;
}

// === Validation ===

const MAX_CODE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_AMOUNT_CENTS = 100_000_00; // $100,000
const VALID_REWARD_TYPES = new Set(["amazon_gift_card"]);

/**
 * Validate a reward creation request.
 *
 * @param data - The request body fields.
 * @throws Error if validation fails.
 */
function validateRewardCreate(data: {
  rewardType?: string;
  amountCents?: number;
  code?: string;
  description?: string;
}): void {
  if (data.rewardType && !VALID_REWARD_TYPES.has(data.rewardType)) {
    throw new Error("Invalid reward type");
  }
  if (!data.code || typeof data.code !== "string" || data.code.trim().length === 0) {
    throw new Error("Gift card code is required");
  }
  if (data.code.length > MAX_CODE_LENGTH) {
    throw new Error(`Code exceeds maximum length of ${MAX_CODE_LENGTH} characters`);
  }
  if (typeof data.amountCents !== "number" || !Number.isInteger(data.amountCents) || data.amountCents <= 0) {
    throw new Error("Amount must be a positive integer (in cents)");
  }
  if (data.amountCents > MAX_AMOUNT_CENTS) {
    throw new Error("Amount exceeds maximum allowed value");
  }
  if (data.description && data.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`);
  }
}

// === Service functions ===

/**
 * Add a new reward to the pool.
 *
 * @param db - Database instance.
 * @param data - Reward data (type, amount, code, description).
 * @param adminId - ID of the admin creating the reward.
 * @returns The created reward.
 * @throws Error on validation failure or duplicate code.
 */
export function addReward(
  db: DatabaseType,
  data: { rewardType?: string; amountCents: number; code: string; description?: string },
  adminId: string
): Reward {
  validateRewardCreate(data);

  const id = randomUUID();
  const now = new Date().toISOString();
  const rewardType = data.rewardType || "amazon_gift_card";

  try {
    db.prepare(
      `INSERT INTO reward_pool (id, reward_type, amount_cents, code, description, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'available', ?, ?)`
    ).run(id, rewardType, data.amountCents, data.code.trim(), data.description?.trim() || null, now, adminId);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new Error("A reward with this code already exists");
    }
    throw err;
  }

  return {
    id,
    rewardType,
    amountCents: data.amountCents,
    code: data.code.trim(),
    description: data.description?.trim() || null,
    status: "available",
    createdAt: now,
    createdBy: adminId,
    award: null,
  };
}

/**
 * List rewards with pagination and optional status filter.
 *
 * @param db - Database instance.
 * @param params - Pagination and filter parameters.
 * @returns Paginated reward list with award summaries.
 */
export function listRewards(
  db: DatabaseType,
  params: { page?: number; pageSize?: number; status?: string }
): { rewards: Reward[]; total: number; page: number; pageSize: number; totalPages: number } {
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 25));
  const offset = (page - 1) * pageSize;

  const statusFilter = params.status && params.status !== "all" ? params.status : null;

  const whereClause = statusFilter ? "WHERE rp.status = ?" : "";
  const countParams = statusFilter ? [statusFilter] : [];

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM reward_pool rp ${whereClause}`)
    .get(...countParams) as CountRow;
  const total = totalRow.count;

  const queryParams = statusFilter
    ? [statusFilter, pageSize, offset]
    : [pageSize, offset];

  const rows = db
    .prepare(
      `SELECT rp.* FROM reward_pool rp
       ${whereClause}
       ORDER BY rp.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...queryParams) as RewardRow[];

  // Batch-fetch awards for all returned rewards
  const rewardIds = rows.map((r) => r.id);
  const awards = new Map<string, AwardRow>();

  if (rewardIds.length > 0) {
    const placeholders = rewardIds.map(() => "?").join(",");
    const awardRows = db
      .prepare(
        `SELECT ra.*, u.username
         FROM reward_awards ra
         JOIN users u ON u.id = ra.user_id
         WHERE ra.reward_id IN (${placeholders})
           AND ra.voided_at IS NULL`
      )
      .all(...rewardIds) as AwardRow[];

    for (const ar of awardRows) {
      awards.set(ar.reward_id, ar);
    }
  }

  const rewards = rows.map((row) => mapRewardRow(row, awards.get(row.id) || null));

  return {
    rewards,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Get a single reward by ID with its award details.
 *
 * @param db - Database instance.
 * @param rewardId - The reward ID.
 * @returns The reward, or null if not found.
 */
export function getReward(db: DatabaseType, rewardId: string): Reward | null {
  const row = db.prepare("SELECT * FROM reward_pool WHERE id = ?").get(rewardId) as RewardRow | undefined;
  if (!row) return null;

  const award = db
    .prepare(
      `SELECT ra.*, u.username
       FROM reward_awards ra
       JOIN users u ON u.id = ra.user_id
       WHERE ra.reward_id = ?
         AND ra.voided_at IS NULL`
    )
    .get(rewardId) as AwardRow | undefined;

  return mapRewardRow(row, award || null);
}

/**
 * Delete an available (unawarded) reward from the pool.
 *
 * @param db - Database instance.
 * @param rewardId - The reward ID to delete.
 * @returns True if deleted, false if not found or already awarded.
 */
export function deleteReward(db: DatabaseType, rewardId: string): boolean {
  const result = db
    .prepare("DELETE FROM reward_pool WHERE id = ? AND status = 'available'")
    .run(rewardId);
  return result.changes > 0;
}

/**
 * Manually award a reward to a specific user.
 *
 * @param db - Database instance.
 * @param rewardId - The reward to award.
 * @param userId - The user to receive the reward.
 * @param adminId - The admin performing the award.
 * @returns The updated reward.
 * @throws Error if reward is not available or user not found.
 */
export function awardRewardToUser(
  db: DatabaseType,
  rewardId: string,
  userId: string,
  adminId: string
): Reward {
  return db.transaction(() => {
    const reward = db
      .prepare("SELECT * FROM reward_pool WHERE id = ?")
      .get(rewardId) as RewardRow | undefined;

    if (!reward) {
      throw new Error("Reward not found");
    }
    if (reward.status !== "available") {
      throw new Error("Reward is not available");
    }

    const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(userId) as
      | { id: string; username: string }
      | undefined;

    if (!user) {
      throw new Error("User not found");
    }

    const awardId = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const claimToken = generateClaimToken();
    const claimExpiresAt = new Date(nowDate.getTime() + CLAIM_WINDOW_MS).toISOString();

    db.prepare(
      `INSERT INTO reward_awards
        (id, reward_id, user_id, award_method, award_criteria,
         awarded_at, awarded_by,
         claim_token, claim_expires_at)
       VALUES (?, ?, ?, 'manual', NULL, ?, ?, ?, ?)`
    ).run(awardId, rewardId, userId, now, adminId, claimToken, claimExpiresAt);

    db.prepare("UPDATE reward_pool SET status = 'awarded' WHERE id = ?").run(rewardId);

    // Send reward notification email (fire-and-forget)
    const userRow = db.prepare("SELECT email, username FROM users WHERE id = ?").get(userId) as
      | { email: string; username: string }
      | undefined;
    if (userRow) {
      sendRewardAwardedEmail(
        userRow.email,
        userRow.username,
        reward.amount_cents,
        reward.reward_type,
        buildClaimUrl(claimToken),
        claimExpiresAt,
      ).catch((err) => {
        console.error("[reward] Failed to send award notification:", err);
      });
    }

    return getReward(db, rewardId)!;
  })();
}

/**
 * Build the date range for a qualification period. Returns the inclusive
 * `start` and exclusive `end` ISO timestamps; either may be null to
 * represent "no lower / no upper bound".
 *
 * @param criteria - Caller's criteria (only `period` and `month` are read).
 * @returns Half-open interval [start, end) — both null for all_time.
 */
function getPeriodRange(
  criteria: RandomRollCriteria,
): { start: string | null; end: string | null } {
  const now = new Date();
  switch (criteria.period) {
    case "last_week": {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { start: d.toISOString(), end: null };
    }
    case "last_month": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return { start: d.toISOString(), end: null };
    }
    case "last_3_months": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return { start: d.toISOString(), end: null };
    }
    case "calendar_month": {
      // Use UTC month boundaries so the same criteria scopes to the same
      // game-history rows regardless of where the admin happens to be.
      // `played_at` timestamps are stored as ISO UTC.
      const m = criteria.month;
      if (!m || !Number.isInteger(m.year) || !Number.isInteger(m.monthIndex)) {
        throw new Error("criteria.month is required for period=calendar_month");
      }
      if (m.monthIndex < 0 || m.monthIndex > 11) {
        throw new Error("criteria.month.monthIndex must be 0..11");
      }
      const start = new Date(Date.UTC(m.year, m.monthIndex, 1));
      const end = new Date(Date.UTC(m.year, m.monthIndex + 1, 1));
      return { start: start.toISOString(), end: end.toISOString() };
    }
    case "all_time":
      return { start: null, end: null };
  }
}

/**
 * SQL fragment that computes a user's effective current streak, applying
 * the same read-time decay rule as `getStreakForUser` in dailyStreak.ts:
 * if the user's last completion predates `yesterday`, the current streak
 * is treated as 0. Requires a bind parameter for yesterday (YYYY-MM-DD).
 */
const EFFECTIVE_STREAK_SQL =
  "CASE WHEN u.daily_streak_last_date IS NOT NULL AND u.daily_streak_last_date >= ? " +
  "THEN u.daily_streak_current ELSE 0 END";

/**
 * Compute the "yesterday" date string (YYYY-MM-DD UTC) used by the streak
 * decay predicate. Accepts an optional `today` override for testing.
 *
 * @param today - Optional ISO date string (YYYY-MM-DD) representing "today".
 * @returns Yesterday's date string in YYYY-MM-DD UTC.
 */
function getYesterdayString(today?: string): string {
  const base = today ? new Date(`${today}T00:00:00Z`) : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  return base.toISOString().slice(0, 10);
}

/**
 * Get qualifying players based on criteria.
 *
 * Supports four qualification modes (see {@link RandomRollCriteria.mode}):
 * points_only (default, legacy behavior), streak_only, points_and_streak,
 * and points_or_streak. The streak path uses each user's current daily
 * streak with read-time decay — stale streaks (last completion older than
 * yesterday) are treated as 0, matching `getStreakForUser`.
 *
 * @param db - Database instance.
 * @param criteria - Qualification criteria. `mode` and `minStreak` are optional;
 *   omitting them yields legacy points-only behavior.
 * @param today - Optional YYYY-MM-DD UTC override for the decay check. Exposed
 *   so tests can freeze "today" without touching timers.
 * @returns Qualifying players sorted by points descending.
 */
export function getQualifyingPlayers(
  db: DatabaseType,
  criteria: RandomRollCriteria,
  today?: string,
): QualifyingPlayer[] {
  const mode = criteria.mode ?? "points_only";
  const minStreak = criteria.minStreak ?? 0;
  const yesterday = getYesterdayString(today);

  // Compose the streak and points predicates separately, then join by the mode.
  const streakPredicate = `${EFFECTIVE_STREAK_SQL} >= ?`;

  // In streak_only mode the preview is more useful ranked by streak — the
  // points column would otherwise sort by a value that wasn't gating
  // qualification. Other modes still rank by the points metric the admin picked.
  const orderByClause = mode === "streak_only" ? "streak DESC, points DESC" : "points DESC";

  // Default to excluding test accounts so admins don't have to remember to
  // de-select internal users every time. The override is opt-in.
  const excludeTestAccounts = criteria.excludeTestAccounts ?? true;
  const userWhereClauses: string[] = ["u.is_active = 1"];
  const userWhereParams: unknown[] = [];
  if (excludeTestAccounts) {
    userWhereClauses.push("u.is_test_account = 0");
  }
  const excludedUserIds = (criteria.excludedUserIds ?? []).filter((id) => typeof id === "string");
  if (excludedUserIds.length > 0) {
    const placeholders = excludedUserIds.map(() => "?").join(",");
    userWhereClauses.push(`u.id NOT IN (${placeholders})`);
    userWhereParams.push(...excludedUserIds);
  }
  const userWhereClause = userWhereClauses.join(" AND ");

  // === Lifetime-points path =====================================================
  if (criteria.useLifetimePoints) {
    const pointsPredicate = "u.lifetime_score >= ?";
    const { havingClause, params } = composeHavingClause({
      mode,
      pointsPredicate,
      streakPredicate,
      yesterday,
      minPoints: criteria.minPoints,
      minStreak,
    });

    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.email,
                u.lifetime_score as points,
                COUNT(ugh.id) as games_played,
                ${EFFECTIVE_STREAK_SQL} as streak
         FROM users u
         LEFT JOIN user_game_history ugh ON ugh.user_id = u.id
         WHERE ${userWhereClause}
         GROUP BY u.id
         HAVING ${havingClause}
         ORDER BY ${orderByClause}`
      )
      .all(yesterday, ...userWhereParams, ...params) as QualifyingPlayerRow[];
    return rows.map(mapQualifyingPlayer);
  }

  // === Period-based points path =================================================
  const range = getPeriodRange(criteria);

  // Build the ugh JOIN with a half-open interval [start, end) so a calendar
  // month draw (April) doesn't accidentally include May 1st 00:00 plays.
  const joinPredicates: string[] = [];
  const joinParams: unknown[] = [];
  if (range.start !== null) {
    joinPredicates.push("ugh.played_at >= ?");
    joinParams.push(range.start);
  }
  if (range.end !== null) {
    joinPredicates.push("ugh.played_at < ?");
    joinParams.push(range.end);
  }
  const joinClause =
    joinPredicates.length > 0
      ? `LEFT JOIN user_game_history ugh ON ugh.user_id = u.id AND ${joinPredicates.join(" AND ")}`
      : "LEFT JOIN user_game_history ugh ON ugh.user_id = u.id";

  const pointsPredicate = "COALESCE(SUM(ugh.score), 0) >= ?";
  const { havingClause, params } = composeHavingClause({
    mode,
    pointsPredicate,
    streakPredicate,
    yesterday,
    minPoints: criteria.minPoints,
    minStreak,
  });

  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.email,
              COALESCE(SUM(ugh.score), 0) as points,
              COUNT(ugh.id) as games_played,
              ${EFFECTIVE_STREAK_SQL} as streak
       FROM users u
       ${joinClause}
       WHERE ${userWhereClause}
       GROUP BY u.id
       HAVING ${havingClause}
       ORDER BY ${orderByClause}`
    )
    .all(yesterday, ...joinParams, ...userWhereParams, ...params) as QualifyingPlayerRow[];

  return rows.map(mapQualifyingPlayer);
}

/**
 * Build the HAVING clause + ordered bind params for a given qualification mode.
 *
 * The streak predicate already references a positional `?` for `yesterday`, so
 * we pass it through in the returned `params` when streak is part of the mode.
 *
 * @returns The HAVING clause string and the params to bind after the caller's
 *   pre-bound `yesterday` value (and any JOIN cutoff).
 */
function composeHavingClause(opts: {
  mode: "points_only" | "streak_only" | "points_and_streak" | "points_or_streak";
  pointsPredicate: string;
  streakPredicate: string;
  yesterday: string;
  minPoints: number;
  minStreak: number;
}): { havingClause: string; params: unknown[] } {
  const { mode, pointsPredicate, streakPredicate, yesterday, minPoints, minStreak } = opts;
  switch (mode) {
    case "points_only":
      return { havingClause: pointsPredicate, params: [minPoints] };
    case "streak_only":
      return { havingClause: streakPredicate, params: [yesterday, minStreak] };
    case "points_and_streak":
      return {
        havingClause: `(${pointsPredicate}) AND (${streakPredicate})`,
        params: [minPoints, yesterday, minStreak],
      };
    case "points_or_streak":
      return {
        havingClause: `(${pointsPredicate}) OR (${streakPredicate})`,
        params: [minPoints, yesterday, minStreak],
      };
  }
}

/**
 * Two-phase random roll — phase 1: pick a candidate winner and write a
 * pending-review award row. **Sends no notification emails.** The admin
 * must follow up with `confirmPendingAward` (which sends emails and
 * starts the claim window) or `discardPendingAward` (which removes the
 * pending row and frees the reward for re-rolling).
 *
 * The qualifying-pool snapshot (user IDs) is recorded in
 * `award_criteria` JSON so the consolation batch at confirm time uses the
 * same pool the admin reviewed, even if users qualify or de-qualify in
 * the interim.
 *
 * @param db - Database instance.
 * @param rewardId - The reward to award.
 * @param criteria - Qualification criteria for the player pool.
 * @param adminId - The admin running the roll.
 * @returns The candidate winner and supporting context for the review UI.
 * @throws Error if reward unavailable or no qualifying players.
 */
export function previewRandomRoll(
  db: DatabaseType,
  rewardId: string,
  criteria: RandomRollCriteria,
  adminId: string,
): {
  candidateAward: { id: string; userId: string; username: string; email: string };
  reward: Reward;
  totalQualifying: number;
  nonWinners: QualifyingPlayer[];
} {
  return db.transaction(() => {
    const reward = db
      .prepare("SELECT * FROM reward_pool WHERE id = ?")
      .get(rewardId) as RewardRow | undefined;

    if (!reward) {
      throw new Error("Reward not found");
    }
    if (reward.status !== "available") {
      throw new Error("Reward is not available");
    }

    const qualifyingPlayers = getQualifyingPlayers(db, criteria);

    if (qualifyingPlayers.length === 0) {
      throw new Error("No qualifying players found");
    }

    // Weighted random selection: each credited referral = 1 extra entry.
    const playerIds = qualifyingPlayers.map((p) => p.id);
    const placeholders = playerIds.map(() => "?").join(",");
    const referralCounts = new Map<string, number>();
    if (playerIds.length > 0) {
      const rows = db
        .prepare(
          `SELECT referrer_id, COUNT(*) as count FROM referrals
           WHERE referrer_id IN (${placeholders}) AND status = 'credited'
           GROUP BY referrer_id`,
        )
        .all(...playerIds) as { referrer_id: string; count: number }[];
      for (const row of rows) {
        referralCounts.set(row.referrer_id, row.count);
      }
    }
    const weights = qualifyingPlayers.map((p) => 1 + (referralCounts.get(p.id) ?? 0));
    const totalEntries = weights.reduce((sum, w) => sum + w, 0);
    const roll = randomInt(0, totalEntries);

    let cumulative = 0;
    let winnerIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i];
      if (roll < cumulative) {
        winnerIndex = i;
        break;
      }
    }
    const winner = qualifyingPlayers[winnerIndex];
    const winnerReferralBonus = weights[winnerIndex] - 1;

    const awardId = randomUUID();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const claimToken = generateClaimToken();
    // Placeholder deadline; the real claim window is restamped at confirm
    // time so the user always gets the full 30 days from the moment the
    // email is sent.
    const claimExpiresAt = new Date(nowDate.getTime() + CLAIM_WINDOW_MS).toISOString();
    // Snapshot the qualifying-pool user IDs so the consolation batch at
    // confirm time matches what the admin reviewed (a user could lose or
    // gain qualification between preview and confirm). For the "all_time"
    // criterion at large scale this can balloon — at ~100k qualifying
    // users this would be ~3.5 MB of JSON. Practical caps come from the
    // admin's choice of period and minPoints; any unbounded use should
    // graduate to a side-table snapshot before this PR's assumption breaks.
    const criteriaJson = JSON.stringify({
      ...criteria,
      totalEntries,
      winnerReferralBonus,
      qualifyingUserIds: playerIds,
    });

    db.prepare(
      `INSERT INTO reward_awards
        (id, reward_id, user_id, award_method, award_criteria,
         awarded_at, awarded_by,
         claim_token, claim_expires_at,
         pending_review_at)
       VALUES (?, ?, ?, 'random_roll', ?, ?, ?, ?, ?, ?)`
    ).run(
      awardId, rewardId, winner.id, criteriaJson,
      now, adminId, claimToken, claimExpiresAt, now,
    );

    db.prepare("UPDATE reward_pool SET status = 'awarded' WHERE id = ?").run(rewardId);

    const updatedReward = getReward(db, rewardId)!;
    const nonWinners = qualifyingPlayers.filter(
      (p) => p.id !== winner.id && !!p.email,
    );

    return {
      candidateAward: {
        id: awardId,
        userId: winner.id,
        username: winner.username,
        email: winner.email,
      },
      reward: updatedReward,
      totalQualifying: qualifyingPlayers.length,
      nonWinners,
    };
  })();
}

/**
 * Two-phase random roll — phase 2: confirm a pending-review award. Sends
 * the winner notification, fires the consolation batch for non-winners,
 * and resets the claim window so the user gets the full 30 days from
 * confirmation (not from the original preview).
 *
 * @param db - Database instance.
 * @param awardId - The id returned by `previewRandomRoll.candidateAward.id`.
 * @param adminId - The admin confirming.
 * @returns The updated reward.
 * @throws Error if the award is not in pending-review state.
 */
export function confirmPendingAward(
  db: DatabaseType,
  awardId: string,
  adminId: string,
): Reward {
  type ConfirmRow = {
    id: string;
    reward_id: string;
    user_id: string;
    pending_review_at: string | null;
    voided_at: string | null;
    claimed_at: string | null;
    award_criteria: string | null;
    claim_token: string;
    amount_cents: number;
    reward_type: string;
    email: string;
    username: string;
    period: string;
  };

  const ctx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ra.id, ra.reward_id, ra.user_id, ra.pending_review_at,
                ra.voided_at, ra.claimed_at, ra.award_criteria, ra.claim_token,
                rp.amount_cents, rp.reward_type,
                u.email, u.username
         FROM reward_awards ra
         JOIN reward_pool rp ON rp.id = ra.reward_id
         JOIN users u ON u.id = ra.user_id
         WHERE ra.id = ?`
      )
      .get(awardId) as ConfirmRow | undefined;

    if (!row) throw new Error("Award not found");
    if (row.voided_at !== null || row.claimed_at !== null) {
      throw new Error("Award is not pending review");
    }
    if (row.pending_review_at === null) {
      throw new Error("Award is not pending review");
    }

    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const newExpires = new Date(nowDate.getTime() + CLAIM_WINDOW_MS).toISOString();
    db.prepare(
      `UPDATE reward_awards
       SET pending_review_at = NULL,
           awarded_at = ?,
           awarded_by = ?,
           claim_expires_at = ?
       WHERE id = ?`
    ).run(nowIso, adminId, newExpires, awardId);

    const criteriaParsed = row.award_criteria ? JSON.parse(row.award_criteria) : {};
    const qualifyingUserIds: string[] = Array.isArray(criteriaParsed.qualifyingUserIds)
      ? criteriaParsed.qualifyingUserIds
      : [];
    const period: RandomRollCriteria["period"] = criteriaParsed.period ?? "all_time";
    // For calendar_month draws, lift the month label so the consolation
    // copy reads "April 2026's giveaway" instead of "the latest".
    let monthLabel: string | undefined;
    if (period === "calendar_month" && criteriaParsed.month) {
      const m = criteriaParsed.month as { year?: number; monthIndex?: number };
      if (Number.isInteger(m.year) && Number.isInteger(m.monthIndex)) {
        const monthName = new Date(Date.UTC(m.year!, m.monthIndex!, 1))
          .toLocaleString("en-US", { month: "long", timeZone: "UTC" });
        monthLabel = `${monthName} ${m.year}`;
      }
    }

    return {
      reward_id: row.reward_id,
      winnerEmail: row.email,
      winnerUsername: row.username,
      amountCents: row.amount_cents,
      rewardType: row.reward_type,
      claimUrl: buildClaimUrl(row.claim_token),
      claimExpiresAt: newExpires,
      qualifyingUserIds,
      winnerUserId: row.user_id,
      period,
      monthLabel,
    };
  })();

  // Winner notification (fire-and-forget — DB state is the source of
  // truth; a Resend hiccup cannot un-confirm the award).
  sendRewardAwardedEmail(
    ctx.winnerEmail,
    ctx.winnerUsername,
    ctx.amountCents,
    ctx.rewardType,
    ctx.claimUrl,
    ctx.claimExpiresAt,
  ).catch((err) => {
    console.error("[reward] Failed to send winner email on confirm:", err);
  });

  // Consolation batch — re-resolve the snapshot to QualifyingPlayer rows.
  if (ctx.qualifyingUserIds.length > 0) {
    const losers = ctx.qualifyingUserIds.filter((id) => id !== ctx.winnerUserId);
    if (losers.length > 0) {
      const placeholders = losers.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, username, email, lifetime_score as points,
                  0 as games_played, 0 as streak
           FROM users WHERE id IN (${placeholders}) AND email IS NOT NULL`
        )
        .all(...losers) as QualifyingPlayerRow[];
      const nonWinners = rows.map(mapQualifyingPlayer);
      setImmediate(() => {
        void notifyGiveawayNonWinners(db, nonWinners, ctx.period, ctx.monthLabel);
      });
    }
  }

  const updated = getReward(db, ctx.reward_id);
  if (!updated) {
    // Practically impossible on better-sqlite3 (single-threaded, single
    // connection) but we don't want a stray null assertion to crash a
    // request if the invariant is ever violated.
    throw new Error("Reward not found after confirm");
  }
  return updated;
}

/**
 * Two-phase random roll — discard variant: deletes the pending-review
 * award row and returns the pool row to `available`. Used when the admin
 * wants to re-roll. No emails are sent.
 *
 * @param db - Database instance.
 * @param awardId - The pending-review award id.
 * @param _adminId - Reserved for future audit-log wiring.
 * @throws Error if the award is not in pending-review state.
 */
export function discardPendingAward(
  db: DatabaseType,
  awardId: string,
  _adminId: string,
): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, reward_id, pending_review_at, voided_at, claimed_at
         FROM reward_awards
         WHERE id = ?`
      )
      .get(awardId) as
      | { id: string; reward_id: string; pending_review_at: string | null; voided_at: string | null; claimed_at: string | null }
      | undefined;

    if (!row) throw new Error("Award not found");
    if (row.voided_at !== null || row.claimed_at !== null || row.pending_review_at === null) {
      throw new Error("Award is not pending review");
    }

    db.prepare("DELETE FROM reward_awards WHERE id = ?").run(awardId);
    db.prepare("UPDATE reward_pool SET status = 'available' WHERE id = ?").run(row.reward_id);
  })();
}

/**
 * Send the consolation email to every qualifying player who did not win
 * the most recent random-roll draw. Iterates serially with a small delay
 * so we stay well clear of Resend's 10 req/sec ceiling.
 *
 * Gating model (intentionally narrower than the standard marketing
 * pipeline):
 *  - The `email_trigger_config` row for `giveaway_loss` acts as a kill
 *    switch: if `is_enabled = 0` the entire batch is dropped.
 *  - Per-user, the master `email_enabled` flag and the per-type
 *    `giveaway_loss` opt-in are enforced explicitly here.
 *  - The 24h global marketing cooldown is **bypassed** via
 *    `adminOverride: true` so a non-winner who happened to receive any
 *    other marketing email in the last day still hears the result of the
 *    draw they entered. Per-recipient unsubscribe still applies because
 *    one-click unsubscribe flips the per-type pref off and our explicit
 *    check above honors that.
 *
 * @param db - Database instance.
 * @param nonWinners - Qualifying players minus the winner.
 * @param period - Qualifying-period key from the draw criteria; only used
 *   to inflect the body copy ("this month's", "next week's", etc.).
 * @returns Aggregate counts for logging and tests.
 */
export async function notifyGiveawayNonWinners(
  db: DatabaseType,
  nonWinners: QualifyingPlayer[],
  period: RandomRollCriteria["period"],
  monthLabel?: string,
): Promise<{ sent: number; skipped: number; byReason: Record<string, number> }> {
  let sent = 0;
  let skipped = 0;
  const byReason: Record<string, number> = {};

  const bump = (reason: string) => {
    skipped++;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  };

  // Trigger-level kill switch. An admin can disable the type from
  // /admin/email/triggers without having to touch code.
  const trigger = getTriggerConfig(db, "giveaway_loss");
  if (trigger && !trigger.isEnabled) {
    console.log(
      `[reward] giveaway_loss notify skipped: trigger disabled (${nonWinners.length} eligible recipients)`,
    );
    return { sent: 0, skipped: nonWinners.length, byReason: { trigger_disabled: nonWinners.length } };
  }

  for (const player of nonWinners) {
    // Per-recipient try/catch so one bad row never aborts the rest of
    // the batch (e.g. a transient Resend failure or a race with user
    // deletion mid-send).
    try {
      const prefs = getEmailPreferences(db, player.id);
      if (!prefs.emailEnabled) { bump("disabled"); continue; }
      if (!prefs.giveawayLoss) { bump("type_disabled"); continue; }

      const { subject, html, text } = buildGiveawayLossEmail(db, {
        username: player.username,
        period,
        monthLabel,
      });

      const r = await sendMarketingEmail(db, player.id, "giveaway_loss", {
        subject,
        html,
        text,
        // Bypass the 24h global cooldown; the per-recipient pref check
        // above is what guarantees consent.
        adminOverride: true,
      });

      if (r.sent) {
        sent++;
      } else {
        bump(r.reason ?? "unknown");
      }
    } catch (err) {
      console.error(`[reward] giveaway_loss send failed for user=${player.id}:`, err);
      bump("send_error");
    }

    // Headroom under Resend's 10 req/sec free-tier ceiling.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log(
    `[reward] giveaway_loss notify: sent=${sent} skipped=${skipped} reasons=${JSON.stringify(byReason)}`,
  );

  return { sent, skipped, byReason };
}

/**
 * Mask a gift card code, showing only the last 4 characters.
 *
 * @param code - The full gift card code.
 * @returns Masked code string.
 */
function maskCode(code: string): string {
  if (code.length <= 4) return "****";
  return "****-" + code.slice(-4);
}

/**
 * Get all rewards awarded to a specific user.
 * Codes are masked; full codes are only revealed at claim time.
 *
 * @param db - Database instance.
 * @param userId - The user ID.
 * @returns Array of user rewards sorted by awarded date descending.
 */
export function getUserRewards(db: DatabaseType, userId: string): UserReward[] {
  // Voided awards are filtered: from the user's perspective an expired
  // reward is "gone" and is communicated via the expired email instead.
  const rows = db
    .prepare(
      `SELECT rp.id, rp.reward_type, rp.amount_cents, rp.code, rp.description,
              ra.award_method, ra.awarded_at, ra.claimed_at,
              ra.claim_token, ra.claim_expires_at
       FROM reward_awards ra
       JOIN reward_pool rp ON rp.id = ra.reward_id
       WHERE ra.user_id = ?
         AND ra.voided_at IS NULL
         AND ra.pending_review_at IS NULL
       ORDER BY ra.awarded_at DESC`
    )
    .all(userId) as {
    id: string;
    reward_type: string;
    amount_cents: number;
    code: string;
    description: string | null;
    award_method: string;
    awarded_at: string;
    claimed_at: string | null;
    claim_token: string;
    claim_expires_at: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    rewardType: row.reward_type,
    amountCents: row.amount_cents,
    code: maskCode(row.code),
    description: row.description,
    awardMethod: row.award_method as RewardAwardMethod,
    awardedAt: row.awarded_at,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    claimToken: row.claim_token,
  }));
}

/**
 * Mark a reward as claimed by its owner. Returns the full gift card code
 * on success — this is the only endpoint that reveals the unmasked code.
 *
 * Relies on better-sqlite3's synchronous transaction model for atomicity.
 * If the driver is ever switched to an async one, re-evaluate concurrency.
 *
 * @param db - Database instance.
 * @param rewardId - The reward pool ID.
 * @param userId - The user claiming the reward (must be the recipient).
 * @returns The full gift card code, or null if not found / not owned / already claimed.
 */
export function claimReward(db: DatabaseType, rewardId: string, userId: string): string | null {
  return db.transaction(() => {
    const nowIso = new Date().toISOString();
    const row = db
      .prepare(
        `SELECT ra.id, rp.code FROM reward_awards ra
         JOIN reward_pool rp ON rp.id = ra.reward_id
         WHERE ra.reward_id = ?
           AND ra.user_id = ?
           AND rp.status = 'awarded'
           AND ra.claimed_at IS NULL
           AND ra.voided_at IS NULL
           AND ra.pending_review_at IS NULL
           AND ra.claim_expires_at > ?`
      )
      .get(rewardId, userId, nowIso) as { id: string; code: string } | undefined;

    if (!row) return null;

    db.prepare("UPDATE reward_awards SET claimed_at = ? WHERE id = ?").run(nowIso, row.id);
    db.prepare("UPDATE reward_pool SET status = 'claimed' WHERE id = ?").run(rewardId);
    return row.code;
  })();
}

/**
 * Result variants for {@link claimRewardByToken}. Distinguishes the failure
 * modes so the API/UI can render distinct messages without leaking
 * existence (an unknown token returns 'invalid', which is also what we'd
 * return for a malformed token).
 */
export type ClaimByTokenResult =
  | { ok: true; code: string; amountCents: number; rewardType: string }
  | {
      ok: false;
      reason: "invalid" | "wrong_user" | "expired" | "voided" | "already_claimed";
    };

/**
 * Claim a reward via the per-award token sent in the winner email.
 *
 * Verifies the token matches an existing award, the requesting user is the
 * recipient, and the award is not already claimed, voided, or past its
 * deadline. On success, marks the award claimed and reveals the full code
 * (the only place outside `claimReward` that returns the unmasked code).
 *
 * @param db - Database instance.
 * @param token - Per-award claim token from the email link.
 * @param userId - The session user attempting to claim.
 * @returns A discriminated union — {@link ClaimByTokenResult}.
 */
export function claimRewardByToken(
  db: DatabaseType,
  token: string,
  userId: string,
): ClaimByTokenResult {
  return db.transaction((): ClaimByTokenResult => {
    const row = db
      .prepare(
        `SELECT ra.id, ra.user_id, ra.claimed_at, ra.voided_at, ra.claim_expires_at,
                ra.pending_review_at,
                ra.reward_id, rp.code, rp.amount_cents, rp.reward_type
         FROM reward_awards ra
         JOIN reward_pool rp ON rp.id = ra.reward_id
         WHERE ra.claim_token = ?`
      )
      .get(token) as
      | {
          id: string;
          user_id: string;
          claimed_at: string | null;
          voided_at: string | null;
          claim_expires_at: string;
          reward_id: string;
          code: string;
          amount_cents: number;
          reward_type: string;
          pending_review_at: string | null;
        }
      | undefined;

    if (!row) return { ok: false, reason: "invalid" };
    if (row.user_id !== userId) return { ok: false, reason: "wrong_user" };
    if (row.voided_at !== null) return { ok: false, reason: "voided" };
    if (row.claimed_at !== null) return { ok: false, reason: "already_claimed" };
    // A pending-review award means the admin hasn't confirmed the roll
    // yet — the winner email has not been sent and the user has no
    // legitimate way to know this token. Threat model: an admin leak of
    // a pending token, or (vanishingly unlikely) a brute-force guess. In
    // both cases we want zero distinguishability from a non-existent
    // token, so we return `invalid` and not a more specific reason.
    if (row.pending_review_at !== null) return { ok: false, reason: "invalid" };

    const nowIso = new Date().toISOString();
    if (row.claim_expires_at <= nowIso) return { ok: false, reason: "expired" };

    db.prepare("UPDATE reward_awards SET claimed_at = ? WHERE id = ?").run(nowIso, row.id);
    db.prepare("UPDATE reward_pool SET status = 'claimed' WHERE id = ?").run(row.reward_id);

    return {
      ok: true,
      code: row.code,
      amountCents: row.amount_cents,
      rewardType: row.reward_type,
    };
  })();
}

/**
 * Sweep awards whose 30-day claim window has lapsed unclaimed. Marks the
 * award row `voided_at`, returns the pool row to `available`, and fires
 * the final "your reward has expired" email exactly once per voided award.
 *
 * Idempotent: re-running picks up nothing because we filter on
 * `voided_at IS NULL` and stamp it on the first sweep.
 *
 * @param db - Database instance.
 * @param now - Optional Date override for testing.
 * @returns The number of awards voided this run.
 */
export function expireOverdueRewards(
  db: DatabaseType,
  now: Date = new Date(),
): { voidedCount: number } {
  const nowIso = now.toISOString();

  // Critical: pending-review rows are NOT real awards yet — the winner
  // email has not been sent, the user has no idea they were a candidate.
  // If we let the sweeper void them and fire the "expired" email, we'd
  // be telling a user they lost a reward they never knew they won.
  // Pending rows that age out should be cleaned up by the admin (or a
  // separate stale-preview job, future work) — never auto-expired here.
  const overdue = db
    .prepare(
      `SELECT ra.id, ra.reward_id, ra.user_id,
              rp.amount_cents, rp.reward_type,
              u.email, u.username
       FROM reward_awards ra
       JOIN reward_pool rp ON rp.id = ra.reward_id
       JOIN users u ON u.id = ra.user_id
       WHERE ra.voided_at IS NULL
         AND ra.claimed_at IS NULL
         AND ra.pending_review_at IS NULL
         AND ra.claim_expires_at <= ?`
    )
    .all(nowIso) as {
    id: string;
    reward_id: string;
    user_id: string;
    amount_cents: number;
    reward_type: string;
    email: string;
    username: string;
  }[];

  if (overdue.length === 0) return { voidedCount: 0 };

  const voidTransaction = db.transaction(() => {
    for (const r of overdue) {
      db.prepare(
        "UPDATE reward_awards SET voided_at = ?, expired_email_sent_at = ? WHERE id = ?"
      ).run(nowIso, nowIso, r.id);
      db.prepare("UPDATE reward_pool SET status = 'available' WHERE id = ?").run(r.reward_id);
    }
  });
  voidTransaction();

  // Fire-and-forget the final notification — the DB state is the source
  // of truth, so a Resend hiccup must not roll back the void.
  for (const r of overdue) {
    sendRewardExpiredEmail(db, r.email, r.username, r.amount_cents, r.reward_type).catch((err) => {
      console.error(`[reward] Failed to send expiry email for award=${r.id}:`, err);
    });
  }

  return { voidedCount: overdue.length };
}

/**
 * Scan pending awards and send the 15-day, 7-day, and 1-day claim-deadline
 * reminders. Idempotent per cadence: each reminder column is stamped after
 * a successful send, so re-running this in the same cadence window doesn't
 * re-mail the recipient.
 *
 * Each cadence has its own narrow window so a freshly-awarded 30-day
 * reward fires nothing immediately and a 15-day reminder doesn't step on
 * the 7-day reminder's slot. Specifically (with N = days remaining):
 *  - 15-day fires when `7 < N <= 15` and the column is null
 *  - 7-day  fires when `1 < N <= 7`  and the column is null
 *  - 1-day  fires when `0 < N <= 1`  and the column is null
 *
 * Reminders are transactional follow-ups to a transactional event the user
 * already received — they bypass per-user marketing preferences (see PR).
 *
 * @param db - Database instance.
 * @param now - Optional Date override for testing.
 * @returns Per-cadence send counts.
 */
export function sendClaimReminders(
  db: DatabaseType,
  now: Date = new Date(),
): { sent: { day15: number; day7: number; day1: number } } {
  const sent = { day15: 0, day7: 0, day1: 0 };

  // Each cadence has its own narrow window: between the *next* shorter
  // cadence and itself. This keeps the 15-day reminder from firing at
  // 7-days-remaining (which would step on the 7-day reminder) while still
  // letting an admin-shortened deadline land in the right cadence.
  const cadences: {
    days: 15 | 7 | 1;
    column: string;
    lowerExclusiveDays: number;
  }[] = [
    { days: 15, column: "reminder_15d_sent_at", lowerExclusiveDays: 7 },
    { days: 7, column: "reminder_7d_sent_at", lowerExclusiveDays: 1 },
    { days: 1, column: "reminder_1d_sent_at", lowerExclusiveDays: 0 },
  ];

  for (const { days, column, lowerExclusiveDays } of cadences) {
    const nowMs = now.getTime();
    const upperBoundIso = new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
    const lowerBoundIso = new Date(
      nowMs + lowerExclusiveDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const nowIso = now.toISOString();

    const pending = db
      .prepare(
        `SELECT ra.id, ra.reward_id,
                rp.amount_cents, rp.reward_type,
                ra.claim_expires_at, ra.claim_token,
                u.email, u.username
         FROM reward_awards ra
         JOIN reward_pool rp ON rp.id = ra.reward_id
         JOIN users u ON u.id = ra.user_id
         WHERE ra.voided_at IS NULL
           AND ra.claimed_at IS NULL
           AND ra.pending_review_at IS NULL
           AND ra.${column} IS NULL
           AND ra.claim_expires_at > ?
           AND ra.claim_expires_at <= ?`
      )
      .all(lowerBoundIso, upperBoundIso) as {
      id: string;
      reward_id: string;
      amount_cents: number;
      reward_type: string;
      claim_expires_at: string;
      claim_token: string;
      email: string;
      username: string;
    }[];

    for (const r of pending) {
      // Stamp first inside its own transaction so a Resend failure
      // surfaces in logs but never re-sends on the next sweep.
      db.prepare(`UPDATE reward_awards SET ${column} = ? WHERE id = ?`).run(nowIso, r.id);

      sendClaimReminderEmail(
        r.email,
        r.username,
        r.amount_cents,
        days,
        r.claim_expires_at,
        buildClaimUrl(r.claim_token),
      ).catch((err) => {
        console.error(`[reward] Failed to send ${days}d claim reminder for award=${r.id}:`, err);
      });

      if (days === 15) sent.day15++;
      else if (days === 7) sent.day7++;
      else sent.day1++;
    }
  }

  return { sent };
}

/**
 * Search users by username prefix for the admin award UI.
 *
 * @param db - Database instance.
 * @param query - Username search string.
 * @param limit - Max results to return.
 * @returns Array of matching users.
 */
export function searchUsers(
  db: DatabaseType,
  query: string,
  limit: number = 20
): { id: string; username: string; email: string; lifetimeScore: number }[] {
  const escaped = query.toLowerCase().replace(/[%_\\]/g, "\\$&");
  const rows = db
    .prepare(
      `SELECT id, username, email, lifetime_score
       FROM users
       WHERE is_active = 1 AND username_normalized LIKE ? ESCAPE '\\'
       ORDER BY username_normalized
       LIMIT ?`
    )
    .all(`${escaped}%`, limit) as {
    id: string;
    username: string;
    email: string;
    lifetime_score: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    lifetimeScore: r.lifetime_score,
  }));
}
