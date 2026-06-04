/**
 * Architecture-hash computation for the streamer-bot learning system.
 *
 * The hash is a stable fingerprint of the {@link ModelSpec}. It is
 * persisted with every NN snapshot and checked on load — when the
 * spec changes (any layer dim, head count, etc.) the hash changes,
 * the loader detects the mismatch, archives the old snapshot, and
 * starts fresh. This is the correctness gate that lets us evolve
 * the architecture without crashing on stale weights.
 *
 * SHA-256 is overkill for the collision risk here, but it's the only
 * digest in node:crypto we can rely on without an extra dependency,
 * and the cost is negligible (run-once at process start).
 */

import { createHash } from "node:crypto";
import { MODEL_SPEC, type ModelSpec } from "./types";

/**
 * Compute the hex SHA-256 of a model spec. Stable across runs because
 * the spec is a frozen object literal with deterministic key order.
 *
 * @param spec ModelSpec to hash. Defaults to {@link MODEL_SPEC}.
 * @returns 64-char lowercase hex string.
 */
export function archHash(spec: ModelSpec = MODEL_SPEC): string {
  // JSON.stringify with explicit key ordering to defeat any future
  // change in V8's property-iteration order — belt-and-braces.
  const ordered: Record<string, number> = {
    featureDim: spec.featureDim,
    trunkHiddenDim: spec.trunkHiddenDim,
    embeddingDim: spec.embeddingDim,
    numModes: spec.numModes,
    priceClassK: spec.priceClassK,
    condDim: spec.condDim,
    // Phase 3b: head-topology bump. Adding new specialised heads
    // doesn't change any other dim, so this version field is the
    // dedicated knob that forces archHash mismatch when the head
    // set changes.
    headTopologyVersion: spec.headTopologyVersion,
  };
  const canonical = JSON.stringify(ordered);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Memoised default-spec hash. Module-load cost only. */
export const DEFAULT_ARCH_HASH = archHash();
