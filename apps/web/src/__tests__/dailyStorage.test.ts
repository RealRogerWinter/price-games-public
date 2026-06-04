import { describe, it, expect, beforeEach } from "vitest";
import {
  readAnonLastCompleted,
  markAnonCompleted,
  clearAnonDailyState,
} from "../utils/dailyStorage";

beforeEach(() => {
  // jsdom localStorage persists between tests within a file; reset per test.
  localStorage.clear();
});

describe("markAnonCompleted / readAnonLastCompleted", () => {
  it("returns null when no completion stored", () => {
    expect(readAnonLastCompleted()).toBeNull();
  });

  it("round-trips a completion date", () => {
    markAnonCompleted("2026-04-15");
    expect(readAnonLastCompleted()).toBe("2026-04-15");
  });
});

describe("clearAnonDailyState", () => {
  it("removes the anonymous last-completed key", () => {
    markAnonCompleted("2026-04-15");
    clearAnonDailyState();
    expect(readAnonLastCompleted()).toBeNull();
  });

  it("also wipes legacy anon-streak keys from previous builds", () => {
    // Older builds stored anonymous streak counters here. We continue to
    // clear them so a long-lived browser doesn't accumulate dead state.
    localStorage.setItem("priceGames.daily.streak.current", "7");
    localStorage.setItem("priceGames.daily.streak.best", "12");
    localStorage.setItem("priceGames.daily.streak.lastDate", "2026-04-15");

    clearAnonDailyState();

    expect(localStorage.getItem("priceGames.daily.streak.current")).toBeNull();
    expect(localStorage.getItem("priceGames.daily.streak.best")).toBeNull();
    expect(localStorage.getItem("priceGames.daily.streak.lastDate")).toBeNull();
  });
});
