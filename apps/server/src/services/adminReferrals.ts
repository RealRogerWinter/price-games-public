/**
 * Admin referral analytics service.
 *
 * Aggregates the `referrals` table for the admin dashboard. All queries
 * accept an `AdminReferralRange` selector that translates to a
 * `created_at >= ?` predicate (or no predicate for "all"). Day-level
 * bucketing for the daily series uses the admin timezone via
 * `tzDateString` + `padDateSeries`, mirroring `adminUsers.getUserActivity`.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  ADMIN_TIMEZONE,
  padDateSeries,
  tzDateString,
} from "@price-game/shared";
import type {
  AdminReferralDailyPoint,
  AdminReferralRange,
  AdminReferralRejectionBucket,
  AdminReferralSummary,
  AdminReferralTopReferrer,
  AdminReferredUser,
  Avatar,
} from "@price-game/shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Map a range selector to a number of days (or null for "all"). */
function rangeToDays(range: AdminReferralRange): number | null {
  switch (range) {
    case "7d":
      return 7;
    case "28d":
      return 28;
    case "90d":
      return 90;
    case "all":
      return null;
    default:
      return 28;
  }
}

/** Compute the ISO start-of-window timestamp; null when range is "all". */
function rangeStartIso(range: AdminReferralRange, now: Date): string | null {
  const days = rangeToDays(range);
  if (days === null) return null;
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * Aggregate KPI counters for the referral analytics window.
 *
 * @param db - Database instance.
 * @param range - Time window selector ("7d" | "28d" | "90d" | "all").
 * @returns AdminReferralSummary with totals, conversion rate, unique referrers.
 */
export function getReferralSummary(
  db: DatabaseType,
  range: AdminReferralRange,
): AdminReferralSummary {
  const now = new Date();
  const startIso = rangeStartIso(range, now);

  const where = startIso ? "WHERE created_at >= ?" : "";
  const bindings = startIso ? [startIso] : [];

  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'credited' THEN 1 ELSE 0 END) AS credited,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         COUNT(DISTINCT referrer_id) AS unique_referrers
       FROM referrals ${where}`,
    )
    .get(...bindings) as Record<string, number | null>;

  const total = row.total ?? 0;
  const credited = row.credited ?? 0;
  const pending = row.pending ?? 0;
  const rejected = row.rejected ?? 0;
  const uniqueReferrers = row.unique_referrers ?? 0;

  return {
    total,
    credited,
    pending,
    rejected,
    conversionRate: total > 0 ? credited / total : 0,
    uniqueReferrers,
    periodStart: startIso,
    periodEnd: now.toISOString(),
  };
}

/**
 * Daily time-series of referrals created and referrals credited.
 *
 * Returns a zero-filled array — one entry per calendar day in the window —
 * bucketed by `timeZone` (default `ADMIN_TIMEZONE`). For the "all" range
 * we still cap the series at 365 days so the chart stays bounded; callers
 * that want a deeper history should use a different endpoint.
 *
 * @param db - Database instance.
 * @param range - Time window selector.
 * @param timeZone - IANA timezone for day bucketing.
 * @returns Zero-filled daily series.
 */
export function getReferralDaily(
  db: DatabaseType,
  range: AdminReferralRange,
  timeZone: string = ADMIN_TIMEZONE,
): AdminReferralDailyPoint[] {
  const now = new Date();
  const days = rangeToDays(range) ?? 365;
  // Generous SQL-side filter (2 extra days) so DST edges don't drop rows.
  const sinceIso = new Date(now.getTime() - (days + 2) * MS_PER_DAY).toISOString();

  const createdRows = db
    .prepare(
      `SELECT created_at AS ts FROM referrals WHERE created_at >= ?`,
    )
    .all(sinceIso) as { ts: string }[];

  const creditedRows = db
    .prepare(
      `SELECT credited_at AS ts FROM referrals
       WHERE status = 'credited' AND credited_at IS NOT NULL AND credited_at >= ?`,
    )
    .all(sinceIso) as { ts: string }[];

  const created = new Map<string, number>();
  for (const r of createdRows) {
    const bucket = tzDateString(r.ts, timeZone);
    if (!bucket) continue;
    created.set(bucket, (created.get(bucket) ?? 0) + 1);
  }

  const credited = new Map<string, number>();
  for (const r of creditedRows) {
    const bucket = tzDateString(r.ts, timeZone);
    if (!bucket) continue;
    credited.set(bucket, (credited.get(bucket) ?? 0) + 1);
  }

  const dates = new Set<string>([...created.keys(), ...credited.keys()]);
  const sparse: AdminReferralDailyPoint[] = Array.from(dates)
    .map((date) => ({
      date,
      created: created.get(date) ?? 0,
      credited: credited.get(date) ?? 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return padDateSeries(
    sparse,
    now,
    days,
    timeZone,
    (date) => ({ date, created: 0, credited: 0 }),
  );
}

/**
 * Top referrers by credited-referral count within a window.
 *
 * @param db - Database instance.
 * @param range - Time window selector.
 * @param limit - Max rows (clamped to [1, 100]).
 * @returns Leaderboard rows ordered by credited desc, total desc.
 */
export function getReferralTopReferrers(
  db: DatabaseType,
  range: AdminReferralRange,
  limit: number,
): AdminReferralTopReferrer[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 1, 1), 100);
  const now = new Date();
  const startIso = rangeStartIso(range, now);

  const where = startIso ? "WHERE r.created_at >= ?" : "";
  const bindings: unknown[] = startIso ? [startIso, safeLimit] : [safeLimit];

  const rows = db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.username AS username,
         u.avatar AS avatar,
         SUM(CASE WHEN r.status = 'credited' THEN 1 ELSE 0 END) AS credited,
         SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         COUNT(*) AS total
       FROM referrals r
       JOIN users u ON u.id = r.referrer_id
       ${where}
       GROUP BY u.id, u.username, u.avatar
       ORDER BY credited DESC, total DESC, u.username ASC
       LIMIT ?`,
    )
    .all(...bindings) as Array<{
    user_id: string;
    username: string;
    avatar: string | null;
    credited: number;
    pending: number;
    rejected: number;
    total: number;
  }>;

  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    avatar: (row.avatar as Avatar | null) ?? null,
    credited: row.credited ?? 0,
    pending: row.pending ?? 0,
    rejected: row.rejected ?? 0,
    total: row.total ?? 0,
  }));
}

/**
 * Breakdown of rejection reasons for rejected referrals in the window.
 *
 * @param db - Database instance.
 * @param range - Time window selector.
 * @returns Buckets sorted by count desc; null reasons are bucketed as "unknown".
 */
export function getRejectionBreakdown(
  db: DatabaseType,
  range: AdminReferralRange,
): AdminReferralRejectionBucket[] {
  const now = new Date();
  const startIso = rangeStartIso(range, now);

  const where = startIso
    ? "WHERE status = 'rejected' AND created_at >= ?"
    : "WHERE status = 'rejected'";
  const bindings = startIso ? [startIso] : [];

  const rows = db
    .prepare(
      `SELECT COALESCE(rejection_reason, 'unknown') AS reason, COUNT(*) AS count
       FROM referrals
       ${where}
       GROUP BY COALESCE(rejection_reason, 'unknown')
       ORDER BY count DESC, reason ASC`,
    )
    .all(...bindings) as Array<{ reason: string; count: number }>;

  return rows.map((r) => ({ reason: r.reason, count: r.count }));
}

/**
 * List the users referred by a specific referrer, newest first.
 *
 * Powers the admin drill-down where clicking a row in the top-referrers
 * leaderboard reveals which accounts that user actually brought in. The
 * window filter mirrors the leaderboard so the two views stay in sync.
 *
 * @param db - Database instance.
 * @param referrerId - User ID of the referrer.
 * @param range - Time window selector.
 * @returns Referred users ordered by referral created_at desc.
 */
export function getReferredUsersByReferrer(
  db: DatabaseType,
  referrerId: string,
  range: AdminReferralRange,
): AdminReferredUser[] {
  const now = new Date();
  const startIso = rangeStartIso(range, now);

  const where = startIso
    ? "WHERE r.referrer_id = ? AND r.created_at >= ?"
    : "WHERE r.referrer_id = ?";
  const bindings: unknown[] = startIso ? [referrerId, startIso] : [referrerId];

  const rows = db
    .prepare(
      `SELECT
         r.id AS referral_id,
         u.id AS user_id,
         u.username AS username,
         u.avatar AS avatar,
         r.status AS status,
         r.rejection_reason AS rejection_reason,
         r.created_at AS created_at,
         r.credited_at AS credited_at
       FROM referrals r
       JOIN users u ON u.id = r.referred_id
       ${where}
       ORDER BY r.created_at DESC, u.username ASC`,
    )
    .all(...bindings) as Array<{
    referral_id: string;
    user_id: string;
    username: string;
    avatar: string | null;
    status: "pending" | "credited" | "rejected";
    rejection_reason: string | null;
    created_at: string;
    credited_at: string | null;
  }>;

  return rows.map((row) => ({
    referralId: row.referral_id,
    userId: row.user_id,
    username: row.username,
    avatar: (row.avatar as Avatar | null) ?? null,
    status: row.status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    creditedAt: row.credited_at,
  }));
}
