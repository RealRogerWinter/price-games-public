/**
 * Referral service — handles referral code generation, pending/credit logic,
 * IP-based anti-abuse detection, disposable email blocking, and dashboard data.
 */

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import type { ReferralDashboard, ReferralEntry, ReferralStatus } from "@price-game/shared";
import { config } from "../config";

// Charset excludes I/O/0/1 to avoid user confusion
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_RETRIES = 5;

/**
 * Generate a unique 8-character referral code.
 *
 * @param db - Database instance.
 * @returns A unique referral code string.
 * @throws Error if a unique code cannot be generated after max retries.
 */
export function generateReferralCode(db: DatabaseType): string {
  // Largest multiple of CHARSET.length (31) that fits in a byte: 248
  const maxUnbiased = CHARSET.length * Math.floor(256 / CHARSET.length);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let code = "";
    // Rejection sampling: discard bytes >= maxUnbiased to eliminate modulo bias
    while (code.length < CODE_LENGTH) {
      const bytes = crypto.randomBytes(CODE_LENGTH * 2);
      for (let i = 0; i < bytes.length && code.length < CODE_LENGTH; i++) {
        if (bytes[i] < maxUnbiased) {
          code += CHARSET[bytes[i] % CHARSET.length];
        }
      }
    }

    const existing = db
      .prepare("SELECT id FROM users WHERE referral_code = ?")
      .get(code);
    if (!existing) return code;
  }
  throw new Error("Failed to generate unique referral code after max retries");
}

/**
 * Assign referral codes to all existing users that have NULL referral_code.
 * Called after the v26 migration to backfill codes.
 *
 * @param db - Database instance.
 * @returns Number of users updated.
 */
export function backfillReferralCodes(db: DatabaseType): number {
  const users = db
    .prepare("SELECT id FROM users WHERE referral_code IS NULL")
    .all() as { id: string }[];

  if (users.length === 0) return 0;

  const update = db.prepare("UPDATE users SET referral_code = ? WHERE id = ?");

  const backfill = db.transaction(() => {
    for (const user of users) {
      const code = generateReferralCode(db);
      update.run(code, user.id);
    }
  });

  backfill();
  return users.length;
}

/**
 * Create a pending referral record when a new user registers with a referral code.
 *
 * @param db - Database instance.
 * @param referredUserId - The newly registered user's ID.
 * @param referralCode - The referral code they used.
 * @param referredIp - The IP address of the referred user.
 * @returns true if the pending referral was created, false if invalid/self-referral.
 */
export function createPendingReferral(
  db: DatabaseType,
  referredUserId: string,
  referralCode: string,
  referredIp: string,
): boolean {
  // Normalize to uppercase to match generated codes
  const normalizedCode = referralCode.toUpperCase();

  // Look up referrer by code
  const referrer = db
    .prepare("SELECT id FROM users WHERE referral_code = ?")
    .get(normalizedCode) as { id: string } | undefined;

  if (!referrer) return false;

  // Prevent self-referral
  if (referrer.id === referredUserId) return false;

  // Check if referred user already has a referral
  const existing = db
    .prepare("SELECT id FROM referrals WHERE referred_id = ?")
    .get(referredUserId);
  if (existing) return false;

  // Get the referrer's most recent IP from sessions
  const referrerSession = db
    .prepare(
      "SELECT ip_address FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC LIMIT 1",
    )
    .get(referrer.id) as { ip_address: string | null } | undefined;

  const referrerIp = referrerSession?.ip_address ?? null;

  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, referrer_ip, referred_ip, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, referrer.id, referredUserId, normalizedCode, referrerIp, referredIp, now);

  return true;
}

/**
 * Check if an email domain is from a disposable email provider.
 *
 * @param email - The email address to check.
 * @returns true if the domain is disposable.
 */
export function isDisposableEmail(email: string): boolean {
  try {
    // Dynamic require to avoid bundling issues; package is optional
    const domains = require("disposable-email-domains") as string[];
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;
    return domains.includes(domain);
  } catch {
    // If the package isn't installed, skip the check
    return false;
  }
}

/**
 * Credit or reject a pending referral when the referred user verifies their email.
 *
 * Checks for IP match (same IP = likely same person) and disposable email.
 * Sets status to 'credited' or 'rejected' with the appropriate reason.
 *
 * @param db - Database instance.
 * @param referredUserId - The user who just verified their email.
 */
export function creditReferralOnVerify(
  db: DatabaseType,
  referredUserId: string,
): void {
  const referral = db
    .prepare("SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending'")
    .get(referredUserId) as Record<string, unknown> | undefined;

  if (!referral) return;

  const now = new Date().toISOString();

  // Check IP match
  if (
    referral.referrer_ip &&
    referral.referred_ip &&
    referral.referrer_ip === referral.referred_ip
  ) {
    db.prepare(
      "UPDATE referrals SET status = 'rejected', rejection_reason = 'ip_match' WHERE id = ?",
    ).run(referral.id as string);
    return;
  }

  // Check disposable email on the referred user
  const referredUser = db
    .prepare("SELECT email FROM users WHERE id = ?")
    .get(referredUserId) as { email: string } | undefined;

  if (referredUser && isDisposableEmail(referredUser.email)) {
    db.prepare(
      "UPDATE referrals SET status = 'rejected', rejection_reason = 'disposable_email' WHERE id = ?",
    ).run(referral.id as string);
    return;
  }

  // Credit the referral
  db.prepare(
    "UPDATE referrals SET status = 'credited', credited_at = ? WHERE id = ?",
  ).run(now, referral.id as string);
}

/**
 * Get the full referral dashboard data for a user.
 *
 * @param db - Database instance.
 * @param userId - The user whose dashboard to retrieve.
 * @returns ReferralDashboard with stats, referral list, and multi-account warning.
 */
export function getReferralDashboard(
  db: DatabaseType,
  userId: string,
): ReferralDashboard {
  const user = db
    .prepare("SELECT referral_code FROM users WHERE id = ?")
    .get(userId) as { referral_code: string | null } | undefined;

  const referralCode = user?.referral_code ?? "";
  const appUrl = config.appUrl.replace(/\/$/, "");
  const referralUrl = `${appUrl}/r/${referralCode}`;

  // Get all referrals made by this user
  const rows = db
    .prepare(
      `SELECT r.id, r.status, r.rejection_reason, r.created_at, r.credited_at,
              u.username as referred_username, u.avatar as referred_avatar
       FROM referrals r
       JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(userId) as {
    id: string;
    status: string;
    rejection_reason: string | null;
    created_at: string;
    credited_at: string | null;
    referred_username: string;
    referred_avatar: string | null;
  }[];

  const referrals: ReferralEntry[] = rows.map((row) => ({
    id: row.id,
    referredUsername: row.referred_username,
    referredAvatar: (row.referred_avatar as import("@price-game/shared").Avatar | null) ?? null,
    status: row.status as ReferralStatus,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    creditedAt: row.credited_at,
  }));

  const totalReferrals = referrals.length;
  const creditedReferrals = referrals.filter((r) => r.status === "credited").length;
  const pendingReferrals = referrals.filter((r) => r.status === "pending").length;

  // Detect multi-account: check if other users share IPs from this user's sessions
  const multiAccountWarning = detectMultiAccount(db, userId);

  return {
    referralCode,
    referralUrl,
    totalReferrals,
    creditedReferrals,
    pendingReferrals,
    referrals,
    multiAccountWarning,
  };
}

/**
 * Check if other users share session IPs with this user (multi-account indicator).
 *
 * @param db - Database instance.
 * @param userId - The user to check.
 * @returns true if other users share IPs from this user's sessions.
 */
function detectMultiAccount(db: DatabaseType, userId: string): boolean {
  // Limit scan to sessions from the last 90 days to bound query cost
  const result = db
    .prepare(
      `SELECT COUNT(DISTINCT us2.user_id) as shared_count
       FROM user_sessions us1
       JOIN user_sessions us2
         ON us1.ip_address = us2.ip_address
         AND us2.user_id != us1.user_id
         AND us2.last_active_at > datetime('now', '-90 days')
       WHERE us1.user_id = ?
         AND us1.ip_address IS NOT NULL
         AND us1.last_active_at > datetime('now', '-90 days')`,
    )
    .get(userId) as { shared_count: number };

  return result.shared_count > 0;
}

/**
 * Get the count of credited referrals for a user (used for weighted random roll).
 *
 * @param db - Database instance.
 * @param userId - The user ID.
 * @returns Number of credited referrals.
 */
export function getCreditedReferralCount(
  db: DatabaseType,
  userId: string,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND status = 'credited'",
    )
    .get(userId) as { count: number };
  return row.count;
}
