import { describe, it, expect, beforeEach, vi } from "vitest";
import { getPreferences, savePreferences, hasConsented, type CookiePreferences } from "../utils/cookieConsent";

describe("cookieConsent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getPreferences", () => {
    it("returns defaults when localStorage is empty", () => {
      expect(getPreferences()).toEqual({ consented: false, necessary: true, analytics: false });
    });

    it("reads saved preferences from localStorage", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: true, necessary: true, analytics: true }),
      );
      expect(getPreferences()).toEqual({ consented: true, necessary: true, analytics: true });
    });

    it("reads a rejected-all record (necessary off)", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: true, necessary: false, analytics: false }),
      );
      expect(getPreferences()).toEqual({ consented: true, necessary: false, analytics: false });
    });

    it("returns defaults for invalid JSON", () => {
      localStorage.setItem("cookie_consent", "not-json");
      expect(getPreferences()).toEqual({ consented: false, necessary: true, analytics: false });
    });

    it("defaults missing fields", () => {
      localStorage.setItem("cookie_consent", JSON.stringify({ consented: true }));
      // Legacy records without `necessary` implicitly opted in — preserve that.
      expect(getPreferences()).toEqual({ consented: true, necessary: true, analytics: false });
    });

    it("strictly validates booleans — rejects truthy non-boolean values", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: "yes", necessary: 1, analytics: 1 }),
      );
      const prefs = getPreferences();
      expect(prefs.consented).toBe(false);
      // `necessary` uses a type check so non-booleans fall back to the default true.
      expect(prefs.necessary).toBe(true);
      expect(prefs.analytics).toBe(false);
    });

    it("returns a new object each time (no shared reference)", () => {
      const a = getPreferences();
      const b = getPreferences();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it("handles localStorage throwing", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Quota exceeded");
      });
      expect(getPreferences()).toEqual({ consented: false, necessary: true, analytics: false });
      vi.restoreAllMocks();
    });
  });

  describe("savePreferences", () => {
    it("persists preferences to localStorage", () => {
      const prefs: CookiePreferences = { consented: true, necessary: true, analytics: true };
      savePreferences(prefs);
      expect(JSON.parse(localStorage.getItem("cookie_consent")!)).toEqual(prefs);
    });
  });

  describe("hasConsented", () => {
    it("returns false when no preferences saved", () => {
      expect(hasConsented()).toBe(false);
    });

    it("returns true after consent is saved", () => {
      savePreferences({ consented: true, necessary: true, analytics: false });
      expect(hasConsented()).toBe(true);
    });
  });
});
