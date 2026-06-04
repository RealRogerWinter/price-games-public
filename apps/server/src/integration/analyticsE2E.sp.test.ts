/**
 * End-to-end analytics tests for the single-player flow.
 *
 * Each test boots a real Express + http.Server backed by an in-memory
 * SQLite DB, drives a flow over real HTTP, runs the hourly rollup, and
 * asserts the v2 dashboard reflects what actually happened.
 *
 * The signal chain under test:
 *   POST /api/game/start      → events.game_started   → analytics_sessions.games_started++ → analytics_hourly.games_started
 *   POST /api/game/:id/guess  → events.game_round_submitted (×N-1)
 *                             → events.game_completed
 *                             → analytics_sessions.games_completed++ → analytics_hourly.games_completed
 *   getOverview()             → reads analytics_hourly + analytics_sessions
 *
 * What this catches that the per-service tests don't:
 *   - Wire-format drift between routes and recordEventFromRequest
 *   - DNT scrubbing applied at the route boundary
 *   - Rollup correctness end-to-end (events → hourly → dashboard)
 *   - Conservation: dashboard counters never inflate or lose events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createScenario,
  teardownScenario,
  startSpGame,
  playRound,
  completeSpGame,
  fetchWithJar,
  readOverview,
  advanceTimeAndRollup,
  readConservationCounters,
  assertGlobalInvariants,
  type TestContext,
} from "../test/analyticsScenario";

vi.mock("../db", () => ({ default: null as unknown }));

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createScenario(50);
});

afterEach(async () => {
  // Run the universal analytics invariants BEFORE teardown so a
  // violation pins the failure to the specific test that wrote the
  // offending events.
  assertGlobalInvariants(ctx);
  await teardownScenario(ctx);
});

describe("Analytics E2E — single-player happy path", () => {
  it("anon visitor: start → complete → dashboard reflects 1 start + 1 completion", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);

    advanceTimeAndRollup(ctx);
    const overview = await readOverview(ctx);
    expect(overview.gamesStarted).toBe(1);
    expect(overview.gamesCompleted).toBe(1);

    // Conservation: events table and analytics_hourly agree.
    const counters = readConservationCounters(ctx);
    expect(counters.gamesStartedEvents).toBe(counters.gamesStartedHourly);
    expect(counters.gamesCompletedEvents).toBe(counters.gamesCompletedHourly);
  });

  it("abandonment: 2 rounds played, no completion → games_started=1, games_completed=0", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    // Two guesses, then abandon — default rounds is 5, so 2 < 5 means no completion.
    await playRound(ctx, "anon", sessionId, 5000);
    const second = await playRound(ctx, "anon", sessionId, 5000);
    expect(second.completed).toBe(false);

    advanceTimeAndRollup(ctx);
    const overview = await readOverview(ctx);
    expect(overview.gamesStarted).toBe(1);
    expect(overview.gamesCompleted).toBe(0);
  });

  it("two SP sessions under the same visitor cookie produce two distinct game_completed events", async () => {
    // Two starts under the same jar inherit the same visitor cookie.
    // Each session gets a distinct server-issued id, so its dedup key
    // `srv:game_completed:<sessionId>` is also distinct — both
    // completions must land as separate rows.
    const t1 = await startSpGame(ctx, "anon");
    const t2 = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", t1.sessionId);
    await completeSpGame(ctx, "anon", t2.sessionId);

    const completed = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE event_name = 'game_completed'",
        )
        .get() as { n: number }
    ).n;
    expect(completed).toBe(2);
  });

  it("the (visitor_id, client_event_id) UNIQUE index absorbs a real beacon retry", async () => {
    // Drives the dedup invariant directly via the beacon endpoint —
    // the SP route layer 404s on a re-submitted completed session, so
    // we exercise the index at the ingest path that actually re-fires
    // under retry (network, page-hide replay).
    const envelope = {
      tabId: "t-dedup",
      sentAt: Date.now(),
      events: [
        {
          name: "page_viewed",
          category: "page" as const,
          path: "/",
          ts: Date.now(),
          seq: 0,
          clientEventId: "ce-replay-1",
        },
      ],
    };
    const r1 = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    expect(r1.status).toBe(204);
    const r2 = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    expect(r2.status).toBe(204);

    const count = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE client_event_id = 'ce-replay-1'",
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("DNT-set visitor: events stored with dnt=1, properties scrubbed end-to-end", async () => {
    // Send a DNT=1 page-view first to set the sticky pref on visitor_profile.
    // The game-route emit path (no DNT header) then inherits via
    // visitor_profile.dnt COALESCE.
    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      headers: { DNT: "1" },
      body: JSON.stringify({
        tabId: "t-1",
        sentAt: Date.now(),
        events: [
          {
            name: "page_viewed",
            category: "page",
            path: "/",
            ts: Date.now(),
            seq: 0,
            clientEventId: "ce-1",
          },
        ],
      }),
    });

    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);

    // Every event for this visitor should carry dnt=1 and scrubbed properties.
    const rows = ctx.db
      .prepare(
        `SELECT dnt, properties FROM events
          WHERE event_name IN ('game_started','game_round_submitted','game_completed')`,
      )
      .all() as Array<{ dnt: number; properties: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.dnt).toBe(1);
      expect(r.properties).toBeNull();
    }
  });

  it("re-submitting a guess against a completed session does not produce a second game_completed event", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    let last = await playRound(ctx, "anon", sessionId, 5000);
    while (!last.completed) {
      last = await playRound(ctx, "anon", sessionId, 5000);
    }
    // The route 404s on a guess against a completed session — there is
    // no analytics emission on that path. We pin the behavior here so
    // a future regression that DOES emit on the 404 path (and corrupts
    // the conservation invariant) surfaces immediately.
    await fetchWithJar(ctx, "anon", `/api/game/${sessionId}/guess`, {
      method: "POST",
      body: JSON.stringify({ guessedPriceCents: 5000 }),
    });
    const completed = (
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE event_name = 'game_completed' AND game_session_id = ?",
        )
        .get(sessionId) as { n: number }
    ).n;
    expect(completed).toBe(1);
  });

  it("conservation invariant holds across a full happy-path flow", async () => {
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);
    advanceTimeAndRollup(ctx);

    const c = readConservationCounters(ctx);
    expect(c.gamesStartedEvents).toBe(1);
    expect(c.gamesStartedHourly).toBe(1);
    expect(c.gamesCompletedEvents).toBe(1);
    expect(c.gamesCompletedHourly).toBe(1);
    // Monotonicity: started >= completed.
    expect(c.gamesStartedEvents).toBeGreaterThanOrEqual(c.gamesCompletedEvents);
  });
});
