import { describe, it, expect, beforeEach } from "vitest";
import { isBot, pruneBotVelocity, __resetBotVelocity, BOT_VELOCITY_THRESHOLD } from "./botDetection";

beforeEach(() => {
  __resetBotVelocity();
});

describe("isBot", () => {
  it("catches common bot UAs", () => {
    expect(isBot("Googlebot/2.1", "v1")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "v1")).toBe(true);
    expect(isBot("facebookexternalhit/1.1", "v1")).toBe(true);
    expect(isBot("Slackbot-LinkExpanding 1.0", "v1")).toBe(true);
    expect(isBot("curl/7.88.1", "v1")).toBe(true);
    expect(isBot("GPTBot/1.0", "v1")).toBe(true);
  });

  it("passes real Chrome", () => {
    expect(
      isBot(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "v1",
      ),
    ).toBe(false);
  });

  it("passes real Safari", () => {
    expect(
      isBot(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
        "v1",
      ),
    ).toBe(false);
  });

  it("flags velocity bots when a single visitor exceeds threshold", () => {
    const now = 1_000_000;
    const ua = "Mozilla/5.0 Chrome/120";
    let flagged = false;
    for (let i = 0; i <= BOT_VELOCITY_THRESHOLD + 2; i++) {
      flagged = isBot(ua, "velocity-visitor", now + i);
    }
    expect(flagged).toBe(true);
  });

  it("does not flag when events are spread across a wider window", () => {
    const ua = "Mozilla/5.0 Chrome/120";
    let any = false;
    for (let i = 0; i < 20; i++) {
      any = any || isBot(ua, "slow-visitor", 1_000_000 + i * 5_000);
    }
    expect(any).toBe(false);
  });

  it("returns false with no UA and unknown visitor", () => {
    expect(isBot(null, null)).toBe(false);
    expect(isBot(undefined, undefined)).toBe(false);
  });

  it("pruneBotVelocity clears stale entries", () => {
    isBot("Mozilla/5.0 Chrome/120", "expiring-visitor", 1_000_000);
    pruneBotVelocity(1_000_000 + 2 * 60 * 1000);
    // Second call after prune should not continue incrementing across window.
    expect(isBot("Mozilla/5.0 Chrome/120", "expiring-visitor", 1_000_000 + 2 * 60 * 1000)).toBe(false);
  });
});
