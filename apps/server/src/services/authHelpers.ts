/**
 * Shared authentication helpers for admin and user login flows.
 *
 * Consolidates security-critical logic (account locking, failed login tracking,
 * session eviction) that was previously duplicated across adminAuth.ts,
 * userAuth.ts, and oauth.ts. Ensures a bug fix or security patch is applied
 * once rather than in multiple places.
 *
 * Note: The `table` parameter is always a compile-time string literal
 * ("admin_users" or "users"), never user input.
 */

import bcrypt from "bcryptjs";
import type { Database as DatabaseType } from "better-sqlite3";

/** Known-safe login error messages that can be forwarded to the client. */
export const SAFE_LOGIN_ERRORS = new Set([
  "Invalid credentials",
  "Account is temporarily locked",
  "Invalid verification code",
  "Invalid recovery code",
  "Pending token expired or invalid",
]);

/**
 * Check if an account is locked and handle lock expiry.
 *
 * On the active-lock path, runs a dummy bcrypt comparison to prevent timing
 * leaks. On the expired-lock and no-lock paths, returns false immediately —
 * callers are responsible for running the real `bcrypt.compareSync` afterward
 * to maintain constant-time behaviour.
 *
 * @param db - Database instance.
 * @param table - Table name ("admin_users" or "users") — always a compile-time literal, never user input.
 * @param id - The account's primary key.
 * @param lockedUntil - The locked_until field value (ISO string or null).
 * @param dummyHash - Pre-computed bcrypt hash for constant-time comparison.
 * @param password - The submitted password (used only for timing-safe comparison).
 * @returns true if the account is currently locked, false if unlocked or lock expired.
 */
export function isAccountLocked(
  db: DatabaseType,
  table: "admin_users" | "users",
  id: string,
  lockedUntil: string | null | undefined,
  dummyHash: string,
  password: string,
): boolean {
  if (table !== "admin_users" && table !== "users") throw new Error("Invalid table");
  if (!lockedUntil) return false;

  const lockedUntilMs = new Date(lockedUntil).getTime();
  if (Date.now() < lockedUntilMs) {
    bcrypt.compareSync(password, dummyHash);
    return true;
  }

  // Lock expired — reset
  db.prepare(
    `UPDATE ${table} SET locked_until = NULL, failed_login_count = 0 WHERE id = ?`,
  ).run(id);
  return false;
}

/**
 * Record a failed login attempt, locking the account if the threshold is reached.
 *
 * @param db - Database instance.
 * @param table - Table name ("admin_users" or "users") — always a compile-time literal, never user input.
 * @param id - The account's primary key.
 * @param currentFailedCount - Current failed_login_count from the DB row.
 * @param maxAttempts - Maximum allowed failed attempts before locking.
 * @param lockDurationMs - Duration of the lockout in milliseconds.
 */
export function recordFailedLogin(
  db: DatabaseType,
  table: "admin_users" | "users",
  id: string,
  currentFailedCount: number,
  maxAttempts: number,
  lockDurationMs: number,
): void {
  if (table !== "admin_users" && table !== "users") throw new Error("Invalid table");
  const newCount = currentFailedCount + 1;
  if (newCount >= maxAttempts) {
    const lockedUntil = new Date(Date.now() + lockDurationMs).toISOString();
    db.prepare(
      `UPDATE ${table} SET failed_login_count = ?, locked_until = ? WHERE id = ?`,
    ).run(newCount, lockedUntil, id);
  } else {
    db.prepare(
      `UPDATE ${table} SET failed_login_count = ? WHERE id = ?`,
    ).run(newCount, id);
  }
}

/**
 * Record a successful login — reset failed count, clear lock, update last_login_at.
 *
 * @param db - Database instance.
 * @param table - Table name ("admin_users" or "users") — always a compile-time literal, never user input.
 * @param id - The account's primary key.
 */
export function recordSuccessfulLogin(
  db: DatabaseType,
  table: "admin_users" | "users",
  id: string,
): void {
  if (table !== "admin_users" && table !== "users") throw new Error("Invalid table");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ${table} SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, id);
}

/**
 * Evict the oldest user sessions when the max concurrent limit is reached.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param maxSessions - Maximum allowed concurrent sessions.
 */
export function evictOldestSessions(
  db: DatabaseType,
  userId: string,
  maxSessions: number,
): void {
  db.transaction(() => {
    const sessions = db
      .prepare("SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as { id: string }[];

    if (sessions.length >= maxSessions) {
      const toEvict = sessions.slice(0, sessions.length - maxSessions + 1);
      const deleteStmt = db.prepare("DELETE FROM user_sessions WHERE id = ?");
      for (const s of toEvict) {
        deleteStmt.run(s.id);
      }
    }
  })();
}
