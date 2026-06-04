/**
 * Tests for the streamer-bot stats relay router.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Request, Response } from "express";
import { createStreamerRouter, _resetStreamerStatsForTest, createSqlitePersistence, parseNnTickPayload } from "./streamer";
import Database from "better-sqlite3";
import { SOCKET_EVENTS } from "@price-game/shared";

interface RouteHandler {
  (req: Request, res: Response, next?: unknown): void;
}
interface RouterLayer {
  route?: { path: string; stack: Array<{ method: string; handle: RouteHandler }> };
}

function pickHandler(router: ReturnType<typeof createStreamerRouter>, method: string, path: string): RouteHandler {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route?.path === path) {
      const postLayers = layer.route.stack.filter((s) => s.method === method);
      if (postLayers.length > 0) return postLayers[postLayers.length - 1].handle;
    }
  }
  throw new Error(`${method.toUpperCase()} ${path} not found on streamer router`);
}

function mockReq(opts: { body?: unknown; isStreamerBot?: boolean }): Request {
  return {
    body: opts.body,
    isStreamerBot: opts.isStreamerBot,
    headers: {},
  } as unknown as Request;
}

function mockRes(): { res: Response; status: number; body: unknown } {
  const state: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, get status() { return state.status; }, get body() { return state.body; } };
}

describe("streamer router", () => {
  beforeEach(() => {
    _resetStreamerStatsForTest();
    vi.clearAllMocks();
  });

  it("GET /stats returns null when nothing has been published", () => {
    const router = createStreamerRouter(null);
    const handler = pickHandler(router, "get", "/stats");
    const ctx = mockRes();
    handler(mockReq({}), ctx.res);
    expect(ctx.body).toEqual({ stats: null });
  });

  it("POST /stats rejects unauthenticated requests with 403", () => {
    const router = createStreamerRouter(null);
    const handler = pickHandler(router, "post", "/stats");
    const ctx = mockRes();
    handler(mockReq({ body: { wins: 1, losses: 0, streak: 1 }, isStreamerBot: false }), ctx.res);
    expect(ctx.status).toBe(403);
  });

  it("POST /stats rejects payloads that aren't shaped like BotStats with 400", () => {
    const router = createStreamerRouter(null);
    const handler = pickHandler(router, "post", "/stats");
    for (const bad of [
      undefined,
      null,
      "not an object",
      { wins: -1, losses: 0, streak: 0 },
      { wins: NaN, losses: 0, streak: 0 },
      { wins: 1, losses: "0", streak: 0 },
      { wins: 1, losses: 0 },
    ]) {
      const ctx = mockRes();
      handler(mockReq({ body: bad, isStreamerBot: true }), ctx.res);
      expect(ctx.status).toBe(400);
    }
  });

  it("POST /stats stores the latest payload and emits over Socket.IO", () => {
    const emit = vi.fn();
    const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
    const router = createStreamerRouter(io);
    const post = pickHandler(router, "post", "/stats");
    const get = pickHandler(router, "get", "/stats");

    const postCtx = mockRes();
    post(
      mockReq({ body: { wins: 5, losses: 2, streak: 3, mood: "happy", winRate: 0.71 }, isStreamerBot: true }),
      postCtx.res,
    );
    expect(postCtx.body).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_STATS, {
      wins: 5,
      losses: 2,
      streak: 3,
      mood: "happy",
      winRate: 0.71,
    });

    const getCtx = mockRes();
    get(mockReq({}), getCtx.res);
    expect(getCtx.body).toMatchObject({
      stats: { wins: 5, losses: 2, streak: 3, mood: "happy", winRate: 0.71 },
    });
  });

  it("POST /stats clamps non-finite winRate and floors fractional counts", () => {
    const router = createStreamerRouter(null);
    const post = pickHandler(router, "post", "/stats");
    const ctx = mockRes();
    post(
      mockReq({ body: { wins: 4.7, losses: 1.2, streak: -2.6, winRate: 99 }, isStreamerBot: true }),
      ctx.res,
    );
    expect(ctx.body).toEqual({ ok: true });
    const getCtx = mockRes();
    pickHandler(router, "get", "/stats")(mockReq({}), getCtx.res);
    expect(getCtx.body).toEqual({
      stats: { wins: 4, losses: 1, streak: -3, winRate: 1 },
    });
  });

  it("POST /stats caps absurdly large counts before fan-out", () => {
    const router = createStreamerRouter(null);
    const post = pickHandler(router, "post", "/stats");
    post(
      mockReq({
        body: { wins: 9_999_999_999, losses: 9_999_999_999, streak: -9_999_999_999 },
        isStreamerBot: true,
      }),
      mockRes().res,
    );
    const getCtx = mockRes();
    pickHandler(router, "get", "/stats")(mockReq({}), getCtx.res);
    expect(getCtx.body).toEqual({
      stats: { wins: 1_000_000, losses: 1_000_000, streak: -1_000_000 },
    });
  });

  it("POST /stats drops unknown mood values silently rather than persisting them", () => {
    const router = createStreamerRouter(null);
    const post = pickHandler(router, "post", "/stats");
    const ctx = mockRes();
    post(
      mockReq({ body: { wins: 1, losses: 0, streak: 1, mood: "evil-laugh" }, isStreamerBot: true }),
      ctx.res,
    );
    expect(ctx.body).toEqual({ ok: true });
    const getCtx = mockRes();
    pickHandler(router, "get", "/stats")(mockReq({}), getCtx.res);
    expect(getCtx.body).toEqual({
      stats: { wins: 1, losses: 0, streak: 1 },
    });
  });

  describe("STREAMER_MOOD_DEBUG", () => {
    // Diagnostic env-flag: when set, log only when the bot's reported
    // mood changes between consecutive POSTs. Per-push logging would
    // flood prod stdout for a decorative field; transition-only gives
    // the same signal at ~1 line per minute.
    const originalFlag = process.env.STREAMER_MOOD_DEBUG;

    beforeEach(() => {
      process.env.STREAMER_MOOD_DEBUG = "1";
    });

    afterAll(() => {
      if (originalFlag === undefined) delete process.env.STREAMER_MOOD_DEBUG;
      else process.env.STREAMER_MOOD_DEBUG = originalFlag;
    });

    it("logs only when mood transitions (not on every POST)", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/stats");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      // First POST: mood goes from null → happy → one log line.
      post(mockReq({ body: { wins: 1, losses: 0, streak: 1, mood: "happy" }, isStreamerBot: true }), mockRes().res);
      expect(log).toHaveBeenCalledTimes(1);
      expect((log.mock.calls[0][0] as string)).toMatch(/null → happy/);

      // Second POST with same mood: no new log line.
      post(mockReq({ body: { wins: 2, losses: 0, streak: 2, mood: "happy" }, isStreamerBot: true }), mockRes().res);
      expect(log).toHaveBeenCalledTimes(1);

      // Third POST flips mood: another log line.
      post(mockReq({ body: { wins: 2, losses: 1, streak: -1, mood: "frustrated" }, isStreamerBot: true }), mockRes().res);
      expect(log).toHaveBeenCalledTimes(2);
      expect((log.mock.calls[1][0] as string)).toMatch(/happy → frustrated/);

      log.mockRestore();
    });

    it("stays silent when STREAMER_MOOD_DEBUG is unset", () => {
      delete process.env.STREAMER_MOOD_DEBUG;
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/stats");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      post(mockReq({ body: { wins: 1, losses: 0, streak: 1, mood: "happy" }, isStreamerBot: true }), mockRes().res);
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  describe("/music", () => {
    it("GET /music returns null when nothing has been published", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "get", "/music")(mockReq({}), ctx.res);
      expect(ctx.body).toEqual({ music: null });
    });

    it("POST /music rejects unauthenticated callers with 403", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "post", "/music")(
        mockReq({ body: { title: "Coffee Shop" }, isStreamerBot: false }),
        ctx.res,
      );
      expect(ctx.status).toBe(403);
    });

    it("POST /music rejects malformed bodies with 400", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/music");
      for (const bad of [
        undefined,
        "string-body",
        { title: "" },
        { artist: "no title" },
        { title: 42 },
        // Defence-in-depth: oversized title rejected so a single bad
        // payload can't balloon into the Socket.IO fan-out.
        { title: "x".repeat(201) },
      ]) {
        const ctx = mockRes();
        post(mockReq({ body: bad, isStreamerBot: true }), ctx.res);
        expect(ctx.status).toBe(400);
      }
    });

    it("POST /music drops oversized artist/album fields silently rather than rejecting the whole payload", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/music");
      const ctx = mockRes();
      post(
        mockReq({
          body: { title: "Coffee Shop", artist: "x".repeat(500), album: "y".repeat(500) },
          isStreamerBot: true,
        }),
        ctx.res,
      );
      expect(ctx.body).toEqual({ ok: true });
      const getCtx = mockRes();
      pickHandler(router, "get", "/music")(mockReq({}), getCtx.res);
      // Oversized optional fields are dropped; the title-only track
      // still surfaces so the MusicTicker isn't blanked by a single
      // bad metadata field.
      expect(getCtx.body).toEqual({ music: { title: "Coffee Shop" } });
    });

    it("POST /music stores the latest track and emits over Socket.IO", () => {
      const emit = vi.fn();
      const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
      const router = createStreamerRouter(io);
      const ctx = mockRes();
      pickHandler(router, "post", "/music")(
        mockReq({
          body: { title: "Coffee Shop", artist: "Lofi Girl", album: "Loops" },
          isStreamerBot: true,
        }),
        ctx.res,
      );
      expect(ctx.body).toEqual({ ok: true });
      expect(emit).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_MUSIC, {
        title: "Coffee Shop",
        artist: "Lofi Girl",
        album: "Loops",
      });
      const getCtx = mockRes();
      pickHandler(router, "get", "/music")(mockReq({}), getCtx.res);
      expect(getCtx.body).toEqual({
        music: { title: "Coffee Shop", artist: "Lofi Girl", album: "Loops" },
      });
    });

    it("POST /music with a null body clears the cache and emits null (queue stopped)", () => {
      const emit = vi.fn();
      const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
      const router = createStreamerRouter(io);
      // Seed a track first.
      pickHandler(router, "post", "/music")(
        mockReq({ body: { title: "Coffee Shop" }, isStreamerBot: true }),
        mockRes().res,
      );
      const ctx = mockRes();
      pickHandler(router, "post", "/music")(
        mockReq({ body: null, isStreamerBot: true }),
        ctx.res,
      );
      expect(ctx.body).toEqual({ ok: true });
      expect(emit).toHaveBeenLastCalledWith(SOCKET_EVENTS.STREAMER_BOT_MUSIC, null);
      const getCtx = mockRes();
      pickHandler(router, "get", "/music")(mockReq({}), getCtx.res);
      expect(getCtx.body).toEqual({ music: null });
    });
  });

  describe("persistence", () => {
    // Why these tests: the in-memory cache evaporates on every
    // server restart (deploy, OOM, container kill). Without
    // persistence the broadcast panel reverts to zeros / null
    // until the next bot round / track-change — typically minutes
    // later. The SQLite singleton row keeps the last-known values
    // available immediately on the next boot.

    function createInMemoryDb(): Database.Database {
      const db = new Database(":memory:");
      // Mirror migrations v68 + v70 — the production DB runs the
      // migrations before the router is built, so the test DB must
      // have the columns in place too. (v70 added mood_json /
      // mood_updated_at; we declare them here directly rather than
      // running an ALTER so the create stays atomic.)
      db.exec(`
        CREATE TABLE IF NOT EXISTS streamer_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          stats_json TEXT,
          music_json TEXT,
          mood_json TEXT,
          stats_updated_at INTEGER,
          music_updated_at INTEGER,
          mood_updated_at INTEGER
        );
        INSERT OR IGNORE INTO streamer_state (id) VALUES (1);
      `);
      return db;
    }

    it("POST writes through to SQLite so the cache survives a router rebuild", () => {
      const db = createInMemoryDb();
      const persistence = createSqlitePersistence(db);
      const r1 = createStreamerRouter(null, persistence);
      pickHandler(r1, "post", "/stats")(
        mockReq({ body: { wins: 7, losses: 2, streak: 3, mood: "happy", winRate: 0.78 }, isStreamerBot: true }),
        mockRes().res,
      );
      pickHandler(r1, "post", "/music")(
        mockReq({ body: { title: "Coffee Shop", artist: "Lofi Girl" }, isStreamerBot: true }),
        mockRes().res,
      );

      // Simulate a fresh process: clear the module-level cache and
      // build a new router off the same DB. The hydrate path on
      // construction must restore the previous values.
      _resetStreamerStatsForTest();
      const r2 = createStreamerRouter(null, persistence);
      const sCtx = mockRes();
      pickHandler(r2, "get", "/stats")(mockReq({}), sCtx.res);
      expect(sCtx.body).toMatchObject({
        stats: { wins: 7, losses: 2, streak: 3, mood: "happy" },
      });
      const mCtx = mockRes();
      pickHandler(r2, "get", "/music")(mockReq({}), mCtx.res);
      expect(mCtx.body).toEqual({ music: { title: "Coffee Shop", artist: "Lofi Girl" } });

      db.close();
    });

    it("re-validates persisted payloads on hydrate so a corrupt row can't poison the IO emit", () => {
      // A future schema bump or a hand-edit could leave a row that
      // doesn't match `parseStatsPayload`. The hydrate path must
      // drop those instead of trusting the JSON.
      const db = createInMemoryDb();
      db.prepare("UPDATE streamer_state SET stats_json = ? WHERE id = 1").run(
        JSON.stringify({ wins: -1, losses: 0, streak: 0 }),
      );
      db.prepare("UPDATE streamer_state SET music_json = ? WHERE id = 1").run(
        JSON.stringify({ title: "" }),
      );
      const persistence = createSqlitePersistence(db);
      _resetStreamerStatsForTest();
      const router = createStreamerRouter(null, persistence);
      const sCtx = mockRes();
      pickHandler(router, "get", "/stats")(mockReq({}), sCtx.res);
      expect(sCtx.body).toEqual({ stats: null });
      const mCtx = mockRes();
      pickHandler(router, "get", "/music")(mockReq({}), mCtx.res);
      expect(mCtx.body).toEqual({ music: null });
      db.close();
    });

    it("createSqlitePersistence swallows DB errors so a broken disk doesn't block POST responses", () => {
      // Decorative state shouldn't gate the live broadcast on
      // filesystem health. The Sqlite wrapper logs and continues
      // when prepare() / run() throws (disk full, locked, etc.) so
      // the in-memory cache + Socket.IO fan-out still proceed.
      const broken = {
        prepare(_sql: string) {
          throw new Error("disk full");
        },
      } as unknown as Database.Database;
      const persistence = createSqlitePersistence(broken);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // No throws despite every method hitting prepare() failure.
        expect(() => persistence.load()).not.toThrow();
        expect(() => persistence.saveStats({ wins: 1, losses: 0, streak: 1 })).not.toThrow();
        expect(() => persistence.saveMusic({ title: "x" })).not.toThrow();
        expect(() => persistence.saveMood({ mood: "happy", vibe: 1, morale: 0, streak: 2 })).not.toThrow();
        // The first call goes through `load()` which returns null/null/null
        // on error — this is the behaviour the route relies on to
        // keep going.
        expect(persistence.load()).toEqual({ stats: null, music: null, mood: null });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("/nn-tick", () => {
    function fixtureTick(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        roundId: "r-1",
        phase: "result",
        network: {
          layers: [
            { name: "input", activations: [0.1, 0.2], mostActiveIdx: 1, mostActiveTrail: [0, 0] },
            { name: "trunk-hidden", activations: [0.3, -0.1], mostActiveIdx: 0, mostActiveTrail: [0, 0] },
          ],
          weightSamples: [{ fromLayer: 0, fromIdx: 0, toLayer: 1, toIdx: 0, weight: 0.5 }],
        },
        prediction: { cents: 1234, sigma: 200 },
        belief: {
          topCategory: { id: 3, name: "Electronics", prob: 0.7 },
          brandTier: { tier: "mid", prob: 0.6, gated: false },
          topFeatures: [{ name: "tok_pro", contribution: 0.4 }],
        },
        embedding2d: { x: 0.1, y: -0.2 },
        recentLosses: [0.5, 0.4, 0.3],
        recentAccuracy: ["within10", "miss", "within25"],
        teachingMoment: { triggered: false },
        ageMs: 12,
        ...overrides,
      };
    }

    it("GET /nn-tick returns null before any push", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "get", "/nn-tick")(mockReq({}), ctx.res);
      expect(ctx.body).toEqual({ tick: null });
    });

    it("POST /nn-tick rejects unauthenticated callers with 403", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "post", "/nn-tick")(mockReq({ body: fixtureTick() }), ctx.res);
      expect(ctx.status).toBe(403);
    });

    it("POST /nn-tick rejects malformed bodies with 400", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/nn-tick");
      const cases: unknown[] = [
        null,
        {},
        { roundId: "x" },
        { roundId: "", phase: "idle", network: { layers: [] }, prediction: { cents: 0, sigma: 0 }, belief: {}, embedding2d: {}, recentLosses: [], recentAccuracy: [], teachingMoment: {} },
        { ...fixtureTick(), phase: "weird" },
      ];
      for (const body of cases) {
        const ctx = mockRes();
        post(mockReq({ body, isStreamerBot: true }), ctx.res);
        expect(ctx.status).toBe(400);
      }
    });

    it("POST /nn-tick stores the latest payload and emits over Socket.IO", () => {
      const emit = vi.fn();
      const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
      const router = createStreamerRouter(io);
      const ctx = mockRes();
      pickHandler(router, "post", "/nn-tick")(
        mockReq({ body: fixtureTick(), isStreamerBot: true }),
        ctx.res,
      );
      expect(ctx.status).toBe(200);
      expect(emit).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, expect.objectContaining({ roundId: "r-1" }));
      const getCtx = mockRes();
      pickHandler(router, "get", "/nn-tick")(mockReq({}), getCtx.res);
      expect(getCtx.body).toMatchObject({ tick: { roundId: "r-1", prediction: { cents: 1234 } } });
    });

    it("POST /nn-tick caps oversized arrays before fan-out", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/nn-tick");
      const ctx = mockRes();
      const giant = fixtureTick({
        recentLosses: Array.from({ length: 500 }, (_, i) => i * 0.001),
        recentAccuracy: Array.from({ length: 500 }, () => "miss" as const),
        network: {
          layers: Array.from({ length: 50 }, (_, i) => ({
            name: `L${i}`,
            activations: Array.from({ length: 200 }, () => 0.1),
            mostActiveIdx: 0,
            mostActiveTrail: [0, 0],
          })),
          weightSamples: Array.from({ length: 1000 }, (_, i) => ({
            fromLayer: 0,
            fromIdx: 0,
            toLayer: 1,
            toIdx: 0,
            weight: i,
          })),
        },
      });
      post(mockReq({ body: giant, isStreamerBot: true }), ctx.res);
      expect(ctx.status).toBe(200);
      const getCtx = mockRes();
      pickHandler(router, "get", "/nn-tick")(mockReq({}), getCtx.res);
      const tick = (getCtx.body as { tick: { recentLosses: number[]; recentAccuracy: unknown[]; network: { layers: unknown[]; weightSamples: unknown[] } } }).tick;
      expect(tick.recentLosses.length).toBeLessThanOrEqual(60);
      expect(tick.recentAccuracy.length).toBeLessThanOrEqual(16);
      expect(tick.network.layers.length).toBeLessThanOrEqual(8);
      expect(tick.network.weightSamples.length).toBeLessThanOrEqual(256);
    });

    it("parseNnTickPayload drops invalid entries silently", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        recentAccuracy: ["within10", "garbage", null, "miss"],
        belief: {
          // Stale topCategory / brandTier should be silently dropped
          // (PR-4 belief shape is just topFeatures + optional sentence).
          topCategory: { id: 1, name: "x", prob: 0.5 },
          brandTier: { tier: "wat", prob: 0.5, gated: false },
          topFeatures: [{ name: "ok", contribution: 0.1 }, { name: "", contribution: 0.2 }],
        },
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.recentAccuracy).toEqual(["within10", "miss"]);
      expect(parsed?.belief.topFeatures.length).toBe(1);
      expect(parsed?.belief.topFeatures[0].name).toBe("ok");
    });

    it("forwards priceCandidates when present + drops out-of-range entries", () => {
      // Trust-boundary validation for PR #3: bot POSTs a list of
      // (cents, prob) pairs from the priceClassHead softmax. The
      // server clips at MAX_PRICE_CANDIDATES, drops entries whose
      // cents are non-finite/negative/over-cap or whose prob is
      // outside [0, 1] — without this, a malformed bot payload could
      // push odd values into the broadcast overlay's render.
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        priceCandidates: [
          { cents: 999, prob: 0.62 },          // ok
          { cents: 1299, prob: 0.18 },          // ok
          { cents: -1, prob: 0.1 },             // dropped: negative cents
          { cents: 1e15, prob: 0.05 },          // dropped: over MAX_PRICE_CANDIDATE_CENTS
          { cents: 500, prob: 1.5 },            // dropped: prob > 1
          { cents: 600, prob: -0.1 },           // dropped: prob < 0
          { cents: Number.NaN, prob: 0.1 },     // dropped: NaN cents
          { cents: 700, prob: Number.POSITIVE_INFINITY }, // dropped: non-finite prob
          "garbage",                            // dropped: not an object
          null,                                 // dropped: nullish
        ],
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.priceCandidates).toEqual([
        { cents: 999, prob: 0.62 },
        { cents: 1299, prob: 0.18 },
      ]);
    });

    it("priceCandidates with all-invalid entries collapses to undefined", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        priceCandidates: [{ cents: -1, prob: 2 }, { cents: NaN, prob: 0.5 }],
      });
      expect(parsed?.priceCandidates).toBeUndefined();
    });

    it("missing priceCandidates leaves the field undefined (PR-2-era ticks)", () => {
      const parsed = parseNnTickPayload(fixtureTick());
      expect(parsed?.priceCandidates).toBeUndefined();
    });

    it("priceCandidates is capped at MAX_PRICE_CANDIDATES (16)", () => {
      const big: Array<{ cents: number; prob: number }> = [];
      for (let i = 0; i < 50; i++) big.push({ cents: 100 + i, prob: 0.01 });
      const parsed = parseNnTickPayload({ ...fixtureTick(), priceCandidates: big });
      expect(parsed?.priceCandidates?.length).toBe(16);
    });

    it("forwards the optional belief.sentence", () => {
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/nn-tick");
      const ctx = mockRes();
      post(
        mockReq({
          isStreamerBot: true,
          body: {
            roundId: "r-sent",
            phase: "result",
            network: { layers: [{ name: "x", activations: [], mostActiveIdx: 0, mostActiveTrail: [0, 0] }], weightSamples: [] },
            prediction: { cents: 100, sigma: 10 },
            belief: {
              topCategory: { id: 0, name: "Books", prob: 0.5 },
              brandTier: { tier: "mid", prob: 0.5, gated: false },
              topFeatures: [],
              sentence: "Reads like Books: pro and wireless both pulling up.",
            },
            embedding2d: { x: 0, y: 0 },
            recentLosses: [],
            recentAccuracy: [],
            teachingMoment: { triggered: false },
            ageMs: 1,
          },
        }),
        ctx.res,
      );
      expect(ctx.status).toBe(200);
      const getCtx = mockRes();
      pickHandler(router, "get", "/nn-tick")(mockReq({}), getCtx.res);
      const tick = (getCtx.body as { tick: { belief: { sentence?: string } } }).tick;
      expect(tick.belief.sentence).toMatch(/Reads like Books/i);
    });

    /* health block — feeds the NeuralDebugHud "training" column */

    function fixtureHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        round: 142,
        loss: 0.83,
        gradNormP95: 0.42,
        learningRate: 8.5e-4,
        warmupStep: 142,
        warmupTotal: 200,
        bufferSize: 384,
        bufferCapacity: 512,
        batchSize: 16,
        stepsPerRound: 6,
        goldenMAE: 214,
        snapshotAgeMs: 42_000,
        teachingMomentsCount: 3,
        nanRollbacks: 0,
        frozen: false,
        ...overrides,
      };
    }

    it("forwards a well-formed health block", () => {
      const parsed = parseNnTickPayload({ ...fixtureTick(), health: fixtureHealth() });
      expect(parsed?.health).toMatchObject({
        round: 142,
        loss: 0.83,
        gradNormP95: 0.42,
        learningRate: 8.5e-4,
        bufferSize: 384,
        bufferCapacity: 512,
        goldenMAE: 214,
        snapshotAgeMs: 42_000,
        frozen: false,
      });
    });

    it("clamps negative numeric health fields to zero", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        health: fixtureHealth({ gradNormP95: -1, learningRate: -0.001, snapshotAgeMs: -5 }),
      });
      expect(parsed?.health?.gradNormP95).toBe(0);
      expect(parsed?.health?.learningRate).toBe(0);
      expect(parsed?.health?.snapshotAgeMs).toBe(0);
    });

    it("preserves loss=null and goldenMAE=null on the wire (no update / no eval yet)", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        health: fixtureHealth({ loss: null, goldenMAE: null }),
      });
      expect(parsed?.health?.loss).toBeNull();
      expect(parsed?.health?.goldenMAE).toBeNull();
    });

    it.each([
      ["round", "x"],
      ["round", Number.NaN],
      ["gradNormP95", "0.42"],
      ["bufferSize", null],
      ["batchSize", undefined],
      ["snapshotAgeMs", Number.POSITIVE_INFINITY],
    ])("drops the entire health block when %s is %p", (field, badValue) => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        health: fixtureHealth({ [field]: badValue }),
      });
      // Tick still parses; only the optional health block is dropped.
      expect(parsed).not.toBeNull();
      expect(parsed?.health).toBeUndefined();
    });

    it("treats only frozen===true as frozen (string 'true' / 1 are not coerced)", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        health: fixtureHealth({ frozen: "true" as unknown as boolean }),
      });
      expect(parsed?.health?.frozen).toBe(false);
    });

    it("ignores a non-object health payload without rejecting the tick", () => {
      const parsed = parseNnTickPayload({
        ...fixtureTick(),
        health: "not an object" as unknown as Record<string, unknown>,
      });
      expect(parsed).not.toBeNull();
      expect(parsed?.health).toBeUndefined();
    });
  });

  describe("/reset-learning", () => {
    it("rejects unauthenticated callers with 403", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "post", "/reset-learning")(mockReq({}), ctx.res);
      expect(ctx.status).toBe(403);
    });

    it("clears latestNnTick + emits a null fan-out", () => {
      const emit = vi.fn();
      const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
      const router = createStreamerRouter(io);
      // Seed cache with a valid tick.
      const post = pickHandler(router, "post", "/nn-tick");
      const ctx0 = mockRes();
      post(
        mockReq({
          isStreamerBot: true,
          body: {
            roundId: "r1",
            phase: "result",
            network: { layers: [{ name: "x", activations: [], mostActiveIdx: 0, mostActiveTrail: [0, 0] }], weightSamples: [] },
            prediction: { cents: 100, sigma: 10 },
            belief: {
              topCategory: { id: 0, name: "x", prob: 0.5 },
              brandTier: { tier: "mid", prob: 0.5, gated: false },
              topFeatures: [],
            },
            embedding2d: { x: 0, y: 0 },
            recentLosses: [],
            recentAccuracy: [],
            teachingMoment: { triggered: false },
            ageMs: 1,
          },
        }),
        ctx0.res,
      );
      expect(ctx0.status).toBe(200);

      const ctx = mockRes();
      pickHandler(router, "post", "/reset-learning")(
        mockReq({ isStreamerBot: true }),
        ctx.res,
      );
      expect(ctx.status).toBe(200);
      expect(emit).toHaveBeenLastCalledWith(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, null);
      const getCtx = mockRes();
      pickHandler(router, "get", "/nn-tick")(mockReq({}), getCtx.res);
      expect((getCtx.body as { tick: unknown }).tick).toBeNull();
    });
  });

  describe("/mood", () => {
    it("GET /mood returns null when nothing has been published", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "get", "/mood")(mockReq({}), ctx.res);
      expect(ctx.body).toEqual({ mood: null });
    });

    it("POST /mood rejects unauthenticated requests with 403", () => {
      const router = createStreamerRouter(null);
      const ctx = mockRes();
      pickHandler(router, "post", "/mood")(
        mockReq({ body: { mood: "happy", vibe: 1, morale: 0, streak: 1 }, isStreamerBot: false }),
        ctx.res,
      );
      expect(ctx.status).toBe(403);
    });

    it("POST /mood rejects malformed payloads with 400", () => {
      const router = createStreamerRouter(null);
      const handler = pickHandler(router, "post", "/mood");
      for (const bad of [
        undefined,
        null,
        "not an object",
        { mood: "evil-laugh", vibe: 0, morale: 0, streak: 0 }, // unknown mood
        { mood: "happy", vibe: NaN, morale: 0, streak: 0 },     // non-finite vibe
        { mood: "happy", vibe: 0, morale: "high", streak: 0 },  // wrong type
        { mood: "happy", vibe: 0, morale: 0 },                  // missing streak
        {},
      ]) {
        const ctx = mockRes();
        handler(mockReq({ body: bad, isStreamerBot: true }), ctx.res);
        expect(ctx.status, `should reject ${JSON.stringify(bad)}`).toBe(400);
      }
    });

    it("POST /mood stores the snapshot and emits STREAMER_BOT_MOOD with the parsed payload", () => {
      const emit = vi.fn();
      const io = { emit } as unknown as Parameters<typeof createStreamerRouter>[0];
      const router = createStreamerRouter(io);
      const post = pickHandler(router, "post", "/mood");
      const get = pickHandler(router, "get", "/mood");

      const postCtx = mockRes();
      post(
        mockReq({
          body: { mood: "elated", vibe: 2.5, morale: 0.6, streak: 4, updatedAt: 1700000000000 },
          isStreamerBot: true,
        }),
        postCtx.res,
      );
      expect(postCtx.body).toEqual({ ok: true });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(SOCKET_EVENTS.STREAMER_BOT_MOOD, {
        mood: "elated",
        vibe: 2.5,
        morale: 0.6,
        streak: 4,
        updatedAt: 1700000000000,
      });

      const getCtx = mockRes();
      get(mockReq({}), getCtx.res);
      expect(getCtx.body).toMatchObject({
        mood: { mood: "elated", vibe: 2.5, morale: 0.6, streak: 4 },
      });
    });

    it("POST /mood clamps vibe / morale / streak to engine bounds (instead of rejecting)", () => {
      // Engine clamps internally too — accepting and clamping here
      // means a transient bug in the runner can't permanently silence
      // mood emits while the route returns 400 for every push.
      const router = createStreamerRouter(null);
      const post = pickHandler(router, "post", "/mood");
      post(
        mockReq({
          body: { mood: "frustrated", vibe: -99, morale: 5, streak: 1e15 },
          isStreamerBot: true,
        }),
        mockRes().res,
      );
      const getCtx = mockRes();
      pickHandler(router, "get", "/mood")(mockReq({}), getCtx.res);
      expect(getCtx.body).toEqual({
        mood: { mood: "frustrated", vibe: -3, morale: 1, streak: 1_000_000 },
      });
    });

    it("persistence: POST /mood writes through and hydrates after a router rebuild", () => {
      const Database = (require("better-sqlite3") as typeof import("better-sqlite3"));
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE IF NOT EXISTS streamer_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          stats_json TEXT,
          music_json TEXT,
          mood_json TEXT,
          stats_updated_at INTEGER,
          music_updated_at INTEGER,
          mood_updated_at INTEGER
        );
        INSERT OR IGNORE INTO streamer_state (id) VALUES (1);
      `);
      const persistence = createSqlitePersistence(db);
      const r1 = createStreamerRouter(null, persistence);
      pickHandler(r1, "post", "/mood")(
        mockReq({ body: { mood: "confident", vibe: 0.5, morale: 0.4, streak: 3 }, isStreamerBot: true }),
        mockRes().res,
      );
      _resetStreamerStatsForTest();
      const r2 = createStreamerRouter(null, persistence);
      const ctx = mockRes();
      pickHandler(r2, "get", "/mood")(mockReq({}), ctx.res);
      expect(ctx.body).toMatchObject({
        mood: { mood: "confident", vibe: 0.5, morale: 0.4, streak: 3 },
      });
      db.close();
    });
  });
});
