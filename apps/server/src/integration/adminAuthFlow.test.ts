/**
 * End-to-end integration tests for the admin authentication flow.
 *
 * Exercises the full lifecycle: login, session management, analytics access,
 * logout, session expiry, concurrent sessions, and seeded data verification.
 * Each test gets a fresh in-memory database and its own HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer, Server as HttpServer } from "http";
import { createTestDb, seedAdminUser, seedAnalyticsData } from "../test/dbHelper";
import { createAdminRouter } from "../routes/admin";
import { config } from "../config";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;
let server: HttpServer;
let baseUrl: string;

/**
 * Build an Express app wired to the admin router with the given database.
 *
 * @param db - Database instance to inject into the router.
 * @returns Configured Express application.
 */
function buildApp(db: DatabaseType) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin", createAdminRouter(db));
  return app;
}

/**
 * Extract the admin_session cookie value from a Set-Cookie response header
 * and return it as a Cookie header string.
 *
 * @param response - The fetch Response object.
 * @returns Cookie header string, or empty string if not found.
 */
function extractCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return "";
  const match = setCookie.match(/admin_session=([^;]+)/);
  return match ? `admin_session=${match[1]}` : "";
}

/**
 * Login as the admin user and return the session cookie string.
 *
 * @param username - Admin username.
 * @param password - Admin password.
 * @returns Cookie header string for authenticated requests.
 */
async function login(
  username: string = "admin",
  password: string = "testpassword123"
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return extractCookie(res);
}

beforeEach(async () => {
  testDb = createTestDb();
  seedAdminUser(testDb, "admin", "testpassword123");
  seedAnalyticsData(testDb);
  const app = buildApp(testDb);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  if (server) server.close();
});

describe("Admin auth end-to-end flow", () => {
  it("full flow: login -> /me -> analytics/overview -> logout -> /me returns 401", async () => {
    // Step 1: Login
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.user).toBeDefined();
    expect(loginBody.user.username).toBe("admin");
    const cookie = extractCookie(loginRes);
    expect(cookie).not.toBe("");

    // Step 2: Access /me
    const meRes = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user.username).toBe("admin");

    // Step 3: Access an admin-only endpoint to verify the cookie flows
    // through `requireAdmin + require2faEnrolled`. /analytics/overview was
    // deleted in PR #209 — /analytics/active-rooms is the surviving live
    // ops endpoint and exercises the same auth gate.
    const analyticsRes = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`, {
      headers: { Cookie: cookie },
    });
    expect(analyticsRes.status).toBe(200);
    const analyticsBody = await analyticsRes.json();
    expect(Array.isArray(analyticsBody)).toBe(true);

    // Step 4: Logout
    const logoutRes = await fetch(`${baseUrl}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);

    // Step 5: /me should return 401 after logout
    const meAfterLogout = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie },
    });
    expect(meAfterLogout.status).toBe(401);
  });

  it("cannot access admin endpoints without auth", async () => {
    // The v1 dashboard endpoints were deleted in PR #209. Insights v2 has
    // its own auth coverage in analyticsV2.test.ts. /analytics/active-rooms
    // is the surviving v1-shaped ops endpoint and exercises the same
    // requireAdmin + require2faEnrolled gate as the rest of /api/admin/*.
    const res = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`);
    expect(res.status).toBe(401);
  });

  it("cannot access analytics with expired session", async () => {
    // Login to get a valid session
    const cookie = await login();
    expect(cookie).not.toBe("");

    // Verify the session works
    const meRes = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);

    // Manually expire the session in the database
    testDb
      .prepare("UPDATE admin_sessions SET expires_at = ?")
      .run(new Date(Date.now() - 86400000).toISOString());

    // Now requests should fail with 401. Use the surviving live ops
    // endpoint since the v1 /analytics/overview was deleted in PR #209.
    const expiredRes = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`, {
      headers: { Cookie: cookie },
    });
    expect(expiredRes.status).toBe(401);
  });

  it("supports multiple concurrent sessions for same admin", async () => {
    // Login twice to get two different sessions
    const cookie1 = await login();
    const cookie2 = await login();
    expect(cookie1).not.toBe("");
    expect(cookie2).not.toBe("");
    // Sessions should be different tokens
    expect(cookie1).not.toBe(cookie2);

    // Both sessions should work
    const me1 = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie1 },
    });
    expect(me1.status).toBe(200);

    const me2 = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie2 },
    });
    expect(me2.status).toBe(200);

    // Both should return the same admin user
    const body1 = await me1.json();
    const body2 = await me2.json();
    expect(body1.user.username).toBe("admin");
    expect(body2.user.username).toBe("admin");
  });

  it("login updates last_login_at timestamp", async () => {
    // Check initial state: last_login_at should be null
    const before = testDb
      .prepare("SELECT last_login_at FROM admin_users WHERE username = ?")
      .get("admin") as { last_login_at: string | null };
    expect(before.last_login_at).toBeNull();

    // Login
    await login();

    // Check that last_login_at was updated
    const after = testDb
      .prepare("SELECT last_login_at FROM admin_users WHERE username = ?")
      .get("admin") as { last_login_at: string | null };
    expect(after.last_login_at).not.toBeNull();
    // Should be a valid ISO date string
    expect(new Date(after.last_login_at!).getTime()).toBeGreaterThan(0);
  });

  it("active-rooms ops endpoint returns seeded room with player count", async () => {
    // Replaces the broader v1 dashboard-data assertion. The overview /
    // games-by-mode / score-distribution endpoints were deleted in PR
    // #209; their replacements live in analyticsV2.test.ts and test the
    // same data shape via the events-stream pipeline.
    const cookie = await login();

    const roomsRes = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`, {
      headers: { Cookie: cookie },
    });
    expect(roomsRes.status).toBe(200);
    const rooms = await roomsRes.json();
    expect(rooms.length).toBe(1);
    expect(rooms[0].code).toBe("AAAA");
    expect(rooms[0].playerCount).toBe(2);

    // Verify popular categories returns data (seeded products are Electronics + Home & Kitchen)
  });
});
