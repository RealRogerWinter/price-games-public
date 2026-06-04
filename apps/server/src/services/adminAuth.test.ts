/**
 * Tests for the admin authentication service.
 *
 * Covers admin user creation, login (with locking and case-insensitivity),
 * session validation (expiration, idle timeout, inactive user), session
 * destruction, and initial admin seeding from environment variables.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as OTPAuth from "otpauth";
import { createTestDb } from "../test/dbHelper";
import {
  createAdmin,
  adminLogin,
  adminLoginVerify2fa,
  validateAdminSession,
  destroyAdminSession,
  destroyAllAdminSessions,
  seedInitialAdmin,
} from "./adminAuth";
import { beginTotpSetup, verifyAndEnableTotp } from "./adminTotp";
import { config } from "../config";
import type { Database as DatabaseType } from "better-sqlite3";

const maxFailedLogins = config.adminMaxFailedLogins;

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ── createAdmin ────────────────────────────────────────────────────────────

describe("createAdmin", () => {
  it("creates a valid admin user and returns AdminUser without password hash", () => {
    const user = createAdmin(db, "TestAdmin", "securepassword12");

    expect(user.id).toBeDefined();
    expect(user.username).toBe("testadmin");
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toBeDefined();
    expect(user.updatedAt).toBeDefined();
    expect(user.lastLoginAt).toBeNull();
    // Ensure no password hash is exposed
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((user as Record<string, unknown>).password_hash).toBeUndefined();
  });

  it("normalizes username to lowercase", () => {
    const user = createAdmin(db, "UPPERCASE", "securepassword12");

    expect(user.username).toBe("uppercase");
  });

  it("rejects duplicate username", () => {
    createAdmin(db, "admin", "securepassword12");

    expect(() => createAdmin(db, "admin", "anotherpassword12")).toThrow(
      "Username already exists",
    );
  });

  it("rejects empty username", () => {
    expect(() => createAdmin(db, "", "securepassword12")).toThrow(
      "Username must not be empty",
    );
  });

  it("rejects password shorter than 12 characters", () => {
    expect(() => createAdmin(db, "admin", "short")).toThrow(
      "Password must be at least 12 characters",
    );
  });
});

// ── adminLogin ─────────────────────────────────────────────────────────────

describe("adminLogin", () => {
  const USERNAME = "loginuser";
  const PASSWORD = "correctpassword1";

  beforeEach(() => {
    createAdmin(db, USERNAME, PASSWORD);
  });

  it("returns token and user for correct credentials", () => {
    const result = adminLogin(db, USERNAME, PASSWORD);

    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.user.username).toBe(USERNAME);
    expect(result.user.isActive).toBe(true);
  });

  it('throws "Invalid credentials" for wrong password', () => {
    expect(() => adminLogin(db, USERNAME, "wrongpassword12")).toThrow(
      "Invalid credentials",
    );
  });

  it('throws "Invalid credentials" for non-existent user', () => {
    expect(() => adminLogin(db, "nosuchuser", PASSWORD)).toThrow(
      "Invalid credentials",
    );
  });

  it("increments failed_login_count on failure", () => {
    try {
      adminLogin(db, USERNAME, "wrongpassword12");
    } catch {
      // expected
    }

    const row = db
      .prepare("SELECT failed_login_count FROM admin_users WHERE username = ?")
      .get(USERNAME) as { failed_login_count: number };

    expect(row.failed_login_count).toBe(1);
  });

  it("locks account after maxFailedLogins attempts", () => {
    for (let i = 0; i < maxFailedLogins; i++) {
      try {
        adminLogin(db, USERNAME, "wrongpassword12");
      } catch {
        // expected
      }
    }

    expect(() => adminLogin(db, USERNAME, PASSWORD)).toThrow(
      "Account is temporarily locked",
    );
  });

  it("successful login resets failed_login_count to 0", () => {
    // Accumulate some failures (but not enough to lock)
    for (let i = 0; i < maxFailedLogins - 1; i++) {
      try {
        adminLogin(db, USERNAME, "wrongpassword12");
      } catch {
        // expected
      }
    }

    const before = db
      .prepare("SELECT failed_login_count FROM admin_users WHERE username = ?")
      .get(USERNAME) as { failed_login_count: number };
    expect(before.failed_login_count).toBe(maxFailedLogins - 1);

    // Successful login should reset the count
    adminLogin(db, USERNAME, PASSWORD);

    const after = db
      .prepare("SELECT failed_login_count FROM admin_users WHERE username = ?")
      .get(USERNAME) as { failed_login_count: number };
    expect(after.failed_login_count).toBe(0);
  });

  it('throws "Invalid credentials" for inactive account', () => {
    db.prepare("UPDATE admin_users SET is_active = 0 WHERE username = ?").run(
      USERNAME,
    );

    expect(() => adminLogin(db, USERNAME, PASSWORD)).toThrow(
      "Invalid credentials",
    );
  });

  it("username is case-insensitive", () => {
    const result = adminLogin(db, "LOGINUSER", PASSWORD);

    expect(result.user.username).toBe(USERNAME);
  });

  it("updates last_login_at on success", () => {
    const before = db
      .prepare("SELECT last_login_at FROM admin_users WHERE username = ?")
      .get(USERNAME) as { last_login_at: string | null };
    expect(before.last_login_at).toBeNull();

    adminLogin(db, USERNAME, PASSWORD);

    const after = db
      .prepare("SELECT last_login_at FROM admin_users WHERE username = ?")
      .get(USERNAME) as { last_login_at: string | null };
    expect(after.last_login_at).not.toBeNull();
  });
});

// ── validateAdminSession ───────────────────────────────────────────────────

describe("validateAdminSession", () => {
  const USERNAME = "sessionuser";
  const PASSWORD = "securepassword12";
  let token: string;

  beforeEach(() => {
    createAdmin(db, USERNAME, PASSWORD);
    const result = adminLogin(db, USERNAME, PASSWORD);
    token = result.token;
  });

  it("returns AdminUser for valid session", () => {
    const user = validateAdminSession(db, token);

    expect(user).not.toBeNull();
    expect(user!.username).toBe(USERNAME);
    expect(user!.isActive).toBe(true);
  });

  it("returns null for non-existent token", () => {
    const user = validateAdminSession(db, "non-existent-token");

    expect(user).toBeNull();
  });

  it("returns null for expired session", () => {
    // Set expires_at to a time in the past
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE admin_sessions SET expires_at = ? WHERE id = ?").run(
      past,
      token,
    );

    const user = validateAdminSession(db, token);

    expect(user).toBeNull();
  });

  it("returns null for idle session", () => {
    // Set last_active_at beyond the configured idle timeout
    const longAgo = new Date(Date.now() - config.adminIdleTimeoutMs - 60_000).toISOString();
    db.prepare("UPDATE admin_sessions SET last_active_at = ? WHERE id = ?").run(
      longAgo,
      token,
    );

    const user = validateAdminSession(db, token);

    expect(user).toBeNull();
  });

  it("returns null for session of inactive user", () => {
    db.prepare("UPDATE admin_users SET is_active = 0 WHERE username = ?").run(
      USERNAME,
    );

    const user = validateAdminSession(db, token);

    expect(user).toBeNull();
  });

  it("updates last_active_at on valid access", () => {
    const before = db
      .prepare("SELECT last_active_at FROM admin_sessions WHERE id = ?")
      .get(token) as { last_active_at: string };
    const beforeTime = new Date(before.last_active_at).getTime();

    // Small delay to ensure timestamp difference
    const user = validateAdminSession(db, token);
    expect(user).not.toBeNull();

    const after = db
      .prepare("SELECT last_active_at FROM admin_sessions WHERE id = ?")
      .get(token) as { last_active_at: string };
    const afterTime = new Date(after.last_active_at).getTime();

    expect(afterTime).toBeGreaterThanOrEqual(beforeTime);
  });
});

// ── destroyAdminSession / destroyAllAdminSessions ──────────────────────────

describe("destroyAdminSession", () => {
  const USERNAME = "destroyuser";
  const PASSWORD = "securepassword12";

  it("destroys session so subsequent validate returns null", () => {
    createAdmin(db, USERNAME, PASSWORD);
    const { token } = adminLogin(db, USERNAME, PASSWORD);

    // Session is valid before destruction
    expect(validateAdminSession(db, token)).not.toBeNull();

    destroyAdminSession(db, token);

    expect(validateAdminSession(db, token)).toBeNull();
  });

  it("destroyAllAdminSessions removes all sessions for user", () => {
    const user = createAdmin(db, USERNAME, PASSWORD);
    const { token: token1 } = adminLogin(db, USERNAME, PASSWORD);
    const { token: token2 } = adminLogin(db, USERNAME, PASSWORD);

    // Both sessions are valid
    expect(validateAdminSession(db, token1)).not.toBeNull();
    expect(validateAdminSession(db, token2)).not.toBeNull();

    destroyAllAdminSessions(db, user.id);

    expect(validateAdminSession(db, token1)).toBeNull();
    expect(validateAdminSession(db, token2)).toBeNull();
  });
});

// ── adminLoginVerify2fa (lockout isolation) ───────────────────────────────

describe("adminLoginVerify2fa", () => {
  const USERNAME = "twofauser";
  const PASSWORD = "securepassword12";

  it("failed 2FA does not increment failed_login_count", async () => {
    createAdmin(db, USERNAME, PASSWORD);
    const user = db
      .prepare("SELECT id FROM admin_users WHERE username = ?")
      .get(USERNAME) as { id: string };

    // Enable TOTP for the user
    const setup = await beginTotpSetup(db, user.id);
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });
    verifyAndEnableTotp(db, user.id, totp.generate());

    // Log in with correct password to get a pending token
    const loginResult = adminLogin(db, USERNAME, PASSWORD);
    expect(loginResult.requiresTwoFactor).toBe(true);
    if (!loginResult.requiresTwoFactor) return;

    // Submit a wrong TOTP code
    expect(() => adminLoginVerify2fa(db, loginResult.pendingToken, "000000")).toThrow(
      "Invalid verification code",
    );

    // failed_login_count should still be 0 (not incremented by 2FA failure)
    const row = db
      .prepare("SELECT failed_login_count, locked_until FROM admin_users WHERE id = ?")
      .get(user.id) as { failed_login_count: number; locked_until: string | null };
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

// ── seedInitialAdmin ───────────────────────────────────────────────────────

describe("seedInitialAdmin", () => {
  const ENV_USER = "ADMIN_INITIAL_USERNAME";
  const ENV_PASS = "ADMIN_INITIAL_PASSWORD";

  it("creates admin when table empty and env vars set", () => {
    const origUser = process.env[ENV_USER];
    const origPass = process.env[ENV_PASS];
    try {
      process.env[ENV_USER] = "seedadmin";
      process.env[ENV_PASS] = "seedpassword123";

      seedInitialAdmin(db);

      const row = db
        .prepare("SELECT * FROM admin_users WHERE username = ?")
        .get("seedadmin") as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row!.username).toBe("seedadmin");
      expect(row!.is_active).toBe(1);
    } finally {
      // Restore original env
      if (origUser === undefined) delete process.env[ENV_USER];
      else process.env[ENV_USER] = origUser;
      if (origPass === undefined) delete process.env[ENV_PASS];
      else process.env[ENV_PASS] = origPass;
    }
  });

  it("skips when table already has users", () => {
    createAdmin(db, "existing", "existingpassword1");

    const origUser = process.env[ENV_USER];
    const origPass = process.env[ENV_PASS];
    try {
      process.env[ENV_USER] = "seedadmin";
      process.env[ENV_PASS] = "seedpassword123";

      seedInitialAdmin(db);

      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM admin_users")
        .get() as { cnt: number };

      // Should still be just the one pre-existing user
      expect(count.cnt).toBe(1);
    } finally {
      if (origUser === undefined) delete process.env[ENV_USER];
      else process.env[ENV_USER] = origUser;
      if (origPass === undefined) delete process.env[ENV_PASS];
      else process.env[ENV_PASS] = origPass;
    }
  });

  it("skips when env vars are empty", () => {
    const origUser = process.env[ENV_USER];
    const origPass = process.env[ENV_PASS];
    try {
      delete process.env[ENV_USER];
      delete process.env[ENV_PASS];

      seedInitialAdmin(db);

      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM admin_users")
        .get() as { cnt: number };

      expect(count.cnt).toBe(0);
    } finally {
      if (origUser === undefined) delete process.env[ENV_USER];
      else process.env[ENV_USER] = origUser;
      if (origPass === undefined) delete process.env[ENV_PASS];
      else process.env[ENV_PASS] = origPass;
    }
  });
});
