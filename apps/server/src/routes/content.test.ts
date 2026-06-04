/**
 * Tests for the public content router. Follows the project's no-supertest
 * handler-invocation pattern.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { createContentRouter } from "./content";
import { setSiteContent, setEnabledPages } from "../services/siteSettings";

let db: DatabaseType;
let router: ReturnType<typeof createContentRouter>;

beforeEach(() => {
  db = createTestDb();
  router = createContentRouter(() => db);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHandler(path: string, method: string = "get"): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route?.path === path) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stack = layer.route.stack.filter((s: any) => s.method === method);
      return stack[stack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockRes() {
  const data: { statusCode?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    json(d: any) { data.body = d; return res; },
    status(code: number) { data.statusCode = code; return res; },
    setHeader(k: string, v: string) { data.headers[k] = v; return res; },
  };
  return { res, data };
}

/** Enable every toggleable page so visibility-gated tests don't need to
 *  remember to flip flags individually. */
function enableAllPages() {
  setEnabledPages(db, {
    about: true,
    faq: true,
    contact: true,
    game_modes: true,
    privacy: true,
    terms: true,
  });
}

describe("GET /:key", () => {
  beforeEach(() => {
    enableAllPages();
  });

  it("returns default content for 'about' when unset", () => {
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "about" } }, res);
    expect(data.statusCode).toBeUndefined();
    expect((data.body as { key: string }).key).toBe("about");
  });

  it("returns default FAQ items when unset", () => {
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "faq" } }, res);
    const body = data.body as { key: string; items: unknown[] };
    expect(body.key).toBe("faq");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("returns stored content once configured", () => {
    setSiteContent(db, "about", { key: "about", title: "Custom T", body: "Custom B" });
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "about" } }, res);
    const body = data.body as { title: string; body: string };
    expect(body.title).toBe("Custom T");
    expect(body.body).toBe("Custom B");
  });

  it("returns 404 for invalid keys", () => {
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "bogus" } }, res);
    expect(data.statusCode).toBe(404);
  });

  it("sets a short cache header on successful responses", () => {
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "about" } }, res);
    expect(data.headers["Cache-Control"]).toContain("max-age=60");
  });
});

describe("GET /:key — visibility gating", () => {
  it("returns 404 for a valid key when the page is disabled by default", () => {
    // Fresh DB — no enabled_pages row, so every page is disabled.
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "about" } }, res);
    expect(data.statusCode).toBe(404);
  });

  it("returns 404 when a page is explicitly disabled", () => {
    enableAllPages();
    setEnabledPages(db, {
      about: false,
      faq: true,
      contact: true,
      game_modes: true,
      privacy: true,
      terms: true,
    });
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "about" } }, res);
    expect(data.statusCode).toBe(404);
  });

  it("still serves enabled pages when sibling pages are disabled", () => {
    setEnabledPages(db, {
      about: false,
      faq: true,
      contact: false,
      game_modes: false,
      privacy: false,
      terms: false,
    });
    const handler = getHandler("/:key");
    const { res, data } = mockRes();
    handler({ params: { key: "faq" } }, res);
    expect(data.statusCode).toBeUndefined();
    const body = data.body as { key: string };
    expect(body.key).toBe("faq");
  });
});

describe("GET /pages-enabled", () => {
  it("returns an all-false map for a fresh database", () => {
    const handler = getHandler("/pages-enabled");
    const { res, data } = mockRes();
    handler({}, res);
    const body = data.body as { pages: Record<string, boolean> };
    expect(body.pages.about).toBe(false);
    expect(body.pages.faq).toBe(false);
    expect(body.pages.contact).toBe(false);
    expect(body.pages.game_modes).toBe(false);
    expect(body.pages.privacy).toBe(false);
    expect(body.pages.terms).toBe(false);
  });

  it("reflects saved flags", () => {
    setEnabledPages(db, {
      about: true,
      faq: false,
      contact: true,
      game_modes: false,
      privacy: true,
      terms: false,
    });
    const handler = getHandler("/pages-enabled");
    const { res, data } = mockRes();
    handler({}, res);
    const body = data.body as { pages: Record<string, boolean> };
    expect(body.pages.about).toBe(true);
    expect(body.pages.faq).toBe(false);
    expect(body.pages.contact).toBe(true);
    expect(body.pages.privacy).toBe(true);
  });

  it("sets a short cache header", () => {
    const handler = getHandler("/pages-enabled");
    const { res, data } = mockRes();
    handler({}, res);
    expect(data.headers["Cache-Control"]).toContain("max-age=60");
  });
});
