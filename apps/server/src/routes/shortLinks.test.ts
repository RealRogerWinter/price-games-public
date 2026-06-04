/**
 * HTTP integration tests for the public `/go/:code` short-link redirect.
 *
 * The handler is mounted on a throwaway Express app so we can exercise
 * the redirect, 404 path, security headers, and click-counter increment
 * without spinning up the full server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, Server as HttpServer } from "http";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedAdminUser } from "../test/dbHelper";
import { createUtmTag, setUtmTagStatus } from "../services/utmTags";
import { createShortLinkRouter } from "./shortLinks";

let db: DatabaseType;
let server: HttpServer;
let baseUrl: string;
// The router uses a configured base URL (not the request's Host header) so
// that malicious `Host: evil.com` headers cannot force an open redirect.
// For tests we override it to a known-harmless origin so assertions on the
// Location header are deterministic.
const TRUSTED_BASE_URL = "https://test.price.games";

function buildApp(database: DatabaseType) {
  const app = express();
  app.use(createShortLinkRouter(database, undefined, TRUSTED_BASE_URL));
  return app;
}

async function listen(app: express.Application): Promise<string> {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

beforeEach(async () => {
  db = createTestDb();
  seedAdminUser(db, "admin", "testpassword123");
  baseUrl = await listen(buildApp(db));
});

afterEach(() => {
  if (server) server.close();
});

describe("GET /go/:code", () => {
  it("returns 404 with X-Robots-Tag: noindex for an unknown code", async () => {
    const res = await fetch(`${baseUrl}/go/nonexistent`, { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("302 redirects to the long UTM URL for a known code", async () => {
    const tag = createUtmTag(
      db,
      {
        name: "redirect-test",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "launch",
        destinationUrl: "/giveaway",
        shortCode: "red-go-1",
      },
      null,
    );

    const res = await fetch(`${baseUrl}/go/${tag.shortCode}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const parsed = new URL(location!);
    // Origin must come from the trusted server-configured base URL, NOT
    // from the request's Host header — this is the host-header-injection
    // fix for the security review on PR #56.
    expect(parsed.origin).toBe(TRUSTED_BASE_URL);
    expect(parsed.pathname).toBe("/giveaway");
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
    expect(parsed.searchParams.get("utm_medium")).toBe("cpc");
    expect(parsed.searchParams.get("utm_campaign")).toBe("launch");
  });

  it("ignores a malicious Host header and redirects to the configured origin", async () => {
    // Regression test for the security review finding (PR #56): a crafted
    // `Host: evil.com` header must not steer a root-relative destination
    // into an open redirect at `https://evil.com/giveaway`.
    createUtmTag(
      db,
      {
        name: "host-injection",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "host-go",
      },
      null,
    );
    const res = await fetch(`${baseUrl}/go/host-go`, {
      redirect: "manual",
      headers: { Host: "evil.com" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const parsed = new URL(location);
    // Origin comes from the trusted base URL override, not from the Host
    // header. evil.com must NOT appear anywhere in the redirect target.
    expect(parsed.origin).toBe(TRUSTED_BASE_URL);
    expect(location).not.toContain("evil.com");
  });

  it("sets Cache-Control: no-store and X-Robots-Tag: noindex on the redirect", async () => {
    createUtmTag(
      db,
      {
        name: "headers",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "hdrs-1",
      },
      null,
    );
    const res = await fetch(`${baseUrl}/go/hdrs-1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("increments click_count by 1 per request", async () => {
    const tag = createUtmTag(
      db,
      {
        name: "counter",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "cnt-1",
      },
      null,
    );
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${baseUrl}/go/cnt-1`, { redirect: "manual" });
      expect(r.status).toBe(302);
    }
    const row = db
      .prepare("SELECT click_count, last_clicked_at FROM utm_tags WHERE id = ?")
      .get(tag.id) as { click_count: number; last_clicked_at: string | null };
    expect(row.click_count).toBe(3);
    expect(row.last_clicked_at).toBeTruthy();
  });

  it("still redirects and counts clicks for archived tags", async () => {
    const tag = createUtmTag(
      db,
      {
        name: "archived",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "arch-go",
      },
      null,
    );
    setUtmTagStatus(db, tag.id, "archived");

    const res = await fetch(`${baseUrl}/go/arch-go`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const row = db
      .prepare("SELECT click_count, status FROM utm_tags WHERE id = ?")
      .get(tag.id) as { click_count: number; status: string };
    expect(row.status).toBe("archived");
    expect(row.click_count).toBe(1);
  });

  it("normalizes mixed-case incoming codes to lowercase before lookup", async () => {
    createUtmTag(
      db,
      {
        name: "case",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "lower-go",
      },
      null,
    );
    // Users may paste the code with stray uppercase; the handler should
    // normalize before looking up.
    const res = await fetch(`${baseUrl}/go/LOWER-GO`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  it("returns 404 for a tag that has no short code (can only happen via direct path manipulation)", async () => {
    createUtmTag(
      db,
      { name: "no-sc", utmSource: "reddit", destinationUrl: "/giveaway" },
      null,
    );
    // Empty path segment is handled by Express routing (no match), but a
    // non-matching code should still return 404.
    const res = await fetch(`${baseUrl}/go/not-set`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("redirects to an absolute destination preserving origin", async () => {
    createUtmTag(
      db,
      {
        name: "abs-dest",
        utmSource: "reddit",
        destinationUrl: "https://partner.example.com/landing",
        shortCode: "abs-go",
      },
      null,
    );
    const res = await fetch(`${baseUrl}/go/abs-go`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    const parsed = new URL(location!);
    expect(parsed.origin).toBe("https://partner.example.com");
    expect(parsed.pathname).toBe("/landing");
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
  });
});
