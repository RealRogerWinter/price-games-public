import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test/dbHelper";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  isAccountLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  evictOldestSessions,
  SAFE_LOGIN_ERRORS,
} from "./authHelpers";

let db: DatabaseType;
const DUMMY_HASH = bcrypt.hashSync("dummy", 4);

beforeEach(() => {
  db = createTestDb();
});

function seedUser(overrides?: { lockedUntil?: string; failedCount?: number }): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, is_active, failed_login_count, locked_until)
     VALUES (?, 'u', 'u', 'u@test.com', ?, ?, ?, 1, ?, ?)`
  ).run(id, bcrypt.hashSync("password10", 4), now, now, overrides?.failedCount ?? 0, overrides?.lockedUntil ?? null);
  return id;
}

function seedAdmin(overrides?: { lockedUntil?: string; failedCount?: number }): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO admin_users (id, username, password_hash, created_at, updated_at, is_active, failed_login_count, locked_until)
     VALUES (?, 'admin', ?, ?, ?, 1, ?, ?)`
  ).run(id, bcrypt.hashSync("password1234", 4), now, now, overrides?.failedCount ?? 0, overrides?.lockedUntil ?? null);
  return id;
}

function createSession(userId: string): string {
  const token = uuidv4();
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86400000).toISOString();
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(token, userId, now, expires, now);
  return token;
}

// ── SAFE_LOGIN_ERRORS ──

describe("SAFE_LOGIN_ERRORS", () => {
  it("contains expected error messages", () => {
    expect(SAFE_LOGIN_ERRORS.has("Invalid credentials")).toBe(true);
    expect(SAFE_LOGIN_ERRORS.has("Account is temporarily locked")).toBe(true);
  });

  it("rejects unknown messages", () => {
    expect(SAFE_LOGIN_ERRORS.has("User not found")).toBe(false);
  });
});

// ── isAccountLocked ──

describe("isAccountLocked", () => {
  it("returns false when lockedUntil is null", () => {
    const id = seedUser();
    expect(isAccountLocked(db, "users", id, null, DUMMY_HASH, "pass")).toBe(false);
  });

  it("returns false when lockedUntil is undefined", () => {
    const id = seedUser();
    expect(isAccountLocked(db, "users", id, undefined, DUMMY_HASH, "pass")).toBe(false);
  });

  it("returns true when account is actively locked", () => {
    const id = seedUser();
    const futureDate = new Date(Date.now() + 60000).toISOString();
    expect(isAccountLocked(db, "users", id, futureDate, DUMMY_HASH, "pass")).toBe(true);
  });

  it("resets lock and returns false when lock has expired", () => {
    const id = seedUser({ lockedUntil: new Date(Date.now() - 1000).toISOString(), failedCount: 5 });
    const result = isAccountLocked(db, "users", id, new Date(Date.now() - 1000).toISOString(), DUMMY_HASH, "pass");
    expect(result).toBe(false);

    const row = db.prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it("works with admin_users table", () => {
    const id = seedAdmin();
    const futureDate = new Date(Date.now() + 60000).toISOString();
    expect(isAccountLocked(db, "admin_users", id, futureDate, DUMMY_HASH, "pass")).toBe(true);
  });

  it("throws on invalid table name", () => {
    expect(() => isAccountLocked(db, "bad_table" as any, "x", null, DUMMY_HASH, "p")).toThrow("Invalid table");
  });
});

// ── recordFailedLogin ──

describe("recordFailedLogin", () => {
  it("increments failed count below threshold", () => {
    const id = seedUser({ failedCount: 1 });
    recordFailedLogin(db, "users", id, 1, 5, 900000);

    const row = db.prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(2);
    expect(row.locked_until).toBeNull();
  });

  it("locks account when threshold is reached", () => {
    const id = seedUser({ failedCount: 4 });
    recordFailedLogin(db, "users", id, 4, 5, 900000);

    const row = db.prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(5);
    expect(row.locked_until).not.toBeNull();
  });

  it("works with admin_users table", () => {
    const id = seedAdmin({ failedCount: 0 });
    recordFailedLogin(db, "admin_users", id, 0, 3, 60000);

    const row = db.prepare("SELECT failed_login_count FROM admin_users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(1);
  });

  it("throws on invalid table name", () => {
    expect(() => recordFailedLogin(db, "evil" as any, "x", 0, 5, 1000)).toThrow("Invalid table");
  });
});

// ── recordSuccessfulLogin ──

describe("recordSuccessfulLogin", () => {
  it("resets failed count and lock", () => {
    const id = seedUser({ failedCount: 3, lockedUntil: new Date().toISOString() });
    recordSuccessfulLogin(db, "users", id);

    const row = db.prepare("SELECT failed_login_count, locked_until, last_login_at FROM users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(row.last_login_at).not.toBeNull();
  });

  it("works with admin_users table", () => {
    const id = seedAdmin({ failedCount: 2 });
    recordSuccessfulLogin(db, "admin_users", id);

    const row = db.prepare("SELECT failed_login_count, last_login_at FROM admin_users WHERE id = ?").get(id) as any;
    expect(row.failed_login_count).toBe(0);
    expect(row.last_login_at).not.toBeNull();
  });

  it("throws on invalid table name", () => {
    expect(() => recordSuccessfulLogin(db, "evil" as any, "x")).toThrow("Invalid table");
  });
});

// ── evictOldestSessions ──

describe("evictOldestSessions", () => {
  it("does nothing when under the limit", () => {
    const userId = seedUser();
    createSession(userId);
    createSession(userId);

    evictOldestSessions(db, userId, 5);

    const count = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?").get(userId) as any;
    expect(count.cnt).toBe(2);
  });

  it("evicts oldest sessions when at limit", () => {
    const userId = seedUser();
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      tokens.push(createSession(userId));
    }

    evictOldestSessions(db, userId, 5);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?").get(userId) as any;
    expect(remaining.cnt).toBe(4);
  });

  it("evicts multiple sessions when well over limit", () => {
    const userId = seedUser();
    for (let i = 0; i < 8; i++) {
      createSession(userId);
    }

    evictOldestSessions(db, userId, 3);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?").get(userId) as any;
    expect(remaining.cnt).toBe(2);
  });

  it("does not affect other users' sessions", () => {
    const user1 = seedUser();
    // Create a second user manually
    const user2 = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, is_active)
       VALUES (?, 'u2', 'u2', 'u2@test.com', 'hash', ?, ?, 1)`
    ).run(user2, now, now);

    createSession(user1);
    createSession(user1);
    createSession(user1);
    const otherToken = createSession(user2);

    evictOldestSessions(db, user1, 2);

    // user1 should have 1 session, user2 should still have 1
    const count1 = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?").get(user1) as any;
    const count2 = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?").get(user2) as any;
    expect(count1.cnt).toBe(1);
    expect(count2.cnt).toBe(1);
  });
});
