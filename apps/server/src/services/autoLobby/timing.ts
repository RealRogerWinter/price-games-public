/**
 * Humanlike submission-delay distribution for disguised bots.
 *
 * The existing bot scheduler uses a flat 2-6s uniform — fine for clearly-
 * labeled bots, but a giveaway when bots are pretending to be human. Real
 * humans show a bimodal-ish pattern: a fast-confident bucket (<2s on easy
 * recognition), a medium "actually thinking" bucket (2-5s), and a long
 * thinking-pause bucket (6-11s on hard recall).
 *
 * Mixture (default, easy/medium difficulty):
 *   - 70% lognormal, median ≈ 3.2s, sigma ≈ 0.45  (the bulk)
 *   - 20% fast-confident, uniform 0.9-1.8s
 *   - 10% thinking-pause, uniform 6-11s
 *
 * Hard difficulty shifts mass to {50/10/40} — more long pauses, fewer
 * fast-confident samples.
 *
 * Output is in milliseconds, always a positive integer.
 */

import type { BotDifficulty } from "@price-game/shared";

const MEDIUM_MEDIAN_S = 3.2;
const MEDIUM_SIGMA = 0.45;

interface MixtureWeights {
  fast: number;
  medium: number;
  pause: number;
}

const DEFAULT_MIX: MixtureWeights = { fast: 0.20, medium: 0.70, pause: 0.10 };
const HARD_MIX: MixtureWeights = { fast: 0.10, medium: 0.50, pause: 0.40 };

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function uniform(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function pickMix(difficulty: BotDifficulty | undefined): MixtureWeights {
  return difficulty === "hard" ? HARD_MIX : DEFAULT_MIX;
}

/** Options for {@link sampleHumanlikeDelayMs}. */
export interface DelayOpts {
  /** Game difficulty — modulates the mixture toward more pauses on hard. */
  difficulty?: BotDifficulty;
  /** Optional hard cap (ms). Useful when the round timer is short. */
  maxMs?: number;
  /** Optional minimum (ms) — used for modes where instant-submit reads as a bot
   *  (sort-it-out, odd-one-out). Defaults to 600. */
  minMs?: number;
}

/**
 * Draw a single delay (ms) before a disguised bot submits.
 *
 * @param opts - Optional difficulty / cap / floor knobs.
 * @returns Positive integer milliseconds, in `[minMs, maxMs]`.
 */
export function sampleHumanlikeDelayMs(opts: DelayOpts = {}): number {
  const mix = pickMix(opts.difficulty);
  const r = Math.random();
  let raw: number;
  if (r < mix.fast) {
    raw = uniform(0.9, 1.8) * 1000;
  } else if (r < mix.fast + mix.medium) {
    // Lognormal: exp(ln(median) + sigma·N(0,1))
    raw = Math.exp(Math.log(MEDIUM_MEDIAN_S) + MEDIUM_SIGMA * gauss()) * 1000;
  } else {
    raw = uniform(6.0, 11.0) * 1000;
  }
  const minMs = opts.minMs ?? 600;
  const maxMs = opts.maxMs ?? Infinity;
  return Math.max(minMs, Math.min(maxMs, Math.round(raw)));
}
