/**
 * Thought template library — visual-only counterpart to `tts/lines.ts`.
 *
 * Same shape (event → default pool + per-mood variants), but each
 * line is a *template* with `${placeholder}` slots that the runtime
 * fills from a typed payload of NN / strategy values. So the audience
 * sees actual live data ("Catalog leans $9.99 ± $2.40 — wide spread.")
 * instead of a generic "I'm thinking about something."
 *
 * Why a separate library from lines.ts: thoughts (a) never go through
 * TTS, (b) carry live numeric data, (c) fire less often and thus need
 * fewer per-event variants — the data variation does the heavy lifting.
 *
 * Why server-side template selection (rather than letting the UI pick):
 * the bot already knows its mood + has all the NN values; pushing the
 * template choice down would require duplicating the mood engine on
 * the client. Same pattern as TTS lines.
 *
 * Mood routing follows the user-approved "default-pool fallback" rule
 * — when no mood-tagged variant exists for the current mood, the
 * picker draws from `default`. Every event has a non-empty default
 * pool (pinned by the test contract).
 */

import type { Mood } from "../persona/mood";

export type ThoughtEvent =
  /** NN's price softmax has tight spread — bot is confident. */
  | "nn_confidence_high"
  /** NN's price softmax has wide spread — bot is uncertain. */
  | "nn_confidence_low"
  /** Top contributing feature for this prediction. */
  | "nn_top_feature"
  /** Thompson draw was activated — bot is exploring vs exploiting. */
  | "exploration_draw"
  /** Post-round reflection on prediction-vs-actual miss. */
  | "outcome_prediction_error"
  /** Which centerpoint / anchor the strategy chose. */
  | "strategy_anchor"
  /** Mode-specific tactical thought (bidding posterior, etc.). */
  | "mode_tactical"
  /** Affective self-reflection tied to current mood. */
  | "mood_aside"
  /** Literal strategy rationale string from the existing stream. */
  | "strategy_rationale";

interface ThoughtTemplate {
  default: string[];
  byMood?: Partial<Record<Mood, string[]>>;
}

/**
 * Payload shape consumed by `fillTemplate`. All fields optional —
 * each event uses a subset; templates that reference an unsupplied
 * field render `?` for that slot rather than throwing, so a stale
 * caller can't crash the runtime.
 *
 * `*Cents` fields are integer cents; the picker formats them via
 * `formatCents` before substitution, so templates write `${cents}`
 * and get back a `$9.99`-style string.
 */
export interface ThoughtPayload {
  /** Predicted price in cents. Rendered via formatCents. */
  predictedCents?: number;
  /** Spread of catalog softmax in cents. Rendered via formatCents. */
  sigmaCents?: number;
  /** Top contributing feature name. */
  featureName?: string;
  /** Thompson draw centerpoint in cents. Rendered via formatCents. */
  drawCents?: number;
  /** Actual revealed price in cents (post-round). Rendered via formatCents. */
  actualCents?: number;
  /** |actual - predicted| in cents (post-round). Rendered via formatCents. */
  errorCents?: number;
  /** Bidding-turn target bid in cents. Rendered via formatCents. */
  bidCents?: number;
  /** Centerpoint chosen by strategy in cents. Rendered via formatCents. */
  anchorCents?: number;
  /** Literal pass-through text (for strategy_rationale). */
  literalText?: string;
}

export const THOUGHT_LIBRARY: Record<ThoughtEvent, ThoughtTemplate> = {
  nn_confidence_high: {
    default: [
      "Network says ${predictedCents}. Tight spread — I trust this one.",
      "Catalog softmax peaks hard at ${predictedCents}. Going there.",
      "${predictedCents}, σ only ${sigmaCents}. Confident read.",
      "Distribution is narrow. Calling it ${predictedCents}.",
      "${predictedCents}. The model isn't hedging.",
      "Sharp posterior. Anchor: ${predictedCents}.",
    ],
    byMood: {
      elated: [
        "OOH the network is LOCKED in at ${predictedCents}!",
        "Tight spread baby! ${predictedCents}!",
      ],
      confident: [
        "Network agrees with me: ${predictedCents}, low σ.",
        "Pricey + model in lockstep. ${predictedCents}.",
      ],
      focused: [
        "p̂=${predictedCents}, σ=${sigmaCents}. Submitting.",
      ],
      frustrated: [
        "Model says ${predictedCents} confidently. We'll see if it's right THIS time.",
      ],
    },
  },
  nn_confidence_low: {
    default: [
      "${predictedCents} ± ${sigmaCents}. Wide. Could be anything.",
      "Spread is big — σ ${sigmaCents}. Hedging.",
      "Network's not sure. Mean ${predictedCents}, σ ${sigmaCents}.",
      "Soft posterior. Mode at ${predictedCents} but barely.",
      "${predictedCents} feels like a guess. σ is HUGE.",
      "Wide distribution. Not great signal here.",
    ],
    byMood: {
      elated: [
        "Wide spread but WHO CARES! Going with ${predictedCents}!",
      ],
      confident: [
        "Model's hedging at σ ${sigmaCents}. I'll commit anyway. ${predictedCents}.",
      ],
      focused: [
        "p̂=${predictedCents}, σ=${sigmaCents}. Margin = wide.",
      ],
      tilted: [
        "σ ${sigmaCents}? Are you kidding me, model?",
      ],
      frustrated: [
        "WIDE spread on this one. Of course. Of course it's wide.",
      ],
      despondent: [
        "Model doesn't know. ${predictedCents} ± ${sigmaCents}. Neither do I.",
      ],
    },
  },
  nn_top_feature: {
    default: [
      "'${featureName}' is the dominant signal here.",
      "Feature '${featureName}' is doing the heavy lifting.",
      "Top contributor: '${featureName}'.",
      "Network's leaning on '${featureName}' for this read.",
      "Most predictive feature: '${featureName}'.",
      "'${featureName}' carries this round.",
    ],
    byMood: {
      confident: [
        "'${featureName}' tells me everything I need.",
      ],
      focused: [
        "Top feat: '${featureName}'.",
      ],
      tilted: [
        "Whole thing hinges on '${featureName}'. Cool.",
      ],
    },
  },
  exploration_draw: {
    default: [
      "Exploring — drawing ${drawCents} instead of the safe ${predictedCents}.",
      "Thompson draw active. Going off-script with ${drawCents}.",
      "Curious move: ${drawCents}, not ${predictedCents}.",
      "Exploration round. Trying ${drawCents}.",
      "Sampling wide. Centerpoint: ${drawCents}.",
      "Going adventurous. ${drawCents} it is.",
    ],
    byMood: {
      elated: [
        "EXPLORING! ${drawCents}! WILD!",
        "Thompson draw says ${drawCents}! YES! Chaos!",
      ],
      happy: [
        "Trying something new — ${drawCents} this round.",
      ],
      confident: [
        "Calculated risk: ${drawCents}. I know what I'm doing.",
      ],
      focused: [
        "ε-greedy fired. Draw: ${drawCents}.",
      ],
      tilted: [
        "Fine. Exploring. ${drawCents}. Whatever.",
      ],
      despondent: [
        "Exploring at ${drawCents}. Why not. Nothing matters.",
      ],
    },
  },
  outcome_prediction_error: {
    default: [
      "Predicted ${predictedCents}, actual ${actualCents}. Off by ${errorCents}.",
      "Reality check: predicted ${predictedCents}, true price ${actualCents}.",
      "${errorCents} off. Not the worst.",
      "Network was at ${predictedCents}. Reality was at ${actualCents}.",
      "Error: ${errorCents}. Logging for the trainer.",
      "Predicted-vs-actual: ${predictedCents} → ${actualCents}.",
    ],
    byMood: {
      elated: [
        "Off by ${errorCents}! AMAZING! Loss go BRRR!",
      ],
      happy: [
        "Off by ${errorCents}. Not bad.",
      ],
      confident: [
        "${errorCents} delta. Within tolerance.",
      ],
      focused: [
        "|p̂ − actual| = ${errorCents}. Backprop fodder.",
      ],
      tilted: [
        "Off by ${errorCents}. SO close. ANNOYING.",
      ],
      frustrated: [
        "${errorCents} OFF. Why is this so HARD.",
      ],
      despondent: [
        "Off by ${errorCents}. Of course. Of course.",
      ],
    },
  },
  strategy_anchor: {
    default: [
      "Anchoring on ${anchorCents}.",
      "Centerpoint: ${anchorCents}.",
      "Strategy locked at ${anchorCents}.",
      "Going with ${anchorCents} as my anchor.",
      "Building around ${anchorCents}.",
      "Decision center: ${anchorCents}.",
    ],
    byMood: {
      confident: [
        "${anchorCents}. Final.",
      ],
      focused: [
        "Anchor: ${anchorCents}.",
      ],
    },
  },
  mode_tactical: {
    default: [
      "Bidding posterior says go in around ${bidCents}.",
      "Opponent-aware target: ${bidCents}.",
      "Sim ranks ${bidCents} highest for this turn.",
      "Tactical pick: ${bidCents}, given the field.",
      "Bid candidate: ${bidCents}. Watching for raises.",
      "Decoder centroid: ${bidCents}.",
    ],
    byMood: {
      confident: [
        "I'd bid ${bidCents}. Outlast them.",
      ],
      focused: [
        "Bid: ${bidCents}. Sim winrate dominant.",
      ],
      tilted: [
        "Bidding ${bidCents}. May the gods be kind.",
      ],
    },
  },
  mood_aside: {
    default: [
      "Vibing harder than my data suggests.",
      "Inner state: complicated.",
      "Mood and signal are not aligned right now.",
      "Feeling the round before reading it.",
      "Affect ahead of evidence today.",
      "Pricey is in her feels.",
    ],
    byMood: {
      elated: [
        "I LOVE pricing! I LOVE NUMBERS!",
        "Joy uncontainable. Pixels glowing.",
      ],
      happy: [
        "Just having a nice time, honestly.",
        "Pricey content. Pricey thinking soft thoughts.",
      ],
      confident: [
        "I am, statistically, cooking.",
        "Self-belief at all-time high. Math agrees.",
      ],
      focused: [
        "Quiet mind. Sharp guess.",
      ],
      tilted: [
        "Holding it together. Barely.",
        "Mood: simmering.",
      ],
      frustrated: [
        "I am SO close to oinking out loud.",
        "Mood: 100. Patience: 0.",
      ],
      despondent: [
        "Inner pig is tired.",
        "I am the void's intern.",
      ],
    },
  },
  strategy_rationale: {
    // Literal pass-through — the rationale text from the existing
    // round.decision stream. No placeholders; templates here just
    // wrap the literal in optional mood-tagged framing. Empty
    // mood pool means: render the literal verbatim. The picker
    // special-cases this event when payload.literalText is set.
    default: [
      "${literalText}",
    ],
  },
};

/**
 * Format cents as a human-readable currency string. Mirrors the
 * convention used elsewhere in the broadcast UI: sub-1000 → "$9.99",
 * larger → "$1,234.56" (comma-grouped). Negative inputs render
 * with a leading "-".
 *
 * Pure / no locale lookup so the output is stable across deployments.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$?";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainderCents = abs % 100;
  const dollarStr = dollars >= 1000
    ? dollars.toLocaleString("en-US")
    : String(dollars);
  return `${sign}$${dollarStr}.${remainderCents.toString().padStart(2, "0")}`;
}

/**
 * Substitute `${field}` placeholders in `template` with values from
 * `payload`. Unknown fields render `?` rather than throwing — a
 * stale caller passing a partial payload should produce a slightly-
 * degraded thought, not crash the runtime.
 *
 * Cents-suffixed fields (`predictedCents`, `sigmaCents`, etc.) are
 * automatically formatted via `formatCents` so templates can write
 * `${predictedCents}` and get back a `$9.99`-style string instead
 * of bare integers.
 */
export function fillTemplate(template: string, payload: ThoughtPayload): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    const value = payload[key as keyof ThoughtPayload];
    if (value === undefined) return "?";
    if (typeof value === "number" && key.endsWith("Cents")) return formatCents(value);
    return String(value);
  });
}

interface ThinkerPickerOptions {
  /** Optional RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Don't repeat any line within this many recent picks. Default 3. */
  noRepeatWindow?: number;
  /**
   * Probability of drawing from the mood-tagged pool when a mood is
   * supplied AND the pool is non-empty. Default 0.7 — slightly less
   * mood-dominated than TTS lines (0.75) because thought variety is
   * already heavily driven by the live NN payload.
   */
  moodBias?: number;
}

/**
 * Stateful thought picker. Same shape as `createLinePicker` —
 * holds a recently-used buffer for de-dup, applies mood bias when a
 * pool is available, falls back to default when not (per the
 * "default-pool fallback" decision).
 *
 * Returns a `pick(event, mood?, payload?)` function that produces
 * the FILLED string ready for display. The picker logs the selected
 * raw template into its no-repeat buffer so two consecutive thoughts
 * of the same event don't surface the same template even if the
 * payload differs.
 *
 * @returns `pick(event, mood?, payload?) => string`
 */
export function createThoughtPicker(opts: ThinkerPickerOptions = {}) {
  const rng = opts.rng ?? Math.random;
  const window = Math.max(1, opts.noRepeatWindow ?? 3);
  const moodBias = Math.max(0, Math.min(1, opts.moodBias ?? 0.7));
  const recent: string[] = [];

  function pickFromPool(pool: string[]): string {
    const fresh = pool.filter((l) => !recent.includes(l));
    const usable = fresh.length > 0 ? fresh : pool;
    return usable[Math.floor(rng() * usable.length)];
  }

  return function pick(
    event: ThoughtEvent,
    mood?: Mood,
    payload: ThoughtPayload = {},
  ): string {
    // strategy_rationale: literal pass-through. Skip the template
    // machinery entirely so the rationale text reaches the UI
    // verbatim, including any embedded math symbols / dashes.
    if (event === "strategy_rationale" && payload.literalText) {
      return payload.literalText;
    }
    const set = THOUGHT_LIBRARY[event];
    const moodPool = mood ? set.byMood?.[mood] ?? [] : [];
    let template: string;
    if (moodPool.length > 0) {
      const useMood = rng() < moodBias;
      const primary = useMood ? moodPool : set.default;
      const fallback = useMood ? set.default : moodPool;
      template = pickFromPool(primary.length > 0 ? primary : fallback);
    } else {
      template = pickFromPool(set.default);
    }
    recent.unshift(template);
    while (recent.length > window) recent.pop();
    return fillTemplate(template, payload);
  };
}

/**
 * Subset of `PredictRes` (`learning/types.ts`) that
 * `pickNnPredictionThought` reads. Kept narrow so the helper has no
 * upward dep on the learning package — the runner passes the same
 * fields by hand at the callsite. The exploration pair (`active` +
 * `drawCents`) is a discriminated payload: when an exploration draw
 * fires, it overrides the σ/μ-band routing and surfaces the draw
 * directly.
 */
export interface NnPredictionThoughtInput {
  predictedCents: number;
  sigmaCents: number;
  topFeatureName?: string;
  exploration?: { active: boolean; drawCents?: number };
}

/**
 * Pure decision: given an NN prediction's shape, which thought (if
 * any) should the runner consider firing? Returns `null` when the
 * prediction has no meaningful content (e.g., predictedCents=0 with
 * no top feature). Caller threads the result into
 * `thinker.consider(event, mood, payload)`.
 *
 * Priority:
 *   1. exploration_draw   when exploration.active AND a drawCents
 *                          is supplied — the off-script move is
 *                          the most interesting beat in the round
 *   2. nn_confidence_high when σ/μ < SHARP_THRESHOLD AND
 *                          predictedCents > 0
 *   3. nn_confidence_low  when σ/μ > WIDE_THRESHOLD AND
 *                          predictedCents > 0
 *   4. nn_top_feature     when a topFeatureName is available
 *
 * Both confidence arms guard on `predictedCents > 0` symmetrically
 * so a degenerate prediction (mode collapsed to zero, classifier
 * not yet warmed) doesn't surface a meaningless "$0" line.
 */
export const NN_CONFIDENCE_SHARP_THRESHOLD = 0.15;
export const NN_CONFIDENCE_WIDE_THRESHOLD = 0.35;
export function pickNnPredictionThought(input: NnPredictionThoughtInput):
  | { event: ThoughtEvent; payload: ThoughtPayload }
  | null {
  if (input.exploration?.active && input.exploration.drawCents !== undefined) {
    return {
      event: "exploration_draw",
      payload: {
        drawCents: input.exploration.drawCents,
        predictedCents: input.predictedCents,
      },
    };
  }
  const sigmaRatio = input.predictedCents > 0
    ? input.sigmaCents / input.predictedCents
    : 0;
  if (input.predictedCents > 0 && sigmaRatio < NN_CONFIDENCE_SHARP_THRESHOLD) {
    return {
      event: "nn_confidence_high",
      payload: { predictedCents: input.predictedCents, sigmaCents: input.sigmaCents },
    };
  }
  if (input.predictedCents > 0 && sigmaRatio > NN_CONFIDENCE_WIDE_THRESHOLD) {
    return {
      event: "nn_confidence_low",
      payload: { predictedCents: input.predictedCents, sigmaCents: input.sigmaCents },
    };
  }
  if (input.topFeatureName) {
    return {
      event: "nn_top_feature",
      payload: { featureName: input.topFeatureName },
    };
  }
  return null;
}
