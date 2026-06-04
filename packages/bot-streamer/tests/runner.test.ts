import { describe, it, expect } from "vitest";
import { runLifecycle, type Driver } from "../src/lifecycle/runner";
import type { LifecyclePlan, PlanOutcome } from "../src/lifecycle/types";

function recordingDriver(steps: Array<PlanOutcome["status"] | "throw">): Driver & {
  log: LifecyclePlan[];
  errors: number;
} {
  const log: LifecyclePlan[] = [];
  let i = 0;
  let errors = 0;
  const driver: Driver & { log: LifecyclePlan[]; errors: number } = {
    log,
    get errors() {
      return errors;
    },
    set errors(_v: number) {
      // satisfy TS getter/setter parity; don't reassign internally.
    },
    async execute(plan, _signal) {
      log.push(plan);
      const step = steps[i++] ?? "completed";
      if (step === "throw") {
        errors++;
        throw new Error("boom");
      }
      return { plan, status: step };
    },
  };
  return driver;
}

describe("runLifecycle", () => {
  it("walks the rotation when every plan succeeds, then aborts", async () => {
    const driver = recordingDriver(Array(7).fill("completed"));
    const ac = new AbortController();
    const outcomes: PlanOutcome[] = [];
    const sleeps: number[] = [];
    const promise = runLifecycle(driver, ac.signal, {
      now: () => 0,
      // Cursor-based rotation; this test asserts the legacy fixed-rotation
      // ordering. The default-on stateful picker is exercised separately.
      useStatefulPicker: false,
      sleep: async (ms, _signal) => {
        sleeps.push(ms);
      },
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 7) ac.abort();
      },
    });
    await promise;
    // Phase 3d.2 default rotation: solo, quickplay_bidding, solo,
    // quickplay_bidding, solo (length 5; wraps for entries 5+6).
    expect(driver.log.map((p) => p.kind)).toEqual([
      "solo",
      "quickplay_bidding",
      "solo",
      "quickplay_bidding",
      "solo",
      "solo",
      "quickplay_bidding",
    ]);
    expect(sleeps).toHaveLength(0);
  });

  it("backs off exponentially on errors and does not advance the cursor", async () => {
    const driver = recordingDriver(["throw", "throw", "throw", "completed"]);
    const ac = new AbortController();
    const sleeps: number[] = [];
    const outcomes: PlanOutcome[] = [];
    await runLifecycle(driver, ac.signal, {
      // Cursor-based mode: same plan stays selected until success or skip.
      useStatefulPicker: false,
      sleep: async (ms, _signal) => {
        sleeps.push(ms);
      },
      baseBackoffMs: 100,
      maxBackoffMs: 10_000,
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 4) ac.abort();
      },
    });
    // First 3 attempts threw; cursor stayed at "solo" each time.
    expect(driver.log.slice(0, 3).every((p) => p.kind === "solo")).toBe(true);
    // 4th attempt succeeded; cursor stayed on solo for the success.
    expect(driver.log[3].kind).toBe("solo");
    // Backoff: 100, 200, 400 (exponential x 2).
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const driver = recordingDriver(["throw", "throw", "throw", "throw", "throw", "throw", "throw"]);
    const ac = new AbortController();
    const sleeps: number[] = [];
    let count = 0;
    await runLifecycle(driver, ac.signal, {
      sleep: async (ms, _signal) => {
        sleeps.push(ms);
      },
      baseBackoffMs: 100,
      maxBackoffMs: 500,
      // Disable the skip-after-N escape so this test exercises the
      // cap behaviour in isolation (otherwise the cursor would advance
      // after 5 errors and the backoff counter would reset).
      maxConsecutiveErrors: Infinity,
      onPlanComplete: () => {
        count++;
        if (count === 7) ac.abort();
      },
    });
    // The 7th outcome triggers abort inside onPlanComplete, so the runner
    // returns before the 7th sleep fires. We see backoffs for the first
    // 6 errors only: 100, 200, 400 (exponential), then capped at 500 thrice.
    expect(sleeps).toEqual([100, 200, 400, 500, 500, 500]);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const driver = recordingDriver([]);
    const ac = new AbortController();
    ac.abort();
    await runLifecycle(driver, ac.signal);
    expect(driver.log).toHaveLength(0);
  });

  it("skips to the next step after maxConsecutiveErrors failures on the same plan", async () => {
    // 5 errors on solo, then we should advance to the next step.
    const driver = recordingDriver(["throw", "throw", "throw", "throw", "throw", "completed"]);
    const ac = new AbortController();
    const outcomes: PlanOutcome[] = [];
    await runLifecycle(driver, ac.signal, {
      useStatefulPicker: false,
      sleep: async () => {},
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      maxConsecutiveErrors: 5,
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 6) ac.abort();
      },
    });
    // Plans 1..5 all 'solo' (errors); plan 6 is the next step in the
    // rotation ('quickplay_bidding' from DEFAULT_ROTATION post-3d.2)
    // — driver returned 'completed' there.
    const kinds = driver.log.map((p) => p.kind);
    expect(kinds.slice(0, 5)).toEqual(["solo", "solo", "solo", "solo", "solo"]);
    expect(kinds[5]).toBe("quickplay_bidding");
  });

  it("reports durationMs in the outcome", async () => {
    const driver = recordingDriver(["completed"]);
    const ac = new AbortController();
    let t = 1000;
    const outcomes: PlanOutcome[] = [];
    await runLifecycle(driver, ac.signal, {
      now: () => {
        const v = t;
        t += 250;
        return v;
      },
      onPlanComplete: (o) => {
        outcomes.push(o);
        ac.abort();
      },
    });
    expect(outcomes[0].durationMs).toBe(250);
  });

  it("fires onPlanStart with the current plan and a 3-deep lookahead", async () => {
    const driver = recordingDriver(["completed", "completed"]);
    const ac = new AbortController();
    const starts: { plan: LifecyclePlan; upcoming: LifecyclePlan[] }[] = [];
    const outcomes: PlanOutcome[] = [];
    await runLifecycle(driver, ac.signal, {
      // Cursor-based: deterministic "solo, public_join" sequence.
      useStatefulPicker: false,
      sleep: async () => {},
      onPlanStart: (plan, upcoming) => {
        starts.push({ plan, upcoming });
      },
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 2) ac.abort();
      },
    });
    expect(starts).toHaveLength(2);
    expect(starts[0].plan.kind).toBe("solo");
    // Default lookahead = 3.
    expect(starts[0].upcoming).toHaveLength(3);
    // Second call sees the next slot (1 = quickplay_bidding in
    // Phase 3d.2's DEFAULT_ROTATION).
    expect(starts[1].plan.kind).toBe("quickplay_bidding");
  });

  it("respects a custom lookaheadCount", async () => {
    const driver = recordingDriver(["completed"]);
    const ac = new AbortController();
    const starts: { upcoming: LifecyclePlan[] }[] = [];
    await runLifecycle(driver, ac.signal, {
      sleep: async () => {},
      lookaheadCount: 1,
      onPlanStart: (_plan, upcoming) => {
        starts.push({ upcoming });
      },
      onPlanComplete: () => ac.abort(),
    });
    expect(starts[0].upcoming).toHaveLength(1);
  });

  it("uses the stateful picker by default — no host_public twice in a row", async () => {
    const driver = recordingDriver(Array(20).fill("completed"));
    const ac = new AbortController();
    const outcomes: PlanOutcome[] = [];
    // Force host_public weight high so the picker WOULD repeat it
    // every step if the no-repeat constraint weren't enforced. Phase
    // 3d.2: kindWeights merges over DEFAULT_KIND_WEIGHTS, so we
    // explicitly zero `quickplay_bidding` here too — otherwise the
    // post-3d.2 default (0.4) would let the picker bypass the
    // host_public constraint entirely.
    await runLifecycle(driver, ac.signal, {
      sleep: async () => {},
      policy: {
        rng: () => 0.99, // pushes every weighted sample to the last item
        kindWeights: { solo: 0, public_join: 0, host_public: 1, quickplay_bidding: 0 },
      },
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 6) ac.abort();
      },
    });
    // First pick: host_public (no constraint yet).
    // Subsequent picks: host_public weight is 0 so picker falls back
    // to solo (since public_join also weights 0). The sequence
    // alternates rather than spamming host_public.
    const kinds = driver.log.map((p) => p.kind);
    expect(kinds[0]).toBe("host_public");
    // No two consecutive host_public.
    for (let i = 1; i < kinds.length; i++) {
      if (kinds[i] === "host_public") {
        expect(kinds[i - 1]).not.toBe("host_public");
      }
    }
  });

  it("stateful picker downweights modes that consistently fail (EWMA)", async () => {
    // We can't easily observe the EWMA from runLifecycle's external
    // contract without a hook. The test asserts the loop survives
    // many failures without crashing — EWMA correctness is unit-
    // tested in policy.test.ts.
    const driver = recordingDriver(Array(10).fill("error"));
    const ac = new AbortController();
    const outcomes: PlanOutcome[] = [];
    await runLifecycle(driver, ac.signal, {
      sleep: async () => {},
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      onPlanComplete: (o) => {
        outcomes.push(o);
        if (outcomes.length === 6) ac.abort();
      },
    });
    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((o) => o.status === "error")).toBe(true);
  });

  it("does not derail the loop if onPlanStart throws", async () => {
    const driver = recordingDriver(["completed"]);
    const ac = new AbortController();
    let completed = false;
    await runLifecycle(driver, ac.signal, {
      sleep: async () => {},
      onPlanStart: () => {
        throw new Error("telemetry boom");
      },
      onPlanComplete: () => {
        completed = true;
        ac.abort();
      },
    });
    expect(completed).toBe(true);
  });
});
