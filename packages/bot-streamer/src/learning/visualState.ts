/**
 * Build the {@link VisualTick} the broadcast overlay consumes.
 *
 * The worker pre-encodes the tick to a Buffer (JSON.stringify → utf8)
 * so the main thread only does `socket.emit`. This avoids the JSON
 * round-trip on the UI-critical thread.
 *
 * As of PR #4 the belief block is slimmed: the category narrative and
 * brand-tier badge are gone; the sentence is now confidence-derived
 * from the priceClassHead's softmax instead of category-derived.
 */

import { FEATURE_NAMES } from "./featureExtractor";
import {
  EMBEDDING_DIM,
  type LearningPhase,
  type VisualTick,
} from "./types";

export interface VisualBuilderInputs {
  roundId: string;
  phase: LearningPhase;
  /** Hidden activations of the trunk (post-ReLU). Length === TRUNK_HIDDEN_DIM. */
  trunkHidden: Float32Array;
  /** Embedding (trunk output). */
  embedding: Float32Array;
  /** Last 50 round losses (newest last). */
  recentLosses: number[];
  /** Last 10 round bucket labels. */
  recentAccuracy: Array<"within10" | "within25" | "miss">;
  /** Predicted price + sigma for the gauge. */
  predictionCents: number;
  predictionSigmaCents: number;
  /** 2-d viz projection. */
  vizCoord: [number, number];
  /** Top features by |contribution|. */
  topFeatures: Array<{ name: string; contribution: number }>;
  /** Whether the tick should fire the "aha" pulse. */
  teachingMomentTriggered: boolean;
  /** Optional product title for the teaching-moment caption. */
  teachingMomentTitle?: string;
  /** Most-active neuron index per layer; previous trail samples. */
  mostActiveByLayer: Array<{ idx: number; trail: [number, number] }>;
  /** Pre-sampled weight edges (subset). */
  weightSamples: Array<{
    fromLayer: number;
    fromIdx: number;
    toLayer: number;
    toIdx: number;
    weight: number;
  }>;
  /** Hero-path nodes when phase==='reveal'. */
  heroPath?: Array<{ layer: number; idx: number }>;
  /**
   * Top-K canonical-prices catalog candidates from the priceClassHead
   * softmax, sorted by probability descending. BeliefCard renders
   * top-3 with percentages. The first entry's `prob` also drives the
   * confidence-based belief sentence below.
   */
  priceCandidates?: Array<{ cents: number; prob: number }>;
  /** Training/health snapshot for the Neural Debug HUD — see VisualTick.health. */
  health?: VisualTick["health"];
}

/** Length-bounded copy of `arr` keeping the latest `n`. */
function tail<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  return arr.slice(arr.length - n);
}

const FEATURE_THRESHOLD = 0.15;
/** Top-prob threshold for "Pricey is sure" copy. */
const SURE_TOP_PROB = 0.6;
/** Top-prob threshold for "Pricey is leaning" copy. */
const LEANING_TOP_PROB = 0.3;

/** Convert engineered feature name to a stream-friendly fragment. */
export function prettyFeatureName(name: string): string {
  if (name.startsWith("tok_")) return name.slice(4).replace(/-/g, " ");
  if (name.startsWith("mode_")) return name.slice(5);
  return name.replace(/_/g, " ");
}

/** Format a cents value as "$N.NN" — used inside worker-rendered copy. */
function formatDollars(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "?";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Pre-render the BeliefCard sentence on the worker so the panel stays
 * a dumb renderer.
 *
 * The PR-4 sentence is confidence-derived. We grade the top
 * priceCandidate's probability into three bands:
 *   - prob ≥ 0.60  → "Pricey is sure: $X"
 *   - prob ≥ 0.30  → "Pricey is leaning $X"
 *   - else         → fall back to the feature-driven sentence (or
 *                    "Still finding the pattern…" when no feature
 *                    crosses the contribution threshold).
 *
 * @param topFeatures      Top engineered features by |contribution|.
 * @param priceCandidates  Top-K classifier candidates (probability desc).
 */
export function chooseBeliefSentence(
  topFeatures: ReadonlyArray<{ name: string; contribution: number }>,
  priceCandidates?: ReadonlyArray<{ cents: number; prob: number }>,
): string {
  const top = priceCandidates && priceCandidates.length > 0 ? priceCandidates[0] : null;
  if (top && top.prob >= SURE_TOP_PROB) {
    return `Pricey is sure: ${formatDollars(top.cents)}.`;
  }
  if (top && top.prob >= LEANING_TOP_PROB) {
    return `Leaning ${formatDollars(top.cents)}.`;
  }
  // Fall through to the feature-driven sentence (legacy path) — useful
  // during cold-start before the classifier has formed an opinion.
  const above = topFeatures.filter((f) => Math.abs(f.contribution) >= FEATURE_THRESHOLD);
  if (above.length === 0) return "Still finding the pattern…";
  if (above.length === 1) {
    const f = above[0];
    if (f.contribution < 0) {
      return `Cheap signal — "${prettyFeatureName(f.name)}" usually means low-end.`;
    }
    return `Looking pricey — "${prettyFeatureName(f.name)}" is doing the talking.`;
  }
  const [a, b] = above;
  return `Two signals pulling up: "${prettyFeatureName(a.name)}" and "${prettyFeatureName(b.name)}".`;
}

/**
 * Build a VisualTick payload (NOT the encoded Buffer).
 *
 * @param input All visual fields the worker has sampled this tick.
 * @returns Payload object — pass to {@link encodeTick} to get the Buffer.
 */
export function buildTick(input: VisualBuilderInputs): VisualTick {
  // Subsample the input layer to ~12 representative neurons by stride.
  const inputStride = Math.max(1, Math.floor(FEATURE_NAMES.length / 12));
  const inputActivations: number[] = [];
  for (let i = 0; i < FEATURE_NAMES.length; i += inputStride) {
    if (inputActivations.length < 12) inputActivations.push(i);
  }
  // Trunk hidden + embedding: cap displayed activations at 32 / 16 entries.
  const hidden = Array.from(input.trunkHidden.subarray(0, 32));
  const emb = Array.from(input.embedding.subarray(0, EMBEDDING_DIM));

  return {
    roundId: input.roundId,
    phase: input.phase,
    network: {
      layers: [
        {
          name: "input",
          activations: inputActivations.map(() => 0), // visualisation: filled by panel
          mostActiveIdx: input.mostActiveByLayer[0]?.idx ?? 0,
          mostActiveTrail: input.mostActiveByLayer[0]?.trail ?? [0, 0],
        },
        {
          name: "trunk-hidden",
          activations: hidden,
          mostActiveIdx: input.mostActiveByLayer[1]?.idx ?? 0,
          mostActiveTrail: input.mostActiveByLayer[1]?.trail ?? [0, 0],
        },
        {
          name: "embedding",
          activations: emb,
          mostActiveIdx: input.mostActiveByLayer[2]?.idx ?? 0,
          mostActiveTrail: input.mostActiveByLayer[2]?.trail ?? [0, 0],
        },
      ],
      weightSamples: input.weightSamples,
      heroPath: input.heroPath,
    },
    prediction: {
      cents: input.predictionCents,
      sigma: input.predictionSigmaCents,
    },
    priceCandidates: input.priceCandidates,
    belief: {
      topFeatures: input.topFeatures,
      sentence: chooseBeliefSentence(input.topFeatures, input.priceCandidates),
    },
    embedding2d: { x: input.vizCoord[0], y: input.vizCoord[1] },
    recentLosses: tail(input.recentLosses, 50),
    recentAccuracy: tail(input.recentAccuracy, 10),
    teachingMoment: {
      triggered: input.teachingMomentTriggered,
      productTitle: input.teachingMomentTitle,
    },
    ...(input.health ? { health: input.health } : {}),
    ageMs: Date.now(),
  };
}

/** JSON-encode a tick to a Buffer for zero-copy transfer. */
export function encodeTick(tick: VisualTick): Buffer {
  return Buffer.from(JSON.stringify(tick), "utf8");
}
