/**
 * Tests for the streamer-bot's STREAMER_TARGET_URL validation.
 *
 * The bot operates the broadcast overlay (`?broadcast=1`), which is
 * blocked on the public price.games domain (Caddy + Express middleware
 * both return 404). Operators must point the bot at the tailnet
 * hostname; this validator catches the misconfiguration at boot.
 */

import { describe, it, expect } from "vitest";
import { resolveTargetUrl, PUBLIC_BROADCAST_HOSTS } from "../src/runner/targetUrl";

describe("resolveTargetUrl", () => {
  it("throws when the env value is undefined", () => {
    expect(() => resolveTargetUrl(undefined)).toThrow(/required/);
  });

  it("throws when the env value is empty / whitespace", () => {
    expect(() => resolveTargetUrl("")).toThrow(/required/);
    expect(() => resolveTargetUrl("   ")).toThrow(/required/);
  });

  it("throws when the env value is not a valid URL", () => {
    expect(() => resolveTargetUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => resolveTargetUrl("just-a-hostname")).toThrow(/not a valid URL/);
  });

  it("throws when pointing at price.games", () => {
    expect(() => resolveTargetUrl("https://price.games")).toThrow(
      /blocked on public hostnames/,
    );
  });

  it("throws when pointing at www.price.games or sandbox.price.games", () => {
    expect(() => resolveTargetUrl("https://www.price.games")).toThrow(
      /blocked on public hostnames/,
    );
    expect(() => resolveTargetUrl("https://sandbox.price.games")).toThrow(
      /blocked on public hostnames/,
    );
  });

  it("matches public hosts case-insensitively", () => {
    expect(() => resolveTargetUrl("https://Price.Games")).toThrow(
      /blocked on public hostnames/,
    );
  });

  it("blocks the trailing-dot FQDN form (https://price.games./)", () => {
    // `new URL("https://price.games./").hostname` parses to
    // "price.games." — without trailing-dot stripping, an operator
    // could silently typo their way into pointing the bot at the
    // public site. DNS resolves both forms identically.
    expect(() => resolveTargetUrl("https://price.games.")).toThrow(
      /blocked on public hostnames/,
    );
    expect(() => resolveTargetUrl("https://www.price.games./")).toThrow(
      /blocked on public hostnames/,
    );
    expect(() => resolveTargetUrl("https://sandbox.price.games.")).toThrow(
      /blocked on public hostnames/,
    );
  });

  it("ignores trailing slashes when validating, and returns the URL without one", () => {
    expect(() => resolveTargetUrl("https://price.games/")).toThrow(
      /blocked on public hostnames/,
    );
    expect(resolveTargetUrl("https://onestreamer.tail-abcd.ts.net/")).toBe(
      "https://onestreamer.tail-abcd.ts.net",
    );
    expect(resolveTargetUrl("https://onestreamer.tail-abcd.ts.net///")).toBe(
      "https://onestreamer.tail-abcd.ts.net",
    );
  });

  it("accepts a tailnet hostname", () => {
    expect(resolveTargetUrl("https://onestreamer.tail-abcd.ts.net")).toBe(
      "https://onestreamer.tail-abcd.ts.net",
    );
  });

  it("accepts a localhost URL (dev / sandbox)", () => {
    expect(resolveTargetUrl("http://localhost:3001")).toBe("http://localhost:3001");
  });

  it("accepts a non-blocklisted public host (operator override)", () => {
    // The validator only blocks the known-blocked hosts. If an operator
    // ever runs the bot against a different deployment (a private mirror,
    // an old domain), the env var is the source of truth.
    expect(resolveTargetUrl("https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
  });

  it("PUBLIC_BROADCAST_HOSTS covers the production + sandbox hostnames", () => {
    // Pin the contract — these names also appear in the Caddyfile and in
    // apps/server/src/middleware/broadcastAccess.ts; a drift between the
    // two layers would silently widen the public surface.
    expect(PUBLIC_BROADCAST_HOSTS.has("price.games")).toBe(true);
    expect(PUBLIC_BROADCAST_HOSTS.has("www.price.games")).toBe(true);
    expect(PUBLIC_BROADCAST_HOSTS.has("sandbox.price.games")).toBe(true);
  });
});
