/**
 * Lifecycle runner — drives the rotation by repeatedly:
 *   1. Asking the policy for the next plan.
 *   2. Delegating execution to a `Driver` (real Playwright / HTTP code in
 *      production; a stub in tests).
 *   3. Recording the outcome and applying exponential backoff on errors.
 *
 * The runner does NOT touch sockets, HTTP, or browsers directly — that
 * keeps it unit-testable and keeps the integration surface confined to
 * the driver. The driver's contract is in {@link Driver}.
 */

import {
  advance,
  planAt,
  peekNextPlans,
  pickNextPlan,
  recordPlanOutcome,
  INITIAL_PLAN_PICKER_STATE,
  type PolicyConfig,
  type PlanPickerState,
} from "./policy";
import type { GameMode } from "@price-game/shared";
import type { LifecyclePlan, PlanOutcome } from "./types";

export interface Driver {
  /**
   * Execute the plan and return when the bot is ready for the next one.
   * Drivers are responsible for handling per-plan timeouts internally;
   * the runner just records the elapsed wall-clock time.
   *
   * @throws Errors propagate to the runner's backoff loop.
   */
  execute(plan: LifecyclePlan, signal: AbortSignal): Promise<PlanOutcome>;
}

export interface RunnerOptions {
  policy?: PolicyConfig;
  /** Inject a clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Inject a delay function. Default observes the abort signal so
   * shutdown latency is bounded by the loop's next iteration, not by
   * the current backoff tail.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Initial backoff after first error, in ms. Defaults to 2_000. */
  baseBackoffMs?: number;
  /** Backoff ceiling. Defaults to 60_000. */
  maxBackoffMs?: number;
  /**
   * Number of consecutive failures on the same plan before the runner
   * skips to the next step in the rotation. Default 5 — matches the
   * exponential cap so a stuck plan can't wedge the bot indefinitely.
   * Set to Infinity to disable.
   */
  maxConsecutiveErrors?: number;
  /** Optional listener invoked after every plan completes. */
  onPlanComplete?: (outcome: PlanOutcome) => void;
  /**
   * Optional listener invoked _before_ each plan executes, with the
   * plan itself and a lookahead of the next N plans. Used by the
   * runner for telemetry; the lookahead is a *preview* — the runner
   * re-resolves random mode picks at the actual step boundary, so
   * the preview can differ from what eventually runs.
   */
  onPlanStart?: (plan: LifecyclePlan, upcoming: LifecyclePlan[]) => void;
  /**
   * Number of plans to look ahead when calling `onPlanStart`.
   * Defaults to 3.
   */
  lookaheadCount?: number;
  /**
   * Pick the next plan via the **stateful** picker (probabilistic
   * kind weights, EWMA mode tracking, no-immediate-repetition).
   * Defaults to `true`.
   *
   * Set to `false` to keep the legacy fixed-rotation behaviour —
   * useful for tests of the cursor-based flow and operators who
   * want deterministic ordering.
   */
  useStatefulPicker?: boolean;
}

const DEFAULT_BASE_BACKOFF = 2_000;
const DEFAULT_MAX_BACKOFF = 60_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Sleep that resolves early if the abort signal fires. This bounds
 * shutdown latency to roughly one loop tick rather than waiting out the
 * entire backoff tail.
 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run the lifecycle loop until `signal` aborts.
 *
 * Returns when the abort signal fires (so the runner is await-able from a
 * supervisor). Throws only if the policy itself can't produce a plan
 * (which indicates programmer error, not a runtime fault).
 *
 * @param driver Driver that executes individual plans.
 * @param signal Abort signal that ends the loop.
 * @param opts See {@link RunnerOptions}.
 * @returns Resolves once the abort signal fires.
 */
export async function runLifecycle(
  driver: Driver,
  signal: AbortSignal,
  opts: RunnerOptions = {},
): Promise<void> {
  const policy = opts.policy ?? {};
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;

  let cursor = 0;
  let consecutiveErrors = 0;
  const lookaheadCount = opts.lookaheadCount ?? 3;
  const useStatefulPicker = opts.useStatefulPicker ?? true;
  let pickerState: PlanPickerState = INITIAL_PLAN_PICKER_STATE;

  while (!signal.aborted) {
    let plan: LifecyclePlan;
    let nextPickerState: PlanPickerState | null = null;
    if (useStatefulPicker) {
      const result = pickNextPlan(pickerState, policy);
      plan = result.plan;
      nextPickerState = result.nextState;
    } else {
      plan = planAt(cursor, policy);
    }
    if (opts.onPlanStart) {
      try {
        // Lookahead: in stateful mode we synthesize 3 future picks
        // from a *copy* of the next state (doesn't mutate). In
        // cursor mode we use the existing peekNextPlans helper.
        const upcoming = useStatefulPicker
          ? peekStateful(nextPickerState!, lookaheadCount, policy)
          : peekNextPlans(cursor, lookaheadCount, policy);
        opts.onPlanStart(plan, upcoming);
      } catch {
        // Telemetry-style callback; never let it derail the loop.
      }
    }
    const start = now();
    let outcome: PlanOutcome;

    try {
      outcome = await driver.execute(plan, signal);
      consecutiveErrors = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { plan, status: "error", error: message };
      consecutiveErrors++;
    }

    outcome.durationMs = now() - start;
    opts.onPlanComplete?.(outcome);

    if (signal.aborted) return;

    if (outcome.status === "error") {
      const wait = Math.min(maxBackoff, baseBackoff * 2 ** Math.min(consecutiveErrors - 1, 5));
      await sleep(wait, signal);
      // After N consecutive failures on the same plan, skip ahead so a
      // single broken step (e.g. a flaky public-lobby endpoint) can't
      // wedge the bot. Reset the counter as we move on.
      if (consecutiveErrors >= maxConsecutiveErrors) {
        cursor = advance(cursor, policy);
        consecutiveErrors = 0;
      }
      continue;
    }

    if (useStatefulPicker && nextPickerState) {
      // Fold the outcome into the picker's per-mode EWMA so future
      // picks downweight modes that keep failing.
      const planMode: GameMode | null = "mode" in plan ? plan.mode : null;
      pickerState = recordPlanOutcome(
        nextPickerState,
        planMode,
        outcome.status === "completed",
      );
    } else {
      cursor = advance(cursor, policy);
    }
  }
}

/**
 * Stateful-picker lookahead: simulate the next `count` picks from a
 * given state with the same RNG, returning just the plans (the
 * intermediate states are dropped). Pure preview — does not mutate
 * the caller's state.
 */
function peekStateful(
  state: PlanPickerState,
  count: number,
  policy: PolicyConfig,
): LifecyclePlan[] {
  const out: LifecyclePlan[] = [];
  let cursor = state;
  for (let i = 0; i < count; i++) {
    const r = pickNextPlan(cursor, policy);
    out.push(r.plan);
    // For preview we assume "would have been completed" so the
    // EWMA doesn't drift the lookahead toward a failure scenario.
    const mode = "mode" in r.plan ? r.plan.mode : null;
    cursor = recordPlanOutcome(r.nextState, mode, true);
  }
  return out;
}
