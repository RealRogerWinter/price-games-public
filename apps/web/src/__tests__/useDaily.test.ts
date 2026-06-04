import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDaily } from "../hooks/useDaily";
import * as dailyClient from "../api/dailyClient";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDaily", () => {
  it("starts in loading and transitions to ready on successful fetch", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      alreadyPlayed: false,
      streak: { current: 0, best: 0, lastDate: null },
    });

    const { result } = renderHook(() => useDaily());
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.today?.gameMode).toBe("comparison");
    expect(result.current.streak?.current).toBe(0);
  });

  it("transitions to unavailable on DailyDisabledError", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockRejectedValueOnce(
      new dailyClient.DailyDisabledError("disabled"),
    );
    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
  });

  it("transitions to error on other errors", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockRejectedValueOnce(
      new Error("network down"),
    );
    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("transitions to already-played when alreadyPlayed=true", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      alreadyPlayed: true,
      streak: { current: 3, best: 7, lastDate: "2026-04-14" },
    });
    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("already-played"));
  });

  it("anonymous user with no logged-in alreadyPlayed flag uses localStorage as fallback", async () => {
    localStorage.setItem("priceGames.daily.lastCompleted", "2026-04-15");
    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      // No alreadyPlayed field — anonymous response
    });
    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("already-played"));
  });

  // Regression guard: previously this hook fell back to a localStorage
  // streak counter for anonymous sessions. That value had no relationship
  // to any account-bound history (it could survive sign-in, drift across
  // devices, and falsely encourage users mid-session that they had a
  // streak the server didn't know about). It now returns `null` so the
  // UI prompts the user to "Start a streak" instead.
  it("returns null streak for an anonymous session even with legacy localStorage values", async () => {
    localStorage.setItem("priceGames.daily.streak.current", "5");
    localStorage.setItem("priceGames.daily.streak.best", "9");
    localStorage.setItem("priceGames.daily.streak.lastDate", "2026-04-15");

    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      // No alreadyPlayed field — anonymous response, no `streak` field either.
    });

    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.streak).toBeNull();
  });

  it("start() transitions to playing on success", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      alreadyPlayed: false,
    });
    vi.spyOn(dailyClient, "startDaily").mockResolvedValueOnce({
      id: "session-1",
      currentRound: 1,
      totalRounds: 5,
      totalScore: 0,
      completed: false,
      gameMode: "comparison",
    });

    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    let session;
    await act(async () => {
      session = await result.current.start();
    });
    expect(session).toBeDefined();
    expect(result.current.state).toBe("playing");
  });

  it("start() transitions to already-played on DailyAlreadyPlayedError", async () => {
    vi.spyOn(dailyClient, "fetchDailyToday").mockResolvedValueOnce({
      date: "2026-04-15",
      gameMode: "comparison",
      modeName: "Comparison",
      totalRounds: 5,
      alreadyPlayed: false,
    });
    vi.spyOn(dailyClient, "startDaily").mockRejectedValueOnce(
      new dailyClient.DailyAlreadyPlayedError("already_played"),
    );

    const { result } = renderHook(() => useDaily());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    await act(async () => {
      try {
        await result.current.start();
      } catch {
        // expected
      }
    });
    await waitFor(() => expect(result.current.state).toBe("already-played"));
  });
});
