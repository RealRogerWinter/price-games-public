import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchRates, getRates } from "./exchangeRates";

describe("exchangeRates", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getRates", () => {
    it("returns hardcoded fallback rates when no rates have been fetched", () => {
      // getRates should return something even before fetchRates is called
      const rates = getRates();
      expect(rates.base).toBe("USD");
      expect(rates.rates).toBeDefined();
      expect(rates.updatedAt).toBeDefined();
      expect(typeof rates.rates.EUR).toBe("number");
      expect(typeof rates.rates.GBP).toBe("number");
      expect(typeof rates.rates.JPY).toBe("number");
    });

    it("returns rates with all supported currencies", () => {
      const rates = getRates();
      const expected = ["EUR", "GBP", "CAD", "AUD", "JPY", "INR", "BRL", "MXN", "KRW", "SEK", "CHF", "CNY"];
      for (const currency of expected) {
        expect(rates.rates[currency]).toBeDefined();
        expect(rates.rates[currency]).toBeGreaterThan(0);
      }
    });
  });

  describe("fetchRates", () => {
    it("fetches rates from API and caches them", async () => {
      const mockRates = { EUR: 0.95, GBP: 0.80, CAD: 1.35, AUD: 1.50, JPY: 150, INR: 83, BRL: 5, MXN: 17, KRW: 1300, SEK: 10.5, CHF: 0.90, CNY: 7.2 };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: mockRates }),
      } as Response);

      await fetchRates();

      const rates = getRates();
      expect(rates.rates.EUR).toBe(0.95);
      expect(rates.rates.GBP).toBe(0.80);
    });

    it("falls back to hardcoded rates on API failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

      await fetchRates();

      const rates = getRates();
      expect(rates.base).toBe("USD");
      expect(rates.rates.EUR).toBeDefined();
    });

    it("falls back to hardcoded rates on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      await fetchRates();

      const rates = getRates();
      expect(rates.base).toBe("USD");
    });

    it("uses hardcoded fallback when no prior cache exists and API fails", async () => {
      // Reset module state by calling with a failed fetch first
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("No internet"));
      await fetchRates();

      const rates = getRates();
      expect(rates.base).toBe("USD");
      expect(typeof rates.rates.EUR).toBe("number");
      expect(rates.updatedAt).toBeDefined();
    });

    it("keeps previously cached rates when API fails after successful fetch", async () => {
      // First: successful fetch to populate cache
      const mockRates = { EUR: 0.88, GBP: 0.75, CAD: 1.30, AUD: 1.45, JPY: 145, INR: 80, BRL: 4.8, MXN: 16, KRW: 1280, SEK: 10.0, CHF: 0.85, CNY: 7.0 };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: mockRates }),
      } as Response);
      await fetchRates();

      // Verify cache is populated
      const ratesAfterSuccess = getRates();
      expect(ratesAfterSuccess.rates.EUR).toBe(0.88);

      // Second: failed fetch should keep the cached rates
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network down"));
      await fetchRates();

      const ratesAfterFailure = getRates();
      expect(ratesAfterFailure.rates.EUR).toBe(0.88); // Same as before
    });

    it("filters only supported currencies from API response", async () => {
      // API returns extra unsupported currencies
      const mockRates = { EUR: 0.90, GBP: 0.78, XYZ: 999.99, CAD: 1.35, AUD: 1.50, JPY: 150, INR: 83, BRL: 5, MXN: 17, KRW: 1300, SEK: 10.5, CHF: 0.90, CNY: 7.2 };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: mockRates }),
      } as Response);
      await fetchRates();

      const rates = getRates();
      expect(rates.rates.EUR).toBe(0.90);
      expect(rates.rates["XYZ"]).toBeUndefined(); // unsupported currency not included
    });

    it("handles API response with missing rates object", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => ({}), // No rates property
      } as Response);
      await fetchRates();

      const rates = getRates();
      expect(rates.base).toBe("USD");
    });
  });
});
