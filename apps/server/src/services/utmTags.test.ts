/**
 * Tests for the UTM tag management service.
 *
 * Covers schema constraints, CRUD, URL generation, and the per-tag
 * conversion funnel (signups → played first game → giveaway-eligible →
 * won reward) computed against the existing users.utm_* columns.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "crypto";
import { createTestDb, seedAdminUser, seedUser } from "../test/dbHelper";
import {
  createUtmTag,
  getUtmTag,
  listUtmTags,
  updateUtmTag,
  setUtmTagStatus,
  deleteUtmTag,
  buildTagUrl,
  getUtmTagStats,
  getUtmTagTimeSeries,
  getUtmTagComparison,
  recordShortCodeClick,
  generateShortCodeSuggestion,
  buildShortUrl,
} from "./utmTags";

let db: DatabaseType;
let adminId: string;

beforeEach(() => {
  db = createTestDb();
  adminId = seedAdminUser(db);
});

// === Helpers ===

function makeTag(overrides: Partial<Parameters<typeof createUtmTag>[1]> = {}) {
  return createUtmTag(
    db,
    {
      name: `tag-${Math.random().toString(36).slice(2, 10)}`,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "giveaway_v1",
      destinationUrl: "/giveaway",
      ...overrides,
    },
    adminId,
  );
}

/**
 * Insert a user row with the given UTM tuple directly (bypassing signup
 * flow). Used to seed funnel test data. `createdAt` defaults to "now"
 * but is overridable so range-bound tests can backdate rows out of the
 * window.
 */
function insertUserWithAttribution(
  opts: {
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
    lifetimeScore?: number;
    createdAt?: string;
  } = {},
): string {
  const id = randomUUID();
  const username = `u-${id.slice(0, 8)}`;
  const created = opts.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO users
      (id, username, username_normalized, email, password_hash,
       created_at, updated_at, is_active, lifetime_score,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    username,
    username,
    `${username}@test.local`,
    created,
    created,
    opts.lifetimeScore ?? 0,
    opts.utmSource ?? null,
    opts.utmMedium ?? null,
    opts.utmCampaign ?? null,
    opts.utmContent ?? null,
    opts.utmTerm ?? null,
  );
  return id;
}

function recordGamePlayed(userId: string): void {
  db.prepare(
    `INSERT INTO user_game_history
      (user_id, game_type, game_mode, session_id, score, played_at)
     VALUES (?, 'single', 'classic', ?, 1000, ?)`,
  ).run(userId, randomUUID(), new Date().toISOString());
}

function recordRewardAward(userId: string): void {
  // Minimal reward_pool row (schema requires created_by).
  const rewardId = randomUUID();
  db.prepare(
    `INSERT INTO reward_pool (id, reward_type, amount_cents, code, status, created_at, created_by)
     VALUES (?, 'amazon_gift_card', 500, ?, 'awarded', ?, ?)`,
  ).run(rewardId, `CODE-${rewardId.slice(0, 8)}`, new Date().toISOString(), adminId);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO reward_awards
      (id, reward_id, user_id, award_method, awarded_at, awarded_by,
       claim_token, claim_expires_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    rewardId,
    userId,
    new Date().toISOString(),
    adminId,
    randomUUID(),
    expires,
  );
}

// === Schema constraints (migration v29) ===

describe("utm_tags schema", () => {
  it("creates the utm_tags table in the test DB", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='utm_tags'")
      .get();
    expect(row).toBeTruthy();
  });

  it("creates the users UTM cohort index", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_utm_cohort'")
      .get();
    expect(row).toBeTruthy();
  });

  it("enforces UNIQUE(name)", () => {
    makeTag({ name: "dupe" });
    expect(() => makeTag({ name: "dupe" })).toThrow("A UTM tag with this name already exists");
  });

  it("rejects status values outside the CHECK constraint", () => {
    // Bypass the service validator to prove the DB-level guard is in place.
    expect(() =>
      db
        .prepare(
          `INSERT INTO utm_tags
            (id, name, utm_source, destination_url, status, created_at, updated_at)
           VALUES (?, ?, 'reddit', '/giveaway', 'bogus', ?, ?)`,
        )
        .run(randomUUID(), "bad-status", new Date().toISOString(), new Date().toISOString()),
    ).toThrow();
  });
});

// === Schema constraints (migration v30: short-link columns) ===

describe("utm_tags schema v30 (short link + clicks)", () => {
  function getColumns(): Array<{ name: string; type: string; dflt_value: unknown; notnull: number }> {
    return db.prepare("PRAGMA table_info(utm_tags)").all() as Array<{
      name: string;
      type: string;
      dflt_value: unknown;
      notnull: number;
    }>;
  }

  it("adds short_code, click_count, and last_clicked_at columns", () => {
    const cols = getColumns();
    const names = cols.map((c) => c.name);
    expect(names).toContain("short_code");
    expect(names).toContain("click_count");
    expect(names).toContain("last_clicked_at");
  });

  it("click_count is NOT NULL with default 0", () => {
    const cols = getColumns();
    const col = cols.find((c) => c.name === "click_count");
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(1);
    // dflt_value is stored as the literal source text ("0").
    expect(String(col!.dflt_value)).toBe("0");
  });

  it("creates idx_utm_tags_short_code as a partial unique index", () => {
    const idx = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_utm_tags_short_code'",
      )
      .get() as { name: string; sql: string } | undefined;
    expect(idx).toBeTruthy();
    expect(idx!.sql).toMatch(/UNIQUE/i);
    expect(idx!.sql).toMatch(/WHERE\s+short_code\s+IS\s+NOT\s+NULL/i);
  });

  it("allows multiple NULL short_code values (partial unique)", () => {
    makeTag({ name: "null-1" });
    makeTag({ name: "null-2" });
    makeTag({ name: "null-3" });
    const row = db
      .prepare("SELECT COUNT(*) as c FROM utm_tags WHERE short_code IS NULL")
      .get() as { c: number };
    expect(row.c).toBeGreaterThanOrEqual(3);
  });

  it("rejects duplicate non-null short_code values at the DB level", () => {
    // Write directly to prove the unique partial index is enforced — bypassing
    // the service validator keeps this a pure schema test.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, destination_url, short_code,
                             status, created_at, updated_at)
       VALUES (?, ?, 'reddit', '/giveaway', 'dupcode', 'active', ?, ?)`,
    ).run(randomUUID(), "raw-1", now, now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO utm_tags (id, name, utm_source, destination_url, short_code,
                                 status, created_at, updated_at)
           VALUES (?, ?, 'reddit', '/giveaway', 'dupcode', 'active', ?, ?)`,
        )
        .run(randomUUID(), "raw-2", now, now),
    ).toThrow(/UNIQUE/i);
  });

  it("seeds click_count to 0 for newly inserted rows", () => {
    const tag = makeTag({ name: "fresh-clicks" });
    const row = db
      .prepare("SELECT click_count, last_clicked_at, short_code FROM utm_tags WHERE id = ?")
      .get(tag.id) as {
      click_count: number;
      last_clicked_at: string | null;
      short_code: string | null;
    };
    expect(row.click_count).toBe(0);
    expect(row.last_clicked_at).toBeNull();
    expect(row.short_code).toBeNull();
  });
});

// === createUtmTag ===

describe("createUtmTag", () => {
  it("persists all fields and returns the row in camelCase", () => {
    const tag = makeTag({
      name: "reddit-gw-v1",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "giveaway_v1",
      utmContent: "variant_a",
      utmTerm: "price",
      destinationUrl: "/giveaway",
    });
    expect(tag).toMatchObject({
      name: "reddit-gw-v1",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "giveaway_v1",
      utmContent: "variant_a",
      utmTerm: "price",
      destinationUrl: "/giveaway",
      status: "active",
      createdBy: adminId,
    });
    expect(tag.id).toBeTruthy();
    expect(tag.createdAt).toBeTruthy();
    expect(tag.updatedAt).toBeTruthy();
  });

  it("coerces empty-string optional UTM fields to null", () => {
    const tag = makeTag({
      name: "partial",
      utmMedium: "",
      utmContent: "",
      utmTerm: "",
    });
    expect(tag.utmMedium).toBeNull();
    expect(tag.utmContent).toBeNull();
    expect(tag.utmTerm).toBeNull();
  });

  it("trims name and string fields", () => {
    const tag = makeTag({
      name: "  spaced  ",
      utmSource: "  reddit  ",
      destinationUrl: "  /giveaway  ",
    });
    expect(tag.name).toBe("spaced");
    expect(tag.utmSource).toBe("reddit");
    expect(tag.destinationUrl).toBe("/giveaway");
  });

  it("rejects missing name", () => {
    expect(() =>
      createUtmTag(
        db,
        { name: "", utmSource: "reddit", destinationUrl: "/giveaway" },
        adminId,
      ),
    ).toThrow("UTM tag name is required");
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      createUtmTag(
        db,
        { name: "   ", utmSource: "reddit", destinationUrl: "/giveaway" },
        adminId,
      ),
    ).toThrow("UTM tag name is required");
  });

  it("rejects name exceeding 200 chars", () => {
    expect(() => makeTag({ name: "x".repeat(201) })).toThrow(
      "UTM tag name exceeds maximum length of 200 characters",
    );
  });

  it("rejects missing utm_source", () => {
    expect(() =>
      createUtmTag(
        db,
        { name: "t1", utmSource: "", destinationUrl: "/giveaway" },
        adminId,
      ),
    ).toThrow("utm_source is required");
  });

  it("rejects utm_source exceeding 128 chars", () => {
    expect(() => makeTag({ utmSource: "x".repeat(129) })).toThrow(
      "utm_source exceeds maximum length of 128 characters",
    );
  });

  it("rejects optional UTM fields exceeding 128 chars", () => {
    expect(() => makeTag({ utmMedium: "x".repeat(129) })).toThrow(
      "UTM field exceeds maximum length of 128 characters",
    );
    expect(() => makeTag({ utmCampaign: "x".repeat(129) })).toThrow(
      "UTM field exceeds maximum length of 128 characters",
    );
    expect(() => makeTag({ utmContent: "x".repeat(129) })).toThrow(
      "UTM field exceeds maximum length of 128 characters",
    );
    expect(() => makeTag({ utmTerm: "x".repeat(129) })).toThrow(
      "UTM field exceeds maximum length of 128 characters",
    );
  });

  it("rejects missing destination URL", () => {
    expect(() =>
      createUtmTag(
        db,
        { name: "t1", utmSource: "reddit", destinationUrl: "" },
        adminId,
      ),
    ).toThrow("Destination URL is required");
  });

  it("rejects destination URL exceeding 2048 chars", () => {
    expect(() => makeTag({ destinationUrl: "/" + "x".repeat(2048) })).toThrow(
      "Destination URL exceeds maximum length of 2048 characters",
    );
  });

  it("rejects destination URLs that are not HTTP(S) absolute or root-relative paths", () => {
    expect(() => makeTag({ destinationUrl: "javascript:alert(1)" })).toThrow(
      "Destination URL must be an HTTP(S) URL or path starting with /",
    );
    expect(() => makeTag({ destinationUrl: "ftp://example.com" })).toThrow(
      "Destination URL must be an HTTP(S) URL or path starting with /",
    );
    expect(() => makeTag({ destinationUrl: "not-a-url" })).toThrow(
      "Destination URL must be an HTTP(S) URL or path starting with /",
    );
  });

  it("accepts both root-relative and absolute HTTP(S) destinations", () => {
    expect(() => makeTag({ name: "rel", destinationUrl: "/giveaway" })).not.toThrow();
    expect(() =>
      makeTag({ name: "abs-http", destinationUrl: "http://example.com/path" }),
    ).not.toThrow();
    expect(() =>
      makeTag({ name: "abs-https", destinationUrl: "https://example.com/path?a=1" }),
    ).not.toThrow();
  });

  it("strips unknown keys from the input", () => {
    const tag = createUtmTag(
      db,
      {
        name: "stripped",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        // @ts-expect-error — deliberately passing an unknown key
        bogus: "hacked",
      },
      adminId,
    );
    expect(tag).toBeTruthy();
    const row = db.prepare("SELECT * FROM utm_tags WHERE id = ?").get(tag.id) as Record<
      string,
      unknown
    >;
    expect(row.bogus).toBeUndefined();
  });

  it("accepts a null adminId (seed / unauthenticated imports)", () => {
    const tag = createUtmTag(
      db,
      { name: "no-admin", utmSource: "reddit", destinationUrl: "/giveaway" },
      null,
    );
    expect(tag.createdBy).toBeNull();
  });
});

// === getUtmTag ===

describe("getUtmTag", () => {
  it("returns a tag by id", () => {
    const created = makeTag({ name: "fetchme" });
    const fetched = getUtmTag(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("fetchme");
  });

  it("returns null for a missing id", () => {
    expect(getUtmTag(db, "non-existent-id")).toBeNull();
  });
});

// === listUtmTags ===

describe("listUtmTags", () => {
  it("returns an empty result when no tags exist", () => {
    const result = listUtmTags(db, {});
    expect(result).toMatchObject({ tags: [], total: 0, page: 1, totalPages: 0 });
  });

  it("returns only active tags by default", () => {
    const active = makeTag({ name: "active-1" });
    const toArchive = makeTag({ name: "archived-1" });
    setUtmTagStatus(db, toArchive.id, "archived");

    const result = listUtmTags(db, {});
    expect(result.total).toBe(1);
    expect(result.tags[0].id).toBe(active.id);
  });

  it("filters by status='archived'", () => {
    makeTag({ name: "a" });
    const archived = makeTag({ name: "b" });
    setUtmTagStatus(db, archived.id, "archived");

    const result = listUtmTags(db, { status: "archived" });
    expect(result.total).toBe(1);
    expect(result.tags[0].id).toBe(archived.id);
  });

  it("returns all tags when status='all'", () => {
    makeTag({ name: "a" });
    const archived = makeTag({ name: "b" });
    setUtmTagStatus(db, archived.id, "archived");

    const result = listUtmTags(db, { status: "all" });
    expect(result.total).toBe(2);
  });

  it("rejects invalid status filter values", () => {
    expect(() => listUtmTags(db, { status: "garbage" })).toThrow("Invalid status filter");
  });

  it("paginates results", () => {
    for (let i = 0; i < 5; i++) makeTag({ name: `p-${i}` });
    const page1 = listUtmTags(db, { page: 1, pageSize: 2 });
    expect(page1.tags).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(3);

    const page3 = listUtmTags(db, { page: 3, pageSize: 2 });
    expect(page3.tags).toHaveLength(1);
  });

  it("clamps page and pageSize to valid ranges", () => {
    makeTag({ name: "p" });
    const result = listUtmTags(db, { page: -1, pageSize: 0 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBeGreaterThanOrEqual(1);

    const big = listUtmTags(db, { pageSize: 9999 });
    expect(big.pageSize).toBeLessThanOrEqual(200);
  });

  it("orders by created_at DESC", () => {
    const first = makeTag({ name: "first" });
    // Force a newer timestamp by updating created_at manually.
    const later = new Date(Date.now() + 1000).toISOString();
    db.prepare("UPDATE utm_tags SET created_at = ? WHERE id = ?").run(later, first.id);

    makeTag({ name: "second" });
    const result = listUtmTags(db, {});
    expect(result.tags[0].id).toBe(first.id);
  });
});

// === updateUtmTag ===

describe("updateUtmTag", () => {
  it("updates mutable fields and bumps updated_at", async () => {
    const tag = makeTag({ name: "before", utmCampaign: "old" });
    // Ensure the timestamp comparison has strictly increased resolution.
    await new Promise((r) => setTimeout(r, 10));
    const updated = updateUtmTag(db, tag.id, {
      name: "after",
      utmCampaign: "new",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("after");
    expect(updated!.utmCampaign).toBe("new");
    expect(updated!.updatedAt > tag.updatedAt).toBe(true);
  });

  it("ignores undefined fields (partial update)", () => {
    const tag = makeTag({ name: "keep-source", utmSource: "reddit" });
    const updated = updateUtmTag(db, tag.id, { utmCampaign: "newcamp" });
    expect(updated!.utmSource).toBe("reddit");
    expect(updated!.utmCampaign).toBe("newcamp");
  });

  it("returns null for a missing id", () => {
    expect(updateUtmTag(db, "missing", { name: "x" })).toBeNull();
  });

  it("rejects a duplicate name on rename", () => {
    makeTag({ name: "one" });
    const two = makeTag({ name: "two" });
    expect(() => updateUtmTag(db, two.id, { name: "one" })).toThrow(
      "A UTM tag with this name already exists",
    );
  });

  it("re-validates utm_source length", () => {
    const tag = makeTag();
    expect(() => updateUtmTag(db, tag.id, { utmSource: "x".repeat(129) })).toThrow(
      "utm_source exceeds maximum length of 128 characters",
    );
  });

  it("clears an optional UTM field when explicitly passed null", () => {
    // Admins need a way to unset a previously-set optional field. Passing
    // `null` (or empty string) on update should normalize to NULL in the DB,
    // while undefined should preserve the existing value.
    const tag = makeTag({
      name: "clearable",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "v1",
    });
    expect(tag.utmMedium).toBe("cpc");

    const cleared = updateUtmTag(db, tag.id, { utmMedium: null });
    expect(cleared).not.toBeNull();
    expect(cleared!.utmMedium).toBeNull();
    // Other fields are untouched.
    expect(cleared!.utmSource).toBe("reddit");
    expect(cleared!.utmCampaign).toBe("v1");
  });

  it("clears an optional UTM field when passed an empty string", () => {
    const tag = makeTag({
      name: "clearable-empty",
      utmSource: "reddit",
      utmCampaign: "v1",
    });
    const cleared = updateUtmTag(db, tag.id, { utmCampaign: "" });
    expect(cleared!.utmCampaign).toBeNull();
  });
});

// === setUtmTagStatus ===

describe("setUtmTagStatus", () => {
  it("archives a tag", () => {
    const tag = makeTag();
    const updated = setUtmTagStatus(db, tag.id, "archived");
    expect(updated!.status).toBe("archived");
  });

  it("unarchives a tag", () => {
    const tag = makeTag();
    setUtmTagStatus(db, tag.id, "archived");
    const updated = setUtmTagStatus(db, tag.id, "active");
    expect(updated!.status).toBe("active");
  });

  it("returns null for a missing id", () => {
    expect(setUtmTagStatus(db, "missing", "archived")).toBeNull();
  });

  it("rejects invalid status values", () => {
    const tag = makeTag();
    // @ts-expect-error — deliberately passing an invalid status
    expect(() => setUtmTagStatus(db, tag.id, "bogus")).toThrow("Invalid status");
  });
});

// === deleteUtmTag ===

describe("deleteUtmTag", () => {
  it("hard-deletes a tag with no matched signups", () => {
    const tag = makeTag({ name: "expendable" });
    expect(deleteUtmTag(db, tag.id)).toBe(true);
    expect(getUtmTag(db, tag.id)).toBeNull();
  });

  it("returns false for a missing id", () => {
    expect(deleteUtmTag(db, "missing")).toBe(false);
  });

  it("refuses to delete a tag whose UTM tuple matches existing users", () => {
    const tag = makeTag({
      name: "matched",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "match",
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "match",
    });
    expect(() => deleteUtmTag(db, tag.id)).toThrow(
      "Cannot delete UTM tag with matched signups",
    );
    // Ensure the tag is still present.
    expect(getUtmTag(db, tag.id)).not.toBeNull();
  });

  it("treats null optional fields as exact-match (NULL only) when checking matches", () => {
    // Tag with only utm_source set; all optional fields null — should match
    // ONLY signups whose optional fields are also NULL (no wildcard bleed
    // into narrower tags that share the same source).
    const tag = makeTag({
      name: "exact-null",
      utmSource: "reddit",
      utmMedium: null,
      utmCampaign: null,
    });
    // utm_medium='cpc' should NOT match a tag with utm_medium=NULL.
    insertUserWithAttribution({ utmSource: "reddit", utmMedium: "cpc" });
    // Allowed: tag has no signups, deletion succeeds.
    expect(deleteUtmTag(db, tag.id)).toBe(true);
  });

  it("blocks delete when a signup's NULL fields exactly match the tag", () => {
    const tag = makeTag({
      name: "exact-null-match",
      utmSource: "reddit",
      utmMedium: null,
      utmCampaign: null,
    });
    insertUserWithAttribution({ utmSource: "reddit" });
    expect(() => deleteUtmTag(db, tag.id)).toThrow(
      "Cannot delete UTM tag with matched signups",
    );
  });
});

// === System-managed origin rows are read-only ===

/**
 * Insert a system-managed utm_tags row (origin_key non-null) bypassing the
 * service layer. Used to verify that update/delete refuse on these rows
 * regardless of who calls them.
 */
function insertSystemTag(originKey: string, destinationUrl: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO utm_tags
      (id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       destination_url, status, created_at, updated_at, created_by, short_code, origin_key)
     VALUES (?, ?, 'email', 'transactional', 'reward_expired', NULL, NULL,
             ?, 'active', ?, ?, NULL, ?, ?)`,
  ).run(id, `[system:${originKey}] ${id.slice(0, 8)}`, destinationUrl, now, now, originKey.slice(0, 6) + "x", originKey);
  return id;
}

describe("system-managed origin rows", () => {
  it("listUtmTags defaults to admin-only (excludes origin_key NOT NULL rows)", () => {
    const adminTag = makeTag({ name: "admin-tag" });
    const systemTagId = insertSystemTag("email:reward_expired", "/");

    const result = listUtmTags(db, {});
    const ids = result.tags.map((t) => t.id);
    expect(ids).toContain(adminTag.id);
    expect(ids).not.toContain(systemTagId);
  });

  it("listUtmTags origin=system shows only system rows", () => {
    makeTag({ name: "admin-tag" });
    const systemTagId = insertSystemTag("email:reward_expired", "/");

    const result = listUtmTags(db, { origin: "system", status: "all" });
    const ids = result.tags.map((t) => t.id);
    expect(ids).toEqual([systemTagId]);
    expect(result.tags[0].originKey).toBe("email:reward_expired");
  });

  it("listUtmTags origin=all shows both admin and system rows", () => {
    const adminTag = makeTag({ name: "admin-tag" });
    const systemTagId = insertSystemTag("email:reward_expired", "/");

    const result = listUtmTags(db, { origin: "all", status: "all" });
    const ids = result.tags.map((t) => t.id);
    expect(ids).toContain(adminTag.id);
    expect(ids).toContain(systemTagId);
  });

  it("listUtmTags rejects invalid origin filter", () => {
    expect(() => listUtmTags(db, { origin: "bogus" })).toThrow(
      "Invalid origin filter",
    );
  });

  it("updateUtmTag refuses on rows with origin_key set", () => {
    const id = insertSystemTag("email:reward_expired", "/");
    expect(() => updateUtmTag(db, id, { name: "renamed" })).toThrow(
      "Cannot update system-managed UTM tag",
    );
  });

  it("deleteUtmTag refuses on rows with origin_key set", () => {
    const id = insertSystemTag("email:reward_expired", "/");
    expect(() => deleteUtmTag(db, id)).toThrow(
      "Cannot delete system-managed UTM tag",
    );
    // Row still exists.
    expect(getUtmTag(db, id)).not.toBeNull();
  });

  it("getUtmTag exposes origin_key on the returned tag", () => {
    const id = insertSystemTag("email:reward_expired", "/");
    const tag = getUtmTag(db, id);
    expect(tag?.originKey).toBe("email:reward_expired");
  });

  it("admin-created tags have null origin_key", () => {
    const tag = makeTag({ name: "admin-created" });
    const fetched = getUtmTag(db, tag.id);
    expect(fetched?.originKey).toBeNull();
  });
});

// === buildTagUrl ===

describe("buildTagUrl", () => {
  const base = "https://pricegames.app";

  it("builds a URL from a root-relative destination with all UTM params", () => {
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "launch",
        utmContent: "variant_a",
        utmTerm: "price",
        destinationUrl: "/giveaway",
      },
      base,
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://pricegames.app");
    expect(parsed.pathname).toBe("/giveaway");
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
    expect(parsed.searchParams.get("utm_medium")).toBe("cpc");
    expect(parsed.searchParams.get("utm_campaign")).toBe("launch");
    expect(parsed.searchParams.get("utm_content")).toBe("variant_a");
    expect(parsed.searchParams.get("utm_term")).toBe("price");
  });

  it("skips null and empty UTM fields", () => {
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: null,
        utmCampaign: "",
        utmContent: null,
        utmTerm: null,
        destinationUrl: "/giveaway",
      },
      base,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
    expect(parsed.searchParams.has("utm_medium")).toBe(false);
    expect(parsed.searchParams.has("utm_campaign")).toBe(false);
    expect(parsed.searchParams.has("utm_content")).toBe(false);
    expect(parsed.searchParams.has("utm_term")).toBe(false);
  });

  it("accepts absolute HTTP(S) destinations and preserves their origin", () => {
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        destinationUrl: "https://partner.example.com/landing",
      },
      base,
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://partner.example.com");
    expect(parsed.pathname).toBe("/landing");
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
  });

  it("preserves existing non-UTM query params on the destination", () => {
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        destinationUrl: "/giveaway?ref=promo",
      },
      base,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("ref")).toBe("promo");
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
  });

  it("encodes special characters in UTM values", () => {
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: null,
        utmCampaign: "hello world & more",
        utmContent: null,
        utmTerm: null,
        destinationUrl: "/giveaway",
      },
      base,
    );
    expect(url).toContain("utm_campaign=hello+world+%26+more");
  });

  it("overwrites pre-existing UTM params on the destination URL", () => {
    // If the destination already carries utm_* params, the tag's values win —
    // admins should not be able to accidentally ship stale attribution by
    // pasting a URL with its own UTM suffix into the destination field.
    const url = buildTagUrl(
      {
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "new-campaign",
        utmContent: null,
        utmTerm: null,
        destinationUrl:
          "/giveaway?utm_source=twitter&utm_medium=organic&utm_campaign=old&ref=promo",
      },
      base,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("reddit");
    expect(parsed.searchParams.get("utm_medium")).toBe("cpc");
    expect(parsed.searchParams.get("utm_campaign")).toBe("new-campaign");
    // Non-UTM params are preserved.
    expect(parsed.searchParams.get("ref")).toBe("promo");
  });
});

// === getUtmTagStats (conversion funnel) ===

describe("getUtmTagStats", () => {
  it("returns null for a missing id", () => {
    expect(getUtmTagStats(db, "nope")).toBeNull();
  });

  it("returns all zeros for a fresh tag with no matching users", () => {
    const tag = makeTag({
      name: "fresh",
      utmSource: "reddit",
      utmCampaign: "nobody",
    });
    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.tagId).toBe(tag.id);
    expect(stats.signups).toBe(0);
    expect(stats.playedFirstGame).toBe(0);
    expect(stats.giveawayEligible).toBe(0);
    expect(stats.wonReward).toBe(0);
    expect(stats.giveawayThreshold).toBeGreaterThan(0);
  });

  it("counts signups matching the tag's UTM tuple", () => {
    const tag = makeTag({
      name: "match",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "launch",
    });
    // Two matching users.
    insertUserWithAttribution({ utmSource: "reddit", utmMedium: "cpc", utmCampaign: "launch" });
    insertUserWithAttribution({ utmSource: "reddit", utmMedium: "cpc", utmCampaign: "launch" });
    // Non-matching users (different campaign, different source).
    insertUserWithAttribution({ utmSource: "reddit", utmMedium: "cpc", utmCampaign: "other" });
    insertUserWithAttribution({ utmSource: "twitter", utmMedium: "cpc", utmCampaign: "launch" });

    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.signups).toBe(2);
  });

  it("treats null optional tag fields as exact NULL match (no wildcard bleed)", () => {
    // The "narrow" tag specifies a medium; the "broad" tag has medium=NULL.
    // Two signups share utm_source=reddit, one with utm_medium=cpc and one
    // with utm_medium=NULL. Each signup must be counted by exactly one tag
    // — no double-counting across overlapping tags.
    const broad = makeTag({
      name: "broad-reddit",
      utmSource: "reddit",
      utmMedium: null,
      utmCampaign: null,
    });
    const narrow = makeTag({
      name: "narrow-reddit-cpc",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: null,
    });
    insertUserWithAttribution({ utmSource: "reddit", utmMedium: "cpc" });
    insertUserWithAttribution({ utmSource: "reddit" }); // medium null
    insertUserWithAttribution({ utmSource: "twitter", utmMedium: "cpc" });

    const broadStats = getUtmTagStats(db, broad.id)!;
    const narrowStats = getUtmTagStats(db, narrow.id)!;
    expect(broadStats.signups).toBe(1);
    expect(narrowStats.signups).toBe(1);
  });

  it("counts users who played at least one game", () => {
    const tag = makeTag({
      name: "played",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "play",
    });
    const u1 = insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "play",
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "play",
    });
    // u1 played two games; should still count as 1 distinct user.
    recordGamePlayed(u1);
    recordGamePlayed(u1);

    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.signups).toBe(2);
    expect(stats.playedFirstGame).toBe(1);
  });

  it("counts users whose lifetime_score meets the giveaway threshold", () => {
    const tag = makeTag({
      name: "gw",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "gw",
    });
    const stats0 = getUtmTagStats(db, tag.id)!;
    const threshold = stats0.giveawayThreshold;

    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "gw",
      lifetimeScore: threshold - 1,
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "gw",
      lifetimeScore: threshold,
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "gw",
      lifetimeScore: threshold + 100,
    });

    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.signups).toBe(3);
    expect(stats.giveawayEligible).toBe(2);
  });

  it("counts users with at least one reward_awards row", () => {
    const tag = makeTag({
      name: "winners",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "winners",
    });
    const u1 = insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "winners",
    });
    const u2 = insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "winners",
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "winners",
    });
    recordRewardAward(u1);
    recordRewardAward(u2);
    // A non-matching user gets a reward too — should not count.
    const other = insertUserWithAttribution({ utmSource: "twitter" });
    recordRewardAward(other);

    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.signups).toBe(3);
    expect(stats.wonReward).toBe(2);
  });

  it("reads the giveaway threshold from site_settings.promo_banner when present", () => {
    // Write a custom promo_banner setting with a known threshold.
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)",
    ).run(
      "promo_banner",
      JSON.stringify({
        enabled: true,
        message: "x",
        giveawayMinPoints: 12345,
      }),
      now,
    );

    const tag = makeTag({ name: "custom-threshold", utmSource: "reddit" });
    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.giveawayThreshold).toBe(12345);
  });

  it("includes clicks=0 and hasShortCode=false for a tag with no short code", () => {
    const tag = makeTag({ name: "no-code" });
    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.clicks).toBe(0);
    expect(stats.hasShortCode).toBe(false);
  });

  it("returns clicks from click_count and hasShortCode=true when a short code is set", () => {
    const tag = makeTag({ name: "clicky", shortCode: "clicky-1" });
    // Seed click_count directly so the test targets only the stats query.
    db.prepare("UPDATE utm_tags SET click_count = 7 WHERE id = ?").run(tag.id);
    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.clicks).toBe(7);
    expect(stats.hasShortCode).toBe(true);
  });

  it("counts unclaimed visitors with a first_game_at as anonymousPlays", () => {
    const tag = makeTag({
      name: "anon-plays",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "anonymize",
    });
    const insertVisitor = (
      visitorId: string,
      opts: {
        firstGameAt?: string | null;
        claimedUserId?: string | null;
        utmMedium?: string | null;
        utmCampaign?: string | null;
      } = {},
    ) => {
      db.prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, utm_medium, utm_campaign,
            first_seen_at, first_game_at, first_game_type, first_game_mode,
            games_played, claimed_user_id, claimed_at)
         VALUES (?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        visitorId,
        opts.utmMedium ?? "cpc",
        opts.utmCampaign ?? "anonymize",
        new Date().toISOString(),
        opts.firstGameAt ?? null,
        opts.firstGameAt ? "single" : null,
        opts.firstGameAt ? "classic" : null,
        opts.firstGameAt ? 1 : 0,
        opts.claimedUserId ?? null,
        opts.claimedUserId ? new Date().toISOString() : null,
      );
    };

    // Should count: two unclaimed visitors who played.
    insertVisitor("v-unclaimed-1", { firstGameAt: new Date().toISOString() });
    insertVisitor("v-unclaimed-2", { firstGameAt: new Date().toISOString() });
    // Should NOT count: unclaimed visitor who never played.
    insertVisitor("v-clickonly");
    // Should NOT count: played but claimed (counted under signups/played instead).
    const claimer = seedUser(db, "claimer", "c@test.local", "password1234");
    insertVisitor("v-claimed", {
      firstGameAt: new Date().toISOString(),
      claimedUserId: claimer,
    });
    // Should NOT count: wrong campaign.
    insertVisitor("v-wrong-campaign", {
      firstGameAt: new Date().toISOString(),
      utmCampaign: "other",
    });

    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.anonymousPlays).toBe(2);
  });

  it("returns anonymousPlays=0 when no visitors match", () => {
    const tag = makeTag({ name: "none", utmSource: "reddit" });
    const stats = getUtmTagStats(db, tag.id)!;
    expect(stats.anonymousPlays).toBe(0);
  });

  it("restricts signups to the trailing window when rangeDays is given", () => {
    // The detail-page upgrade can ask for a 7-day funnel; old signups
    // outside the window must drop out cleanly so the rate metrics aren't
    // dragged down by long-since-converted users.
    const tag = makeTag({
      name: "ranged",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ranged",
    });
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // In window: 1 day ago (inside both 7d and 28d).
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ranged",
      createdAt: new Date(now - 1 * DAY_MS).toISOString(),
    });
    // In window for 28d only: 10 days ago (outside 7d, inside 28d).
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ranged",
      createdAt: new Date(now - 10 * DAY_MS).toISOString(),
    });
    // Out of every window: 100 days ago.
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ranged",
      createdAt: new Date(now - 100 * DAY_MS).toISOString(),
    });

    expect(getUtmTagStats(db, tag.id, { rangeDays: 7, now })!.signups).toBe(1);
    expect(getUtmTagStats(db, tag.id, { rangeDays: 28, now })!.signups).toBe(2);
    expect(getUtmTagStats(db, tag.id, { rangeDays: 90, now })!.signups).toBe(2);
    // Lifetime view is unchanged: still 3.
    expect(getUtmTagStats(db, tag.id)!.signups).toBe(3);
  });

  it("restricts anonymousPlays to the trailing window when rangeDays is given", () => {
    const tag = makeTag({
      name: "ranged-anon",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ranged-anon",
    });
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const insertVisitor = (id: string, firstGameAt: string | null) => {
      db.prepare(
        `INSERT INTO visitor_attribution
           (visitor_id, utm_source, utm_medium, utm_campaign,
            first_seen_at, first_game_at, first_game_type, first_game_mode,
            games_played, claimed_user_id, claimed_at)
         VALUES (?, 'reddit', 'cpc', 'ranged-anon', ?, ?, 'single', 'classic', 1, NULL, NULL)`,
      ).run(id, firstGameAt ?? new Date().toISOString(), firstGameAt);
    };
    insertVisitor("v-recent", new Date(now - 1 * DAY_MS).toISOString());
    insertVisitor("v-mid", new Date(now - 10 * DAY_MS).toISOString());
    insertVisitor("v-old", new Date(now - 100 * DAY_MS).toISOString());

    expect(getUtmTagStats(db, tag.id, { rangeDays: 7, now })!.anonymousPlays).toBe(1);
    expect(getUtmTagStats(db, tag.id, { rangeDays: 28, now })!.anonymousPlays).toBe(2);
    expect(getUtmTagStats(db, tag.id)!.anonymousPlays).toBe(3);
  });

  it("returns lifetime click_count regardless of rangeDays (no per-click time data)", () => {
    // Per the privacy posture in shortLinks.ts, the redirect handler does
    // NOT log per-click events; click_count is an atomic lifetime counter.
    // The range-bound stats endpoint must therefore still return the
    // lifetime value rather than misleadingly returning 0 for a window.
    const tag = makeTag({ name: "click-life", shortCode: "click-life" });
    db.prepare("UPDATE utm_tags SET click_count = 99 WHERE id = ?").run(tag.id);
    expect(getUtmTagStats(db, tag.id, { rangeDays: 7 })!.clicks).toBe(99);
    expect(getUtmTagStats(db, tag.id)!.clicks).toBe(99);
  });
});

// === getUtmTagTimeSeries ===

describe("getUtmTagTimeSeries", () => {
  /** Insert a session row directly. Used to seed analytics_sessions for
   * time-series tests; bypasses the full event ingest path so tests stay
   * focused on the bucketing query. Only sets the columns the time-series
   * query needs to filter on; everything else is left to its column default. */
  function insertSession(opts: {
    visitorId: string;
    startedAt: number;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    isBot?: boolean;
  }) {
    db.prepare(
      `INSERT INTO analytics_sessions
         (id, visitor_id, started_at, last_event_at, device_type,
          is_bot, entry_utm_source, entry_utm_medium, entry_utm_campaign,
          last_utm_source)
       VALUES (?, ?, ?, ?, 'desktop', ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      opts.visitorId,
      opts.startedAt,
      opts.startedAt + 1000,
      opts.isBot ? 1 : 0,
      opts.utmSource ?? null,
      opts.utmMedium ?? null,
      opts.utmCampaign ?? null,
      opts.utmSource ?? null,
    );
  }

  it("returns null for a missing id", () => {
    expect(getUtmTagTimeSeries(db, "nope", 7)).toBeNull();
  });

  it("returns rangeDays + 1 zero-filled buckets when no data matches", () => {
    const tag = makeTag({ name: "ts-empty" });
    const now = Date.parse("2026-05-04T12:00:00Z");
    const points = getUtmTagTimeSeries(db, tag.id, 7, now)!;
    // enumerateDaysInRange is inclusive on both ends, so a 7-day window
    // typically yields 8 days. We don't pin the exact length (DST may
    // produce 7 or 8) but every day has zero counts.
    expect(points.length).toBeGreaterThanOrEqual(7);
    expect(points.every((p) => p.sessions === 0 && p.signups === 0 && p.anonymousPlays === 0)).toBe(true);
    // Dates strictly ascending.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].date > points[i - 1].date).toBe(true);
    }
  });

  it("buckets sessions, signups, and anon plays into the correct days", () => {
    const tag = makeTag({
      name: "ts-buckets",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
    });
    const now = Date.parse("2026-05-04T19:00:00Z");
    const DAY = 24 * 60 * 60 * 1000;

    // Sessions: 2 yesterday, 1 today.
    insertSession({
      visitorId: "v-s1",
      startedAt: now - 1 * DAY,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
    });
    insertSession({
      visitorId: "v-s2",
      startedAt: now - 1 * DAY + 60_000,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
    });
    insertSession({
      visitorId: "v-s3",
      startedAt: now,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
    });
    // A bot session in the cohort — must be excluded.
    insertSession({
      visitorId: "v-bot",
      startedAt: now,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
      isBot: true,
    });
    // A non-matching session (different campaign).
    insertSession({
      visitorId: "v-other",
      startedAt: now,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "other",
    });

    // Signups: 1 yesterday, 1 today.
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
      createdAt: new Date(now - 1 * DAY).toISOString(),
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "ts",
      createdAt: new Date(now).toISOString(),
    });

    // Anon play: 1 yesterday.
    db.prepare(
      `INSERT INTO visitor_attribution
         (visitor_id, utm_source, utm_medium, utm_campaign,
          first_seen_at, first_game_at, first_game_type, first_game_mode,
          games_played, claimed_user_id, claimed_at)
       VALUES (?, 'reddit', 'cpc', 'ts', ?, ?, 'single', 'classic', 1, NULL, NULL)`,
    ).run(
      "v-anon-1",
      new Date(now - 1 * DAY).toISOString(),
      new Date(now - 1 * DAY).toISOString(),
    );

    const points = getUtmTagTimeSeries(db, tag.id, 7, now)!;
    const totals = points.reduce(
      (acc, p) => ({
        sessions: acc.sessions + p.sessions,
        signups: acc.signups + p.signups,
        anon: acc.anon + p.anonymousPlays,
      }),
      { sessions: 0, signups: 0, anon: 0 },
    );
    expect(totals.sessions).toBe(3); // 2 + 1, bot excluded, sibling excluded
    expect(totals.signups).toBe(2);
    expect(totals.anon).toBe(1);
  });

  it("excludes data outside the trailing window", () => {
    const tag = makeTag({
      name: "ts-window",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "win",
    });
    const now = Date.parse("2026-05-04T19:00:00Z");
    const DAY = 24 * 60 * 60 * 1000;
    // Inside the 7-day window.
    insertSession({
      visitorId: "v-recent",
      startedAt: now - 2 * DAY,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "win",
    });
    // Outside the 7-day window (10 days back).
    insertSession({
      visitorId: "v-old",
      startedAt: now - 10 * DAY,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "win",
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "win",
      createdAt: new Date(now - 100 * DAY).toISOString(),
    });

    const points = getUtmTagTimeSeries(db, tag.id, 7, now)!;
    const totalSessions = points.reduce((s, p) => s + p.sessions, 0);
    const totalSignups = points.reduce((s, p) => s + p.signups, 0);
    expect(totalSessions).toBe(1);
    expect(totalSignups).toBe(0);
  });

  it("isolates exact-tuple cohorts between sibling tags", () => {
    // The broad-tag-no-bleed regression: a 'reddit'-only tag's time series
    // must NOT include sessions whose entry has a more specific tuple.
    const broad = makeTag({
      name: "broad-ts",
      utmSource: "reddit",
      utmMedium: null,
      utmCampaign: null,
    });
    const narrow = makeTag({
      name: "narrow-ts",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
    });
    const now = Date.parse("2026-05-04T19:00:00Z");
    insertSession({
      visitorId: "v-narrow",
      startedAt: now,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
    });

    const broadPts = getUtmTagTimeSeries(db, broad.id, 7, now)!;
    const narrowPts = getUtmTagTimeSeries(db, narrow.id, 7, now)!;
    expect(broadPts.reduce((s, p) => s + p.sessions, 0)).toBe(0);
    expect(narrowPts.reduce((s, p) => s + p.sessions, 0)).toBe(1);
  });
});

// === getUtmTagComparison (cross-tag leaderboard) ===

describe("getUtmTagComparison", () => {
  /** Insert a session row directly (mirror of the timeseries helper). */
  function insertSession(opts: {
    visitorId: string;
    startedAt: number;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    isBot?: boolean;
    signupOccurred?: boolean;
  }) {
    db.prepare(
      `INSERT INTO analytics_sessions
         (id, visitor_id, started_at, last_event_at, device_type,
          is_bot, signup_occurred,
          entry_utm_source, entry_utm_medium, entry_utm_campaign,
          last_utm_source)
       VALUES (?, ?, ?, ?, 'desktop', ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      opts.visitorId,
      opts.startedAt,
      opts.startedAt + 1000,
      opts.isBot ? 1 : 0,
      opts.signupOccurred ? 1 : 0,
      opts.utmSource ?? null,
      opts.utmMedium ?? null,
      opts.utmCampaign ?? null,
      opts.utmSource ?? null,
    );
  }

  it("returns an empty leaderboard with zero summary when no tags exist", () => {
    const out = getUtmTagComparison(db, { rangeDays: 7 });
    expect(out.rows).toHaveLength(0);
    expect(out.summary.activeTagCount).toBe(0);
    expect(out.summary.totalSessions).toBe(0);
    expect(out.summary.totalSignups).toBe(0);
    expect(out.summary.globalConversionRate).toBe(0);
  });

  it("includes active tags and excludes archived ones from the leaderboard", () => {
    makeTag({ name: "active-1", utmSource: "reddit" });
    const archived = makeTag({ name: "archived-1", utmSource: "tiktok" });
    setUtmTagStatus(db, archived.id, "archived");
    const out = getUtmTagComparison(db, { rangeDays: 7 });
    expect(out.rows.map((r) => r.name)).toEqual(["active-1"]);
  });

  it("respects the origin filter (defaults to admin-only)", () => {
    // Admin tag.
    makeTag({ name: "admin-tag", utmSource: "reddit" });
    // System tag — insert directly with origin_key set.
    db.prepare(
      `INSERT INTO utm_tags
         (id, name, utm_source, destination_url, status, origin_key,
          created_at, updated_at, click_count)
       VALUES (?, ?, 'sys', '/', 'active', ?, ?, ?, 0)`,
    ).run(randomUUID(), "sys-tag", "outbound:email_x", new Date().toISOString(), new Date().toISOString());

    const adminOnly = getUtmTagComparison(db, { rangeDays: 7 });
    expect(adminOnly.rows.map((r) => r.name)).toEqual(["admin-tag"]);

    const systemOnly = getUtmTagComparison(db, { rangeDays: 7, origin: "system" });
    expect(systemOnly.rows.map((r) => r.name)).toEqual(["sys-tag"]);

    const all = getUtmTagComparison(db, { rangeDays: 7, origin: "all" });
    expect(all.rows.map((r) => r.name).sort()).toEqual(["admin-tag", "sys-tag"]);
  });

  it("computes sessions, signups, anon plays per tag with exact-tuple cohort", () => {
    makeTag({ name: "broad", utmSource: "reddit", utmMedium: null, utmCampaign: null });
    makeTag({
      name: "narrow",
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
    });
    const now = Date.now();
    // Two sessions for narrow tag, one signup, one anon play.
    insertSession({
      visitorId: "v1",
      startedAt: now - 1000,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
    });
    insertSession({
      visitorId: "v2",
      startedAt: now - 1000,
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
    });
    insertUserWithAttribution({
      utmSource: "reddit",
      utmMedium: "cpc",
      utmCampaign: "x",
      createdAt: new Date(now - 1000).toISOString(),
    });
    db.prepare(
      `INSERT INTO visitor_attribution
         (visitor_id, utm_source, utm_medium, utm_campaign,
          first_seen_at, first_game_at, first_game_type, first_game_mode,
          games_played, claimed_user_id, claimed_at)
       VALUES (?, 'reddit', 'cpc', 'x', ?, ?, 'single', 'classic', 1, NULL, NULL)`,
    ).run("anon-1", new Date(now - 1000).toISOString(), new Date(now - 1000).toISOString());

    const out = getUtmTagComparison(db, { rangeDays: 7, now });
    const broad = out.rows.find((r) => r.name === "broad")!;
    const narrow = out.rows.find((r) => r.name === "narrow")!;
    // Critical: the broad tag MUST NOT see the narrow tag's traffic.
    expect(broad.sessions).toBe(0);
    expect(broad.signups).toBe(0);
    expect(broad.anonymousPlays).toBe(0);
    expect(narrow.sessions).toBe(2);
    expect(narrow.signups).toBe(1);
    expect(narrow.anonymousPlays).toBe(1);
    expect(narrow.conversionRate).toBeCloseTo(0.5, 6);
    // Wilson interval bounds 0.5 with finite width.
    expect(narrow.ciLow).toBeGreaterThan(0);
    expect(narrow.ciHigh).toBeLessThan(1);
    expect(narrow.ciLow).toBeLessThan(narrow.ciHigh);
  });

  it("flags low-sample rows and suppresses significance flags for them", () => {
    makeTag({ name: "small", utmSource: "twitter", utmMedium: "cpc", utmCampaign: "tiny" });
    const now = Date.now();
    // 1 session, 1 signup → CR=100% but n=1 (way below LOW_SAMPLE_SESSION_THRESHOLD=30).
    insertSession({
      visitorId: "v1",
      startedAt: now - 1000,
      utmSource: "twitter",
      utmMedium: "cpc",
      utmCampaign: "tiny",
    });
    insertUserWithAttribution({
      utmSource: "twitter",
      utmMedium: "cpc",
      utmCampaign: "tiny",
      createdAt: new Date(now - 1000).toISOString(),
    });

    const out = getUtmTagComparison(db, { rangeDays: 7, now });
    const row = out.rows.find((r) => r.name === "small")!;
    expect(row.isLowSample).toBe(true);
    expect(row.isSignificantlyAboveAverage).toBe(false);
    expect(row.isSignificantlyBelowAverage).toBe(false);
  });

  it("ranks by Wilson lower bound descending", () => {
    makeTag({ name: "high-cr", utmSource: "fb", utmMedium: "cpc", utmCampaign: "h" });
    makeTag({ name: "low-cr", utmSource: "fb", utmMedium: "cpc", utmCampaign: "l" });
    const now = Date.now();
    // High-CR: 60 signups in 100 sessions (60%).
    for (let i = 0; i < 100; i++) {
      insertSession({
        visitorId: `v-h-${i}`,
        startedAt: now - 1000,
        utmSource: "fb",
        utmMedium: "cpc",
        utmCampaign: "h",
      });
    }
    for (let i = 0; i < 60; i++) {
      insertUserWithAttribution({
        utmSource: "fb",
        utmMedium: "cpc",
        utmCampaign: "h",
        createdAt: new Date(now - 1000).toISOString(),
      });
    }
    // Low-CR: 5 signups in 100 sessions (5%).
    for (let i = 0; i < 100; i++) {
      insertSession({
        visitorId: `v-l-${i}`,
        startedAt: now - 1000,
        utmSource: "fb",
        utmMedium: "cpc",
        utmCampaign: "l",
      });
    }
    for (let i = 0; i < 5; i++) {
      insertUserWithAttribution({
        utmSource: "fb",
        utmMedium: "cpc",
        utmCampaign: "l",
        createdAt: new Date(now - 1000).toISOString(),
      });
    }
    const out = getUtmTagComparison(db, { rangeDays: 7, now });
    expect(out.rows.map((r) => r.name)).toEqual(["high-cr", "low-cr"]);
    expect(out.rows[0].ciLow).toBeGreaterThan(out.rows[1].ciHigh);
    // Significance flag should fire (intervals don't overlap).
    expect(out.rows[0].isSignificantlyAboveAverage).toBe(true);
    expect(out.rows[1].isSignificantlyBelowAverage).toBe(true);
  });

  it("populates a 7-day sparkline with daily signup counts", () => {
    makeTag({
      name: "sparked",
      utmSource: "yt",
      utmMedium: "video",
      utmCampaign: "spark",
    });
    const now = Date.parse("2026-05-04T19:00:00Z");
    const DAY = 24 * 60 * 60 * 1000;
    // Two signups today, one signup 3 days ago.
    insertUserWithAttribution({
      utmSource: "yt",
      utmMedium: "video",
      utmCampaign: "spark",
      createdAt: new Date(now).toISOString(),
    });
    insertUserWithAttribution({
      utmSource: "yt",
      utmMedium: "video",
      utmCampaign: "spark",
      createdAt: new Date(now - 1000).toISOString(),
    });
    insertUserWithAttribution({
      utmSource: "yt",
      utmMedium: "video",
      utmCampaign: "spark",
      createdAt: new Date(now - 3 * DAY).toISOString(),
    });

    const out = getUtmTagComparison(db, { rangeDays: 7, now });
    const row = out.rows.find((r) => r.name === "sparked")!;
    expect(row.sparkline).toHaveLength(7);
    // Sum should equal the in-window signups (3).
    expect(row.sparkline.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it("computes the global summary across the cohort, not just leaderboard tags", () => {
    // Untagged session traffic must not affect the summary, but signups
    // attributed to ANY tag (including ones not in the active leaderboard)
    // count toward the global pool. We assert the basic invariants.
    makeTag({ name: "only", utmSource: "ads", utmMedium: "cpc", utmCampaign: "abc" });
    const now = Date.now();
    insertSession({
      visitorId: "v1",
      startedAt: now - 1000,
      utmSource: "ads",
      utmMedium: "cpc",
      utmCampaign: "abc",
    });
    insertUserWithAttribution({
      utmSource: "ads",
      utmMedium: "cpc",
      utmCampaign: "abc",
      createdAt: new Date(now - 1000).toISOString(),
    });

    const out = getUtmTagComparison(db, { rangeDays: 7, now });
    expect(out.summary.totalSessions).toBe(1);
    expect(out.summary.totalSignups).toBe(1);
    expect(out.summary.globalConversionRate).toBeCloseTo(1, 6);
    expect(out.summary.activeTagCount).toBe(1);
    expect(out.summary.rangeDays).toBe(7);
  });
});

// === Short code validation + CRUD ===

describe("createUtmTag with shortCode", () => {
  it("persists a valid short code", () => {
    const tag = makeTag({ name: "sc-1", shortCode: "reddit-gw1" });
    expect(tag.shortCode).toBe("reddit-gw1");
    expect(tag.clickCount).toBe(0);
    expect(tag.lastClickedAt).toBeNull();
  });

  it("treats an undefined short code as null", () => {
    const tag = makeTag({ name: "sc-undef" });
    expect(tag.shortCode).toBeNull();
  });

  it("normalizes empty-string short code to null", () => {
    const tag = makeTag({ name: "sc-empty", shortCode: "" });
    expect(tag.shortCode).toBeNull();
  });

  it("normalizes whitespace-only short code to null", () => {
    const tag = makeTag({ name: "sc-ws", shortCode: "   " });
    expect(tag.shortCode).toBeNull();
  });

  it("trims and lowercases the short code", () => {
    const tag = makeTag({ name: "sc-trim", shortCode: "  MiXeD-CaSe-1  " });
    expect(tag.shortCode).toBe("mixed-case-1");
  });

  it("rejects short codes shorter than 3 chars", () => {
    expect(() => makeTag({ name: "too-short", shortCode: "ab" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects short codes longer than 32 chars", () => {
    expect(() => makeTag({ name: "too-long", shortCode: "a".repeat(33) })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects short codes with a leading hyphen", () => {
    expect(() => makeTag({ name: "lead-hyphen", shortCode: "-abc" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects short codes with a trailing hyphen", () => {
    expect(() => makeTag({ name: "trail-hyphen", shortCode: "abc-" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects short codes with spaces", () => {
    expect(() => makeTag({ name: "space", shortCode: "ab cd" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects short codes with special characters", () => {
    expect(() => makeTag({ name: "special", shortCode: "abc_def" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
    expect(() => makeTag({ name: "special-2", shortCode: "abc.def" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
    expect(() => makeTag({ name: "special-3", shortCode: "abc/def" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("rejects a duplicate non-null short code with a stable error message", () => {
    makeTag({ name: "first", shortCode: "dup-code" });
    expect(() => makeTag({ name: "second", shortCode: "dup-code" })).toThrow(
      "A UTM tag with this short code already exists",
    );
  });

  it("allows multiple tags with null short codes (the common case)", () => {
    expect(() => makeTag({ name: "null-a" })).not.toThrow();
    expect(() => makeTag({ name: "null-b" })).not.toThrow();
    expect(() => makeTag({ name: "null-c" })).not.toThrow();
  });
});

describe("updateUtmTag with shortCode", () => {
  it("sets a short code on a tag that did not have one", () => {
    const tag = makeTag({ name: "u-set" });
    expect(tag.shortCode).toBeNull();
    const updated = updateUtmTag(db, tag.id, { shortCode: "set-it" });
    expect(updated!.shortCode).toBe("set-it");
  });

  it("changes an existing short code", () => {
    const tag = makeTag({ name: "u-change", shortCode: "old-code" });
    const updated = updateUtmTag(db, tag.id, { shortCode: "new-code" });
    expect(updated!.shortCode).toBe("new-code");
  });

  it("clears a short code when passed null", () => {
    const tag = makeTag({ name: "u-clear-null", shortCode: "clr-1" });
    const updated = updateUtmTag(db, tag.id, { shortCode: null });
    expect(updated!.shortCode).toBeNull();
  });

  it("clears a short code when passed an empty string", () => {
    const tag = makeTag({ name: "u-clear-empty", shortCode: "clr-2" });
    const updated = updateUtmTag(db, tag.id, { shortCode: "" });
    expect(updated!.shortCode).toBeNull();
  });

  it("leaves the short code unchanged when the field is undefined", () => {
    const tag = makeTag({ name: "u-keep", shortCode: "keep-it" });
    const updated = updateUtmTag(db, tag.id, { utmCampaign: "new" });
    expect(updated!.shortCode).toBe("keep-it");
  });

  it("rejects an update that would collide with another tag's short code", () => {
    makeTag({ name: "u-collide-a", shortCode: "taken" });
    const b = makeTag({ name: "u-collide-b", shortCode: "free" });
    expect(() => updateUtmTag(db, b.id, { shortCode: "taken" })).toThrow(
      "A UTM tag with this short code already exists",
    );
  });

  it("allows an update that re-sets the same short code on the same row", () => {
    const tag = makeTag({ name: "u-same", shortCode: "samey" });
    const updated = updateUtmTag(db, tag.id, { shortCode: "samey" });
    expect(updated!.shortCode).toBe("samey");
  });

  it("re-validates short code format on update", () => {
    const tag = makeTag({ name: "u-reject" });
    expect(() => updateUtmTag(db, tag.id, { shortCode: "BAD CODE" })).toThrow(
      /Short code must be 3-32 lowercase letters, digits, or hyphens/,
    );
  });

  it("does not reset click_count when updating other fields", () => {
    const tag = makeTag({ name: "u-keep-clicks", shortCode: "keep-clicks" });
    db.prepare("UPDATE utm_tags SET click_count = 42 WHERE id = ?").run(tag.id);
    updateUtmTag(db, tag.id, { utmCampaign: "changed" });
    const row = db
      .prepare("SELECT click_count FROM utm_tags WHERE id = ?")
      .get(tag.id) as { click_count: number };
    expect(row.click_count).toBe(42);
  });
});

// === recordShortCodeClick ===

describe("recordShortCodeClick", () => {
  it("increments click_count and sets last_clicked_at on a matching tag", () => {
    const tag = makeTag({ name: "click-1", shortCode: "click-1" });
    const beforeTs = Date.now();
    const updated = recordShortCodeClick(db, "click-1");
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(tag.id);
    expect(updated!.clickCount).toBe(1);
    expect(updated!.lastClickedAt).toBeTruthy();
    const ts = new Date(updated!.lastClickedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(beforeTs - 100);
  });

  it("increments exactly once per call across multiple clicks", () => {
    makeTag({ name: "click-n", shortCode: "click-n" });
    for (let i = 0; i < 5; i++) recordShortCodeClick(db, "click-n");
    const row = db
      .prepare("SELECT click_count FROM utm_tags WHERE short_code = ?")
      .get("click-n") as { click_count: number };
    expect(row.click_count).toBe(5);
  });

  it("returns null for an unknown code", () => {
    expect(recordShortCodeClick(db, "nope-not-there")).toBeNull();
  });

  it("does not match tags with a null short_code", () => {
    makeTag({ name: "no-sc" }); // no short code
    // Querying with empty-ish value must not match the null row.
    expect(recordShortCodeClick(db, "")).toBeNull();
  });

  it("still records clicks on archived tags (old printed URLs must keep working)", () => {
    const tag = makeTag({ name: "archived", shortCode: "arch-1" });
    setUtmTagStatus(db, tag.id, "archived");
    const updated = recordShortCodeClick(db, "arch-1");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("archived");
    expect(updated!.clickCount).toBe(1);
  });

  it("is case-insensitive by matching after lowercasing the provided code", () => {
    makeTag({ name: "case", shortCode: "lower-only" });
    // The redirect handler normalizes to lowercase — the service expects a
    // lowercased input. A mixed-case lookup must not match.
    expect(recordShortCodeClick(db, "LOWER-ONLY")).toBeNull();
  });
});

// === generateShortCodeSuggestion ===

describe("generateShortCodeSuggestion", () => {
  it("returns a string matching the short-code character rules", () => {
    const code = generateShortCodeSuggestion(db);
    expect(code).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(code.length).toBeGreaterThanOrEqual(3);
    expect(code.length).toBeLessThanOrEqual(32);
  });

  it("does not return a code that already exists in the DB", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const tag = makeTag({ name: `seed-${i}`, shortCode: `seed-${i}abc` });
      existing.add(tag.shortCode!);
    }
    for (let i = 0; i < 20; i++) {
      const code = generateShortCodeSuggestion(db);
      expect(existing.has(code)).toBe(false);
    }
  });
});

// === buildShortUrl ===

describe("buildShortUrl", () => {
  it("returns null when the tag has no short code", () => {
    expect(
      buildShortUrl({ shortCode: null }, "https://pricegames.app"),
    ).toBeNull();
  });

  it("builds a /go/:code URL from the base", () => {
    expect(
      buildShortUrl({ shortCode: "abc-123" }, "https://pricegames.app"),
    ).toBe("https://pricegames.app/go/abc-123");
  });

  it("strips a trailing slash on the base URL", () => {
    expect(
      buildShortUrl({ shortCode: "abc" }, "https://pricegames.app/"),
    ).toBe("https://pricegames.app/go/abc");
  });
});

// Silence unused-helper warnings when a test is commented out.
void seedUser;
