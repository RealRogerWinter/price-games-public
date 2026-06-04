import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import {
  recordEvent,
  linkVisitorToUser,
  scrubUrl,
  classifyAcquisition,
} from "./eventLog";
import { __resetBotVelocity } from "./botDetection";
import { ANALYTICS_EVENTS } from "@price-game/shared";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

const VID_A = "11111111-1111-1111-1111-111111111111";
const VID_B = "22222222-2222-2222-2222-222222222222";
const UA_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0";
const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function rowCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
}

describe("recordEvent — basic ingest", () => {
  it("writes an event row and creates a session on first call", () => {
    const sid = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    expect(sid).toBeTruthy();
    expect(rowCount("events")).toBe(1);
    expect(rowCount("analytics_sessions")).toBe(1);
    expect(rowCount("visitor_profile")).toBe(1);
  });

  it("reuses the same session for events within the idle window", () => {
    const s1 = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        nowMs: 1_000_000,
      },
      db,
    );
    const s2 = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        nowMs: 1_000_000 + 5 * 60 * 1000, // +5 min, within idle window
      },
      db,
    );
    expect(s1).toBe(s2);
    expect(rowCount("events")).toBe(2);
    expect(rowCount("analytics_sessions")).toBe(1);
  });

  it("mints a new session after 30 min idle", () => {
    const s1 = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        nowMs: 1_000_000,
      },
      db,
    );
    const s2 = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        nowMs: 1_000_000 + 31 * 60 * 1000, // > 30 min
      },
      db,
    );
    expect(s1).not.toBe(s2);
    expect(rowCount("analytics_sessions")).toBe(2);
  });

  it("applies 4h active-game idle extension once a game has been played", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_STARTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        nowMs: 1_000_000,
      },
      db,
    );
    // 45 minutes later — past 30min idle, but within 4h active-game window.
    const s2 = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_ROUND_SUBMITTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        nowMs: 1_000_000 + 45 * 60 * 1000,
      },
      db,
    );
    const profile = db
      .prepare("SELECT current_session_id FROM visitor_profile WHERE visitor_id = ?")
      .get(VID_A) as { current_session_id: string };
    expect(profile.current_session_id).toBe(s2);
    expect(rowCount("analytics_sessions")).toBe(1);
  });

  it("hashes IP and never stores raw IP in the row", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        ip: "1.2.3.4",
      },
      db,
    );
    const row = db
      .prepare("SELECT ip_hash FROM events LIMIT 1")
      .get() as { ip_hash: string };
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash).not.toContain("1.2.3.4");
  });

  it("stores minimal row and skips UA / geo / properties when dnt is set", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        ip: "1.2.3.4",
        path: "/?ref=test",
        properties: { foo: "bar" },
        dnt: true,
      },
      db,
    );
    const row = db.prepare("SELECT * FROM events LIMIT 1").get() as Record<string, unknown>;
    expect(row.dnt).toBe(1);
    expect(row.properties).toBeNull();
    expect(row.ip_hash).toBeNull();
    expect(row.browser).toBeNull();
    expect(row.ua_hash).toBeNull();
  });

  // PR 6.1 — DNT preference is sticky on visitor_profile so server-emitted
  // events fired without request context (mpRoundEnd round timer, etc.)
  // still honor a visitor's previously-observed DNT/GPC opt-out.
  it("persists DNT preference on visitor_profile for later sticky lookup", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        dnt: true,
      },
      db,
    );
    const profile = db
      .prepare("SELECT dnt FROM visitor_profile WHERE visitor_id = ?")
      .get(VID_A) as { dnt: number | null };
    expect(profile.dnt).toBe(1);
  });

  it("falls back to visitor_profile.dnt when input.dnt is omitted (sticky honor)", () => {
    // First event: explicit DNT=true persists the preference.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        ip: "1.2.3.4",
        path: "/",
        dnt: true,
      },
      db,
    );
    // Second event: NO dnt field (server-side emit). Should still scrub.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        ip: "1.2.3.4",
        properties: { score: 9000 },
      },
      db,
    );
    const row = db
      .prepare(
        "SELECT dnt, properties, ip_hash, browser FROM events WHERE event_name = ?",
      )
      .get(ANALYTICS_EVENTS.MP_GAME_COMPLETED) as Record<string, unknown>;
    expect(row.dnt).toBe(1);
    expect(row.properties).toBeNull();
    expect(row.ip_hash).toBeNull();
    expect(row.browser).toBeNull();
  });

  it("does not scrub when visitor_profile.dnt is null (no prior opt-out)", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        ip: "1.2.3.4",
        properties: { score: 9000 },
      },
      db,
    );
    const row = db
      .prepare("SELECT dnt, properties, ip_hash FROM events LIMIT 1")
      .get() as Record<string, unknown>;
    expect(row.dnt).toBe(0);
    expect(row.properties).not.toBeNull();
    expect(row.ip_hash).not.toBeNull();
  });

  it("dedupes retried beacon with the same client_event_id", () => {
    const payload = {
      eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
      visitorId: VID_A,
      userAgent: UA_CHROME,
      path: "/",
      clientEventId: "dedupe-uuid-1",
    };
    recordEvent(payload, db);
    recordEvent(payload, db);
    expect(rowCount("events")).toBe(1);
  });

  it("flags bot UA and never inflates is_bot on the profile", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_BOT,
        path: "/",
      },
      db,
    );
    const row = db.prepare("SELECT is_bot FROM events LIMIT 1").get() as { is_bot: number };
    expect(row.is_bot).toBe(1);
    const profile = db
      .prepare("SELECT is_bot FROM visitor_profile WHERE visitor_id = ?")
      .get(VID_A) as { is_bot: number };
    expect(profile.is_bot).toBe(1);
  });

  it("tracks games_started on the session and profile counters", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_STARTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        gameMode: "classic",
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        gameMode: "classic",
      },
      db,
    );
    const sess = db
      .prepare("SELECT games_started, games_completed FROM analytics_sessions LIMIT 1")
      .get() as { games_started: number; games_completed: number };
    expect(sess.games_started).toBe(1);
    expect(sess.games_completed).toBe(1);
    const profile = db
      .prepare(
        "SELECT total_games_started, total_games_completed, ever_played FROM visitor_profile LIMIT 1",
      )
      .get() as { total_games_started: number; total_games_completed: number; ever_played: number };
    expect(profile.total_games_started).toBe(1);
    expect(profile.total_games_completed).toBe(1);
    expect(profile.ever_played).toBe(1);
  });

  it("treats MP_GAME_STARTED + MP_GAME_COMPLETED as start/complete events for rollup", () => {
    // Multiplayer feeds the SAME session/profile counters as single-player so
    // v2's analytics_hourly games_started / games_completed metrics include
    // multiplayer activity. Without this, MP completions silently fail to
    // bump the rollup and v2 reports a fraction of true gameplay.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.MP_GAME_STARTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/ROOM",
        gameMode: "classic",
        mpRoomCode: "ROOM",
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/ROOM",
        gameMode: "classic",
        mpRoomCode: "ROOM",
      },
      db,
    );
    const sess = db
      .prepare("SELECT games_started, games_completed FROM analytics_sessions LIMIT 1")
      .get() as { games_started: number; games_completed: number };
    expect(sess.games_started).toBe(1);
    expect(sess.games_completed).toBe(1);
    const profile = db
      .prepare(
        "SELECT total_games_started, total_games_completed, ever_played FROM visitor_profile LIMIT 1",
      )
      .get() as { total_games_started: number; total_games_completed: number; ever_played: number };
    expect(profile.total_games_started).toBe(1);
    expect(profile.total_games_completed).toBe(1);
    expect(profile.ever_played).toBe(1);
  });

  it("DAILY_STARTED is a start event but DAILY_COMPLETED is a semantic-only marker", () => {
    // SP daily uses DAILY_STARTED in place of GAME_STARTED, so it must bump
    // the start counter. DAILY_COMPLETED is emitted *alongside* a regular
    // GAME_COMPLETED (or MP_GAME_COMPLETED) that already bumps games_completed,
    // so DAILY_COMPLETED itself must NOT — otherwise the headline metric
    // double-counts every daily completion.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.DAILY_STARTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/daily",
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.DAILY_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/daily",
      },
      db,
    );
    const sess = db
      .prepare("SELECT games_started, games_completed FROM analytics_sessions LIMIT 1")
      .get() as { games_started: number; games_completed: number };
    expect(sess.games_started).toBe(1);
    expect(sess.games_completed).toBe(0);
  });

  it("delegates first-touch UTM to visitor_attribution (does not duplicate)", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/?utm_source=google",
        attribution: { utm_source: "google", utm_medium: "cpc", utm_campaign: "launch" },
      },
      db,
    );
    const attr = db
      .prepare("SELECT utm_source, utm_campaign FROM visitor_attribution WHERE visitor_id = ?")
      .get(VID_A) as { utm_source: string; utm_campaign: string } | undefined;
    expect(attr?.utm_source).toBe("google");
    expect(attr?.utm_campaign).toBe("launch");

    // Expect one page_viewed event AND one utm_captured follow-up event.
    const names = db
      .prepare("SELECT event_name FROM events ORDER BY id")
      .all() as { event_name: string }[];
    expect(names.some((n) => n.event_name === ANALYTICS_EVENTS.PAGE_VIEWED)).toBe(true);
    expect(names.some((n) => n.event_name === ANALYTICS_EVENTS.UTM_CAPTURED)).toBe(true);
  });

  it("does NOT fire utm_captured on events that already are utm_captured (no recursion)", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.UTM_CAPTURED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        attribution: { utm_source: "reddit" },
      },
      db,
    );
    const count = (
      db
        .prepare("SELECT COUNT(*) as n FROM events WHERE event_name = ?")
        .get(ANALYTICS_EVENTS.UTM_CAPTURED) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("ignores utm_captured if visitor_attribution already has a row (first-touch wins)", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        attribution: { utm_source: "google" },
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        attribution: { utm_source: "bing" },
      },
      db,
    );
    const attr = db
      .prepare("SELECT utm_source FROM visitor_attribution WHERE visitor_id = ?")
      .get(VID_A) as { utm_source: string };
    expect(attr.utm_source).toBe("google"); // first-touch preserved
  });

  it("returns null silently when visitorId is missing", () => {
    const sid = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: "",
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    expect(sid).toBeNull();
    expect(rowCount("events")).toBe(0);
  });

  it("retroactively stamps user_id onto the session when an anon user logs in", () => {
    const sid = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.USER_LOGGED_IN,
        visitorId: VID_A,
        userId: "user-1",
        userAgent: UA_CHROME,
        path: "/login",
      },
      db,
    );
    const row = db
      .prepare("SELECT user_id FROM analytics_sessions WHERE id = ?")
      .get(sid) as { user_id: string };
    expect(row.user_id).toBe("user-1");
  });

  it("truncates oversized properties to a sentinel object", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
        properties: { huge: "x".repeat(3000) },
      },
      db,
    );
    const row = db.prepare("SELECT properties FROM events LIMIT 1").get() as { properties: string };
    const parsed = JSON.parse(row.properties);
    expect(parsed._truncated).toBe(true);
  });

  it("skips ingest entirely when isStreamerBot is set (no event/session/profile rows)", () => {
    const sid = recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_COMPLETED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/classic",
        gameMode: "classic",
        isStreamerBot: true,
      },
      db,
    );
    expect(sid).toBeNull();
    expect(rowCount("events")).toBe(0);
    expect(rowCount("analytics_sessions")).toBe(0);
    expect(rowCount("visitor_profile")).toBe(0);
  });

  it("does not bump games_started/games_completed counters for streamer-bot events", () => {
    // First a real player completes a game → counters bump.
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_STARTED, visitorId: VID_A, userAgent: UA_CHROME, path: "/" },
      db,
    );
    recordEvent(
      { eventName: ANALYTICS_EVENTS.GAME_COMPLETED, visitorId: VID_A, userAgent: UA_CHROME, path: "/" },
      db,
    );
    // Then the streamer-bot fires the same events on a separate visitor — counters must not move.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_STARTED,
        visitorId: VID_B,
        userAgent: UA_CHROME,
        path: "/",
        isStreamerBot: true,
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_COMPLETED,
        visitorId: VID_B,
        userAgent: UA_CHROME,
        path: "/",
        isStreamerBot: true,
      },
      db,
    );

    const profiles = db
      .prepare(
        "SELECT visitor_id, total_games_started, total_games_completed FROM visitor_profile",
      )
      .all() as { visitor_id: string; total_games_started: number; total_games_completed: number }[];
    expect(profiles).toHaveLength(1);
    expect(profiles[0].visitor_id).toBe(VID_A);
    expect(profiles[0].total_games_started).toBe(1);
    expect(profiles[0].total_games_completed).toBe(1);
  });
});

describe("linkVisitorToUser", () => {
  it("inserts an alias row", () => {
    linkVisitorToUser(VID_A, "user-1", db);
    const row = db
      .prepare("SELECT * FROM visitor_aliases WHERE user_id = ?")
      .get("user-1") as { visitor_id: string; user_id: string };
    expect(row.visitor_id).toBe(VID_A);
    expect(row.user_id).toBe("user-1");
  });

  it("is idempotent under repeated calls", () => {
    linkVisitorToUser(VID_A, "user-1", db);
    linkVisitorToUser(VID_A, "user-1", db);
    expect(
      (db
        .prepare("SELECT COUNT(*) as n FROM visitor_aliases")
        .get() as { n: number }).n,
    ).toBe(1);
  });

  it("is a no-op for missing visitorId", () => {
    linkVisitorToUser(null, "user-1", db);
    linkVisitorToUser(undefined, "user-1", db);
    expect(rowCount("visitor_aliases")).toBe(0);
  });

  it("supports multiple devices per user", () => {
    linkVisitorToUser(VID_A, "user-1", db);
    linkVisitorToUser(VID_B, "user-1", db);
    expect(
      (db
        .prepare("SELECT COUNT(*) as n FROM visitor_aliases WHERE user_id = ?")
        .get("user-1") as { n: number }).n,
    ).toBe(2);
  });

  // PR 6.1 — alias backfill so pre-signup activity surfaces in
  // user-keyed / loggedIn-audience V2 dashboards.
  it("backfills events.user_id for the visitor's anon history", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.GAME_STARTED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
      },
      db,
    );
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE user_id IS NULL")
        .get() as { n: number }).n,
    ).toBe(2);

    linkVisitorToUser(VID_A, "user-1", db);

    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ?")
        .get("user-1") as { n: number }).n,
    ).toBe(2);
  });

  it("backfills analytics_sessions.user_id and visitor_profile.user_id", () => {
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    expect(
      (db
        .prepare("SELECT user_id FROM analytics_sessions WHERE visitor_id = ?")
        .get(VID_A) as { user_id: string | null }).user_id,
    ).toBeNull();
    expect(
      (db
        .prepare("SELECT user_id FROM visitor_profile WHERE visitor_id = ?")
        .get(VID_A) as { user_id: string | null }).user_id,
    ).toBeNull();

    linkVisitorToUser(VID_A, "user-1", db);

    expect(
      (db
        .prepare("SELECT user_id FROM analytics_sessions WHERE visitor_id = ?")
        .get(VID_A) as { user_id: string | null }).user_id,
    ).toBe("user-1");
    const profile = db
      .prepare("SELECT user_id, ever_registered FROM visitor_profile WHERE visitor_id = ?")
      .get(VID_A) as { user_id: string | null; ever_registered: number };
    expect(profile.user_id).toBe("user-1");
    expect(profile.ever_registered).toBe(1);
  });

  it("does not overwrite an existing user_id on conflicting visitor (different user wins is idempotent on first claim)", () => {
    // First claim wins on COALESCE; a stray subsequent link with a
    // different user-id leaves prior rows untouched. Simulates the
    // (rare) device-swap edge where two users share a cookie jar.
    recordEvent(
      {
        eventName: ANALYTICS_EVENTS.PAGE_VIEWED,
        visitorId: VID_A,
        userAgent: UA_CHROME,
        path: "/",
      },
      db,
    );
    linkVisitorToUser(VID_A, "user-1", db);
    linkVisitorToUser(VID_A, "user-2", db);
    const row = db
      .prepare("SELECT user_id FROM events WHERE visitor_id = ?")
      .get(VID_A) as { user_id: string };
    expect(row.user_id).toBe("user-1");
  });
});

describe("scrubUrl", () => {
  it("returns null for null/undefined", () => {
    expect(scrubUrl(null)).toBeNull();
    expect(scrubUrl(undefined)).toBeNull();
  });

  it("keeps safe query params", () => {
    expect(scrubUrl("/admin/analytics?range=30d&mode=classic")).toBe(
      "/admin/analytics?range=30d&mode=classic",
    );
  });

  it("strips token / password / secret keys", () => {
    expect(scrubUrl("/reset?token=abc&keep=me")).toBe("/reset?keep=me");
    expect(scrubUrl("/x?password=secret&email=a@b.com")).toBe("/x");
  });

  it("strips JWT-shaped values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue";
    expect(scrubUrl(`/x?t=${jwt}`)).toBe("/x");
  });

  it("clamps length", () => {
    const huge = "/x?" + "a=1&".repeat(500);
    const out = scrubUrl(huge);
    expect(out!.length).toBeLessThanOrEqual(512);
  });
});

describe("classifyAcquisition", () => {
  it("returns direct when no source", () => {
    expect(classifyAcquisition(null, null)).toBe("direct");
  });

  it("routes cpc / ppc to paid", () => {
    expect(classifyAcquisition("google", "cpc")).toBe("paid");
    expect(classifyAcquisition("fb", "ppc")).toBe("paid");
  });

  it("classifies known sources into buckets", () => {
    expect(classifyAcquisition("google", null)).toBe("organic");
    expect(classifyAcquisition("reddit", null)).toBe("social");
    expect(classifyAcquisition("facebook", null)).toBe("social");
  });

  it("treats unknown sources as referral", () => {
    expect(classifyAcquisition("some-blog.example.com", null)).toBe("referral");
  });

  it("prefers explicit medium over source heuristic", () => {
    expect(classifyAcquisition("google", "email")).toBe("email");
  });
});
