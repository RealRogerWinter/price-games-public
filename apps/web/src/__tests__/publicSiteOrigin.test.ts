/**
 * Tests for getPublicSiteOrigin / getPublicSiteHost.
 *
 * Background: the admin panel is reached over Tailscale, so the QR codes
 * and UTM URLs the panel generates must NOT use `window.location.origin`.
 * The helpers under test centralize that decision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const PUBLIC_SITE_URL_KEY = "VITE_PUBLIC_SITE_URL";

describe("publicSiteOrigin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the canonical price.games origin by default", async () => {
    vi.stubEnv(PUBLIC_SITE_URL_KEY, "");
    const { getPublicSiteOrigin, getPublicSiteHost } = await import(
      "../utils/publicSiteOrigin"
    );
    expect(getPublicSiteOrigin()).toBe("https://price.games");
    expect(getPublicSiteHost()).toBe("price.games");
  });

  it("ignores window.location.origin even when it looks like a Tailscale host", async () => {
    // Stub window.location to a Tailscale-like origin to assert the helper
    // does NOT consult it.
    const original = window.location.origin;
    Object.defineProperty(window, "location", {
      value: { ...window.location, origin: "https://admin-panel.tailnet.ts.net" },
      writable: true,
    });
    try {
      vi.stubEnv(PUBLIC_SITE_URL_KEY, "");
      const { getPublicSiteOrigin } = await import("../utils/publicSiteOrigin");
      const origin = getPublicSiteOrigin();
      expect(origin).toBe("https://price.games");
      expect(origin).not.toContain("ts.net");
    } finally {
      Object.defineProperty(window, "location", {
        value: { ...window.location, origin: original },
        writable: true,
      });
    }
  });

  it("honors VITE_PUBLIC_SITE_URL when set", async () => {
    vi.stubEnv(PUBLIC_SITE_URL_KEY, "https://sandbox.price.games");
    const { getPublicSiteOrigin, getPublicSiteHost } = await import(
      "../utils/publicSiteOrigin"
    );
    expect(getPublicSiteOrigin()).toBe("https://sandbox.price.games");
    expect(getPublicSiteHost()).toBe("sandbox.price.games");
  });

  it("strips a single trailing slash from the env override", async () => {
    vi.stubEnv(PUBLIC_SITE_URL_KEY, "https://sandbox.price.games/");
    const { getPublicSiteOrigin } = await import("../utils/publicSiteOrigin");
    expect(getPublicSiteOrigin()).toBe("https://sandbox.price.games");
  });

  it("falls back to price.games when the env override is malformed", async () => {
    vi.stubEnv(PUBLIC_SITE_URL_KEY, "not-a-valid-url");
    const { getPublicSiteHost } = await import("../utils/publicSiteOrigin");
    // Origin returns the raw string; host parsing fails and falls back.
    expect(getPublicSiteHost()).toBe("price.games");
  });
});
