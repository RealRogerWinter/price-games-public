import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startGame,
  getCategories,
  getSession,
  getProduct,
  submitGuess,
  getHint,
  submitHigherLowerGuess,
  submitComparisonGuess,
  submitClosestGuess,
  submitPriceMatchGuess,
  submitRiserGuess,
  getMpLeaderboard,
  getLeaderboardV2,
  getUserRank,
  getPublicProfile,
  getPublicScoreHistory,
  getPublicGameHistory,
} from "../api/client";

describe("API client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  function mockFetchError(body: string, status: number) {
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { status })
    );
  }

  describe("startGame", () => {
    it("sends POST to /api/game/start", async () => {
      mockFetch({ id: "s1", currentRound: 1, totalRounds: 10, totalScore: 0, completed: false, gameMode: "classic" });
      const session = await startGame();
      expect(fetchSpy).toHaveBeenCalledWith("/api/game/start", expect.objectContaining({
        method: "POST",
      }));
      expect(session.id).toBe("s1");
    });

    it("sends categories and mode in body", async () => {
      mockFetch({ id: "s1" });
      await startGame(["Electronics"], "comparison");
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.categories).toEqual(["Electronics"]);
      expect(body.mode).toBe("comparison");
    });

    it("omits categories when empty", async () => {
      mockFetch({ id: "s1" });
      await startGame([], "classic");
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.categories).toBeUndefined();
    });
  });

  describe("getCategories", () => {
    it("sends GET to /api/game/categories", async () => {
      mockFetch({ categories: [{ name: "Electronics", count: 50 }] });
      const result = await getCategories();
      expect(fetchSpy).toHaveBeenCalledWith("/api/game/categories", expect.any(Object));
      expect(result.categories).toHaveLength(1);
    });
  });

  describe("getSession", () => {
    it("sends GET to /api/game/:sessionId", async () => {
      mockFetch({ id: "s1", currentRound: 3, totalRounds: 10, totalScore: 1500, completed: false, gameMode: "classic" });
      const session = await getSession("s1");
      expect(fetchSpy).toHaveBeenCalledWith("/api/game/s1", expect.any(Object));
      expect(session.id).toBe("s1");
      expect(session.currentRound).toBe(3);
    });
  });

  describe("getProduct", () => {
    it("sends GET to /api/game/:sessionId/product", async () => {
      mockFetch({ id: 1, title: "Widget", imageUrl: "img.jpg", category: "Electronics" });
      const product = await getProduct("session-123");
      expect(fetchSpy).toHaveBeenCalledWith("/api/game/session-123/product", expect.any(Object));
      expect(product.title).toBe("Widget");
    });

    it("does not dispatch pg-bot-event on a normal page (no broadcast flag)", async () => {
      window.history.replaceState(null, "", "/");
      mockFetch({ id: 1, title: "Widget", imageUrl: "img.jpg", category: "Electronics" });
      const listener = vi.fn();
      window.addEventListener("pg-bot-event", listener);
      try {
        await getProduct("session-123");
        expect(listener).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("pg-bot-event", listener);
      }
    });

    it("dispatches pg-bot-event with a wrapped bare-Product payload when ?broadcast=1", async () => {
      window.history.replaceState(null, "", "/?broadcast=1");
      sessionStorage.setItem(
        "active_game",
        JSON.stringify({ gameMode: "classic", session: { currentRound: 2 } })
      );
      mockFetch({ id: 1, title: "Widget", imageUrl: "img.jpg", category: "Electronics" });
      const events: CustomEvent[] = [];
      const listener = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("pg-bot-event", listener);
      try {
        await getProduct("session-123");
        expect(events).toHaveLength(1);
        const detail = events[0].detail as { kind: string; payload: { product: { title?: string }; gameMode?: string; roundNumber?: number } };
        expect(detail.kind).toBe("game:round_start");
        expect(detail.payload.product?.title).toBe("Widget");
        expect(detail.payload.gameMode).toBe("classic");
        expect(detail.payload.roundNumber).toBe(2);
      } finally {
        window.removeEventListener("pg-bot-event", listener);
        sessionStorage.removeItem("active_game");
        window.history.replaceState(null, "", "/");
      }
    });

    it("dispatches the wrapped response shape for non-classic modes (no double-wrap)", async () => {
      window.history.replaceState(null, "", "/?broadcast=1");
      sessionStorage.setItem(
        "active_game",
        JSON.stringify({ gameMode: "comparison", session: { currentRound: 1 } })
      );
      mockFetch({ products: [{ id: 1, title: "A" }, { id: 2, title: "B" }], question: "Which is more?" });
      const events: CustomEvent[] = [];
      const listener = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener("pg-bot-event", listener);
      try {
        await getProduct("session-123");
        const detail = events[0].detail as { payload: { product?: unknown; products?: unknown[] } };
        expect(detail.payload.product).toBeUndefined();
        expect(detail.payload.products).toHaveLength(2);
      } finally {
        window.removeEventListener("pg-bot-event", listener);
        sessionStorage.removeItem("active_game");
        window.history.replaceState(null, "", "/");
      }
    });
  });

  describe("submitGuess", () => {
    it("sends POST with guessedPriceCents", async () => {
      mockFetch({ score: 500, pctOff: 0.10 });
      await submitGuess("s1", 2500);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.guessedPriceCents).toBe(2500);
    });

    it("includes timedOut flag when true", async () => {
      mockFetch({ score: 0 });
      await submitGuess("s1", 0, true);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.timedOut).toBe(true);
    });

    it("omits timedOut flag when false", async () => {
      mockFetch({ score: 500 });
      await submitGuess("s1", 1000, false);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.timedOut).toBeUndefined();
    });
  });

  describe("submitHigherLowerGuess", () => {
    it("sends guess direction", async () => {
      mockFetch({ score: 800, correct: true });
      await submitHigherLowerGuess("s1", "higher");
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.guess).toBe("higher");
    });
  });

  describe("submitComparisonGuess", () => {
    it("sends guessedProductId", async () => {
      mockFetch({ score: 600 });
      await submitComparisonGuess("s1", 42);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.guessedProductId).toBe(42);
    });
  });

  describe("submitClosestGuess", () => {
    it("sends guessedPriceCents", async () => {
      mockFetch({ score: 300 });
      await submitClosestGuess("s1", 1500);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.guessedPriceCents).toBe(1500);
    });
  });

  describe("submitPriceMatchGuess", () => {
    it("sends assignments map", async () => {
      mockFetch({ score: 800 });
      await submitPriceMatchGuess("s1", { 1: 1000, 2: 2000 });
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.assignments).toEqual({ "1": 1000, "2": 2000 });
    });
  });

  describe("submitRiserGuess", () => {
    it("sends stoppedPriceCents", async () => {
      mockFetch({ score: 650 });
      await submitRiserGuess("s1", 3500);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.stoppedPriceCents).toBe(3500);
    });
  });

  describe("getHint", () => {
    it("sends POST to hint endpoint", async () => {
      mockFetch({ hintRange: { min: 1000, max: 2000 } });
      const result = await getHint("s1");
      expect(fetchSpy).toHaveBeenCalledWith("/api/game/s1/hint", expect.objectContaining({
        method: "POST",
      }));
      expect(result.hintRange.min).toBe(1000);
    });
  });

  describe("getMpLeaderboard", () => {
    it("fetches without mode filter", async () => {
      mockFetch({ entries: [] });
      await getMpLeaderboard();
      expect(fetchSpy).toHaveBeenCalledWith("/api/mp/leaderboard", expect.any(Object));
    });

    it("includes mode query parameter", async () => {
      mockFetch({ entries: [] });
      await getMpLeaderboard("budget-builder");
      expect(fetchSpy).toHaveBeenCalledWith("/api/mp/leaderboard?mode=budget-builder", expect.any(Object));
    });
  });

  // ─── Leaderboard V2 ───

  describe("getLeaderboardV2", () => {
    it("fetches /api/leaderboard/v2 with default params", async () => {
      mockFetch({ leaderboard: [] });
      await getLeaderboardV2();
      expect(fetchSpy).toHaveBeenCalledWith("/api/leaderboard/v2?limit=50&offset=0", expect.any(Object));
    });

    it("passes custom limit and offset", async () => {
      mockFetch({ leaderboard: [] });
      await getLeaderboardV2(20, 10);
      expect(fetchSpy).toHaveBeenCalledWith("/api/leaderboard/v2?limit=20&offset=10", expect.any(Object));
    });
  });

  describe("getUserRank", () => {
    it("fetches /api/leaderboard/rank", async () => {
      mockFetch({ rank: 1, totalPlayers: 10 });
      const result = await getUserRank();
      expect(fetchSpy).toHaveBeenCalledWith("/api/leaderboard/rank", expect.any(Object));
      expect(result.rank).toBe(1);
    });
  });

  describe("getPublicProfile", () => {
    it("fetches /api/player/:username", async () => {
      mockFetch({ profile: { username: "alice" } });
      await getPublicProfile("alice");
      expect(fetchSpy).toHaveBeenCalledWith("/api/player/alice", expect.any(Object));
    });
  });

  describe("getPublicScoreHistory", () => {
    // The client auto-populates `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`
    // which varies per host (CI is UTC, dev machines vary). Match the stable
    // prefix of the URL and assert the tz param exists and is non-empty.
    it("fetches with default days", async () => {
      mockFetch({ history: [] });
      await getPublicScoreHistory("alice");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/player\/alice\/score-history\?days=30&tz=.+$/),
        expect.any(Object),
      );
    });

    it("passes custom days param", async () => {
      mockFetch({ history: [] });
      await getPublicScoreHistory("alice", 90);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/player\/alice\/score-history\?days=90&tz=.+$/),
        expect.any(Object),
      );
    });

    it("forwards an explicit timeZone argument", async () => {
      mockFetch({ history: [] });
      await getPublicScoreHistory("alice", 30, "Asia/Tokyo");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/player/alice/score-history?days=30&tz=Asia%2FTokyo",
        expect.any(Object),
      );
    });
  });

  describe("getPublicGameHistory", () => {
    it("fetches with default params", async () => {
      mockFetch({ entries: [], total: 0 });
      await getPublicGameHistory("alice");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/player\/alice\/history\?limit=20&offset=0&tz=.+$/),
        expect.any(Object),
      );
    });

    it("passes custom limit and offset", async () => {
      mockFetch({ entries: [], total: 0 });
      await getPublicGameHistory("alice", 10, 5);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/player\/alice\/history\?limit=10&offset=5&tz=.+$/),
        expect.any(Object),
      );
    });

    it("forwards an explicit timeZone argument", async () => {
      mockFetch({ entries: [], total: 0 });
      await getPublicGameHistory("alice", 20, 0, "Europe/Berlin");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/player/alice/history?limit=20&offset=0&tz=Europe%2FBerlin",
        expect.any(Object),
      );
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetchError("Not found", 404);
      await expect(startGame()).rejects.toThrow("API error 404: Not found");
    });

    it("throws on 500 response", async () => {
      mockFetchError("Internal Server Error", 500);
      await expect(getCategories()).rejects.toThrow("API error 500");
    });
  });

  // ---------------------------------------------------------------------------
  // Opportunistic next-round image preload (baked into request())
  // ---------------------------------------------------------------------------

  describe("nextRoundImageUrls preload", () => {
    /** Replace window.Image with a spy that records every assigned src. */
    function installImageSpy(): { created: string[]; restore: () => void } {
      const created: string[] = [];
      const OriginalImage = window.Image;
      class ImageSpy {
        private _src = "";
        get src() { return this._src; }
        set src(v: string) {
          this._src = v;
          created.push(v);
        }
      }
      // @ts-expect-error monkey-patch for test
      window.Image = ImageSpy;
      return {
        created,
        restore: () => {
          window.Image = OriginalImage;
        },
      };
    }

    it("fires Image() preloads for every URL in nextRoundImageUrls", async () => {
      const spy = installImageSpy();
      try {
        mockFetch({
          result: { score: 500 },
          session: { id: "s1", currentRound: 2, totalRounds: 5, totalScore: 500, completed: false, gameMode: "classic" },
          nextRoundImageUrls: ["/api/image/11", "/api/image/22"],
        });
        await submitGuess("s1", 1000);
        expect(spy.created).toEqual(["/api/image/11", "/api/image/22"]);
      } finally {
        spy.restore();
      }
    });

    it("skips preload when the hint is absent or empty", async () => {
      const spy = installImageSpy();
      try {
        mockFetch({
          result: { score: 500 },
          session: { id: "s1", currentRound: 2, totalRounds: 5, totalScore: 500, completed: false, gameMode: "classic" },
        });
        await submitGuess("s1", 1000);
        expect(spy.created).toEqual([]);

        mockFetch({
          result: { score: 500 },
          session: { id: "s1", currentRound: 2, totalRounds: 5, totalScore: 500, completed: false, gameMode: "classic" },
          nextRoundImageUrls: [],
        });
        await submitGuess("s1", 1000);
        expect(spy.created).toEqual([]);
      } finally {
        spy.restore();
      }
    });

    it("does not preload on non-guess endpoints that don't set the hint", async () => {
      const spy = installImageSpy();
      try {
        mockFetch({ categories: [] });
        await getCategories();
        expect(spy.created).toEqual([]);
      } finally {
        spy.restore();
      }
    });
  });
});
