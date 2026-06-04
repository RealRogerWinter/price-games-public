import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import { retireInactiveGhosts, INACTIVE_THRESHOLD_DAYS, MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS } from "./cycling";
import { invalidateReservedNamesCache } from "./reservedNames";

let db: DatabaseType;

function insertGhost(opts: {
  id?: string;
  username?: string;
  isActive?: number;
  lastPlayedAt?: string | null;
  accountCreatedAt: string;
}) {
  const id = opts.id ?? uuidv4();
  const username = opts.username ?? `g_${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ghost_users (id, username, username_normalized, avatar,
                              lifetime_score, account_created_at, on_shift,
                              is_active, last_played_at, created_at, updated_at)
     VALUES (?, ?, ?, 'silhouette', 0, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    username,
    username.toLowerCase(),
    opts.accountCreatedAt,
    opts.isActive ?? 1,
    opts.lastPlayedAt ?? null,
    now,
    now,
  );
  return id;
}

beforeEach(() => {
  db = createTestDb();
  invalidateReservedNamesCache();
});

describe("retireInactiveGhosts", () => {
  it("retires ghosts past the inactivity threshold AND old enough", () => {
    const long = (INACTIVE_THRESHOLD_DAYS + 5) * 24 * 3600 * 1000;
    const oldEnough = (MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS + 5) * 24 * 3600 * 1000;
    const id = insertGhost({
      lastPlayedAt: new Date(Date.now() - long).toISOString(),
      accountCreatedAt: new Date(Date.now() - oldEnough).toISOString(),
    });
    expect(retireInactiveGhosts(db)).toBe(1);
    const row = db.prepare("SELECT is_active FROM ghost_users WHERE id = ?").get(id) as { is_active: number };
    expect(row.is_active).toBe(0);
  });

  it("does not retire ghosts below the minimum account age", () => {
    const long = (INACTIVE_THRESHOLD_DAYS + 5) * 24 * 3600 * 1000;
    const tooFresh = (MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS - 5) * 24 * 3600 * 1000;
    const id = insertGhost({
      lastPlayedAt: new Date(Date.now() - long).toISOString(),
      accountCreatedAt: new Date(Date.now() - tooFresh).toISOString(),
    });
    expect(retireInactiveGhosts(db)).toBe(0);
    const row = db.prepare("SELECT is_active FROM ghost_users WHERE id = ?").get(id) as { is_active: number };
    expect(row.is_active).toBe(1);
  });

  it("does not retire ghosts that recently played", () => {
    const recent = 3 * 24 * 3600 * 1000;
    const oldEnough = (MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS + 5) * 24 * 3600 * 1000;
    const id = insertGhost({
      lastPlayedAt: new Date(Date.now() - recent).toISOString(),
      accountCreatedAt: new Date(Date.now() - oldEnough).toISOString(),
    });
    expect(retireInactiveGhosts(db)).toBe(0);
    const row = db.prepare("SELECT is_active FROM ghost_users WHERE id = ?").get(id) as { is_active: number };
    expect(row.is_active).toBe(1);
  });

  it("treats null last_played_at as 'never played' — uses account_created_at instead", () => {
    // A ghost that never accrued a single round, after MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS,
    // should still be retired so the roster cycles.
    const oldEnough = (MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS + INACTIVE_THRESHOLD_DAYS + 5) * 24 * 3600 * 1000;
    const id = insertGhost({
      lastPlayedAt: null,
      accountCreatedAt: new Date(Date.now() - oldEnough).toISOString(),
    });
    expect(retireInactiveGhosts(db)).toBe(1);
    const row = db.prepare("SELECT is_active FROM ghost_users WHERE id = ?").get(id) as { is_active: number };
    expect(row.is_active).toBe(0);
  });

  it("ignores already-inactive ghosts (no-op)", () => {
    const long = (INACTIVE_THRESHOLD_DAYS + 50) * 24 * 3600 * 1000;
    const oldEnough = (MIN_ACCOUNT_AGE_FOR_RETIRE_DAYS + 50) * 24 * 3600 * 1000;
    insertGhost({
      isActive: 0,
      lastPlayedAt: new Date(Date.now() - long).toISOString(),
      accountCreatedAt: new Date(Date.now() - oldEnough).toISOString(),
    });
    expect(retireInactiveGhosts(db)).toBe(0);
  });
});
