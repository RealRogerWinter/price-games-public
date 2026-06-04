/**
 * Tests for deriveRoundOutcome — folds RoundResultsPayload into the
 * three-bucket shape the broadcast overlay panels consume.
 */

import { describe, it, expect } from "vitest";
import type { RoundResultsPayload } from "@price-game/shared";
import {
  deriveRoundOutcome,
  deriveSoloOutcome,
  reactiveLineForOutcome,
  pickOutcomeSpecialEvent,
  computeFinalRankEvent,
  nextMoodShiftEvent,
  parseProbEnv,
  MOOD_POLARITY_TABLE,
  type OutcomeSpecialInput,
  type FinalRankStanding,
} from "../src/runner/outcome";
import { MOOD_LABELS } from "@price-game/shared";

function makeResults(
  scores: { id: string; name: string; score: number }[],
): RoundResultsPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    revealData: {
      mode: "classic",
      product: {
        id: 1,
        title: "USB cable",
        description: "",
        imageUrl: "",
        category: "Electronics",
        priceCents: 1000,
      } as never,
    },
    playerResults: scores.map(({ id, name, score }) => ({
      playerId: id,
      displayName: name,
      avatar: "wizard",
      score,
      guessData: null,
    })),
    standings: scores.map(({ id, name, score }, i) => ({
      playerId: id,
      displayName: name,
      avatar: "wizard",
      totalScore: score,
      placement: i + 1,
    })) as never,
  };
}

describe("deriveRoundOutcome", () => {
  it("returns null when playerResults is empty", () => {
    const payload = makeResults([]);
    expect(deriveRoundOutcome(payload, null, "Pricey")).toBeNull();
  });

  it("solo: score === 0 is incorrect", () => {
    const payload = makeResults([{ id: "p1", name: "Pricey", score: 0 }]);
    const view = deriveRoundOutcome(payload, null, "Pricey");
    expect(view?.outcome).toBe("incorrect");
    expect(view?.points).toBe(0);
    expect(view?.topOpponentScore).toBeUndefined();
  });

  it("solo: any positive score is correct (threshold = score/2)", () => {
    const payload = makeResults([{ id: "p1", name: "Pricey", score: 750 }]);
    const view = deriveRoundOutcome(payload, null, "Pricey");
    expect(view?.outcome).toBe("correct");
    expect(view?.points).toBe(750);
  });

  it("MP: bot score above half-of-best is correct", () => {
    const payload = makeResults([
      { id: "p1", name: "Pricey", score: 800 },
      { id: "p2", name: "Alice", score: 900 },
    ]);
    const view = deriveRoundOutcome(payload, "p1", "Pricey");
    expect(view?.outcome).toBe("correct");
    expect(view?.points).toBe(800);
    expect(view?.topOpponentScore).toBe(900);
  });

  it("MP: bot score below half-of-best is partial", () => {
    const payload = makeResults([
      { id: "p1", name: "Pricey", score: 200 },
      { id: "p2", name: "Alice", score: 900 },
    ]);
    const view = deriveRoundOutcome(payload, "p1", "Pricey");
    expect(view?.outcome).toBe("partial");
    expect(view?.points).toBe(200);
    expect(view?.topOpponentScore).toBe(900);
  });

  it("falls back to displayName match when myPlayerId is null", () => {
    const payload = makeResults([
      { id: "p2", name: "Alice", score: 900 },
      { id: "p1", name: "Pricey", score: 100 },
    ]);
    const view = deriveRoundOutcome(payload, null, "Pricey");
    expect(view?.points).toBe(100);
    expect(view?.outcome).toBe("partial");
  });

  it("falls back to first entry when neither id nor name matches", () => {
    const payload = makeResults([
      { id: "p2", name: "Alice", score: 100 },
      { id: "p3", name: "Bob", score: 200 },
    ]);
    const view = deriveRoundOutcome(payload, null, "Pricey");
    expect(view?.points).toBe(100);
    expect(view?.topOpponentScore).toBe(200);
  });
});

describe("deriveSoloOutcome", () => {
  it("score === 0 is incorrect, regardless of mode", () => {
    expect(deriveSoloOutcome(0, "classic")).toEqual({ outcome: "incorrect", points: 0 });
    expect(deriveSoloOutcome(0, "chain-reaction")).toEqual({ outcome: "incorrect", points: 0 });
  });

  it("classic: score >= 500 (50% of 1000) is correct, < 500 is partial", () => {
    // 50% boundary — anything below is "partial" (still scored, but
    // below the canonical win threshold the price.game UI uses).
    expect(deriveSoloOutcome(499, "classic").outcome).toBe("partial");
    expect(deriveSoloOutcome(500, "classic").outcome).toBe("correct");
    expect(deriveSoloOutcome(750, "classic").outcome).toBe("correct");
    expect(deriveSoloOutcome(1000, "classic").outcome).toBe("correct");
  });

  it("chain-reaction: 50% threshold tracks the higher (1313) per-round max", () => {
    // 50% of 1313 = 656.5; safeScore is floored, so 656 is partial,
    // 657 is correct. Pre-fix any non-zero score was correct.
    expect(deriveSoloOutcome(500, "chain-reaction").outcome).toBe("partial");
    expect(deriveSoloOutcome(656, "chain-reaction").outcome).toBe("partial");
    expect(deriveSoloOutcome(657, "chain-reaction").outcome).toBe("correct");
    expect(deriveSoloOutcome(1313, "chain-reaction").outcome).toBe("correct");
  });

  it("points are floored to integer regardless of bucket", () => {
    expect(deriveSoloOutcome(750.9, "classic")).toEqual({ outcome: "correct", points: 750 });
    expect(deriveSoloOutcome(120.7, "classic")).toEqual({ outcome: "partial", points: 120 });
  });

  it("treats negative / NaN / Infinity as incorrect (defensive)", () => {
    expect(deriveSoloOutcome(-50, "classic")).toEqual({ outcome: "incorrect", points: 0 });
    expect(deriveSoloOutcome(Number.NaN, "classic")).toEqual({ outcome: "incorrect", points: 0 });
    expect(deriveSoloOutcome(Number.POSITIVE_INFINITY, "classic")).toEqual({ outcome: "incorrect", points: 0 });
  });
});

describe("reactiveLineForOutcome", () => {
  it("correct → win_correct", () => {
    expect(reactiveLineForOutcome("correct")).toBe("win_correct");
  });

  it("partial → loss_off_a_little", () => {
    expect(reactiveLineForOutcome("partial")).toBe("loss_off_a_little");
  });

  it("incorrect → loss_off_a_lot", () => {
    expect(reactiveLineForOutcome("incorrect")).toBe("loss_off_a_lot");
  });

  it("agrees with the mood-input mapping in attemptRound", () => {
    // Pin the contract: each outcome bucket maps to a line in the
    // same emotional polarity as the moodInput it produces. If a
    // future PR reshuffles either mapping, this test prompts an
    // explicit re-alignment instead of letting the spoken line drift
    // from the displayed mood.
    expect(reactiveLineForOutcome("correct")).toMatch(/^win_/);
    expect(reactiveLineForOutcome("partial")).toMatch(/^loss_/);
    expect(reactiveLineForOutcome("incorrect")).toMatch(/^loss_/);
  });
});

describe("pickOutcomeSpecialEvent", () => {
  // Default fixture — represents a "normal correct round" with no
  // special conditions met. Tests override the fields they care about.
  const baseInput: OutcomeSpecialInput = {
    roundPoints: 500,
    perRoundMaxScore: 1000,
    bullseyeFraction: 0.95,
    prevStreak: 1,
    nextStreak: 2,
    streakMilestones: new Set([3, 5, 10]),
    currentGameBestScore: 500,
    currentGameRoundIndex: 2,
  };

  it("returns null when no special condition matches", () => {
    expect(pickOutcomeSpecialEvent(baseInput)).toBeNull();
  });

  it("round_bullseye fires when score is at threshold", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, roundPoints: 950, perRoundMaxScore: 1000 });
    expect(r).toBe("round_bullseye");
  });

  it("round_bullseye fires above threshold", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, roundPoints: 1000, perRoundMaxScore: 1000 });
    expect(r).toBe("round_bullseye");
  });

  it("round_bullseye does NOT fire just below threshold", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, roundPoints: 949, perRoundMaxScore: 1000 });
    expect(r).not.toBe("round_bullseye");
  });

  it("round_bullseye guards perRoundMaxScore=0 (avoid /0)", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, roundPoints: 0, perRoundMaxScore: 0 });
    expect(r).not.toBe("round_bullseye");
  });

  it("comeback fires when prev streak ≤ -3 AND next is positive", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, prevStreak: -3, nextStreak: 1 });
    expect(r).toBe("comeback");
  });

  it("comeback does not fire on a -2 → +1 flip (prior streak too short)", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      prevStreak: -2,
      nextStreak: 1,
      currentGameRoundIndex: 0, // suppress personal_best fallback
    });
    expect(r).toBeNull();
  });

  it("streak_milestone fires when winning streak crosses a threshold", () => {
    const r = pickOutcomeSpecialEvent({ ...baseInput, prevStreak: 2, nextStreak: 3 });
    expect(r).toBe("streak_milestone");
  });

  it("streak_milestone does NOT fire on losing streaks (negative magnitudes)", () => {
    // Critical regression test — losing-streak narration was previously
    // misrouted to the celebratory streak_milestone pool.
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      prevStreak: -2,
      nextStreak: -3,
      currentGameRoundIndex: 0,
    });
    expect(r).toBeNull();
  });

  it("streak_milestone does NOT fire on the round we sit at (vs cross) the milestone", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      prevStreak: 3,
      nextStreak: 3,
      currentGameRoundIndex: 0,
    });
    expect(r).toBeNull();
  });

  it("personal_best_round fires when round score beats running high", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      roundPoints: 600,
      currentGameBestScore: 500,
      currentGameRoundIndex: 2,
    });
    expect(r).toBe("personal_best_round");
  });

  it("personal_best_round suppressed on round 0 (trivially the best)", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      roundPoints: 600,
      currentGameBestScore: 0,
      currentGameRoundIndex: 0,
    });
    expect(r).toBeNull();
  });

  it("priority: bullseye outranks comeback", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      roundPoints: 1000,
      perRoundMaxScore: 1000,
      prevStreak: -5,
      nextStreak: 1,
    });
    expect(r).toBe("round_bullseye");
  });

  it("priority: comeback outranks streak_milestone", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      prevStreak: -3,
      nextStreak: 3,
    });
    // Both comeback and streak_milestone are eligible at -3 → +3, but
    // comeback is the more meaningful narrative beat.
    expect(r).toBe("comeback");
  });

  it("priority: streak_milestone outranks personal_best_round", () => {
    const r = pickOutcomeSpecialEvent({
      ...baseInput,
      prevStreak: 4,
      nextStreak: 5,
      // Keep score sub-bullseye so the higher-priority round_bullseye
      // doesn't fire — we're testing the milestone-vs-PB precedence.
      roundPoints: 700,
      perRoundMaxScore: 1000,
      currentGameBestScore: 500,
      currentGameRoundIndex: 3,
    });
    expect(r).toBe("streak_milestone");
  });
});

describe("computeFinalRankEvent", () => {
  function s(playerId: string, displayName: string, totalScore: number): FinalRankStanding {
    return { playerId, displayName, totalScore };
  }

  it("returns null for missing standings", () => {
    expect(computeFinalRankEvent(undefined, "p1", "Pricey")).toBeNull();
  });

  it("returns null for empty standings", () => {
    expect(computeFinalRankEvent([], "p1", "Pricey")).toBeNull();
  });

  it("returns null for solo-collapsed (single seat) standings", () => {
    expect(computeFinalRankEvent([s("p1", "Pricey", 500)], "p1", "Pricey")).toBeNull();
  });

  it("first when bot's score is strictly highest", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Pricey", 800), s("p2", "Alice", 500), s("p3", "Bob", 200)],
      "p1",
      "Pricey",
    );
    expect(r).toBe("final_rank_first");
  });

  it("first when bot ties at the top (matches decideMpGameWin tie rule)", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Pricey", 800), s("p2", "Alice", 800), s("p3", "Bob", 200)],
      "p1",
      "Pricey",
    );
    expect(r).toBe("final_rank_first");
  });

  it("last when no opponent scored less", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Pricey", 100), s("p2", "Alice", 500), s("p3", "Bob", 800)],
      "p1",
      "Pricey",
    );
    expect(r).toBe("final_rank_last");
  });

  it("middle when at least one above and one below", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Pricey", 500), s("p2", "Alice", 800), s("p3", "Bob", 100)],
      "p1",
      "Pricey",
    );
    expect(r).toBe("final_rank_middle");
  });

  it("identity match prefers playerId over displayName", () => {
    // Adversarial: an opponent has the bot's persona name. playerId
    // wins; the bot is correctly identified as the high seat.
    const r = computeFinalRankEvent(
      [s("p1", "Pricey", 800), s("p2", "Pricey", 100)],
      "p1",
      "Pricey",
    );
    expect(r).toBe("final_rank_first");
  });

  it("falls back to displayName when playerId is null", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Alice", 100), s("p2", "Pricey", 800)],
      null,
      "Pricey",
    );
    expect(r).toBe("final_rank_first");
  });

  it("falls back to first seat when neither id nor name matches", () => {
    const r = computeFinalRankEvent(
      [s("p1", "Alice", 800), s("p2", "Bob", 200)],
      null,
      "Pricey",
    );
    // Defaults to standings[0] which is Alice in first place.
    expect(r).toBe("final_rank_first");
  });
});

describe("nextMoodShiftEvent", () => {
  it("returns null when mood is unchanged", () => {
    expect(nextMoodShiftEvent("happy", "happy")).toBeNull();
  });

  it("returns null when polarity bucket is unchanged (focused ↔ neutral)", () => {
    // Same polarity (0) — re-label only, not an affective shift.
    expect(nextMoodShiftEvent("focused", "neutral")).toBeNull();
    expect(nextMoodShiftEvent("neutral", "focused")).toBeNull();
  });

  it("returns mood_shift_up for ascending polarity", () => {
    expect(nextMoodShiftEvent("neutral", "happy")).toBe("mood_shift_up");
    expect(nextMoodShiftEvent("tilted", "neutral")).toBe("mood_shift_up");
    expect(nextMoodShiftEvent("frustrated", "confident")).toBe("mood_shift_up");
  });

  it("returns mood_shift_down for descending polarity", () => {
    expect(nextMoodShiftEvent("happy", "neutral")).toBe("mood_shift_down");
    expect(nextMoodShiftEvent("confident", "tilted")).toBe("mood_shift_down");
  });

  it("returns mood_extreme when entering elated regardless of direction", () => {
    expect(nextMoodShiftEvent("happy", "elated")).toBe("mood_extreme");
    expect(nextMoodShiftEvent("neutral", "elated")).toBe("mood_extreme");
    expect(nextMoodShiftEvent("tilted", "elated")).toBe("mood_extreme");
  });

  it("returns mood_extreme when entering despondent regardless of direction", () => {
    expect(nextMoodShiftEvent("frustrated", "despondent")).toBe("mood_extreme");
    expect(nextMoodShiftEvent("happy", "despondent")).toBe("mood_extreme");
  });

  it("MOOD_POLARITY_TABLE covers every label in MOOD_LABELS", () => {
    // Pin the contract: a future mood addition in @price-game/shared
    // must come with a polarity entry, otherwise nextMoodShiftEvent
    // would treat it as polarity 0 (i.e., never trigger a shift).
    for (const mood of MOOD_LABELS) {
      expect(MOOD_POLARITY_TABLE).toHaveProperty(mood);
    }
  });

  it("MOOD_POLARITY_TABLE assigns elated highest and despondent lowest", () => {
    const values = Object.values(MOOD_POLARITY_TABLE);
    expect(MOOD_POLARITY_TABLE.elated).toBe(Math.max(...values));
    expect(MOOD_POLARITY_TABLE.despondent).toBe(Math.min(...values));
  });
});

describe("parseProbEnv", () => {
  it("returns fallback when env is undefined", () => {
    expect(parseProbEnv(undefined, 0.3)).toBe(0.3);
  });

  it("returns fallback when env is empty string (regression for #338 critical)", () => {
    // The naive `Number(process.env.X ?? "")` form returned 0 here,
    // silently disabling the wired default. Pinning the fix.
    expect(parseProbEnv("", 0.3)).toBe(0.3);
  });

  it("returns fallback when env is non-numeric", () => {
    expect(parseProbEnv("nope", 0.5)).toBe(0.5);
  });

  it("clamps values above 1 to 1", () => {
    expect(parseProbEnv("2.5", 0.3)).toBe(1);
  });

  it("clamps values below 0 to 0", () => {
    expect(parseProbEnv("-0.5", 0.3)).toBe(0);
  });

  it("passes through valid in-range values", () => {
    expect(parseProbEnv("0.6", 0.3)).toBe(0.6);
    expect(parseProbEnv("0", 0.3)).toBe(0);
    expect(parseProbEnv("1", 0.3)).toBe(1);
  });
});
