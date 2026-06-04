/**
 * Phase 3b warm-start tests.
 *
 * The warm-start path replaces the new arch's first 8 param-buffers
 * (trunk + priceClassHead + filmGen) with the most-recent archived
 * snapshot's flat-params prefix. We verify:
 *   - The path correctly skips when no archive exists.
 *   - Warm-start preserves the prefix bit-for-bit.
 *   - The Phase 3b heads (logPrice, pairLogit, squashedReg, etc.)
 *     stay at their fresh-init values (no leakage from the archive).
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  WARM_START_BUFFER_COUNT,
  tryWarmStartFromArchive,
} from "../../src/learning/warmStart";
import { LearningPersistence } from "../../src/learning/persistence";
import {
  createNetwork,
  flattenParams,
  iterParamBuffers,
  paramCount,
} from "../../src/learning/mlp";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("tryWarmStartFromArchive", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    /* fresh tmp dir per test */
  });

  afterAll(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it("returns warmStarted=false when there is no archive table", async () => {
    const dir = await tmpDir("nn-ws-empty-");
    dirs.push(dir);
    const persistence = await LearningPersistence.open({ dataDir: dir });
    try {
      const net = createNetwork();
      const result = tryWarmStartFromArchive(persistence, net);
      expect(result.warmStarted).toBe(false);
      expect(result.reason).toBe("no archived snapshot");
    } finally {
      persistence.close();
    }
  });

  it("copies the prefix bit-for-bit when an archived snapshot exists", async () => {
    const dir = await tmpDir("nn-ws-prefix-");
    dirs.push(dir);
    // Open with one archHash to write the snapshot.
    const persistence = await LearningPersistence.open({
      dataDir: dir,
      archHashOverride: "old-arch-hash-aaaaa",
    });
    try {
      // Seed a network with deterministic-ish weights.
      const oldNet = createNetwork(() => 0.5);
      // Mutate so the saved weights are non-trivial.
      let i = 0;
      for (const buf of iterParamBuffers(oldNet)) {
        for (let k = 0; k < buf.length; k++) buf[k] = (i + 1) * 0.001 + k * 0.0001;
        i += 1;
      }
      const flat = flattenParams(oldNet);
      persistence.saveSnapshot({
        round: 12345,
        weights: Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength),
        optimizerState: Buffer.alloc(0),
        featureNorm: Buffer.alloc(0),
        replayBuffer: Buffer.alloc(0),
        teachingMoments: Buffer.alloc(0),
        oodBlender: Buffer.alloc(0),
        uncertaintyWeights: Buffer.alloc(0),
      });
      // Archive everything (simulating an archHash mismatch).
      persistence.archiveAll();
      // Snapshot the prefix the warm-start should restore.
      const expectedPrefix: Float32Array[] = [];
      let j = 0;
      for (const buf of iterParamBuffers(oldNet)) {
        if (j >= WARM_START_BUFFER_COUNT) break;
        expectedPrefix.push(new Float32Array(buf));
        j += 1;
      }

      // Build a fresh "new arch" network and run warm-start.
      const newNet = createNetwork(() => 0.7);
      const result = tryWarmStartFromArchive(persistence, newNet);
      expect(result.warmStarted).toBe(true);
      expect(result.archivedRound).toBe(12345);
      expect(result.bytesCopied).toBeGreaterThan(0);

      // Verify the prefix matches bit-for-bit.
      let k = 0;
      for (const buf of iterParamBuffers(newNet)) {
        if (k >= WARM_START_BUFFER_COUNT) break;
        expect(buf.length).toBe(expectedPrefix[k].length);
        for (let m = 0; m < buf.length; m++) {
          expect(buf[m]).toBeCloseTo(expectedPrefix[k][m], 6);
        }
        k += 1;
      }
    } finally {
      persistence.close();
    }
  });

  it("leaves the Phase 3b heads at their fresh-init values", async () => {
    const dir = await tmpDir("nn-ws-newheads-");
    dirs.push(dir);
    const persistence = await LearningPersistence.open({
      dataDir: dir,
      archHashOverride: "old-arch-hash-bbbbb",
    });
    try {
      const oldNet = createNetwork();
      // Mutate ALL buffers so any leakage would be visible.
      for (const buf of iterParamBuffers(oldNet)) {
        for (let k = 0; k < buf.length; k++) buf[k] = 0.4242;
      }
      const flat = flattenParams(oldNet);
      persistence.saveSnapshot({
        round: 7,
        weights: Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength),
        optimizerState: Buffer.alloc(0),
        featureNorm: Buffer.alloc(0),
        replayBuffer: Buffer.alloc(0),
        teachingMoments: Buffer.alloc(0),
        oodBlender: Buffer.alloc(0),
        uncertaintyWeights: Buffer.alloc(0),
      });
      persistence.archiveAll();

      const newNet = createNetwork(() => 0.31);
      // Snapshot the Phase-3b head buffers BEFORE warm-start.
      const phase3bHeadsBefore: Float32Array[] = [];
      let j = 0;
      for (const buf of iterParamBuffers(newNet)) {
        if (j >= WARM_START_BUFFER_COUNT) {
          phase3bHeadsBefore.push(new Float32Array(buf));
        }
        j += 1;
      }
      const result = tryWarmStartFromArchive(persistence, newNet);
      expect(result.warmStarted).toBe(true);
      // Snapshot AFTER and compare.
      let k = 0;
      let phase3bIdx = 0;
      for (const buf of iterParamBuffers(newNet)) {
        if (k >= WARM_START_BUFFER_COUNT) {
          const before = phase3bHeadsBefore[phase3bIdx];
          for (let m = 0; m < buf.length; m++) {
            expect(buf[m]).toBe(before[m]);
          }
          phase3bIdx += 1;
        }
        k += 1;
      }
    } finally {
      persistence.close();
    }
  });

  it("rejects archives with too-short flat-params buffers", async () => {
    const dir = await tmpDir("nn-ws-short-");
    dirs.push(dir);
    const persistence = await LearningPersistence.open({
      dataDir: dir,
      archHashOverride: "old-arch-hash-ccccc",
    });
    try {
      // Save a truncated snapshot.
      persistence.saveSnapshot({
        round: 1,
        weights: Buffer.alloc(16), // way too short
        optimizerState: Buffer.alloc(0),
        featureNorm: Buffer.alloc(0),
        replayBuffer: Buffer.alloc(0),
        teachingMoments: Buffer.alloc(0),
        oodBlender: Buffer.alloc(0),
        uncertaintyWeights: Buffer.alloc(0),
      });
      persistence.archiveAll();
      const net = createNetwork();
      const result = tryWarmStartFromArchive(persistence, net);
      expect(result.warmStarted).toBe(false);
      expect(result.reason).toMatch(/archived weights/);
    } finally {
      persistence.close();
    }
  });

  it("expected param count integrity check", () => {
    const net = createNetwork();
    const expectedTotal = paramCount(net);
    expect(expectedTotal).toBeGreaterThan(0);
    // Just sanity-check that WARM_START_BUFFER_COUNT is < the
    // current number of buffers (would mean we added new heads).
    let count = 0;
    for (const _ of iterParamBuffers(net)) count += 1;
    expect(count).toBeGreaterThan(WARM_START_BUFFER_COUNT);
  });

  it("Phase 3e.2 cross-version: a v2 archive's prefix warm-starts a v3 network", async () => {
    // The deliberate-wipe rollout path: 3e.1 wrote a SCHEMA_VERSION 2
    // snapshot; 3e.2 loads it, sees archHash mismatch, archives it,
    // and warm-starts the surviving 6-buffer prefix into a fresh v3
    // network. This test simulates that exact transition by stuffing
    // a synthetic v2 weights blob (matching CURRENT featureDim — the
    // realistic case for a freshly-deployed 3e.1 → 3e.2 upgrade)
    // into the archive and asserting the warm-start does the right
    // thing.
    const dir = await tmpDir("nn-ws-v2-to-v3-");
    dirs.push(dir);
    const persistence = await LearningPersistence.open({
      dataDir: dir,
      archHashOverride: "v2-pretend-arch",
    });
    try {
      // Build a synthetic flat-params blob matching the CURRENT v3
      // network shape. The point of the test isn't to validate
      // cross-FEATURE_DIM safety (the docstring already calls out
      // that featureDim variability within v2 is handled by the
      // byte-length guard); it's to validate that the version-gate
      // accepts a v2 archive AND the prefix copy lands correctly.
      const v2Net = createNetwork(() => 0.42); // deterministic content
      const v2Flat = flattenParams(v2Net);
      // Fill the prefix with a recognisable pattern so we can verify
      // it landed in the v3 net post-warm-start.
      let cursor = 0;
      let i = 0;
      for (const buf of iterParamBuffers(v2Net)) {
        if (i >= WARM_START_BUFFER_COUNT) break;
        for (let k = 0; k < buf.length; k++) {
          v2Flat[cursor + k] = (i + 1) * 0.01 + k * 0.0001;
        }
        cursor += buf.length;
        i += 1;
      }
      const v2WeightsBuf = Buffer.from(v2Flat.buffer, v2Flat.byteOffset, v2Flat.byteLength);
      // Save the synthetic snapshot then archive (warmStart reads
      // from the archive table). saveSnapshot stamps current archHash
      // override; archiveAll moves it to nn_snapshots_archived.
      persistence.saveSnapshot({
        round: 100,
        weights: v2WeightsBuf,
        optimizerState: Buffer.alloc(0),
        featureNorm: Buffer.alloc(0),
        replayBuffer: Buffer.alloc(0),
        teachingMoments: Buffer.alloc(0),
        oodBlender: Buffer.alloc(0),
        uncertaintyWeights: Buffer.alloc(0),
      });
      persistence.archiveAll();

      // Construct a fresh "v3" network with random init.
      const v3Net = createNetwork(() => 0.99);
      // Capture pre-warm-start filmGen + tail (these MUST stay at
      // their fresh-init values post-warm-start).
      const filmGenBefore = new Float32Array(v3Net.filmGen.W);
      const pairLogitBefore = new Float32Array(v3Net.pairLogitHead.W);

      const result = tryWarmStartFromArchive(persistence, v3Net);
      expect(result.warmStarted).toBe(true);
      expect(result.archivedRound).toBe(100);
      expect(result.bytesCopied).toBeGreaterThan(0);

      // The first 6 buffers must match the pattern we stuffed into
      // the v2 archive. iterParamBuffers yields trunk[0].W, trunk[0].b,
      // trunk[1].W, trunk[1].b, priceClassHead.W, priceClassHead.b.
      let j = 0;
      for (const buf of iterParamBuffers(v3Net)) {
        if (j >= WARM_START_BUFFER_COUNT) break;
        for (let k = 0; k < buf.length; k++) {
          expect(buf[k]).toBeCloseTo((j + 1) * 0.01 + k * 0.0001, 5);
        }
        j += 1;
      }
      // filmGen and pairLogitHead (post-prefix) must NOT have been touched.
      expect(Array.from(v3Net.filmGen.W)).toEqual(Array.from(filmGenBefore));
      expect(Array.from(v3Net.pairLogitHead.W)).toEqual(Array.from(pairLogitBefore));
    } finally {
      persistence.close();
    }
  });
});
