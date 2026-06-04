import { describe, it, expect } from "vitest";
import type { GameMode } from "@price-game/shared";
import {
  advance,
  planAt,
  peekNextPlans,
  pickNextPlan,
  recordPlanOutcome,
  INITIAL_PLAN_PICKER_STATE,
  DEFAULT_ROTATION,
  type PlanPickerState,
  type RotationStep,
} from "../src/lifecycle/policy";
import { seeded } from "./_rng";

describe("policy.planAt", () => {
  it("walks the default rotation in order", () => {
    const cfg = { rng: seeded(1) };
    // Phase 3d.2 default rotation: solo, quickplay_bidding, solo,
    // quickplay_bidding, solo. Real-MP kinds are out of the rotation
    // by default; operators set STREAMER_ROTATION to bring them back.
    expect(planAt(0, cfg).kind).toBe("solo");
    expect(planAt(1, cfg).kind).toBe("quickplay_bidding");
    expect(planAt(2, cfg).kind).toBe("solo");
    expect(planAt(3, cfg).kind).toBe("quickplay_bidding");
    expect(planAt(4, cfg).kind).toBe("solo");
  });

  it("wraps modulo the rotation length", () => {
    const cfg = { rng: seeded(1) };
    const a = planAt(0, cfg).kind;
    const b = planAt(DEFAULT_ROTATION.length, cfg).kind;
    expect(a).toBe(b);
  });

  it("never picks bidding for solo plans", () => {
    const whitelist: GameMode[] = ["bidding", "classic"];
    for (let i = 0; i < 50; i++) {
      // Step 0 is solo in DEFAULT_ROTATION.
      const plan = planAt(0, { rng: seeded(i + 1), modeWhitelist: whitelist });
      if (plan.kind === "solo") {
        expect(plan.mode).not.toBe("bidding");
      }
    }
  });

  it("public_join always asks for fallbackToHost=true", () => {
    // Custom rotation forces public_join at step 0 since the default
    // rotation no longer includes it.
    const plan = planAt(0, { rotation: ["public_join"], rng: seeded(1) });
    expect(plan.kind).toBe("public_join");
    if (plan.kind === "public_join") {
      expect(plan.fallbackToHost).toBe(true);
    }
  });

  it("host_public carries the configured wait and rounds", () => {
    const plan = planAt(0, { rotation: ["host_public"], rng: seeded(1), hostRounds: 7, hostWaitSeconds: 30 });
    expect(plan.kind).toBe("host_public");
    if (plan.kind === "host_public") {
      expect(plan.rounds).toBe(7);
      expect(plan.waitForOpponentsSeconds).toBe(30);
    }
  });

  it("quickplay_bidding carries the configured rounds + difficulty", () => {
    const plan = planAt(1, { rng: seeded(1), quickplayBiddingRounds: 5, biddingBotDifficulty: "hard" });
    expect(plan.kind).toBe("quickplay_bidding");
    if (plan.kind === "quickplay_bidding") {
      expect(plan.rounds).toBe(5);
      expect(plan.botDifficulty).toBe("hard");
    }
  });

  it("respects a custom rotation", () => {
    const cfg = { rotation: ["solo", "solo"] as RotationStep[], rng: seeded(1) };
    expect(planAt(0, cfg).kind).toBe("solo");
    expect(planAt(1, cfg).kind).toBe("solo");
    expect(planAt(2, cfg).kind).toBe("solo");
  });

  it("throws when the whitelist excludes every solo-eligible mode", () => {
    expect(() =>
      planAt(0, { rng: seeded(1), modeWhitelist: ["bidding"] }),
    ).toThrow();
  });

  it("throws on an empty rotation", () => {
    expect(() => planAt(0, { rotation: [], rng: seeded(1) })).toThrow();
  });
});

describe("policy.advance", () => {
  it("increments and wraps modulo the rotation length", () => {
    expect(advance(0)).toBe(1);
    expect(advance(DEFAULT_ROTATION.length - 1)).toBe(0);
  });
});

describe("policy.pickNextPlan (stateful)", () => {
  it("never picks host_public twice in a row", () => {
    let state: PlanPickerState = INITIAL_PLAN_PICKER_STATE;
    // Force host_public weight to be highest so naive sampling would
    // keep picking it.
    const cfg = {
      kindWeights: { solo: 0.1, public_join: 0.1, host_public: 1 },
      rng: seeded(7),
    };
    let lastKind: RotationStep | null = null;
    for (let i = 0; i < 20; i++) {
      const result = pickNextPlan(state, cfg);
      if (lastKind === "host_public") {
        expect(result.plan.kind).not.toBe("host_public");
      }
      lastKind = result.plan.kind;
      state = result.nextState;
    }
  });

  it("avoids immediate mode repetition when the whitelist is wide", () => {
    let state: PlanPickerState = INITIAL_PLAN_PICKER_STATE;
    const cfg = {
      kindWeights: { solo: 1, public_join: 0, host_public: 0 },
      rng: seeded(11),
    };
    const modes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const result = pickNextPlan(state, cfg);
      if (result.plan.kind === "solo") modes.push(result.plan.mode);
      state = result.nextState;
    }
    // No two consecutive modes are identical.
    for (let i = 1; i < modes.length; i++) {
      expect(modes[i]).not.toBe(modes[i - 1]);
    }
  });

  it("EWMA downweights consistently-failing modes (but never to zero)", () => {
    let state: PlanPickerState = INITIAL_PLAN_PICKER_STATE;
    // Mark 'classic' as a chronic failure across many plays.
    for (let i = 0; i < 30; i++) {
      state = recordPlanOutcome(state, "classic", false);
    }
    // The EWMA should have converged near 0.
    expect(state.modeSuccessEwma["classic"]).toBeLessThan(0.05);
    // Mark 'higher-lower' as a chronic success.
    for (let i = 0; i < 30; i++) {
      state = recordPlanOutcome(state, "higher-lower", true);
    }
    expect(state.modeSuccessEwma["higher-lower"]).toBeGreaterThan(0.95);
  });

  it("recordPlanOutcome is a no-op when mode is null", () => {
    const state = recordPlanOutcome(INITIAL_PLAN_PICKER_STATE, null, true);
    expect(state.modeSuccessEwma).toEqual({});
  });

  it("returns a public_join with fallbackToHost=true", () => {
    const cfg = {
      kindWeights: { solo: 0, public_join: 1, host_public: 0 },
      rng: seeded(1),
    };
    const result = pickNextPlan(INITIAL_PLAN_PICKER_STATE, cfg);
    expect(result.plan.kind).toBe("public_join");
    if (result.plan.kind === "public_join") {
      expect(result.plan.fallbackToHost).toBe(true);
    }
  });

  it("respects the modeWhitelist when picking modes", () => {
    const whitelist: GameMode[] = ["classic", "higher-lower"];
    const cfg = {
      modeWhitelist: whitelist,
      kindWeights: { solo: 1, public_join: 0, host_public: 0 },
      rng: seeded(3),
    };
    let state: PlanPickerState = INITIAL_PLAN_PICKER_STATE;
    for (let i = 0; i < 8; i++) {
      const result = pickNextPlan(state, cfg);
      if (result.plan.kind === "solo") {
        expect(whitelist).toContain(result.plan.mode);
      }
      state = result.nextState;
    }
  });
});

describe("policy.peekNextPlans", () => {
  it("returns the next N plans without advancing the cursor", () => {
    const cfg = { rng: seeded(1) };
    const upcoming = peekNextPlans(0, 3, cfg);
    expect(upcoming).toHaveLength(3);
    // Phase 3d.2 default rotation: step 0 is solo. Steps 1-3 are
    // quickplay_bidding, solo, quickplay_bidding.
    expect(upcoming[0].kind).toBe("quickplay_bidding");
    expect(upcoming[1].kind).toBe("solo");
    expect(upcoming[2].kind).toBe("quickplay_bidding");
  });

  it("wraps modulo the rotation length", () => {
    const cfg = { rotation: ["solo", "host_public"] as RotationStep[], rng: seeded(1) };
    const upcoming = peekNextPlans(0, 4, cfg);
    expect(upcoming.map((p) => p.kind)).toEqual([
      "host_public",
      "solo",
      "host_public",
      "solo",
    ]);
  });

  it("returns an empty array when count is 0", () => {
    expect(peekNextPlans(0, 0, { rng: seeded(1) })).toHaveLength(0);
  });
});
