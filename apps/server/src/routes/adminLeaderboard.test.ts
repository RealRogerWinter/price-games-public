/**
 * Tests for the admin leaderboard router. Extracts handlers from the
 * Express router stack and calls them directly with mock req/res — same
 * pattern as `admin.test.ts`. The underlying service is exercised
 * separately in `services/adminLeaderboard.test.ts`; here we only verify
 * the request → service plumbing and validation behavior.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedAdminUser, seedUser } from "../test/dbHelper";
import { createAdminLeaderboardRouter } from "./adminLeaderboard";

function getHandler(router: any, path: string, method: string = "get") {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      const mStack = layer.route.stack.filter((s: any) => s.method === method);
      if (mStack.length > 0) {
        return mStack[mStack.length - 1]?.handle;
      }
    }
  }
  return undefined;
}

function mockReq(adminId: string, overrides: any = {}) {
  return {
    params: {},
    body: {},
    query: {},
    cookies: { admin_session: "test-session-token" },
    headers: {},
    adminUser: { id: adminId, username: "admin", isActive: true, totpEnabled: true },
    ...overrides,
  } as any;
}

function mockRes() {
  const data: { statusCode?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(d: any) {
      data.body = d;
      return res;
    },
  };
  return { res, data };
}

let db: DatabaseType;
let adminId: string;
let aliceId: string;
let bobId: string;
let aliceEntryId: number;

beforeEach(() => {
  db = createTestDb();
  adminId = seedAdminUser(db, "admin", "password123");
  aliceId = seedUser(db, "alice", "alice@example.com");
  bobId = seedUser(db, "bob", "bob@example.com");
  // Seed entries — every user_game_history row requires a real user_id,
  // so the legacy "guest entry with NULL user_id" case is gone by
  // construction (which is the whole point of the parity fix).
  const insertEntry = db.prepare(
    `INSERT INTO user_game_history
       (user_id, game_type, game_mode, session_id, score, played_at)
     VALUES (?, 'single', ?, ?, ?, ?)`,
  );
  const aliceResult = insertEntry.run(aliceId, "classic", "s-1", 8000, "2026-01-01T00:00:00Z");
  aliceEntryId = Number(aliceResult.lastInsertRowid);
  insertEntry.run(bobId, "classic", "s-2", 9000, "2026-01-02T00:00:00Z");
  db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(8000, aliceId);
  db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(9000, bobId);
});

describe("GET /entries", () => {
  it("returns entries with total + filters", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries");
    const req = mockReq(adminId, { query: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.total).toBe(2);
    expect(data.body.entries.length).toBe(2);
  });

  it("returns empty result for unknown game mode", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries");
    const req = mockReq(adminId, { query: { mode: "made-up-mode" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body).toEqual({ entries: [], total: 0, limit: 0, offset: 0 });
  });

  it("respects status=excluded filter", () => {
    db.prepare(
      `UPDATE user_game_history SET excluded_at = ?, excluded_reason = ? WHERE user_id = ?`,
    ).run("2026-01-03T00:00:00Z", "duplicate", aliceId);
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries");
    const req = mockReq(adminId, { query: { status: "excluded" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.total).toBe(1);
    expect(data.body.entries[0].userId).toBe(aliceId);
    expect(data.body.entries[0].username).toBe("alice");
  });
});

describe("POST /entries/:id/exclude", () => {
  it("400 on invalid id", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/exclude", "post");
    const req = mockReq(adminId, { params: { id: "abc" }, body: { reason: "x" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("400 when reason missing", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/exclude", "post");
    const req = mockReq(adminId, { params: { id: "1" }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("404 for unknown entry", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/exclude", "post");
    const req = mockReq(adminId, { params: { id: "99999" }, body: { reason: "x" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(404);
  });

  it("excludes successfully", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/exclude", "post");
    const req = mockReq(adminId, { params: { id: "1" }, body: { reason: "duplicate" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.isExcluded).toBe(true);
  });
});

describe("POST /entries/:id/restore", () => {
  it("restores an excluded entry", () => {
    db.prepare(
      `UPDATE user_game_history SET excluded_at = ?, excluded_reason = ? WHERE id = ?`,
    ).run("2026-01-03T00:00:00Z", "x", aliceEntryId);
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/restore", "post");
    const req = mockReq(adminId, { params: { id: String(aliceEntryId) }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.isExcluded).toBe(false);
  });

  it("404 unknown entry", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/:id/restore", "post");
    const req = mockReq(adminId, { params: { id: "99999" }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(404);
  });
});

describe("POST /entries/bulk-exclude", () => {
  it("400 when ids missing or empty", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/bulk-exclude", "post");
    const req = mockReq(adminId, { body: { ids: [], reason: "x" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("400 on non-integer id in array", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/bulk-exclude", "post");
    const req = mockReq(adminId, { body: { ids: [1, "abc"], reason: "x" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("400 on null/boolean ids that would coerce to 0/1", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/bulk-exclude", "post");
    const req = mockReq(adminId, { body: { ids: [1, null, true], reason: "x" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("400 on batches over MAX_BULK_IDS", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/bulk-exclude", "post");
    const req = mockReq(adminId, {
      body: { ids: Array.from({ length: 501 }, (_, i) => i + 1), reason: "x" },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
    expect(data.body.error).toMatch(/Too many ids/);
  });

  it("excludes multiple", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/entries/bulk-exclude", "post");
    const req = mockReq(adminId, { body: { ids: [1, 2], reason: "wave" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body).toEqual({ excluded: 2, notFound: 0 });
  });
});

describe("user endpoints", () => {
  it("GET /users/:userId returns summary", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId");
    const req = mockReq(adminId, { params: { userId: aliceId } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.userId).toBe(aliceId);
    expect(data.body.totalEntries).toBe(1);
  });

  it("GET /users/:userId 404 for unknown", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId");
    const req = mockReq(adminId, { params: { userId: "no-such-user" } });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(404);
  });

  it("POST /users/:userId/ban requires reason", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban", "post");
    const req = mockReq(adminId, { params: { userId: aliceId }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("POST /users/:userId/ban rejects oversized reason", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban", "post");
    const req = mockReq(adminId, {
      params: { userId: aliceId },
      body: { reason: "a".repeat(501) },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("POST /users/:userId/ban rejects out-of-range duration", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban", "post");
    const req = mockReq(adminId, {
      params: { userId: aliceId },
      body: { reason: "x", durationDays: 9999 },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("POST /users/:userId/ban succeeds with reason", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban", "post");
    const req = mockReq(adminId, {
      params: { userId: aliceId },
      body: { reason: "cheating", durationDays: 7 },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.banned).toBe(true);
    expect(data.body.bannedUntil).not.toBeNull();
  });

  it("POST /users/:userId/ban-history bans + excludes all entries", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban-history", "post");
    const req = mockReq(adminId, {
      params: { userId: aliceId },
      body: { reason: "wholesale fraud" },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.banned).toBe(true);
    expect(data.body.excludedEntries).toBeGreaterThan(0);
    expect(data.body.excludedEntries).toBe(data.body.totalEntries);
  });

  it("POST /users/:userId/ban-history requires a reason", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban-history", "post");
    const req = mockReq(adminId, { params: { userId: aliceId }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(400);
  });

  it("POST /users/:userId/ban-history 404s for unknown user", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/ban-history", "post");
    const req = mockReq(adminId, {
      params: { userId: "no-such" },
      body: { reason: "x" },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.statusCode).toBe(404);
  });

  it("POST /users/:userId/unban clears state", () => {
    db.prepare(
      `UPDATE users SET leaderboard_banned_at = ?, leaderboard_banned_reason = ? WHERE id = ?`,
    ).run("2026-01-01T00:00:00Z", "x", aliceId);
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/unban", "post");
    const req = mockReq(adminId, { params: { userId: aliceId }, body: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.banned).toBe(false);
  });

  it("POST /users/:userId/test-flag toggles flag", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/users/:userId/test-flag", "post");
    const req = mockReq(adminId, {
      params: { userId: aliceId },
      body: { isTest: true },
    });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.isTestAccount).toBe(true);
  });
});

describe("GET /banned & /audit", () => {
  it("GET /banned lists banned users", () => {
    db.prepare(
      `UPDATE users SET leaderboard_banned_at = ?, leaderboard_banned_reason = ? WHERE id = ?`,
    ).run("2026-01-01T00:00:00Z", "x", aliceId);
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/banned");
    const req = mockReq(adminId, { query: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.total).toBe(1);
    expect(data.body.users[0].userId).toBe(aliceId);
  });

  it("GET /audit returns moderation log", () => {
    db.prepare(
      `INSERT INTO admin_leaderboard_audit
         (admin_user_id, admin_username, action, target_type, target_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(adminId, "admin", "exclude_entry", "entry", "1", "2026-01-01T00:00:00Z");
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/audit");
    const req = mockReq(adminId, { query: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body.total).toBe(1);
    expect(data.body.entries[0].action).toBe("exclude_entry");
  });
});

describe("GET /stats", () => {
  it("returns aggregate counts", () => {
    const router = createAdminLeaderboardRouter(db);
    const handler = getHandler(router, "/stats");
    const req = mockReq(adminId, { query: {} });
    const { res, data } = mockRes();
    handler(req, res);
    expect(data.body).toEqual({
      totalEntries: 2,
      excludedEntries: 0,
      bannedUsers: 0,
      testAccounts: 0,
    });
  });
});
