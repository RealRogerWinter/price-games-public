import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Re-imported in each test to reset module-level state (loaded flag).
let redditPixel: typeof import("../utils/redditPixel");

/** Grant analytics consent in localStorage so loadRedditPixel injects the
 * script eagerly at startup (mirrors a returning visitor). */
function seedConsented() {
  localStorage.setItem(
    "cookie_consent",
    JSON.stringify({ consented: true, necessary: true, analytics: true }),
  );
}

describe("redditPixel", () => {
  beforeEach(async () => {
    // Clean up any state left over from previous tests
    delete (window as Partial<Window> & { rdt?: unknown }).rdt;
    document.head
      .querySelectorAll("script[src*='redditstatic.com']")
      .forEach((s) => s.remove());
    localStorage.clear();

    // requestIdleCallback isn't implemented in jsdom — polyfill to fire
    // synchronously so tests can observe its effects without waiting.
    (window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
    }).requestIdleCallback = (cb: () => void) => {
      cb();
      return 0;
    };

    // Default: env var present so loadRedditPixel does real work
    vi.stubEnv("VITE_REDDIT_PIXEL_ID", "t2_test_pixel");

    vi.resetModules();
    redditPixel = await import("../utils/redditPixel");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  describe("loadRedditPixel", () => {
    it("installs the window.rdt stub without injecting pixel.js for first-time visitors", () => {
      redditPixel.loadRedditPixel();

      // Stub installed so any rdt() calls are buffered.
      expect(typeof window.rdt).toBe("function");

      // But pixel.js is NOT injected until consent is granted.
      const scripts = document.head.querySelectorAll(
        "script[src*='redditstatic.com']",
      );
      expect(scripts.length).toBe(0);
    });

    it("injects pixel.js after idle when the user already consented in a prior visit", () => {
      seedConsented();
      redditPixel.loadRedditPixel();

      // Our beforeEach polyfills requestIdleCallback to fire synchronously,
      // so the script tag should already be present by the time we check.
      const scripts = document.head.querySelectorAll(
        "script[src*='redditstatic.com']",
      );
      expect(scripts.length).toBe(1);
      // Matches Reddit's canonical snippet format: pixel_id as a query param.
      expect(scripts[0].getAttribute("src")).toBe(
        "https://www.redditstatic.com/ads/pixel.js?pixel_id=t2_test_pixel",
      );
    });

    it("is idempotent on repeated calls", () => {
      seedConsented();
      redditPixel.loadRedditPixel();
      redditPixel.loadRedditPixel();
      redditPixel.loadRedditPixel();

      const scripts = document.head.querySelectorAll(
        "script[src*='redditstatic.com']",
      );
      expect(scripts.length).toBe(1);
    });

    it("initializes with optOut: true (consent denied by default)", () => {
      redditPixel.loadRedditPixel();

      // The initial init() call happens during loadRedditPixel before the
      // pixel.js script has loaded, so it's sitting in the stub's callQueue.
      const queue = (window.rdt as unknown as { callQueue?: unknown[][] }).callQueue;
      expect(queue).toBeDefined();

      const initCall = queue?.find(
        (call) => Array.isArray(call) && call[0] === "init",
      );
      expect(initCall).toBeDefined();
      expect(initCall?.[1]).toBe("t2_test_pixel");
      expect(initCall?.[2]).toMatchObject({ optOut: true });
    });

    it("does nothing when VITE_REDDIT_PIXEL_ID is not set", async () => {
      vi.stubEnv("VITE_REDDIT_PIXEL_ID", "");
      vi.resetModules();
      const mod = await import("../utils/redditPixel");

      mod.loadRedditPixel();

      expect(window.rdt).toBeUndefined();
      const scripts = document.head.querySelectorAll(
        "script[src*='redditstatic.com']",
      );
      expect(scripts.length).toBe(0);
    });
  });

  describe("grantRedditConsent", () => {
    it("issues an init with optOut: false and tracks a PageVisit", () => {
      redditPixel.loadRedditPixel();

      // Replace rdt with a spy so we can observe the grant call
      const rdtSpy = vi.fn();
      window.rdt = rdtSpy as unknown as typeof window.rdt;

      redditPixel.grantRedditConsent();

      expect(rdtSpy).toHaveBeenCalledWith("init", "t2_test_pixel", {
        optOut: false,
      });
      expect(rdtSpy).toHaveBeenCalledWith("track", "PageVisit");
    });

    it("is a no-op when the pixel was never loaded", async () => {
      vi.stubEnv("VITE_REDDIT_PIXEL_ID", "");
      vi.resetModules();
      const mod = await import("../utils/redditPixel");

      expect(() => mod.grantRedditConsent()).not.toThrow();
      expect(window.rdt).toBeUndefined();
    });

    it("injects pixel.js for first-time consenters (deferred startup path)", () => {
      // First-time visitor: load runs without consent, so no script injection.
      redditPixel.loadRedditPixel();
      expect(
        document.head.querySelectorAll("script[src*='redditstatic.com']").length,
      ).toBe(0);

      // User accepts the banner — script should be injected lazily.
      redditPixel.grantRedditConsent();
      const scripts = document.head.querySelectorAll(
        "script[src*='redditstatic.com']",
      );
      expect(scripts.length).toBe(1);
      expect(scripts[0].getAttribute("src")).toBe(
        "https://www.redditstatic.com/ads/pixel.js?pixel_id=t2_test_pixel",
      );
    });
  });

  describe("revokeRedditConsent", () => {
    it("issues an init with optOut: true", () => {
      redditPixel.loadRedditPixel();

      const rdtSpy = vi.fn();
      window.rdt = rdtSpy as unknown as typeof window.rdt;

      redditPixel.revokeRedditConsent();

      expect(rdtSpy).toHaveBeenCalledWith("init", "t2_test_pixel", {
        optOut: true,
      });
    });

    it("is a no-op when the pixel was never loaded", async () => {
      vi.stubEnv("VITE_REDDIT_PIXEL_ID", "");
      vi.resetModules();
      const mod = await import("../utils/redditPixel");

      expect(() => mod.revokeRedditConsent()).not.toThrow();
    });

    it("clears _rdt_uuid and rdt_uuid cookies on both naming conventions", () => {
      redditPixel.loadRedditPixel();

      // Simulate cookies Reddit's pixel sets historically. jsdom allows setting
      // cookies directly via document.cookie — we set both the `_rdt*` and
      // un-prefixed `rdt_*` variants to verify the filter catches both.
      document.cookie = "_rdt_uuid=abc123; path=/";
      document.cookie = "rdt_uuid=def456; path=/";
      document.cookie = "unrelated_cookie=xyz; path=/";
      expect(document.cookie).toContain("_rdt_uuid");
      expect(document.cookie).toContain("rdt_uuid");

      redditPixel.revokeRedditConsent();

      // jsdom accepts the past-expiry deletion. Non-reddit cookies should
      // remain untouched.
      expect(document.cookie).not.toContain("_rdt_uuid=abc123");
      expect(document.cookie).not.toContain("rdt_uuid=def456");
      expect(document.cookie).toContain("unrelated_cookie=xyz");
    });
  });

  describe("trackRedditEvent", () => {
    it("calls rdt('track', eventName, metadata) when loaded", () => {
      redditPixel.loadRedditPixel();

      const rdtSpy = vi.fn();
      window.rdt = rdtSpy as unknown as typeof window.rdt;

      redditPixel.trackRedditEvent("SignUp", { source: "email" });

      expect(rdtSpy).toHaveBeenCalledWith("track", "SignUp", {
        source: "email",
      });
    });

    it("calls rdt('track', eventName) with no metadata when none provided", () => {
      redditPixel.loadRedditPixel();

      const rdtSpy = vi.fn();
      window.rdt = rdtSpy as unknown as typeof window.rdt;

      redditPixel.trackRedditEvent("SignUp");

      expect(rdtSpy).toHaveBeenCalledWith("track", "SignUp");
    });

    it("is a no-op when rdt is not loaded", () => {
      expect(() => redditPixel.trackRedditEvent("SignUp")).not.toThrow();
    });
  });
});
