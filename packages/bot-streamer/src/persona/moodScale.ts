/**
 * Mood-conditioned scaling factors for the streamer-bot's decision
 * pipeline. Reads the current MoodState (the 8-mood label resolved
 * from vibe + morale + streak) and the persona's `moodInfluence`
 * knob, and returns three multiplicative scaling factors:
 *
 *   - `tempScale`    — multiplies the candidate-sampler softmax
 *                      temperature in `effectiveTemperature()`.
 *                      Bound [0.6, 1.6].
 *   - `epsilonBump`  — additive corrective ε bump, non-zero only on
 *                      negative-valence moods (tilted, frustrated,
 *                      despondent). Bound [0, 0.05].
 *   - `arousalGain`  — per-sample importance-weight multiplier,
 *                      consumed by the FiLM training path in a
 *                      follow-up commit. Bound [1, 1.27].
 *
 * Symmetry note. `arousalGain` rides `tanh(|vibe|/2)`, so extreme
 * positive AND extreme negative both up-weight learning. This is
 * arousal-gated memory consolidation per Mather & Sutherland
 * (2011) "GANE" — NOT signed Eldar-Niv credit-assignment, which
 * would require the RPE sign at minibatch time and is deferred to
 * a later iteration.
 *
 * Inertness. At `moodInfluence = 0` the function returns identity
 * `{ tempScale: 1, epsilonBump: 0, arousalGain: 1 }` exactly, so
 * the persona knob is provably inert when zero. This is the
 * default; ramp via `STREAMER_MOOD_INFLUENCE` once shadow-mode
 * signal is positive.
 *
 * Per-mood base multipliers (anchored at vibe = 0; smoothed by
 * `tanh(|vibe|/2)` for `tempScale`):
 *
 *   neutral     T·1.00 / ε+0
 *   happy       T·0.95 / ε+0     (post-win mild exploration —
 *                                 a 0.95/1.00 A/B is a flagged
 *                                 post-merge target. 0.95 is the
 *                                 starting point; 1.00 is the
 *                                 strict mood-maintenance read
 *                                 per Isen & Patrick 1983.)
 *   confident   T·0.85 / ε+0     (high morale + mid vibe → trust
 *                                 the read; cf. Lebel & Dunsmoor
 *                                 2019 on calm-state narrowing.)
 *   elated      T·1.05 / ε+0     (hot streak + high morale →
 *                                 mild widening to protect gains;
 *                                 mood-maintenance, Rutledge 2014.)
 *   focused     T·0.70 / ε+0     (in the groove, |streak| ≥ 3.)
 *   tilted      T·1.15 / ε+0.02  (drifting negative.)
 *   frustrated  T·1.25 / ε+0.04  (corrective exploration.)
 *   despondent  T·1.30 / ε+0.05  (max corrective; capped to
 *                                 avoid total collapse.)
 */

import { type Mood } from "@price-game/shared";
import { type MoodState } from "./mood";

interface MoodBase {
  /** Multiplier on the candidate-sampler temperature at vibe = 0. */
  readonly temp: number;
  /** Additive ε bump applied unconditionally on this mood. */
  readonly eps: number;
}

/**
 * Per-mood base scaling factors. Multipliers act on the candidate-
 * sampler temperature; ε bump is additive on the existing
 * exploration-greedy probability.
 */
const MOOD_BASE: Readonly<Record<Mood, MoodBase>> = {
  neutral:    { temp: 1.00, eps: 0 },
  happy:      { temp: 0.95, eps: 0 },
  confident:  { temp: 0.85, eps: 0 },
  elated:     { temp: 1.05, eps: 0 },
  focused:    { temp: 0.70, eps: 0 },
  tilted:     { temp: 1.15, eps: 0.02 },
  frustrated: { temp: 1.25, eps: 0.04 },
  despondent: { temp: 1.30, eps: 0.05 },
};

/** Hard bounds on the temperature multiplier — keeps T_eff
 *  well-conditioned (sampler degenerate at T → 0; near-uniform
 *  at T → ∞) even if a future per-mood entry is mistuned. */
const TEMP_BOUNDS = { min: 0.6, max: 1.6 } as const;

/** Hard bound on the ε bump — keeps total exploration probability
 *  comfortably below 1 in any combination with the worker's
 *  adaptive ε (which itself sits below ~0.5). */
const EPS_BUMP_BOUNDS = { min: 0, max: 0.05 } as const;

/** Coefficient for the arousal-gain GANE-style weighting.
 *  `tanh(|v|/2)` for v ∈ [-3, 3] maxes at tanh(1.5) ≈ 0.905, so
 *  the multiplier is bounded to [1, 1 + 0.3·0.905] ≈ [1, 1.27]
 *  at full influence. Symmetric in vibe sign. */
const AROUSAL_GAIN_K = 0.3;

/**
 * Output of `computeMoodScale`. All three factors collapse to
 * identity at `moodInfluence = 0` so the persona knob is provably
 * inert when zero.
 */
export interface MoodScale {
  /** Multiplier on the candidate-sampler softmax temperature. */
  readonly tempScale: number;
  /** Additive corrective ε bump for negative-valence moods. */
  readonly epsilonBump: number;
  /** Per-sample importance-weight multiplier (FiLM-PR consumer). */
  readonly arousalGain: number;
}

function clampScalar(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Per-sample importance-weight multiplier — the GANE-style arousal
 * gain that `runMinibatchStep` applies to `isWeights[]`. Exposed
 * separately from {@link computeMoodScale} because the trainer
 * doesn't have the resolved mood label (only the raw `vibe` on the
 * Sample) — no need to spin up a fake `MoodState` just to read one
 * scalar.
 *
 *   gain = 1 + clamp(influence, 0, 1) · AROUSAL_GAIN_K · tanh(|vibe| / 2)
 *
 * Identity at influence=0 or vibe=0. Bound `[1, 1 + AROUSAL_GAIN_K · tanh(1.5)]`
 * ≈ [1, 1.27] at full influence with vibe ∈ [-3, 3]. Symmetric in
 * vibe sign — extreme positive AND extreme negative both up-weight
 * learning. Mather & Sutherland 2011 GANE / arousal-biased
 * competition; NOT signed Eldar-Niv credit assignment.
 *
 * Single source of truth — used by both `computeMoodScale` (which
 * surfaces it via `MoodScale.arousalGain`) and
 * `WorkerCore.runMinibatchStep` (which reads it directly per
 * sample). Drift-proof.
 *
 * @param vibe          Sample's recorded vibe ∈ [-3, 3]. Non-finite
 *                      values fall through to 0 (identity gain).
 * @param moodInfluence Persona knob ∈ [0, 1]; clamped silently.
 * @returns             Importance-weight multiplier ∈ [1, 1.27].
 */
export function arousalGainFor(vibe: number, moodInfluence: number): number {
  const inf = clampScalar(moodInfluence, 0, 1);
  if (inf === 0) return 1;
  const v = Number.isFinite(vibe) ? vibe : 0;
  return 1 + inf * AROUSAL_GAIN_K * Math.tanh(Math.abs(v) / 2);
}

/**
 * Coefficient for the signed mood-congruent credit gain (Eldar &
 * Niv 2015 mood-as-momentum, refined by Lefebvre et al. 2017
 * asymmetric learning rates). Sets the maximum magnitude of the
 * up-weight (mood-congruent) and down-weight (mood-incongruent)
 * around 1.
 *
 * gain = 1 + inf · K · tanh(|vibe|/2) · sign(vibe) · tanh(peSigned)
 *
 * Bound: at |vibe|=3, |peSigned|=1, the products max at
 * tanh(1.5)·tanh(1) ≈ 0.905 · 0.762 ≈ 0.689, so gain ranges
 * [1 − 0.3·0.689, 1 + 0.3·0.689] ≈ [0.79, 1.21] at full influence.
 * Combined with `arousalGainFor` ∈ [1, 1.27] the total per-sample
 * weight stays in [0.79, 1.54] — survivable, well-conditioned for
 * Adam.
 */
const SIGNED_CREDIT_K = 0.3;

/**
 * Per-sample, signed mood-congruent credit-assignment gain — the
 * Eldar-Niv mood-as-momentum lever the previous (GANE-style)
 * arousal gain could not express. Composed multiplicatively with
 * `arousalGainFor` in the training path so both literatures are
 * represented:
 *
 *   - `arousalGainFor` (Mather & Sutherland 2011 GANE) — high
 *     emotional activation strengthens memory consolidation,
 *     symmetric in vibe sign.
 *   - `signedCreditGain` (Eldar & Niv 2015) — positive mood
 *     over-credits positive RPEs ("good news got even better"),
 *     negative mood over-credits negative RPEs ("bad news
 *     reinforces the pessimistic prior"). The asymmetry produces
 *     autocorrelated streakiness even in a stationary environment
 *     — the "in the groove" / "on tilt" dynamic that the GANE-only
 *     version of PR #298 could not.
 *
 *   gain = 1 + inf · K · tanh(|vibe|/2) · sign(vibe) · tanh(peSigned)
 *
 * Mood-congruent (signs of vibe and peSigned match): gain > 1
 * (over-credit). Mood-incongruent: gain < 1 (under-credit).
 * Identity at `inf = 0`, `vibe = 0`, OR `peSigned = 0`. Symmetric
 * around 1 — the vibe magnitude controls how strong the asymmetry
 * is, the vibe sign × pe sign controls the direction.
 *
 * Why down-weight (gain < 1) is OK here. The literature is clear
 * that depressed-mood agents can productively ignore positive
 * news (mood-incongruent) — see Huys, Daw & Dayan 2015 on the
 * computational anatomy of depression. The bot version doesn't
 * lock in because (a) `arousalGainFor` always ≥ 1 floors the
 * total combined weight at ~0.79, (b) the negative-vibe ε bump
 * in `computeMoodScale` adds corrective exploration, and (c) the
 * `moodAdversarial.test.ts` lock-in vitest is the merge gate.
 *
 * @param vibe          Sample's recorded vibe ∈ [-3, 3]. Non-finite
 *                      values fall through to identity.
 * @param peSigned      Per-sample relative prediction error,
 *                      bounded ∈ [-1, 1]. Convention: positive PE
 *                      means the bot under-predicted (actual >
 *                      predicted) — interpreted as "good news" for
 *                      an optimistic bot since reality exceeded
 *                      expectation; negative means over-predicted
 *                      ("bad news" for an optimistic bot). The
 *                      sign convention here is load-bearing for
 *                      Eldar-Niv mood-congruent dynamics — flipping
 *                      it without flipping `vibe`'s sign meaning
 *                      would invert the streakiness story.
 *                      Non-finite values fall through to identity.
 * @param moodInfluence Persona knob ∈ [0, 1]; clamped silently.
 * @returns             Signed credit-gain multiplier ∈ [0.79, 1.21]
 *                      at full influence.
 */
export function signedCreditGain(
  vibe: number,
  peSigned: number,
  moodInfluence: number,
): number {
  const inf = clampScalar(moodInfluence, 0, 1);
  if (inf === 0) return 1;
  if (!Number.isFinite(vibe) || !Number.isFinite(peSigned)) return 1;
  const vibeMag = Math.tanh(Math.abs(vibe) / 2);
  const vibeSgn = Math.sign(vibe);
  // Clamp peSigned to [-1, 1] defensively — callers should pre-
  // normalise but a non-conforming caller would produce out-of-
  // range tanh inputs that still saturate, just less predictably.
  const peClamped = clampScalar(peSigned, -1, 1);
  const peTerm = Math.tanh(peClamped);
  return 1 + inf * SIGNED_CREDIT_K * vibeMag * vibeSgn * peTerm;
}

/**
 * Compute mood-driven scale factors for the decision pipeline.
 *
 * Identity at `moodInfluence = 0`: returns
 * `{ tempScale: 1, epsilonBump: 0, arousalGain: 1 }` exactly.
 *
 * @param state          Current bot mood state. The mood label is
 *                       used for the per-mood base; vibe magnitude
 *                       smooths the temperature scaling and drives
 *                       the symmetric arousal gain.
 * @param moodInfluence  Persona knob in [0, 1]. Out-of-range values
 *                       are clamped silently — the loader has
 *                       already validated, this is a defence in
 *                       depth.
 * @returns              Three multiplicative scaling factors.
 */
export function computeMoodScale(
  state: MoodState,
  moodInfluence: number,
): MoodScale {
  const influence = clampScalar(moodInfluence, 0, 1);
  // `state.mood` is constructed from the shared `Mood` union, but
  // narrow defensively to keep the function total even if a future
  // mood label slips past type-checking at a boundary.
  const base = MOOD_BASE[state.mood] ?? MOOD_BASE.neutral;
  const intensity = Math.tanh(Math.abs(state.vibe) / 2);
  const tempScale = clampScalar(
    1 + influence * (base.temp - 1) * (1 + 0.3 * intensity),
    TEMP_BOUNDS.min,
    TEMP_BOUNDS.max,
  );
  const epsilonBump = clampScalar(
    influence * base.eps,
    EPS_BUMP_BOUNDS.min,
    EPS_BUMP_BOUNDS.max,
  );
  // Single source of truth for the arousal-gain formula — the FiLM
  // training path also calls `arousalGainFor` directly, so a future
  // tweak to `AROUSAL_GAIN_K` or the `tanh(|vibe|/2)` shape lands
  // in exactly one place.
  const arousalGain = arousalGainFor(state.vibe, influence);
  return { tempScale, epsilonBump, arousalGain };
}
