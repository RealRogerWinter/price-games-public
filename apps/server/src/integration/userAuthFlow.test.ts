/**
 * End-to-end integration tests for the user authentication flow.
 *
 * Exercises the full lifecycle: register -> login -> me -> change password ->
 * logout -> login with new password. Each test gets a fresh in-memory database
 * and its own HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer, Server as HttpServer } from "http";
import { createTestDb } from "../test/dbHelper";
import { createUserRouter } from "../routes/user";
import { config } from "../config";
import { createEmailVerificationToken } from "../services/userAuth";
import { visitorCookie } from "../middleware/visitorCookie";
import { recordVisitorAttribution } from "../services/visitorAttribution";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;
let server: HttpServer;
let baseUrl: string;

/**
 * Build an Express app wired to the user router with the given database.
 *
 * @param db - Database instance to inject into the router.
 * @returns Configured Express application.
 */
function buildApp(db: DatabaseType) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Issue/read the anonymous visitor cookie for every request, matching
  // the real server wiring in index.ts. Without this middleware the
  // register/attribute-signup handlers would see req.visitorId as
  // undefined and the visitor-attribution merge would be a no-op.
  app.use(visitorCookie);
  app.use("/api/user", createUserRouter(db));
  return app;
}

/**
 * Extract the user_session cookie value from a Set-Cookie response header
 * and return it as a Cookie header string.
 *
 * @param response - The fetch Response object.
 * @returns Cookie header string, or empty string if not found.
 */
function extractCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return "";
  const match = setCookie.match(/user_session=([^;]+)/);
  return match ? `user_session=${match[1]}` : "";
}

beforeEach(async () => {
  testDb = createTestDb();
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

describe("User auth end-to-end flow", () => {
  it("full flow: register -> login -> me -> change password -> logout -> login with new password", { timeout: 30000 }, async () => {
    // Step 1: Register
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "flowuser", email: "flow@example.com", password: "initialpass1" }),
    });
    expect(registerRes.status).toBe(200);
    const registerBody = await registerRes.json();
    expect(registerBody.user).toBeDefined();
    expect(registerBody.user.username).toBe("flowuser");
    expect(registerBody.user.email).toBe("flow@example.com");
    expect(registerBody.emailVerificationPending).toBe(true);
    const registerCookie = extractCookie(registerRes);
    expect(registerCookie).not.toBe("");

    // Step 2: Login (should work with the registered credentials)
    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "flow@example.com", password: "initialpass1" }),
    });
    expect(loginRes.status).toBe(200);
    const loginCookie = extractCookie(loginRes);
    expect(loginCookie).not.toBe("");

    // Step 3: Access /me
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: loginCookie },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user.username).toBe("flowuser");
    expect(meBody.user.email).toBe("flow@example.com");

    // Step 4: Change password
    const changePwRes = await fetch(`${baseUrl}/api/user/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: loginCookie },
      body: JSON.stringify({ currentPassword: "initialpass1", newPassword: "changedpass12" }),
    });
    expect(changePwRes.status).toBe(200);
    const changePwBody = await changePwRes.json();
    expect(changePwBody.ok).toBe(true);
    const newCookie = extractCookie(changePwRes);
    expect(newCookie).not.toBe("");

    // Step 5: Old session should be invalidated (/me uses optionalUser — returns 200 with null user)
    const meAfterChange = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: loginCookie },
    });
    expect(meAfterChange.status).toBe(200);
    const meAfterChangeBody = await meAfterChange.json();
    expect(meAfterChangeBody.user).toBeNull();

    // Step 6: Logout
    const logoutRes = await fetch(`${baseUrl}/api/user/logout`, {
      method: "POST",
      headers: { Cookie: newCookie },
    });
    expect(logoutRes.status).toBe(200);

    // Step 7: /me should return null user after logout
    const meAfterLogout = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: newCookie },
    });
    expect(meAfterLogout.status).toBe(200);
    const meAfterLogoutBody = await meAfterLogout.json();
    expect(meAfterLogoutBody.user).toBeNull();

    // Step 8: Login with new password
    const reLoginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "flow@example.com", password: "changedpass12" }),
    });
    expect(reLoginRes.status).toBe(200);
    const reLoginCookie = extractCookie(reLoginRes);
    expect(reLoginCookie).not.toBe("");

    // Step 9: Old password should not work
    const oldPwRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "flow@example.com", password: "initialpass1" }),
    });
    expect(oldPwRes.status).toBe(401);
  });

  it("email verification flow", { timeout: 15000 }, async () => {
    // Register
    const { cookie } = await (async () => {
      const res = await fetch(`${baseUrl}/api/user/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "verifyflow", email: "verify@example.com", password: "testpassword1" }),
      });
      return { cookie: extractCookie(res) };
    })();

    // Resend verification (token is no longer returned in the response for security)
    const resendRes = await fetch(`${baseUrl}/api/user/resend-verification`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(resendRes.status).toBe(200);
    // Get the user id for direct token creation (tokens are stored hashed in DB,
    // so we create a fresh raw token via the service function for this test)
    const userRow = testDb
      .prepare("SELECT id FROM users WHERE email = ?")
      .get("verify@example.com") as { id: string };
    const verifyToken = createEmailVerificationToken(testDb, userRow.id, "verify@example.com");

    // Verify email
    const verifyRes = await fetch(`${baseUrl}/api/user/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verifyToken }),
    });
    expect(verifyRes.status).toBe(200);

    // Check /me shows emailVerified=true (need to re-login to see updated state since session cache)
    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "verify@example.com", password: "testpassword1" }),
    });
    const newCookie = extractCookie(loginRes);
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: newCookie },
    });
    const meBody = await meRes.json();
    expect(meBody.user.emailVerified).toBe(true);
  });

  it("cannot access protected endpoints without auth", async () => {
    // /me uses optionalUser (returns 200 with user: null), so it's excluded here
    const endpoints = [
      { method: "POST", path: "/api/user/logout" },
      { method: "POST", path: "/api/user/resend-verification" },
      { method: "PUT", path: "/api/user/email" },
      { method: "PUT", path: "/api/user/password" },
      { method: "GET", path: "/api/user/history" },
      { method: "GET", path: "/api/user/stats" },
    ];

    for (const { method, path } of endpoints) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method !== "GET" ? JSON.stringify({}) : undefined,
      });
      expect(res.status).toBe(401);
    }

    // /me specifically should return 200 with null user when unauthenticated
    const meRes = await fetch(`${baseUrl}/api/user/me`);
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user).toBeNull();
  });

  it("supports login by username", async () => {
    // Register
    await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ByNameUser", email: "byname@example.com", password: "testpassword1" }),
    });

    // Login by username (case-insensitive)
    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "bynameuser", password: "testpassword1" }),
    });
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.user.username).toBe("ByNameUser");
  });

  it("supports expired session detection", async () => {
    // Register
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "expireuser", email: "expire@example.com", password: "testpassword1" }),
    });
    const cookie = extractCookie(registerRes);

    // Verify session works
    const meRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);

    // Expire all sessions
    testDb
      .prepare("UPDATE user_sessions SET expires_at = ?")
      .run(new Date(Date.now() - 86400000).toISOString());

    // Now should return null user (me uses optionalUser, returns 200 with user: null)
    const expiredRes = await fetch(`${baseUrl}/api/user/me`, {
      headers: { Cookie: cookie },
    });
    expect(expiredRes.status).toBe(200);
    const expiredBody = await expiredRes.json();
    expect(expiredBody.user).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // UTM attribution capture (Reddit ads prep)
  // ---------------------------------------------------------------------------

  it("stores UTM attribution from the register body onto the users row", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "utmuser",
        email: "utm@example.com",
        password: "testpassword1",
        attribution: {
          utm_source: "reddit",
          utm_medium: "cpc",
          utm_campaign: "giveaway_test",
          utm_content: "variant_giftcard",
          utm_term: "guess-the-price",
          landing_page: "/giveaway",
          referrer: "https://www.reddit.com/r/Frugal/",
        },
      }),
    });
    expect(registerRes.status).toBe(200);

    const row = testDb
      .prepare(
        "SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, signup_referrer FROM users WHERE email = ?",
      )
      .get("utm@example.com") as Record<string, string | null>;

    expect(row.utm_source).toBe("reddit");
    expect(row.utm_medium).toBe("cpc");
    expect(row.utm_campaign).toBe("giveaway_test");
    expect(row.utm_content).toBe("variant_giftcard");
    expect(row.utm_term).toBe("guess-the-price");
    expect(row.landing_page).toBe("/giveaway");
    expect(row.signup_referrer).toBe("https://www.reddit.com/r/Frugal/");
  });

  it("ignores a malformed attribution body without failing registration", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "malformed",
        email: "malformed@example.com",
        password: "testpassword1",
        attribution: "not-an-object",
      }),
    });
    expect(registerRes.status).toBe(200);

    const row = testDb
      .prepare("SELECT utm_source FROM users WHERE email = ?")
      .get("malformed@example.com") as { utm_source: string | null };
    expect(row.utm_source).toBeNull();
  });

  it("does not require attribution on register", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "noattr",
        email: "noattr@example.com",
        password: "testpassword1",
      }),
    });
    expect(registerRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // POST /api/user/attribute-signup (OAuth attribution)
  // ---------------------------------------------------------------------------

  it("attribute-signup writes UTM for a freshly-registered user", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "attrsignup",
        email: "attrsignup@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);

    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attribution: { utm_source: "reddit", utm_campaign: "oauth_test" },
      }),
    });
    expect(attrRes.status).toBe(200);
    const body = await attrRes.json();
    expect(body.wasAttributed).toBe(true);

    const row = testDb
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE email = ?")
      .get("attrsignup@example.com") as Record<string, string | null>;
    expect(row.utm_source).toBe("reddit");
    expect(row.utm_campaign).toBe("oauth_test");
  });

  it("attribute-signup is a no-op on second call (first-touch wins)", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "attrtwice",
        email: "attrtwice@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);

    await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attribution: { utm_source: "reddit" },
      }),
    });

    const secondRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attribution: { utm_source: "google" },
      }),
    });
    expect(secondRes.status).toBe(200);
    const body = await secondRes.json();
    expect(body.wasAttributed).toBe(false);

    const row = testDb
      .prepare("SELECT utm_source FROM users WHERE email = ?")
      .get("attrtwice@example.com") as { utm_source: string };
    expect(row.utm_source).toBe("reddit");
  });

  it("attribute-signup is a no-op outside the 10-minute window", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "attrstale",
        email: "attrstale@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);

    // Back-date the user's created_at to 20 minutes ago
    const staleDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    testDb
      .prepare("UPDATE users SET created_at = ? WHERE email = ?")
      .run(staleDate, "attrstale@example.com");

    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attribution: { utm_source: "reddit" },
      }),
    });
    expect(attrRes.status).toBe(200);
    const body = await attrRes.json();
    expect(body.wasAttributed).toBe(false);

    const row = testDb
      .prepare("SELECT utm_source FROM users WHERE email = ?")
      .get("attrstale@example.com") as { utm_source: string | null };
    expect(row.utm_source).toBeNull();
  });

  it("attribute-signup requires authentication", async () => {
    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attribution: { utm_source: "reddit" },
      }),
    });
    expect(attrRes.status).toBe(401);
  });

  it("attribute-signup returns wasAttributed:false for an empty body", async () => {
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "attrempty",
        email: "attrempty@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);

    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(attrRes.status).toBe(200);
    const body = await attrRes.json();
    expect(body.wasAttributed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Visitor cookie → signup merge (anonymous attribution flow)
  // ---------------------------------------------------------------------------

  it("register merges visitor_attribution onto the user when the cookie is present", async () => {
    // Pre-seed a visitor row as if the client had POSTed /api/attribution/track.
    const visitorId = "11111111-2222-3333-4444-555555555555";
    recordVisitorAttribution(testDb, visitorId, {
      utm_source: "reddit",
      utm_medium: "social",
      utm_campaign: "anon_merge",
      landing_page: "/giveaway",
    });

    // Register WITHOUT an attribution body — the merge should pull from
    // the cookie-backed row.
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `visitor_id=${visitorId}`,
      },
      body: JSON.stringify({
        username: "anonmerge",
        email: "anonmerge@example.com",
        password: "testpassword1",
      }),
    });
    expect(registerRes.status).toBe(200);

    const row = testDb
      .prepare(
        "SELECT utm_source, utm_medium, utm_campaign, landing_page FROM users WHERE email = ?",
      )
      .get("anonmerge@example.com") as Record<string, string | null>;
    expect(row.utm_source).toBe("reddit");
    expect(row.utm_medium).toBe("social");
    expect(row.utm_campaign).toBe("anon_merge");
    expect(row.landing_page).toBe("/giveaway");

    // The visitor row should be marked as claimed by this user.
    const visitorRow = testDb
      .prepare("SELECT claimed_user_id FROM visitor_attribution WHERE visitor_id = ?")
      .get(visitorId) as { claimed_user_id: string | null };
    expect(visitorRow.claimed_user_id).not.toBeNull();
  });

  it("register prefers the request body attribution when both sources are present", async () => {
    const visitorId = "22222222-3333-4444-5555-666666666666";
    recordVisitorAttribution(testDb, visitorId, {
      utm_source: "reddit",
      utm_campaign: "cookie_source",
    });

    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `visitor_id=${visitorId}`,
      },
      body: JSON.stringify({
        username: "bodywins",
        email: "bodywins@example.com",
        password: "testpassword1",
        attribution: { utm_source: "google", utm_campaign: "body_source" },
      }),
    });
    expect(registerRes.status).toBe(200);

    const row = testDb
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE email = ?")
      .get("bodywins@example.com") as Record<string, string | null>;
    // The body-supplied UTM wins because storeSignupAttribution runs first.
    expect(row.utm_source).toBe("google");
    expect(row.utm_campaign).toBe("body_source");

    // The visitor row is still claimed so it stops being counted as unclaimed.
    const visitorRow = testDb
      .prepare("SELECT claimed_user_id FROM visitor_attribution WHERE visitor_id = ?")
      .get(visitorId) as { claimed_user_id: string | null };
    expect(visitorRow.claimed_user_id).not.toBeNull();
  });

  it("attribute-signup falls back to the visitor cookie when the body is empty", async () => {
    // OAuth-style flow: register first (simulating an account created via
    // OAuth callback where attribution wasn't supplied), then call
    // /attribute-signup with no body payload. The visitor cookie should
    // still carry the merge forward.
    const visitorId = "33333333-4444-5555-6666-777777777777";
    recordVisitorAttribution(testDb, visitorId, {
      utm_source: "reddit",
      utm_campaign: "oauth_cookie_merge",
    });

    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "oauthmerge",
        email: "oauthmerge@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);
    expect(cookie).not.toBe("");

    // Clear the utm_source so hasRecentSignupWithoutAttribution passes
    // (register may or may not have merged depending on which request
    // carried the visitor cookie; explicitly null it out to exercise the
    // attribute-signup fallback in isolation).
    testDb
      .prepare("UPDATE users SET utm_source = NULL, utm_campaign = NULL WHERE email = ?")
      .run("oauthmerge@example.com");

    // Reset visitor row so it's not yet claimed.
    testDb
      .prepare(
        "UPDATE visitor_attribution SET claimed_user_id = NULL, claimed_at = NULL WHERE visitor_id = ?",
      )
      .run(visitorId);

    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookie}; visitor_id=${visitorId}`,
      },
      body: JSON.stringify({}),
    });
    expect(attrRes.status).toBe(200);
    const body = await attrRes.json();
    expect(body.wasAttributed).toBe(true);

    const row = testDb
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE email = ?")
      .get("oauthmerge@example.com") as Record<string, string | null>;
    expect(row.utm_source).toBe("reddit");
    expect(row.utm_campaign).toBe("oauth_cookie_merge");
  });

  // ---------------------------------------------------------------------------
  // "Stay logged in" cookie option on POST /login
  // ---------------------------------------------------------------------------
  //
  // When stayLoggedIn is true (or omitted for backwards compat), the
  // Set-Cookie header carries Max-Age / Expires so the cookie survives a
  // browser restart. When stayLoggedIn is false, we want a bare session
  // cookie — no Max-Age, no Expires — so the browser deletes it on close.
  // In both cases the session is still valid for /me in the same window.

  /**
   * Extract only the `user_session=...` cookie's attribute list from a
   * Set-Cookie response header. The visitor cookie middleware also
   * writes a `visitor_id=...; max-age=...` cookie, so a naive substring
   * match against the full header would false-positive. This slices out
   * the user_session segment (which is always last in the login
   * response) and returns it in lowercase for case-insensitive matching.
   */
  function userSessionCookieSegment(response: Response): string {
    const setCookie = (response.headers.get("set-cookie") ?? "").toLowerCase();
    const idx = setCookie.indexOf("user_session=");
    if (idx === -1) return "";
    return setCookie.slice(idx);
  }

  it("login without stayLoggedIn sets a persistent cookie (backwards compat)", async () => {
    await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "stayunset", email: "stayunset@example.com", password: "testpassword1" }),
    });

    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "stayunset@example.com", password: "testpassword1" }),
    });
    expect(loginRes.status).toBe(200);

    const segment = userSessionCookieSegment(loginRes);
    expect(segment).toContain("user_session=");
    // Backwards compat: missing flag behaves like stayLoggedIn=true.
    expect(segment).toMatch(/max-age=|expires=/);

    // Cookie is still usable for /me.
    const cookie = extractCookie(loginRes);
    const meRes = await fetch(`${baseUrl}/api/user/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user?.email).toBe("stayunset@example.com");
  });

  it("login with stayLoggedIn=true sets a persistent cookie", async () => {
    await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "staytrue", email: "staytrue@example.com", password: "testpassword1" }),
    });

    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "staytrue@example.com",
        password: "testpassword1",
        stayLoggedIn: true,
      }),
    });
    expect(loginRes.status).toBe(200);

    const segment = userSessionCookieSegment(loginRes);
    expect(segment).toContain("user_session=");
    expect(segment).toMatch(/max-age=|expires=/);
  });

  it("login with stayLoggedIn=false sets a browser-session cookie (no Max-Age / Expires)", async () => {
    await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "stayfalse", email: "stayfalse@example.com", password: "testpassword1" }),
    });

    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "stayfalse@example.com",
        password: "testpassword1",
        stayLoggedIn: false,
      }),
    });
    expect(loginRes.status).toBe(200);

    const segment = userSessionCookieSegment(loginRes);
    expect(segment).toContain("user_session=");
    // Browser session cookie — neither Max-Age nor Expires should be
    // present on the user_session portion.
    expect(segment).not.toMatch(/max-age=/);
    expect(segment).not.toMatch(/expires=/);

    // Still usable for /me in the current session.
    const cookie = extractCookie(loginRes);
    const meRes = await fetch(`${baseUrl}/api/user/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user?.email).toBe("stayfalse@example.com");
  });

  it("login rejects a non-boolean stayLoggedIn value with 400", async () => {
    await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "staybad", email: "staybad@example.com", password: "testpassword1" }),
    });

    const loginRes = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "staybad@example.com",
        password: "testpassword1",
        stayLoggedIn: "yes",
      }),
    });
    expect(loginRes.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Turnstile enforcement on registration
  // ---------------------------------------------------------------------------

  it("rejects registration when Turnstile is configured but no token is provided", async () => {
    // Simulate a production environment where Turnstile is enforced
    const originalSecret = config.turnstileSecretKey;
    (config as any).turnstileSecretKey = "real-secret-key";
    try {
      const res = await fetch(`${baseUrl}/api/user/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "noturnstile",
          email: "noturnstile@example.com",
          password: "testpassword1",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Verification challenge is required");
    } finally {
      (config as any).turnstileSecretKey = originalSecret;
    }
  });

  it("rejects registration when Turnstile token exceeds max length", async () => {
    const originalSecret = config.turnstileSecretKey;
    (config as any).turnstileSecretKey = "real-secret-key";
    try {
      const res = await fetch(`${baseUrl}/api/user/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "longtoken",
          email: "longtoken@example.com",
          password: "testpassword1",
          turnstileToken: "x".repeat(2049),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid verification token");
    } finally {
      (config as any).turnstileSecretKey = originalSecret;
    }
  });

  it("allows registration without token when Turnstile is NOT configured", async () => {
    // Default test environment: turnstileSecretKey is empty
    const originalSecret = config.turnstileSecretKey;
    (config as any).turnstileSecretKey = "";
    try {
      const res = await fetch(`${baseUrl}/api/user/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "notenforced",
          email: "notenforced@example.com",
          password: "testpassword1",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.username).toBe("notenforced");
    } finally {
      (config as any).turnstileSecretKey = originalSecret;
    }
  });

  it("attribute-signup rejects a payload without utm_source", async () => {
    // Mirrors the first-touch-wins hardening: payloads without utm_source
    // are dropped by validateAttribution, so the endpoint returns
    // wasAttributed:false without writing anything.
    const registerRes = await fetch(`${baseUrl}/api/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "attrnosource",
        email: "attrnosource@example.com",
        password: "testpassword1",
      }),
    });
    const cookie = extractCookie(registerRes);

    const attrRes = await fetch(`${baseUrl}/api/user/attribute-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attribution: { utm_medium: "cpc", utm_campaign: "no_source" },
      }),
    });
    expect(attrRes.status).toBe(200);
    const body = await attrRes.json();
    expect(body.wasAttributed).toBe(false);

    const row = testDb
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE email = ?")
      .get("attrnosource@example.com") as Record<string, string | null>;
    expect(row.utm_source).toBeNull();
    expect(row.utm_campaign).toBeNull();
  });
});
