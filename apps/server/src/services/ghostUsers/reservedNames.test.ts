import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  isReservedByGhost,
  invalidateReservedNamesCache,
} from "./reservedNames";

let db: DatabaseType;

function insertGhost(opts: { id?: string; username: string }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ghost_users (id, username, username_normalized, avatar,
                              lifetime_score, account_created_at, on_shift,
                              is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'silhouette', 0, ?, 0, 1, ?, ?)`,
  ).run(opts.id ?? opts.username, opts.username, opts.username.toLowerCase(), now, now, now);
}

beforeEach(() => {
  db = createTestDb();
  invalidateReservedNamesCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isReservedByGhost", () => {
  it("returns false when no ghosts exist", () => {
    expect(isReservedByGhost(db, "anyone")).toBe(false);
  });

  it("returns true for an existing ghost username (case-insensitive)", () => {
    insertGhost({ username: "Mike_42" });
    expect(isReservedByGhost(db, "Mike_42")).toBe(true);
    expect(isReservedByGhost(db, "MIKE_42")).toBe(true);
    expect(isReservedByGhost(db, "mike_42")).toBe(true);
  });

  it("returns false for non-matching names", () => {
    insertGhost({ username: "alice99" });
    expect(isReservedByGhost(db, "bob99")).toBe(false);
  });

  it("caches results across calls", () => {
    insertGhost({ username: "cached_name" });
    expect(isReservedByGhost(db, "cached_name")).toBe(true);
    // Mutate the table directly without invalidating; the cache should
    // still return the original answer until TTL expires or invalidate fires.
    db.prepare("DELETE FROM ghost_users WHERE username = 'cached_name'").run();
    expect(isReservedByGhost(db, "cached_name")).toBe(true);
  });

  it("invalidateReservedNamesCache forces a fresh DB read", () => {
    insertGhost({ username: "stale" });
    expect(isReservedByGhost(db, "stale")).toBe(true);
    db.prepare("DELETE FROM ghost_users WHERE username = 'stale'").run();
    invalidateReservedNamesCache();
    expect(isReservedByGhost(db, "stale")).toBe(false);
  });

  it("re-reads the DB once the TTL expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    insertGhost({ username: "ttl_test" });
    expect(isReservedByGhost(db, "ttl_test")).toBe(true);

    db.prepare("DELETE FROM ghost_users WHERE username = 'ttl_test'").run();
    // 60s TTL — advance just past it.
    vi.setSystemTime(new Date(2026, 0, 1, 12, 1, 1));
    expect(isReservedByGhost(db, "ttl_test")).toBe(false);
  });

  it("trims whitespace before comparison", () => {
    insertGhost({ username: "trimmed" });
    expect(isReservedByGhost(db, "  trimmed  ")).toBe(true);
  });

  it("returns false for empty input", () => {
    expect(isReservedByGhost(db, "")).toBe(false);
    expect(isReservedByGhost(db, "   ")).toBe(false);
  });
});
