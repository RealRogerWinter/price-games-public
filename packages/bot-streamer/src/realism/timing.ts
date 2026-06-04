/**
 * Timing distributions used by the bot's realism layer.
 *
 * - `readingDelayMs(textLength)` — log-normal centred on the content
 *   length, clamped to [1.2s, 6s]. Used before the bot's first action
 *   on a new round so the stream looks like the bot is reading the
 *   prompt rather than reacting instantly.
 * - `decisionDelayMs()` — short Gaussian gap between "I know the answer"
 *   and committing the input, with an 8% chance of a 1.5–2.5s
 *   "second-thought" outlier.
 * - `gaussian(mean, stddev, rng?)` — exposed because other modules
 *   (mouse, typing) compose their own delays from it.
 */

export interface RngOptions {
  /** Inject a deterministic RNG to make outputs testable. */
  rng?: () => number;
}

const DEFAULT_RNG = Math.random;
const READING_MIN_MS = 1200;
const READING_MAX_MS = 6000;

/**
 * Box-Muller transform — turn two uniform U[0,1) draws into a single
 * standard-normal sample, then scale.
 *
 * @param mean   Distribution mean.
 * @param stddev Distribution standard deviation.
 * @param rng    Optional seeded RNG; defaults to Math.random.
 */
export function gaussian(mean: number, stddev: number, rng: () => number = DEFAULT_RNG): number {
  // Avoid log(0) by clamping the lower edge of the uniform draw.
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}

/**
 * Sample a humanlike "time spent reading the prompt" delay.
 *
 * Mean grows mildly with prompt length (~1.8s for an empty prompt up to
 * ~4.5s for a paragraph-sized prompt), with a small stddev so the
 * variance feels natural without making the stream look erratic. The
 * result is clamped so the stream never stalls regardless of how
 * extreme the underlying draw is.
 *
 * @param textLength Approximate character count of the prompt the bot
 *                   needs to read. Pass 0 if you can't measure it.
 * @returns Delay in milliseconds, clamped to [1200, 6000].
 */
export function readingDelayMs(textLength: number, opts: RngOptions = {}): number {
  const rng = opts.rng ?? DEFAULT_RNG;
  // Mean reading time (seconds) scales linearly with character count up
  // to a soft ceiling around 4.5s. ~1.8s for trivial prompts, ~3.3s
  // around 200 chars, ~4.5s+ from 360 chars upward.
  const baseSeconds = 1.8 + Math.max(textLength, 0) * 0.0075;
  const meanSeconds = Math.min(baseSeconds, 4.5);
  const stddevSeconds = 0.55;
  const seconds = gaussian(meanSeconds, stddevSeconds, rng);
  const ms = Math.round(seconds * 1000);
  return Math.max(READING_MIN_MS, Math.min(READING_MAX_MS, ms));
}

/**
 * Sample the gap between deciding and committing an input. Mostly a
 * tight Gaussian; occasionally a longer "second-thought" pause.
 *
 * @returns Delay in milliseconds, always ≥ 50.
 */
export function decisionDelayMs(opts: RngOptions = {}): number {
  const rng = opts.rng ?? DEFAULT_RNG;
  // 8% chance of a longer pause; otherwise short Gaussian centred 500ms.
  if (rng() < 0.08) {
    const long = gaussian(2000, 400, rng);
    return Math.max(1500, Math.min(2500, Math.round(long)));
  }
  const short = gaussian(500, 180, rng);
  return Math.max(50, Math.min(1100, Math.round(short)));
}

/**
 * Sample the gap between consecutive sub-actions inside a single
 * round — tap-after-tap interactions for modes that involve more
 * than one click.
 *
 * The biggest pre-B6 sin: price-match would tap product → price →
 * product → price (8 clicks) with **zero** inter-tap pause. Read
 * as a robot. The new defaults give every mode a beat between
 * actions so the viewer can register what just happened before
 * the next click fires.
 *
 * @param mode Game mode the bot is playing.
 * @returns Delay in milliseconds. Clamped to [200, 2400] for most
 *          modes; `bidding-fill` floors at 800ms (sub-800ms bids
 *          would tip MP opponents that they're playing a bot).
 */
export function interActionDelayMs(
  mode:
    | "price-match"
    | "sort-it-out"
    | "sort-it-out-first"
    | "budget-builder"
    | "budget-builder-late"
    | "chain-reaction"
    | "chain-reaction-final"
    | "bidding-fill",
  opts: RngOptions = {},
): number {
  const rng = opts.rng ?? DEFAULT_RNG;
  // Mean / stddev tuned per the plan (see B6 in the plan file). Means
  // are chosen so a 5-iteration mode adds ~3s of cumulative pause —
  // enough to read as deliberate without bloating round time past
  // the result-modal-next adaptive timeout (capped at ~25s).
  let mean: number;
  let stddev: number;
  let floor = 200;
  let ceiling = 2400;
  switch (mode) {
    case "price-match":
      mean = 850;   // 4 inter-pair pauses → ~3.4s/round added
      stddev = 170;
      break;
    case "sort-it-out":
      mean = 600;
      stddev = 120;
      break;
    case "sort-it-out-first":
      // Comprehension beat — the first swap is the slowest so the
      // viewer can register the initial layout before it churns.
      mean = 1300;
      stddev = 200;
      break;
    case "budget-builder":
      mean = 550;
      stddev = 110;
      break;
    case "budget-builder-late":
      // The last 1–2 picks read as "reconsidering budget headroom".
      mean = 800;
      stddev = 160;
      break;
    case "chain-reaction":
      mean = 900;
      stddev = 180;
      break;
    case "chain-reaction-final":
      // Last link before the final reveal — stakes-rising beat.
      mean = 1300;
      stddev = 220;
      break;
    case "bidding-fill":
      // Hard floor so MP bidding never undercuts in <800ms (would
      // tip opponents that they're playing a bot).
      mean = 1500;
      stddev = 250;
      floor = 800;
      ceiling = 2400;
      break;
  }
  return Math.max(floor, Math.min(ceiling, Math.round(gaussian(mean, stddev, rng))));
}
