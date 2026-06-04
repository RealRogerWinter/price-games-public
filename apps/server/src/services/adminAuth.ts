/**
 * Admin authentication service.
 *
 * Handles admin user CRUD, login with account locking, session management
 * (create / validate / destroy), and initial admin seeding from environment
 * variables.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import type { AdminUser } from "@price-game/shared";
import { config } from "../config";
import { isAccountLocked, recordFailedLogin, recordSuccessfulLogin } from "./authHelpers";
import { isTotpEnabled, createPendingTotpToken, validateAndConsumePendingToken, verifyTotpCode, verifyRecoveryCodeAndConsume, logAuditEvent } from "./adminTotp";

export type { AdminUser };

// ── Constants ──────────────────────────────────────────────────────────────

/** Dummy bcrypt hash for constant-time comparison — must match production cost factor. */
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", config.adminBcryptRounds);

/** Minimum password length. */
const MIN_PASSWORD_LENGTH = 12;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Map a DB row to a public AdminUser (no hash). */
function rowToAdminUser(row: Record<string, unknown>): AdminUser {
  return {
    id: row.id as string,
    username: row.username as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastLoginAt: (row.last_login_at as string) ?? null,
    isActive: (row.is_active as number) === 1,
    canUseExtension: (row.can_use_extension as number) === 1,
    totpEnabled: (row.totp_enabled as number) === 1,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new admin user.
 *
 * @param db - Database instance.
 * @param username - Desired username (will be lowercased).
 * @param password - Plain-text password (min 12 chars).
 * @returns The created AdminUser (without password hash).
 * @throws If username is empty, password too short, or username already taken.
 */
export function createAdmin(
  db: DatabaseType,
  username: string,
  password: string,
): AdminUser {
  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Username must not be empty");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const existing = db
    .prepare("SELECT id FROM admin_users WHERE username = ?")
    .get(normalized);
  if (existing) {
    throw new Error("Username already exists");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, config.adminBcryptRounds);

  db.prepare(
    `INSERT INTO admin_users (id, username, password_hash, created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, normalized, hash, now, now);

  return {
    id,
    username: normalized,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    isActive: true,
    canUseExtension: false,
    totpEnabled: false,
  };
}

/** Result of a login attempt — either a full session or a pending 2FA challenge. */
export type AdminLoginResult =
  | { requiresTwoFactor: false; token: string; user: AdminUser }
  | { requiresTwoFactor: true; pendingToken: string; user: AdminUser };

/**
 * Authenticate an admin user. If 2FA is enabled, returns a pending token
 * instead of a full session — the caller must complete 2FA via
 * `adminLoginVerify2fa`.
 *
 * @param db - Database instance.
 * @param username - Username (case-insensitive).
 * @param password - Plain-text password.
 * @param ip - Optional IP address for the session.
 * @param userAgent - Optional user-agent string.
 * @returns Either a full session or a 2FA pending token.
 * @throws On invalid credentials, locked or disabled account.
 */
export function adminLogin(
  db: DatabaseType,
  username: string,
  password: string,
  ip?: string,
  userAgent?: string,
): AdminLoginResult {
  const normalized = username.trim().toLowerCase();

  const row = db
    .prepare("SELECT * FROM admin_users WHERE username = ?")
    .get(normalized) as Record<string, unknown> | undefined;

  if (!row) {
    bcrypt.compareSync(password, DUMMY_HASH);
    throw new Error("Invalid credentials");
  }

  if ((row.is_active as number) !== 1) {
    bcrypt.compareSync(password, DUMMY_HASH);
    throw new Error("Invalid credentials");
  }

  if (isAccountLocked(db, "admin_users", row.id as string, row.locked_until as string | null, DUMMY_HASH, password)) {
    throw new Error("Account is temporarily locked");
  }

  const valid = bcrypt.compareSync(password, row.password_hash as string);
  if (!valid) {
    recordFailedLogin(db, "admin_users", row.id as string, (row.failed_login_count as number) ?? 0, config.adminMaxFailedLogins, config.adminLockoutDurationMs);
    throw new Error("Invalid credentials");
  }

  recordSuccessfulLogin(db, "admin_users", row.id as string);

  // Re-read to capture updated fields
  const updated = db
    .prepare("SELECT * FROM admin_users WHERE id = ?")
    .get(row.id as string) as Record<string, unknown>;
  const user = rowToAdminUser(updated);

  // If 2FA is enabled, issue a pending token instead of a session
  if (isTotpEnabled(db, row.id as string)) {
    const pendingToken = createPendingTotpToken(db, row.id as string, ip, userAgent);
    return { requiresTwoFactor: true, pendingToken, user };
  }

  // No 2FA — create a full session
  const now = new Date().toISOString();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.adminSessionDurationMs).toISOString();

  db.prepare(
    `INSERT INTO admin_sessions (id, admin_user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, row.id as string, ip ?? null, userAgent ?? null, now, expiresAt, now);

  return { requiresTwoFactor: false, token, user };
}

/**
 * Complete 2FA login verification. Validates the pending token and TOTP/recovery
 * code, then creates a full session.
 *
 * @param db - Database instance.
 * @param pendingToken - The pending token from `adminLogin`.
 * @param code - TOTP code or recovery code.
 * @param isRecoveryCode - Whether `code` is a recovery code.
 * @param ip - Optional IP address for the session.
 * @param userAgent - Optional user-agent string.
 * @returns Full session token and user.
 * @throws On invalid pending token or verification code.
 */
export function adminLoginVerify2fa(
  db: DatabaseType,
  pendingToken: string,
  code: string,
  isRecoveryCode: boolean = false,
  ip?: string,
  userAgent?: string,
): { token: string; user: AdminUser } {
  const pending = validateAndConsumePendingToken(db, pendingToken);
  if (!pending) {
    throw new Error("Pending token expired or invalid");
  }

  const adminUserId = pending.adminUserId;

  // Verify TOTP or recovery code
  let verified = false;
  if (isRecoveryCode) {
    verified = verifyRecoveryCodeAndConsume(db, adminUserId, code);
  } else {
    verified = verifyTotpCode(db, adminUserId, code);
  }

  if (!verified) {
    // Audit-log only — don't increment failed_login_count or trigger lockout.
    // The pending token is already consumed (one-time use), so retrying
    // requires a fresh password login. The 2FA rate limiter and 5-minute
    // pending token expiry bound the attack surface.
    logAuditEvent(db, adminUserId, "2fa_login_failed", ip, userAgent);
    throw new Error(isRecoveryCode ? "Invalid recovery code" : "Invalid verification code");
  }

  // Create full session
  const now = new Date().toISOString();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.adminSessionDurationMs).toISOString();

  db.prepare(
    `INSERT INTO admin_sessions (id, admin_user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, adminUserId, ip ?? null, userAgent ?? null, now, expiresAt, now);

  const updated = db
    .prepare("SELECT * FROM admin_users WHERE id = ?")
    .get(adminUserId) as Record<string, unknown>;

  logAuditEvent(db, adminUserId, "2fa_login_success", ip, userAgent);

  return { token, user: rowToAdminUser(updated) };
}

/**
 * Validate an admin session token.
 *
 * Checks existence, expiration, idle timeout, and that the owning user is
 * still active. On success, updates last_active_at and returns the AdminUser.
 *
 * @param db - Database instance.
 * @param token - Session token (the session id).
 * @returns AdminUser if valid, or null.
 */
export function validateAdminSession(
  db: DatabaseType,
  token: string,
): AdminUser | null {
  const session = db
    .prepare("SELECT * FROM admin_sessions WHERE id = ?")
    .get(token) as Record<string, unknown> | undefined;

  if (!session) return null;

  // Check absolute expiration
  const expiresAt = new Date(session.expires_at as string).getTime();
  if (Date.now() > expiresAt) return null;

  // Check idle timeout
  const lastActive = new Date(session.last_active_at as string).getTime();
  if (Date.now() - lastActive > config.adminIdleTimeoutMs) return null;

  // Check user active
  const user = db
    .prepare("SELECT * FROM admin_users WHERE id = ?")
    .get(session.admin_user_id as string) as Record<string, unknown> | undefined;

  if (!user || (user.is_active as number) !== 1) return null;

  // Touch last_active_at
  const now = new Date().toISOString();
  db.prepare("UPDATE admin_sessions SET last_active_at = ? WHERE id = ?").run(
    now,
    token,
  );

  return rowToAdminUser(user);
}

/**
 * Destroy a single admin session.
 *
 * @param db - Database instance.
 * @param token - Session token to destroy.
 */
export function destroyAdminSession(
  db: DatabaseType,
  token: string,
): void {
  db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(token);
}

/**
 * Destroy all sessions for a given admin user.
 *
 * @param db - Database instance.
 * @param adminUserId - The admin user's id.
 */
export function destroyAllAdminSessions(
  db: DatabaseType,
  adminUserId: string,
): void {
  db.prepare("DELETE FROM admin_sessions WHERE admin_user_id = ?").run(
    adminUserId,
  );
}

/**
 * Delete all expired admin sessions from the database.
 *
 * @param db - Database instance.
 * @returns Number of sessions deleted.
 */
export function cleanupExpiredSessions(db: DatabaseType): number {
  const now = new Date().toISOString();
  const result = db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  return result.changes;
}

/**
 * Seed an initial admin user from environment variables on first start.
 *
 * Reads `ADMIN_INITIAL_USERNAME` and `ADMIN_INITIAL_PASSWORD` from
 * `process.env`. If both are set and no admin users exist yet, creates the
 * admin.
 *
 * @param db - Database instance.
 */
export function seedInitialAdmin(db: DatabaseType): void {
  const username = process.env.ADMIN_INITIAL_USERNAME;
  const password = process.env.ADMIN_INITIAL_PASSWORD;

  if (!username || !password) return;

  const count = db
    .prepare("SELECT COUNT(*) as cnt FROM admin_users")
    .get() as { cnt: number };

  if (count.cnt > 0) return;

  createAdmin(db, username, password);
}
