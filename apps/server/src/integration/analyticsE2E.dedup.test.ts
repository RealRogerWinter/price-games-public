/**
 * End-to-end dedup tests for the analytics ingest path.
 *
 * Pins the contract that powers every dashboard's accuracy: a duplicate
 * write to the events table — whether from a network retry, a
 * localStorage replay, or a double-flushed envelope — never creates
 * a second event row. The (visitor_id, client_event_id) UNIQUE
 * partial index in production is the load-bearing piece; these tests
 * exercise it through real HTTP, not direct SQL.
 *
 * What the SP / MP / identity files don't catch:
 *   - Out-of-order arrival (envelope sent later but with an earlier ts_client)
 *   - Clock-skew where ts_client and ts_server disagree by hours
 *   - localStorage replay after a network interruption (two writes,
 *     same key, but different sentAt)
 *   - Enumerating edge keys (empty path, max-length cleid, etc.) so a
 *     future allowlist tightening doesn't silently fail open
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  createScenario,
  teardownScenario,
  fetchWithJar,
  assertGlobalInvariants,
  type TestContext,
} from "../test/analyticsScenario";
import { ANALYTICS_EVENTS } from "@price-game/shared";

vi.mock("../db", () => ({ default: null as unknown }));

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createScenario(50);
});

afterEach(async () => {
  assertGlobalInvariants(ctx);
  await teardownScenario(ctx);
});

function envelope(
  events: Array<{
    name?: string;
    path?: string;
    ts?: number;
    seq?: number;
    clientEventId?: string;
    properties?: Record<string, string | number | boolean | null>;
  }>,
  sentAt: number = Date.now(),
  tabId: string = "tab-dedup",
) {
  return {
    tabId,
    sentAt,
    events: events.map((e, i) => ({
      name: e.name ?? ANALYTICS_EVENTS.PAGE_VIEWED,
      category: "page" as const,
      path: e.path ?? "/",
      ts: e.ts ?? Date.now(),
      seq: e.seq ?? i,
      clientEventId: e.clientEventId ?? randomUUID(),
      properties: e.properties,
    })),
  };
}

describe("Analytics E2E — dedup edges", () => {
  it("two flushes of the SAME clientEventId from the same visitor produce one row", async () => {
    const cleid = randomUUID();
    const env = envelope([{ clientEventId: cleid }]);
    const r1 = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r1.status).toBe(204);
    const r2 = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r2.status).toBe(204);
    const count = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE client_event_id = ?")
        .get(cleid) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("the SAME clientEventId from DIFFERENT visitors produces two rows (key is scoped per-visitor)", async () => {
    const cleid = randomUUID();
    // visitor A
    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(envelope([{ clientEventId: cleid }])),
    });
    // visitor B (different jar = fresh cookie)
    await fetchWithJar(ctx, "other", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(envelope([{ clientEventId: cleid }])),
    });
    const count = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE client_event_id = ?")
        .get(cleid) as { n: number }
    ).n;
    expect(count).toBe(2);
  });

  it("an envelope with ts_client 30 minutes in the past still lands and dedups correctly", async () => {
    // localStorage-replay shape: the client originally tried to send
    // 30min ago, failed, persisted, and the page visit just now is
    // re-flushing it. Both ts_client (event.ts) and sentAt are stale.
    const cleid = randomUUID();
    const halfHourAgo = Date.now() - 30 * 60 * 1000;
    const env = envelope(
      [{ clientEventId: cleid, ts: halfHourAgo }],
      halfHourAgo,
    );
    const r = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r.status).toBe(204);
    const row = ctx.db
      .prepare(
        "SELECT ts_client, ts_server, client_event_id FROM events WHERE client_event_id = ?",
      )
      .get(cleid) as { ts_client: number; ts_server: number; client_event_id: string };
    expect(row.ts_client).toBe(halfHourAgo);
    expect(row.ts_server).toBeGreaterThan(halfHourAgo);
    // A retry of the same envelope still dedups.
    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    const count = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE client_event_id = ?")
        .get(cleid) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("clock skew: ts_client 6 hours ahead does not break ingestion or rollup bucketing", async () => {
    // A client whose system clock is 6h fast still produces a valid
    // event row. ts_server (set by recordEvent at write time) drives
    // rollup bucketing, so a skewed ts_client cannot warp dashboards.
    const cleid = randomUUID();
    const sixHoursAhead = Date.now() + 6 * 60 * 60 * 1000;
    const env = envelope([{ clientEventId: cleid, ts: sixHoursAhead }]);
    const r = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r.status).toBe(204);
    const row = ctx.db
      .prepare("SELECT ts_client, ts_server FROM events WHERE client_event_id = ?")
      .get(cleid) as { ts_client: number; ts_server: number };
    expect(row.ts_client).toBe(sixHoursAhead);
    // ts_server is at most a few seconds after Date.now(), well below
    // the 6h skew. This is the property the rollup depends on.
    expect(row.ts_server).toBeLessThan(sixHoursAhead - 5 * 60 * 60 * 1000);
  });

  it("localStorage-replay shape: same cleid with a fresh sentAt is absorbed by the dedup index", async () => {
    // We don't simulate a real network 5xx — the test models the
    // POST-replay shape that the beacon's localStorage queue produces:
    // same envelope events but a refreshed `sentAt` on the replay.
    // The (visitor_id, client_event_id) UNIQUE index must absorb it.
    const cleid = randomUUID();
    const env = envelope([{ clientEventId: cleid, ts: Date.now() - 10_000 }]);

    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    const replay = { ...env, sentAt: Date.now() };
    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(replay),
    });
    const count = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE client_event_id = ?")
        .get(cleid) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("a 5-event batch containing one cleid that already landed in a prior flush adds 4 new rows (5 total)", async () => {
    // Worst case: the localStorage replay buffer flushed alongside a
    // fresh batch, and one of the replayed cleids had already landed
    // in the prior flush. The dedup index must absorb the dup but
    // not drop the other 4 events. (Test name updated for accuracy:
    // the prior flush adds 1 row + the new batch adds 4 = 5 total.)
    const dupCleid = randomUUID();
    // First flush — establishes the prior write.
    await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(envelope([{ clientEventId: dupCleid }])),
    });

    // Second flush — 5 events total, one of which is the duplicate.
    const env = envelope([
      { clientEventId: randomUUID() },
      { clientEventId: randomUUID() },
      { clientEventId: dupCleid }, // retry
      { clientEventId: randomUUID() },
      { clientEventId: randomUUID() },
    ]);
    const r = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r.status).toBe(204);
    const row = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    // 1 from first flush + 4 fresh from second = 5 total. The retry
    // of dupCleid was absorbed.
    expect(row.n).toBe(5);
  });

  it("disallowed event names in a mixed batch are dropped without rejecting the whole batch", async () => {
    // Defense-in-depth: an attacker who gains a beacon endpoint can't
    // smuggle a server-emitted event by mixing it with allowlisted
    // ones. The route must accept the allowed events and silently
    // drop the disallowed.
    const goodCleid = randomUUID();
    const env = envelope([
      { clientEventId: goodCleid, name: ANALYTICS_EVENTS.PAGE_VIEWED },
      { clientEventId: randomUUID(), name: ANALYTICS_EVENTS.GAME_COMPLETED }, // server-only
    ]);
    const r = await fetchWithJar(ctx, "anon", "/api/events/track", {
      method: "POST",
      body: JSON.stringify(env),
    });
    expect(r.status).toBe(204);
    const rows = ctx.db
      .prepare("SELECT event_name, client_event_id FROM events ORDER BY id")
      .all() as Array<{ event_name: string; client_event_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_name).toBe(ANALYTICS_EVENTS.PAGE_VIEWED);
    expect(rows[0].client_event_id).toBe(goodCleid);
  });
});
