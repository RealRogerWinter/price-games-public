/**
 * User authentication service.
 *
 * Handles user registration, login with account locking, session management
 * (create / validate / destroy), email verification, password/email changes,
 * and session limits. Mirrors the adminAuth pattern but with user-specific
 * behaviour (e.g. login by email or username, max concurrent sessions).
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import type { UserAccount, Avatar } from "@price-game/shared";
import { isValidProfileAvatar } from "@price-game/shared";
import { config } from "../config";
import { validateUsername } from "./inputSanitizer";
import { UserFacingError } from "./errors";
import { isAccountLocked, recordFailedLogin, recordSuccessfulLogin, evictOldestSessions } from "./authHelpers";
import { isReservedByGhost } from "./ghostUsers/reservedNames";
import { generateReferralCode, creditReferralOnVerify } from "./referrals";

export type { UserAccount };

// ── Constants ──────────────────────────────────────────────────────────────

/** Dummy bcrypt hash for constant-time comparison — prevents timing attacks. */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), config.userBcryptRounds);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map a database row to a public UserAccount object (no hash exposure).
 *
 * @param row - Raw database row.
 * @returns A UserAccount with no sensitive fields.
 */
export function rowToUserAccount(row: Record<string, unknown>): UserAccount {
  return {
    id: row.id as string,
    username: row.username as string,
    email: row.email as string,
    emailVerified: (row.email_verified as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastLoginAt: (row.last_login_at as string) ?? null,
    isActive: (row.is_active as number) === 1,
    lifetimeScore: (row.lifetime_score as number) ?? 0,
    usernamePending: (row.username_pending as number) === 1,
    referralCode: (row.referral_code as string) ?? "",
    avatar: (row.avatar as Avatar | null) ?? null,
  };
}

/**
 * Validate an email address format.
 *
 * @param email - Email string to validate.
 * @returns true if the format is valid.
 */
function isValidEmail(email: string): boolean {
  // Simple but effective email regex
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * A small set of trivially-weak passwords we reject regardless of length.
 * Sourced from common-password lists. The full mitigation is bcrypt + rate
 * limiting + lockout, but length-only validation let `aaaaaaaaaa` through —
 * see PR3 sec M3. This denylist is intentionally tiny: the goal is to
 * block obviously-trivial choices, not to be a comprehensive credential-
 * stuffing defense (HaveIBeenPwned-style integrations are a follow-up).
 */
const COMMON_WEAK_PASSWORDS = new Set<string>([
  "password", "password1", "password12", "password123", "password1234", "password12345",
  "passw0rd", "passw0rd1", "passw0rd123",
  "qwerty", "qwerty123", "qwerty1234", "qwertyuiop",
  "1234567890", "12345678901", "123456789012",
  "letmein", "letmein123", "letmeinplease",
  "welcome", "welcome1", "welcome123",
  "iloveyou", "iloveyou1", "ilovegames", "iloveyou12",
  "abc12345", "abc123456", "abcdef1234",
  "admin1234", "admin12345", "administrator",
  "trustno1234", "monkey1234", "dragon1234",
  "pricegames", "pricegames1", "pricegame123",
]);

/**
 * Reject obviously weak passwords. Length is already validated by the
 * caller; this function adds composition checks beyond length:
 *
 *   - reject passwords with fewer than 4 unique characters (catches
 *     `aaaaaaaaaa`, `ababababab`, and similar low-entropy patterns)
 *   - reject the password if it equals or contains the username/email
 *     local-part case-insensitively
 *   - reject a small denylist of common passwords (above)
 *
 * Full credential-stuffing defense lives at the rate-limit + lockout layer.
 * This is meant to stop the obviously-trivial class of choices (PR3 sec M3).
 *
 * @throws UserFacingError if the password fails any check.
 */
export function validatePasswordStrength(password: string, username?: string, email?: string): void {
  // All-same-character: detect by checking unique-character count.
  const uniqueChars = new Set(password).size;
  if (uniqueChars < 4) {
    throw new UserFacingError("Password is too simple — please choose something less repetitive");
  }

  const lower = password.toLowerCase();

  // Username / email-local-part inclusion. We compare lowercase substring
  // both ways so 'JohnDoe2026!' is rejected if the username is 'johndoe'.
  if (username && username.length >= 3) {
    const u = username.toLowerCase();
    if (lower.includes(u) || u.includes(lower)) {
      throw new UserFacingError("Password must not contain your username");
    }
  }
  if (email) {
    const localPart = email.toLowerCase().split("@")[0];
    if (localPart && localPart.length >= 3 && lower.includes(localPart)) {
      throw new UserFacingError("Password must not contain your email address");
    }
  }

  if (COMMON_WEAK_PASSWORDS.has(lower)) {
    throw new UserFacingError("This password is too common — please choose a stronger password");
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a new user account.
 *
 * Validates username (via validateUsername), email format, and password length.
 * Hashes password with bcrypt. Stores username with original casing and a
 * lowercase normalized copy for uniqueness checks.
 *
 * @param db - Database instance.
 * @param username - Desired username (3-20 chars, alphanumeric + underscore).
 * @param email - Email address.
 * @param password - Plain-text password (10-128 chars).
 * @returns The created UserAccount (without password hash).
 * @throws UserFacingError on validation failure or duplicate username/email.
 */
export function createUser(
  db: DatabaseType,
  username: string,
  email: string,
  password: string,
): UserAccount {
  // Validate username (strips HTML, checks format, profanity, reserved words)
  const cleanUsername = validateUsername(username);
  const normalizedUsername = cleanUsername.toLowerCase();

  // Validate email
  if (!email || typeof email !== "string") {
    throw new UserFacingError("Email is required");
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    throw new UserFacingError("Invalid email format");
  }

  // Validate password length and minimum strength.
  if (!password || typeof password !== "string") {
    throw new UserFacingError("Password is required");
  }
  if (password.length < config.userMinPasswordLength) {
    throw new UserFacingError(`Password must be at least ${config.userMinPasswordLength} characters`);
  }
  if (password.length > config.userMaxPasswordLength) {
    throw new UserFacingError(`Password must be at most ${config.userMaxPasswordLength} characters`);
  }
  validatePasswordStrength(password, cleanUsername, normalizedEmail);

  // PR3 sec M1: do not reveal WHICH field collides. Distinct error
  // messages for "username taken" vs "email already in use" let an
  // unauthenticated attacker enumerate registered emails or usernames
  // by registration probe — contradicting the carefully enum-safe
  // /forgot-password path. A single generic message handles both.
  // Username collisions also include the ghost_users table (globally
  // reserved so a real user can't register a name owned by a synthetic
  // ghost identity).
  const existingUsername = db
    .prepare("SELECT id FROM users WHERE username_normalized = ?")
    .get(normalizedUsername);
  const usernameReserved = existingUsername || isReservedByGhost(db, normalizedUsername);
  const existingEmail = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(normalizedEmail);
  if (usernameReserved || existingEmail) {
    throw new UserFacingError("That username or email is already in use");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, config.userBcryptRounds);

  // Insert user and assign referral code atomically
  const referralCode = generateReferralCode(db);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, referral_code, created_at, updated_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, cleanUsername, normalizedUsername, normalizedEmail, hash, referralCode, now, now);
  })();

  return {
    id,
    username: cleanUsername,
    email: normalizedEmail,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    isActive: true,
    lifetimeScore: 0,
    usernamePending: false,
    referralCode,
    avatar: null,
  };
}

/**
 * Authenticate a user and create a session.
 *
 * Accepts login by email (if identifier contains '@') or by username.
 * Uses constant-time bcrypt comparison even for non-existent users.
 * Implements account locking after 5 failed attempts (15-minute lockout).
 * Enforces max 5 concurrent sessions (evicts oldest on 6th).
 *
 * @param db - Database instance.
 * @param identifier - Email or username.
 * @param password - Plain-text password.
 * @param ip - Optional IP address for the session.
 * @param userAgent - Optional user-agent string.
 * @param stayLoggedIn - When true (default, for backwards compatibility
 *                       with pre-flag callers) the session lasts
 *                       `userSessionDurationMs` (30 days). When false
 *                       the session is capped to
 *                       `userShortSessionDurationMs` (24 hours) — used
 *                       in combination with a browser-session cookie
 *                       so the session genuinely ends at browser close.
 * @returns An object with `token` (session id) and `user` (UserAccount).
 * @throws Error on invalid credentials, locked or disabled account.
 */
export function userLogin(
  db: DatabaseType,
  identifier: string,
  password: string,
  ip?: string,
  userAgent?: string,
  stayLoggedIn: boolean = true,
): { token: string; user: UserAccount } {
  const trimmed = identifier.trim();
  const isEmail = trimmed.includes("@");

  let row: Record<string, unknown> | undefined;
  if (isEmail) {
    row = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(trimmed.toLowerCase()) as Record<string, unknown> | undefined;
  } else {
    row = db
      .prepare("SELECT * FROM users WHERE username_normalized = ?")
      .get(trimmed.toLowerCase()) as Record<string, unknown> | undefined;
  }

  if (!row) {
    // Constant-time: run bcrypt even for non-existent users to prevent timing attacks
    bcrypt.compareSync(password, DUMMY_HASH);
    throw new UserFacingError("Invalid credentials");
  }

  // Check disabled — still run bcrypt to prevent timing leak
  if ((row.is_active as number) !== 1) {
    bcrypt.compareSync(password, DUMMY_HASH);
    throw new UserFacingError("Invalid credentials");
  }

  // Check locked — still run bcrypt to prevent timing leak
  if (isAccountLocked(db, "users", row.id as string, row.locked_until as string | null, DUMMY_HASH, password)) {
    throw new UserFacingError("Account is temporarily locked");
  }

  // OAuth-only accounts cannot use password login
  if (row.password_hash === "OAUTH_NO_PASSWORD") {
    bcrypt.compareSync(password, DUMMY_HASH); // constant-time
    throw new UserFacingError("Invalid credentials");
  }

  // Verify password
  const valid = bcrypt.compareSync(password, row.password_hash as string);
  if (!valid) {
    recordFailedLogin(db, "users", row.id as string, (row.failed_login_count as number) ?? 0, config.userMaxFailedLogins, config.userLockoutDurationMs);
    throw new UserFacingError("Invalid credentials");
  }

  // Successful — reset failed count, update last_login_at
  recordSuccessfulLogin(db, "users", row.id as string);
  const now = new Date().toISOString();

  // Enforce max concurrent sessions: evict oldest if at limit
  evictOldestSessions(db, row.id as string, config.userMaxSessions);

  // Create session
  const token = crypto.randomBytes(32).toString("hex");
  const sessionDurationMs = stayLoggedIn
    ? config.userSessionDurationMs
    : config.userShortSessionDurationMs;
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();

  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, row.id as string, ip ?? null, userAgent ?? null, now, expiresAt, now);

  // Re-read to capture updated fields
  const updated = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(row.id as string) as Record<string, unknown>;

  return { token, user: rowToUserAccount(updated) };
}

/**
 * Validate a user session token.
 *
 * Checks existence, absolute expiry (set at login time — either
 * `userSessionDurationMs` for persistent sessions or
 * `userShortSessionDurationMs` for "stay logged in unchecked" sessions),
 * idle timeout (`userIdleTimeoutMs`, 7 days by default), and that the
 * owning user is still active. On success, updates `last_active_at`
 * (throttled) and returns the UserAccount.
 *
 * @param db - Database instance.
 * @param token - Session token (the session id).
 * @returns UserAccount if valid, or null.
 */
export function validateUserSession(
  db: DatabaseType,
  token: string,
): UserAccount | null {
  const session = db
    .prepare("SELECT * FROM user_sessions WHERE id = ?")
    .get(token) as Record<string, unknown> | undefined;

  if (!session) return null;

  // Check absolute expiration
  const expiresAt = new Date(session.expires_at as string).getTime();
  if (Date.now() > expiresAt) return null;

  // Check idle timeout
  const lastActive = new Date(session.last_active_at as string).getTime();
  if (Date.now() - lastActive > config.userIdleTimeoutMs) return null;

  // Check user active
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(session.user_id as string) as Record<string, unknown> | undefined;

  if (!user || (user.is_active as number) !== 1) return null;

  // Throttle last_active_at updates to once per 5 minutes to reduce write load
  const fiveMinutesMs = 5 * 60 * 1000;
  if (Date.now() - lastActive > fiveMinutesMs) {
    const now = new Date().toISOString();
    db.prepare("UPDATE user_sessions SET last_active_at = ? WHERE id = ?").run(
      now,
      token,
    );
  }

  return rowToUserAccount(user);
}

/**
 * Destroy a single user session.
 *
 * @param db - Database instance.
 * @param token - Session token to destroy.
 */
export function destroyUserSession(
  db: DatabaseType,
  token: string,
): void {
  db.prepare("DELETE FROM user_sessions WHERE id = ?").run(token);
}

/**
 * Destroy all sessions for a given user, optionally keeping one.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param exceptToken - If provided, keep this session alive.
 */
export function destroyAllUserSessions(
  db: DatabaseType,
  userId: string,
  exceptToken?: string,
): void {
  if (exceptToken) {
    db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND id != ?").run(
      userId,
      exceptToken,
    );
  } else {
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
  }
}

/**
 * Delete all expired user sessions from the database.
 *
 * @param db - Database instance.
 * @returns Number of sessions deleted.
 */
export function cleanupExpiredUserSessions(db: DatabaseType): number {
  const now = new Date().toISOString();
  const idleThreshold = new Date(Date.now() - config.userIdleTimeoutMs).toISOString();
  const result = db.prepare(
    "DELETE FROM user_sessions WHERE expires_at <= ? OR last_active_at <= ?",
  ).run(now, idleThreshold);
  return result.changes;
}

/**
 * Create an email verification token for a user.
 *
 * Invalidates any previous unused tokens for this user. Generates a 32-byte
 * hex token with 24-hour expiry.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param email - The email address to verify.
 * @returns The generated verification token.
 */
/**
 * Hash a token with SHA-256 for secure storage.
 *
 * @param token - Raw token string.
 * @returns Hex-encoded SHA-256 hash.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createEmailVerificationToken(
  db: DatabaseType,
  userId: string,
  email: string,
): string {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const id = uuidv4();

  db.transaction(() => {
    // Invalidate previous unused tokens for this user
    db.prepare(
      "UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(now, userId);

    db.prepare(
      `INSERT INTO email_verification_tokens (id, user_id, token, email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, tokenHash, email.toLowerCase(), now, expiresAt);
  })();

  return token;
}

/**
 * Verify an email using a verification token.
 *
 * Validates the token exists, is unused, and not expired. Marks the token as
 * used and sets email_verified = 1 on the user.
 *
 * @param db - Database instance.
 * @param token - The verification token string.
 * @returns true if verification succeeded, false otherwise.
 */
export function verifyEmail(
  db: DatabaseType,
  token: string,
): boolean {
  const tokenHash = hashToken(token);
  const row = db
    .prepare("SELECT * FROM email_verification_tokens WHERE token = ?")
    .get(tokenHash) as Record<string, unknown> | undefined;

  // Combine all failure conditions into a single code path to avoid timing leaks
  if (!row || row.used_at || Date.now() > new Date(row.expires_at as string).getTime()) {
    return false;
  }

  const now = new Date().toISOString();

  const userId = row.user_id as string;

  db.transaction(() => {
    // Mark token as used
    db.prepare("UPDATE email_verification_tokens SET used_at = ? WHERE id = ?").run(
      now,
      row.id as string,
    );

    // Set email_verified on the user
    db.prepare("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?").run(
      now,
      userId,
    );

    // Credit any pending referral for this user
    creditReferralOnVerify(db, userId);
  })();

  return true;
}

/**
 * Change a user's password.
 *
 * Verifies the current password, hashes the new one, and destroys all other
 * sessions (keeping the current one if a token is provided via the caller).
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param currentPassword - Current plain-text password for verification.
 * @param newPassword - New plain-text password.
 * @throws UserFacingError on validation failure.
 */
export function changePassword(
  db: DatabaseType,
  userId: string,
  currentPassword: string,
  newPassword: string,
): void {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;

  if (!user) {
    throw new UserFacingError("User not found");
  }

  // Verify current password
  const valid = bcrypt.compareSync(currentPassword, user.password_hash as string);
  if (!valid) {
    throw new UserFacingError("Current password is incorrect");
  }

  // Validate new password length and strength
  if (newPassword.length < config.userMinPasswordLength) {
    throw new UserFacingError(`Password must be at least ${config.userMinPasswordLength} characters`);
  }
  if (newPassword.length > config.userMaxPasswordLength) {
    throw new UserFacingError(`Password must be at most ${config.userMaxPasswordLength} characters`);
  }
  validatePasswordStrength(newPassword, user.username as string, user.email as string);

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(newPassword, config.userBcryptRounds);

  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      hash,
      now,
      userId,
    );

    // Destroy all sessions — caller re-creates one via userLogin afterward
    destroyAllUserSessions(db, userId);
  })();
}

/**
 * Change a user's email address.
 *
 * Verifies the password, checks new email uniqueness, updates the email,
 * resets email_verified, and creates a new verification token.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param newEmail - New email address.
 * @param password - Current plain-text password for verification.
 * @returns The verification token for the new email.
 * @throws UserFacingError on validation failure.
 */
export function changeEmail(
  db: DatabaseType,
  userId: string,
  newEmail: string,
  password: string,
): string {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;

  if (!user) {
    throw new UserFacingError("User not found");
  }

  // Verify password
  const valid = bcrypt.compareSync(password, user.password_hash as string);
  if (!valid) {
    throw new UserFacingError("Password is incorrect");
  }

  // Validate email format
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    throw new UserFacingError("Invalid email format");
  }

  // Check uniqueness
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ? AND id != ?")
    .get(normalizedEmail, userId);
  if (existing) {
    // PR3 sec M1: same generic message as createUser so the change-email
    // path doesn't leak whether a target email is already registered.
    // Lower-risk than register (requires a valid session) but kept
    // consistent for defense in depth.
    throw new UserFacingError("That email is already in use");
  }

  const now = new Date().toISOString();

  db.prepare(
    "UPDATE users SET email = ?, email_verified = 0, updated_at = ? WHERE id = ?",
  ).run(normalizedEmail, now, userId);

  // Create a new verification token for the new email
  return createEmailVerificationToken(db, userId, normalizedEmail);
}

/**
 * Change a user's username. Used by OAuth users to choose their initial
 * username, or by any user with username_pending set.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param newUsername - Desired new username.
 * @returns The updated UserAccount.
 * @throws UserFacingError on validation failure or duplicate username.
 */
export function changeUsername(
  db: DatabaseType,
  userId: string,
  newUsername: string,
): UserAccount {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;
  if (!user) {
    throw new UserFacingError("User not found");
  }
  if ((user.username_pending as number) !== 1) {
    throw new UserFacingError("Username change is not available");
  }

  const cleanUsername = validateUsername(newUsername);
  const normalizedUsername = cleanUsername.toLowerCase();

  // Check for duplicate username (normalized) — covers both real users
  // and ghost-reserved names per the global-reservation invariant.
  const existing = db
    .prepare("SELECT id FROM users WHERE username_normalized = ? AND id != ?")
    .get(normalizedUsername, userId);
  if (existing) {
    throw new UserFacingError("Username already exists");
  }
  if (isReservedByGhost(db, normalizedUsername)) {
    throw new UserFacingError("Username already exists");
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE users SET username = ?, username_normalized = ?, username_pending = 0, updated_at = ? WHERE id = ?",
  ).run(cleanUsername, normalizedUsername, now, userId);

  const updatedRow = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown>;
  return rowToUserAccount(updatedRow);
}

/**
 * Change a user's avatar preference.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param avatar - A valid profile avatar name, or null to clear.
 * @returns The updated UserAccount.
 * @throws UserFacingError if the avatar name is invalid or user not found.
 */
export function changeAvatar(
  db: DatabaseType,
  userId: string,
  avatar: string | null,
): UserAccount {
  if (avatar !== null && !isValidProfileAvatar(avatar)) {
    throw new UserFacingError("Invalid avatar");
  }
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE users SET avatar = ?, updated_at = ? WHERE id = ? AND is_active = 1")
    .run(avatar, now, userId);
  if (result.changes === 0) {
    throw new UserFacingError("User not found");
  }
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown>;
  return rowToUserAccount(row);
}

/**
 * Create a password reset token for a user.
 *
 * Invalidates any previous unused tokens for this user. Generates a 32-byte
 * hex token with 1-hour expiry.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @returns The generated reset token.
 */
export function createPasswordResetToken(
  db: DatabaseType,
  userId: string,
): string {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const id = uuidv4();

  db.transaction(() => {
    // Invalidate previous unused tokens for this user
    db.prepare(
      "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(now, userId);

    db.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, tokenHash, now, expiresAt);
  })();

  return token;
}

/**
 * Reset a user's password using a reset token.
 *
 * Validates the token exists, is unused, and not expired. Sets the new
 * password hash and destroys all existing sessions.
 *
 * @param db - Database instance.
 * @param token - The password reset token string.
 * @param newPassword - New plain-text password.
 * @returns true if reset succeeded, false if token is invalid/expired.
 * @throws UserFacingError on password validation failure.
 */
export function resetPassword(
  db: DatabaseType,
  token: string,
  newPassword: string,
): boolean {
  const tokenHash = hashToken(token);
  const row = db
    .prepare("SELECT * FROM password_reset_tokens WHERE token = ?")
    .get(tokenHash) as Record<string, unknown> | undefined;

  // Combine all failure conditions into a single code path to avoid timing leaks
  if (!row || row.used_at || Date.now() > new Date(row.expires_at as string).getTime()) {
    return false;
  }

  // Validate new password length and strength
  if (!newPassword || typeof newPassword !== "string") {
    throw new UserFacingError("Password is required");
  }
  if (newPassword.length < config.userMinPasswordLength) {
    throw new UserFacingError(`Password must be at least ${config.userMinPasswordLength} characters`);
  }
  if (newPassword.length > config.userMaxPasswordLength) {
    throw new UserFacingError(`Password must be at most ${config.userMaxPasswordLength} characters`);
  }
  // Look up username + email for the strength comparison so the password
  // can't trivially equal them.
  const userRow = db
    .prepare("SELECT username, email FROM users WHERE id = ?")
    .get(row.user_id as string) as { username: string; email: string } | undefined;
  if (userRow) {
    validatePasswordStrength(newPassword, userRow.username, userRow.email);
  }

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(newPassword, config.userBcryptRounds);
  const userId = row.user_id as string;

  db.transaction(() => {
    // Mark token as used
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(
      now,
      row.id as string,
    );

    // Update password
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      hash,
      now,
      userId,
    );

    // Destroy all sessions
    destroyAllUserSessions(db, userId);
  })();

  return true;
}

/**
 * Delete expired or used password reset and email verification tokens.
 *
 * @param db - Database instance.
 * @returns Number of tokens deleted.
 */
export function cleanupExpiredTokens(db: DatabaseType): number {
  const now = new Date().toISOString();
  const r1 = db.prepare(
    "DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
  ).run(now);
  const r2 = db.prepare(
    "DELETE FROM email_verification_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
  ).run(now);
  return r1.changes + r2.changes;
}

/**
 * Find a user by email address.
 *
 * @param db - Database instance.
 * @param email - Email to look up (case-insensitive).
 * @returns The user row or null if not found.
 */
export function findUserByEmail(
  db: DatabaseType,
  email: string,
): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ?? null;
}
