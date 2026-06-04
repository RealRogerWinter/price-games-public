/**
 * Integration tests for the image proxy router.
 *
 * Focus: the Cache-Control headers on non-200 paths — iOS Safari was
 * observed caching error bodies (429, 404) as broken images, causing
 * subsequent rounds to show blank product art until the user refreshed.
 * These tests pin the header behavior so a regression can't silently
 * reintroduce the bug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, Server as HttpServer } from "http";
import { createTestDb } from "../test/dbHelper";
import { createImageRouter } from "./image";
import * as imageProxy from "../services/imageProxy";
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
let server: HttpServer;
let baseUrl: string;

beforeEach(async () => {
  db = createTestDb();
  const app = express();
  app.use("/api/image", createImageRouter(() => db));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (server) server.close();
});

describe("GET /api/image/:productId — cache headers", () => {
  it("sets Cache-Control: no-store on 400 for invalid productId", async () => {
    const res = await fetch(`${baseUrl}/api/image/abc`);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate");
  });

  it("sets Cache-Control: no-store on 404 when product does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/image/9999`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate");
  });

  it("sets Cache-Control: public, max-age=86400 on successful image fetch", async () => {
    vi.spyOn(imageProxy, "fetchProductImage").mockResolvedValue({
      buffer: Buffer.from("x".repeat(1100)),
      contentType: "image/jpeg",
    });

    const res = await fetch(`${baseUrl}/api/image/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("sets Cache-Control: no-store on 500 when fetchProductImage throws", async () => {
    vi.spyOn(imageProxy, "fetchProductImage").mockRejectedValue(new Error("boom"));

    const res = await fetch(`${baseUrl}/api/image/2`);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate");
  });

  it("handles concurrent requests in parallel (async scrape does not block event loop)", async () => {
    // Two concurrent requests should resolve in parallel, not serially.
    // With the previous synchronous execFileSync scrape, request N+1 had
    // to wait for request N's curl subprocess to finish before even
    // starting — pushing p99 past iOS Safari's HTTP/2 stall window.
    // Use a longer per-request delay (300ms) so the serial vs parallel
    // gap is wide enough to remain unambiguous under CI overhead. The
    // older 120ms delays left only a ~60ms margin which slow CircleCI
    // workers (observed 287ms elapsed in pipeline #340) could eat into.
    vi.spyOn(imageProxy, "fetchProductImage").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { buffer: Buffer.from("x".repeat(1100)), contentType: "image/jpeg" };
    });

    const started = Date.now();
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/image/3`),
      fetch(`${baseUrl}/api/image/4`),
    ]);
    const elapsed = Date.now() - started;

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Serial execution would be ~600ms+ (2 × 300ms); parallel should be
    // ~300-400ms. A 500ms ceiling still clearly asserts parallel execution
    // while tolerating slow-runner overhead.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("image rate-limit handler — cache headers", () => {
  // Separate suite so we can mount the limiter with max: 1 to verify the
  // handler's Cache-Control behavior end-to-end. The main image.ts file does
  // not own the limiter (it's a deployment concern wired up in index.ts)
  // but the header it sets is load-bearing for the iOS Safari fix.
  it("sets Cache-Control: no-store on 429 rate-limit responses", async () => {
    const rateLimit = (await import("express-rate-limit")).default;
    const app = express();
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      handler: (_req, res) => {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        res.status(429).send("Too many image requests");
      },
    });
    const limitedDb = createTestDb();
    app.use("/api/image", limiter, createImageRouter(() => limitedDb));
    const limitedServer = createServer(app);
    await new Promise<void>((resolve) => limitedServer.listen(0, () => resolve()));
    const addr = limitedServer.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      await fetch(`${url}/api/image/1`); // consume the quota
      const res = await fetch(`${url}/api/image/1`); // triggers the 429 handler
      expect(res.status).toBe(429);
      expect(res.headers.get("cache-control")).toBe("no-store, must-revalidate");
    } finally {
      limitedServer.close();
    }
  });
});

describe("image rate-limit — bot exemption + per-IP keying", () => {
  // The streamer bot shares an egress IP with one or more humans and would
  // otherwise burn the shared per-IP image budget every round. The skip
  // predicate keeps the bot from starving humans of images.
  it("skips the limiter when req.isStreamerBot is true", async () => {
    const rateLimit = (await import("express-rate-limit")).default;
    const app = express();
    // Mark every request as a bot so the limiter MUST be skipped for the
    // requests to succeed past max: 1.
    app.use((req, _res, next) => {
      (req as unknown as { isStreamerBot?: boolean }).isStreamerBot = true;
      next();
    });
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      skip: (req) => (req as unknown as { isStreamerBot?: boolean }).isStreamerBot === true,
      handler: (_req, res) => {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        res.status(429).send("Too many image requests");
      },
    });
    const limitedDb = createTestDb();
    app.use("/api/image", limiter, createImageRouter(() => limitedDb));
    const limitedServer = createServer(app);
    await new Promise<void>((resolve) => limitedServer.listen(0, () => resolve()));
    const addr = limitedServer.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      // Five requests, all bot — none should 429 even though max is 1.
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${url}/api/image/${i + 1}`);
        expect(res.status).not.toBe(429);
      }
    } finally {
      limitedServer.close();
    }
  });

  // Locks in the trust-proxy fix at the Express level: a connection from a
  // docker-bridge-gateway IP must be treated as a trusted proxy hop so the
  // limiter keys on the real client IP carried in X-Forwarded-For. Without
  // the fix all external clients would share one bucket.
  it("keys the limiter per X-Forwarded-For when proxied from a trusted hop", async () => {
    const rateLimit = (await import("express-rate-limit")).default;
    const app = express();
    // Match the production set: loopback + link-local + unique-local. The
    // test loopback connection (127.0.0.1) is in this set, so XFF is honored.
    app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      handler: (_req, res) => {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        res.status(429).send("Too many image requests");
      },
    });
    const limitedDb = createTestDb();
    app.use("/api/image", limiter, createImageRouter(() => limitedDb));
    const limitedServer = createServer(app);
    await new Promise<void>((resolve) => limitedServer.listen(0, () => resolve()));
    const addr = limitedServer.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      // Two distinct fake clients via XFF — neither should 429 the other.
      const a1 = await fetch(`${url}/api/image/1`, { headers: { "X-Forwarded-For": "203.0.113.10" } });
      const b1 = await fetch(`${url}/api/image/2`, { headers: { "X-Forwarded-For": "203.0.113.20" } });
      expect(a1.status).not.toBe(429);
      expect(b1.status).not.toBe(429);
      // A's second hit MUST 429 (bucket exhausted), B's bucket is still free.
      const a2 = await fetch(`${url}/api/image/3`, { headers: { "X-Forwarded-For": "203.0.113.10" } });
      expect(a2.status).toBe(429);
    } finally {
      limitedServer.close();
    }
  });
});
