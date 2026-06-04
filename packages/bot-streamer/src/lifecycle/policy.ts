/**
 * Round-robin policy — picks the next lifecycle plan based on the
 * configured rotation and a small amount of history.
 *
 * Default rotation: solo → public_join → host_public → public_join → solo
 * Repeats. Public joins fall back to host_public when no lobby is found
 * — that fallback is signalled via `PublicJoinPlan.fallbackToHost: true`.
 *
 * The policy is intentionally a pure function over its inputs (rotation
 * config + history). It does not perform I/O. The runner calls it for
 * each new plan and tracks its own rotation cursor.
 */

import type { BotDifficulty, GameMode } from "@price-game/shared";
import { MULTIPLAYER_ONLY_MODES, VALID_GAME_MODES } from "@price-game/shared";
import type { LifecyclePlan } from "./types";

export type RotationStep = "solo" | "public_join" | "host_public" | "quickplay_bidding";

export const DEFAULT_ROTATION: RotationStep[] = [
  "solo",
  "quickplay_bidding",
  "solo",
  "quickplay_bidding",
  "solo",
];

/**
 * Probability over rotation kinds for the **stateful** picker.
 *
 * Phase 3d.2: defaults shifted to Quick Play bidding (the user
 * specified "never play in real multiplayer; just use single-play
 * version of bidding war with bots"). Real-MP join/host kinds
 * default to 0; operators can re-enable via `STREAMER_ROTATION` env
 * if they want.
 */
export const DEFAULT_KIND_WEIGHTS: Record<RotationStep, number> = {
  solo: 0.6,
  quickplay_bidding: 0.4,
  public_join: 0,
  host_public: 0,
};

/**
 * EWMA learning rate for per-mode success tracking. 0.3 means each
 * new outcome is ~30% of the next weight, the prior is 70%. Picked
 * to converge over ~15 samples (5 rounds × 3 plays of a mode).
 */
const SUCCESS_EWMA_ALPHA = 0.3;
/**
 * Floor on per-mode weight in the picker. A mode that has been
 * consistently failing still gets ~10% chance of being picked, so a
 * temporarily-broken enactor can recover (and we get observability
 * via `mode_success_rate_30m` in A6).
 */
const MODE_WEIGHT_FLOOR = 0.1;

export interface PlanPickerState {
  /** Last RotationStep selected. Used to gate the no-host-twice-in-a-row constraint. */
  lastKind: RotationStep | null;
  /**
   * Last mode picked for solo / host_public. Used to enforce no-
   * immediate-mode-repetition so the same game doesn't run two
   * rounds in a row when the whitelist is wide.
   */
  lastMode: GameMode | null;
  /**
   * Per-mode rolling success rate ∈ [0,1]. Folded via EWMA on each
   * `recordPlanOutcome()` call. Modes with low rates get downweighted
   * but never to zero (see `MODE_WEIGHT_FLOOR`).
   */
  modeSuccessEwma: Partial<Record<GameMode, number>>;
}

export const INITIAL_PLAN_PICKER_STATE: PlanPickerState = {
  lastKind: null,
  lastMode: null,
  modeSuccessEwma: {},
};

/**
 * Update the picker's per-mode success EWMA after a plan completes.
 * Returns a fresh state — never mutates the input. Pure so a runner
 * can replay history deterministically in tests.
 */
export function recordPlanOutcome(
  state: PlanPickerState,
  mode: GameMode | null,
  success: boolean,
): PlanPickerState {
  if (!mode) return state;
  const prev = state.modeSuccessEwma[mode] ?? 0.5;
  const next = SUCCESS_EWMA_ALPHA * (success ? 1 : 0) + (1 - SUCCESS_EWMA_ALPHA) * prev;
  return {
    ...state,
    modeSuccessEwma: { ...state.modeSuccessEwma, [mode]: next },
  };
}

function modeWeightFromEwma(ewma: number | undefined): number {
  // Default weight 0.5 (no signal yet). Then 0.5 + 0.5×success.
  // Floor at MODE_WEIGHT_FLOOR.
  const baseline = 0.5;
  const weight = ewma === undefined
    ? baseline
    : baseline + 0.5 * ewma;
  return Math.max(MODE_WEIGHT_FLOOR, weight);
}

function sampleByWeight<T>(items: { item: T; weight: number }[], rng: () => number): T {
  const total = items.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (total <= 0) return items[0].item;
  let r = rng() * total;
  for (const x of items) {
    r -= Math.max(0, x.weight);
    if (r <= 0) return x.item;
  }
  return items[items.length - 1].item;
}

export interface PolicyConfig {
  rotation?: RotationStep[];
  /**
   * Modes the bot is allowed to play in solo / host_public. Defaults to
   * every valid mode that isn't multiplayer-only. Caller can narrow this
   * (e.g. for an "easy modes only" stream).
   */
  modeWhitelist?: GameMode[];
  /** Default rounds-per-game in solo. Defaults to 5. */
  soloRounds?: number;
  /** Default rounds-per-game when hosting. Defaults to 5. */
  hostRounds?: number;
  /**
   * Seconds to wait for opponents before starting a hosted MP game.
   * Default lowered from 90s → 60s in A4 to reduce dead-air on
   * stream; the runner additionally subscribes to ROOM_PLAYER_JOINED
   * and shortens the remaining wait when an opponent shows up.
   */
  hostWaitSeconds?: number;
  /**
   * Probability weights for the stateful picker's kind selection.
   * Defaults to `DEFAULT_KIND_WEIGHTS` (60/40/0/0 — solo + quickplay
   * bidding). Set any key to 0 to disable that kind. Partial: any
   * unspecified key falls back to its DEFAULT_KIND_WEIGHTS value
   * so callers can override only the keys they care about.
   */
  kindWeights?: Partial<Record<RotationStep, number>>;
  /**
   * Phase 3d.2: rounds-per-game in `quickplay_bidding`. Defaults to
   * 5 to match Quick Play UX defaults.
   */
  quickplayBiddingRounds?: number;
  /**
   * Phase 3d.2: NPC difficulty for the auto-fill bots in
   * `quickplay_bidding`. Defaults to "medium".
   */
  biddingBotDifficulty?: BotDifficulty;
  /** Optional RNG injection for testable mode picking. Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Pick a mode at random from the whitelist (or every non-MP-only mode if
 * no whitelist is supplied). Bidding is always excluded from solo plans
 * because the server enforces it as multiplayer-only.
 */
function pickMode(allow: GameMode[], excludeBidding: boolean, rng: () => number): GameMode {
  const candidates = excludeBidding
    ? allow.filter((m) => !MULTIPLAYER_ONLY_MODES.has(m))
    : allow;
  if (candidates.length === 0) {
    throw new Error("policy.pickMode: candidate mode list is empty");
  }
  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * Default whitelist: all valid game modes. Lazily computed because
 * `VALID_GAME_MODES` is a Set we have to materialise into an array.
 */
function defaultModeWhitelist(): GameMode[] {
  return Array.from(VALID_GAME_MODES) as GameMode[];
}

/**
 * Build the next plan in the rotation given the current step index.
 *
 * @param stepIndex Current cursor position; the runner increments after
 *                  each plan completes.
 * @param config See {@link PolicyConfig}.
 * @returns The plan to execute next.
 */
export function planAt(stepIndex: number, config: PolicyConfig = {}): LifecyclePlan {
  const rotation = config.rotation ?? DEFAULT_ROTATION;
  if (rotation.length === 0) {
    throw new Error("policy.planAt: rotation is empty");
  }
  const step = rotation[((stepIndex % rotation.length) + rotation.length) % rotation.length];
  const allow = config.modeWhitelist ?? defaultModeWhitelist();
  const rng = config.rng ?? Math.random;
  const soloRounds = config.soloRounds ?? 5;
  const hostRounds = config.hostRounds ?? 5;
  // Default host wait dropped from 90s → 60s in A4. The runner's
  // opponent-aware shortening (executeHostPublic in playwrightDriver)
  // exits the wait early when joiners arrive, so the ceiling can be
  // lower without sacrificing matchmaking flexibility.
  const hostWaitSeconds = config.hostWaitSeconds ?? 60;

  const quickplayRounds = config.quickplayBiddingRounds ?? 5;
  const biddingDifficulty = config.biddingBotDifficulty ?? "medium";
  switch (step) {
    case "solo":
      return { kind: "solo", mode: pickMode(allow, true, rng), rounds: soloRounds };
    case "public_join":
      return { kind: "public_join", fallbackToHost: true };
    case "host_public":
      return {
        kind: "host_public",
        mode: pickMode(allow, false, rng),
        rounds: hostRounds,
        waitForOpponentsSeconds: hostWaitSeconds,
      };
    case "quickplay_bidding":
      return {
        kind: "quickplay_bidding",
        rounds: quickplayRounds,
        botDifficulty: biddingDifficulty,
      };
  }
}

/**
 * Helper: advance the cursor. Wraps modulo the rotation length so the
 * runner never has to think about overflow.
 */
export function advance(stepIndex: number, config: PolicyConfig = {}): number {
  const rotation = config.rotation ?? DEFAULT_ROTATION;
  return (stepIndex + 1) % rotation.length;
}

/**
 * Pick the next plan with the **stateful** policy: probabilistic
 * kind selection (with no-host-twice-in-a-row), EWMA-weighted mode
 * selection, and no-immediate-mode-repetition.
 *
 * Returns the new state alongside the plan so the runner can thread
 * it through the loop.
 *
 * @param state Picker state (use `INITIAL_PLAN_PICKER_STATE` on the
 *              first call).
 * @param config Config bag — `kindWeights`, `modeWhitelist`, RNG
 *               override etc.
 */
export function pickNextPlan(
  state: PlanPickerState,
  config: PolicyConfig = {},
): { plan: LifecyclePlan; nextState: PlanPickerState } {
  const rng = config.rng ?? Math.random;
  const allow = config.modeWhitelist ?? defaultModeWhitelist();
  // Merge partial kindWeights over the default so callers can override
  // only the keys they care about.
  const kindWeights: Record<RotationStep, number> = {
    ...DEFAULT_KIND_WEIGHTS,
    ...(config.kindWeights ?? {}),
  };
  const soloRounds = config.soloRounds ?? 5;
  const hostRounds = config.hostRounds ?? 5;
  const hostWaitSeconds = config.hostWaitSeconds ?? 60;
  const quickplayBiddingRounds = config.quickplayBiddingRounds ?? 5;
  const biddingBotDifficulty = config.biddingBotDifficulty ?? "medium";

  // Kind selection: zero out host_public if it just ran (avoid
  // back-to-back 60s lobby waits which kill stream pacing). If the
  // resulting weights are all zero, fall through to "solo"
  // explicitly — relying on `sampleByWeight`'s zero-total fallback
  // landing on `items[0]` would silently break if anyone reordered
  // the array.
  const kindEntries: { item: RotationStep; weight: number }[] = [
    { item: "solo", weight: kindWeights.solo },
    { item: "public_join", weight: kindWeights.public_join ?? 0 },
    {
      item: "host_public",
      weight: state.lastKind === "host_public" ? 0 : (kindWeights.host_public ?? 0),
    },
    {
      item: "quickplay_bidding",
      weight: kindWeights.quickplay_bidding ?? 0,
    },
  ];
  const totalKindWeight = kindEntries.reduce((s, x) => s + Math.max(0, x.weight), 0);
  const kind: RotationStep = totalKindWeight <= 0
    ? "solo"
    : sampleByWeight(kindEntries, rng);

  // Mode selection (only applicable for solo / host_public).
  // quickplay_bidding hardcodes "bidding" so it's not listed here.
  let mode: GameMode | null = null;
  if (kind === "solo" || kind === "host_public") {
    const candidates = allow.filter((m) =>
      kind === "solo" ? !MULTIPLAYER_ONLY_MODES.has(m) : true,
    );
    if (candidates.length === 0) {
      throw new Error(`pickNextPlan: no eligible modes for ${kind}`);
    }
    // Apply no-immediate-repetition only when there's another option.
    const filtered = candidates.length > 1
      ? candidates.filter((m) => m !== state.lastMode)
      : candidates;
    const weighted = filtered.map((m) => ({
      item: m,
      weight: modeWeightFromEwma(state.modeSuccessEwma[m]),
    }));
    mode = sampleByWeight(weighted, rng);
  }

  let plan: LifecyclePlan;
  switch (kind) {
    case "solo":
      plan = { kind: "solo", mode: mode!, rounds: soloRounds };
      break;
    case "public_join":
      plan = { kind: "public_join", fallbackToHost: true };
      break;
    case "host_public":
      plan = {
        kind: "host_public",
        mode: mode!,
        rounds: hostRounds,
        waitForOpponentsSeconds: hostWaitSeconds,
      };
      break;
    case "quickplay_bidding":
      plan = {
        kind: "quickplay_bidding",
        rounds: quickplayBiddingRounds,
        botDifficulty: biddingBotDifficulty,
      };
      break;
  }

  return {
    plan,
    nextState: {
      ...state,
      lastKind: kind,
      lastMode: mode ?? state.lastMode,
    },
  };
}

/**
 * Look ahead at the next `count` plans in the rotation without
 * advancing the cursor. Used by the runner to surface an "Up Next"
 * teaser on the broadcast overlay.
 *
 * Each call to `planAt` re-rolls the random mode for solo/host_public
 * steps; that means the lookahead is a *preview* of what _could_
 * happen, not a binding promise. The runner re-resolves on the actual
 * step boundary using the same RNG. Pass a deterministic RNG via
 * `config.rng` if you need stable preview-vs-actual matching for tests.
 */
export function peekNextPlans(
  stepIndex: number,
  count: number,
  config: PolicyConfig = {},
): LifecyclePlan[] {
  const out: LifecyclePlan[] = [];
  for (let i = 0; i < count; i++) {
    out.push(planAt(stepIndex + i + 1, config));
  }
  return out;
}
