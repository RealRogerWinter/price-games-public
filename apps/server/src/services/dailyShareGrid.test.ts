import { describe, it, expect } from "vitest";
import {
  buildDailyShareText,
  normalizeDailyRoundScores,
  DAILY_TOTAL_ROUNDS,
  SHARE_FOOTER_URL,
  type DailyShareGridInput,
  type GameMode,
} from "@price-game/shared";

function makeDailyInput(overrides: Partial<DailyShareGridInput> = {}): DailyShareGridInput {
  const gameMode: GameMode = overrides.gameMode ?? "classic";
  return {
    gameMode,
    modeName: overrides.modeName ?? "Precision",
    roundScores: overrides.roundScores ?? [1000, 1000, 1000, 1000, 1000],
    totalScore: overrides.totalScore ?? 5000,
    perRoundMax: overrides.perRoundMax ?? 1000,
    dailyNumber: overrides.dailyNumber ?? 42,
    streak: overrides.streak,
  };
}

describe("normalizeDailyRoundScores", () => {
  it("returns exactly DAILY_TOTAL_ROUNDS entries (5)", () => {
    expect(normalizeDailyRoundScores([1000, 1000, 1000, 1000, 1000])).toHaveLength(5);
  });

  it("right-pads short arrays with 0", () => {
    expect(normalizeDailyRoundScores([900])).toEqual([900, 0, 0, 0, 0]);
    expect(normalizeDailyRoundScores([])).toEqual([0, 0, 0, 0, 0]);
  });

  it("truncates long arrays to 5", () => {
    expect(normalizeDailyRoundScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("buildDailyShareText", () => {
  it("includes the Daily #N header with mode and score/max", () => {
    const text = buildDailyShareText(makeDailyInput({ dailyNumber: 42, totalScore: 4500 }));
    expect(text).toContain("Daily #42");
    expect(text).toContain("Precision");
    expect(text).toContain("4,500/5,000");
  });

  it("emits a single 5-tile pip row, not the standard 2x5 grid", () => {
    const text = buildDailyShareText(
      makeDailyInput({ roundScores: [1000, 1000, 1000, 1000, 1000] })
    );
    const lines = text.split("\n");
    // Header, pip row, footer = 3 lines minimum (when no streak).
    expect(lines).toHaveLength(3);
    // The pip row should have exactly 5 emoji tiles. Each tile is 2 code units
    // (UTF-16 surrogate pair) so length should be 10.
    expect(lines[1]).toBe("🟩🟩🟩🟩🟩");
  });

  it("does not include any /s/ short URL even if a shareUrl is somehow available", () => {
    const text = buildDailyShareText(makeDailyInput());
    expect(text).not.toContain("/s/");
    expect(text).toContain(SHARE_FOOTER_URL);
  });

  it("includes a streak flame line only when streak >= 3", () => {
    expect(buildDailyShareText(makeDailyInput({ streak: 0 }))).not.toContain("streak");
    expect(buildDailyShareText(makeDailyInput({ streak: 1 }))).not.toContain("streak");
    expect(buildDailyShareText(makeDailyInput({ streak: 2 }))).not.toContain("streak");
    const withStreak = buildDailyShareText(makeDailyInput({ streak: 3 }));
    expect(withStreak).toContain("🔥");
    expect(withStreak).toContain("3-day streak");
    const big = buildDailyShareText(makeDailyInput({ streak: 47 }));
    expect(big).toContain("47-day streak");
  });

  it("uses miss tile for zero scores in the row", () => {
    const text = buildDailyShareText(
      makeDailyInput({ roundScores: [1000, 0, 1000, 0, 1000] })
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("🟩⬛🟩⬛🟩");
  });

  it("pads short round score arrays with miss tiles", () => {
    const text = buildDailyShareText(
      makeDailyInput({ roundScores: [1000, 1000] })
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("🟩🟩⬛⬛⬛");
  });

  it("truncates long round score arrays to 5", () => {
    const text = buildDailyShareText(
      makeDailyInput({ roundScores: [1000, 1000, 1000, 1000, 1000, 1000, 1000] })
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("🟩🟩🟩🟩🟩");
  });

  it("computes max as perRoundMax * DAILY_TOTAL_ROUNDS (5), not standard 10", () => {
    const text = buildDailyShareText(makeDailyInput({ perRoundMax: 1000, totalScore: 5000 }));
    expect(text).toContain("/5,000");
    expect(text).not.toContain("/10,000");
  });

  it("formats large scores with thousands separators", () => {
    const text = buildDailyShareText(
      makeDailyInput({ totalScore: 5000, perRoundMax: 1313, dailyNumber: 1234 })
    );
    expect(text).toContain("Daily #1234");
    expect(text).toContain("/6,565"); // 1313 * 5
    expect(text).toContain("5,000");
  });

  it("DAILY_TOTAL_ROUNDS is 5 (sanity)", () => {
    expect(DAILY_TOTAL_ROUNDS).toBe(5);
  });
});
