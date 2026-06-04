/**
 * Compositional scaffolding for analytics end-to-end scenarios.
 *
 * The test suite under apps/server/src/integration/analyticsE2E.*.test.ts
 * needs to exercise the full signal chain (HTTP → recordEvent →
 * analytics_sessions → analytics_hourly → analyticsV2 dashboard reads)
 * across many flow variants without the boilerplate of booting a
 * fresh Express + cookie-jar fixture in every test. This module
 * provides the helpers that compose those flows.
 *
 * Design choices:
 *   - **Compositional, not declarative.** Each helper does one thing
 *     and returns the updated context; callers chain them. This keeps
 *     scenarios readable as a top-to-bottom recipe instead of a
 *     hidden DSL.
 *   - **No assertions inside helpers.** Helpers only mutate state.
 *     Assertions live in the test bodies so a failure surfaces at the
 *     line the test author wrote, not at a deep stack frame inside
 *     scaffolding.
 *   - **Cookie-jar is per-visitor.** The TestContext exposes
 *     `withVisitor(label, fn)` so tests that need multiple cookie
 *     jars (multi-tab, multi-user, alias resolution) can keep them
 *     distinct without manual header threading.
 *   - **Time control is opt-in.** `advanceTimeAndRollup` is provided
 *     for scenarios that need to advance into the next hour bucket.
 *     Scenarios that don't care just don't call it.
 *
 * Reuses: `createTestDb` / `seedProducts` (./dbHelper.ts), the unified
 * `recordEventFromRequest` ingest path, the production v1 routes
 * (`game.ts`) and v2 services (`analyticsV2.ts`, `analyticsHourly.ts`).
 */

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server as HttpServer } from "http";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedProducts } from "./dbHelper";
import { rebuildHourlyRange } from "../services/analyticsHourly";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Top-level handle returned by {@link createScenario}. Tests treat it
 * as opaque — the public surface is the helpers below, all of which
 * accept a TestContext as the first argument.
 */
export interface TestContext {
  db: DatabaseType;
  app: Express;
  server: HttpServer;
  baseUrl: string;
  /**
   * Cookie jars keyed by a caller-chosen label ("anon", "userA",
   * "tab2", etc.). Scenarios that need multiple identities create
   * additional jars via {@link withVisitor}.
   */
  jars: Map<string, string>;
}

/**
 * Boot a real Express + http.Server backed by an in-memory SQLite DB
 * pre-seeded with `productCount` products. The default jar key is
 * "anon"; tests typically alias additional jars by visitor / user.
 *
 * @param productCount - Number of test products to seed (default 50).
 * @returns A TestContext ready for scenario helpers. Caller MUST call
 *   {@link teardownScenario} in `afterEach` to release the server.
 */
export async function createScenario(
  productCount: number = 50,
): Promise<TestContext> {
  const db = createTestDb();
  seedProducts(db, productCount);
  // Inject the in-memory DB into the global module so route handlers
  // (which import the default-exported db) see the fresh test fixture.
  const dbMod = await import("../db");
  (dbMod as unknown as { default: DatabaseType }).default = db;

  // Imports must happen after the module mock has resolved so closure
  // capture grabs the test DB rather than a stale handle.
  const { visitorCookie } = await import("../middleware/visitorCookie");
  const gameRouter = (await import("../routes/game")).default;
  const { createEventsRouter } = await import("../routes/events");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", visitorCookie);
  app.use("/api/game", gameRouter);
  app.use("/api/events", createEventsRouter());

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return { db, app, server, baseUrl, jars: new Map([["anon", ""]]) };
}

/** Teardown counterpart to {@link createScenario}. Awaits the http
 *  server close so the next test's listen(0) doesn't race the previous
 *  port-release. Closes the in-memory DB handle to free its memory
 *  immediately — without this the harness keeps every test's DB alive
 *  until process exit, which inflates per-shard memory under vitest's
 *  parallel runner. */
export async function teardownScenario(ctx: TestContext): Promise<void> {
  if (ctx.server) {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  }
  if (ctx.db && ctx.db.open) ctx.db.close();
}

/**
 * Run `fn` with the given visitor jar selected. The jar is created on
 * first use so a test can ask for a fresh visitor identity without
 * a separate setup step.
 */
export async function withVisitor<T>(
  ctx: TestContext,
  label: string,
  fn: (jarCookie: () => string) => Promise<T>,
): Promise<T> {
  if (!ctx.jars.has(label)) ctx.jars.set(label, "");
  return fn(() => ctx.jars.get(label) ?? "");
}

/**
 * POST against the test server with the named jar's current cookie.
 * Captures any Set-Cookie response and updates the jar.
 */
export async function fetchWithJar(
  ctx: TestContext,
  jarLabel: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cookie = ctx.jars.get(jarLabel) ?? "";
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (cookie) headers.set("Cookie", cookie);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
  // Fold the Set-Cookie response back into the jar for follow-up calls.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const m = setCookie.match(/visitor_id=([^;]+)/);
    if (m) ctx.jars.set(jarLabel, `visitor_id=${m[1]}`);
  }
  return res;
}

/**
 * Start a single-player game via POST /api/game/start. Returns the
 * server-issued session id.
 */
export async function startSpGame(
  ctx: TestContext,
  jarLabel: string = "anon",
  opts: { mode?: string; rounds?: number } = {},
): Promise<{ sessionId: string }> {
  const res = await fetchWithJar(ctx, jarLabel, "/api/game/start", {
    method: "POST",
    body: JSON.stringify({ mode: opts.mode ?? "classic", rounds: opts.rounds }),
  });
  if (!res.ok) {
    throw new Error(`startSpGame: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { sessionId: body.id };
}

/**
 * Submit a single guess. Returns whether the session is now completed.
 */
export async function playRound(
  ctx: TestContext,
  jarLabel: string,
  sessionId: string,
  guessedPriceCents: number = 5000,
): Promise<{ completed: boolean; totalScore: number }> {
  const res = await fetchWithJar(ctx, jarLabel, `/api/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedPriceCents }),
  });
  if (!res.ok) {
    throw new Error(`playRound: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    session: { completed: boolean; totalScore: number };
  };
  return {
    completed: body.session.completed,
    totalScore: body.session.totalScore,
  };
}

/**
 * Drive a session to completion by submitting one guess per remaining
 * round. Returns the final total score.
 */
export async function completeSpGame(
  ctx: TestContext,
  jarLabel: string,
  sessionId: string,
  guessedPriceCents: number = 5000,
): Promise<number> {
  let last = await playRound(ctx, jarLabel, sessionId, guessedPriceCents);
  // Bound the loop so a runaway test (session that never completes
  // due to a bug in our flow) surfaces as an explicit failure rather
  // than hanging the suite or returning misleading mid-game state.
  let safety = 50;
  while (!last.completed) {
    if (safety-- <= 0) {
      throw new Error(
        `completeSpGame: session ${sessionId} did not complete after 50 guesses — flow is stuck`,
      );
    }
    last = await playRound(ctx, jarLabel, sessionId, guessedPriceCents);
  }
  return last.totalScore;
}

/**
 * Read the v2 dashboard overview for the given window.
 * Thin wrapper for ergonomics; tests can also call analyticsV2 directly.
 */
export async function readOverview(
  ctx: TestContext,
  rangeDays: number = 30,
): Promise<Record<string, unknown>> {
  const { getOverview } = await import("../services/analyticsV2");
  return getOverview(ctx.db, {
    rangeDays,
    audience: "all",
    deviceType: "all",
  }) as unknown as Record<string, unknown>;
}

/**
 * Force-roll up the events table into analytics_hourly for the window
 * surrounding `now`. Use this after writing events but before calling
 * the dashboard readers, since v2 reads from analytics_hourly.
 */
export function advanceTimeAndRollup(
  ctx: TestContext,
  now: number = Date.now(),
  windowHours: number = 24 * 30,
): void {
  const endBucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  const startBucket = endBucket - windowHours * HOUR_MS;
  rebuildHourlyRange(startBucket, endBucket, ctx.db);
}

/**
 * Return the set of conservation invariants that should hold for any
 * window in the analytics pipeline. Used by tests to assert post-flow
 * dashboards reflect reality without inflation or loss.
 *
 * The contract:
 *   - `gamesStartedEvents` (count of game_started + mp_game_started +
 *     daily_started rows in events for non-bot, non-DNT visitors) ==
 *     `gamesStartedHourly` (sum across analytics_hourly).
 *   - `gamesCompletedEvents` == `gamesCompletedHourly`.
 *   - `gamesStarted >= gamesCompleted` (monotonicity).
 *
 * Returned as a record so tests can assert pieces individually with
 * informative failure messages, instead of a boolean.
 */
export function readConservationCounters(
  ctx: TestContext,
): {
  gamesStartedEvents: number;
  gamesStartedHourly: number;
  gamesCompletedEvents: number;
  gamesCompletedHourly: number;
} {
  const eventCounter = (names: string[]) => {
    const placeholders = names.map(() => "?").join(",");
    // Mirror the rollup's filter: real users only — bots and synthetic
    // (ghost / seed) rows are excluded so the counter matches what the
    // dashboard surfaces. Without `is_synthetic = 0`, future fixtures
    // that seed synthetic activity would silently inflate the
    // conservation invariant.
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE event_name IN (${placeholders})
            AND is_bot = 0
            AND COALESCE(is_synthetic, 0) = 0`,
      )
      .get(...names) as { n: number };
    return row.n;
  };
  const hourlyCounter = (col: "games_started" | "games_completed") => {
    const row = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(${col}), 0) AS n FROM analytics_hourly`,
      )
      .get() as { n: number };
    return row.n;
  };
  return {
    gamesStartedEvents: eventCounter([
      "game_started",
      "mp_game_started",
      "daily_started",
    ]),
    gamesStartedHourly: hourlyCounter("games_started"),
    gamesCompletedEvents: eventCounter([
      "game_completed",
      "mp_game_completed",
    ]),
    gamesCompletedHourly: hourlyCounter("games_completed"),
  };
}

/**
 * Run the universal analytics invariants against the scenario's DB.
 * Designed to be called from an E2E test's `afterEach`:
 *
 *   afterEach(async () => {
 *     assertGlobalInvariants(ctx);
 *     await teardownScenario(ctx);
 *   });
 *
 * Invariants (none ever rely on a specific test's flow shape — the
 * point is a free regression net for ANY test that touches analytics):
 *
 *   1. **Dedup index integrity**: no two events share
 *      (visitor_id, client_event_id). The UNIQUE partial index in
 *      production absorbs duplicate writes silently, so checking for
 *      duplicates AFTER a flow caught a real keying bug in PR 6a's
 *      MP completions before the index was used.
 *
 *   2. **Started ≥ Completed**: a real visitor cannot have completed
 *      more games than they started. Violations are typically caused
 *      by a missed `game_started` emission upstream of `game_completed`.
 *
 *   3. **No raw-row events without ts_server**: every row has a
 *      server-assigned timestamp. A null ts_server breaks rollup
 *      bucketing.
 *
 * Throws AssertionError with a specific message on violation so the
 * culprit test (the one whose afterEach ran) is the one that fails.
 */
export function assertGlobalInvariants(ctx: TestContext): void {
  assertGlobalInvariantsOnDb(ctx.db);
}

/**
 * Same invariants as {@link assertGlobalInvariants}, but takes a raw
 * DB handle for tests that don't use the {@link TestContext} fixture
 * (e.g. socket-based MP tests that own their own TestServer instance
 * with its own SQLite handle).
 */
export function assertGlobalInvariantsOnDb(db: DatabaseType): void {
  const dupes = db
    .prepare(
      `SELECT visitor_id, client_event_id, COUNT(*) AS c FROM events
        WHERE client_event_id IS NOT NULL
        GROUP BY visitor_id, client_event_id HAVING c > 1`,
    )
    .all() as Array<{ visitor_id: string; client_event_id: string; c: number }>;
  if (dupes.length > 0) {
    throw new Error(
      `assertGlobalInvariants: duplicate dedup keys (visitor_id, client_event_id):\n` +
        dupes.map((d) => `  ${d.visitor_id}/${d.client_event_id} ×${d.c}`).join("\n"),
    );
  }

  const eventCounter = (names: string[]) => {
    const placeholders = names.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE event_name IN (${placeholders})
            AND is_bot = 0
            AND COALESCE(is_synthetic, 0) = 0`,
      )
      .get(...names) as { n: number };
    return row.n;
  };
  const startedEvents = eventCounter([
    "game_started",
    "mp_game_started",
    "daily_started",
  ]);
  const completedEvents = eventCounter(["game_completed", "mp_game_completed"]);
  if (startedEvents < completedEvents) {
    throw new Error(
      `assertGlobalInvariants: monotonicity violated — ` +
        `gamesStartedEvents=${startedEvents} < ` +
        `gamesCompletedEvents=${completedEvents}`,
    );
  }

  const nullTs = (
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ts_server IS NULL")
      .get() as { n: number }
  ).n;
  if (nullTs > 0) {
    throw new Error(
      `assertGlobalInvariants: ${nullTs} events have NULL ts_server — rollup will bucket them as epoch zero`,
    );
  }
}
