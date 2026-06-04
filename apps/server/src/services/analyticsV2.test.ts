import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { recordEvent } from "./eventLog";
import { rebuildHourlyRange } from "./analyticsHourly";
import { __resetBotVelocity } from "./botDetection";
import {
  getOverview,
  getDailyTimeseries,
  getAcquisitionSources,
  getUtmTagPerformance,
  getTopPaths,
  getGamesPerSession,
  getHourlyHeatmap,
  getGamesByModeBreakdown,
  getGamesDailyUniques,
  getJoinSourceBreakdown,
  getStartSourceBreakdown,
  getShareLinkFunnel,
} from "./analyticsV2";
import { ANALYTICS_EVENTS } from "@price-game/shared";

const HOUR_MS = 60 * 60 * 1000;

let db: DatabaseType;

const VID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UA = "Mozilla/5.0 Chrome/120";

beforeEach(() => {
  db = createTestDb();
  __resetBotVelocity();
});

function seedEvent(
  name: string,
  opts: {
    vid?: string;
    userId?: string;
    path?: string;
    ts: number;
    utm?: { utm_source: string; utm_medium?: string; utm_campaign?: string };
  },
): void {
  recordEvent(
    {
      eventName: name,
      visitorId: opts.vid ?? VID_A,
      userId: opts.userId ?? null,
      userAgent: UA,
      path: opts.path ?? "/",
      nowMs: opts.ts,
      attribution: opts.utm,
    },
    db,
  );
}

describe("getOverview", () => {
  it("returns zeros on an empty DB", () => {
    const now = Date.now();
    const k = getOverview(db, { rangeDays: 7 }, now);
    expect(k.sessions).toBe(0);
    expect(k.dau).toBe(0);
    expect(k.engagementRate).toBe(0);
  });

  it("aggregates sessions + games from the hourly rollup", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: now - 60_000 });
    seedEvent(ANALYTICS_EVENTS.GAME_STARTED, { ts: now - 30_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const k = getOverview(db, { rangeDays: 7 }, now);
    expect(k.sessions).toBeGreaterThan(0);
    expect(k.gamesStarted).toBe(1);
  });

  it("segments by audience (anon vs logged-in)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000 });
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, userId: "u1", ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const anon = getOverview(db, { rangeDays: 7, audience: "anon" }, now);
    const logged = getOverview(db, { rangeDays: 7, audience: "loggedIn" }, now);
    expect(anon.sessions).toBeGreaterThan(0);
    expect(logged.sessions).toBeGreaterThan(0);
    expect(anon.sessions + logged.sessions).toBeGreaterThan(0);
  });

  it("reports live visitors active in the last 5 min", () => {
    const now = Date.now();
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 30_000 });
    const k = getOverview(db, { rangeDays: 7 }, now);
    expect(k.liveVisitors).toBeGreaterThanOrEqual(1);
  });

  it("returns null sessionsDelta when there is no prior window data", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const k = getOverview(db, { rangeDays: 7 }, now);
    expect(k.sessionsDelta).toBeNull();
  });

  it("reports sessionsDelta with no window overlap (boundary correctness)", () => {
    const DAY = 24 * HOUR_MS;
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    // Prior window: 14-7 days ago — seed a session there.
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      vid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      ts: now - 10 * DAY,
    });
    // Current window: last 7 days — seed 2 sessions.
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 3 * DAY });
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, ts: now - 1 * DAY });
    rebuildHourlyRange(now - 14 * DAY, now, db);
    const k = getOverview(db, { rangeDays: 7 }, now);
    expect(k.sessionsDelta).not.toBeNull();
    // 2 current vs 1 prior → +100% (or close to it).
    expect(k.sessionsDelta).toBeGreaterThan(0);
  });

  it("segments by device filter", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const desktop = getOverview(db, { rangeDays: 7, deviceType: "desktop" }, now);
    const mobile = getOverview(db, { rangeDays: 7, deviceType: "mobile" }, now);
    // UA "Mozilla/5.0 Chrome/120" parses to desktop.
    expect(desktop.sessions).toBeGreaterThan(0);
    expect(mobile.sessions).toBe(0);
  });
});

describe("getDailyTimeseries", () => {
  it("returns rangeDays + 1 points, zero-filled for empty days", () => {
    const now = Date.now();
    const points = getDailyTimeseries(db, { rangeDays: 7 }, now);
    expect(points).toHaveLength(8);
    expect(points.every((p) => p.sessions === 0)).toBe(true);
  });

  it("fills the bucket for days with data", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const points = getDailyTimeseries(db, { rangeDays: 7 }, now);
    expect(points.some((p) => p.sessions > 0)).toBe(true);
  });
});

describe("getAcquisitionSources", () => {
  it("classifies utm sources into coarse buckets", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      vid: VID_A,
      ts: now - 60_000,
      utm: { utm_source: "google", utm_medium: "cpc" },
    });
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      vid: VID_B,
      ts: now - 60_000,
      utm: { utm_source: "reddit" },
    });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const rows = getAcquisitionSources(db, { rangeDays: 7 }, now);
    const paid = rows.find((r) => r.source === "paid");
    const social = rows.find((r) => r.source === "social");
    expect(paid?.sessions).toBeGreaterThan(0);
    expect(social?.sessions).toBeGreaterThan(0);
  });
});

describe("getUtmTagPerformance", () => {
  it("joins utm_tags to analytics_sessions on exact (source, medium, campaign)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, utm_medium, utm_campaign, destination_url, status, click_count, created_at, updated_at)
       VALUES ('tag-1', 'Spring launch', 'google', 'cpc', 'spring2026', '/?ref=spring', 'active', 42, datetime('now'), datetime('now'))`,
    ).run();
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      ts: now - 60_000,
      utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "spring2026" },
    });
    seedEvent(ANALYTICS_EVENTS.GAME_COMPLETED, {
      ts: now - 30_000,
      utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "spring2026" },
    });
    const rows = getUtmTagPerformance(db, { rangeDays: 7 }, now);
    const row = rows.find((r) => r.tagId === ("tag-1" as unknown as number));
    expect(row).toBeDefined();
    expect(row!.clickCount).toBe(42);
    expect(row!.sessions).toBeGreaterThanOrEqual(1);
    expect(row!.gamesCompleted).toBeGreaterThanOrEqual(1);
  });

  it("returns zero rows for tags with no matching sessions", () => {
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, utm_campaign, destination_url, status, click_count, created_at, updated_at)
       VALUES ('tag-2', 'Unused tag', 'newsletter', NULL, '/', 'active', 0, datetime('now'), datetime('now'))`,
    ).run();
    const rows = getUtmTagPerformance(db, { rangeDays: 7 });
    const row = rows.find((r) => r.tagId === ("tag-2" as unknown as number));
    expect(row?.sessions).toBe(0);
  });

  it("does not count narrower-cohort sessions toward a broader tag (exact-tuple isolation)", () => {
    // Regression for the pre-#246 behavior: a "reddit" broad tag (no
    // medium, no campaign) used to count sessions belonging to a
    // sibling "reddit + cpc + giveaway" tag because the JOIN matched
    // on `(source, campaign)` only and treated NULL as a wildcard.
    // After tightening to exact-tuple, the broad tag must report zero
    // sessions when every actual session has a more specific tuple.
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    // Broad tag: source only.
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, utm_medium, utm_campaign, destination_url, status, click_count, created_at, updated_at)
       VALUES ('tag-broad', 'Reddit broad', 'reddit', NULL, NULL, '/', 'active', 0, datetime('now'), datetime('now'))`,
    ).run();
    // Narrow sibling tag: source + medium + campaign all set.
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, utm_medium, utm_campaign, destination_url, status, click_count, created_at, updated_at)
       VALUES ('tag-narrow', 'Reddit gw cpc', 'reddit', 'cpc', 'giveaway', '/giveaway', 'active', 0, datetime('now'), datetime('now'))`,
    ).run();
    // Real session: matches the narrow tag's tuple exactly.
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      ts: now - 60_000,
      utm: { utm_source: "reddit", utm_medium: "cpc", utm_campaign: "giveaway" },
    });

    const rows = getUtmTagPerformance(db, { rangeDays: 7 }, now);
    const broad = rows.find((r) => r.tagId === ("tag-broad" as unknown as number));
    const narrow = rows.find((r) => r.tagId === ("tag-narrow" as unknown as number));
    expect(narrow?.sessions).toBeGreaterThanOrEqual(1);
    // Critical: the broad tag must NOT also count this session.
    expect(broad?.sessions ?? 0).toBe(0);
  });

  it("matches sessions with NULL UTM fields only when the tag's matching field is also NULL", () => {
    // Direct/no-utm session (utm_source captured by visitor_attribution
    // would still be a tag insert — but in analytics_sessions a session
    // with `entry_utm_source IS NULL` should match no UTM tag at all
    // because every utm_tags row requires utm_source NOT NULL.
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    db.prepare(
      `INSERT INTO utm_tags (id, name, utm_source, utm_medium, utm_campaign, destination_url, status, click_count, created_at, updated_at)
       VALUES ('tag-only-source', 'Newsletter no medium', 'newsletter', NULL, NULL, '/', 'active', 0, datetime('now'), datetime('now'))`,
    ).run();
    // Two sessions: one with full match (source=newsletter, medium NULL, campaign NULL),
    // one with explicit medium that should NOT match the NULL-medium tag.
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      ts: now - 60_000,
      utm: { utm_source: "newsletter" },
    });
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, {
      vid: "deadbeef-dead-dead-dead-deadbeefdead",
      ts: now - 60_000,
      utm: { utm_source: "newsletter", utm_medium: "email" },
    });
    const rows = getUtmTagPerformance(db, { rangeDays: 7 }, now);
    const row = rows.find((r) => r.tagId === ("tag-only-source" as unknown as number));
    // Only the NULL-medium session matches; the medium=email session is
    // excluded by the new exact-tuple match.
    expect(row?.sessions).toBe(1);
  });
});

describe("getTopPaths", () => {
  it("returns entry + exit path counts", () => {
    const now = Date.now();
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000, path: "/home" });
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_B, ts: now - 30_000, path: "/classic" });
    const rows = getTopPaths(db, { rangeDays: 7 }, 10, now);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.path === "/home")).toBe(true);
  });
});

describe("getGamesPerSession", () => {
  it("buckets sessions by games_started count", () => {
    const now = Date.now();
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { vid: VID_A, ts: now - 60_000 });
    seedEvent(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 30_000 });
    const rows = getGamesPerSession(db, { rangeDays: 7 }, now);
    const one = rows.find((r) => r.bucket === "1");
    expect(one?.sessions).toBeGreaterThanOrEqual(1);
    // All five buckets are always represented, even if zero.
    expect(rows).toHaveLength(5);
  });

  it("routes 4 games into the 3-5 bucket", () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      seedEvent(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 60_000 + i });
    }
    const rows = getGamesPerSession(db, { rangeDays: 7 }, now);
    expect(rows.find((r) => r.bucket === "3-5")?.sessions).toBeGreaterThanOrEqual(1);
  });

  it("routes 7 games into the 6+ bucket", () => {
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      seedEvent(ANALYTICS_EVENTS.GAME_STARTED, { vid: VID_A, ts: now - 60_000 + i });
    }
    const rows = getGamesPerSession(db, { rangeDays: 7 }, now);
    expect(rows.find((r) => r.bucket === "6+")?.sessions).toBeGreaterThanOrEqual(1);
  });
});

describe("getHourlyHeatmap", () => {
  it("always returns a 168-cell zero-filled grid", () => {
    const cells = getHourlyHeatmap(db, { rangeDays: 7 });
    expect(cells).toHaveLength(7 * 24);
    expect(cells.every((c) => c.sessions === 0)).toBe(true);
  });

  it("populates cells where sessions occurred", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: now - 60_000 });
    rebuildHourlyRange(now - HOUR_MS, now, db);
    const cells = getHourlyHeatmap(db, { rangeDays: 7 }, now);
    expect(cells.some((c) => c.sessions > 0)).toBe(true);
  });
});

describe("PST timezone bucketing", () => {
  // Pin the load-bearing invariant: a Pacific-late-night event (10:30pm PST
  // on Wed Jan 14, 2026) must land on Jan 14 in the daily series and on
  // (Wed, 22) in the heatmap — NOT on Jan 15 / (Thu, 6) as it would under
  // UTC bucketing. 2026-01-15T06:30:00Z is 2026-01-14 22:30 PST (PST =
  // UTC-8 in January, no DST in effect).
  const PACIFIC_NIGHT_MS = Date.parse("2026-01-15T06:30:00Z");

  it("buckets a Pacific-late-night event into the prior PST date", () => {
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: PACIFIC_NIGHT_MS });
    seedEvent(ANALYTICS_EVENTS.GAME_STARTED, { ts: PACIFIC_NIGHT_MS + 1000 });
    const hourBucket = Math.floor(PACIFIC_NIGHT_MS / HOUR_MS) * HOUR_MS;
    rebuildHourlyRange(hourBucket, hourBucket, db);

    // `now` shortly after the event so the daily window includes it.
    // PST default applies because we omit `timeZone`.
    const now = PACIFIC_NIGHT_MS + 60 * 60 * 1000;
    const points = getDailyTimeseries(db, { rangeDays: 2 }, now);
    const target = points.find((p) => p.date === "2026-01-14");
    const offByOne = points.find((p) => p.date === "2026-01-15");
    expect(target).toBeDefined();
    expect(target!.gamesStarted).toBe(1);
    // Jan 15 bucket may exist (zero-filled) but must NOT have the event.
    expect(offByOne?.gamesStarted ?? 0).toBe(0);
  });

  it("places a Pacific-late-night session in (Wed, 22) on the heatmap", () => {
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: PACIFIC_NIGHT_MS });
    const hourBucket = Math.floor(PACIFIC_NIGHT_MS / HOUR_MS) * HOUR_MS;
    rebuildHourlyRange(hourBucket, hourBucket, db);

    const now = PACIFIC_NIGHT_MS + 60 * 60 * 1000;
    const cells = getHourlyHeatmap(db, { rangeDays: 7 }, now);
    // 2026-01-14 was a Wednesday → dayOfWeek=3. Local hour 22.
    const wed22 = cells.find((c) => c.dayOfWeek === 3 && c.hourOfDay === 22);
    const thu06 = cells.find((c) => c.dayOfWeek === 4 && c.hourOfDay === 6);
    expect(wed22?.sessions ?? 0).toBeGreaterThanOrEqual(1);
    expect(thu06?.sessions ?? 0).toBe(0);
  });

  it("honors the per-request timeZone override (UTC reverts to old behavior)", () => {
    seedEvent(ANALYTICS_EVENTS.PAGE_VIEWED, { ts: PACIFIC_NIGHT_MS });
    const hourBucket = Math.floor(PACIFIC_NIGHT_MS / HOUR_MS) * HOUR_MS;
    rebuildHourlyRange(hourBucket, hourBucket, db);

    const now = PACIFIC_NIGHT_MS + 60 * 60 * 1000;
    const points = getDailyTimeseries(db, { rangeDays: 2, timeZone: "UTC" }, now);
    const target = points.find((p) => p.date === "2026-01-15");
    expect(target?.sessions ?? 0).toBeGreaterThanOrEqual(1);
  });
});

/** Insert a raw events row directly. Used by the granular-endpoint tests
 * which need event names that aren't in the client beacon allowlist (and
 * thus can't go through `recordEvent` from the test seed helper). */
function rawEvent(opts: {
  ts: number;
  name: string;
  type?: string;
  vid?: string;
  userId?: string | null;
  path?: string | null;
  gameMode?: string | null;
  gameSessionId?: string | null;
  mpRoom?: string | null;
  properties?: Record<string, unknown>;
  isSynthetic?: boolean;
}): void {
  db.prepare(
    `INSERT INTO events (
       ts_server, visitor_id, user_id, session_id,
       event_type, event_name, path, game_mode, game_session_id, mp_room_code,
       properties, is_bot, is_synthetic, device_type, client_event_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unknown', ?
     )`,
  ).run(
    opts.ts,
    opts.vid ?? VID_A,
    opts.userId ?? null,
    `s-${Math.random().toString(36).slice(2)}`,
    opts.type ?? "mp",
    opts.name,
    opts.path ?? null,
    opts.gameMode ?? null,
    opts.gameSessionId ?? null,
    opts.mpRoom ?? null,
    opts.properties ? JSON.stringify({ v: 1, ...opts.properties }) : null,
    opts.isSynthetic ? 1 : 0,
    `t-${opts.name}-${opts.ts}-${opts.vid ?? VID_A}`,
  );
}

describe("getGamesByModeBreakdown", () => {
  it("partitions completions by (date, mode, variant) — single / multiplayer / daily", () => {
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic" });
    rawEvent({ ts: now - 50_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "classic" });
    rawEvent({ ts: now - 40_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "bidding" });
    rawEvent({ ts: now - 30_000, name: ANALYTICS_EVENTS.DAILY_COMPLETED, type: "game", gameMode: "comparison" });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(4);
    const byVariant = (v: string) => rows.filter((r) => r.variant === v);
    expect(byVariant("single").length).toBe(1);
    expect(byVariant("multiplayer").length).toBe(2);
    expect(byVariant("daily").length).toBe(1);
    // Per-row counts.
    expect(byVariant("single")[0].count).toBe(1);
    expect(byVariant("multiplayer").reduce((s, r) => s + r.count, 0)).toBe(2);
  });

  it("includes synthetic events (count metric — historical period must be continuous)", () => {
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({
      ts: now - 60_000,
      name: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
      type: "mp",
      gameMode: "classic",
      isSynthetic: true,
    });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(1);
  });

  it("groups completions in the same hour bucket / mode / variant", () => {
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "classic", vid: "v1" });
    rawEvent({ ts: now - 50_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "classic", vid: "v2" });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(2);
  });

  it("counts a live SP daily play once (as 'daily'), not also as 'single'", () => {
    // Live SP daily: game.ts emits BOTH game_completed AND daily_completed
    // for the same gameSessionId. Without the paired-dedup, the chart double-
    // counts the play (once as `single`, once as `daily`). Verify the play
    // surfaces under `daily` only.
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    const sid = "sess-sp-daily-1";
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "comparison", gameSessionId: sid });
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.DAILY_COMPLETED, type: "game", gameMode: "comparison", gameSessionId: sid });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(1);
    expect(rows[0].variant).toBe("daily");
    expect(rows[0].count).toBe(1);
  });

  it("counts a live MP daily play once (as 'daily'), not also as 'multiplayer'", () => {
    // Live MP daily: mpRoundEnd emits MP_GAME_COMPLETED + DAILY_COMPLETED per
    // human player; both share (visitor_id, mp_room_code) but neither carries
    // a gameSessionId. Dedup must key on the room+visitor pair for MP.
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "comparison", mpRoom: "ROOM01", vid: "vis-mp-1" });
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.DAILY_COMPLETED, type: "game", gameMode: "comparison", mpRoom: "ROOM01", vid: "vis-mp-1" });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(1);
    expect(rows[0].variant).toBe("daily");
    expect(rows[0].count).toBe(1);
  });

  it("MP daily room: 'Play Again' subsequent games still count as multiplayer (regression)", () => {
    // mpRoundEnd emits daily_completed only on the FIRST play of the day
    // (gated by the daily_plays unique constraint). When players hit "Play
    // Again" in the same daily room, only mp_game_completed fires for the
    // second game. A naive (mp_room_code, visitor_id) dedup would drop the
    // second game by matching it against the earlier daily_completed — net
    // data loss. The dedup must scope tightly enough that only the paired
    // events (firing within ms of each other) match.
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    // Game 1 (daily): mp_game_completed + paired daily_completed.
    rawEvent({ ts: now - 600_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "comparison", mpRoom: "ROOM-PA", vid: "vis-pa" });
    rawEvent({ ts: now - 600_000, name: ANALYTICS_EVENTS.DAILY_COMPLETED, type: "game", gameMode: "comparison", mpRoom: "ROOM-PA", vid: "vis-pa" });
    // Game 2 (Play Again, no longer counts as daily): mp_game_completed only,
    // 10 minutes later in the same room with the same visitor.
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "comparison", mpRoom: "ROOM-PA", vid: "vis-pa" });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    const byVariant = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.variant] = (acc[r.variant] ?? 0) + r.count;
      return acc;
    }, {});
    // First play: 1 daily. Second play: 1 multiplayer. Total 2.
    expect(byVariant.daily).toBe(1);
    expect(byVariant.multiplayer).toBe(1);
  });

  it("non-daily SP and MP plays still count as 'single' / 'multiplayer' (no dedup applied)", () => {
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic", gameSessionId: "sess-sp-1" });
    rawEvent({ ts: now - 50_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "classic", mpRoom: "ROOM02", vid: "vis-mp-2" });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    const byVariant = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.variant] = (acc[r.variant] ?? 0) + r.count;
      return acc;
    }, {});
    expect(byVariant.single).toBe(1);
    expect(byVariant.multiplayer).toBe(1);
    expect(byVariant.daily).toBeUndefined();
  });

  it("synthetic daily-only events still count as 'daily' (the backfill writes daily_completed alone)", () => {
    // Sanity check: synthetic data emits only daily_completed (no paired
    // game_completed). The dedup query must not drop these — the synthetic
    // path is the historical-continuity bedrock.
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({
      ts: now - 60_000,
      name: ANALYTICS_EVENTS.DAILY_COMPLETED,
      type: "game",
      gameMode: "classic",
      isSynthetic: true,
    });

    const rows = getGamesByModeBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(1);
    expect(rows[0].variant).toBe("daily");
    expect(rows[0].count).toBe(1);
  });
});

describe("getJoinSourceBreakdown", () => {
  it("counts mp_room_joined events by their join_source property", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 1000, name: ANALYTICS_EVENTS.MP_ROOM_JOINED, properties: { join_source: "share_link" } });
    rawEvent({ ts: now - 2000, name: ANALYTICS_EVENTS.MP_ROOM_JOINED, properties: { join_source: "share_link" }, vid: "v2" });
    rawEvent({ ts: now - 3000, name: ANALYTICS_EVENTS.MP_ROOM_JOINED, properties: { join_source: "browser" } });

    const rows = getJoinSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    const byKey = Object.fromEntries(rows.map((r) => [r.source, r.joins]));
    expect(byKey.share_link).toBe(2);
    expect(byKey.browser).toBe(1);
  });

  it("excludes synthetic events", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({
      ts: now - 1000,
      name: ANALYTICS_EVENTS.MP_ROOM_JOINED,
      properties: { join_source: "share_link" },
      isSynthetic: true,
    });
    const rows = getJoinSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(0);
  });
});

describe("getGamesDailyUniques", () => {
  it("returns zero-filled date series with unique players + total games per tz-local day", () => {
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic", gameSessionId: "s1", vid: "v-1" });
    rawEvent({ ts: now - 50_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic", gameSessionId: "s2", vid: "v-1" });
    rawEvent({ ts: now - 40_000, name: ANALYTICS_EVENTS.MP_GAME_COMPLETED, type: "mp", gameMode: "classic", mpRoom: "ROOM01", vid: "v-2" });

    const rows = getGamesDailyUniques(db, { rangeDays: 1, timeZone: "UTC" }, now + HOUR_MS);
    const today = rows.find((r) => r.date === "2026-04-15");
    expect(today).toBeDefined();
    expect(today!.uniquePlayers).toBe(2); // v-1 and v-2
    expect(today!.totalGames).toBe(3);
    // Older buckets in the zero-fill window stay at 0.
    expect(rows.every((r) => r.uniquePlayers >= 0)).toBe(true);
  });

  it("dedupes daily plays so a daily SP play counts as ONE game (not two)", () => {
    // Same dedup invariant as getGamesByModeBreakdown — the unique-players
    // line on the chart must track the same number-of-plays semantics.
    const now = Math.floor(Date.parse("2026-04-15T20:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "comparison", gameSessionId: "sd1", vid: "vis-d-1" });
    rawEvent({ ts: now - 60_000, name: ANALYTICS_EVENTS.DAILY_COMPLETED, type: "game", gameMode: "comparison", gameSessionId: "sd1", vid: "vis-d-1" });

    const rows = getGamesDailyUniques(db, { rangeDays: 1, timeZone: "UTC" }, now + HOUR_MS);
    const today = rows.find((r) => r.date === "2026-04-15");
    expect(today!.uniquePlayers).toBe(1);
    expect(today!.totalGames).toBe(1);
  });

  it("counts a visitor on each day they played (not summable across days)", () => {
    const day1 = Math.floor(Date.parse("2026-04-14T15:00:00Z") / HOUR_MS) * HOUR_MS;
    const day2 = Math.floor(Date.parse("2026-04-15T15:00:00Z") / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: day1, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic", gameSessionId: "s-d1", vid: "v-cross" });
    rawEvent({ ts: day2, name: ANALYTICS_EVENTS.GAME_COMPLETED, type: "game", gameMode: "classic", gameSessionId: "s-d2", vid: "v-cross" });

    const rows = getGamesDailyUniques(db, { rangeDays: 7, timeZone: "UTC" }, day2 + HOUR_MS);
    expect(rows.find((r) => r.date === "2026-04-14")?.uniquePlayers).toBe(1);
    expect(rows.find((r) => r.date === "2026-04-15")?.uniquePlayers).toBe(1);
  });
});

describe("getStartSourceBreakdown", () => {
  it("counts game_started + mp_game_started events by start_source property", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 1000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game", properties: { start_source: "homepage" } });
    rawEvent({ ts: now - 2000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game", properties: { start_source: "homepage" }, vid: "v2" });
    rawEvent({ ts: now - 3000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game", properties: { start_source: "game-browser" } });
    rawEvent({ ts: now - 4000, name: ANALYTICS_EVENTS.MP_GAME_STARTED, type: "mp", properties: { start_source: "quickplay" } });
    rawEvent({ ts: now - 5000, name: ANALYTICS_EVENTS.MP_GAME_STARTED, type: "mp", properties: { start_source: "mp-invite" } });

    const rows = getStartSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    const byKey = Object.fromEntries(rows.map((r) => [r.source, r.starts]));
    expect(byKey.homepage).toBe(2);
    expect(byKey["game-browser"]).toBe(1);
    expect(byKey.quickplay).toBe(1);
    expect(byKey["mp-invite"]).toBe(1);
  });

  it("collapses missing/null start_source into the 'unknown' bucket", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 1000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game" });
    rawEvent({ ts: now - 2000, name: ANALYTICS_EVENTS.MP_GAME_STARTED, type: "mp", properties: { start_source: null } });

    const rows = getStartSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    const byKey = Object.fromEntries(rows.map((r) => [r.source, r.starts]));
    expect(byKey.unknown).toBe(2);
  });

  it("collapses non-canonical start_source values into 'unknown' (read-path defense)", () => {
    // Defensive: even if a future emission site bypassed asStartSource(),
    // the read path must not leak the raw string to admin clients.
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 1000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game", properties: { start_source: "<script>alert(1)</script>" } });
    rawEvent({ ts: now - 2000, name: ANALYTICS_EVENTS.GAME_STARTED, type: "game", properties: { start_source: "totally-fake-bucket" } });

    const rows = getStartSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.every((r) => ["homepage", "game-browser", "quickplay", "room-creation", "mp-invite", "unknown"].includes(r.source))).toBe(true);
    const byKey = Object.fromEntries(rows.map((r) => [r.source, r.starts]));
    expect(byKey.unknown).toBe(2);
  });

  it("excludes synthetic events (backfill predates the start_source column)", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({
      ts: now - 1000,
      name: ANALYTICS_EVENTS.GAME_STARTED,
      type: "game",
      properties: { start_source: "homepage" },
      isSynthetic: true,
    });
    const rows = getStartSourceBreakdown(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(rows.length).toBe(0);
  });
});

describe("getShareLinkFunnel", () => {
  it("counts each step from copy through complete", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    // Seed a real room so the page-view check resolves to mp_rooms.
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at)
       VALUES ('ROOM123', 'h1', 'classic', 'lobby', 0, 5, ?, ?)`,
    ).run(new Date(now - 60_000).toISOString(), new Date(now - 60_000).toISOString());

    rawEvent({ ts: now - 50_000, name: ANALYTICS_EVENTS.SHARE_CLICKED, type: "mp", properties: { role: "host" } });
    rawEvent({ ts: now - 49_000, name: ANALYTICS_EVENTS.SHARE_CLICKED, type: "mp", properties: { role: "player" } });
    rawEvent({ ts: now - 48_000, name: ANALYTICS_EVENTS.PAGE_VIEWED, type: "page", path: "/ROOM123" });
    rawEvent({
      ts: now - 47_000,
      name: ANALYTICS_EVENTS.MP_ROOM_JOINED,
      type: "mp",
      mpRoom: "ROOM123",
      vid: "vis-joiner",
      properties: { join_source: "share_link" },
    });
    rawEvent({
      ts: now - 46_000,
      name: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
      type: "mp",
      mpRoom: "ROOM123",
      vid: "vis-joiner",
    });

    const funnel = getShareLinkFunnel(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(funnel.copied).toBe(2);
    expect(funnel.hostCopied).toBe(1);
    expect(funnel.playerCopied).toBe(1);
    expect(funnel.visitedRoomLink).toBe(1);
    expect(funnel.joinedViaShareLink).toBe(1);
    expect(funnel.completedAfterShareLink).toBe(1);
  });

  it("does NOT count page_viewed on non-room paths matching the legacy 7-char GLOB", () => {
    // Regression test for the GLOB false-positive bug where /profile,
    // /settings, /leaderboard, /scoreboard, etc. inflated the click step.
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    rawEvent({ ts: now - 1000, name: ANALYTICS_EVENTS.PAGE_VIEWED, type: "page", path: "/profile" });
    rawEvent({ ts: now - 2000, name: ANALYTICS_EVENTS.PAGE_VIEWED, type: "page", path: "/contact" });
    rawEvent({ ts: now - 3000, name: ANALYTICS_EVENTS.PAGE_VIEWED, type: "page", path: "/leaderboard" });
    // No mp_rooms row means EXISTS returns false for any of these paths.

    const funnel = getShareLinkFunnel(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(funnel.visitedRoomLink).toBe(0);
  });

  it("does not attribute a completion when the visitor's join was not a share_link", () => {
    const now = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    db.prepare(
      `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, last_activity_at)
       VALUES ('ROOM456', 'h2', 'classic', 'lobby', 0, 5, ?, ?)`,
    ).run(new Date(now - 60_000).toISOString(), new Date(now - 60_000).toISOString());

    rawEvent({
      ts: now - 5000,
      name: ANALYTICS_EVENTS.MP_ROOM_JOINED,
      type: "mp",
      mpRoom: "ROOM456",
      vid: "vis-quick",
      properties: { join_source: "quickplay" },
    });
    rawEvent({
      ts: now - 4000,
      name: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
      type: "mp",
      mpRoom: "ROOM456",
      vid: "vis-quick",
    });

    const funnel = getShareLinkFunnel(db, { rangeDays: 7 }, now + HOUR_MS);
    expect(funnel.joinedViaShareLink).toBe(0);
    expect(funnel.completedAfterShareLink).toBe(0);
  });
});
