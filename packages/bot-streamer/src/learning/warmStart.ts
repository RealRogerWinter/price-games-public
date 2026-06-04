/**
 * Phase 3b warm-start: seed the new arch's compatible buffers from
 * the most-recent archived snapshot's flat-params.
 *
 * Background. Phase 3b ships with a `headTopologyVersion` archHash
 * bump (see {@link archHash}). Pre-3b snapshots auto-archive on
 * next start, leaving the model with random weights that need
 * weeks of streaming to recover Phase-4 accuracy. The recovery
 * plan calls for a distillation warm-start to cushion this; in
 * Phase 3b's case the trunk dimensions, embedding dim, and
 * priceClassK are all unchanged — only the param-buffer iteration
 * order grew with the new heads — so warm-start reduces to a
 * direct **prefix copy** from the archived flat-params into the
 * new network's first 8 buffers (trunk[0]+trunk[1] +
 * priceClassHead + filmGen, in iterParamBuffers order). The 5 new
 * heads start from random init.
 *
 * No distillation loop is needed because the math is exact: the
 * pre-3b network's `forward(x)` for the priceClass path is
 * bit-identical when the same weights live in the new network's
 * priceClassHead. The new heads' weights are independent, so
 * there's no cross-talk.
 *
 * The optimizer's adam-moment buffers are a different size (8 vs
 * 22 entries) so we don't try to restore them — they re-warm in
 * ~50 steps.
 *
 * Safe failure modes:
 *   - No archived snapshot: skip warm-start, return false.
 *   - Schema mismatch (older format): skip, return false.
 *   - Wrong-length flat-params buffer: skip, return false.
 *
 * The caller (`WorkerCore.init`) should run this AFTER detecting
 * an archHash mismatch (loadLatestSnapshot returned null due to
 * mismatch).
 */

import type { LearningPersistence } from "./persistence";
import { SCHEMA_VERSION } from "./persistence";
import { iterParamBuffers, type Network } from "./mlp";

/**
 * Number of buffers warm-started from the archive prefix. These are
 * the buffers whose shape has remained stable across every arch bump
 * since Phase 3b: `trunk[0].W, .b, trunk[1].W, .b, priceClassHead.W, .b`
 * (six buffers total).
 *
 * Phase 3e.2 (SCHEMA_VERSION 2 → 3) shrank this from 8 to 6: filmGen's
 * input dim changed (cond_dim 6 → 3), so its archived `W` (192 entries)
 * no longer matches the new layer's `W` (96 entries). Copying the
 * first 96 of 192 would scramble the layer (the OLD W is laid out
 * `[col0..col5 for out0, col0..col5 for out1, ...]` so the first 96
 * entries cover only the first 16 outputs, not the full 32).
 *
 * Any future arch bump that changes the dim of trunk[0/1] or
 * priceClassHead MUST also bump SCHEMA_VERSION so the version-mismatch
 * guard below rejects the now-incompatible archive.
 */
export const WARM_START_BUFFER_COUNT = 6;

/**
 * Minimum archived `schemaVersion` from which warm-start will read
 * the first {@link WARM_START_BUFFER_COUNT} buffers. Phase 3e.2 sets
 * this to **2** — pre-v2 archives had a different buffer order
 * (priceClassHead landed in PR #282 still under v1; pre-3b multi-task
 * heads occupied the same slots) and would silently splice mis-aligned
 * data into the new prefix. The byte-length guard at line 149
 * (`archived.weights.length < prefixBytes`) does NOT catch v1
 * archives because the FULL v1 flat-params blob is larger than the
 * v3 prefix.
 *
 * Production reality: running boxes have v2 or v3 archives, so this
 * is defence-in-depth rather than load-bearing. But the version
 * envelope SHOULD reflect what's actually safe.
 *
 * **Caveat — featureDim variability within v2.** Schema v2 lived
 * through three FEATURE_DIM values (114 → 135 → 140) without a
 * SCHEMA_VERSION bump because `featureDim` is in archHash and
 * archHash mismatch alone forces archive. So an in-process v2 archive
 * created by THIS deploy line shares the current FEATURE_DIM, but a
 * cross-version v2 archive (e.g. an old DB restored from backup)
 * could have a smaller FEATURE_DIM. The byte-length guard catches
 * the smaller-archive case (would fail the `archived.weights.length
 * < prefixBytes` check). The larger-archive case (FEATURE_DIM grew
 * post-archive) doesn't apply on the upgrade path because archHash
 * mismatch already happened at the time of the FEATURE_DIM bump,
 * archiving the smaller-FEATURE_DIM blob.
 *
 * Any future change to a buffer in the warm-start prefix (trunk[0/1]
 * or priceClassHead) MUST bump both SCHEMA_VERSION and
 * MIN_WARM_START_SOURCE_VERSION so this guard rejects archives that
 * pre-date the new shape.
 */
export const MIN_WARM_START_SOURCE_VERSION = 2;

/**
 * Result of {@link tryWarmStartFromArchive}.
 */
export interface WarmStartResult {
  /** True iff buffers were successfully copied from the archive. */
  warmStarted: boolean;
  /**
   * Round counter from the archived snapshot when warm-start
   * succeeded; null otherwise. Logged by the caller for visibility.
   */
  archivedRound: number | null;
  /**
   * Number of float32 entries copied. 0 when warm-start was skipped.
   */
  bytesCopied: number;
  /** Reason for skipping when `warmStarted` is false. */
  reason?: string;
}

/**
 * Try to warm-start `network` from the persistence layer's most
 * recent archived snapshot. Pure on `persistence` (no writes); the
 * `network` argument's first 8 param-buffers are mutated in place
 * when warm-start succeeds.
 *
 * @param persistence Learning persistence, already opened.
 * @param network     Freshly-initialised network (random weights).
 *                    On success, its trunk + priceClassHead +
 *                    filmGen buffers are overwritten with the
 *                    archived weights.
 * @returns           {@link WarmStartResult} with details for logs.
 */
export function tryWarmStartFromArchive(
  persistence: LearningPersistence,
  network: Network,
): WarmStartResult {
  let archived;
  try {
    archived = persistence.loadLatestArchivedSnapshot();
  } catch (err) {
    return {
      warmStarted: false,
      archivedRound: null,
      bytesCopied: 0,
      reason: `loadLatestArchivedSnapshot threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!archived) {
    return {
      warmStarted: false,
      archivedRound: null,
      bytesCopied: 0,
      reason: "no archived snapshot",
    };
  }
  // Compute prefix length (sum of first 8 buffer sizes in the
  // current network — these are the buffers that survived the
  // bump). Iterating the live network is safer than hardcoding
  // dims, since trunk-hidden + priceClassK are still in the spec.
  const prefixSizes: number[] = [];
  let i = 0;
  for (const buf of iterParamBuffers(network)) {
    if (i >= WARM_START_BUFFER_COUNT) break;
    prefixSizes.push(buf.length);
    i += 1;
  }
  if (prefixSizes.length !== WARM_START_BUFFER_COUNT) {
    return {
      warmStarted: false,
      archivedRound: archived.round,
      bytesCopied: 0,
      reason: `network has only ${prefixSizes.length} buffers; expected ≥${WARM_START_BUFFER_COUNT}`,
    };
  }
  const prefixFloats = prefixSizes.reduce((a, b) => a + b, 0);
  const prefixBytes = prefixFloats * 4;
  if (archived.weights.length < prefixBytes) {
    return {
      warmStarted: false,
      archivedRound: archived.round,
      bytesCopied: 0,
      reason: `archived weights ${archived.weights.length} bytes < required ${prefixBytes}`,
    };
  }
  // Defence-in-depth shape check. The archive's `weights` is the
  // FULL pre-bump flat-params blob, with size = sum of OLD per-buffer
  // sizes. The first WARM_START_BUFFER_COUNT buffers (trunk[0]+1 +
  // priceClassHead) have had stable shapes across every schema version
  // shipped to date, so any version ≥ MIN_WARM_START_SOURCE_VERSION
  // is a valid source for the prefix.
  //
  // A future arch bump that changes the dim of any surviving buffer
  // MUST bump both SCHEMA_VERSION and MIN_WARM_START_SOURCE_VERSION
  // so this guard rejects archives that pre-date the new shape.
  if (archived.schemaVersion < MIN_WARM_START_SOURCE_VERSION) {
    return {
      warmStarted: false,
      archivedRound: archived.round,
      bytesCopied: 0,
      reason: `archived schemaVersion ${archived.schemaVersion} < min compatible ${MIN_WARM_START_SOURCE_VERSION}`,
    };
  }
  // Read the float32 view of the archived weights' prefix and
  // distribute into the network's first 8 param buffers.
  const archivedFlat = new Float32Array(
    archived.weights.buffer,
    archived.weights.byteOffset,
    prefixFloats,
  );
  let off = 0;
  let written = 0;
  i = 0;
  for (const buf of iterParamBuffers(network)) {
    if (i >= WARM_START_BUFFER_COUNT) break;
    const slice = archivedFlat.subarray(off, off + buf.length);
    // Defensive: any non-finite weight in the archive cancels the
    // copy for that buffer (better random-init than NaN poisoning).
    let allFinite = true;
    for (let k = 0; k < slice.length; k++) {
      if (!Number.isFinite(slice[k])) {
        allFinite = false;
        break;
      }
    }
    if (allFinite) {
      buf.set(slice);
      written += slice.length;
    }
    off += buf.length;
    i += 1;
  }
  return {
    warmStarted: written > 0,
    archivedRound: archived.round,
    bytesCopied: written * 4,
    reason: written > 0 ? undefined : "all archived prefix buffers contained non-finite values",
  };
}
