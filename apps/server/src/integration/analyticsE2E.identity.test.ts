/**
 * End-to-end analytics tests for identity edges.
 *
 * Drives the production HTTP flow for SP gameplay, then exercises the
 * production `linkVisitorToUser` (the same function the /register and
 * /login routes call) and asserts that pre-signup activity surfaces in
 * loggedIn-audience V2 dashboards via the alias backfill from PR 6.1.
 *
 * Why this is a separate file from analyticsE2E.sp.test.ts:
 *   - The SP file pins single-visitor invariants (events ↔ hourly).
 *   - This file pins cross-identity invariants — what happens when an
 *     anonymous visitor's history is later claimed by a signup. The
 *     bug it guards against (pre-signup events orphaned in user-keyed
 *     dashboards) is high-value to catch on regression because it
 *     silently under-counts signed-up users' activity in every cohort
 *     query.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createScenario,
  teardownScenario,
  startSpGame,
  completeSpGame,
  fetchWithJar,
  advanceTimeAndRollup,
  assertGlobalInvariants,
  type TestContext,
} from "../test/analyticsScenario";

vi.mock("../db", () => ({ default: null as unknown }));

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createScenario(50);
});

afterEach(async () => {
  assertGlobalInvariants(ctx);
  await teardownScenario(ctx);
});

describe("Analytics E2E — identity edges", () => {
  it("anon plays SP → signs up → loggedIn-audience query reflects pre-signup activity", async () => {
    // 1. Anonymous play.
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);

    // 2. Resolve the visitor_id the cookie middleware minted for this jar.
    //    fetchWithJar captured it on the first POST; jar value is
    //    `visitor_id=<uuid>`.
    const cookie = ctx.jars.get("anon") ?? "";
    const m = cookie.match(/visitor_id=([0-9a-f-]+)/);
    expect(m).toBeTruthy();
    const visitorId = m![1];

    // Pre-signup: events for this visitor have user_id = NULL.
    const pre = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE visitor_id = ? AND user_id IS NULL",
        )
        .get(visitorId) as { n: number }
    ).n;
    expect(pre).toBeGreaterThan(0);

    // 3. Simulate signup by calling the production linkVisitorToUser.
    const { linkVisitorToUser } = await import("../services/eventLog");
    linkVisitorToUser(visitorId, "user-test-1", ctx.db);

    // 4. Post-signup: ALL of this visitor's events are now stamped with
    //    the user_id, so a loggedIn-audience query (which filters by
    //    `user_id IS NOT NULL`) sees them.
    const post = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE visitor_id = ? AND user_id = ?",
        )
        .get(visitorId, "user-test-1") as { n: number }
    ).n;
    expect(post).toBe(pre);
    const orphaned = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE visitor_id = ? AND user_id IS NULL",
        )
        .get(visitorId) as { n: number }
    ).n;
    expect(orphaned).toBe(0);

    // analytics_sessions also gets the backfill so the "loggedIn"
    // audience filter on session-grouped dashboards picks up these
    // pre-signup sessions.
    const sessionUser = (
      ctx.db
        .prepare(
          "SELECT user_id FROM analytics_sessions WHERE visitor_id = ?",
        )
        .get(visitorId) as { user_id: string | null }
    ).user_id;
    expect(sessionUser).toBe("user-test-1");

    // visitor_profile gets ever_registered=1 even before the next
    // page-view re-runs the UPSERT, so cohort definitions that key off
    // ever_registered work immediately on signup.
    const profile = ctx.db
      .prepare(
        "SELECT user_id, ever_registered FROM visitor_profile WHERE visitor_id = ?",
      )
      .get(visitorId) as { user_id: string; ever_registered: number };
    expect(profile.user_id).toBe("user-test-1");
    expect(profile.ever_registered).toBe(1);
  });

  it("alias is idempotent — replaying the link does not double-mutate or leak", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);
    const visitorId = (ctx.jars.get("anon") ?? "").match(/visitor_id=([0-9a-f-]+)/)![1];

    const { linkVisitorToUser } = await import("../services/eventLog");
    linkVisitorToUser(visitorId, "user-test-1", ctx.db);
    const eventsAfterFirst = ctx.db
      .prepare("SELECT id, user_id FROM events WHERE visitor_id = ? ORDER BY id")
      .all(visitorId) as Array<{ id: number; user_id: string }>;

    linkVisitorToUser(visitorId, "user-test-1", ctx.db);
    const eventsAfterSecond = ctx.db
      .prepare("SELECT id, user_id FROM events WHERE visitor_id = ? ORDER BY id")
      .all(visitorId) as Array<{ id: number; user_id: string }>;

    expect(eventsAfterSecond).toEqual(eventsAfterFirst);
    const aliasCount = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM visitor_aliases WHERE visitor_id = ? AND user_id = ?",
        )
        .get(visitorId, "user-test-1") as { n: number }
    ).n;
    expect(aliasCount).toBe(1);
  });

  it("first-claim-wins — a stray subsequent link with a different user does not overwrite prior attribution", async () => {
    // Cookie-jar swap edge: two different users somehow share a cookie
    // (rare but possible — shared kiosk, browser handed off, etc.).
    // The first claim attaches the visitor's history to the original
    // user; the second claim is a no-op for the existing rows but does
    // create the second alias row for cross-device merging.
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);
    const visitorId = (ctx.jars.get("anon") ?? "").match(/visitor_id=([0-9a-f-]+)/)![1];

    const { linkVisitorToUser } = await import("../services/eventLog");
    linkVisitorToUser(visitorId, "user-1", ctx.db);
    linkVisitorToUser(visitorId, "user-2", ctx.db);

    // Original events stay attributed to user-1.
    const userIds = ctx.db
      .prepare("SELECT DISTINCT user_id FROM events WHERE visitor_id = ?")
      .all(visitorId) as Array<{ user_id: string }>;
    expect(userIds).toEqual([{ user_id: "user-1" }]);

    // But both alias rows exist for cross-device resolution.
    const aliases = ctx.db
      .prepare(
        "SELECT user_id FROM visitor_aliases WHERE visitor_id = ? ORDER BY user_id",
      )
      .all(visitorId) as Array<{ user_id: string }>;
    expect(aliases).toEqual([{ user_id: "user-1" }, { user_id: "user-2" }]);
  });

  it("conservation invariant survives signup — events are not duplicated or lost", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);
    const visitorId = (ctx.jars.get("anon") ?? "").match(/visitor_id=([0-9a-f-]+)/)![1];

    const beforeCount = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
    ).n;

    const { linkVisitorToUser } = await import("../services/eventLog");
    linkVisitorToUser(visitorId, "user-test-1", ctx.db);

    const afterCount = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
    ).n;
    expect(afterCount).toBe(beforeCount);

    // Rollup parity: re-rolling up after the backfill doesn't change
    // the pre-aggregated counters either.
    advanceTimeAndRollup(ctx);
    const startedHourly = (
      ctx.db
        .prepare(
          "SELECT COALESCE(SUM(games_started), 0) AS n FROM analytics_hourly",
        )
        .get() as { n: number }
    ).n;
    expect(startedHourly).toBe(1);
  });

  it("uses fetchWithJar to confirm the cookie jar plumbing surfaces a stable visitor across requests", async () => {
    // Pin the harness contract: two calls under the same jar use the
    // same visitor_id cookie. If a future scaffolding bug rotates the
    // cookie mid-test, every identity assertion in this file would
    // silently lose its meaning.
    const r1 = await fetchWithJar(ctx, "anon", "/api/game/categories");
    expect(r1.status).toBe(200);
    const r2 = await fetchWithJar(ctx, "anon", "/api/game/categories");
    expect(r2.status).toBe(200);
    const cookie = ctx.jars.get("anon") ?? "";
    expect(cookie).toMatch(/^visitor_id=[0-9a-f-]+$/);
  });
});
