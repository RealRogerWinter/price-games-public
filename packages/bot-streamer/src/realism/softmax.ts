/**
 * Softmax candidate sampler for the bot's "skill curve".
 *
 * Each ModeStrategy returns a list of `{ action, score, rationale }`
 * candidates. The sampler converts the score vector into a probability
 * distribution at temperature T, then draws one candidate.
 *
 * - T = 0  → always pick the highest-scoring candidate (perfect play).
 * - T = 1  → distribution is the standard softmax, leaning toward the
 *            best but giving plausible alternatives a real shot.
 * - T → ∞  → uniform; the bot picks at random.
 *
 * For the streamer we tend toward T ≈ 0.3–0.4 — competent player who
 * occasionally takes a wrong-but-plausible answer.
 */
import type { RngOptions } from "./timing";

export interface ScoredCandidate<TPayload> {
  payload: TPayload;
  /** Higher is better. Same units across the candidate list. */
  score: number;
  rationale?: string;
}

export interface SoftmaxOptions extends RngOptions {
  /** Temperature; must be ≥ 0. Defaults to 1.0. */
  temperature?: number;
}

const DEFAULT_RNG = Math.random;

/**
 * Sample one candidate from `candidates` weighted by softmax(score / T).
 *
 * @param candidates Non-empty list of scored candidates.
 * @param opts See {@link SoftmaxOptions}.
 * @throws Error if `candidates` is empty.
 * @returns The sampled candidate (a reference into the input array).
 */
export function softmaxSample<TPayload>(
  candidates: ScoredCandidate<TPayload>[],
  opts: SoftmaxOptions = {},
): ScoredCandidate<TPayload> {
  if (candidates.length === 0) {
    throw new Error("softmaxSample: candidate list is empty");
  }
  if (candidates.length === 1) return candidates[0];

  const rng = opts.rng ?? DEFAULT_RNG;
  const temperature = opts.temperature ?? 1.0;

  // T = 0: deterministic — pick the best score (first index on ties so
  // the result is stable for tests).
  if (temperature <= 0) {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > best.score) {
        best = candidates[i];
      }
    }
    return best;
  }

  // Standard softmax with temperature scaling. Subtract the max score
  // for numerical stability before exponentiating.
  let maxScore = -Infinity;
  for (const c of candidates) if (c.score > maxScore) maxScore = c.score;

  let total = 0;
  const weights = candidates.map((c) => {
    const w = Math.exp((c.score - maxScore) / temperature);
    total += w;
    return w;
  });

  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  // Floating-point fall-through; return the last candidate.
  return candidates[candidates.length - 1];
}
