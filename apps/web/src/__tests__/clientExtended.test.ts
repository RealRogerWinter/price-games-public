import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  submitOddOneOutGuess,
  submitMarketBasketGuess,
  submitSortItOutGuess,
  submitBudgetBuilderGuess,
  submitChainReactionGuess,
  submitHigherLowerGuess,
  submitComparisonGuess,
  submitClosestGuess,
} from "../api/client";

describe("API client — extended game mode functions", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  function mockOk(data: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }

  // ── timedOut branches for earlier functions not covered by client.test.ts ─

  describe("submitHigherLowerGuess — timedOut branch", () => {
    it("includes timedOut:true when provided", async () => {
      mockOk({ score: 0, correct: false });
      await submitHigherLowerGuess("s1", "lower", true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when false (falsy branch)", async () => {
      mockOk({ score: 800 });
      await submitHigherLowerGuess("s1", "higher", false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });
  });

  describe("submitComparisonGuess — timedOut branch", () => {
    it("includes timedOut:true when provided", async () => {
      mockOk({ score: 0 });
      await submitComparisonGuess("s1", 5, true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when false (falsy branch)", async () => {
      mockOk({ score: 600 });
      await submitComparisonGuess("s1", 5, false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });
  });

  describe("submitClosestGuess — timedOut branch", () => {
    it("includes timedOut:true when provided", async () => {
      mockOk({ score: 0 });
      await submitClosestGuess("s1", 1500, true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when false (falsy branch)", async () => {
      mockOk({ score: 300 });
      await submitClosestGuess("s1", 1500, false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });
  });

  // ── submitOddOneOutGuess ─────────────────────────────────────────────────

  describe("submitOddOneOutGuess", () => {
    it("sends POST with guessedProductId", async () => {
      mockOk({ score: 500, correct: true });
      await submitOddOneOutGuess("s1", 42);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/game/s1/guess");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.guessedProductId).toBe(42);
    });

    it("does not include timedOut when not provided", async () => {
      mockOk({ score: 500 });
      await submitOddOneOutGuess("s1", 7);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("includes timedOut:true when timedOut is true", async () => {
      mockOk({ score: 0 });
      await submitOddOneOutGuess("s1", 7, true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when timedOut is false (falsy branch)", async () => {
      mockOk({ score: 0 });
      await submitOddOneOutGuess("s1", 7, false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("returns the API response", async () => {
      const responseData = { score: 800, correct: true, outlierProductId: 42 };
      mockOk(responseData);
      const result = await submitOddOneOutGuess("s2", 42);
      expect(result).toEqual(responseData);
    });
  });

  // ── submitMarketBasketGuess ──────────────────────────────────────────────

  describe("submitMarketBasketGuess", () => {
    it("sends POST with guessedTotalCents", async () => {
      mockOk({ score: 600, pctOff: 5 });
      await submitMarketBasketGuess("s1", 10500);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/game/s1/guess");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.guessedTotalCents).toBe(10500);
    });

    it("does not include timedOut when not provided", async () => {
      mockOk({ score: 600 });
      await submitMarketBasketGuess("s1", 10000);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("includes timedOut:true when timedOut is true", async () => {
      mockOk({ score: 0 });
      await submitMarketBasketGuess("s1", 0, true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when timedOut is false (falsy branch)", async () => {
      mockOk({ score: 0 });
      await submitMarketBasketGuess("s1", 0, false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("returns the API response", async () => {
      const responseData = { score: 700, pctOff: 3, actualTotalCents: 10000, guessedTotalCents: 10300 };
      mockOk(responseData);
      const result = await submitMarketBasketGuess("s2", 10300);
      expect(result).toEqual(responseData);
    });
  });

  // ── submitSortItOutGuess ─────────────────────────────────────────────────

  describe("submitSortItOutGuess", () => {
    it("sends POST with submittedOrder", async () => {
      mockOk({ score: 700, correctCount: 3 });
      await submitSortItOutGuess("s1", [1, 2, 3]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/game/s1/guess");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.submittedOrder).toEqual([1, 2, 3]);
    });

    it("does not include timedOut when not provided", async () => {
      mockOk({ score: 700 });
      await submitSortItOutGuess("s1", [3, 1, 2]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("includes timedOut:true when timedOut is true", async () => {
      mockOk({ score: 0 });
      await submitSortItOutGuess("s1", [], true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when timedOut is false (falsy branch)", async () => {
      mockOk({ score: 0 });
      await submitSortItOutGuess("s1", [], false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("returns the API response", async () => {
      const responseData = { score: 850, correctCount: 3, correctOrder: [1, 2, 3] };
      mockOk(responseData);
      const result = await submitSortItOutGuess("s3", [1, 2, 3]);
      expect(result).toEqual(responseData);
    });
  });

  // ── submitBudgetBuilderGuess ─────────────────────────────────────────────

  describe("submitBudgetBuilderGuess", () => {
    it("sends POST with selectedProductIds", async () => {
      mockOk({ score: 500, cartTotalCents: 4800 });
      await submitBudgetBuilderGuess("s1", [1, 2, 3]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/game/s1/guess");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.selectedProductIds).toEqual([1, 2, 3]);
    });

    it("does not include timedOut when not provided", async () => {
      mockOk({ score: 500 });
      await submitBudgetBuilderGuess("s1", [4, 5]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("includes timedOut:true when timedOut is true", async () => {
      mockOk({ score: 0 });
      await submitBudgetBuilderGuess("s1", [], true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when timedOut is false (falsy branch)", async () => {
      mockOk({ score: 0 });
      await submitBudgetBuilderGuess("s1", [], false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("returns the API response", async () => {
      const responseData = { score: 600, budgetCents: 5000, cartTotalCents: 4900, selectedProductIds: [1] };
      mockOk(responseData);
      const result = await submitBudgetBuilderGuess("s4", [1]);
      expect(result).toEqual(responseData);
    });
  });

  // ── submitChainReactionGuess ─────────────────────────────────────────────

  describe("submitChainReactionGuess", () => {
    it("sends POST with chainGuesses", async () => {
      mockOk({ score: 600, correctCount: 2 });
      await submitChainReactionGuess("s1", ["more", "less", "more"]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/game/s1/guess");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.chainGuesses).toEqual(["more", "less", "more"]);
    });

    it("does not include timedOut when not provided", async () => {
      mockOk({ score: 600 });
      await submitChainReactionGuess("s1", ["less"]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("includes timedOut:true when timedOut is true", async () => {
      mockOk({ score: 0 });
      await submitChainReactionGuess("s1", [], true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut when timedOut is false (falsy branch)", async () => {
      mockOk({ score: 0 });
      await submitChainReactionGuess("s1", [], false);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.timedOut).toBeUndefined();
    });

    it("returns the API response", async () => {
      const responseData = { score: 900, correctCount: 3, chainLength: 3 };
      mockOk(responseData);
      const result = await submitChainReactionGuess("s5", ["more", "more", "less"]);
      expect(result).toEqual(responseData);
    });
  });
});
