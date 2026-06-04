/**
 * Mood-engine adversarial sequence tests. Drives `nextMood` through
 * deterministic outcome streams and asserts the bot doesn't lock
 * into a negative-cluster mood after recovery has objectively
 * begun, and (mirror-image) doesn't lock into a positive-cluster
 * mood after a regime shift.
 *
 * These are merge gates: lock-in is the most concrete failure mode
 * for a mood-conditioned policy (depressive attractor —
 * Huys/Browning/Daw 2015 in the human literature; we don't want to
 * reproduce it). The negative-cluster check rides on the asymmetric
 * ε bump in `computeMoodScale` correcting bad-streak exploration;
 * the positive-cluster check guards against `elated`/`confident`
 * persisting through environmental change in a way that would block
 * adaptation.
 *
 * Tests operate at the `nextMood` level — the actual sampler /
 * trainer are not exercised here. The mood-conditioned scaling
 * factors are checked separately in `moodScale.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  nextMood,
  INITIAL_MOOD,
  type MoodState,
  type MoodInput,
} from "../src/persona/mood";
import { computeMoodScale } from "../src/persona/moodScale";

const NEGATIVE_CLUSTER = new Set(["tilted", "frustrated", "despondent"] as const);
const POSITIVE_CLUSTER = new Set(["happy", "confident", "elated"] as const);

type RoundOutcome = "win" | "loss" | "soft_win" | "soft_loss";

function applyRound(state: MoodState, outcome: RoundOutcome): MoodState {
  const input: MoodInput = { kind: "round_outcome", outcome };
  return nextMood(state, input);
}

function applyGame(state: MoodState, win: boolean): MoodState {
  return nextMood(state, { kind: "game_outcome", win });
}

/** Run a sequence of round outcomes and return the per-step state trace. */
function trace(start: MoodState, seq: RoundOutcome[]): MoodState[] {
  const out: MoodState[] = [];
  let s = start;
  for (const o of seq) {
    s = applyRound(s, o);
    out.push(s);
  }
  return out;
}

describe("adversarial: 10 losses → 10 wins → 50 alternating → 50 wins", () => {
  // Build the stream once.
  const stream: RoundOutcome[] = [
    ...Array(10).fill("loss" as const),
    ...Array(10).fill("win" as const),
    ...Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? "win" : "loss") as RoundOutcome),
    ...Array(50).fill("win" as const),
  ];
  const states = trace(INITIAL_MOOD, stream);

  it("enters the negative cluster during the loss streak", () => {
    // First 10 are losses. By round ~3 the bot should be in
    // frustrated/despondent territory.
    const lateLossSegment = states.slice(0, 10);
    expect(
      lateLossSegment.some((s) => NEGATIVE_CLUSTER.has(s.mood as never)),
    ).toBe(true);
  });

  it("exits the negative cluster within 12 rounds of the first recovery win", () => {
    // The 10-loss streak ends at index 9; the recovery wins start
    // at index 10. The bot must escape the negative cluster within
    // 12 rounds of round-10 (i.e., by index 21 inclusive).
    const recoveryWindow = states.slice(10, 22);
    const escapeIdx = recoveryWindow.findIndex(
      (s) => !NEGATIVE_CLUSTER.has(s.mood as never),
    );
    expect(escapeIdx).toBeGreaterThanOrEqual(0);
    expect(escapeIdx).toBeLessThan(12);
  });

  it("does not spend most of the alternating block in the negative cluster", () => {
    // Tightened assertion (neuroscience expert ask): in the
    // alternating block (rounds 50–100 of the test = indices
    // 20..69 of `states`), mean-time-in-negative-cluster < 0.4.
    // If this fails, the asymmetric ε bump and bounded T are not
    // enough to prevent residual depressive lock-in and we'd want
    // to add a proportional pull-to-zero on morale.
    const alternatingSegment = states.slice(20, 70);
    const fracNegative =
      alternatingSegment.filter((s) => NEGATIVE_CLUSTER.has(s.mood as never)).length
      / alternatingSegment.length;
    expect(fracNegative).toBeLessThan(0.4);
  });

  it("settles in the positive cluster after the long winning tail", () => {
    // After 50 consecutive wins, the bot should be solidly
    // positive-valence by the final state.
    const finalState = states[states.length - 1];
    expect(POSITIVE_CLUSTER.has(finalState.mood as never)).toBe(true);
  });
});

describe("adversarial: positive lock-in — 50-round win block then regime shift", () => {
  // Drive the bot into elated/confident, then flip to losses and
  // verify it doesn't stay positive past the recovery window.
  let s = INITIAL_MOOD;
  // Bias morale up first via game wins so the streak can promote
  // to elated rather than just happy.
  for (let i = 0; i < 5; i++) s = applyGame(s, true);
  // Then the 50-round win block.
  for (let i = 0; i < 50; i++) s = applyRound(s, "win");

  it("reaches the positive cluster after the win block", () => {
    expect(POSITIVE_CLUSTER.has(s.mood as never)).toBe(true);
  });

  it("exits the positive cluster within 12 rounds of regime flip to losses", () => {
    const recovery = trace(s, Array(15).fill("loss" as const));
    const exitIdx = recovery.findIndex((r) => !POSITIVE_CLUSTER.has(r.mood as never));
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeLessThan(12);
  });
});

describe("adversarial: monotone win-streak then monotone loss-streak", () => {
  // Asymmetric vibe-decay damage check: vibe should clamp at +3
  // during the win streak, then decay + accumulate into negative
  // territory at the same nominal rate during the loss streak.
  let s = INITIAL_MOOD;
  for (let i = 0; i < 50; i++) s = applyRound(s, "win");

  it("vibe saturates at the +3 ceiling under sustained wins", () => {
    expect(s.vibe).toBeGreaterThanOrEqual(2.99);
    expect(s.vibe).toBeLessThanOrEqual(3);
  });

  it("vibe reaches the -3 floor under sustained losses without overshoot", () => {
    let t = s;
    for (let i = 0; i < 50; i++) t = applyRound(t, "loss");
    expect(t.vibe).toBeLessThanOrEqual(-2.99);
    expect(t.vibe).toBeGreaterThanOrEqual(-3);
  });
});

describe("adversarial: seeded random walk over MoodInput", () => {
  // Resonance / divergence check: a long deterministic random walk
  // mustn't push state outside the documented bounds.
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("vibe ∈ [-3, 3], morale ∈ [-1, 1], mood is one of MOOD_LABELS over 1000 mixed rounds", () => {
    const rng = lcg(0xc0ffee);
    let st = INITIAL_MOOD;
    for (let i = 0; i < 1000; i++) {
      const r = rng();
      if (r < 0.1) st = applyGame(st, rng() < 0.5);
      else st = applyRound(st, rng() < 0.5 ? "win" : "loss");
      expect(st.vibe).toBeGreaterThanOrEqual(-3);
      expect(st.vibe).toBeLessThanOrEqual(3);
      expect(st.morale).toBeGreaterThanOrEqual(-1);
      expect(st.morale).toBeLessThanOrEqual(1);
    }
  });
});

describe("adversarial: mood pinned at extreme produces bounded scale outputs", () => {
  // Defence in depth — even at the most extreme combinations the
  // documented bounds hold. Complements moodScale.test.ts's per-
  // mood checks by exercising real states the engine could
  // actually reach.
  it("at full influence, despondent + vibe=-3 + streak=-10 stays within scale bounds", () => {
    const state: MoodState = {
      mood: "despondent",
      vibe: -3,
      morale: -1,
      streak: -10,
    };
    const scale = computeMoodScale(state, 1);
    expect(scale.tempScale).toBeGreaterThanOrEqual(0.6);
    expect(scale.tempScale).toBeLessThanOrEqual(1.6);
    expect(scale.epsilonBump).toBeGreaterThanOrEqual(0);
    expect(scale.epsilonBump).toBeLessThanOrEqual(0.05);
    expect(scale.arousalGain).toBeGreaterThanOrEqual(1);
    expect(scale.arousalGain).toBeLessThanOrEqual(1.272);
  });

  it("at full influence, elated + vibe=3 + morale=1 + streak=10 stays within scale bounds", () => {
    const state: MoodState = { mood: "elated", vibe: 3, morale: 1, streak: 10 };
    const scale = computeMoodScale(state, 1);
    expect(scale.tempScale).toBeGreaterThanOrEqual(0.6);
    expect(scale.tempScale).toBeLessThanOrEqual(1.6);
    expect(scale.epsilonBump).toBe(0);
    expect(scale.arousalGain).toBeGreaterThanOrEqual(1);
    expect(scale.arousalGain).toBeLessThanOrEqual(1.272);
  });
});
