import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { recordEvent } from "./eventLog";
import {
  closeoutStaleSessions,
  purgeOldEvents,
} from "./sessionCloseout";
import { __resetBotVelocity } from "./botDetection";
import { ANALYTICS_EVENTS } from "@price-game/shared";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

const VID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UA = "Mozilla/5.0 Chrome/120";

describe("closeoutStaleSessions", () => {
  it("closes a session idle longer than 30min", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    const closed = closeoutStaleSessions(1_000_000 + 31 * 60 * 1000, db);
    expect(closed).toBe(1);
    const row = db
      .prepare("SELECT ended_at, bounced FROM analytics_sessions LIMIT 1")
      .get() as { ended_at: number; bounced: number };
    expect(row.ended_at).toBe(1_000_000);
    expect(row.bounced).toBe(1); // single page view, no game, counts as bounced
  });

  it("leaves a recent session open", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    const closed = closeoutStaleSessions(1_000_000 + 10 * 60 * 1000, db);
    expect(closed).toBe(0);
    const row = db
      .prepare("SELECT ended_at FROM analytics_sessions LIMIT 1")
      .get() as { ended_at: number | null };
    expect(row.ended_at).toBeNull();
  });

  it("applies 4h active-game idle for visitors who have played", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: VID, userAgent: UA, path: "/classic", nowMs: 1_000_000 },
      db,
    );
    // 45 min later — expired per 30-min idle, but should stay open per 4h active.
    const closed = closeoutStaleSessions(1_000_000 + 45 * 60 * 1000, db);
    expect(closed).toBe(0);
  });

  it("forces closeout past the 4h absolute cap even if still active", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: VID, userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    // 4h 10min absolute — exceeds cap, should force-close.
    const closed = closeoutStaleSessions(1_000_000 + 4 * 60 * 60 * 1000 + 10 * 60 * 1000, db);
    expect(closed).toBe(1);
  });

  it("does NOT flag as bounced if games_started > 0", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: VID, userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    closeoutStaleSessions(1_000_000 + 5 * 60 * 60 * 1000, db);
    const row = db
      .prepare("SELECT bounced FROM analytics_sessions LIMIT 1")
      .get() as { bounced: number };
    expect(row.bounced).toBe(0);
  });

  it("mirrors last_session_bounced onto the visitor_profile", () => {
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    closeoutStaleSessions(1_000_000 + 31 * 60 * 1000, db);
    const profile = db
      .prepare("SELECT last_session_bounced, current_session_id FROM visitor_profile LIMIT 1")
      .get() as { last_session_bounced: number; current_session_id: string | null };
    expect(profile.last_session_bounced).toBe(1);
    expect(profile.current_session_id).toBeNull();
  });

  it("bumps users.total_sessions when a logged-in session closes", () => {
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at)
       VALUES ('u1', 'u1', 'u1', 'u1@x.com', 'h', datetime('now'), datetime('now'))`,
    ).run();
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userId: "u1", userAgent: UA, path: "/", nowMs: 1_000_000 },
      db,
    );
    closeoutStaleSessions(1_000_000 + 31 * 60 * 1000, db);
    const u = db.prepare("SELECT total_sessions, last_session_at FROM users WHERE id = 'u1'").get() as {
      total_sessions: number;
      last_session_at: number;
    };
    expect(u.total_sessions).toBe(1);
    expect(u.last_session_at).toBe(1_000_000);
  });
});

describe("purgeOldEvents", () => {
  it("removes events older than the retention window", () => {
    // Old event (100 days ago, default retention 90)
    const tooOld = Date.now() - 100 * 24 * 60 * 60 * 1000;
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userAgent: UA, path: "/", nowMs: tooOld },
      db,
    );
    // Recent event
    recordEvent(
      { eventName: ANALYTICS_EVENTS.PAGE_VIEWED, visitorId: VID, userAgent: UA, path: "/", nowMs: Date.now() },
      db,
    );
    const deleted = purgeOldEvents(Date.now(), db);
    expect(deleted).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n,
    ).toBe(1);
  });
});
