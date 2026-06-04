/**
 * Tests for the admin panel routes.
 *
 * Combines HTTP integration tests (existing) with handler-level unit tests
 * targeting uncovered lines. Handler-level tests extract route handlers from the
 * Express router stack and call them directly with mock request/response objects,
 * bypassing the requireAdmin middleware.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer, Server as HttpServer } from "http";
import {
  createTestDb,
  seedAdminUser,
  seedAnalyticsData,
  seedProducts,
  seedDiverseProducts,
  createTestContactsDb,
  seedManufacturer,
  seedContact,
  seedUser,
} from "../test/dbHelper";
import { createAdminRouter } from "./admin";
import { config } from "../config";
import type { Database as DatabaseType } from "better-sqlite3";
import { setGhostSettings } from "../services/ghostUsers/settings";
import { _resetSimLatchForTesting } from "../services/ghostUsers/dailySim";

vi.mock("../services/email", () => ({
  sendRewardAwardedEmail: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Handler-level test helpers
// ============================================================================

/**
 * Extract a route handler from an Express router's internal stack.
 *
 * @param router - The Express router instance.
 * @param path - The route path to match.
 * @param method - HTTP method (default "get").
 * @returns The last handler function on the matched route (after middleware).
 */
function getHandler(router: any, path: string, method: string = "get") {
  for (const layer of router.stack) {
    if (layer.route?.path === path) {
      const mStack = layer.route.stack.filter((s: any) => s.method === method);
      if (mStack.length > 0) {
        // Return the LAST handler (after middleware like requireAdmin)
        return mStack[mStack.length - 1]?.handle;
      }
    }
  }
  return undefined;
}

/**
 * Create a mock Express request object.
 *
 * @param adminId - The admin user ID to attach.
 * @param overrides - Properties to merge into the base request.
 * @returns Mock request.
 */
function mockReq(adminId: string, overrides: any = {}) {
  return {
    params: {},
    body: {},
    query: {},
    cookies: { admin_session: "test-session-token" },
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    adminUser: { id: adminId, username: "admin", isActive: true, canUseExtension: false },
    ...overrides,
  } as any;
}

/**
 * Create a mock Express response object with data capture.
 *
 * @returns Object with `res` (the mock response) and `data` (captured state).
 */
function mockRes() {
  const data: {
    statusCode?: number;
    body?: any;
    headers?: Record<string, string>;
    cookies?: Record<string, any>;
    cleared?: string[];
  } = {};
  const res = {
    json(d: any) {
      data.body = d;
      return res;
    },
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    cookie(name: string, val: any, _opts: any) {
      data.cookies = { ...data.cookies, [name]: val };
      return res;
    },
    clearCookie(name: string) {
      data.cleared = [...(data.cleared || []), name];
      return res;
    },
    setHeader(name: string, val: string) {
      data.headers = { ...data.headers, [name]: val };
      return res;
    },
  } as any;
  return { res, data };
}

// ============================================================================
// Handler-level tests — targeting uncovered lines
// ============================================================================

describe("Handler-level admin route tests", () => {
  let db: DatabaseType;
  let contactsDb: DatabaseType;
  let adminId: string;

  beforeEach(() => {
    db = createTestDb();
    contactsDb = createTestContactsDb();
    seedProducts(db, 20);
    adminId = seedAdminUser(db, "admin", "password123");
    // Create an admin session for the requireAdmin middleware
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 3600000).toISOString();
    db.prepare(
      "INSERT INTO admin_sessions (id, admin_user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)"
    ).run("test-session-token", adminId, now, expires, now);
  });

  // ── Login Routes (lines 164-192) ──────────────────────────────────────────

  describe("POST /login", () => {
    it("successful login returns user and sets cookie", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/login", "post");
      const req = mockReq(adminId, { body: { username: "admin", password: "password123" }, adminUser: undefined });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.user).toBeDefined();
      expect(data.body.user.username).toBe("admin");
      expect(data.cookies).toBeDefined();
      expect(data.cookies!.admin_session).toBeDefined();
    });

    it("missing username/password returns 400", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/login", "post");
      const req = mockReq(adminId, { body: {}, adminUser: undefined });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Username and password are required");
    });

    it("too-long input returns 400", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/login", "post");
      const req = mockReq(adminId, {
        body: { username: "a".repeat(200), password: "b" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Input too long");
    });

    it("invalid credentials returns 401", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/login", "post");
      const req = mockReq(adminId, { body: { username: "admin", password: "wrongpassword" }, adminUser: undefined });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(401);
      expect(data.body.error).toBe("Invalid credentials");
    });

    it("locked account returns 429", () => {
      const lockedUntil = new Date(Date.now() + 3600000).toISOString();
      db.prepare("UPDATE admin_users SET locked_until = ? WHERE id = ?").run(lockedUntil, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/login", "post");
      const req = mockReq(adminId, { body: { username: "admin", password: "password123" }, adminUser: undefined });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(429);
      expect(data.body.error).toBe("Account is temporarily locked");
    });
  });

  // ── Logout (lines 195-206) ────────────────────────────────────────────────

  describe("POST /logout", () => {
    it("destroys session and clears cookie", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/logout", "post");
      const req = mockReq(adminId, {
        cookies: { admin_session: "test-session-token" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ ok: true });
      expect(data.cleared).toContain("admin_session");
      // Verify session was deleted from DB
      const session = db.prepare("SELECT * FROM admin_sessions WHERE id = ?").get("test-session-token");
      expect(session).toBeUndefined();
    });

    it("destroys session via Bearer token header", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/logout", "post");
      const req = mockReq(adminId, {
        cookies: {},
        headers: { authorization: "Bearer test-session-token" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ ok: true });
      const session = db.prepare("SELECT * FROM admin_sessions WHERE id = ?").get("test-session-token");
      expect(session).toBeUndefined();
    });
  });

  // ── Analytics Routes ──────────────────────────────────────────────────────
  // The v1 dashboard endpoints (/analytics/overview, /analytics/games-by-day,
  // /analytics/games-by-mode, /analytics/player-activity,
  // /analytics/popular-categories, /analytics/score-distribution,
  // POST /analytics/backfill) were deleted in PR #209 — Insights
  // (/admin/analytics/v2/*) is the single source of truth for analytics
  // and has its own coverage in analyticsV2.test.ts. Only the live
  // /analytics/active-rooms ops endpoint survives here.

  // ── Product Management (lines 295-420) ────────────────────────────────────

  describe("GET /products", () => {
    it("returns paginated products", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products");
      const req = mockReq(adminId, { query: { page: "1", pageSize: "5" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.products).toBeDefined();
      expect(data.body.products.length).toBeLessThanOrEqual(5);
      expect(data.body.total).toBe(20);
    });

    it("rejects invalid sortBy", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products");
      const req = mockReq(adminId, { query: { sortBy: "hackme" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid sortBy value");
    });

    it("rejects invalid sortOrder", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products");
      const req = mockReq(adminId, { query: { sortOrder: "sideways" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("sortOrder must be 'asc' or 'desc'");
    });
  });

  describe("PATCH /products/bulk-status", () => {
    it("validates ids array is present", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-status", "patch");
      const req = mockReq(adminId, { body: { ids: [], isActive: true } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("ids must be a non-empty array");
    });

    it("rejects more than 500 ids", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-status", "patch");
      const ids = Array.from({ length: 501 }, (_, i) => i + 1);
      const req = mockReq(adminId, { body: { ids, isActive: true } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Cannot update more than 500 products at once");
    });

    it("rejects non-positive-integer ids", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-status", "patch");
      const req = mockReq(adminId, { body: { ids: [-1, 0], isActive: true } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("All ids must be positive integers");
    });

    it("rejects non-boolean isActive", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-status", "patch");
      const req = mockReq(adminId, { body: { ids: [1, 2], isActive: "yes" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("isActive must be a boolean");
    });

    it("bulk updates product status", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-status", "patch");
      const req = mockReq(adminId, { body: { ids: [1, 2, 3], isActive: false } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.updated).toBeDefined();
    });
  });

  describe("GET /products/:id", () => {
    it("returns product by id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id");
      const req = mockReq(adminId, { params: { id: "1" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toBeDefined();
      expect(data.body.id).toBe(1);
    });

    it("returns 404 for non-existent product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id");
      const req = mockReq(adminId, { params: { id: "99999" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("Product not found");
    });

    it("returns 400 for non-numeric id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id");
      const req = mockReq(adminId, { params: { id: "abc" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid product ID");
    });
  });

  describe("POST /products", () => {
    it("creates product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products", "post");
      const req = mockReq(adminId, {
        body: { title: "New Product", priceCents: 1999, category: "Electronics" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(201);
      expect(data.body.title).toBe("New Product");
    });

    it("returns 400 on validation error", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products", "post");
      const req = mockReq(adminId, { body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  describe("PUT /products/:id", () => {
    it("updates product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id", "put");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { title: "Updated Title" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.title).toBe("Updated Title");
    });

    it("returns 404 for non-existent product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id", "put");
      const req = mockReq(adminId, {
        params: { id: "99999" },
        body: { title: "Nope" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("returns 400 for non-numeric id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id", "put");
      const req = mockReq(adminId, {
        params: { id: "abc" },
        body: { title: "Nope" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid product ID");
    });
  });

  describe("PATCH /products/:id/status", () => {
    it("sets product active/inactive", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/status", "patch");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { isActive: false },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isActive).toBe(false);
    });

    it("returns 400 for non-boolean isActive", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/status", "patch");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { isActive: "no" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("isActive must be a boolean");
    });

    it("returns 400 for non-numeric id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/status", "patch");
      const req = mockReq(adminId, {
        params: { id: "abc" },
        body: { isActive: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid product ID");
    });

    it("returns 404 for non-existent product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/status", "patch");
      const req = mockReq(adminId, {
        params: { id: "99999" },
        body: { isActive: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });
  });

  // ── Archive Routes ─────────────────────────────────────────────────────────

  describe("PATCH /products/:id/archive", () => {
    it("archives a product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/archive", "patch");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isArchived).toBe(true);
      expect(data.body.isActive).toBe(false);
    });

    it("unarchives a product", () => {
      const router = createAdminRouter(db, contactsDb);
      db.prepare("UPDATE products SET is_archived = 1, is_active = 0 WHERE id = 1").run();
      const handler = getHandler(router, "/products/:id/archive", "patch");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { isArchived: false },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isArchived).toBe(false);
    });

    it("returns 400 for non-boolean isArchived", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/archive", "patch");
      const req = mockReq(adminId, {
        params: { id: "1" },
        body: { isArchived: "yes" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("isArchived must be a boolean");
    });

    it("returns 400 for non-numeric id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/archive", "patch");
      const req = mockReq(adminId, {
        params: { id: "abc" },
        body: { isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid product ID");
    });

    it("returns 404 for non-existent product", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/:id/archive", "patch");
      const req = mockReq(adminId, {
        params: { id: "99999" },
        body: { isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });
  });

  describe("PATCH /products/bulk-archive", () => {
    it("archives multiple products", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const req = mockReq(adminId, {
        body: { ids: [1, 2, 3], isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.updated).toBe(3);
    });

    it("unarchives multiple products", () => {
      const router = createAdminRouter(db, contactsDb);
      db.prepare("UPDATE products SET is_archived = 1, is_active = 0 WHERE id IN (1, 2)").run();
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const req = mockReq(adminId, {
        body: { ids: [1, 2], isArchived: false },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.updated).toBe(2);
    });

    it("returns 400 for empty ids array", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const req = mockReq(adminId, {
        body: { ids: [], isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("ids must be a non-empty array");
    });

    it("returns 400 for non-boolean isArchived", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const req = mockReq(adminId, {
        body: { ids: [1], isArchived: "true" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("isArchived must be a boolean");
    });

    it("returns 400 for non-integer ids", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const req = mockReq(adminId, {
        body: { ids: [1, "abc"], isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("All ids must be positive integers");
    });

    it("returns 400 for too many ids", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/products/bulk-archive", "patch");
      const ids = Array.from({ length: 501 }, (_, i) => i + 1);
      const req = mockReq(adminId, {
        body: { ids, isArchived: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Cannot update more than 500 products at once");
    });
  });

  // ── Manufacturer Routes (lines 425-508) ───────────────────────────────────

  describe("GET /manufacturers/by-name/:name", () => {
    it("returns manufacturer with contacts", () => {
      const mfgId = seedManufacturer(contactsDb, "Sony", 10);
      seedContact(contactsDb, mfgId, { contactType: "general", email: "test@sony.com" });
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/by-name/:name");
      const req = mockReq(adminId, { params: { name: "Sony" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.manufacturer.name).toBe("Sony");
      expect(data.body.contacts.length).toBe(1);
    });

    it("validates name with invalid characters", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/by-name/:name");
      const req = mockReq(adminId, { params: { name: "<script>alert(1)</script>" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid manufacturer name");
    });

    it("returns 404 when manufacturer not found", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/by-name/:name");
      const req = mockReq(adminId, { params: { name: "NonExistentCorp" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("Manufacturer not found");
    });
  });

  describe("POST /manufacturers/:id/contacts", () => {
    it("creates contact", () => {
      const mfgId = seedManufacturer(contactsDb, "Nike", 5);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts", "post");
      const req = mockReq(adminId, {
        params: { id: String(mfgId) },
        body: { contactType: "general", confidence: "high", email: "contact@nike.com" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(201);
      expect(data.body.email).toBe("contact@nike.com");
    });

    it("returns 400 for invalid manufacturer ID", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts", "post");
      const req = mockReq(adminId, {
        params: { id: "abc" },
        body: { contactType: "general", confidence: "high" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid manufacturer ID");
    });
  });

  describe("PUT /manufacturers/:id/contacts/:contactId", () => {
    it("updates contact", () => {
      const mfgId = seedManufacturer(contactsDb, "Samsung", 3);
      const contactId = seedContact(contactsDb, mfgId, { email: "old@samsung.com" });
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "put");
      const req = mockReq(adminId, {
        params: { id: String(mfgId), contactId: String(contactId) },
        body: { email: "new@samsung.com" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.email).toBe("new@samsung.com");
    });

    it("returns 404 for non-existent contact", () => {
      const mfgId = seedManufacturer(contactsDb, "Bose", 3);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "put");
      const req = mockReq(adminId, {
        params: { id: String(mfgId), contactId: "99999" },
        body: { email: "x@y.com" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("Contact not found");
    });

    it("returns 400 for invalid contact ID", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "put");
      const req = mockReq(adminId, {
        params: { id: "abc", contactId: "def" },
        body: { email: "x@y.com" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid contact ID");
    });
  });

  describe("DELETE /manufacturers/:id/contacts/:contactId", () => {
    it("deletes contact", () => {
      const mfgId = seedManufacturer(contactsDb, "Apple", 2);
      const contactId = seedContact(contactsDb, mfgId, { email: "del@apple.com" });
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "delete");
      const req = mockReq(adminId, {
        params: { id: String(mfgId), contactId: String(contactId) },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ ok: true });
    });

    it("returns 404 for non-existent contact", () => {
      const mfgId = seedManufacturer(contactsDb, "LG", 1);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "delete");
      const req = mockReq(adminId, {
        params: { id: String(mfgId), contactId: "99999" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("Contact not found");
    });

    it("returns 400 for invalid IDs", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/manufacturers/:id/contacts/:contactId", "delete");
      const req = mockReq(adminId, {
        params: { id: "abc", contactId: "def" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid contact ID");
    });
  });

  // ── Rewards Routes (lines 513-653) ────────────────────────────────────────

  describe("GET /rewards", () => {
    it("lists rewards", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards");
      const req = mockReq(adminId, { query: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.rewards).toBeDefined();
      expect(Array.isArray(data.body.rewards)).toBe(true);
    });

    it("rejects invalid status filter", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards");
      const req = mockReq(adminId, { query: { status: "bogus" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid status filter");
    });
  });

  describe("POST /rewards", () => {
    it("creates reward", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards", "post");
      const req = mockReq(adminId, {
        body: { code: "GIFT-1234-ABCD", amountCents: 2000, description: "Test reward" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(201);
      expect(data.body.code).toBe("GIFT-1234-ABCD");
      expect(data.body.amountCents).toBe(2000);
    });

    it("returns 400 on validation error", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards", "post");
      const req = mockReq(adminId, { body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  describe("GET /rewards/qualifying-players", () => {
    it("returns qualifying players", () => {
      const userId = seedUser(db, "player1", "player1@test.com");
      db.prepare("UPDATE users SET lifetime_score = 5000 WHERE id = ?").run(userId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "0", period: "all_time", useLifetimePoints: "true" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.players).toBeDefined();
      expect(data.body.total).toBeGreaterThanOrEqual(0);
    });

    it("rejects invalid minPoints", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "abc", period: "all_time" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("minPoints must be a non-negative integer");
    });

    it("rejects invalid period", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "100", period: "yesterday" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid period");
    });

    it("rejects unknown mode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "0", period: "all_time", mode: "lottery" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid mode");
    });

    it("rejects non-integer minPoints (e.g. 3.5)", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "3.5", period: "all_time" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("minPoints must be a non-negative integer");
    });

    it("rejects streak_only with minStreak < 1", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: { minPoints: "0", period: "all_time", mode: "streak_only", minStreak: "0" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("at least 1");
    });

    it("returns players with streak column when mode is streak_only", () => {
      const userId = seedUser(db, "streakuser", "streakuser@test.com");
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(
        "UPDATE users SET daily_streak_current = 8, daily_streak_best = 8, daily_streak_last_date = ? WHERE id = ?"
      ).run(today, userId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/qualifying-players");
      const req = mockReq(adminId, {
        query: {
          minPoints: "0",
          period: "all_time",
          useLifetimePoints: "true",
          mode: "streak_only",
          minStreak: "5",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      const match = data.body.players.find((p: { id: string }) => p.id === userId);
      expect(match).toBeDefined();
      expect(match.streak).toBe(8);
    });
  });

  describe("GET /rewards/search-users", () => {
    it("searches users by query", () => {
      seedUser(db, "searchable", "searchable@test.com");
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/search-users");
      const req = mockReq(adminId, { query: { q: "search" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(Array.isArray(data.body)).toBe(true);
      expect(data.body.length).toBeGreaterThanOrEqual(1);
      expect(data.body[0].username).toBe("searchable");
    });

    it("returns empty array for empty query", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/search-users");
      const req = mockReq(adminId, { query: { q: "" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual([]);
    });

    it("returns empty array for too-long query", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/search-users");
      const req = mockReq(adminId, { query: { q: "x".repeat(101) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual([]);
    });
  });

  describe("GET /rewards/:id", () => {
    it("returns reward by id", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("test-reward-1", "amazon_gift_card", 5000, "CODE-ABC", "available", now, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id");
      const req = mockReq(adminId, { params: { id: "test-reward-1" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.id).toBe("test-reward-1");
      expect(data.body.amountCents).toBe(5000);
    });

    it("returns 404 when not found", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id");
      const req = mockReq(adminId, { params: { id: "nonexistent" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("Reward not found");
    });
  });

  describe("DELETE /rewards/:id", () => {
    it("deletes available reward", () => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("del-reward-1", "amazon_gift_card", 1000, "DEL-CODE", "available", now, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id", "delete");
      const req = mockReq(adminId, { params: { id: "del-reward-1" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ ok: true });
    });

    it("returns 404 for non-existent reward", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id", "delete");
      const req = mockReq(adminId, { params: { id: "nope" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });
  });

  describe("POST /rewards/:id/award", () => {
    it("awards reward to a user", () => {
      const userId = seedUser(db, "winner", "winner@test.com");
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("award-reward-1", "amazon_gift_card", 2000, "AWARD-CODE", "available", now, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id/award", "post");
      const req = mockReq(adminId, {
        params: { id: "award-reward-1" },
        body: { userId },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.id).toBe("award-reward-1");
      expect(data.body.status).toBe("awarded");
    });

    it("rejects missing userId", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id/award", "post");
      const req = mockReq(adminId, {
        params: { id: "some-id" },
        body: {},
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("userId is required");
    });

    it("returns 404 for non-existent reward", () => {
      const userId = seedUser(db, "player2", "player2@test.com");
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/:id/award", "post");
      const req = mockReq(adminId, {
        params: { id: "nonexistent" },
        body: { userId },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });
  });

  describe("POST /rewards/random-roll", () => {
    it("validates rewardId is required", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, { body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("rewardId is required");
    });

    it("validates criteria is required", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, { body: { rewardId: "some-id" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("criteria is required");
    });

    it("validates criteria.minPoints", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "some-id",
          criteria: { minPoints: -5, period: "all_time" },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("minPoints must be a non-negative integer");
    });

    it("validates criteria.period", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "some-id",
          criteria: { minPoints: 0, period: "invalid_period" },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid period");
    });

    it("executes random roll successfully", () => {
      const userId = seedUser(db, "rollwinner", "rollwinner@test.com");
      db.prepare("UPDATE users SET lifetime_score = 10000 WHERE id = ?").run(userId);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("roll-reward-1", "amazon_gift_card", 5000, "ROLL-CODE", "available", now, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "roll-reward-1",
          criteria: { minPoints: 0, period: "all_time", useLifetimePoints: true },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.candidateAward).toBeDefined();
      expect(data.body.reward).toBeDefined();
      expect(data.body.totalQualifying).toBeGreaterThanOrEqual(1);
      // Pending-review state — no emails sent yet
      expect(data.body.reward.award.pendingReviewAt).not.toBeNull();
    });

    it("rejects invalid criteria.mode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "some-id",
          criteria: { minPoints: 0, period: "all_time", mode: "everything" },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid mode");
    });

    it("rejects streak mode with minStreak < 1", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "some-id",
          criteria: { minPoints: 0, period: "all_time", mode: "streak_only", minStreak: 0 },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("at least 1");
    });

    it("rejects negative minStreak", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "some-id",
          criteria: { minPoints: 0, period: "all_time", minStreak: -3 },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("minStreak must be a non-negative integer");
    });

    it("executes streak_only roll when user meets streak threshold", () => {
      const userId = seedUser(db, "streakwinner", "streakwin@test.com");
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(
        "UPDATE users SET daily_streak_current = 7, daily_streak_best = 7, daily_streak_last_date = ? WHERE id = ?"
      ).run(today, userId);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("streak-roll-1", "amazon_gift_card", 2500, "STREAK-CODE", "available", now, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/rewards/random-roll", "post");
      const req = mockReq(adminId, {
        body: {
          rewardId: "streak-roll-1",
          criteria: {
            mode: "streak_only",
            minPoints: 0,
            period: "all_time",
            useLifetimePoints: true,
            minStreak: 5,
          },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.candidateAward?.userId).toBe(userId);
      expect(data.body.totalQualifying).toBe(1);
    });
  });

  // ── Banner Routes (lines 658-700) ─────────────────────────────────────────

  describe("GET /banner", () => {
    it("returns banner settings", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toBeDefined();
      expect(data.body.enabled).toBeDefined();
      expect(data.body.text).toBeDefined();
    });
  });

  describe("PUT /banner", () => {
    it("updates banner settings", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, {
        body: { enabled: true, text: "Hello!", linkText: "Click", linkUrl: "/promo", audienceMode: "all", showLink: true },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.text).toBe("Hello!");
      expect(data.body.enabled).toBe(true);
    });

    it("rejects text exceeding 500 characters", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { text: "x".repeat(501) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("Banner text");
    });

    it("rejects linkText exceeding 100 characters", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { linkText: "z".repeat(101) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("Link text");
    });

    it("rejects linkUrl not starting with /", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { linkUrl: "https://evil.com" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("relative path");
    });

    it("rejects linkUrl starting with //", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { linkUrl: "//evil.com" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("relative path");
    });

    it("rejects linkUrl exceeding 500 characters", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { linkUrl: "/" + "x".repeat(500) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("Link URL");
    });

    it("rejects non-boolean enabled", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { enabled: "yes" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("enabled must be a boolean");
    });

    it("rejects invalid audienceMode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { audienceMode: "nobody" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("audienceMode");
    });

    it("rejects non-boolean showLink", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { showLink: "maybe" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("showLink must be a boolean");
    });

    it("rejects non-boolean showGiveawayModal", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { showGiveawayModal: "yes" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("showGiveawayModal must be a boolean");
    });

    it("rejects non-integer giveawayMinPoints", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayMinPoints: 3.14 } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("giveawayMinPoints");
    });

    it("rejects negative giveawayMinPoints", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayMinPoints: -100 } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("giveawayMinPoints");
    });

    it("accepts valid giveawayMinPoints", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayMinPoints: 5000 } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined(); // no res.status() = 200
      expect(data.body.giveawayMinPoints).toBe(5000);
    });

    it("rejects qualifiedMessage exceeding 500 characters", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { qualifiedMessage: "x".repeat(501) } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("qualifiedMessage");
    });

    it("accepts valid qualifiedMessage", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { qualifiedMessage: "You're in the {month} drawing!" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined();
      expect(data.body.qualifiedMessage).toBe("You're in the {month} drawing!");
    });

    it("rejects non-integer giveawayMinStreak", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayMinStreak: 2.5 } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("giveawayMinStreak");
    });

    it("rejects negative giveawayMinStreak", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayMinStreak: -1 } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("giveawayMinStreak");
    });

    it("rejects unknown giveawayQualifyMode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, { body: { giveawayQualifyMode: "lottery" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toContain("giveawayQualifyMode");
    });

    it("accepts valid giveawayMinStreak and giveawayQualifyMode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/banner", "put");
      const req = mockReq(adminId, {
        body: { giveawayMinStreak: 7, giveawayQualifyMode: "points_and_streak" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined();
      expect(data.body.giveawayMinStreak).toBe(7);
      expect(data.body.giveawayQualifyMode).toBe("points_and_streak");
    });
  });

  // ── Game Mode Settings Routes ────────────────────────────────────────────

  describe("GET /game-modes", () => {
    it("returns all modes and empty disabled list by default", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toBeDefined();
      expect(data.body.modes).toBeDefined();
      expect(Array.isArray(data.body.modes)).toBe(true);
      expect(data.body.modes.length).toBeGreaterThan(0);
      expect(data.body.disabledModes).toEqual([]);
    });

    it("returns previously disabled modes", () => {
      db.prepare(
        "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
      ).run("disabled_game_modes", JSON.stringify(["classic", "riser"]), new Date().toISOString());

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.disabledModes).toEqual(["classic", "riser"]);
    });
  });

  describe("PUT /game-modes", () => {
    it("updates disabled modes", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes", "put");
      const req = mockReq(adminId, { body: { disabledModes: ["classic", "riser"] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.disabledModes).toEqual(["classic", "riser"]);
    });

    it("rejects non-array disabledModes", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes", "put");
      const req = mockReq(adminId, { body: { disabledModes: "classic" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("disabledModes must be an array");
    });

    it("rejects non-string entries", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes", "put");
      const req = mockReq(adminId, { body: { disabledModes: [123] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("All entries in disabledModes must be strings");
    });

    it("rejects invalid game mode names", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes", "put");
      const req = mockReq(adminId, { body: { disabledModes: ["classic", "fake-mode"] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid game mode: fake-mode");
    });

    it("clears disabled modes with empty array", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/game-modes", "put");
      const req1 = mockReq(adminId, { body: { disabledModes: ["classic"] } });
      const { res: res1 } = mockRes();
      handler(req1, res1);

      const req2 = mockReq(adminId, { body: { disabledModes: [] } });
      const { res: res2, data: data2 } = mockRes();
      handler(req2, res2);
      expect(data2.body.disabledModes).toEqual([]);
    });
  });

  // ── Avatar Settings Routes ────────────────────────────────────────────────

  describe("GET /avatars", () => {
    it("returns all avatars and empty disabled list by default", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toBeDefined();
      expect(data.body.avatars).toBeDefined();
      expect(Array.isArray(data.body.avatars)).toBe(true);
      expect(data.body.avatars.length).toBeGreaterThan(0);
      expect(data.body.disabledAvatars).toEqual([]);
      expect(data.body.labels).toBeDefined();
      expect(typeof data.body.labels).toBe("object");
      expect(data.body.userCounts).toBeDefined();
    });

    it("returns previously disabled avatars", () => {
      db.prepare(
        "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
      ).run("disabled_avatars", JSON.stringify(["wizard", "pirate"]), new Date().toISOString());

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.disabledAvatars).toEqual(["wizard", "pirate"]);
    });

    it("returns user counts per avatar", () => {
      // Create a user with a wizard avatar
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO users (id, username, username_normalized, email, password_hash, avatar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
      ).run("u1", "player1", "player1", "p1@test.com", "hash", "wizard", now, now);

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.userCounts.wizard).toBe(1);
    });
  });

  describe("PUT /avatars", () => {
    it("updates disabled avatars", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars", "put");
      const req = mockReq(adminId, { body: { disabledAvatars: ["wizard", "pirate"] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.disabledAvatars).toEqual(["wizard", "pirate"]);
    });

    it("rejects non-array disabledAvatars", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars", "put");
      const req = mockReq(adminId, { body: { disabledAvatars: "wizard" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("disabledAvatars must be an array");
    });

    it("rejects non-string entries", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars", "put");
      const req = mockReq(adminId, { body: { disabledAvatars: [123] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("All entries in disabledAvatars must be strings");
    });

    it("rejects invalid avatar names", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars", "put");
      const req = mockReq(adminId, { body: { disabledAvatars: ["wizard", "fake-avatar"] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid avatar: fake-avatar");
    });

    it("clears disabled avatars with empty array", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/avatars", "put");
      const req1 = mockReq(adminId, { body: { disabledAvatars: ["wizard"] } });
      const { res: res1 } = mockRes();
      handler(req1, res1);

      const req2 = mockReq(adminId, { body: { disabledAvatars: [] } });
      const { res: res2, data: data2 } = mockRes();
      handler(req2, res2);
      expect(data2.body.disabledAvatars).toEqual([]);
    });
  });

  // ── Extension Routes (lines 705-753) ──────────────────────────────────────

  describe("POST /extension/login", () => {
    it("returns token in body for extension-permitted user", () => {
      seedAdminUser(db, "extadmin", "password123", true);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, {
        body: { username: "extadmin", password: "password123" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.token).toBeDefined();
      expect(data.body.user).toBeDefined();
      expect(data.body.user.canUseExtension).toBe(true);
    });

    it("rejects user without extension permission", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, {
        body: { username: "admin", password: "password123" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(403);
      expect(data.body.error).toBe("Extension access not permitted");
    });

    it("rejects missing credentials", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, { body: {}, adminUser: undefined });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Username and password are required");
    });

    it("rejects too-long input", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, {
        body: { username: "x".repeat(200), password: "y" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Input too long");
    });

    it("rejects invalid credentials", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, {
        body: { username: "admin", password: "wrongpassword" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(401);
      expect(data.body.error).toBe("Invalid credentials");
    });

    it("returns 429 for locked account", () => {
      const lockedUntil = new Date(Date.now() + 3600000).toISOString();
      db.prepare("UPDATE admin_users SET locked_until = ? WHERE id = ?").run(lockedUntil, adminId);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/login", "post");
      const req = mockReq(adminId, {
        body: { username: "admin", password: "password123" },
        adminUser: undefined,
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(429);
      expect(data.body.error).toBe("Account is temporarily locked");
    });
  });

  describe("POST /extension/import", () => {
    it("imports product via ASIN", () => {
      const extAdminId = seedAdminUser(db, "importadmin", "password123", true);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/import", "post");
      const req = mockReq(adminId, {
        adminUser: { id: extAdminId, username: "importadmin", isActive: true, canUseExtension: true },
        body: {
          asin: "B0ABCDEFGH",
          title: "Extension Product",
          priceCents: 2999,
          imageUrl: "https://example.com/img.jpg",
          category: "Electronics",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(201);
      expect(data.body.product.title).toBe("Extension Product");
      expect(data.body.created).toBe(true);
    });

    it("returns 400 on invalid import data", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/import", "post");
      const req = mockReq(adminId, {
        adminUser: { id: adminId, username: "admin", isActive: true, canUseExtension: true },
        body: { asin: "" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("updates existing product by ASIN", () => {
      const extAdminId = seedAdminUser(db, "importadmin2", "password123", true);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/extension/import", "post");
      // First import
      const req1 = mockReq(adminId, {
        adminUser: { id: extAdminId, username: "importadmin2", isActive: true, canUseExtension: true },
        body: {
          asin: "B0NWPROD01",
          title: "Original Title",
          priceCents: 1999,
        },
      });
      const { res: res1, data: data1 } = mockRes();
      handler(req1, res1);
      expect(data1.statusCode).toBe(201);

      // Second import — same ASIN, should update
      const req2 = mockReq(adminId, {
        adminUser: { id: extAdminId, username: "importadmin2", isActive: true, canUseExtension: true },
        body: {
          asin: "B0NWPROD01",
          title: "Updated Title",
          priceCents: 2999,
        },
      });
      const { res: res2, data: data2 } = mockRes();
      handler(req2, res2);
      expect(data2.statusCode).toBe(200);
      expect(data2.body.created).toBe(false);
      expect(data2.body.product.title).toBe("Updated Title");
    });
  });

  // ── UTM Tag Routes ─────────────────────────────────────────────────────────

  describe("UTM tag routes", () => {
    /**
     * Create a tag via the POST handler and return the created tag.
     * Fails the test if creation did not succeed.
     */
    function createTagViaRouter(
      router: ReturnType<typeof createAdminRouter>,
      overrides: Record<string, unknown> = {},
    ) {
      const postHandler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: {
          name: `tag-${Math.random().toString(36).slice(2, 10)}`,
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "gw",
          destinationUrl: "/giveaway",
          ...overrides,
        },
      });
      const { res, data } = mockRes();
      postHandler(req, res);
      expect(data.statusCode).toBe(201);
      return data.body;
    }

    it("POST /utm-tags creates a tag and returns 201", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: {
          name: "reddit-launch",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "launch",
          destinationUrl: "/giveaway",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(201);
      expect(data.body).toMatchObject({
        name: "reddit-launch",
        utmSource: "reddit",
        status: "active",
        createdBy: adminId,
      });
      expect(data.body.id).toBeTruthy();
    });

    it("POST /utm-tags returns 400 on validation failure", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: { name: "", utmSource: "reddit", destinationUrl: "/giveaway" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("UTM tag name is required");
    });

    it("POST /utm-tags forwards duplicate-name errors through the safe-error filter", () => {
      const router = createAdminRouter(db, contactsDb);
      createTagViaRouter(router, { name: "dupe" });
      const handler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: {
          name: "dupe",
          utmSource: "reddit",
          destinationUrl: "/giveaway",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("A UTM tag with this name already exists");
    });

    it("GET /utm-tags lists active tags by default", () => {
      const router = createAdminRouter(db, contactsDb);
      createTagViaRouter(router, { name: "active-1" });
      createTagViaRouter(router, { name: "active-2" });
      const handler = getHandler(router, "/utm-tags", "get")!;
      const req = mockReq(adminId, { query: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.total).toBe(2);
      expect(data.body.tags).toHaveLength(2);
    });

    it("GET /utm-tags returns 400 on an invalid status filter", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags", "get")!;
      const req = mockReq(adminId, { query: { status: "bogus" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid status filter");
    });

    it("GET /utm-tags/:id returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id", "get")!;
      const req = mockReq(adminId, { params: { id: "missing" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
      expect(data.body.error).toBe("UTM tag not found");
    });

    it("GET /utm-tags/:id returns the tag", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id", "get")!;
      const req = mockReq(adminId, { params: { id: created.id } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.id).toBe(created.id);
    });

    it("PUT /utm-tags/:id updates a tag", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, { name: "renameable" });
      const handler = getHandler(router, "/utm-tags/:id", "put")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { name: "renamed", utmCampaign: "v2" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.name).toBe("renamed");
      expect(data.body.utmCampaign).toBe("v2");
    });

    it("PUT /utm-tags/:id returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id", "put")!;
      const req = mockReq(adminId, {
        params: { id: "missing" },
        body: { name: "x" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("PUT /utm-tags/:id returns 400 on validation error", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id", "put")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { utmSource: "x".repeat(129) },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("utm_source exceeds maximum length of 128 characters");
    });

    it("PATCH /utm-tags/:id/status archives a tag", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id/status", "patch")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { status: "archived" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.status).toBe("archived");
    });

    it("PATCH /utm-tags/:id/status returns 400 on bogus status", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id/status", "patch")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { status: "bogus" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("Invalid status");
    });

    it("PATCH /utm-tags/:id/status returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id/status", "patch")!;
      const req = mockReq(adminId, {
        params: { id: "missing" },
        body: { status: "archived" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("DELETE /utm-tags/:id removes a tag with no matched signups", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, { name: "expendable" });
      const handler = getHandler(router, "/utm-tags/:id", "delete")!;
      const req = mockReq(adminId, { params: { id: created.id } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ ok: true });
    });

    it("DELETE /utm-tags/:id returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id", "delete")!;
      const req = mockReq(adminId, { params: { id: "missing" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("DELETE /utm-tags/:id returns 409 when the tag has matched signups", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "matched",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "match",
      });
      // Seed a matching user.
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users
          (id, username, username_normalized, email, password_hash,
           created_at, updated_at, is_active,
           utm_source, utm_medium, utm_campaign)
         VALUES (?, ?, ?, ?, 'x', ?, ?, 1, ?, ?, ?)`,
      ).run(
        "u-matched",
        "umatched",
        "umatched",
        "umatched@test.local",
        now,
        now,
        "reddit",
        "cpc",
        "match",
      );
      const handler = getHandler(router, "/utm-tags/:id", "delete")!;
      const req = mockReq(adminId, { params: { id: created.id } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(409);
      expect(data.body.error).toBe("Cannot delete UTM tag with matched signups");
    });

    it("GET /utm-tags/:id/stats returns the funnel for a tag", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "funnel",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "funnel",
      });
      const handler = getHandler(router, "/utm-tags/:id/stats", "get")!;
      const req = mockReq(adminId, { params: { id: created.id } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toMatchObject({
        tagId: created.id,
        signups: 0,
        playedFirstGame: 0,
        giveawayEligible: 0,
        wonReward: 0,
      });
      expect(data.body.giveawayThreshold).toBeGreaterThan(0);
    });

    it("GET /utm-tags/:id/stats returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id/stats", "get")!;
      const req = mockReq(adminId, { params: { id: "missing" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    // ── Short-code support (migration v30) ────────────────────────────────

    it("POST /utm-tags persists a valid short code", () => {
      const router = createAdminRouter(db, contactsDb);
      const tag = createTagViaRouter(router, {
        name: "has-sc",
        shortCode: "reddit-gw-1",
      });
      expect(tag.shortCode).toBe("reddit-gw-1");
      expect(tag.clickCount).toBe(0);
      expect(tag.lastClickedAt).toBeNull();
    });

    it("POST /utm-tags returns 400 on an invalid short code", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: {
          name: "bad-sc",
          utmSource: "reddit",
          destinationUrl: "/giveaway",
          shortCode: "BAD CODE",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/Short code must be 3-32/);
    });

    it("POST /utm-tags returns 400 on a duplicate short code with a stable message", () => {
      const router = createAdminRouter(db, contactsDb);
      createTagViaRouter(router, { name: "first-sc", shortCode: "dup-sc" });
      const handler = getHandler(router, "/utm-tags", "post")!;
      const req = mockReq(adminId, {
        body: {
          name: "second-sc",
          utmSource: "reddit",
          destinationUrl: "/giveaway",
          shortCode: "dup-sc",
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toBe("A UTM tag with this short code already exists");
    });

    it("PUT /utm-tags/:id updates the short code", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "update-sc",
        shortCode: "before-sc",
      });
      const handler = getHandler(router, "/utm-tags/:id", "put")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { shortCode: "after-sc" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.shortCode).toBe("after-sc");
    });

    it("PUT /utm-tags/:id clears the short code when passed null", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "clear-sc",
        shortCode: "clear-me",
      });
      const handler = getHandler(router, "/utm-tags/:id", "put")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        body: { shortCode: null },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.shortCode).toBeNull();
    });

    it("GET /utm-tags/short-code/suggest returns a freshly-generated code", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/short-code/suggest", "get");
      expect(handler).toBeDefined();
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler!(req, res);
      expect(data.body).toHaveProperty("code");
      expect(typeof data.body.code).toBe("string");
      expect(data.body.code).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it("GET /utm-tags/:id/stats includes clicks and hasShortCode", () => {
      const router = createAdminRouter(db, contactsDb);
      // With a short code.
      const withCode = createTagViaRouter(router, {
        name: "with-code",
        shortCode: "has-clicks",
      });
      db.prepare("UPDATE utm_tags SET click_count = 5 WHERE id = ?").run(withCode.id);
      const handler = getHandler(router, "/utm-tags/:id/stats", "get")!;
      const req1 = mockReq(adminId, { params: { id: withCode.id } });
      const r1 = mockRes();
      handler(req1, r1.res);
      expect(r1.data.body.clicks).toBe(5);
      expect(r1.data.body.hasShortCode).toBe(true);

      // Without a short code.
      const withoutCode = createTagViaRouter(router, { name: "no-code" });
      const req2 = mockReq(adminId, { params: { id: withoutCode.id } });
      const r2 = mockRes();
      handler(req2, r2.res);
      expect(r2.data.body.clicks).toBe(0);
      expect(r2.data.body.hasShortCode).toBe(false);
    });

    // ── Dashboard upgrade routes ──────────────────────────────────────────

    it("GET /utm-tags/:id/stats?range=7 returns 400 on invalid range", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id/stats", "get")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        query: { range: "bogus" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/range must be 7, 28, or 90/);
    });

    it("GET /utm-tags/:id/stats?range=7 returns the windowed funnel", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "stats-windowed",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "win",
      });
      const handler = getHandler(router, "/utm-tags/:id/stats", "get")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        query: { range: "7d" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.tagId).toBe(created.id);
      expect(data.body.signups).toBe(0);
    });

    it("GET /utm-tags/:id/timeseries?range=7 returns daily points", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router, {
        name: "ts",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "ts",
      });
      const handler = getHandler(router, "/utm-tags/:id/timeseries", "get")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        query: { range: "7d" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(Array.isArray(data.body)).toBe(true);
      expect(data.body.length).toBeGreaterThanOrEqual(7);
      expect(data.body[0]).toHaveProperty("date");
      expect(data.body[0]).toHaveProperty("sessions");
      expect(data.body[0]).toHaveProperty("signups");
      expect(data.body[0]).toHaveProperty("anonymousPlays");
    });

    it("GET /utm-tags/:id/timeseries returns 400 on missing/invalid range", () => {
      const router = createAdminRouter(db, contactsDb);
      const created = createTagViaRouter(router);
      const handler = getHandler(router, "/utm-tags/:id/timeseries", "get")!;
      const req = mockReq(adminId, {
        params: { id: created.id },
        query: { range: "1d" }, // valid for v2 analytics, but UTM dashboard only supports 7/28/90
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("GET /utm-tags/:id/timeseries returns 404 for missing id", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/:id/timeseries", "get")!;
      const req = mockReq(adminId, {
        params: { id: "missing" },
        query: { range: "7d" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(404);
    });

    it("GET /utm-tags/comparison returns the leaderboard with summary", () => {
      const router = createAdminRouter(db, contactsDb);
      createTagViaRouter(router, { name: "cmp-1" });
      createTagViaRouter(router, { name: "cmp-2" });
      const handler = getHandler(router, "/utm-tags/comparison", "get")!;
      const req = mockReq(adminId, { query: { range: "7d" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toHaveProperty("rows");
      expect(data.body).toHaveProperty("summary");
      expect(data.body.rows.map((r: { name: string }) => r.name).sort()).toEqual([
        "cmp-1",
        "cmp-2",
      ]);
      expect(data.body.summary.activeTagCount).toBe(2);
      expect(data.body.summary.rangeDays).toBe(7);
    });

    it("GET /utm-tags/comparison defaults origin to admin (excludes system tags)", () => {
      const router = createAdminRouter(db, contactsDb);
      createTagViaRouter(router, { name: "admin-tag" });
      // System tag with origin_key set.
      db.prepare(
        `INSERT INTO utm_tags
           (id, name, utm_source, destination_url, status, origin_key,
            created_at, updated_at, click_count)
         VALUES (?, ?, 'sys', '/', 'active', ?, ?, ?, 0)`,
      ).run(
        "sys-id",
        "sys-tag",
        "outbound:email",
        new Date().toISOString(),
        new Date().toISOString(),
      );
      const handler = getHandler(router, "/utm-tags/comparison", "get")!;
      const req = mockReq(adminId, { query: { range: "7d" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.rows.map((r: { name: string }) => r.name)).toEqual(["admin-tag"]);
    });

    it("GET /utm-tags/comparison returns 400 on invalid range", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/comparison", "get")!;
      const req = mockReq(adminId, { query: { range: "bogus" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("GET /utm-tags/comparison returns 400 on invalid origin", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/utm-tags/comparison", "get")!;
      const req = mockReq(adminId, {
        query: { range: "7d", origin: "bogus" },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });
});

// ============================================================================
// HTTP integration tests (original)
// ============================================================================

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

// ===== Auth routes =====

describe("Auth routes", () => {
  beforeEach(async () => {
    testDb = createTestDb();
    seedAdminUser(testDb, "admin", "testpassword123");
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

  it("POST /login returns 400 for missing fields", async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /login returns 401 for wrong password", async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrongpassword" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /login returns 200 and sets cookie on success", async () => {
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("admin");

    const cookie = extractCookie(res);
    expect(cookie).toContain("admin_session=");
  });

  it("GET /me returns 401 without cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/me`);
    expect(res.status).toBe(401);
  });

  it("GET /me returns user with valid cookie", async () => {
    // Login first
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractCookie(loginRes);
    expect(cookie).not.toBe("");

    // Use cookie to access /me
    const meRes = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const body = await meRes.json();
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("admin");
  });

  it("POST /logout clears session", async () => {
    // Login
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    const cookie = extractCookie(loginRes);

    // Logout
    const logoutRes = await fetch(`${baseUrl}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);
    const logoutBody = await logoutRes.json();
    expect(logoutBody.ok).toBe(true);

    // Verify /me returns 401 after logout
    const meRes = await fetch(`${baseUrl}/api/admin/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(401);
  });

  it("POST /login returns 429 for locked account after max failed attempts", async () => {
    // Make enough failed login attempts to trigger lockout
    for (let i = 0; i < config.adminMaxFailedLogins; i++) {
      await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      });
    }

    // Even with correct password, account should be locked
    const res = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("locked");
  });
});

// ===== Analytics routes =====

describe("Analytics routes", () => {
  let authCookie: string;

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

    // Login to get auth cookie
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    authCookie = extractCookie(loginRes);
  });

  afterEach(() => {
    if (server) server.close();
  });

  // The v1 analytics-route http tests (overview / games-by-day /
  // games-by-mode / player-activity / popular-categories /
  // score-distribution / POST backfill) were deleted alongside the routes
  // themselves in PR #209. Insights v2 has its own coverage in
  // analyticsV2.test.ts. Only the live ops endpoint remains.

  it("GET /analytics/active-rooms returns array", async () => {
    const res = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("/analytics/active-rooms returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/admin/analytics/active-rooms`);
    expect(res.status).toBe(401);
  });
});

// ===== Product routes =====

describe("Product routes", () => {
  let authCookie: string;

  beforeEach(async () => {
    testDb = createTestDb();
    seedAdminUser(testDb, "admin", "testpassword123");
    seedDiverseProducts(testDb, 20);
    const app = buildApp(testDb);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    authCookie = extractCookie(loginRes);
  });

  afterEach(() => {
    if (server) server.close();
  });

  it("GET /products returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products`);
    expect(res.status).toBe(401);
  });

  it("GET /products returns paginated list", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products?page=1&pageSize=10`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toHaveLength(10);
    expect(body.total).toBe(20);
    expect(body.totalPages).toBe(2);
  });

  it("GET /products supports search", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products?search=Sony`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products.length).toBeGreaterThan(0);
  });

  it("GET /products supports category filter", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products?category=Electronics`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const p of body.products) {
      expect(p.category).toBe("Electronics");
    }
  });

  it("GET /products/categories returns categories", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/categories`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("GET /products/:id returns a product", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/1`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.title).toBeDefined();
  });

  it("GET /products/:id returns 404 for non-existent", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/99999`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(404);
  });

  it("POST /products creates a product", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ title: "New Product", priceCents: 4999, category: "Test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("New Product");
    expect(body.priceCents).toBe(4999);
  });

  it("POST /products returns 400 for invalid data", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ title: "", priceCents: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /products/:id updates a product", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ title: "Updated Title" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Updated Title");
  });

  it("PUT /products/:id returns 404 for non-existent", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/99999`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /products/:id/status toggles active", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/1/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isActive).toBe(false);
  });

  it("PATCH /products/:id/status returns 400 for non-boolean", async () => {
    const res = await fetch(`${baseUrl}/api/admin/products/1/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ isActive: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

// ===== Manufacturer contact routes =====

describe("Manufacturer contact routes", () => {
  let authCookie: string;
  let contactsDb: import("better-sqlite3").Database;

  function buildAppWithContacts(db: DatabaseType, cDb: DatabaseType) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/admin", createAdminRouter(db, cDb));
    return app;
  }

  beforeEach(async () => {
    testDb = createTestDb();
    contactsDb = (await import("../test/dbHelper")).createTestContactsDb();
    seedAdminUser(testDb, "admin", "testpassword123");

    const app = buildAppWithContacts(testDb, contactsDb);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    authCookie = extractCookie(loginRes);
  });

  afterEach(() => {
    if (server) server.close();
  });

  it("GET /manufacturers/by-name/:name returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/by-name/Sony`);
    expect(res.status).toBe(401);
  });

  it("GET /manufacturers/by-name/:name returns manufacturer with contacts", async () => {
    const mfgId = seedManufacturer(contactsDb, "Sony", 10);
    seedContact(contactsDb, mfgId, { contactType: "media", email: "press@sony.com", confidence: "high" });

    const res = await fetch(`${baseUrl}/api/admin/manufacturers/by-name/Sony`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manufacturer.name).toBe("Sony");
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].email).toBe("press@sony.com");
  });

  it("GET /manufacturers/by-name/:name returns 404 for unknown", async () => {
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/by-name/UnknownCo`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(404);
  });

  it("POST /manufacturers/:id/contacts creates a contact", async () => {
    const mfgId = seedManufacturer(contactsDb, "Nike", 5);
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/${mfgId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ contactType: "pr", confidence: "high", email: "pr@nike.com" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contactType).toBe("pr");
    expect(body.email).toBe("pr@nike.com");
  });

  it("POST /manufacturers/:id/contacts returns 400 for invalid type", async () => {
    const mfgId = seedManufacturer(contactsDb, "Test", 1);
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/${mfgId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ contactType: "bogus", confidence: "high" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT /manufacturers/:id/contacts/:contactId updates a contact", async () => {
    const mfgId = seedManufacturer(contactsDb, "Bose", 3);
    const contactId = seedContact(contactsDb, mfgId, { contactType: "general", email: "old@bose.com", confidence: "low" });

    const res = await fetch(`${baseUrl}/api/admin/manufacturers/${mfgId}/contacts/${contactId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ email: "new@bose.com", confidence: "high" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("new@bose.com");
    expect(body.confidence).toBe("high");
  });

  it("PUT /manufacturers/:id/contacts/:contactId returns 404 for non-existent", async () => {
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/1/contacts/99999`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ email: "x@y.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /manufacturers/:id/contacts/:contactId deletes a contact", async () => {
    const mfgId = seedManufacturer(contactsDb, "LG", 2);
    const contactId = seedContact(contactsDb, mfgId, { contactType: "support", confidence: "medium" });

    const res = await fetch(`${baseUrl}/api/admin/manufacturers/${mfgId}/contacts/${contactId}`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("DELETE /manufacturers/:id/contacts/:contactId returns 404 for non-existent", async () => {
    const res = await fetch(`${baseUrl}/api/admin/manufacturers/1/contacts/99999`, {
      method: "DELETE",
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(404);
  });
});

// ===== UTM tag routes — HTTP integration (auth gating) =====

describe("UTM tag routes HTTP integration", () => {
  beforeEach(async () => {
    testDb = createTestDb();
    seedAdminUser(testDb, "admin", "testpassword123");
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

  it("GET /utm-tags returns 401 without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/utm-tags`);
    expect(res.status).toBe(401);
  });

  it("POST /utm-tags returns 401 without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/utm-tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /utm-tags/:id/stats returns 401 without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/utm-tags/any-id/stats`);
    expect(res.status).toBe(401);
  });

  it("GET /utm-tags/short-code/suggest returns 401 without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/admin/utm-tags/short-code/suggest`);
    expect(res.status).toBe(401);
  });

  it("full CRUD flow over HTTP with a valid session", async () => {
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpassword123" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractCookie(loginRes);

    // Create
    const createRes = await fetch(`${baseUrl}/api/admin/utm-tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "integration",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "int",
        destinationUrl: "/giveaway",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeTruthy();

    // List
    const listRes = await fetch(`${baseUrl}/api/admin/utm-tags`, {
      headers: { Cookie: cookie },
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.total).toBe(1);

    // Stats
    const statsRes = await fetch(`${baseUrl}/api/admin/utm-tags/${created.id}/stats`, {
      headers: { Cookie: cookie },
    });
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(stats.signups).toBe(0);

    // Archive
    const archiveRes = await fetch(`${baseUrl}/api/admin/utm-tags/${created.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(archiveRes.status).toBe(200);
    const archived = await archiveRes.json();
    expect(archived.status).toBe("archived");

    // Delete (no matched signups → succeeds)
    const delRes = await fetch(`${baseUrl}/api/admin/utm-tags/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(delRes.status).toBe(200);
  });
});

// ============================================================================
// Daily challenge admin routes (handler-level)
// ============================================================================

describe("Admin daily challenge routes", () => {
  let db: DatabaseType;
  let contactsDb: DatabaseType;
  let adminId: string;

  beforeEach(() => {
    db = createTestDb();
    contactsDb = createTestContactsDb();
    seedDiverseProducts(db, 60);
    adminId = seedAdminUser(db, "admin", "password123");
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 3600000).toISOString();
    db.prepare(
      "INSERT INTO admin_sessions (id, admin_user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)"
    ).run("test-session-token", adminId, now, expires, now);
  });

  describe("GET /daily/overview", () => {
    it("returns enabled=false and 14 rows by default", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.enabled).toBe(false);
      expect(data.body.rows).toHaveLength(14);
      expect(data.body.schedule).toHaveLength(7);
    });

    it("respects ?days=7", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: { days: "7" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.rows).toHaveLength(7);
    });

    it("clamps invalid days to default", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: { days: "garbage" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.rows).toHaveLength(14);
    });

    it("respects ?startDate for past dates", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: { days: "7", startDate: "2020-01-06" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.rows).toHaveLength(7);
      expect(data.body.rows[0].date).toBe("2020-01-06");
    });

    it("returns 400 for invalid startDate format", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: { startDate: "not-a-date" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
      expect(data.body.error).toMatch(/invalid/i);
    });

    it("rows include productImageUrls and productPriceCents arrays", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/overview", "get");
      const req = mockReq(adminId, { query: { days: "1" } });
      const { res, data } = mockRes();
      handler(req, res);
      const row = data.body.rows[0];
      expect(Array.isArray(row.productImageUrls)).toBe(true);
      expect(Array.isArray(row.productPriceCents)).toBe(true);
    });
  });

  describe("PUT /daily/enabled", () => {
    it("flips the flag with body { enabled: true }", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/enabled", "put");
      const req = mockReq(adminId, { body: { enabled: true } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ enabled: true });
    });

    it("400 when enabled is not a boolean", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/enabled", "put");
      const req = mockReq(adminId, { body: { enabled: "yes" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  describe("PUT /daily/schedule", () => {
    it("persists a valid schedule", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/schedule", "put");
      const req = mockReq(adminId, {
        body: {
          schedule: [
            "classic", "classic", "classic", "classic", "classic", "classic", "classic",
          ],
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.schedule).toHaveLength(7);
    });

    it("400 on length != 7", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/schedule", "put");
      const req = mockReq(adminId, { body: { schedule: ["classic"] } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("400 on an unknown mode string", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/schedule", "put");
      const req = mockReq(adminId, {
        body: {
          schedule: [
            "classic", "classic", "not-a-real-mode", "classic", "classic", "classic", "classic",
          ],
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("accepts any registered GameMode (every mode is admin-selectable)", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/schedule", "put");
      const schedule = [
        "classic", "riser", "chain-reaction", "market-basket",
        "odd-one-out", "sort-it-out", "budget-builder",
      ];
      const req = mockReq(adminId, { body: { schedule } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.schedule).toEqual(schedule);
    });
  });

  describe("PUT /daily/:date/products", () => {
    it("persists a manual override with valid input", () => {
      const ids = (db.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/:date/products", "put");
      const req = mockReq(adminId, {
        params: { date: "2030-04-15" },
        body: { gameMode: "classic", productIds: ids },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isManualOverride).toBe(true);
      expect(data.body.productIds).toEqual(ids);
    });

    it("400 on missing gameMode", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/:date/products", "put");
      const req = mockReq(adminId, {
        params: { date: "2030-04-15" },
        body: { productIds: [1, 2, 3, 4, 5] },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("400 on bad date", () => {
      const ids = (db.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/:date/products", "put");
      const req = mockReq(adminId, {
        params: { date: "not-a-date" },
        body: { gameMode: "classic", productIds: ids },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  describe("POST /daily/:date/regenerate", () => {
    it("regenerates a fresh row", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/:date/regenerate", "post");
      const req = mockReq(adminId, { params: { date: "2030-04-15" }, body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isManualOverride).toBe(false);
      expect(data.body.productIds.length).toBeGreaterThan(0);
    });

    it("409 manual_override_protected when override exists and force is not set", () => {
      // Set up a manual override
      const ids = (db.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
      const router = createAdminRouter(db, contactsDb);
      const setHandler = getHandler(router, "/daily/:date/products", "put");
      const setReq = mockReq(adminId, {
        params: { date: "2030-04-15" },
        body: { gameMode: "classic", productIds: ids },
      });
      const { res: setRes } = mockRes();
      setHandler(setReq, setRes);

      const router2 = createAdminRouter(db, contactsDb);
      const handler = getHandler(router2, "/daily/:date/regenerate", "post");
      const req = mockReq(adminId, { params: { date: "2030-04-15" }, body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(409);
      expect(data.body.error).toBe("manual_override_protected");
    });

    it("force=true clears the manual override flag", () => {
      const ids = (db.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
      const router = createAdminRouter(db, contactsDb);
      const setHandler = getHandler(router, "/daily/:date/products", "put");
      const setReq = mockReq(adminId, {
        params: { date: "2030-04-15" },
        body: { gameMode: "classic", productIds: ids },
      });
      const { res: setRes } = mockRes();
      setHandler(setReq, setRes);

      const router2 = createAdminRouter(db, contactsDb);
      const handler = getHandler(router2, "/daily/:date/regenerate", "post");
      const req = mockReq(adminId, { params: { date: "2030-04-15" }, body: { force: true } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.isManualOverride).toBe(false);
    });
  });

  describe("GET /daily/stats", () => {
    it("returns zeros when no plays exist", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/stats", "get");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.totalPlays).toBe(0);
      expect(data.body.uniquePlayers).toBe(0);
    });
  });

  describe("DELETE /daily/plays/:userId/:date", () => {
    it("returns deleted=0 when no row matches", () => {
      const userId = seedUser(db, "support");
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/plays/:userId/:date", "delete");
      const req = mockReq(adminId, { params: { userId, date: "2030-04-15" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toEqual({ deleted: 0 });
    });

    it("400 on bad date", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/daily/plays/:userId/:date", "delete");
      const req = mockReq(adminId, { params: { userId: "u", date: "bad" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  // ── Public Page Visibility Routes ────────────────────────────────────────
  describe("GET /pages", () => {
    it("returns an all-false map for a fresh database", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/pages");
      const req = mockReq(adminId);
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.pages).toEqual({
        about: false,
        faq: false,
        contact: false,
        game_modes: false,
        privacy: false,
        terms: false,
      });
    });
  });

  describe("PUT /pages", () => {
    it("persists every flag independently", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/pages", "put");
      const req = mockReq(adminId, {
        body: {
          pages: {
            about: true,
            faq: false,
            contact: true,
            game_modes: false,
            privacy: true,
            terms: true,
          },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.pages).toEqual({
        about: true,
        faq: false,
        contact: true,
        game_modes: false,
        privacy: true,
        terms: true,
      });

      // GET after PUT should reflect the persisted state.
      const getH = getHandler(router, "/pages");
      const getReq = mockReq(adminId);
      const getOut = mockRes();
      getH(getReq, getOut.res);
      expect(getOut.data.body.pages.about).toBe(true);
    });

    it("rejects a non-object pages payload", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/pages", "put");
      const req = mockReq(adminId, { body: { pages: "nope" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("drops unknown keys silently", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/pages", "put");
      const req = mockReq(adminId, {
        body: {
          pages: {
            about: true,
            bogus: true,
          },
        },
      });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body.pages.about).toBe(true);
      expect(data.body.pages.bogus).toBeUndefined();
    });
  });

  // ── Referral Analytics Routes ─────────────────────────────────────────────

  describe("GET /analytics/referrals/*", () => {
    function seedReferralRow(referrerId: string, referredId: string, status: "pending" | "credited" | "rejected", reason?: string) {
      const id = `${referrerId}-${referredId}-ref`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, rejection_reason, created_at, credited_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        referrerId,
        referredId,
        `R${id.slice(0, 7).toUpperCase()}`,
        status,
        reason ?? null,
        now,
        status === "credited" ? now : null,
      );
    }

    function makeUser(username: string, email: string): string {
      const userId = `${username}-id`;
      db.prepare(
        `INSERT INTO users (id, username, username_normalized, email, password_hash, is_active, lifetime_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'hash', 1, 0, ?, ?)`,
      ).run(userId, username, username.toLowerCase(), email, new Date().toISOString(), new Date().toISOString());
      return userId;
    }

    it("summary returns KPI counters", () => {
      const a = makeUser("alice", "alice@x.com");
      const b = makeUser("bob", "bob@x.com");
      const c = makeUser("carol", "carol@x.com");
      seedReferralRow(a, b, "credited");
      seedReferralRow(a, c, "pending");

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/summary");
      const req = mockReq(adminId, { query: { range: "28d" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body.total).toBe(2);
      expect(data.body.credited).toBe(1);
      expect(data.body.pending).toBe(1);
      expect(data.body.uniqueReferrers).toBe(1);
    });

    it("daily returns a zero-filled series", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/daily");
      const req = mockReq(adminId, { query: { range: "7d" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(Array.isArray(data.body)).toBe(true);
      expect(data.body).toHaveLength(7);
      expect(data.body[0]).toMatchObject({ date: expect.any(String), created: 0, credited: 0 });
    });

    it("top-referrers ranks users by credited count", () => {
      const a = makeUser("alice", "alice@x.com");
      const b = makeUser("bob", "bob@x.com");
      const c = makeUser("carol", "carol@x.com");
      const d = makeUser("dan", "dan@x.com");
      seedReferralRow(b, a, "credited");
      seedReferralRow(b, c, "credited");
      seedReferralRow(a, d, "credited");

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/top-referrers");
      const req = mockReq(adminId, { query: { range: "28d", limit: "5" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(data.body[0].username).toBe("bob");
      expect(data.body[0].credited).toBe(2);
    });

    it("top-referrers clamps limit", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/top-referrers");
      const req = mockReq(adminId, { query: { limit: "9999" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined();
      expect(Array.isArray(data.body)).toBe(true);
    });

    it("rejections returns reason buckets", () => {
      const a = makeUser("alice", "alice@x.com");
      const b = makeUser("bob", "bob@x.com");
      const c = makeUser("carol", "carol@x.com");
      seedReferralRow(a, b, "rejected", "ip_match");
      seedReferralRow(a, c, "rejected", "disposable_email");

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/rejections");
      const req = mockReq(adminId, { query: { range: "28d" } });
      const { res, data } = mockRes();
      handler(req, res);

      const reasons = (data.body as Array<{ reason: string; count: number }>).map((r) => r.reason);
      expect(reasons).toContain("ip_match");
      expect(reasons).toContain("disposable_email");
    });

    it("invalid range falls back to default rather than 500", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/summary");
      const req = mockReq(adminId, { query: { range: "garbage" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined();
      expect(data.body.total).toBeDefined();
    });

    it("by-referrer returns the referred-user list", () => {
      const a = makeUser("alice", "alice@x.com");
      const b = makeUser("bob", "bob@x.com");
      const c = makeUser("carol", "carol@x.com");
      seedReferralRow(a, b, "credited");
      seedReferralRow(a, c, "pending");

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/by-referrer");
      const req = mockReq(adminId, { query: { referrerId: a, range: "28d" } });
      const { res, data } = mockRes();
      handler(req, res);

      expect(Array.isArray(data.body)).toBe(true);
      expect(data.body).toHaveLength(2);
      const usernames = (data.body as Array<{ username: string }>).map((r) => r.username);
      expect(usernames).toContain("bob");
      expect(usernames).toContain("carol");
    });

    it("by-referrer 400s when referrerId is missing", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/analytics/referrals/by-referrer");
      const req = mockReq(adminId, { query: { range: "28d" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });
  });

  describe("POST /ghost-users/simulate-daily-now", () => {
    it("returns a 200 with the simulation summary", () => {
      // Enable ghosts so the simulator does work; without this it returns
      // an all-zeros summary which still 200s but doesn't exercise the
      // happy path.
      _resetSimLatchForTesting();
      setGhostSettings(db, { enabled: true });

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/ghost-users/simulate-daily-now", "post");
      const req = mockReq(adminId, { body: {} });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.body).toMatchObject({
        ghostsConsidered: expect.any(Number),
        played: expect.any(Number),
        skippedNoPlay: expect.any(Number),
        streakCapped: expect.any(Number),
        cleanupZeroed: expect.any(Number),
      });
    });

    it("400s on a bad date format", () => {
      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/ghost-users/simulate-daily-now", "post");
      const req = mockReq(adminId, { body: { date: "not-a-date" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBe(400);
    });

    it("accepts an explicit YYYY-MM-DD date and runs against it", () => {
      _resetSimLatchForTesting();
      setGhostSettings(db, { enabled: true });

      const router = createAdminRouter(db, contactsDb);
      const handler = getHandler(router, "/ghost-users/simulate-daily-now", "post");
      const req = mockReq(adminId, { body: { date: "2026-04-27" } });
      const { res, data } = mockRes();
      handler(req, res);
      expect(data.statusCode).toBeUndefined(); // 200 → res.status not called
      expect(data.body.ghostsConsidered).toBeDefined();
    });
  });
});
