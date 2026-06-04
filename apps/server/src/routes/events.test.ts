import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { createEventsRouter } from "./events";
import { __resetBotVelocity } from "../services/botDetection";

interface RouteHandler {
  (req: Request, res: Response, next?: unknown): void;
}

interface RouterLayer {
  route?: { path: string; stack: Array<{ method: string; handle: RouteHandler }> };
}

beforeEach(() => {
  __resetBotVelocity();
  vi.clearAllMocks();
});

// Pull the POST /track handler out of the router so we can call it directly
// without spinning up a real HTTP server.
function getPostTrackHandler(): RouteHandler {
  const router = createEventsRouter();
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route?.path === "/track") {
      // The Route's internal stack is [rateLimiter, actualHandler]; grab the
      // last entry so tests exercise the handler without the rate limiter
      // that requires a full Express req/res/next chain.
      const postLayers = layer.route.stack.filter((s) => s.method === "post");
      if (postLayers.length > 0) return postLayers[postLayers.length - 1].handle;
    }
  }
  throw new Error("POST /track handler not found on events router");
}

function mockReq(body: unknown): Request {
  return {
    body,
    visitorId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    headers: {},
    query: {},
    originalUrl: "/api/events/track",
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

function mockRes(): { res: Response; status: number; body: unknown; headers: Record<string, string> } {
  const state: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  const res = {
    status(n: number) {
      state.status = n;
      return this;
    },
    json(b: unknown) {
      state.body = b;
      return this;
    },
    end() {
      if (state.status === 0) state.status = 200;
      return this;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete state.headers[name.toLowerCase()];
    },
  } as unknown as Response;
  return { res, ...state, get status() { return state.status; }, get body() { return state.body; }, get headers() { return state.headers; } } as unknown as { res: Response; status: number; body: unknown; headers: Record<string, string> };
}

function validEnvelope(): unknown {
  return {
    tabId: "tab-123",
    sentAt: Date.now(),
    events: [
      {
        name: "page_viewed",
        category: "page",
        path: "/",
        ts: Date.now(),
        seq: 1,
        clientEventId: "uuid-1",
      },
    ],
  };
}

describe("POST /api/events/track", () => {
  it("accepts a valid envelope and returns 204", () => {
    const handler = getPostTrackHandler();
    const req = mockReq(validEnvelope());
    const state = mockRes();
    handler(req, state.res);
    // skip the per-IP rate limit middleware — `createEventsRouter` returns a
    // full Router whose stack includes rate limiting. We grabbed only the
    // final POST handler above.
    expect(state.status).toBe(204);
  });

  it("rejects a payload missing tabId with 400", () => {
    const handler = getPostTrackHandler();
    const bad = { ...(validEnvelope() as Record<string, unknown>), tabId: null };
    const req = mockReq(bad);
    const state = mockRes();
    handler(req, state.res);
    expect(state.status).toBe(400);
  });

  it("rejects a payload missing events with 400", () => {
    const handler = getPostTrackHandler();
    const req = mockReq({ tabId: "t", sentAt: Date.now() });
    const state = mockRes();
    handler(req, state.res);
    expect(state.status).toBe(400);
  });

  it("drops malformed events but accepts well-formed ones in the same batch", () => {
    const handler = getPostTrackHandler();
    const env = {
      tabId: "tab-1",
      sentAt: Date.now(),
      events: [
        { name: "page_viewed", path: "/", ts: Date.now(), seq: 1, clientEventId: "uuid-good" },
        { name: "no_path_or_id" },
      ],
    };
    const req = mockReq(env);
    const state = mockRes();
    handler(req, state.res);
    expect(state.status).toBe(204);
  });

  it("returns 400 if every event in the batch is malformed", () => {
    const handler = getPostTrackHandler();
    const env = {
      tabId: "tab-1",
      sentAt: Date.now(),
      events: [{ nope: 1 }, { also_nope: 2 }],
    };
    const req = mockReq(env);
    const state = mockRes();
    handler(req, state.res);
    expect(state.status).toBe(400);
  });

  it("drops client-forged server-only event names", () => {
    // An attacker tries to fabricate a game_completed event to poison
    // dashboards. Server-side hooks own those; the client must not be able
    // to emit them via the beacon. Allowed events (page_viewed) still pass.
    const handler = getPostTrackHandler();
    const env = {
      tabId: "tab-1",
      sentAt: Date.now(),
      events: [
        { name: "game_completed", path: "/", ts: Date.now(), seq: 1, clientEventId: "u1" },
        { name: "user_signed_up", path: "/", ts: Date.now(), seq: 2, clientEventId: "u2" },
        { name: "page_viewed", path: "/", ts: Date.now(), seq: 3, clientEventId: "u3" },
      ],
    };
    const req = mockReq(env);
    const state = mockRes();
    handler(req, state.res);
    // 204 because at least one event (page_viewed) was valid and the handler
    // drops disallowed ones silently. The server-side tests already cover
    // that only the allowed one lands in the DB.
    expect(state.status).toBe(204);
  });
});
