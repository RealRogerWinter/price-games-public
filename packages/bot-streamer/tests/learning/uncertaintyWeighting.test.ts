import { describe, expect, it } from "vitest";
import {
  FIXED_PHASE_ROUNDS,
  FIXED_TASK_WEIGHTS,
  LOG_SIGMA2_MAX,
  LOG_SIGMA2_MIN,
  MIN_TASK_OBSERVATIONS,
  TASK_INDEX,
  UncertaintyWeights,
} from "../../src/learning/uncertaintyWeighting";
import { NUM_ACTIVE_TASKS } from "../../src/learning/types";

function makeMask(active: ReadonlyArray<number>): Uint8Array {
  const m = new Uint8Array(NUM_ACTIVE_TASKS);
  for (const t of active) m[t] = 1;
  return m;
}

function makeLosses(values: Record<number, number>): Float32Array {
  const l = new Float32Array(NUM_ACTIVE_TASKS);
  for (const [t, v] of Object.entries(values)) l[Number(t)] = v;
  return l;
}

describe("UncertaintyWeights", () => {
  it("starts with zero logSigma2 (except pinballQ40 high-init) and zero observations", () => {
    const w = new UncertaintyWeights();
    expect(w.numTasks).toBe(NUM_ACTIVE_TASKS);
    for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
      // Phase 3d.2: pinballQ40's slot is seeded high (logSigma2 = 2.0)
      // so the head's first-touch K&G branch is heavily down-weighted
      // until tasksObserved clears MIN_TASK_OBSERVATIONS. Other slots
      // keep the original 0 default.
      if (t === TASK_INDEX.pinballQ40) {
        expect(w.logSigma2[t]).toBe(2.0);
      } else {
        expect(w.logSigma2[t]).toBe(0);
      }
      expect(w.tasksObserved[t]).toBe(0);
    }
    expect(w.roundsObserved).toBe(0);
  });

  it("rejects construction with wrong numTasks", () => {
    expect(() => new UncertaintyWeights(NUM_ACTIVE_TASKS + 1)).toThrow();
    expect(() => new UncertaintyWeights(0)).toThrow();
  });

  it("rejects mismatched losses/mask lengths in combine", () => {
    const w = new UncertaintyWeights();
    expect(() =>
      w.combine(new Float32Array(NUM_ACTIVE_TASKS - 1), new Uint8Array(NUM_ACTIVE_TASKS), {
        round: 0,
      }),
    ).toThrow();
    expect(() =>
      w.combine(new Float32Array(NUM_ACTIVE_TASKS), new Uint8Array(NUM_ACTIVE_TASKS + 1), {
        round: 0,
      }),
    ).toThrow();
  });

  describe("fixed phase", () => {
    it("uses FIXED_TASK_WEIGHTS when round < FIXED_PHASE_ROUNDS", () => {
      const w = new UncertaintyWeights();
      const losses = makeLosses({
        [TASK_INDEX.pairLogit]: 2.0,
        [TASK_INDEX.priceClass]: 5.0,
        [TASK_INDEX.logPrice]: 3.0,
      });
      const mask = makeMask([TASK_INDEX.pairLogit, TASK_INDEX.priceClass, TASK_INDEX.logPrice]);
      const res = w.combine(losses, mask, { round: 0 });
      const expectLoss =
        FIXED_TASK_WEIGHTS[TASK_INDEX.pairLogit] * 2.0 +
        FIXED_TASK_WEIGHTS[TASK_INDEX.priceClass] * 5.0 +
        FIXED_TASK_WEIGHTS[TASK_INDEX.logPrice] * 3.0;
      expect(res.loss).toBeCloseTo(expectLoss, 6);
      expect(res.gradPerTask[TASK_INDEX.pairLogit]).toBeCloseTo(
        FIXED_TASK_WEIGHTS[TASK_INDEX.pairLogit],
      );
      // K&G is frozen.
      for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
        expect(res.dLogSigma2[t]).toBe(0);
      }
    });

    it("inactive tasks contribute zero loss/grad", () => {
      const w = new UncertaintyWeights();
      const losses = makeLosses({
        [TASK_INDEX.pairLogit]: 2.0,
        [TASK_INDEX.pinballQ40]: 100.0, // should be ignored — inactive
      });
      const mask = makeMask([TASK_INDEX.pairLogit]);
      const res = w.combine(losses, mask, { round: 0 });
      expect(res.loss).toBeCloseTo(FIXED_TASK_WEIGHTS[TASK_INDEX.pairLogit] * 2.0, 6);
      expect(res.gradPerTask[TASK_INDEX.pinballQ40]).toBe(0);
    });
  });

  describe("K&G phase", () => {
    it("transitions to K&G when round ≥ FIXED_PHASE_ROUNDS AND task observed enough", () => {
      const w = new UncertaintyWeights();
      // Pretend pairLogit has been observed enough.
      w.tasksObserved[TASK_INDEX.pairLogit] = MIN_TASK_OBSERVATIONS;
      // logSigma2 = 0 ⇒ σ² = 1; gradPerTask = 1/(2·1) = 0.5
      const losses = makeLosses({ [TASK_INDEX.pairLogit]: 4.0 });
      const mask = makeMask([TASK_INDEX.pairLogit]);
      const res = w.combine(losses, mask, { round: FIXED_PHASE_ROUNDS });
      // L = L/(2·σ²) + 0.5·logσ² = 4 / 2 + 0 = 2
      expect(res.loss).toBeCloseTo(2.0, 6);
      expect(res.gradPerTask[TASK_INDEX.pairLogit]).toBeCloseTo(0.5, 6);
      // d/d(logSigma2) = 0.5 - L/(2·σ²) = 0.5 - 2 = -1.5
      expect(res.dLogSigma2[TASK_INDEX.pairLogit]).toBeCloseTo(-1.5, 6);
    });

    it("freezes σ² for tasks below MIN_TASK_OBSERVATIONS", () => {
      const w = new UncertaintyWeights();
      // Below the gate.
      w.tasksObserved[TASK_INDEX.squashedReg] = MIN_TASK_OBSERVATIONS - 1;
      const losses = makeLosses({ [TASK_INDEX.squashedReg]: 4.0 });
      const mask = makeMask([TASK_INDEX.squashedReg]);
      const res = w.combine(losses, mask, { round: FIXED_PHASE_ROUNDS + 1 });
      // Should fall back to fixed weights — loss = w · L
      const fixedW = FIXED_TASK_WEIGHTS[TASK_INDEX.squashedReg];
      expect(res.loss).toBeCloseTo(fixedW * 4.0, 6);
      expect(res.dLogSigma2[TASK_INDEX.squashedReg]).toBe(0);
    });

    it("matches numerical gradient on log σ²", () => {
      const w = new UncertaintyWeights();
      w.tasksObserved[TASK_INDEX.squashedReg] = MIN_TASK_OBSERVATIONS;
      // Pre-set logSigma2 to a non-trivial value.
      w.logSigma2[TASK_INDEX.squashedReg] = 0.7;
      const losses = makeLosses({ [TASK_INDEX.squashedReg]: 3.5 });
      const mask = makeMask([TASK_INDEX.squashedReg]);
      const opts = { round: FIXED_PHASE_ROUNDS + 100 };
      const { dLogSigma2 } = w.combine(losses, mask, opts);
      const eps = 1e-3;
      // Numerical: shift logSigma2 ± eps, recompute loss, finite-diff.
      const baseS = w.logSigma2[TASK_INDEX.squashedReg];
      w.logSigma2[TASK_INDEX.squashedReg] = baseS + eps;
      const fwdPlus = w.combine(losses, mask, opts).loss;
      w.logSigma2[TASK_INDEX.squashedReg] = baseS - eps;
      const fwdMinus = w.combine(losses, mask, opts).loss;
      w.logSigma2[TASK_INDEX.squashedReg] = baseS;
      const numerical = (fwdPlus - fwdMinus) / (2 * eps);
      expect(Math.abs(dLogSigma2[TASK_INDEX.squashedReg] - numerical)).toBeLessThan(1e-3);
    });
  });

  describe("non-finite defences", () => {
    it("combine skips slots with NaN/Inf losses", () => {
      const w = new UncertaintyWeights();
      w.tasksObserved[TASK_INDEX.pairLogit] = MIN_TASK_OBSERVATIONS;
      const losses = new Float32Array(NUM_ACTIVE_TASKS);
      losses[TASK_INDEX.pairLogit] = NaN;
      const mask = makeMask([TASK_INDEX.pairLogit]);
      const res = w.combine(losses, mask, { round: FIXED_PHASE_ROUNDS + 1 });
      expect(res.loss).toBe(0);
      expect(res.dLogSigma2[TASK_INDEX.pairLogit]).toBe(0);
    });

    it("applyGradient skips non-finite step values", () => {
      const w = new UncertaintyWeights();
      w.logSigma2[0] = 0.5;
      const grad = new Float32Array(NUM_ACTIVE_TASKS);
      grad[0] = NaN;
      w.applyGradient(grad);
      // logSigma2[0] should be unchanged (still 0.5).
      expect(w.logSigma2[0]).toBe(0.5);
    });
  });

  describe("applyGradient", () => {
    it("steps logSigma2 in the direction of the gradient", () => {
      const w = new UncertaintyWeights();
      const grad = new Float32Array(NUM_ACTIVE_TASKS);
      grad[TASK_INDEX.pairLogit] = 0.5; // positive grad ⇒ subtract ⇒ logSigma2 decreases
      w.applyGradient(grad);
      expect(w.logSigma2[TASK_INDEX.pairLogit]).toBeCloseTo(-0.5, 6);
    });

    it("clamps logSigma2 to [LOG_SIGMA2_MIN, LOG_SIGMA2_MAX]", () => {
      const w = new UncertaintyWeights();
      const grad = new Float32Array(NUM_ACTIVE_TASKS);
      grad[0] = -1000; // huge negative grad ⇒ logSigma2 grows past max
      w.applyGradient(grad);
      expect(w.logSigma2[0]).toBe(LOG_SIGMA2_MAX);

      grad.fill(0);
      grad[1] = 1000;
      w.applyGradient(grad);
      expect(w.logSigma2[1]).toBe(LOG_SIGMA2_MIN);
    });

    it("rejects mismatched gradient length", () => {
      const w = new UncertaintyWeights();
      expect(() => w.applyGradient(new Float32Array(NUM_ACTIVE_TASKS - 1))).toThrow();
    });
  });

  describe("noteRoundObserved", () => {
    it("increments per-task counts only for active tasks", () => {
      const w = new UncertaintyWeights();
      const mask = makeMask([TASK_INDEX.pairLogit, TASK_INDEX.priceClass]);
      w.noteRoundObserved(mask);
      expect(w.roundsObserved).toBe(1);
      expect(w.tasksObserved[TASK_INDEX.pairLogit]).toBe(1);
      expect(w.tasksObserved[TASK_INDEX.priceClass]).toBe(1);
      expect(w.tasksObserved[TASK_INDEX.pinballQ40]).toBe(0);
    });
  });

  describe("serialize / deserialize round-trip", () => {
    it("preserves logSigma2, tasksObserved, and roundsObserved", () => {
      const w = new UncertaintyWeights();
      w.logSigma2[TASK_INDEX.pairLogit] = 1.5;
      w.logSigma2[TASK_INDEX.pinballQ40] = -0.3;
      w.tasksObserved[TASK_INDEX.pairLogit] = 42;
      w.tasksObserved[TASK_INDEX.pinballQ40] = 7;
      w.roundsObserved = 1234;
      const buf = w.serialize();
      const back = UncertaintyWeights.deserialize(buf);
      for (let t = 0; t < NUM_ACTIVE_TASKS; t++) {
        expect(back.logSigma2[t]).toBeCloseTo(w.logSigma2[t], 6);
        expect(back.tasksObserved[t]).toBe(w.tasksObserved[t]);
      }
      expect(back.roundsObserved).toBe(1234);
    });

    it("returns fresh instance on empty / malformed buffer", () => {
      expect(UncertaintyWeights.deserialize(Buffer.alloc(0)).roundsObserved).toBe(0);
      expect(UncertaintyWeights.deserialize(Buffer.from([1, 2, 3])).roundsObserved).toBe(0);
    });

    it("clamps out-of-range logSigma2 on load", () => {
      const w = new UncertaintyWeights();
      // Stuff an invalid value past the clamp.
      w.logSigma2[0] = 999;
      const buf = w.serialize();
      // The serializer doesn't clamp — but deserialize does, since
      // the on-disk value should never be applied verbatim.
      const back = UncertaintyWeights.deserialize(buf);
      expect(back.logSigma2[0]).toBe(LOG_SIGMA2_MAX);
    });
  });
});
