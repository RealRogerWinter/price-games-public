import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import { v4 as uuidv4 } from "uuid";
import {
  generateGhostPersona,
  generateGhostPersonas,
  GHOST_AGE_MIN_DAYS,
  GHOST_AGE_MAX_DAYS,
} from "./persona";
import { invalidateReservedNamesCache } from "./reservedNames";
import { RANDOMIZABLE_AVATARS } from "@price-game/shared";

let db: DatabaseType;

function insertRealUser(username: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash,
                        created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 1)`,
  ).run(uuidv4(), username, username.toLowerCase(), `${username}@example.com`, now, now);
}

function insertGhost(username: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ghost_users (id, username, username_normalized, avatar,
                              lifetime_score, account_created_at, on_shift,
                              is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'silhouette', 0, ?, 0, 1, ?, ?)`,
  ).run(uuidv4(), username, username.toLowerCase(), now, now, now);
}

beforeEach(() => {
  db = createTestDb();
  invalidateReservedNamesCache();
});

describe("generateGhostPersona", () => {
  it("returns a non-empty username + avatar + account_created_at", () => {
    const p = generateGhostPersona(db);
    expect(p).not.toBeNull();
    expect(typeof p!.username).toBe("string");
    expect(p!.username.length).toBeGreaterThan(0);
    expect(typeof p!.avatar).toBe("string");
    expect(typeof p!.accountCreatedAt).toBe("string");
  });

  it("uses an avatar from RANDOMIZABLE_AVATARS", () => {
    const valid = new Set<string>(RANDOMIZABLE_AVATARS);
    for (let i = 0; i < 30; i++) {
      const p = generateGhostPersona(db);
      expect(valid.has(p!.avatar as (typeof RANDOMIZABLE_AVATARS)[number])).toBe(true);
    }
  });

  it("never collides with existing real users (case-insensitive)", () => {
    insertRealUser("Mike_42");
    insertRealUser("sarah.b");
    for (let i = 0; i < 50; i++) {
      const p = generateGhostPersona(db);
      const lower = p!.username.toLowerCase();
      expect(lower).not.toBe("mike_42");
      expect(lower).not.toBe("sarah.b");
    }
  });

  it("never collides with existing ghosts", () => {
    insertGhost("ghost_1");
    insertGhost("ghost_2");
    for (let i = 0; i < 50; i++) {
      const p = generateGhostPersona(db);
      const lower = p!.username.toLowerCase();
      expect(lower).not.toBe("ghost_1");
      expect(lower).not.toBe("ghost_2");
    }
  });

  it("produces an account_created_at in the past (between MIN and MAX days ago)", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      const p = generateGhostPersona(db);
      const ts = new Date(p!.accountCreatedAt).getTime();
      const ageDays = (now - ts) / (24 * 3600 * 1000);
      expect(ageDays).toBeGreaterThanOrEqual(GHOST_AGE_MIN_DAYS - 0.5);
      expect(ageDays).toBeLessThanOrEqual(GHOST_AGE_MAX_DAYS + 0.5);
    }
  });
});

describe("generateGhostPersonas (bulk)", () => {
  it("returns N unique personas", () => {
    const personas = generateGhostPersonas(db, 20);
    expect(personas).toHaveLength(20);
    const usernames = new Set(personas.map((p) => p.username.toLowerCase()));
    expect(usernames.size).toBe(20);
  });

  it("respects existing real users + ghosts when bulk-generating", () => {
    insertRealUser("alex_pro");
    insertGhost("alex_pro_ghost");
    const personas = generateGhostPersonas(db, 30);
    const usernames = new Set(personas.map((p) => p.username.toLowerCase()));
    expect(usernames.has("alex_pro")).toBe(false);
    expect(usernames.has("alex_pro_ghost")).toBe(false);
  });
});
