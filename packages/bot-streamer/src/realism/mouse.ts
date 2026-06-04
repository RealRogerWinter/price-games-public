/**
 * Mouse-path generator: turns a logical "click this point" into a
 * sequence of (x, y, t) waypoints that look humanlike when fed into a
 * Playwright `mouse.move()` loop.
 *
 * Path shape: cubic Bezier between the start and end points, with two
 * control points perturbed by a Gaussian. ~15% of clicks include an
 * overshoot + correction at the end so the cursor doesn't always land
 * dead-centre on the first attempt.
 *
 * Output is a plain array — the Playwright driver wraps these in actual
 * `mouse.move(x, y)` + `await delay(t)` calls. Tests can inspect the
 * waypoints directly.
 */
import { gaussian, type RngOptions } from "./timing";

export interface Point {
  x: number;
  y: number;
}

export interface MouseWaypoint extends Point {
  /** Cumulative milliseconds since the start of the move. */
  t: number;
}

export interface MousePathOptions extends RngOptions {
  /** Total move duration before any overshoot, in milliseconds. */
  durationMs?: number;
  /** Number of intermediate samples along the path (excluding start). */
  steps?: number;
  /** Probability of generating an overshoot+correction at the end. */
  overshootProbability?: number;
  /** Force the overshoot path on/off; mainly a test affordance. */
  forceOvershoot?: boolean;
  /**
   * Target's smallest dimension in pixels. When provided, the duration
   * is computed via a Fitts-Law-ish formula instead of uniform random:
   * `clamp(180 + 180·log2(distance/width + 1) + N(0, 60), 240, 1100)`.
   * Larger / closer targets snap quickly; smaller / farther ones get
   * a longer, more deliberate path.
   */
  targetWidth?: number;
}

const DEFAULT_RNG = Math.random;
const FITTS_BASE_MS = 180;
const FITTS_INDEX_MS = 180;
const FITTS_NOISE_STDDEV = 60;
const MIN_DURATION = 240;
const MAX_DURATION = 1_100;
const FRAME_TICK_MS = 33; // 1000 / 30fps stream output
const MIN_STEPS = 6;
const DEFAULT_OVERSHOOT_PROB = 0.15;
const CONTROL_POINT_VARIANCE = 40; // was 80 — reduced to keep arcs in the "natural arm motion" envelope.

/** Distance helper exposed for tests. */
function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function bezierPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Build a humanlike mouse-move path from `from` to `to`. Returns the
 * full waypoint sequence including the destination.
 *
 * @param from Starting cursor coordinates.
 * @param to   Target coordinates (centre of the element to click).
 * @param opts See {@link MousePathOptions}.
 * @returns Array of timestamped waypoints. Always non-empty; last entry
 *          is the corrected landing point (or `to` if no overshoot).
 */
export function planMousePath(
  from: Point,
  to: Point,
  opts: MousePathOptions = {},
): MouseWaypoint[] {
  const rng = opts.rng ?? DEFAULT_RNG;
  const overshootProb = opts.overshootProbability ?? DEFAULT_OVERSHOOT_PROB;
  const overshoot = opts.forceOvershoot ?? rng() < overshootProb;

  // Pick a duration. When `targetWidth` is provided, use Fitts-Law-ish
  // scaling so longer / smaller-target moves get more time. Otherwise
  // fall back to uniform random in the legacy range — preserves
  // existing test fixtures.
  let duration: number;
  if (opts.durationMs !== undefined) {
    duration = opts.durationMs;
  } else if (opts.targetWidth !== undefined && opts.targetWidth > 0) {
    const dist = distance(from, to);
    const indexOfDifficulty = Math.log2(dist / opts.targetWidth + 1);
    const noisy = FITTS_BASE_MS + FITTS_INDEX_MS * indexOfDifficulty + gaussian(0, FITTS_NOISE_STDDEV, rng);
    duration = noisy;
  } else {
    duration = Math.round(MIN_DURATION + rng() * (MAX_DURATION - MIN_DURATION));
  }
  duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, duration));

  // Steps default to one waypoint per encoded stream frame (~33ms each)
  // — every move position lands on a unique frame and nothing is wasted
  // on sub-frame detail. Caller can override via opts.steps.
  const steps = Math.max(MIN_STEPS, opts.steps ?? Math.round(duration / FRAME_TICK_MS));

  // Control points: 1/3 and 2/3 along the line, perturbed by N(0, 40px).
  // Reduced from 80px so short moves don't loop dramatically — keeps
  // the arc inside the "natural arm motion" envelope.
  const cpVariance = CONTROL_POINT_VARIANCE;
  const c1: Point = {
    x: from.x + (to.x - from.x) / 3 + gaussian(0, cpVariance, rng),
    y: from.y + (to.y - from.y) / 3 + gaussian(0, cpVariance, rng),
  };
  const c2: Point = {
    x: from.x + (2 * (to.x - from.x)) / 3 + gaussian(0, cpVariance, rng),
    y: from.y + (2 * (to.y - from.y)) / 3 + gaussian(0, cpVariance, rng),
  };

  // Optional landing offset for the overshoot variant — pulled outside
  // the loop so the same offset is reused for every step that targets
  // the overshoot end-point (which the curve must reach before the
  // correction).
  const overshootEnd: Point = overshoot
    ? {
        x: to.x + gaussian(0, 6, rng) + Math.sign(to.x - from.x || 1) * (5 + rng() * 13),
        y: to.y + gaussian(0, 6, rng) + Math.sign(to.y - from.y || 1) * (5 + rng() * 13),
      }
    : to;

  // Each step samples the Bezier at an eased parameter so the cursor
  // accelerates out of `from` and decelerates into the destination — the
  // signature of a non-robot move. The same eased parameter feeds the
  // timestamp so spatial and temporal pacing stay in sync.
  const waypoints: MouseWaypoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = easeInOutQuad(t);
    const p = bezierPoint(eased, from, c1, c2, overshootEnd);
    waypoints.push({ x: p.x, y: p.y, t: Math.round(eased * duration) });
  }

  if (overshoot) {
    // Add 4 short waypoints correcting back to `to` over ~120ms.
    const correctionSteps = 4;
    const correctionDuration = 120;
    const corrStart = waypoints[waypoints.length - 1];
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      waypoints.push({
        x: corrStart.x + (to.x - corrStart.x) * t,
        y: corrStart.y + (to.y - corrStart.y) * t,
        t: duration + Math.round(t * correctionDuration),
      });
    }
  }

  return waypoints;
}

/**
 * Apply a small Gaussian offset to a click target so the bot doesn't
 * always click the exact pixel-centre. σ = 4px keeps the click safely
 * inside any reasonably-sized button.
 *
 * @param centre Element centre coordinates.
 * @returns Jittered click point.
 */
export function jitterClickPoint(centre: Point, opts: RngOptions = {}): Point {
  const rng = opts.rng ?? DEFAULT_RNG;
  return {
    x: centre.x + gaussian(0, 4, rng),
    y: centre.y + gaussian(0, 4, rng),
  };
}
