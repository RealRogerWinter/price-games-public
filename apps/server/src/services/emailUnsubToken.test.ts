import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The token module hashes with config.emailUnsubSecret. Give it a fixed secret
// so the tests are deterministic and don't rely on env order.
vi.mock("../config", () => ({
  config: {
    emailUnsubSecret: "test-secret-for-unit-tests",
    appUrl: "https://price.games",
  },
}));

import {
  signUnsubToken,
  verifyUnsubToken,
  buildUnsubscribeUrl,
} from "./emailUnsubToken";

describe("signUnsubToken + verifyUnsubToken", () => {
  it("round-trips a valid payload", () => {
    const token = signUnsubToken({ userId: "u1", type: "promotional" });
    const parsed = verifyUnsubToken(token);
    expect(parsed).toEqual({ userId: "u1", type: "promotional" });
  });

  it("rejects a tampered body", () => {
    const token = signUnsubToken({ userId: "u1", type: "promotional" });
    const parts = token.split(".");
    // Flip the payload but keep the signature: should fail the HMAC check.
    const newBody = Buffer.from(
      JSON.stringify({ userId: "attacker", type: "all", iat: Date.now() }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${newBody}.${parts[1]}`;
    expect(verifyUnsubToken(tampered)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyUnsubToken("not.a.token")).toBeNull();
    expect(verifyUnsubToken("nodot")).toBeNull();
    expect(verifyUnsubToken("" as unknown as string)).toBeNull();
  });

  it("rejects an expired token (>90 days)", () => {
    const realNow = Date.now;
    try {
      // Sign with "now" in the past
      Date.now = () => realNow.call(Date) - 100 * 24 * 60 * 60 * 1000;
      const token = signUnsubToken({ userId: "u1", type: "promotional" });
      Date.now = realNow;
      expect(verifyUnsubToken(token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("buildUnsubscribeUrl", () => {
  it("uses the configured appUrl and embeds a token", () => {
    const url = buildUnsubscribeUrl("u1", "promotional");
    expect(url).toMatch(/^https:\/\/price\.games\/api\/email\/unsubscribe\?token=/);
  });
});
