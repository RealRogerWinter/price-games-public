import { describe, it, expect } from "vitest";
import { computeMoodScale, signedCreditGain } from "../src/persona/moodScale";
import { INITIAL_MOOD, type MoodState } from "../src/persona/mood";
import { MOOD_LABELS, type Mood } from "@price-game/shared";

function stateOf(mood: Mood, vibe = 0, morale = 0, streak = 0): MoodState {
  return { mood, vibe, morale, streak };
}

describe("computeMoodScale — identity at moodInfluence=0", () => {
  it("returns { 1, 0, 1 } exactly at moodInfluence=0 regardless of mood", () => {
    for (const mood of MOOD_LABELS) {
      const s = computeMoodScale(stateOf(mood, 3, 1, 5), 0);
      expect(s.tempScale).toBe(1);
      expect(s.epsilonBump).toBe(0);
      expect(s.arousalGain).toBe(1);
    }
  });

  it("returns { 1, 0, 1 } exactly at moodInfluence=0 with INITIAL_MOOD", () => {
    const s = computeMoodScale(INITIAL_MOOD, 0);
    expect(s).toEqual({ tempScale: 1, epsilonBump: 0, arousalGain: 1 });
  });
});

describe("computeMoodScale — per-mood base table at moodInfluence=1, vibe=0", () => {
  // At vibe=0, intensity = tanh(0) = 0, so the smoothing factor is
  // (1 + 0.3·0) = 1. tempScale collapses to 1 + 1·(BASE-1) = BASE.
  // Pin the per-mood base values here so a future tweak doesn't
  // silently shift behaviour across thousands of rounds.
  const cases: Array<{ mood: Mood; tempScale: number; epsilonBump: number }> = [
    { mood: "neutral", tempScale: 1.00, epsilonBump: 0 },
    { mood: "happy", tempScale: 0.95, epsilonBump: 0 },
    { mood: "confident", tempScale: 0.85, epsilonBump: 0 },
    { mood: "elated", tempScale: 1.05, epsilonBump: 0 },
    { mood: "focused", tempScale: 0.70, epsilonBump: 0 },
    { mood: "tilted", tempScale: 1.15, epsilonBump: 0.02 },
    { mood: "frustrated", tempScale: 1.25, epsilonBump: 0.04 },
    { mood: "despondent", tempScale: 1.30, epsilonBump: 0.05 },
  ];

  for (const c of cases) {
    it(`${c.mood} → tempScale=${c.tempScale}, epsilonBump=${c.epsilonBump}`, () => {
      const s = computeMoodScale(stateOf(c.mood, 0, 0, 0), 1);
      expect(s.tempScale).toBeCloseTo(c.tempScale, 6);
      expect(s.epsilonBump).toBeCloseTo(c.epsilonBump, 6);
      // arousalGain at vibe=0 is identity regardless of mood.
      expect(s.arousalGain).toBe(1);
    });
  }
});

describe("computeMoodScale — bounds enforced", () => {
  it("tempScale bounded to [0.6, 1.6] for any state and influence", () => {
    for (const mood of MOOD_LABELS) {
      for (const vibe of [-3, -1.5, 0, 1.5, 3]) {
        for (const inf of [0, 0.25, 0.5, 0.75, 1]) {
          const s = computeMoodScale(stateOf(mood, vibe), inf);
          expect(s.tempScale).toBeGreaterThanOrEqual(0.6);
          expect(s.tempScale).toBeLessThanOrEqual(1.6);
        }
      }
    }
  });

  it("epsilonBump bounded to [0, 0.05]", () => {
    for (const mood of MOOD_LABELS) {
      for (const vibe of [-3, 0, 3]) {
        const s = computeMoodScale(stateOf(mood, vibe), 1);
        expect(s.epsilonBump).toBeGreaterThanOrEqual(0);
        expect(s.epsilonBump).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it("arousalGain bounded to [1, ~1.27] at full influence", () => {
    for (const mood of MOOD_LABELS) {
      for (const vibe of [-3, -1.5, 0, 1.5, 3]) {
        const s = computeMoodScale(stateOf(mood, vibe), 1);
        expect(s.arousalGain).toBeGreaterThanOrEqual(1);
        // tanh(1.5) ≈ 0.905; max gain = 1 + 0.3·0.905 ≈ 1.272.
        expect(s.arousalGain).toBeLessThanOrEqual(1.272);
      }
    }
  });

  it("epsilonBump is zero for non-negative-valence moods regardless of vibe", () => {
    for (const mood of ["neutral", "happy", "confident", "elated", "focused"] as const) {
      for (const vibe of [-3, 0, 3]) {
        const s = computeMoodScale(stateOf(mood, vibe), 1);
        expect(s.epsilonBump).toBe(0);
      }
    }
  });

  it("clamps an out-of-range moodInfluence silently (defence in depth)", () => {
    // Loader should already validate; this is the second line of
    // defence in case a caller bypasses loadPersonaFromEnv.
    const sNeg = computeMoodScale(stateOf("frustrated", 0), -0.5);
    expect(sNeg.tempScale).toBe(1);
    expect(sNeg.epsilonBump).toBe(0);
    const sBig = computeMoodScale(stateOf("frustrated", 0), 5);
    const sOne = computeMoodScale(stateOf("frustrated", 0), 1);
    expect(sBig).toEqual(sOne);
  });
});

describe("computeMoodScale — vibe-magnitude smoothing", () => {
  it("tempScale departs further from 1 as |vibe| grows for amplifying moods", () => {
    // For frustrated (BASE=1.25), more |vibe| → tempScale farther
    // above 1. Strict monotone in |vibe| at fixed influence.
    const v0 = computeMoodScale(stateOf("frustrated", 0), 1).tempScale;
    const v1 = computeMoodScale(stateOf("frustrated", -1), 1).tempScale;
    const v3 = computeMoodScale(stateOf("frustrated", -3), 1).tempScale;
    expect(v0).toBeLessThan(v1);
    expect(v1).toBeLessThan(v3);
  });

  it("tempScale departs further from 1 as |vibe| grows for tightening moods", () => {
    // For focused (BASE=0.70), more |vibe| → tempScale farther
    // below 1.
    const v0 = computeMoodScale(stateOf("focused", 0), 1).tempScale;
    const v1 = computeMoodScale(stateOf("focused", 1), 1).tempScale;
    const v3 = computeMoodScale(stateOf("focused", 3), 1).tempScale;
    expect(v0).toBeGreaterThan(v1);
    expect(v1).toBeGreaterThan(v3);
  });

  it("arousalGain is symmetric in vibe sign — extreme positive AND negative both up-weight learning (GANE, not signed Eldar-Niv)", () => {
    const pos = computeMoodScale(stateOf("happy", 2.5), 1).arousalGain;
    const neg = computeMoodScale(stateOf("frustrated", -2.5), 1).arousalGain;
    expect(pos).toBeCloseTo(neg, 6);
    expect(pos).toBeGreaterThan(1);
  });

  it("arousalGain monotone in |vibe|", () => {
    const a0 = computeMoodScale(stateOf("neutral", 0), 1).arousalGain;
    const a1 = computeMoodScale(stateOf("neutral", 1), 1).arousalGain;
    const a3 = computeMoodScale(stateOf("neutral", 3), 1).arousalGain;
    expect(a0).toBe(1);
    expect(a1).toBeGreaterThan(a0);
    expect(a3).toBeGreaterThan(a1);
  });
});

describe("computeMoodScale — moodInfluence ramp", () => {
  it("tempScale interpolates linearly between identity and base at vibe=0", () => {
    // intensity=0 at vibe=0, so tempScale = 1 + influence·(BASE-1).
    const half = computeMoodScale(stateOf("frustrated", 0), 0.5).tempScale;
    const full = computeMoodScale(stateOf("frustrated", 0), 1).tempScale;
    expect(half).toBeCloseTo(1 + 0.5 * (1.25 - 1), 6);
    expect(full).toBeCloseTo(1.25, 6);
  });
});

describe("signedCreditGain — Eldar-Niv mood-congruent credit assignment", () => {
  it("returns 1 exactly at moodInfluence=0 regardless of inputs", () => {
    expect(signedCreditGain(3, 1, 0)).toBe(1);
    expect(signedCreditGain(-3, -1, 0)).toBe(1);
    expect(signedCreditGain(0, 0, 0)).toBe(1);
  });

  it("returns 1 exactly at vibe=0 (no momentum to bias)", () => {
    for (const peSigned of [-1, -0.5, 0, 0.5, 1]) {
      expect(signedCreditGain(0, peSigned, 1)).toBe(1);
    }
  });

  it("returns 1 exactly at peSigned=0 (no surprise to over- or under-credit)", () => {
    for (const vibe of [-3, -1.5, 0, 1.5, 3]) {
      expect(signedCreditGain(vibe, 0, 1)).toBe(1);
    }
  });

  it("up-weights when mood and PE are sign-aligned (mood-congruent)", () => {
    // Positive vibe + positive PE (under-prediction of a happy bot)
    // → over-credit the optimistic update.
    const congruentPos = signedCreditGain(2.5, 0.5, 1);
    expect(congruentPos).toBeGreaterThan(1);
    // Negative vibe + negative PE (over-prediction of a frustrated
    // bot) → over-credit the pessimistic update.
    const congruentNeg = signedCreditGain(-2.5, -0.5, 1);
    expect(congruentNeg).toBeGreaterThan(1);
  });

  it("down-weights when mood and PE oppose (mood-incongruent)", () => {
    // Positive vibe + negative PE (over-prediction in a happy bot)
    // → under-credit the bad-news update (the literature's "happy
    // people protect the good mood").
    const incongruentPos = signedCreditGain(2.5, -0.5, 1);
    expect(incongruentPos).toBeLessThan(1);
    // Negative vibe + positive PE (under-prediction in a sad bot)
    // → under-credit the good-news update (Huys-style depressive
    // dampening of positive surprise).
    const incongruentNeg = signedCreditGain(-2.5, 0.5, 1);
    expect(incongruentNeg).toBeLessThan(1);
  });

  it("congruent and incongruent are symmetric around 1", () => {
    // |gain - 1| should be equal in magnitude for matched-magnitude
    // inputs of opposite signs (the function is sign-symmetric in
    // both vibe·peSigned).
    const a = signedCreditGain(2, 0.6, 1);
    const b = signedCreditGain(-2, -0.6, 1);
    const c = signedCreditGain(2, -0.6, 1);
    const d = signedCreditGain(-2, 0.6, 1);
    expect(a).toBeCloseTo(b, 9);     // both congruent
    expect(c).toBeCloseTo(d, 9);     // both incongruent
    expect(a - 1).toBeCloseTo(1 - c, 9); // mirror across 1
  });

  it("bound: gain ∈ [0.79, 1.21] at full influence with extreme inputs", () => {
    // tanh(1.5) ≈ 0.905, tanh(1) ≈ 0.762; product ≈ 0.689; with
    // K=0.3 and influence=1, max deviation from 1 is ~0.207.
    for (const v of [-3, -1.5, 0, 1.5, 3]) {
      for (const pe of [-1, -0.5, 0, 0.5, 1]) {
        const g = signedCreditGain(v, pe, 1);
        expect(g).toBeGreaterThanOrEqual(0.79);
        expect(g).toBeLessThanOrEqual(1.21);
      }
    }
  });

  it("clamps out-of-range peSigned defensively", () => {
    // Caller mistakes that overshoot ±1 must not produce
    // unbounded tanh inputs that saturate harder than [-1, 1] —
    // we clamp inside the helper.
    const at1 = signedCreditGain(2, 1, 1);
    const at5 = signedCreditGain(2, 5, 1);
    expect(at5).toBeCloseTo(at1, 9);
  });

  it("returns 1 for non-finite vibe or peSigned (defence in depth)", () => {
    expect(signedCreditGain(Number.NaN, 0.5, 1)).toBe(1);
    expect(signedCreditGain(0.5, Number.NaN, 1)).toBe(1);
    expect(signedCreditGain(Number.POSITIVE_INFINITY, 0.5, 1)).toBe(1);
    expect(signedCreditGain(0.5, Number.NEGATIVE_INFINITY, 1)).toBe(1);
  });

  it("scales linearly with moodInfluence at fixed vibe + peSigned", () => {
    const half = signedCreditGain(2, 0.5, 0.5) - 1;
    const full = signedCreditGain(2, 0.5, 1) - 1;
    expect(half).toBeCloseTo(full / 2, 6);
  });
});
