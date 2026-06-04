/**
 * AR(1) momentum scalar for per-round bot streakiness.
 *
 * Real players have hot streaks and cold streaks; their performance round to
 * round is autocorrelated, not independent. Without this, a tuned bot's
 * accuracy is suspiciously uniform — the same player always finishing 2nd by
 * the same margin reads "algorithmic." With AR(1) momentum, a bot that nailed
 * round 3 is somewhat more likely to nail round 4, then drift back to mean.
 *
 * Update rule: `m_{t+1} = 0.6·m_t + 0.4·N(1.0, 0.15)`, clamped to
 * `[MOMENTUM_MIN, MOMENTUM_MAX]`. The 0.6 inertia + bounded Gaussian noise
 * give visible streaks (lag-1 autocorrelation ≈ 0.5) without runaway drift.
 *
 * Callers multiply this scalar into the personality's sigma each round.
 * Output > 1 means "wider misses this round" (cold streak); < 1 means
 * "tighter / hot streak."
 */

/** Lower clamp for the momentum scalar — prevents oracle-tight rounds. */
export const MOMENTUM_MIN = 0.7;
/** Upper clamp — prevents an unrecoverable bad streak that breaks immersion. */
export const MOMENTUM_MAX = 1.3;

const INERTIA = 0.6;
const NOISE_STD = 0.15;

/** Box-Muller standard Gaussian. */
function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(x: number): number {
  return Math.max(MOMENTUM_MIN, Math.min(MOMENTUM_MAX, x));
}

/**
 * Advance the momentum scalar by one round.
 *
 * Output is `0.6·prev + 0.4·N(1.0, 0.15)`, clamped to the [0.7, 1.3] band.
 * Cold-start (`prev === undefined`) is treated as `prev = 1.0`.
 *
 * @param prev - Previous round's momentum (omit on the first round).
 * @returns Next round's momentum scalar.
 */
export function nextMomentum(prev: number | undefined): number {
  const base = typeof prev === "number" ? prev : 1.0;
  const sample = INERTIA * base + (1 - INERTIA) * (1.0 + gauss() * NOISE_STD);
  return clamp(sample);
}
