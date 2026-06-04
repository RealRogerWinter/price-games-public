/**
 * Tests for the broadcast-access middleware.
 *
 * Covers the application-layer half of the two-layer guard. The
 * Caddy layer is exercised by manual smoke (curl against the
 * deployed vhost); these tests pin the in-process behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  createDenyPublicBroadcast,
  denyPublicBroadcastFromEnv,
  parseBlockedHosts,
} from "./broadcastAccess";

function makeReq(opts: { hostname?: string; broadcast?: string | string[] }): Request {
  return {
    hostname: opts.hostname ?? "localhost",
    query: opts.broadcast === undefined ? {} : { broadcast: opts.broadcast },
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const end = vi.fn();
  const status = vi.fn(() => ({ end })) as unknown as Response["status"];
  const res = { status, end } as unknown as Response;
  return { res, status: status as unknown as ReturnType<typeof vi.fn>, end };
}

describe("parseBlockedHosts", () => {
  it("includes the production defaults when the env var is unset", () => {
    const set = parseBlockedHosts(undefined);
    expect(set.has("price.games")).toBe(true);
    expect(set.has("www.price.games")).toBe(true);
    expect(set.has("sandbox.price.games")).toBe(true);
  });

  it("includes the defaults when the env var is empty / whitespace", () => {
    expect(parseBlockedHosts("").has("price.games")).toBe(true);
    expect(parseBlockedHosts("   ").has("price.games")).toBe(true);
    expect(parseBlockedHosts(",,").has("price.games")).toBe(true);
  });

  it("merges env values with the defaults (additive, not replace)", () => {
    // Pin the fail-closed semantics: a custom value adds, never removes.
    // A typo in the env var (e.g. dropping `price.games` while adding a
    // mirror) must NOT silently downgrade protection on the defaults.
    const set = parseBlockedHosts(" Foo.Example , bar.example ");
    expect(set.has("foo.example")).toBe(true);
    expect(set.has("bar.example")).toBe(true);
    expect(set.has("price.games")).toBe(true);
    expect(set.has("www.price.games")).toBe(true);
    expect(set.has("sandbox.price.games")).toBe(true);
  });

  it("lowercases env values on parse", () => {
    const set = parseBlockedHosts("FOO.Example");
    expect(set.has("foo.example")).toBe(true);
    expect(set.has("FOO.Example")).toBe(false);
  });
});

describe("denyPublicBroadcast middleware", () => {
  const blocked = new Set(["price.games", "sandbox.price.games"]);

  it("calls next() when the request is not a broadcast request, regardless of host", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "price.games" }), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("404s a broadcast request reaching a blocked host", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, end } = makeRes();

    middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("404s a broadcast request reaching the sandbox host", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "sandbox.price.games", broadcast: "1" }), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows a broadcast request reaching a tailnet host", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(
      makeReq({ hostname: "onestreamer.tail-abcd.ts.net", broadcast: "1" }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("allows a broadcast request from localhost (dev)", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "localhost", broadcast: "1" }), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("treats `broadcast=1` strictly — `?broadcast=true` is not blocked", () => {
    // Mirrors the web-app's own `useBroadcastMode` strict check, so the
    // server can't 404 a request the SPA would have rendered as non-broadcast.
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "price.games", broadcast: "true" }), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("matches case-insensitively on hostname", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "Price.Games", broadcast: "1" }), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("handles repeated broadcast query params (Express yields an array)", () => {
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(
      makeReq({ hostname: "price.games", broadcast: ["1", "1"] }),
      res,
      next,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  describe("BROADCAST_DISABLE_PUBLIC_GATE escape hatch", () => {
    /**
     * Helper: temporarily set process.env entries and restore them
     * after the body. Both `SANDBOX` and `BROADCAST_DISABLE_PUBLIC_GATE`
     * are checked at factory call time, so each test must build the
     * middleware AFTER setting / clearing them.
     */
    function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
      const previous: Record<string, string | undefined> = {};
      for (const k of Object.keys(values)) previous[k] = process.env[k];
      try {
        for (const [k, v] of Object.entries(values)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        fn();
      } finally {
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("disables the gate when both SANDBOX=1 AND BROADCAST_DISABLE_PUBLIC_GATE=1 are set", () => {
      withEnv({ SANDBOX: "1", BROADCAST_DISABLE_PUBLIC_GATE: "1" }, () => {
        const middleware = createDenyPublicBroadcast(blocked);
        const next = vi.fn() as unknown as NextFunction;
        const { res, status } = makeRes();

        // sandbox.price.games is in the default block list — the
        // escape hatch should let the request through.
        middleware(makeReq({ hostname: "sandbox.price.games", broadcast: "1" }), res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(status).not.toHaveBeenCalled();
      });
    });

    it("does NOT disable the gate when only BROADCAST_DISABLE_PUBLIC_GATE=1 is set (SANDBOX missing)", () => {
      // Defence-in-depth: a single env var typo (someone setting
      // BROADCAST_DISABLE_PUBLIC_GATE=1 in a non-sandbox container)
      // must not silently disable the production-default-block list.
      withEnv({ SANDBOX: undefined, BROADCAST_DISABLE_PUBLIC_GATE: "1" }, () => {
        const middleware = createDenyPublicBroadcast(blocked);
        const next = vi.fn() as unknown as NextFunction;
        const { res, status } = makeRes();

        middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);

        expect(status).toHaveBeenCalledWith(404);
        expect(next).not.toHaveBeenCalled();
      });
    });

    it("does NOT disable the gate when only SANDBOX=1 is set (BROADCAST_DISABLE_PUBLIC_GATE missing)", () => {
      // Symmetrical defence: a sandbox container without the explicit
      // disable flag should still respect the gate.
      withEnv({ SANDBOX: "1", BROADCAST_DISABLE_PUBLIC_GATE: undefined }, () => {
        const middleware = createDenyPublicBroadcast(blocked);
        const next = vi.fn() as unknown as NextFunction;
        const { res, status } = makeRes();

        middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);

        expect(status).toHaveBeenCalledWith(404);
        expect(next).not.toHaveBeenCalled();
      });
    });

    it("requires literal '1' for both env vars — 'true' / 'yes' / 'on' do not flip the gate", () => {
      withEnv({ SANDBOX: "true", BROADCAST_DISABLE_PUBLIC_GATE: "true" }, () => {
        const middleware = createDenyPublicBroadcast(blocked);
        const next = vi.fn() as unknown as NextFunction;
        const { res, status } = makeRes();

        middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);

        expect(status).toHaveBeenCalledWith(404);
        expect(next).not.toHaveBeenCalled();
      });
    });
  });

  it("blocks the trailing-dot FQDN form (Host: price.games.)", () => {
    // RFC-style absolute FQDN — DNS resolves it identically to the
    // non-dotted form, and `Set.has("price.games")` would otherwise
    // miss it. The whole point of layer 2 is to backstop layer 1, so
    // this form must NOT slip through.
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "price.games.", broadcast: "1" }), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("normalises mixed-case input sets so direct callers cannot get a no-op", () => {
    // Defensive normalisation inside the factory: someone wiring this
    // up directly with a mixed-case set (e.g. tests, future call site)
    // gets the same behaviour as the env path.
    const middleware = createDenyPublicBroadcast(new Set(["Price.Games"]));
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not throw when req.hostname is missing", () => {
    // Pin the `?? ""` guard. Express has historically always populated
    // req.hostname, but this shouldn't crash if a future upgrade
    // changes that — the safe default is "let it through" (the SPA
    // catch-all serves whatever shell, and the network layer is the
    // real gate).
    const middleware = createDenyPublicBroadcast(blocked);
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();

    middleware(
      makeReq({ hostname: undefined as unknown as string, broadcast: "1" }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});

describe("denyPublicBroadcastFromEnv", () => {
  it("merges BROADCAST_BLOCKED_HOSTS from env with the production defaults", () => {
    const previous = process.env.BROADCAST_BLOCKED_HOSTS;
    process.env.BROADCAST_BLOCKED_HOSTS = "custom.example";
    try {
      const middleware = denyPublicBroadcastFromEnv();

      // Custom host from env is blocked.
      const next = vi.fn() as unknown as NextFunction;
      const { res, status } = makeRes();
      middleware(makeReq({ hostname: "custom.example", broadcast: "1" }), res, next);
      expect(status).toHaveBeenCalledWith(404);

      // Defaults are STILL blocked even when env adds custom entries —
      // the env path is additive, not replace. This pins the
      // fail-closed semantics flagged by the security review (M1).
      const next2 = vi.fn() as unknown as NextFunction;
      const { res: res2, status: status2 } = makeRes();
      middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res2, next2);
      expect(status2).toHaveBeenCalledWith(404);
      expect(next2).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.BROADCAST_BLOCKED_HOSTS;
      else process.env.BROADCAST_BLOCKED_HOSTS = previous;
    }
  });

  it("blocks the production defaults when env is unset", () => {
    const previous = process.env.BROADCAST_BLOCKED_HOSTS;
    delete process.env.BROADCAST_BLOCKED_HOSTS;
    try {
      const middleware = denyPublicBroadcastFromEnv();
      const next = vi.fn() as unknown as NextFunction;
      const { res, status } = makeRes();

      middleware(makeReq({ hostname: "price.games", broadcast: "1" }), res, next);
      expect(status).toHaveBeenCalledWith(404);
    } finally {
      if (previous !== undefined) process.env.BROADCAST_BLOCKED_HOSTS = previous;
    }
  });
});
