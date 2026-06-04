/**
 * Mood engine v2 — two-layer state machine combining a fast-moving
 * "vibe" (recent rounds) with a slow-moving "morale" (recent games)
 * to pick from the 8-mood vocabulary in `@price-game/shared`.
 *
 * The audit's primary engine complaints with v1 were:
 *   - Mood was too jumpy: a single win could flip "frustrated" →
 *     "neutral" because vibe decayed 20% per round.
 *   - There was no long-term memory: every container restart erased
 *     mood and the bot started "neutral" forever, even after a
 *     thousand-game losing streak.
 *   - The label vocabulary (4 moods) was so coarse the indicator
 *     panel struggled to communicate emotional arc.
 *
 * v2 addresses (1) and (3) here. Long-term persistence (2) is the
 * scope of the next follow-up PR — `MoodState` includes morale and
 * the runner already feeds `game_outcome` events at finalize time,
 * so persisting + hydrating the snapshot is a separate-concerns
 * change that can land cleanly on top.
 *
 * Behavioural shape:
 *
 *   vibe   ∈ [-3, 3]   slow-decay (0.92 per round) sum of round-
 *                      outcome contributions. Drives the immediate
 *                      mood category.
 *   morale ∈ [-1, 1]   EMA over per-GAME results (α = 0.18). Drifts
 *                      slowly — survives one bad game, captures a
 *                      multi-hour run.
 *   streak  signed     same as v1: ±N for N consecutive same-direction
 *                      round outcomes. Reset to ±1 on flip.
 *
 * `resolveMood(vibe, morale, streak)` is the pure label picker — its
 * decision table is documented inline. `nextMood(prev, input)` folds
 * a single event into the next state, dispatching on the input's
 * `kind` discriminator (round_outcome | game_outcome).
 */

import { DEFAULT_MOOD, type Mood } from "@price-game/shared";
export { type Mood, DEFAULT_MOOD };

export interface MoodState {
  /** Current displayed mood label. */
  mood: Mood;
  /** Hidden vibe score in [-3, 3] — short-term, decays per round. */
  vibe: number;
  /**
   * Hidden morale score in [-1, 1] — long-term, EMA over game
   * outcomes. Drifts ~3-5x slower than vibe; one bad game won't tip
   * it but a session of bad games will.
   */
  morale: number;
  /** Signed round streak. ±N for N consecutive same-direction outcomes. */
  streak: number;
}

export const INITIAL_MOOD: MoodState = {
  mood: DEFAULT_MOOD,
  vibe: 0,
  morale: 0,
  streak: 0,
};

/**
 * Inputs the engine accepts. Discriminated union so the engine can
 * fold both per-round and per-game signals through a single `nextMood`
 * entry point — keeps the call shape uniform and lets future inputs
 * (chat sentiment, music swap, lobby empty, etc.) bolt on as new
 * `kind` arms without changing existing call sites.
 *
 * `round_outcome.outcome` keeps v1's labels — `soft_win` and
 * `soft_loss` are still wired in (v1 only ever fed soft_loss for
 * partial guesses; the runner can feed soft_win when a future close-
 * win signal lands).
 */
export type MoodInput =
  | { readonly kind: "round_outcome"; readonly outcome: "win" | "loss" | "soft_win" | "soft_loss" }
  | { readonly kind: "game_outcome"; readonly win: boolean };

// -- Tunable constants. Pulled out so a future PR can reach them via
// ----- env / debug HUD overrides without rewriting the engine.

/** Vibe decays toward 0 each round at this rate. v1 used 0.80 — too
 * jumpy; v2 holds vibe longer so a single result can't flip mood. */
const VIBE_DECAY = 0.92;

type RoundOutcome = "win" | "loss" | "soft_win" | "soft_loss";

/**
 * Vibe contribution magnitudes per round outcome.
 *
 * `soft_win` is currently dead config: the only caller (`attemptRound`
 * in playwrightDriver) maps `view.outcome === "correct"` to `"win"`
 * unconditionally because `RoundOutcomeView` doesn't yet expose the
 * score-vs-bestScore ratio needed to distinguish a clean win from a
 * narrow one. Kept here so a future PR that surfaces that signal can
 * wire it through without re-extending the union.
 */
const VIBE_DELTA: Record<RoundOutcome, number> = {
  win: 1,
  soft_win: 0.5,
  loss: -1,
  soft_loss: -0.4, // partial guesses sting less than a hard zero
};

/** EMA mixing weight on game-outcome morale updates. α=0.18 → ~5-game half-life. */
const MORALE_ALPHA = 0.18;

/** Bounds for clamping vibe and morale after every update. */
const VIBE_BOUNDS = { min: -3, max: 3 } as const;
const MORALE_BOUNDS = { min: -1, max: 1 } as const;

/** Vibe thresholds for the resolver — see `resolveMood` doc table. */
const VIBE_HIGH = 1.5;
const VIBE_LOW = -1.5;

/** Morale thresholds — wider than vibe because morale moves slower. */
const MORALE_HIGH = 0.4;
const MORALE_LOW = -0.4;

/** Streak length the resolver treats as "in a groove". */
const STREAK_FOCUSED = 3;

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(bounds.max, value));
}

/**
 * Pure mood label picker. Documented decision table:
 *
 *   ┌─ vibe high (≥1.5) ─┐
 *   │  morale high       │ → elated     (riding hot + long-term up)
 *   │  morale neutral    │ → happy      (recent wins, no big arc)
 *   │  morale low        │ → happy      (recent rebound from a slump —
 *   │                    │               the wins ARE the bot's read of
 *   │                    │               the moment; mood follows the
 *   │                    │               immediate signal, not the arc.
 *   │                    │               Keeps a comeback-feel intact.)
 *   ├─ vibe neutral ─────┤
 *   │  streak  ≥3        │ → focused    (in a groove going up — checked
 *   │                    │               BEFORE morale so a "confident"
 *   │                    │               long-term arc doesn't mask the
 *   │                    │               more interesting "in the zone"
 *   │                    │               read; also prevents "confident"
 *   │                    │               while in a LOSING streak)
 *   │  streak ≤-3        │ → focused    (in a groove going down)
 *   │  morale high       │ → confident  (steady wins over time, no
 *   │                    │               immediate streak)
 *   │  morale low        │ → tilted     (long-term down, present neutral)
 *   │  else              │ → neutral
 *   ├─ vibe low (≤-1.5) ─┤
 *   │  morale low        │ → despondent (recent losses + long-term down)
 *   │  morale neutral    │ → frustrated
 *   │  morale high       │ → neutral    (long-term arc cancels the dip
 *   │                    │               into a wash; routing here to
 *   │                    │               `tilted` would flicker against
 *   │                    │               the mid-band tilted entry on
 *   │                    │               adjacent rounds when vibe
 *   │                    │               crosses ±1.5)
 *   └────────────────────┘
 *
 * Pure function, exported so the resolver can be tested exhaustively
 * over the (vibe × morale × streak) grid without standing up the
 * full state machine.
 *
 * @param vibe   Hidden vibe score in [-3, 3].
 * @param morale Hidden morale EMA in [-1, 1].
 * @param streak Signed round streak.
 * @returns Resolved mood label.
 */
export function resolveMood(vibe: number, morale: number, streak: number): Mood {
  const vibeHigh = vibe >= VIBE_HIGH;
  const vibeLow = vibe <= VIBE_LOW;
  const moraleHigh = morale >= MORALE_HIGH;
  const moraleLow = morale <= MORALE_LOW;
  const inGroove = Math.abs(streak) >= STREAK_FOCUSED;

  if (vibeHigh) {
    if (moraleHigh) return "elated";
    return "happy";
  }
  if (vibeLow) {
    if (moraleLow) return "despondent";
    // morale-high here used to return "tilted" — but `tilted` is also
    // the mid-band+morale-low label, which produced flicker between
    // the two branches as vibe oscillated near ±1.5 with morale high.
    // Routing this corner to neutral removes the flicker; the
    // long-term positive arc legitimately cancels the present dip.
    if (moraleHigh) return DEFAULT_MOOD;
    return "frustrated";
  }
  // Vibe in the middle band. Streak-driven `focused` outranks the
  // morale-driven `confident` so a strong streak (positive or
  // negative) is never silently relabelled — and so a long losing
  // streak with high morale doesn't read as "confident".
  if (inGroove) return "focused";
  if (moraleHigh) return "confident";
  if (moraleLow) return "tilted";
  return DEFAULT_MOOD;
}

/**
 * Reduce a single event into the next MoodState. Pure function so the
 * engine can be tested deterministically by chaining calls.
 *
 * @param prev   Previous state (use INITIAL_MOOD on first call).
 * @param input  The event to fold in. Discriminated by `kind`.
 * @returns Next mood state with the resolved label.
 */
export function nextMood(prev: MoodState, input: MoodInput): MoodState {
  if (input.kind === "round_outcome") {
    const sign = VIBE_DELTA[input.outcome];
    const vibe = clamp(prev.vibe * VIBE_DECAY + sign, VIBE_BOUNDS);
    const isWin = input.outcome === "win" || input.outcome === "soft_win";
    const streak = (() => {
      if (isWin && prev.streak >= 0) return prev.streak + 1;
      if (!isWin && prev.streak <= 0) return prev.streak - 1;
      return isWin ? 1 : -1;
    })();
    const mood = resolveMood(vibe, prev.morale, streak);
    return { mood, vibe, morale: prev.morale, streak };
  }
  // game_outcome: morale-only update. Vibe + streak are per-round
  // signals and shouldn't move on the once-per-game finalize.
  const target = input.win ? 1 : -1;
  const morale = clamp(
    prev.morale * (1 - MORALE_ALPHA) + target * MORALE_ALPHA,
    MORALE_BOUNDS,
  );
  const mood = resolveMood(prev.vibe, morale, prev.streak);
  return { mood, vibe: prev.vibe, morale, streak: prev.streak };
}

/**
 * Format a mood transition for `[mood] kind=… vibe=…→… morale=…→…`
 * log lines. The runner emits one after every `nextMood` call so an
 * operator tailing the container's stdout can see the engine working.
 *
 * Pure for testability — no side effects, no console.log inside.
 *
 * Stable field order so log greppers and dashboards can rely on it.
 *
 * @param prev   State before the transition.
 * @param next   State after the transition.
 * @param input  The event that produced the transition.
 * @returns Single-line log string with stable field order.
 */
export function formatMoodTransition(
  prev: MoodState,
  next: MoodState,
  input: MoodInput,
): string {
  const fmt = (n: number): string => n.toFixed(2);
  const tag = input.kind === "round_outcome"
    ? `outcome=${input.outcome}`
    : `game=${input.win ? "win" : "loss"}`;
  return (
    `[mood] ${tag}`
    + ` vibe=${fmt(prev.vibe)}→${fmt(next.vibe)}`
    + ` morale=${fmt(prev.morale)}→${fmt(next.morale)}`
    + ` streak=${prev.streak}→${next.streak}`
    + ` mood=${prev.mood}→${next.mood}`
  );
}
