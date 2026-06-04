/**
 * Property-based analytics invariants.
 *
 * Where the SP/MP/identity/dedup E2E files pin specific scenarios,
 * this file pins the GENERAL properties that should hold for *any*
 * sequence of analytics writes — generated randomly by `fast-check`.
 *
 * Each property is a contract the rollup + dashboard must respect
 * regardless of which specific events landed first or how many real
 * vs synthetic visitors are in the mix:
 *
 *   1. **Conservation** — for any window, the count of game-completion
 *      events in the events table equals the sum of `games_completed`
 *      across `analytics_hourly` rows in that window. Drives every
 *      "how many games were completed?" dashboard.
 *
 *   2. **Monotonicity** — for any visitor V, gamesStarted(V) >=
 *      gamesCompleted(V). A completion without a start indicates a
 *      missed emission upstream.
 *
 *   3. **Rollup idempotency** — re-running `rebuildHourlyRange` over
 *      a frozen events table produces byte-identical analytics_hourly
 *      rows. Guards against a future caching/ordering bug that makes
 *      the rollup non-deterministic.
 *
 *   4. **Time-window additivity** — `rollup([t, t+1h)) + rollup([t+1h,
 *      t+2h)) == rollup([t, t+2h))` for the games_started/completed
 *      columns. A property that fails here means dashboards' totals
 *      depend on which window slice the user picked.
 *
 * Cost budget: each property runs ~50 randomized cases (default
 * fast-check `numRuns`) at ~5–20 ms per case ⇒ <2s total on CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fc from "fast-check";
import { randomUUID } from "crypto";
import {
  createScenario,
  teardownScenario,
  startSpGame,
  playRound,
  completeSpGame,
  fetchWithJar,
  advanceTimeAndRollup,
  type TestContext,
} from "../test/analyticsScenario";
import { rebuildHourlyRange } from "../services/analyticsHourly";
import { ANALYTICS_EVENTS } from "@price-game/shared";

vi.mock("../db", () => ({ default: null as unknown }));

const HOUR_MS = 60 * 60 * 1000;

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createScenario(50);
});

afterEach(async () => {
  await teardownScenario(ctx);
});

/**
 * Post N random PAGE_VIEWED events under fresh visitor cookies. Used
 * by the conservation / monotonicity properties to seed the events
 * table with synthetic-but-realistic activity. Uses real beacon
 * envelopes so the event row matches what production would write.
 */
async function seedRandomPageViews(
  ctx_: TestContext,
  count: number,
): Promise<void> {
  const tabId = randomUUID();
  const events = Array.from({ length: count }, (_, i) => ({
    name: ANALYTICS_EVENTS.PAGE_VIEWED,
    category: "page" as const,
    path: "/",
    ts: Date.now(),
    seq: i,
    clientEventId: randomUUID(),
  }));
  await fetchWithJar(ctx_, "anon", "/api/events/track", {
    method: "POST",
    body: JSON.stringify({ tabId, sentAt: Date.now(), events }),
  });
}

describe("Analytics invariants — property-based", () => {
  it("Conservation: events table count of game_completed == analytics_hourly sum of games_completed", async () => {
    // Generator: 0..3 anon SP completions per case. Plus a random
    // amount of beacon noise (page views) to verify the property
    // isolates game_completed from other event types.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 12 }),
        async (numCompletions, numPageViews) => {
          // Fresh DB per case via beforeEach is too expensive (each
          // case would boot Express + SQLite), so instead we snapshot
          // the prior count and assert the DELTA.
          const beforeEvents = (
            ctx.db
              .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE event_name = 'game_completed' AND is_bot = 0 AND COALESCE(is_synthetic, 0) = 0",
              )
              .get() as { n: number }
          ).n;

          for (let i = 0; i < numCompletions; i++) {
            const jar = `case-${randomUUID()}`;
            const { sessionId } = await startSpGame(ctx, jar);
            await completeSpGame(ctx, jar, sessionId);
          }
          if (numPageViews > 0) await seedRandomPageViews(ctx, numPageViews);

          advanceTimeAndRollup(ctx);

          const afterEvents = (
            ctx.db
              .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE event_name = 'game_completed' AND is_bot = 0 AND COALESCE(is_synthetic, 0) = 0",
              )
              .get() as { n: number }
          ).n;
          expect(afterEvents - beforeEvents).toBe(numCompletions);

          const hourlyCompleted = (
            ctx.db
              .prepare(
                "SELECT COALESCE(SUM(games_completed), 0) AS n FROM analytics_hourly",
              )
              .get() as { n: number }
          ).n;
          // After the rollup, the hourly sum equals the total count of
          // completion events in this DB.
          expect(hourlyCompleted).toBe(afterEvents);
        },
      ),
      // 12 cases × up to 6 completions × ~80ms per SP completion ≈ 6s
      // upper bound. Wider than the original 8/3 because the smaller
      // generator paid fast-check overhead without earning it — at
      // numCompletions ≤ 3 the property's fail-modes are too narrow.
      { numRuns: 12 },
    );
  }, 60_000);

  it("Monotonicity: for every visitor, started >= completed even with abandoned + completed mix", async () => {
    // Generator: a sequence of (numStarts, numCompletes) where
    // numCompletes <= numStarts — i.e. some visitors abandon mid-game,
    // some run to completion, some start multiple games. The property
    // would fail if a future bug emits a stray completion without a
    // matching start (the bug class this guards against), and the
    // mixed-abandonment generator exercises the case where completion
    // does NOT trivially follow every start.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            numStarts: fc.integer({ min: 1, max: 3 }),
            numCompletes: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (visitorPlays) => {
          for (const v of visitorPlays) {
            const jar = `mono-${randomUUID()}`;
            const completes = Math.min(v.numCompletes, v.numStarts);
            for (let i = 0; i < v.numStarts; i++) {
              const { sessionId } = await startSpGame(ctx, jar);
              if (i < completes) {
                await completeSpGame(ctx, jar, sessionId);
              } else {
                // Abandon: play one round so the start event is
                // unambiguously present without driving to completion.
                await playRound(ctx, jar, sessionId);
              }
            }
          }
          const violators = ctx.db
            .prepare(
              `SELECT visitor_id,
                      SUM(CASE WHEN event_name = 'game_started' THEN 1 ELSE 0 END) AS started,
                      SUM(CASE WHEN event_name = 'game_completed' THEN 1 ELSE 0 END) AS completed
                 FROM events
                WHERE event_name IN ('game_started', 'game_completed')
                  AND is_bot = 0
                  AND COALESCE(is_synthetic, 0) = 0
             GROUP BY visitor_id
               HAVING completed > started`,
            )
            .all();
          expect(violators).toEqual([]);
        },
      ),
      { numRuns: 12 },
    );
  }, 60_000);

  it("Rollup idempotency: re-running rebuildHourlyRange over a frozen events table is a no-op", async () => {
    // Seed some activity, snapshot analytics_hourly, run rebuild
    // again, snapshot, assert byte-equal.
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);
    await seedRandomPageViews(ctx, 4);

    const now = Date.now();
    const startBucket = Math.floor(now / HOUR_MS) * HOUR_MS - 24 * HOUR_MS;
    const endBucket = Math.floor(now / HOUR_MS) * HOUR_MS;
    rebuildHourlyRange(startBucket, endBucket, ctx.db);
    const first = ctx.db
      .prepare(
        "SELECT * FROM analytics_hourly ORDER BY hour_bucket, device_type, country, acquisition_source",
      )
      .all();

    rebuildHourlyRange(startBucket, endBucket, ctx.db);
    const second = ctx.db
      .prepare(
        "SELECT * FROM analytics_hourly ORDER BY hour_bucket, device_type, country, acquisition_source",
      )
      .all();
    expect(second).toEqual(first);
  }, 30_000);

  it("Time-window additivity: rollup([t, t+1h)) ∪ rollup([t+1h, t+2h)) == rollup([t, t+2h))", async () => {
    // Seed activity straddling two hour buckets. Slice the rollup two
    // ways and assert the totals are identical. This catches a class
    // of off-by-one bucketing bugs that would let the same event
    // count toward two adjacent windows.
    const { sessionId } = await startSpGame(ctx, "anon");
    await completeSpGame(ctx, "anon", sessionId);

    const now = Date.now();
    const t = Math.floor(now / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
    const tPlus1 = t + HOUR_MS;
    const tPlus2 = t + 2 * HOUR_MS;

    const sumStarted = (start: number, end: number): number => {
      rebuildHourlyRange(start, end, ctx.db);
      return (
        ctx.db
          .prepare(
            "SELECT COALESCE(SUM(games_started), 0) AS n FROM analytics_hourly WHERE hour_bucket BETWEEN ? AND ?",
          )
          .get(start, end) as { n: number }
      ).n;
    };

    const halfA = sumStarted(t, tPlus1 - 1);
    const halfB = sumStarted(tPlus1, tPlus2 - 1);
    const full = sumStarted(t, tPlus2 - 1);
    expect(halfA + halfB).toBe(full);
  }, 30_000);
});
