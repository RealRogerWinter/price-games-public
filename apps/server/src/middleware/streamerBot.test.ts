/**
 * Tests for the streamer-bot detection middleware.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  matchesStreamerBotSecret,
  streamerBotDetect,
  detectStreamerBotFromHeaders,
  STREAMER_BOT_HEADER,
} from "./streamerBot";
import { config } from "../config";

function makeReq(headerValue?: string | string[]): Request {
  return {
    headers: headerValue === undefined ? {} : { [STREAMER_BOT_HEADER]: headerValue },
  } as unknown as Request;
}

// `config` is `as const` typed but a plain runtime object. Direct mutation via
// type cast is the simplest way to swap the secret per-test without a full
// module mock; we restore in afterEach to keep tests independent.
function setSecret(value: string): void {
  (config as unknown as { streamerBotSecret: string }).streamerBotSecret = value;
}

describe("matchesStreamerBotSecret", () => {
  it("returns false when the configured secret is empty", () => {
    expect(matchesStreamerBotSecret("anything", "")).toBe(false);
    expect(matchesStreamerBotSecret("", "")).toBe(false);
  });

  it("returns false when the header value is null/undefined/empty", () => {
    expect(matchesStreamerBotSecret(null, "configured-secret")).toBe(false);
    expect(matchesStreamerBotSecret(undefined, "configured-secret")).toBe(false);
    expect(matchesStreamerBotSecret("", "configured-secret")).toBe(false);
  });

  it("returns false on length mismatch (no timing oracle)", () => {
    expect(matchesStreamerBotSecret("short", "much-longer-secret")).toBe(false);
    expect(matchesStreamerBotSecret("much-longer-value", "short")).toBe(false);
  });

  it("returns false on byte-for-byte mismatch of equal-length values", () => {
    expect(matchesStreamerBotSecret("aaaaaaaa", "bbbbbbbb")).toBe(false);
  });

  it("returns true when header byte-equals the configured secret", () => {
    expect(matchesStreamerBotSecret("the-secret-123", "the-secret-123")).toBe(true);
  });
});

describe("detectStreamerBotFromHeaders (shared helper)", () => {
  it("returns false when the header is absent", () => {
    expect(detectStreamerBotFromHeaders({}, "secret-xyz")).toBe(false);
  });

  it("returns true when the string-valued header matches the secret", () => {
    expect(
      detectStreamerBotFromHeaders({ [STREAMER_BOT_HEADER]: "secret-xyz" }, "secret-xyz"),
    ).toBe(true);
  });

  it("uses the first entry of an array-valued header", () => {
    expect(
      detectStreamerBotFromHeaders(
        { [STREAMER_BOT_HEADER]: ["secret-xyz", "ignored"] },
        "secret-xyz",
      ),
    ).toBe(true);
  });

  it("returns false when array's first entry does not match", () => {
    expect(
      detectStreamerBotFromHeaders(
        { [STREAMER_BOT_HEADER]: ["wrong", "secret-xyz"] },
        "secret-xyz",
      ),
    ).toBe(false);
  });

  it("returns false when the secret is empty (fail-closed)", () => {
    expect(
      detectStreamerBotFromHeaders({ [STREAMER_BOT_HEADER]: "anything" }, ""),
    ).toBe(false);
  });
});

describe("streamerBotDetect middleware", () => {
  let next: NextFunction;
  const originalSecret = config.streamerBotSecret;
  beforeEach(() => {
    next = vi.fn();
  });
  afterEach(() => {
    setSecret(originalSecret);
  });

  it("does not set req.isStreamerBot when no header is present", () => {
    setSecret("secret-xyz");
    const req = makeReq();
    streamerBotDetect(req, {} as Response, next);
    expect(req.isStreamerBot).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not set req.isStreamerBot when the header doesn't match", () => {
    setSecret("secret-xyz");
    const req = makeReq("nope");
    streamerBotDetect(req, {} as Response, next);
    expect(req.isStreamerBot).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not set req.isStreamerBot when secret is unset (dev)", () => {
    setSecret("");
    const req = makeReq("anything");
    streamerBotDetect(req, {} as Response, next);
    expect(req.isStreamerBot).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("sets req.isStreamerBot when the header matches the secret", () => {
    setSecret("secret-xyz");
    const req = makeReq("secret-xyz");
    streamerBotDetect(req, {} as Response, next);
    expect(req.isStreamerBot).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it("handles array-valued headers (uses first entry)", () => {
    setSecret("secret-xyz");
    const req = makeReq(["secret-xyz", "ignored"]);
    streamerBotDetect(req, {} as Response, next);
    expect(req.isStreamerBot).toBe(true);
  });
});
