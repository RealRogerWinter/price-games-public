import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchDailyToday,
  startDaily,
  fetchDailyHistory,
  DailyAlreadyPlayedError,
  DailyDisabledError,
} from "../api/dailyClient";

describe("Daily API client", () => {
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
      }),
    );
  }

  // -- fetchDailyToday ----------------------------------------------------

  describe("fetchDailyToday", () => {
    it("returns the parsed body on 200", async () => {
      mockFetch({
        date: "2026-04-15",
        gameMode: "comparison",
        modeName: "Comparison",
        totalRounds: 5,
        alreadyPlayed: false,
        streak: { current: 0, best: 0, lastDate: null },
      });
      const result = await fetchDailyToday();
      expect(result.date).toBe("2026-04-15");
      expect(result.gameMode).toBe("comparison");
      expect(result.totalRounds).toBe(5);
    });

    it("throws DailyDisabledError on 404 daily_disabled", async () => {
      mockFetch({ error: "daily_disabled" }, 404);
      await expect(fetchDailyToday()).rejects.toBeInstanceOf(DailyDisabledError);
    });

    it("throws DailyDisabledError on 404 no_available_mode", async () => {
      mockFetch({ error: "no_available_mode" }, 404);
      await expect(fetchDailyToday()).rejects.toBeInstanceOf(DailyDisabledError);
    });

    it("throws a plain Error on other failures", async () => {
      mockFetch({ error: "boom" }, 500);
      await expect(fetchDailyToday()).rejects.toThrow(/boom|500/);
    });
  });

  // -- startDaily ---------------------------------------------------------

  describe("startDaily", () => {
    it("returns the GameSession on 200", async () => {
      mockFetch({
        id: "daily-sess-1",
        currentRound: 1,
        totalRounds: 5,
        totalScore: 0,
        completed: false,
        gameMode: "classic",
      });
      const session = await startDaily();
      expect(session.id).toBe("daily-sess-1");
      expect(session.totalRounds).toBe(5);
    });

    it("throws DailyAlreadyPlayedError on 409", async () => {
      mockFetch({ error: "already_played", date: "2026-04-15" }, 409);
      await expect(startDaily()).rejects.toBeInstanceOf(DailyAlreadyPlayedError);
    });

    it("throws DailyDisabledError on 404 daily_disabled", async () => {
      mockFetch({ error: "daily_disabled" }, 404);
      await expect(startDaily()).rejects.toBeInstanceOf(DailyDisabledError);
    });
  });

  // -- fetchDailyHistory --------------------------------------------------

  describe("fetchDailyHistory", () => {
    it("returns the parsed history list on 200", async () => {
      mockFetch({
        plays: [
          {
            date: "2026-04-15",
            gameMode: "classic",
            score: 4500,
            completedAt: "2026-04-15T12:00:00Z",
            streakAtCompletion: 3,
            perRoundScores: [1000, 900, 800, 900, 900],
          },
        ],
      });
      const result = await fetchDailyHistory();
      expect(result.plays).toHaveLength(1);
      expect(result.plays[0].streakAtCompletion).toBe(3);
    });

    it("throws on 401 (not logged in)", async () => {
      mockFetch({ error: "unauthorized" }, 401);
      await expect(fetchDailyHistory()).rejects.toThrow();
    });

    it("appends ?limit when a limit argument is provided", async () => {
      mockFetch({ plays: [] });
      await fetchDailyHistory(42);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/daily/history?limit=42");
    });

    it("does not append ?limit when called without arguments", async () => {
      mockFetch({ plays: [] });
      await fetchDailyHistory();
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/daily/history");
    });
  });
});
