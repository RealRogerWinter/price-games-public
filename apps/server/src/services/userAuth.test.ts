/**
 * Tests for the user authentication service.
 *
 * Covers registration, login (with locking and identifier detection),
 * session validation (expiration, idle timeout, inactive user, max sessions),
 * session destruction, email verification, password change, and email change.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test/dbHelper";
import {
  createUser,
  userLogin,
  validateUserSession,
  destroyUserSession,
  destroyAllUserSessions,
  cleanupExpiredUserSessions,
  createEmailVerificationToken,
  verifyEmail,
  changePassword,
  changeEmail,
  changeAvatar,
  createPasswordResetToken,
  resetPassword,
  findUserByEmail,
  cleanupExpiredTokens,
} from "./userAuth";
import { config } from "../config";
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ── Registration ──────────────────────────────────────────────────────────

describe("createUser", () => {
  it("creates a valid user and returns UserAccount without hash", () => {
    const user = createUser(db, "TestUser", "test@example.com", "T3stP@ss-w0rd!");

    expect(user.id).toBeDefined();
    expect(user.username).toBe("TestUser");
    expect(user.email).toBe("test@example.com");
    expect(user.emailVerified).toBe(false);
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toBeDefined();
    expect(user.updatedAt).toBeDefined();
    expect(user.lastLoginAt).toBeNull();
    expect(user.lifetimeScore).toBe(0);
    // No hash exposed
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((user as Record<string, unknown>).password_hash).toBeUndefined();
  });

  it("preserves original casing for username", () => {
    const user = createUser(db, "MyUser123", "u@example.com", "T3stP@ss-w0rd!");
    expect(user.username).toBe("MyUser123");
  });

  it("stores username_normalized as lowercase", () => {
    createUser(db, "MyUser123", "u@example.com", "T3stP@ss-w0rd!");
    const row = db.prepare("SELECT username_normalized FROM users WHERE username = ?").get("MyUser123") as any;
    expect(row.username_normalized).toBe("myuser123");
  });

  it("stores email as lowercase", () => {
    const user = createUser(db, "testuser", "Test@Example.COM", "T3stP@ss-w0rd!");
    expect(user.email).toBe("test@example.com");
  });

  it("rejects duplicate username (case-insensitive) without revealing the username collided (PR3 sec M1)", () => {
    createUser(db, "testuser", "a@example.com", "T3stP@ss-w0rd!");
    expect(() => createUser(db, "TestUser", "b@example.com", "T3stP@ss-w0rd!")).toThrow(
      /username or email is already in use/,
    );
  });

  it("rejects duplicate email without revealing the email collided (PR3 sec M1)", () => {
    createUser(db, "user1", "same@example.com", "T3stP@ss-w0rd!");
    expect(() => createUser(db, "user2", "same@example.com", "T3stP@ss-w0rd!")).toThrow(
      /username or email is already in use/,
    );
  });

  it("rejects profane username", () => {
    expect(() => createUser(db, "fuck_you", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "not allowed",
    );
  });

  it("rejects short password", () => {
    expect(() => createUser(db, "testuser", "a@example.com", "short")).toThrow(
      /Password must be at least/,
    );
  });

  it("rejects long password", () => {
    const longPass = "a".repeat(config.userMaxPasswordLength + 1);
    expect(() => createUser(db, "testuser", "a@example.com", longPass)).toThrow(
      /Password must be at most/,
    );
  });

  // PR3 sec M3: length-only validation let trivial passwords through
  // (`aaaaaaaaaa`, `password1234`). The strength check rejects the
  // obviously-trivial class.
  it("rejects all-same-character passwords", () => {
    expect(() => createUser(db, "testuser", "a@example.com", "aaaaaaaaaa")).toThrow(
      /too simple/,
    );
  });

  it("rejects common passwords from the denylist", () => {
    expect(() => createUser(db, "testuser", "a@example.com", "password1234")).toThrow(
      /too common/,
    );
    expect(() => createUser(db, "testuser2", "b@example.com", "qwerty1234")).toThrow(
      /too common/,
    );
  });

  it("rejects a password that contains the username", () => {
    expect(() => createUser(db, "johndoe", "j@example.com", "johndoe2026X@!")).toThrow(
      /must not contain your username/,
    );
  });

  it("rejects a password that contains the email local-part", () => {
    expect(() => createUser(db, "user42", "specificname@example.com", "specificname9X@!")).toThrow(
      /must not contain your email/,
    );
  });

  it("rejects invalid characters in username", () => {
    expect(() => createUser(db, "user name", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "may only contain",
    );
    expect(() => createUser(db, "user@name", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "may only contain",
    );
  });

  it("rejects username shorter than 3 chars", () => {
    expect(() => createUser(db, "ab", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "at least 3",
    );
  });

  it("rejects reserved usernames", () => {
    expect(() => createUser(db, "admin", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "reserved",
    );
    expect(() => createUser(db, "System", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "reserved",
    );
    expect(() => createUser(db, "moderator", "a@example.com", "T3stP@ss-w0rd!")).toThrow(
      "reserved",
    );
  });

  it("rejects invalid email format", () => {
    expect(() => createUser(db, "testuser", "not-an-email", "T3stP@ss-w0rd!")).toThrow(
      "Invalid email format",
    );
    expect(() => createUser(db, "testuser", "", "T3stP@ss-w0rd!")).toThrow(
      "Email is required",
    );
  });
});

// ── Login ─────────────────────────────────────────────────────────────────

describe("userLogin", () => {
  const USERNAME = "loginuser";
  const EMAIL = "login@example.com";
  const PASSWORD = "C0rr3ctP@ss!";

  beforeEach(() => {
    createUser(db, USERNAME, EMAIL, PASSWORD);
  });

  it("returns token and user for correct credentials via email", () => {
    const result = userLogin(db, EMAIL, PASSWORD);

    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.user.username).toBe(USERNAME);
    expect(result.user.email).toBe(EMAIL);
    expect(result.user.isActive).toBe(true);
  });

  it("returns token and user for correct credentials via username", () => {
    const result = userLogin(db, USERNAME, PASSWORD);

    expect(result.token).toBeDefined();
    expect(result.user.username).toBe(USERNAME);
  });

  it("username login is case-insensitive", () => {
    const result = userLogin(db, "LOGINUSER", PASSWORD);
    expect(result.user.username).toBe(USERNAME);
  });

  it("throws 'Invalid credentials' for wrong password", () => {
    expect(() => userLogin(db, EMAIL, "Wr0ngP@ss!")).toThrow("Invalid credentials");
  });

  it("throws 'Invalid credentials' for non-existent user", () => {
    expect(() => userLogin(db, "nobody@example.com", PASSWORD)).toThrow("Invalid credentials");
  });

  it("throws 'Invalid credentials' for disabled account", () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE username_normalized = ?").run(USERNAME);
    expect(() => userLogin(db, EMAIL, PASSWORD)).toThrow("Invalid credentials");
  });

  it("locks account after 5 failed attempts", () => {
    for (let i = 0; i < config.userMaxFailedLogins; i++) {
      try {
        userLogin(db, EMAIL, "Wr0ngP@ss!");
      } catch {
        // expected
      }
    }
    expect(() => userLogin(db, EMAIL, PASSWORD)).toThrow("Account is temporarily locked");
  });

  it("lockout expires and allows login", () => {
    // Lock the account
    for (let i = 0; i < config.userMaxFailedLogins; i++) {
      try { userLogin(db, EMAIL, "Wr0ngP@ss!"); } catch { /* expected */ }
    }

    // Manually expire the lockout
    db.prepare("UPDATE users SET locked_until = ? WHERE username_normalized = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      USERNAME,
    );

    // Should succeed now
    const result = userLogin(db, EMAIL, PASSWORD);
    expect(result.user.username).toBe(USERNAME);
  });

  it("successful login resets failed_login_count", () => {
    // Accumulate some failures
    for (let i = 0; i < config.userMaxFailedLogins - 1; i++) {
      try { userLogin(db, EMAIL, "Wr0ngP@ss!"); } catch { /* expected */ }
    }

    const before = db.prepare("SELECT failed_login_count FROM users WHERE username_normalized = ?").get(USERNAME) as any;
    expect(before.failed_login_count).toBe(config.userMaxFailedLogins - 1);

    userLogin(db, EMAIL, PASSWORD);

    const after = db.prepare("SELECT failed_login_count FROM users WHERE username_normalized = ?").get(USERNAME) as any;
    expect(after.failed_login_count).toBe(0);
  });

  it("updates last_login_at on success", () => {
    const before = db.prepare("SELECT last_login_at FROM users WHERE username_normalized = ?").get(USERNAME) as any;
    expect(before.last_login_at).toBeNull();

    userLogin(db, EMAIL, PASSWORD);

    const after = db.prepare("SELECT last_login_at FROM users WHERE username_normalized = ?").get(USERNAME) as any;
    expect(after.last_login_at).not.toBeNull();
  });

  // ── Stay logged in ─────────────────────────────────────────────────────
  // The session row's absolute expiry mirrors the user's choice at login
  // time. When stayLoggedIn=true (or omitted, for backwards compat) the
  // session lasts `userSessionDurationMs` (30 days by default). When
  // stayLoggedIn=false the session is capped to `userShortSessionDurationMs`
  // (24 hours by default) so even a stale browser can't hold a session
  // longer than the safety cap.

  it("session expires_at defaults to userSessionDurationMs when stayLoggedIn is omitted", () => {
    const before = Date.now();
    const { token } = userLogin(db, EMAIL, PASSWORD, "127.0.0.1", "test-agent");
    const after = Date.now();

    const row = db
      .prepare("SELECT expires_at FROM user_sessions WHERE id = ?")
      .get(token) as { expires_at: string };
    const expiresAt = new Date(row.expires_at).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + config.userSessionDurationMs - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + config.userSessionDurationMs + 1000);
  });

  it("session expires_at uses userSessionDurationMs when stayLoggedIn=true", () => {
    const before = Date.now();
    const { token } = userLogin(db, EMAIL, PASSWORD, "127.0.0.1", "test-agent", true);
    const after = Date.now();

    const row = db
      .prepare("SELECT expires_at FROM user_sessions WHERE id = ?")
      .get(token) as { expires_at: string };
    const expiresAt = new Date(row.expires_at).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + config.userSessionDurationMs - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + config.userSessionDurationMs + 1000);
  });

  it("session expires_at is capped to userShortSessionDurationMs when stayLoggedIn=false", () => {
    const before = Date.now();
    const { token } = userLogin(db, EMAIL, PASSWORD, "127.0.0.1", "test-agent", false);
    const after = Date.now();

    const row = db
      .prepare("SELECT expires_at FROM user_sessions WHERE id = ?")
      .get(token) as { expires_at: string };
    const expiresAt = new Date(row.expires_at).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + config.userShortSessionDurationMs - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + config.userShortSessionDurationMs + 1000);
    // And — crucially — shorter than the default 30-day duration
    expect(expiresAt).toBeLessThan(before + config.userSessionDurationMs);
  });
});

// ── Sessions ──────────────────────────────────────────────────────────────

describe("validateUserSession", () => {
  const USERNAME = "sessionuser";
  const EMAIL = "session@example.com";
  const PASSWORD = "securepass123";
  let token: string;

  beforeEach(() => {
    createUser(db, USERNAME, EMAIL, PASSWORD);
    const result = userLogin(db, EMAIL, PASSWORD);
    token = result.token;
  });

  it("returns UserAccount for valid session", () => {
    const user = validateUserSession(db, token);
    expect(user).not.toBeNull();
    expect(user!.username).toBe(USERNAME);
    expect(user!.isActive).toBe(true);
  });

  it("returns null for non-existent token", () => {
    expect(validateUserSession(db, "non-existent-token")).toBeNull();
  });

  it("returns null for expired session (absolute expiry)", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?").run(past, token);
    expect(validateUserSession(db, token)).toBeNull();
  });

  it("returns null for idle session", () => {
    // Set last_active_at beyond 7-day idle timeout
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE user_sessions SET last_active_at = ? WHERE id = ?").run(longAgo, token);
    expect(validateUserSession(db, token)).toBeNull();
  });

  it("returns null for deactivated user mid-session", () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE username_normalized = ?").run(USERNAME);
    expect(validateUserSession(db, token)).toBeNull();
  });

  it("touches last_active_at on valid access", () => {
    const before = db.prepare("SELECT last_active_at FROM user_sessions WHERE id = ?").get(token) as any;
    const beforeTime = new Date(before.last_active_at).getTime();

    const user = validateUserSession(db, token);
    expect(user).not.toBeNull();

    const after = db.prepare("SELECT last_active_at FROM user_sessions WHERE id = ?").get(token) as any;
    const afterTime = new Date(after.last_active_at).getTime();
    expect(afterTime).toBeGreaterThanOrEqual(beforeTime);
  });

  it("evicts oldest session when max concurrent sessions exceeded", () => {
    // Already have 1 session from beforeEach. Create more to reach the limit.
    const tokens: string[] = [token];
    for (let i = 1; i < config.userMaxSessions; i++) {
      const result = userLogin(db, EMAIL, PASSWORD);
      tokens.push(result.token);
    }

    // All sessions should be valid
    for (const t of tokens) {
      expect(validateUserSession(db, t)).not.toBeNull();
    }

    // Creating one more should evict the oldest
    const newResult = userLogin(db, EMAIL, PASSWORD);
    expect(validateUserSession(db, newResult.token)).not.toBeNull();

    // Oldest token should now be invalid
    expect(validateUserSession(db, tokens[0])).toBeNull();

    // Remaining tokens should still be valid
    for (let i = 1; i < tokens.length; i++) {
      expect(validateUserSession(db, tokens[i])).not.toBeNull();
    }
  });
});

// ── Logout ────────────────────────────────────────────────────────────────

describe("destroyUserSession / destroyAllUserSessions", () => {
  const USERNAME = "logoutuser";
  const EMAIL = "logout@example.com";
  const PASSWORD = "securepass123";

  it("destroys single session", () => {
    createUser(db, USERNAME, EMAIL, PASSWORD);
    const { token } = userLogin(db, EMAIL, PASSWORD);

    expect(validateUserSession(db, token)).not.toBeNull();
    destroyUserSession(db, token);
    expect(validateUserSession(db, token)).toBeNull();
  });

  it("destroys all sessions", () => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    const { token: t1 } = userLogin(db, EMAIL, PASSWORD);
    const { token: t2 } = userLogin(db, EMAIL, PASSWORD);

    expect(validateUserSession(db, t1)).not.toBeNull();
    expect(validateUserSession(db, t2)).not.toBeNull();

    destroyAllUserSessions(db, user.id);

    expect(validateUserSession(db, t1)).toBeNull();
    expect(validateUserSession(db, t2)).toBeNull();
  });

  it("destroys all sessions except current", () => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    const { token: t1 } = userLogin(db, EMAIL, PASSWORD);
    const { token: t2 } = userLogin(db, EMAIL, PASSWORD);
    const { token: t3 } = userLogin(db, EMAIL, PASSWORD);

    destroyAllUserSessions(db, user.id, t2);

    expect(validateUserSession(db, t1)).toBeNull();
    expect(validateUserSession(db, t2)).not.toBeNull();
    expect(validateUserSession(db, t3)).toBeNull();
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────

describe("cleanupExpiredUserSessions", () => {
  it("removes expired sessions and returns count", () => {
    createUser(db, "cleanup_user", "cleanup@example.com", "T3stP@ss-w0rd!");
    const { token } = userLogin(db, "cleanup@example.com", "T3stP@ss-w0rd!");

    // Expire the session
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      token,
    );

    const count = cleanupExpiredUserSessions(db);
    expect(count).toBe(1);
    expect(validateUserSession(db, token)).toBeNull();
  });
});

// ── Email verification ────────────────────────────────────────────────────

describe("email verification", () => {
  const USERNAME = "verifyuser";
  const EMAIL = "verify@example.com";
  const PASSWORD = "securepass123";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("creates a verification token", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64); // 32 bytes hex
  });

  it("successfully verifies email with valid token", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);
    const result = verifyEmail(db, token);
    expect(result).toBe(true);

    // Check email is now verified
    const row = db.prepare("SELECT email_verified FROM users WHERE id = ?").get(userId) as any;
    expect(row.email_verified).toBe(1);
  });

  it("returns false for expired token", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);

    // Expire the token (tokens are now stored hashed, so match by user_id)
    db.prepare("UPDATE email_verification_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL").run(
      new Date(Date.now() - 60_000).toISOString(),
      userId,
    );

    expect(verifyEmail(db, token)).toBe(false);
  });

  it("returns false for already-used token", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);
    expect(verifyEmail(db, token)).toBe(true);
    // Second use should fail
    expect(verifyEmail(db, token)).toBe(false);
  });

  it("returns false for non-existent token", () => {
    expect(verifyEmail(db, "nonexistent")).toBe(false);
  });

  it("invalidates previous tokens when creating a new one", () => {
    const token1 = createEmailVerificationToken(db, userId, EMAIL);
    const token2 = createEmailVerificationToken(db, userId, EMAIL);

    // First token should be invalidated (marked as used)
    expect(verifyEmail(db, token1)).toBe(false);
    // Second token should still work
    expect(verifyEmail(db, token2)).toBe(true);
  });
});

// ── Password change ──────────────────────────────────────────────────────

describe("changePassword", () => {
  const USERNAME = "pwchange";
  const EMAIL = "pw@example.com";
  const PASSWORD = "oldpassword1";
  const NEW_PASSWORD = "newpassword1";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("changes password and allows login with new password", () => {
    changePassword(db, userId, PASSWORD, NEW_PASSWORD);

    // Old password should fail
    expect(() => userLogin(db, EMAIL, PASSWORD)).toThrow("Invalid credentials");

    // New password should work
    const result = userLogin(db, EMAIL, NEW_PASSWORD);
    expect(result.user.username).toBe(USERNAME);
  });

  it("throws on incorrect current password", () => {
    expect(() => changePassword(db, userId, "wrongpassword", NEW_PASSWORD)).toThrow(
      "Current password is incorrect",
    );
  });

  it("destroys all sessions after password change", () => {
    const { token: t1 } = userLogin(db, EMAIL, PASSWORD);
    const { token: t2 } = userLogin(db, EMAIL, PASSWORD);

    changePassword(db, userId, PASSWORD, NEW_PASSWORD);

    expect(validateUserSession(db, t1)).toBeNull();
    expect(validateUserSession(db, t2)).toBeNull();
  });

  it("rejects a weak new password (PR3 sec M3)", () => {
    // Coverage assertion: validatePasswordStrength is wired into the
    // change-password path, not just create-user.
    expect(() => changePassword(db, userId, PASSWORD, "password1234")).toThrow(
      /too common/,
    );
  });

  it("rejects new password that is too short", () => {
    expect(() => changePassword(db, userId, PASSWORD, "short")).toThrow(
      /Password must be at least/,
    );
  });
});

// ── Email change ──────────────────────────────────────────────────────────

describe("changeEmail", () => {
  const USERNAME = "emailchange";
  const EMAIL = "old@example.com";
  const PASSWORD = "securepass123";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
    // Verify the email first
    const token = createEmailVerificationToken(db, userId, EMAIL);
    verifyEmail(db, token);
  });

  it("changes email and resets verified status", () => {
    const newEmail = "new@example.com";
    const verifyToken = changeEmail(db, userId, newEmail, PASSWORD);

    expect(verifyToken).toBeDefined();
    expect(typeof verifyToken).toBe("string");

    // Check email was updated
    const row = db.prepare("SELECT email, email_verified FROM users WHERE id = ?").get(userId) as any;
    expect(row.email).toBe(newEmail);
    expect(row.email_verified).toBe(0);
  });

  it("rejects duplicate email with a generic message (PR3 sec M1)", () => {
    createUser(db, "otheruser", "taken@example.com", "T3stP@ss-w0rd!");
    expect(() => changeEmail(db, userId, "taken@example.com", PASSWORD)).toThrow(
      /email is already in use/,
    );
  });

  it("creates a verification token for the new email", () => {
    const verifyToken = changeEmail(db, userId, "new@example.com", PASSWORD);
    const result = verifyEmail(db, verifyToken);
    expect(result).toBe(true);

    const row = db.prepare("SELECT email_verified FROM users WHERE id = ?").get(userId) as any;
    expect(row.email_verified).toBe(1);
  });

  it("throws on incorrect password", () => {
    expect(() => changeEmail(db, userId, "new@example.com", "wrongpassword")).toThrow(
      "Password is incorrect",
    );
  });

  it("rejects invalid email format", () => {
    expect(() => changeEmail(db, userId, "not-an-email", PASSWORD)).toThrow(
      "Invalid email format",
    );
  });
});

// ── Password reset tokens ────────────────────────────────────────────────

describe("createPasswordResetToken", () => {
  const USERNAME = "resetuser";
  const EMAIL = "reset@example.com";
  const PASSWORD = "securepass123";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("creates a token and returns a hex string", () => {
    const token = createPasswordResetToken(db, userId);
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64); // 32 bytes hex
  });

  it("returns different tokens on successive calls", () => {
    const token1 = createPasswordResetToken(db, userId);
    const token2 = createPasswordResetToken(db, userId);
    expect(token1).not.toBe(token2);
  });

  it("invalidates previous tokens when creating a new one", () => {
    const token1 = createPasswordResetToken(db, userId);
    createPasswordResetToken(db, userId);

    // First token should no longer work for reset
    const result = resetPassword(db, token1, "newvalidpass1");
    expect(result).toBe(false);
  });

  it("stores the token as a hash (not raw) in the database", () => {
    const rawToken = createPasswordResetToken(db, userId);

    // The raw token should NOT appear in the DB
    const row = db
      .prepare("SELECT token FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL")
      .get(userId) as { token: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.token).not.toBe(rawToken);
    expect(row!.token.length).toBe(64); // SHA-256 hex
  });
});

// ── resetPassword ────────────────────────────────────────────────────────

describe("resetPassword", () => {
  const USERNAME = "pwreset";
  const EMAIL = "pwreset@example.com";
  const PASSWORD = "oldpassword1";
  const NEW_PASSWORD = "newpassword1";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("resets password with a valid token", () => {
    const token = createPasswordResetToken(db, userId);
    const result = resetPassword(db, token, NEW_PASSWORD);
    expect(result).toBe(true);

    // Can log in with new password
    const loginResult = userLogin(db, EMAIL, NEW_PASSWORD);
    expect(loginResult.user.username).toBe(USERNAME);
  });

  it("old password no longer works after reset", () => {
    const token = createPasswordResetToken(db, userId);
    resetPassword(db, token, NEW_PASSWORD);

    expect(() => userLogin(db, EMAIL, PASSWORD)).toThrow("Invalid credentials");
  });

  it("rejects a weak new password (PR3 sec M3)", () => {
    // Coverage assertion: validatePasswordStrength is wired into the
    // password-reset path too, not just create/change.
    const token = createPasswordResetToken(db, userId);
    expect(() => resetPassword(db, token, "password1234")).toThrow(
      /too common/,
    );
  });

  it("returns false for expired token", () => {
    const token = createPasswordResetToken(db, userId);

    // Manually expire the token by updating expires_at in the DB
    // We need to find the hashed token row
    db.prepare(
      "UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(new Date(Date.now() - 60_000).toISOString(), userId);

    const result = resetPassword(db, token, NEW_PASSWORD);
    expect(result).toBe(false);
  });

  it("returns false for already-used token", () => {
    const token = createPasswordResetToken(db, userId);

    // First use should succeed
    expect(resetPassword(db, token, NEW_PASSWORD)).toBe(true);

    // Second use should fail
    expect(resetPassword(db, token, "anotherpass123")).toBe(false);
  });

  it("returns false for non-existent token", () => {
    const result = resetPassword(db, "nonexistent_token_value", NEW_PASSWORD);
    expect(result).toBe(false);
  });

  it("throws on weak password (too short)", () => {
    const token = createPasswordResetToken(db, userId);
    expect(() => resetPassword(db, token, "short")).toThrow(/Password must be at least/);
  });

  it("throws on password that is too long", () => {
    const token = createPasswordResetToken(db, userId);
    const longPass = "a".repeat(config.userMaxPasswordLength + 1);
    expect(() => resetPassword(db, token, longPass)).toThrow(/Password must be at most/);
  });

  it("destroys all sessions after reset", () => {
    // Create some sessions
    const { token: sessionToken1 } = userLogin(db, EMAIL, PASSWORD);
    const { token: sessionToken2 } = userLogin(db, EMAIL, PASSWORD);

    expect(validateUserSession(db, sessionToken1)).not.toBeNull();
    expect(validateUserSession(db, sessionToken2)).not.toBeNull();

    const resetToken = createPasswordResetToken(db, userId);
    resetPassword(db, resetToken, NEW_PASSWORD);

    // All sessions should be destroyed
    expect(validateUserSession(db, sessionToken1)).toBeNull();
    expect(validateUserSession(db, sessionToken2)).toBeNull();
  });
});

// ── findUserByEmail ──────────────────────────────────────────────────────

describe("findUserByEmail", () => {
  const USERNAME = "findme";
  const EMAIL = "findme@example.com";
  const PASSWORD = "securepass123";

  beforeEach(() => {
    createUser(db, USERNAME, EMAIL, PASSWORD);
  });

  it("finds an existing user by email", () => {
    const user = findUserByEmail(db, EMAIL);
    expect(user).not.toBeNull();
    expect(user!.username).toBe(USERNAME);
    expect(user!.email).toBe(EMAIL);
  });

  it("returns null for non-existent email", () => {
    const user = findUserByEmail(db, "nobody@example.com");
    expect(user).toBeNull();
  });

  it("is case-insensitive", () => {
    const user = findUserByEmail(db, "FindMe@EXAMPLE.COM");
    expect(user).not.toBeNull();
    expect(user!.email).toBe(EMAIL);
  });

  it("trims whitespace from input", () => {
    const user = findUserByEmail(db, "  findme@example.com  ");
    expect(user).not.toBeNull();
    expect(user!.email).toBe(EMAIL);
  });
});

// ── cleanupExpiredTokens ─────────────────────────────────────────────────

describe("cleanupExpiredTokens", () => {
  const USERNAME = "cleanupuser";
  const EMAIL = "cleanup@example.com";
  const PASSWORD = "securepass123";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("deletes expired password reset tokens", () => {
    const token = createPasswordResetToken(db, userId);

    // Expire the token
    db.prepare(
      "UPDATE password_reset_tokens SET expires_at = ? WHERE user_id = ?",
    ).run(new Date(Date.now() - 60_000).toISOString(), userId);

    const count = cleanupExpiredTokens(db);
    expect(count).toBeGreaterThanOrEqual(1);

    // Token should no longer be in DB
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM password_reset_tokens WHERE user_id = ?")
      .get(userId) as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it("deletes used password reset tokens", () => {
    const token = createPasswordResetToken(db, userId);
    // Use the token
    resetPassword(db, token, "newvalidpass1");

    const count = cleanupExpiredTokens(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("deletes expired email verification tokens", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);

    // Expire the token
    db.prepare(
      "UPDATE email_verification_tokens SET expires_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(new Date(Date.now() - 60_000).toISOString(), userId);

    const count = cleanupExpiredTokens(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("deletes used email verification tokens", () => {
    const token = createEmailVerificationToken(db, userId, EMAIL);
    verifyEmail(db, token);

    const count = cleanupExpiredTokens(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("does not delete unexpired, unused tokens", () => {
    createPasswordResetToken(db, userId);
    createEmailVerificationToken(db, userId, EMAIL);

    const count = cleanupExpiredTokens(db);
    expect(count).toBe(0);

    // Both tokens should still be present
    const resetCount = db
      .prepare("SELECT COUNT(*) as cnt FROM password_reset_tokens WHERE user_id = ?")
      .get(userId) as { cnt: number };
    const verifyCount = db
      .prepare("SELECT COUNT(*) as cnt FROM email_verification_tokens WHERE user_id = ?")
      .get(userId) as { cnt: number };
    // One active reset token and one active verification token
    expect(resetCount.cnt).toBe(1);
    expect(verifyCount.cnt).toBe(1);
  });

  it("returns 0 when there are no tokens to clean up", () => {
    const count = cleanupExpiredTokens(db);
    expect(count).toBe(0);
  });
});

// ── Token hashing round-trip ─────────────────────────────────────────────

describe("token hashing round-trip", () => {
  const USERNAME = "hashuser";
  const EMAIL = "hash@example.com";
  const PASSWORD = "securepass123";
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, USERNAME, EMAIL, PASSWORD);
    userId = user.id;
  });

  it("email verification: raw token from create works with verifyEmail", () => {
    const rawToken = createEmailVerificationToken(db, userId, EMAIL);

    // The raw token should NOT be stored directly
    const row = db
      .prepare("SELECT token FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL")
      .get(userId) as { token: string };
    expect(row.token).not.toBe(rawToken);

    // But passing the raw token to verifyEmail should succeed (it hashes internally)
    const result = verifyEmail(db, rawToken);
    expect(result).toBe(true);
  });

  it("password reset: raw token from create works with resetPassword", () => {
    const rawToken = createPasswordResetToken(db, userId);

    // The raw token should NOT be stored directly
    const row = db
      .prepare("SELECT token FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL")
      .get(userId) as { token: string };
    expect(row.token).not.toBe(rawToken);

    // But passing the raw token to resetPassword should succeed (it hashes internally)
    const result = resetPassword(db, rawToken, "newvalidpass1");
    expect(result).toBe(true);
  });

  it("a modified raw token does not match the stored hash", () => {
    const rawToken = createPasswordResetToken(db, userId);
    const tamperedToken = rawToken.slice(0, -1) + (rawToken.endsWith("0") ? "1" : "0");

    const result = resetPassword(db, tamperedToken, "newvalidpass1");
    expect(result).toBe(false);
  });
});

// ── Avatar ───────────────────────────────────────────────────────────────

describe("createUser avatar field", () => {
  it("returns null avatar by default for new users", () => {
    const user = createUser(db, "AvatarUser", "avatar@example.com", "T3stP@ss-w0rd!");
    expect(user.avatar).toBeNull();
  });
});

describe("changeAvatar", () => {
  let userId: string;

  beforeEach(() => {
    const user = createUser(db, "AvatarUser", "avatar@example.com", "T3stP@ss-w0rd!");
    userId = user.id;
  });

  it("sets a valid profile avatar", () => {
    const updated = changeAvatar(db, userId, "yeti");
    expect(updated.avatar).toBe("yeti");
  });

  it("allows changing from one avatar to another", () => {
    changeAvatar(db, userId, "wizard");
    const updated = changeAvatar(db, userId, "fancy-ghost");
    expect(updated.avatar).toBe("fancy-ghost");
  });

  it("allows clearing avatar by setting null", () => {
    changeAvatar(db, userId, "sushi");
    const updated = changeAvatar(db, userId, null);
    expect(updated.avatar).toBeNull();
  });

  it("rejects invalid avatar names", () => {
    expect(() => changeAvatar(db, userId, "dragon")).toThrow("Invalid avatar");
  });

  it("rejects avatars outside the profile list", () => {
    expect(() => changeAvatar(db, userId, "bear")).toThrow("Invalid avatar");
    expect(() => changeAvatar(db, userId, "octopus")).toThrow("Invalid avatar");
  });

  it("throws for non-existent user", () => {
    expect(() => changeAvatar(db, "nonexistent-id", "wizard")).toThrow("User not found");
  });
});
