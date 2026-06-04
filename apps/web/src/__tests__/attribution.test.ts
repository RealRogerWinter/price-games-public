import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  captureUtmFromUrl,
  getStoredAttribution,
  clearStoredAttribution,
  trackAttributionOnServer,
  type Attribution,
} from "../utils/attribution";

// sessionStorage is provided by jsdom — clear it between tests to isolate state.
// Also snapshot window.location and document.referrer so that tests which
// mutate them via Object.defineProperty don't leak state to sibling tests.
describe("attribution", () => {
  let originalLocation: Location;
  let originalReferrer: string;

  beforeEach(() => {
    sessionStorage.clear();
    originalLocation = window.location;
    originalReferrer = document.referrer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, "referrer", {
      value: originalReferrer,
      configurable: true,
    });
  });

  describe("captureUtmFromUrl", () => {
    it("captures all UTM parameters from a query string", () => {
      captureUtmFromUrl(
        "?utm_source=reddit&utm_medium=cpc&utm_campaign=giveaway_test&utm_content=variant_a&utm_term=guess-the-price"
      );

      const stored = getStoredAttribution();
      expect(stored).toMatchObject({
        utm_source: "reddit",
        utm_medium: "cpc",
        utm_campaign: "giveaway_test",
        utm_content: "variant_a",
        utm_term: "guess-the-price",
      });
    });

    it("captures only the UTM params that are present", () => {
      captureUtmFromUrl("?utm_source=reddit&utm_campaign=launch");

      const stored = getStoredAttribution();
      expect(stored).toMatchObject({
        utm_source: "reddit",
        utm_campaign: "launch",
      });
      expect(stored?.utm_medium).toBeUndefined();
      expect(stored?.utm_content).toBeUndefined();
      expect(stored?.utm_term).toBeUndefined();
    });

    it("captures landing_page from window.location.pathname when attribution is stored", () => {
      Object.defineProperty(window, "location", {
        value: { ...window.location, pathname: "/giveaway" },
        writable: true,
      });

      captureUtmFromUrl("?utm_source=reddit");

      const stored = getStoredAttribution();
      expect(stored?.landing_page).toBe("/giveaway");
    });

    it("captures document.referrer when attribution is stored", () => {
      Object.defineProperty(document, "referrer", {
        value: "https://www.reddit.com/r/Frugal/",
        configurable: true,
      });

      captureUtmFromUrl("?utm_source=reddit");

      const stored = getStoredAttribution();
      expect(stored?.referrer).toBe("https://www.reddit.com/r/Frugal/");
    });

    it("does not store anything when no UTM params are present", () => {
      captureUtmFromUrl("?foo=bar");

      expect(getStoredAttribution()).toBeNull();
    });

    it("does not store anything when the query string is empty", () => {
      captureUtmFromUrl("");

      expect(getStoredAttribution()).toBeNull();
    });

    it("first-touch wins: subsequent captures do not overwrite existing attribution", () => {
      captureUtmFromUrl("?utm_source=reddit&utm_campaign=first");
      captureUtmFromUrl("?utm_source=google&utm_campaign=second");

      const stored = getStoredAttribution();
      expect(stored?.utm_source).toBe("reddit");
      expect(stored?.utm_campaign).toBe("first");
    });

    it("clamps each captured value to 128 characters", () => {
      const longValue = "a".repeat(500);
      captureUtmFromUrl(`?utm_source=${longValue}&utm_campaign=${longValue}`);

      const stored = getStoredAttribution();
      expect(stored?.utm_source?.length).toBe(128);
      expect(stored?.utm_campaign?.length).toBe(128);
    });

    it("clamps referrer and landing_page to 128 characters", () => {
      const longPath = "/" + "b".repeat(500);
      Object.defineProperty(window, "location", {
        value: { ...window.location, pathname: longPath },
        writable: true,
      });
      Object.defineProperty(document, "referrer", {
        value: "https://example.com/" + "c".repeat(500),
        configurable: true,
      });

      captureUtmFromUrl("?utm_source=reddit");

      const stored = getStoredAttribution();
      expect(stored?.landing_page?.length).toBe(128);
      expect(stored?.referrer?.length).toBe(128);
    });

    it("URL-decodes percent-encoded values", () => {
      captureUtmFromUrl("?utm_source=reddit&utm_campaign=guess%20the%20price");

      const stored = getStoredAttribution();
      expect(stored?.utm_campaign).toBe("guess the price");
    });

    it("ignores empty UTM parameter values", () => {
      // utm_source is required, so an empty utm_source with a non-empty
      // utm_campaign still results in nothing being stored.
      captureUtmFromUrl("?utm_source=&utm_campaign=launch");
      expect(getStoredAttribution()).toBeNull();

      // Empty value on a non-required field is dropped; utm_source present wins.
      captureUtmFromUrl("?utm_source=reddit&utm_medium=&utm_campaign=launch");
      const stored = getStoredAttribution();
      expect(stored?.utm_source).toBe("reddit");
      expect(stored?.utm_medium).toBeUndefined();
      expect(stored?.utm_campaign).toBe("launch");
    });

    it("does not store attribution when utm_source is absent", () => {
      // Required-field invariant: without utm_source, the server-side
      // first-touch guard would be bypassed. Match the invariant client-side.
      captureUtmFromUrl("?utm_medium=cpc&utm_campaign=launch");
      expect(getStoredAttribution()).toBeNull();
    });

    it("defaults to window.location.search when no argument is given", () => {
      Object.defineProperty(window, "location", {
        value: { ...window.location, search: "?utm_source=default_source" },
        writable: true,
      });

      captureUtmFromUrl();

      expect(getStoredAttribution()?.utm_source).toBe("default_source");
    });
  });

  describe("getStoredAttribution", () => {
    it("returns null when nothing is stored", () => {
      expect(getStoredAttribution()).toBeNull();
    });

    it("returns the parsed attribution JSON when present", () => {
      const attribution: Attribution = {
        utm_source: "reddit",
        utm_medium: "cpc",
      };
      sessionStorage.setItem("utm_attribution", JSON.stringify(attribution));

      expect(getStoredAttribution()).toEqual(attribution);
    });

    it("returns null when the stored value is malformed JSON", () => {
      sessionStorage.setItem("utm_attribution", "not-json{{{");

      expect(getStoredAttribution()).toBeNull();
    });

    it("returns null when the stored value is not an object", () => {
      sessionStorage.setItem("utm_attribution", JSON.stringify("a string"));

      expect(getStoredAttribution()).toBeNull();
    });
  });

  describe("clearStoredAttribution", () => {
    it("removes the stored attribution", () => {
      captureUtmFromUrl("?utm_source=reddit");
      expect(getStoredAttribution()).not.toBeNull();

      clearStoredAttribution();

      expect(getStoredAttribution()).toBeNull();
    });

    it("is a no-op when nothing is stored", () => {
      expect(() => clearStoredAttribution()).not.toThrow();
    });
  });

  describe("trackAttributionOnServer", () => {
    it("POSTs the stored attribution to /api/attribution/track", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch" as never)
        .mockResolvedValue(
          new Response(JSON.stringify({ recorded: true }), { status: 200 }),
        );

      captureUtmFromUrl("?utm_source=reddit&utm_campaign=launch");
      await trackAttributionOnServer();

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/attribution/track",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        }),
      );
      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.attribution.utm_source).toBe("reddit");
      expect(body.attribution.utm_campaign).toBe("launch");
    });

    it("does not call fetch when nothing is stored", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch" as never)
        .mockResolvedValue(new Response("{}"));

      await trackAttributionOnServer();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("swallows network errors", async () => {
      vi.spyOn(globalThis, "fetch" as never).mockRejectedValue(
        new Error("network down"),
      );
      captureUtmFromUrl("?utm_source=reddit");

      await expect(trackAttributionOnServer()).resolves.toBeUndefined();
    });
  });
});
