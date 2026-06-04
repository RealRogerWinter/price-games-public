import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { recordEvent, linkVisitorToUser } from "./eventLog";
import { exportGdprData, forgetGdprData, getLinkedVisitorIds } from "./gdpr";
import { __resetBotVelocity } from "./botDetection";
import { ANALYTICS_EVENTS } from "@price-game/shared";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

const VID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UA = "Mozilla/5.0 Chrome/120";

function seedUser(id: string): void {
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'h', datetime('now'), datetime('now'))`,
  ).run(id, id, id, `${id}@example.com`);
}

describe("getLinkedVisitorIds", () => {
  it("returns visitor_ids merged via aliases AND via direct user_id", () => {
    seedUser("u1");
    linkVisitorToUser(VID_A, "u1", db);
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID_B, userId: "u1", userAgent: UA, path: "/" },
      db,
    );
    const ids = getLinkedVisitorIds(db, "u1");
    expect(ids.sort()).toEqual([VID_A, VID_B].sort());
  });
});

describe("exportGdprData", () => {
  it("includes events and sessions for all linked visitors", () => {
    seedUser("u1");
    linkVisitorToUser(VID_A, "u1", db);
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID_A, userAgent: UA, path: "/" },
      db,
    );
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: VID_B, userId: "u1", userAgent: UA, path: "/classic" },
      db,
    );
    const exp = exportGdprData(db, "u1");
    expect(exp.userId).toBe("u1");
    expect(exp.visitors.sort()).toEqual([VID_A, VID_B].sort());
    expect(exp.events.length).toBe(2);
    expect(exp.sessions.length).toBe(2);
  });

  it("returns empty arrays when user has no data", () => {
    seedUser("u-empty");
    const exp = exportGdprData(db, "u-empty");
    expect(exp.events).toEqual([]);
    expect(exp.sessions).toEqual([]);
  });
});

describe("forgetGdprData", () => {
  it("deletes events, sessions, profile, and aliases", () => {
    seedUser("u1");
    linkVisitorToUser(VID_A, "u1", db);
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID_A, userId: "u1", userAgent: UA, path: "/" },
      db,
    );
    const before = (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);

    const counts = forgetGdprData(db, "u1");
    expect(counts.events).toBeGreaterThan(0);
    expect(counts.aliases).toBe(1);

    expect((db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM analytics_sessions").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM visitor_profile").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM visitor_aliases").get() as { n: number }).n,
    ).toBe(0);
  });

  it("deletes rows for a user who has events but no visitor_aliases entry", () => {
    // A user can have events attributed via user_id without any alias row
    // (e.g. server-side hook fired before linkVisitorToUser). Confirm the
    // cascade still catches these rows.
    seedUser("u-noalias");
    recordEvent(
      { eventName: ANALYTICS_EVENTS.USER_LOGGED_IN, visitorId: VID_A, userId: "u-noalias", userAgent: UA, path: "/login" },
      db,
    );
    db.prepare("DELETE FROM visitor_aliases WHERE user_id = ?").run("u-noalias");

    const counts = forgetGdprData(db, "u-noalias");
    expect(counts.events).toBeGreaterThan(0);
    expect(
      (db
        .prepare("SELECT COUNT(*) as n FROM events WHERE user_id = ?")
        .get("u-noalias") as { n: number }).n,
    ).toBe(0);
  });

  it("leaves other users' data intact", () => {
    seedUser("u1");
    seedUser("u2");
    linkVisitorToUser(VID_A, "u1", db);
    linkVisitorToUser(VID_B, "u2", db);
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID_A, userId: "u1", userAgent: UA, path: "/" },
      db,
    );
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID_B, userId: "u2", userAgent: UA, path: "/" },
      db,
    );
    forgetGdprData(db, "u1");
    // u2 still has events/sessions/alias
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM events WHERE user_id = 'u2'").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM visitor_aliases WHERE user_id = 'u2'").get() as { n: number }).n,
    ).toBe(1);
  });
});
