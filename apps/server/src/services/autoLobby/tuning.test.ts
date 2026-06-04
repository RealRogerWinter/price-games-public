import { describe, it, expect } from "vitest";
import {
  getDisguisedBotTuning,
  getRampedTuning,
  AUTO_LOBBY_BASELINE,
  AUTO_LOBBY_SOFT,
  ARCHETYPE_MIX_AUTO,
} from "./tuning";

describe("AUTO_LOBBY_BASELINE", () => {
  it("inflates sigma over standard bot tuning (1.25x marker)", () => {
    expect(AUTO_LOBBY_BASELINE.sigmaMultiplier).toBeCloseTo(1.25, 5);
  });

  it("uses categorical correctness 48/60/72 — matches game-design spec", () => {
    expect(AUTO_LOBBY_BASELINE.categoricalCorrectness.easy).toBeCloseTo(0.48, 5);
    expect(AUTO_LOBBY_BASELINE.categoricalCorrectness.medium).toBeCloseTo(0.60, 5);
    expect(AUTO_LOBBY_BASELINE.categoricalCorrectness.hard).toBeCloseTo(0.72, 5);
  });

  it("miss rate is 3%", () => {
    expect(AUTO_LOBBY_BASELINE.missRate).toBeCloseTo(0.03, 5);
  });
});

describe("AUTO_LOBBY_SOFT", () => {
  it("is strictly easier than baseline (higher sigma, lower correctness)", () => {
    expect(AUTO_LOBBY_SOFT.sigmaMultiplier).toBeGreaterThan(AUTO_LOBBY_BASELINE.sigmaMultiplier);
    expect(AUTO_LOBBY_SOFT.categoricalCorrectness.easy).toBeLessThan(AUTO_LOBBY_BASELINE.categoricalCorrectness.easy);
    expect(AUTO_LOBBY_SOFT.categoricalCorrectness.hard).toBeLessThan(AUTO_LOBBY_BASELINE.categoricalCorrectness.hard);
  });

  it("expert weight is heavily reduced vs baseline auto-lobby mix", () => {
    expect(AUTO_LOBBY_SOFT.archetypeMix.expert).toBeLessThan(ARCHETYPE_MIX_AUTO.expert);
  });
});

describe("ARCHETYPE_MIX_AUTO", () => {
  it("sums to 1", () => {
    const sum = Object.values(ARCHETYPE_MIX_AUTO).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("expert weight is roughly half of standard hard mix (capped at 10%)", () => {
    expect(ARCHETYPE_MIX_AUTO.expert).toBeLessThanOrEqual(0.10);
  });
});

describe("getRampedTuning", () => {
  it("returns soft profile for games 0-1", () => {
    expect(getRampedTuning(0)).toEqual(AUTO_LOBBY_SOFT);
    expect(getRampedTuning(1)).toEqual(AUTO_LOBBY_SOFT);
  });

  it("interpolates between soft and baseline for games 2-4", () => {
    const g2 = getRampedTuning(2);
    expect(g2.sigmaMultiplier).toBeGreaterThan(AUTO_LOBBY_BASELINE.sigmaMultiplier);
    expect(g2.sigmaMultiplier).toBeLessThan(AUTO_LOBBY_SOFT.sigmaMultiplier);
  });

  it("returns baseline for games 5+", () => {
    expect(getRampedTuning(5)).toEqual(AUTO_LOBBY_BASELINE);
    expect(getRampedTuning(50)).toEqual(AUTO_LOBBY_BASELINE);
  });

  it("treats negative inputs as game 0", () => {
    expect(getRampedTuning(-3)).toEqual(AUTO_LOBBY_SOFT);
  });
});

describe("getDisguisedBotTuning", () => {
  it("returns ramped profile when disguised", () => {
    const t = getDisguisedBotTuning({ disguised: true, gamesPlayed: 0 });
    expect(t).toEqual(AUTO_LOBBY_SOFT);
  });

  it("returns null for labeled (non-disguised) bots — they use baseline pipeline", () => {
    const t = getDisguisedBotTuning({ disguised: false, gamesPlayed: 0 });
    expect(t).toBeNull();
  });
});
