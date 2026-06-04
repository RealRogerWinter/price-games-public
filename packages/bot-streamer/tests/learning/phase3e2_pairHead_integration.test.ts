/**
 * Phase 3e.2 — end-to-end coverage of the new pair-head paths.
 *
 * The unit-level `mlp.test.ts > forwardPairLogit / backwardPairLogit`
 * suite covers a synthetic forward+backward in isolation. This file
 * covers WorkerCore-level dispatch:
 *
 *   1. predict({...req, pairProducts}) actually exercises the new
 *      `predictPairAIsCorrectProb` → `predictFromPriceClassHead` ×2
 *      → `pairLogitScalarFeatures` → `forwardPairLogit` chain.
 *   2. update({revealedSamples: [a, b], primaryMode: "comparison"})
 *      actually dispatches `computeRoundCoherentPairLogit` and
 *      records a pairLogit per-task loss.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerCore } from "../../src/learning/workerCore";
import type { GameMode } from "@price-game/shared";
import { TASK_INDEX } from "../../src/learning/uncertaintyWeighting";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Phase 3e.2 — pair-head end-to-end dispatch", () => {
  const PROD_A = { id: 1, title: "Widget A Pro", category: "Electronics" };
  const PROD_B = { id: 2, title: "Widget B Mini", category: "Electronics" };

  it("predict({pairProducts}) returns a finite pairAIsCorrectProb after warmup", async () => {
    const dir = await tmpDir("nn-3e2-pair-predict-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      rng: lcg(401),
    });
    await core.init();

    // Issue a comparison-style predict with both products.
    const res = core.predict({
      roundId: "pair-predict-1",
      mode: "comparison" as GameMode,
      product: PROD_A,
      pairProducts: [PROD_A, PROD_B],
    });

    expect(res.pairAIsCorrectProb).toBeDefined();
    expect(Number.isFinite(res.pairAIsCorrectProb!)).toBe(true);
    // Sigmoid output is in (0, 1).
    expect(res.pairAIsCorrectProb!).toBeGreaterThan(0);
    expect(res.pairAIsCorrectProb!).toBeLessThan(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("update({revealedSamples: [a, b], primaryMode: comparison}) records pairLogit per-task loss", async () => {
    const dir = await tmpDir("nn-3e2-pair-update-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      rng: lcg(402),
    });
    await core.init();

    const result = core.update({
      roundId: "pair-update-1",
      revealedSamples: [
        { product: PROD_A, actualCents: 4000, mode: "comparison" as GameMode },
        { product: PROD_B, actualCents: 1500, mode: "comparison" as GameMode },
      ],
      primaryMode: "comparison" as GameMode,
      outcome: "correct",
    });

    expect(result.ok).toBe(true);
    expect(result.nanRollback).toBe(false);
    expect(result.perTaskLosses).toBeDefined();
    // pairLogit loss should be non-zero for a comparison round with
    // exactly 2 revealed samples — confirms `computeRoundCoherentPairLogit`
    // dispatched. priceClass + logPrice will also be nonzero because
    // every per-sample step records them.
    expect(result.perTaskLosses![TASK_INDEX.pairLogit]).toBeGreaterThan(0);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("higher-lower update with pairProducts also drives the pair-head training path", async () => {
    // Bonus check: higher-lower routes 2 revealed samples through the
    // same `computeRoundCoherentPairLogit` (it gates only on
    // `revealedSamples.length === 2`, not on mode). Asserts the
    // pairLogit head learns from both binary-mode signals.
    const dir = await tmpDir("nn-3e2-hl-pair-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      rng: lcg(403),
    });
    await core.init();

    const result = core.update({
      roundId: "hl-pair-1",
      revealedSamples: [
        { product: PROD_A, actualCents: 4000, mode: "higher-lower" as GameMode },
        { product: PROD_B, actualCents: 2500, mode: "higher-lower" as GameMode },
      ],
      primaryMode: "higher-lower" as GameMode,
      outcome: "correct",
    });

    expect(result.ok).toBe(true);
    expect(result.perTaskLosses![TASK_INDEX.pairLogit]).toBeGreaterThan(0);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
