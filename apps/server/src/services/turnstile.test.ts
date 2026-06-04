/**
 * Tests for the Turnstile verification service.
 *
 * Mocks global.fetch and the config module to verify token validation,
 * dev-mode bypass, and error handling behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock config ─────────────────────────────────────────────────────────

vi.mock("../config", () => ({
  config: {
    turnstileSecretKey: "test-secret-key",
  },
}));

import { config } from "../config";
import { verifyTurnstileToken, isTurnstileEnabled } from "./turnstile";

// ── Setup & teardown ────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
const originalSkip = process.env.SKIP_TURNSTILE;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  (config as any).turnstileSecretKey = "test-secret-key";
  delete process.env.SKIP_TURNSTILE;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSkip === undefined) delete process.env.SKIP_TURNSTILE;
  else process.env.SKIP_TURNSTILE = originalSkip;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("verifyTurnstileToken", () => {
  it("returns true when turnstileSecretKey is empty (dev mode skip)", async () => {
    (config as any).turnstileSecretKey = "";

    const result = await verifyTurnstileToken("any-token", "127.0.0.1");

    expect(result).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns true when API returns { success: true }", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const result = await verifyTurnstileToken("valid-token", "192.168.1.1");

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: "test-secret-key",
          response: "valid-token",
          remoteip: "192.168.1.1",
        }),
      }
    );
  });

  it("returns false when API returns { success: false }", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });

    const result = await verifyTurnstileToken("invalid-token", "192.168.1.1");

    expect(result).toBe(false);
  });

  it("returns false when fetch throws an error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const result = await verifyTurnstileToken("some-token", "10.0.0.1");

    expect(result).toBe(false);
  });

  it("returns false when response is not ok (e.g. status 500)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ success: false }),
    });

    const result = await verifyTurnstileToken("some-token", "10.0.0.1");

    expect(result).toBe(false);
  });

  it("returns true (no fetch) when SKIP_TURNSTILE=1 even if secret is set", async () => {
    process.env.SKIP_TURNSTILE = "1";

    const result = await verifyTurnstileToken("any-token", "127.0.0.1");

    expect(result).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isTurnstileEnabled", () => {
  it("is true when a secret is configured and SKIP_TURNSTILE is unset", () => {
    (config as any).turnstileSecretKey = "test-secret-key";
    delete process.env.SKIP_TURNSTILE;
    expect(isTurnstileEnabled()).toBe(true);
  });

  it("is false when no secret is configured", () => {
    (config as any).turnstileSecretKey = "";
    expect(isTurnstileEnabled()).toBe(false);
  });

  it("is false when SKIP_TURNSTILE=1 even if secret is configured", () => {
    (config as any).turnstileSecretKey = "test-secret-key";
    process.env.SKIP_TURNSTILE = "1";
    expect(isTurnstileEnabled()).toBe(false);
  });

  it("is true when SKIP_TURNSTILE has any value other than \"1\"", () => {
    (config as any).turnstileSecretKey = "test-secret-key";
    process.env.SKIP_TURNSTILE = "true";
    expect(isTurnstileEnabled()).toBe(true);
  });
});
