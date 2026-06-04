/**
 * Tests for the lobby-invite-reward HTTP routes:
 *   POST /api/mp/rooms/:code/invite-token
 *   DELETE /api/mp/invite-tokens/:token
 *   GET /r/:token  (resolver — mounted at root)
 *   GET /api/users/me/buffs
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => ({ default: null as any }));

beforeEach(async () => {
  testDb = createTestDb();
  const mod = await import("../db");
  (mod as any).default = testDb;
});

const { createRoom } = await import("../services/roomManager");
const {
  inviteRewardsApiRouter,
  inviteResolverRouter,
  userBuffsRouter,
} = await import("./inviteRewards");
const inviteRewardsService = await import("../services/inviteRewards");

interface MockResData {
  statusCode?: number;
  body?: unknown;
  redirect?: string;
  cookies: Array<{ name: string; value: string; opts?: Record<string, unknown> }>;
  cleared: string[];
}

interface MockReq {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  cookies: Record<string, string>;
  ip?: string;
  user?: { id: string };
  visitorId?: string;
  [key: string]: unknown;
}

function makeReqRes(opts: Partial<MockReq> = {}) {
  const req: MockReq = {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    cookies: opts.cookies ?? {},
    ip: opts.ip ?? "5.5.5.5",
    user: opts.user,
    visitorId: opts.visitorId ?? "v-default",
    headers: { host: "test.local" },
    protocol: "https",
    hostname: "test.local",
  };
  const data: MockResData = { cookies: [], cleared: [] };
  const res = {
    json(b: unknown) { data.body = b; return res; },
    status(c: number) { data.statusCode = c; return res; },
    redirect(url: string) { data.redirect = url; return res; },
    cookie(name: string, value: string, o?: Record<string, unknown>) {
      data.cookies.push({ name, value, opts: o });
      return res;
    },
    clearCookie(name: string) { data.cleared.push(name); return res; },
    sendStatus(c: number) { data.statusCode = c; return res; },
  };
  return { req: req as any, res: res as any, data };
}

function findHandler(router: any, method: string, path: string): any {
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No ${method} ${path}`);
  // Last handler is the user's; earlier ones are middleware (visitorCookie, optionalUser, etc.)
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// ---------------------------------------------------------------------------
// POST /api/mp/rooms/:code/invite-token
// ---------------------------------------------------------------------------

describe("POST /api/mp/rooms/:code/invite-token", () => {
  it("mints a token for the host of the room", async () => {
    const created = await createRoom("Host");
    const handler = findHandler(inviteRewardsApiRouter, "POST", "/rooms/:code/invite-token");
    const { req, res, data } = makeReqRes({
      params: { code: created.room.code },
      visitorId: "v-host",
      body: { playerToken: created.playerToken },
    });
    await handler(req, res);
    expect(data.statusCode).toBeUndefined(); // 200 default
    const body = data.body as { token: string; url: string };
    expect(body.token).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(body.url).toContain(`/r/${body.token}`);
    // Persisted with the visitor as inviter.
    const row = testDb
      .prepare("SELECT inviter_visitor_id, inviter_ip FROM mp_invite_tokens WHERE token = ?")
      .get(body.token) as { inviter_visitor_id: string; inviter_ip: string };
    expect(row.inviter_visitor_id).toBe("v-host");
    expect(row.inviter_ip).toBe("5.5.5.5");
  });

  it("returns 404 if the room doesn't exist", async () => {
    const handler = findHandler(inviteRewardsApiRouter, "POST", "/rooms/:code/invite-token");
    const { req, res, data } = makeReqRes({
      params: { code: "NOPE" },
      body: { playerToken: "missing" },
    });
    await handler(req, res);
    expect(data.statusCode).toBe(404);
  });

  it("returns 403 if the requester is not the host", async () => {
    const created = await createRoom("Host");
    const handler = findHandler(inviteRewardsApiRouter, "POST", "/rooms/:code/invite-token");
    const { req, res, data } = makeReqRes({
      params: { code: created.room.code },
      body: { playerToken: "not-the-host-token" },
    });
    await handler(req, res);
    expect(data.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/mp/invite-tokens/:token
// ---------------------------------------------------------------------------

describe("DELETE /api/mp/invite-tokens/:token", () => {
  it("revokes a token belonging to the requester's visitor", () => {
    // Seed the room first — mp_invite_tokens FK requires it.
    testDb.prepare(
      `INSERT OR IGNORE INTO mp_rooms (code, host_player_id, status, created_at) VALUES ('ABCD','h','lobby',datetime('now'))`,
    ).run();
    const { token } = inviteRewardsService.mintInviteToken(
      testDb,
      {
        roomCode: "ABCD",
        inviterUserId: null,
        inviterVisitorId: "v-host",
        inviterIp: "5.5.5.5",
        inviterFp: null,
      },
      1_700_000_000,
    );

    const handler = findHandler(inviteRewardsApiRouter, "DELETE", "/invite-tokens/:token([A-Za-z0-9]{10})");
    const { req, res, data } = makeReqRes({
      params: { token },
      visitorId: "v-host",
    });
    handler(req, res);
    expect(data.statusCode).toBe(204);
    const row = testDb.prepare("SELECT revoked_at FROM mp_invite_tokens WHERE token = ?").get(token) as { revoked_at: number | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it("returns 404 when the requester does not own the token", () => {
    testDb.prepare(
      `INSERT OR IGNORE INTO mp_rooms (code, host_player_id, status, created_at) VALUES ('ABCD','h','lobby',datetime('now'))`,
    ).run();
    const { token } = inviteRewardsService.mintInviteToken(
      testDb,
      {
        roomCode: "ABCD",
        inviterUserId: null,
        inviterVisitorId: "v-other",
        inviterIp: "5.5.5.5",
        inviterFp: null,
      },
    );
    const handler = findHandler(inviteRewardsApiRouter, "DELETE", "/invite-tokens/:token([A-Za-z0-9]{10})");
    const { req, res, data } = makeReqRes({
      params: { token },
      visitorId: "v-host", // wrong visitor
    });
    handler(req, res);
    expect(data.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /r/:token
// ---------------------------------------------------------------------------

describe("GET /r/:token", () => {
  it("only registers the 10-char path-constrained handler so 8-char signup-referral URLs fall through to the SPA", () => {
    // The existing /r/{8-char-code} signup-referral redirect lives in the
    // SPA's React Router. We must NOT shadow it from the server. Verify that
    // every route on the resolver router is path-constrained.
    const paths = (inviteResolverRouter.stack as Array<{ route?: { path?: string } }>)
      .map((l) => l.route?.path)
      .filter((p): p is string => typeof p === "string");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      // Every route must include a parenthesized regex constraint (so 8-char
      // signup-referral URLs don't match this router and fall through to
      // the SPA's React Router).
      expect(p).toContain("(");
      expect(p).toContain(")");
      // Specifically: the constraint must enforce exactly 10 alphanumerics.
      expect(p).toMatch(/A-Za-z0-9.*\{10\}/);
    }
  });

  it("redirects to /{roomCode} and sets the pg_inv cookie", () => {
    testDb.prepare(
      `INSERT OR IGNORE INTO mp_rooms (code, host_player_id, status, created_at) VALUES ('ABCD','h','lobby',datetime('now'))`,
    ).run();
    const { token } = inviteRewardsService.mintInviteToken(testDb, {
      roomCode: "ABCD",
      inviterUserId: null,
      inviterVisitorId: "v-host",
      inviterIp: "5.5.5.5",
      inviterFp: null,
    });
    const handler = findHandler(inviteResolverRouter, "GET", "/:token([A-Za-z0-9]{10})");
    const { req, res, data } = makeReqRes({ params: { token } });
    handler(req, res);
    expect(data.redirect).toBe("/ABCD");
    const cookie = data.cookies.find((c) => c.name === "pg_inv");
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe(token);
    expect(cookie!.opts!.httpOnly).toBe(true);
    expect(cookie!.opts!.sameSite).toBe("lax");
  });

  it("redirects to /multiplayer with no cookie when token is unknown", () => {
    const handler = findHandler(inviteResolverRouter, "GET", "/:token([A-Za-z0-9]{10})");
    const { req, res, data } = makeReqRes({ params: { token: "Doesnotexi" } });
    handler(req, res);
    expect(data.redirect).toBe("/multiplayer");
    expect(data.cookies).toHaveLength(0);
  });

  it("redirects to /multiplayer with no cookie when token is revoked", () => {
    testDb.prepare(
      `INSERT OR IGNORE INTO mp_rooms (code, host_player_id, status, created_at) VALUES ('ABCD','h','lobby',datetime('now'))`,
    ).run();
    const { token } = inviteRewardsService.mintInviteToken(testDb, {
      roomCode: "ABCD",
      inviterUserId: null,
      inviterVisitorId: "v-host",
      inviterIp: "5.5.5.5",
      inviterFp: null,
    });
    inviteRewardsService.revokeInviteToken(testDb, token, "v-host");
    const handler = findHandler(inviteResolverRouter, "GET", "/:token([A-Za-z0-9]{10})");
    const { req, res, data } = makeReqRes({ params: { token } });
    handler(req, res);
    expect(data.redirect).toBe("/multiplayer");
    expect(data.cookies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/me/buffs
// ---------------------------------------------------------------------------

describe("GET /api/users/me/buffs", () => {
  it("returns active buffs for the visitor", () => {
    testDb.prepare(
      `INSERT OR IGNORE INTO mp_rooms (code, host_player_id, status, created_at) VALUES ('ABCD','h','lobby',datetime('now'))`,
    ).run();
    const { token } = inviteRewardsService.mintInviteToken(testDb, {
      roomCode: "ABCD",
      inviterUserId: null,
      inviterVisitorId: "v-host",
      inviterIp: "5.5.5.5",
      inviterFp: null,
    });
    const r = inviteRewardsService.attributeJoin(testDb, {
      token,
      joiner: { playerId: "p", userId: null, visitorId: "v-bene", ip: "1.1.1.1", fp: null },
    });
    if (r.status !== "pending") throw new Error("expected pending");
    // Tick three rounds to earn the buffs.
    for (let i = 0; i < 3; i++) {
      inviteRewardsService.recordRoundCompleted(testDb, { roomCode: "ABCD", joinerPlayerId: "p" });
    }
    const handler = findHandler(userBuffsRouter, "GET", "/me/buffs");
    const { req, res, data } = makeReqRes({ visitorId: "v-bene" });
    handler(req, res);
    const body = data.body as { active: Array<{ source: string; multiplier: number }> };
    expect(body.active.length).toBeGreaterThan(0);
    expect(body.active[0].source).toMatch(/invite_(host|joiner)/);
  });

  it("returns an empty array when no buffs are active", () => {
    const handler = findHandler(userBuffsRouter, "GET", "/me/buffs");
    const { req, res, data } = makeReqRes({ visitorId: "v-empty" });
    handler(req, res);
    expect((data.body as { active: unknown[] }).active).toEqual([]);
  });
});
