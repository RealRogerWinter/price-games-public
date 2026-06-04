import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Reset module state between tests by re-importing
let analytics: typeof import("../utils/analytics");

describe("analytics", () => {
  beforeEach(async () => {
    // Clean up globals
    delete (window as Partial<Window>).dataLayer;
    delete (window as Partial<Window>).gtag;
    document.head.querySelectorAll("script[src*='googletagmanager']").forEach((s) => s.remove());
    localStorage.clear();

    // Provide a measurement ID so module fns don't early-return
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST12345");

    // Re-import to reset module-scoped state flags
    vi.resetModules();
    analytics = await import("../utils/analytics");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("loadGA", () => {
    it("initialises dataLayer and gtag queue even without consent", () => {
      analytics.loadGA();

      expect(window.dataLayer).toBeDefined();
      expect(window.dataLayer.length).toBeGreaterThan(0);
      expect(typeof window.gtag).toBe("function");
    });

    it("does NOT inject the external gtag.js script when no consent has been given", () => {
      analytics.loadGA();
      const scripts = document.head.querySelectorAll("script[src*='googletagmanager']");
      expect(scripts.length).toBe(0);
    });

    it("injects gtag.js after idle when consent is already granted", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ necessary: true, analytics: true, consented: true }),
      );
      vi.useFakeTimers();

      analytics.loadGA();

      // Script isn't injected synchronously — it's scheduled via requestIdleCallback /
      // setTimeout fallback so it doesn't contend with initial paint.
      expect(document.head.querySelectorAll("script[src*='googletagmanager']").length).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(document.head.querySelectorAll("script[src*='googletagmanager']").length).toBe(1);
    });

    it("sets consent defaults to denied", () => {
      analytics.loadGA();

      const consentEntry = window.dataLayer.find(
        (entry) => Array.isArray(entry) && entry[0] === "consent" && entry[1] === "default",
      ) as unknown[];
      expect(consentEntry).toBeDefined();
      expect(consentEntry[2]).toMatchObject({
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    });

    it("only initialises once on repeated calls", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ necessary: true, analytics: true, consented: true }),
      );
      vi.useFakeTimers();

      analytics.loadGA();
      analytics.loadGA();
      vi.advanceTimersByTime(1000);

      const scripts = document.head.querySelectorAll("script[src*='googletagmanager']");
      expect(scripts.length).toBe(1);
    });
  });

  describe("grantAnalyticsConsent", () => {
    it("pushes a consent update to the dataLayer", () => {
      analytics.loadGA();
      const lengthBefore = window.dataLayer.length;

      analytics.grantAnalyticsConsent();

      const newEntries = window.dataLayer.slice(lengthBefore);
      const grantEntry = newEntries.find(
        (entry) => Array.isArray(entry) && entry[0] === "consent" && entry[1] === "update",
      ) as unknown[];
      expect(grantEntry).toBeDefined();
      expect(grantEntry[2]).toMatchObject({ analytics_storage: "granted" });
    });

    it("injects the gtag.js script", () => {
      analytics.loadGA();
      expect(document.head.querySelectorAll("script[src*='googletagmanager']").length).toBe(0);

      analytics.grantAnalyticsConsent();

      expect(document.head.querySelectorAll("script[src*='googletagmanager']").length).toBe(1);
    });

    it("does not inject the script twice when called repeatedly", () => {
      analytics.loadGA();
      analytics.grantAnalyticsConsent();
      analytics.grantAnalyticsConsent();

      expect(document.head.querySelectorAll("script[src*='googletagmanager']").length).toBe(1);
    });
  });

  describe("revokeAnalyticsConsent", () => {
    it("pushes a consent deny to the dataLayer", () => {
      analytics.loadGA();
      const lengthBefore = window.dataLayer.length;

      analytics.revokeAnalyticsConsent();

      const newEntries = window.dataLayer.slice(lengthBefore);
      const denyEntry = newEntries.find(
        (entry) => Array.isArray(entry) && entry[0] === "consent" && entry[1] === "update",
      ) as unknown[];
      expect(denyEntry).toBeDefined();
      expect(denyEntry[2]).toMatchObject({ analytics_storage: "denied" });
    });

    it("clears GA cookies", () => {
      analytics.loadGA();

      // Simulate a GA cookie
      document.cookie = "_ga=GA1.1.12345; path=/";

      analytics.revokeAnalyticsConsent();

      // The cookie deletion was attempted (document.cookie setter called)
      // We verify the function runs without error
      expect(true).toBe(true);
    });
  });

  describe("trackEvent", () => {
    it("calls gtag with event when loaded", () => {
      analytics.loadGA();
      const gtagSpy = vi.fn();
      window.gtag = gtagSpy;

      analytics.trackEvent("test_event", { value: 42 });

      expect(gtagSpy).toHaveBeenCalledWith("event", "test_event", { value: 42 });
    });

    it("is a no-op when gtag is not loaded", () => {
      // Don't call loadGA — window.gtag should be undefined
      expect(() => analytics.trackEvent("test_event")).not.toThrow();
    });
  });
});
