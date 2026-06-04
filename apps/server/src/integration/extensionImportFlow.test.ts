/**
 * Integration tests for the Chrome extension import flow.
 *
 * Verifies the full lifecycle: login → import new product → import same ASIN
 * (update) → verify. Also tests permission denied flow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer, Server as HttpServer } from "http";
import { createTestDb, seedAdminUser } from "../test/dbHelper";
import { createAdminRouter } from "../routes/admin";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;
let server: HttpServer;
let baseUrl: string;

function buildApp(db: DatabaseType) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin", createAdminRouter(db));
  return app;
}

describe("Extension import flow", () => {
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

  it("full lifecycle: login → import new → import same ASIN (update) → verify", async () => {
    seedAdminUser(testDb, "extadmin", "testpassword123", true);

    // Step 1: Login via extension endpoint
    const loginRes = await fetch(`${baseUrl}/api/admin/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "extadmin", password: "testpassword123" }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeDefined();
    expect(loginBody.user.canUseExtension).toBe(true);
    const token = loginBody.token;

    // Step 2: Import new product
    const import1Res = await fetch(`${baseUrl}/api/admin/extension/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        asin: "B0TESTPRD1",
        title: "Sony WH-1000XM5 Headphones",
        priceCents: 34999,
        imageUrl: "https://m.media-amazon.com/images/I/test.jpg",
        category: "Electronics",
        manufacturer: "Sony",
      }),
    });
    expect(import1Res.status).toBe(201);
    const import1Body = await import1Res.json();
    expect(import1Body.created).toBe(true);
    expect(import1Body.product.asin).toBe("B0TESTPRD1");
    expect(import1Body.product.title).toBe("Sony WH-1000XM5 Headphones");
    expect(import1Body.product.priceCents).toBe(34999);
    expect(import1Body.product.manufacturer).toBe("Sony");
    const productId = import1Body.product.id;

    // Step 3: Import same ASIN with updated price (update path)
    const import2Res = await fetch(`${baseUrl}/api/admin/extension/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        asin: "B0TESTPRD1",
        title: "Sony WH-1000XM5 Headphones",
        priceCents: 29999,
        category: "Electronics",
        manufacturer: "Sony",
      }),
    });
    expect(import2Res.status).toBe(200);
    const import2Body = await import2Res.json();
    expect(import2Body.created).toBe(false);
    expect(import2Body.product.id).toBe(productId);
    expect(import2Body.product.priceCents).toBe(29999);

    // Step 4: Verify product was upserted (read directly from DB —
    // the extension Bearer token must NOT grant access to the regular
    // /api/admin/products/* surface, which is what this test originally
    // (incorrectly) asserted. PR3 sec M2 narrows the Bearer token's scope
    // to /api/admin/extension/* only; regular admin routes require the
    // cookie session.
    const product = testDb
      .prepare("SELECT asin, price_cents, is_active, scraped_at FROM products WHERE id = ?")
      .get(productId) as { asin: string; price_cents: number; is_active: number; scraped_at: string };
    expect(product.asin).toBe("B0TESTPRD1");
    expect(product.price_cents).toBe(29999);
    expect(product.is_active).toBe(1);
    expect(product.scraped_at).toBeDefined();
  });

  it("extension Bearer token cannot access non-extension admin routes (PR3 sec M2)", async () => {
    // Regression: pre-PR3, requireAdmin accepted both cookie and Bearer
    // tokens, so a leaked extension token granted full dashboard takeover.
    // The Bearer path is now reserved for /api/admin/extension/* only.
    seedAdminUser(testDb, "extadmin3", "testpassword123", true);

    const loginRes = await fetch(`${baseUrl}/api/admin/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "extadmin3", password: "testpassword123" }),
    });
    const { token } = await loginRes.json();

    // Try to use the extension Bearer token against a regular admin route
    // that lives under requireAdmin (cookie-only post-PR3).
    const productsRes = await fetch(`${baseUrl}/api/admin/products`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(productsRes.status).toBe(401);
  });

  it("verify endpoint returns ok for valid session", async () => {
    seedAdminUser(testDb, "extadmin2", "testpassword123", true);

    const loginRes = await fetch(`${baseUrl}/api/admin/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "extadmin2", password: "testpassword123" }),
    });
    const { token } = await loginRes.json();

    const verifyRes = await fetch(`${baseUrl}/api/admin/extension/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json();
    expect(body.ok).toBe(true);
    expect(body.user.username).toBe("extadmin2");
  });

  it("verify endpoint returns 401 for invalid token", async () => {
    const verifyRes = await fetch(`${baseUrl}/api/admin/extension/verify`, {
      headers: { Authorization: "Bearer invalidtoken123" },
    });
    expect(verifyRes.status).toBe(401);
  });

  it("permission denied flow: admin without can_use_extension gets 403", async () => {
    seedAdminUser(testDb, "noperm", "testpassword123", false);

    // Extension login should fail
    const loginRes = await fetch(`${baseUrl}/api/admin/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "noperm", password: "testpassword123" }),
    });
    expect(loginRes.status).toBe(403);
    const loginBody = await loginRes.json();
    expect(loginBody.error).toContain("Extension access not permitted");

    // Extension login should fail with 403 because canUseExtension is false.
    // (Pre-PR3 this test logged in via /api/admin/login (cookie session)
    // and tried to import via cookie — but the extension routes now
    // require Bearer auth, so the cookie path is rejected with 401 before
    // the canUseExtension check fires. To exercise the 403 branch we
    // route through /api/admin/extension/login which is where the
    // canUseExtension gate lives.)
    const extLoginRes = await fetch(`${baseUrl}/api/admin/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "noperm", password: "testpassword123" }),
    });
    expect(extLoginRes.status).toBe(403);
    const body = await extLoginRes.json();
    expect(body.error).toBe("Extension access not permitted");
  });
});
