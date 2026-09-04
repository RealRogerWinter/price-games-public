import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getPreferences,
  savePreferences,
  hasConsented,
  useConsentPreferences,
  type CookiePreferences,
} from "../utils/cookieConsent";

describe("cookieConsent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getPreferences", () => {
    it("returns defaults when localStorage is empty", () => {
      expect(getPreferences()).toEqual({
        consented: false,
        necessary: true,
        analytics: false,
        advertising: false,
      });
    });

    it("reads saved preferences from localStorage", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: true, necessary: true, analytics: true, advertising: true }),
      );
      expect(getPreferences()).toEqual({
        consented: true,
        necessary: true,
        analytics: true,
        advertising: true,
      });
    });

    it("reads a rejected-all record (necessary off)", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: true, necessary: false, analytics: false, advertising: false }),
      );
      expect(getPreferences()).toEqual({
        consented: true,
        necessary: false,
        analytics: false,
        advertising: false,
      });
    });

    it("returns defaults for invalid JSON", () => {
      localStorage.setItem("cookie_consent", "not-json");
      expect(getPreferences()).toEqual({
        consented: false,
        necessary: true,
        analytics: false,
        advertising: false,
      });
    });

    it("defaults missing fields", () => {
      localStorage.setItem("cookie_consent", JSON.stringify({ consented: true }));
      // Legacy records without `necessary` implicitly opted in — preserve that.
      // `advertising` didn't exist yet — defaults off, same as analytics.
      expect(getPreferences()).toEqual({
        consented: true,
        necessary: true,
        analytics: false,
        advertising: false,
      });
    });

    it("defaults advertising off for a pre-advertising-category record (analytics on)", () => {
      // A record saved before the "advertising" category existed, with
      // analytics already granted — advertising must still default to off.
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: true, necessary: true, analytics: true }),
      );
      expect(getPreferences()).toEqual({
        consented: true,
        necessary: true,
        analytics: true,
        advertising: false,
      });
    });

    it("strictly validates booleans — rejects truthy non-boolean values", () => {
      localStorage.setItem(
        "cookie_consent",
        JSON.stringify({ consented: "yes", necessary: 1, analytics: 1, advertising: 1 }),
      );
      const prefs = getPreferences();
      expect(prefs.consented).toBe(false);
      // `necessary` uses a type check so non-booleans fall back to the default true.
      expect(prefs.necessary).toBe(true);
      expect(prefs.analytics).toBe(false);
      expect(prefs.advertising).toBe(false);
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
      expect(getPreferences()).toEqual({
        consented: false,
        necessary: true,
        analytics: false,
        advertising: false,
      });
      vi.restoreAllMocks();
    });
  });

  describe("savePreferences", () => {
    it("persists preferences to localStorage", () => {
      const prefs: CookiePreferences = {
        consented: true,
        necessary: true,
        analytics: true,
        advertising: true,
      };
      savePreferences(prefs);
      expect(JSON.parse(localStorage.getItem("cookie_consent")!)).toEqual(prefs);
    });

    it("dispatches a cookie-consent-changed event", () => {
      const handler = vi.fn();
      window.addEventListener("cookie-consent-changed", handler);
      savePreferences({ consented: true, necessary: true, analytics: false, advertising: false });
      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener("cookie-consent-changed", handler);
    });
  });

  describe("hasConsented", () => {
    it("returns false when no preferences saved", () => {
      expect(hasConsented()).toBe(false);
    });

    it("returns true after consent is saved", () => {
      savePreferences({ consented: true, necessary: true, analytics: false, advertising: false });
      expect(hasConsented()).toBe(true);
    });
  });

  describe("useConsentPreferences", () => {
    it("returns the preferences present at mount", () => {
      savePreferences({ consented: true, necessary: true, analytics: false, advertising: true });
      const { result } = renderHook(() => useConsentPreferences());
      expect(result.current).toEqual({
        consented: true,
        necessary: true,
        analytics: false,
        advertising: true,
      });
    });

    it("re-renders with the new value when savePreferences dispatches its change event", () => {
      const { result } = renderHook(() => useConsentPreferences());
      expect(result.current.advertising).toBe(false);

      act(() => {
        savePreferences({ consented: true, necessary: true, analytics: true, advertising: true });
      });

      expect(result.current).toEqual({
        consented: true,
        necessary: true,
        analytics: true,
        advertising: true,
      });
    });
  });
});
