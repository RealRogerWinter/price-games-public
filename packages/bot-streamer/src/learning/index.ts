/**
 * Public API of the streamer-bot learning subsystem.
 *
 * Imports from `bot-streamer/src/runner/*` should only ever consume
 * names exported here, so the implementation files can be reorganised
 * without breaking the runner.
 */

export { LearningBridge } from "./bridge";
export type {
  LearningMode,
  WorkerTransport,
} from "./bridge";
export { defaultWorkerScriptPath } from "./bridge";
export {
  GAME_MODE_ORDER,
  CATEGORY_BUCKETS,
  BRAND_TIER_BUCKETS,
  FEATURE_DIM,
  EMBEDDING_DIM,
} from "./types";
export type {
  PredictReq,
  PredictRes,
  UpdateReq,
  RevealedSample,
  Sample,
  ProductLite,
  LearningHealthBlock,
  VisualTick,
} from "./types";
export { adaptiveEpsilon, thompsonDraw, quantileShift } from "./thompsonSampler";
export { extractFeatures, FEATURE_NAMES } from "./featureExtractor";
export { archHash, DEFAULT_ARCH_HASH } from "./archHash";
