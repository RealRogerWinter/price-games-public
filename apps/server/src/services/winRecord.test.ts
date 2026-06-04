import { describe, it, expect } from "vitest";
import {
  computeIsWin,
  nextStreak,
  WIN_RATIO_THRESHOLD,
  getPerRoundMaxScore,
} from "@price-game/shared";

describe("computeIsWin — single player", () => {
  const baseArgs = {
    gameType: "single" as const,
    gameMode: "classic" as const,
    totalRounds: 10,
    placement: null,
    playersCount: null,
    isBotPlayer: false,
  };

  it("counts a score at exactly 50% of max as a win (threshold is inclusive)", () => {
    const max = getPerRoundMaxScore("classic") * 10; // 10000
    expect(computeIsWin({ ...baseArgs, score: max * WIN_RATIO_THRESHOLD })).toBe(true);
  });

  it("counts a score just below 50% of max as a loss", () => {
    const max = getPerRoundMaxScore("classic") * 10;
    expect(computeIsWin({ ...baseArgs, score: max * WIN_RATIO_THRESHOLD - 1 })).toBe(false);
  });

  it("counts a perfect score as a win", () => {
    const max = getPerRoundMaxScore("classic") * 10;
    expect(computeIsWin({ ...baseArgs, score: max })).toBe(true);
  });

  it("counts a zero score as a loss", () => {
    expect(computeIsWin({ ...baseArgs, score: 0 })).toBe(false);
  });

  it("uses chain-reaction's higher per-round max (1313 not 1000)", () => {
    const args = { ...baseArgs, gameMode: "chain-reaction" as const, totalRounds: 5 };
    // 50% of 1313 * 5 = 3282.5; 3282 should be a loss, 3283 a win.
    expect(computeIsWin({ ...args, score: 3282 })).toBe(false);
    expect(computeIsWin({ ...args, score: 3283 })).toBe(true);
  });

  it("returns null when totalRounds is 0 (defensive — should never happen in prod)", () => {
    expect(computeIsWin({ ...baseArgs, totalRounds: 0, score: 5000 })).toBeNull();
  });
});

describe("computeIsWin — multiplayer", () => {
  const baseArgs = {
    gameType: "multiplayer" as const,
    gameMode: "classic" as const,
    totalRounds: 10,
    score: 5000,
    isBotPlayer: false,
  };

  it("counts placement 1 as a win", () => {
    expect(
      computeIsWin({ ...baseArgs, placement: 1, playersCount: 4 }),
    ).toBe(true);
  });

  it("counts placement 2+ as a loss", () => {
    expect(
      computeIsWin({ ...baseArgs, placement: 2, playersCount: 4 }),
    ).toBe(false);
    expect(
      computeIsWin({ ...baseArgs, placement: 4, playersCount: 4 }),
    ).toBe(false);
  });

  it("returns null when placement is missing (disconnect / not yet ranked)", () => {
    expect(
      computeIsWin({ ...baseArgs, placement: null, playersCount: 4 }),
    ).toBeNull();
  });

  it("returns null for solo MP rooms (anti-streak-farming)", () => {
    expect(
      computeIsWin({ ...baseArgs, placement: 1, playersCount: 1 }),
    ).toBeNull();
  });

  it("returns null when playersCount is missing", () => {
    expect(
      computeIsWin({ ...baseArgs, placement: 1, playersCount: null }),
    ).toBeNull();
  });
});

describe("computeIsWin — bot rows", () => {
  it("always returns null for bot players, regardless of score or placement", () => {
    expect(
      computeIsWin({
        gameType: "single",
        gameMode: "classic",
        totalRounds: 10,
        score: 10000,
        placement: null,
        playersCount: null,
        isBotPlayer: true,
      }),
    ).toBeNull();
    expect(
      computeIsWin({
        gameType: "multiplayer",
        gameMode: "classic",
        totalRounds: 10,
        score: 5000,
        placement: 1,
        playersCount: 4,
        isBotPlayer: true,
      }),
    ).toBeNull();
  });
});

describe("nextStreak", () => {
  it("extends a positive streak by +1 on a win", () => {
    expect(nextStreak(3, true)).toBe(4);
    expect(nextStreak(0, true)).toBe(1);
  });

  it("extends a negative streak by -1 on a loss", () => {
    expect(nextStreak(-2, false)).toBe(-3);
    expect(nextStreak(0, false)).toBe(-1);
  });

  it("flips a negative streak to +1 on a win", () => {
    expect(nextStreak(-5, true)).toBe(1);
  });

  it("flips a positive streak to -1 on a loss", () => {
    expect(nextStreak(7, false)).toBe(-1);
  });

  it("leaves the streak unchanged when the outcome is null (skipped game)", () => {
    expect(nextStreak(5, null)).toBe(5);
    expect(nextStreak(-2, null)).toBe(-2);
    expect(nextStreak(0, null)).toBe(0);
  });
});
