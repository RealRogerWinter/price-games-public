import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import {
  computePercentileCap,
  getCachedCap,
  invalidateCapCache,
} from "./cap";
import { setGhostSettings } from "./settings";

let db: DatabaseType;

function insertUser(score: number, sessionsPlayed = 10) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash,
                        created_at, updated_at, is_active, lifetime_score, total_sessions)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 1, ?, ?)`,
  ).run(uuidv4(), `u${score}`, `u${score}`, `u${score}@x.com`, now, now, score, sessionsPlayed);
}

beforeEach(() => {
  db = createTestDb();
  invalidateCapCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computePercentileCap", () => {
  it("returns 0 when no users have scored", () => {
    expect(computePercentileCap(db, 70)).toBe(0);
  });

  it("ignores users with fewer than the minimum sessions", () => {
    // Real users with 0-1 sessions are noise.
    insertUser(100_000, 0);
    insertUser(50_000, 1);
    expect(computePercentileCap(db, 70)).toBe(0);
  });

  it("computes the 70th percentile of qualified users", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    // Sorted ascending: 1000, 2000, ..., 10000
    // 70th percentile (index 6 in 0-indexed) = 7000
    expect(computePercentileCap(db, 70)).toBe(7000);
  });

  it("respects custom percentile values", () => {
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    expect(computePercentileCap(db, 50)).toBe(5000);
    expect(computePercentileCap(db, 90)).toBe(9000);
  });

  it("returns the highest score when percentile = 100", () => {
    insertUser(1000, 10);
    insertUser(5000, 10);
    insertUser(9000, 10);
    expect(computePercentileCap(db, 100)).toBe(9000);
  });
});

describe("getCachedCap", () => {
  it("uses the percentile from settings on first call", () => {
    setGhostSettings(db, { percentileCap: 50 });
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    expect(getCachedCap(db)).toBe(5000);
  });

  it("caches the value across calls", () => {
    setGhostSettings(db, { percentileCap: 70 });
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    expect(getCachedCap(db)).toBe(7000);
    // Add a new high-scorer; cache should still return the old value.
    insertUser(99_999, 10);
    expect(getCachedCap(db)).toBe(7000);
  });

  it("re-reads after the TTL expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    setGhostSettings(db, { percentileCap: 70 });
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    expect(getCachedCap(db)).toBe(7000);

    insertUser(99_999, 10);
    // Default TTL is 6 hours; advance just past it.
    vi.setSystemTime(new Date(2026, 0, 1, 18, 0, 1));
    // Now there are 11 qualified scores: 1000..10000, 99999. Sorted asc,
    // 70th percentile (index 7 in 0-indexed) = 8000.
    expect(getCachedCap(db)).toBe(8000);
  });

  it("invalidateCapCache forces a fresh read", () => {
    setGhostSettings(db, { percentileCap: 70 });
    for (let i = 1; i <= 10; i++) insertUser(i * 1000, 10);
    expect(getCachedCap(db)).toBe(7000);
    insertUser(99_999, 10);
    invalidateCapCache();
    expect(getCachedCap(db)).toBe(8000);
  });
});
