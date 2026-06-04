/**
 * Operational-guard tests for WorkerCore — NaN-storm freeze + thaw,
 * disk-pressure thresholds, snapshot-age + DB-write-latency telemetry,
 * and resetLearning(). Driven directly against WorkerCore methods so
 * we can corrupt internals deterministically without the full bridge.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { WorkerCore, SNAPSHOT_MAE_BASELINE_WINDOW, median } from "../../src/learning/workerCore";
import type { GameMode } from "@price-game/shared";

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

const MODE: GameMode = "classic";
function sample(id: number): { product: { id: number; title: string; category: string }; actualCents: number; mode: GameMode } {
  return {
    product: { id, title: `P${id}`, category: "Books" },
    actualCents: 500 + id,
    mode: MODE,
  };
}

describe("median (snapshot-gate baseline helper)", () => {
  // Phase 3e.0: tiny unit-test pass on the median helper that backs
  // the snapshot regression gate's median-of-N anchor. Caller is
  // expected to gate on length>0 — empty input → NaN by design.
  it("returns NaN for empty input", () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it("single element returns the element itself", () => {
    expect(median([42])).toBe(42);
  });

  it("odd-length picks the middle element after sort", () => {
    expect(median([1005, 1000, 1010])).toBe(1005);
    expect(median([3, 1, 2, 5, 4])).toBe(3);
  });

  it("even-length averages the two middle elements after sort", () => {
    expect(median([1000, 1010, 990, 1005])).toBe(1002.5);
    expect(median([2, 4])).toBe(3);
  });

  it("at exactly SNAPSHOT_MAE_BASELINE_WINDOW elements (=5) returns sorted midpoint", () => {
    expect(median([1010, 990, 1005, 1000, 1150])).toBe(1005);
  });

  it("preserves the input array (sort is on a copy)", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("handles duplicates", () => {
    expect(median([5, 5, 5])).toBe(5);
    expect(median([5, 5, 5, 5])).toBe(5);
  });
});

describe("WorkerCore guards", () => {
  it("NaN storm: real >10-rollback transition flips frozen", async () => {
    const dir = await tmpDir("nn-nan-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(1),
    });
    await core.init();
    core.update({ roundId: "warm", revealedSamples: [sample(0)], primaryMode: MODE, outcome: "correct" });
    expect(core.isFrozen()).toBe(false);

    // To deterministically trigger the NaN guard we corrupt the
    // optimizer's moment buffer before each update. The next Adam
    // step's running-average update produces a NaN value, which
    // propagates into the params and the post-step assertFinite
    // catches it. Rollback restores from the in-memory snapshot
    // (which is clean — captured at the start of update). The
    // rolling 1-hour window of NaN-rollback epochs grows; >10
    // entries flips frozen.
    // To deterministically drive the freeze threshold across the
    // current and future network shapes, poke `nanRollbackEpochs`
    // directly to push the rolling 1-hour window above
    // NAN_STORM_THRESHOLD (=10). The Adam-state poisoning approach
    // we used pre-2026-05 became flaky as the network grew (the
    // larger priceClassHead introduced finite-update paths the
    // poison sometimes bypassed). The "thaw" test below exercises
    // the same internal mutation to verify the inverse transition.
    type Internal = { nanRollbackEpochs: number[]; frozen: boolean };
    const internal = core as unknown as Internal;
    const now = Date.now();
    for (let i = 0; i < 11; i++) internal.nanRollbackEpochs.push(now);
    // One real update cycles through the freeze re-evaluation block
    // (the worker only checks the threshold inside the post-rollback
    // window-prune path, so we need a step to flip frozen).
    type AdamInternal = { moments: Float32Array[]; secondMoments: Float32Array[] };
    const adam = core.optimizer as unknown as AdamInternal;
    adam.moments[0][0] = Number.NaN;
    adam.secondMoments[0][0] = Number.NaN;
    core.update({
      roundId: "trip",
      revealedSamples: [sample(999)],
      primaryMode: MODE,
      outcome: "incorrect",
    });
    expect(core.isFrozen()).toBe(true);
    expect(core.health().degraded).toBe("nan_storm");

    // Once frozen, subsequent update() calls short-circuit.
    const frozenResult = core.update({
      roundId: "post-storm",
      revealedSamples: [sample(999)],
      primaryMode: MODE,
      outcome: "correct",
    });
    expect(frozenResult.loss).toBe(0);
    expect(frozenResult.nanRollback).toBe(false);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("NaN storm: thaw transition resets frozen once the window clears", async () => {
    const dir = await tmpDir("nn-thaw-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(2),
    });
    await core.init();
    type Internal = { nanRollbackEpochs: number[]; frozen: boolean };
    const internal = core as unknown as Internal;
    // Force-freeze the model with a stale-but-still-in-window epoch ring.
    internal.frozen = true;
    const now = Date.now();
    for (let i = 0; i < 11; i++) internal.nanRollbackEpochs.push(now - 30 * 60_000);
    // After enough wall-clock time passes, the entries fall out of the
    // 1-hour window. We can't actually wait an hour in a test — instead
    // backdate the entries so they're already older than the window.
    internal.nanRollbackEpochs.length = 0;
    for (let i = 0; i < 11; i++) internal.nanRollbackEpochs.push(now - 2 * 60 * 60_000);
    // Run an update — frozen path re-evaluates the window and thaws.
    core.update({ roundId: "thaw", revealedSamples: [sample(50)], primaryMode: MODE, outcome: "correct" });
    expect(core.isFrozen()).toBe(false);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("snapshotAgeMs is 0 before the first snapshot, > 0 after", async () => {
    const dir = await tmpDir("nn-snap-age-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(2),
    });
    await core.init();
    expect(core.snapshotAgeMs()).toBe(0);
    core.snapshotNow();
    expect(core.snapshotAgeMs()).toBeGreaterThanOrEqual(0);
    expect(core.snapshotAgeMs()).toBeLessThan(1_000);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("dbWriteLatencyP95Ms records snapshot durations", async () => {
    const dir = await tmpDir("nn-db-lat-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(3),
    });
    await core.init();
    expect(core.dbWriteLatencyP95Ms()).toBe(0);
    core.snapshotNow();
    core.snapshotNow();
    expect(core.dbWriteLatencyP95Ms()).toBeGreaterThanOrEqual(0);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("disk pressure ≥0.9 skips snapshots", async () => {
    const dir = await tmpDir("nn-disk-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(4),
    });
    await core.init();
    type Internal = { lastDiskUsedRatio: number };
    (core as unknown as Internal).lastDiskUsedRatio = 0.95;
    core.snapshotNow();
    // skipped → lastSnapshotRound stays at 0
    expect(core.lastSnapshotRound).toBe(0);
    expect(core.snapshotAgeMs()).toBe(0);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resetLearning archives + zeros every mutable structure", async () => {
    const dir = await tmpDir("nn-reset-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(5),
    });
    await core.init();
    for (let r = 0; r < 5; r++) {
      core.update({ roundId: `pre-${r}`, revealedSamples: [sample(r)], primaryMode: MODE, outcome: "correct" });
    }
    expect(core.round).toBe(5);
    expect(core.replay.size()).toBeGreaterThan(0);

    await core.resetLearning();
    expect(core.round).toBe(0);
    expect(core.replay.size()).toBe(0);
    expect(core.lastSnapshotAt).toBe(0);
    expect(core.nanRollbacks).toBe(0);
    expect(core.isFrozen()).toBe(false);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("health() resolves degraded='nan_storm' while frozen", async () => {
    const dir = await tmpDir("nn-frozen-");
    const core = new WorkerCore({ dataDir: dir, rng: lcg(6) });
    await core.init();
    type Internal = { frozen: boolean };
    (core as unknown as Internal).frozen = true;
    expect(core.health().degraded).toBe("nan_storm");
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("health() resolves degraded='disk' when pressure ≥ 0.8", async () => {
    const dir = await tmpDir("nn-disk-h-");
    const core = new WorkerCore({ dataDir: dir, rng: lcg(7) });
    await core.init();
    type Internal = { lastDiskUsedRatio: number };
    (core as unknown as Internal).lastDiskUsedRatio = 0.85;
    expect(core.health().degraded).toBe("disk");
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("health() honours external degraded override (worker_dead from bridge)", async () => {
    const dir = await tmpDir("nn-ext-degrad-");
    const core = new WorkerCore({ dataDir: dir, rng: lcg(8) });
    await core.init();
    type Internal = { frozen: boolean };
    (core as unknown as Internal).frozen = true;
    // Worker is frozen, but the bridge supplies an explicit override.
    expect(core.health("worker_dead").degraded).toBe("worker_dead");
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("snapshot regression gate: refuses to write on a catastrophic regression (>1.2× median of last-N MAEs)", async () => {
    // Regression test for the round-530 divergence: the snapshot path
    // used to write any new weights regardless of how badly they
    // performed on golden eval, so once the loss-bug + loose-clip combo
    // pushed the model into a NaN regime the corrupt weights were
    // happily persisted and the bot never recovered. The gate here is
    // load-bearing for "the next time something goes wrong, we can
    // restart and return to a working model".
    //
    // Phase 3e.0: tightened from 2.0× → 1.2× and pivoted from
    // "single last MAE" to "median of last 5 MAEs". The catastrophic-
    // regression scenario tested here ($9990 MAE vs O($1k) baseline)
    // trips both the old and new gate; a separate test below covers
    // the median-vs-single-anchor distinction directly.
    const dir = await tmpDir("nn-regression-gate-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(101),
    });
    await core.init();

    // Seed a trivial golden set so the gate has something to score.
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
      { product: { id: 2, title: "G2", category: "Books" }, mode: "classic", actualCents: 1500 },
    );

    // The OOD blender dampens the NN's μ by tanh(n/20) where n is
    // observations in the category. At n=0 the heuristic is the only
    // signal — synthetic priceHead poisoning has no effect. Seed every
    // bucket with enough observations to get a strong NN weight, since
    // categoryBucket("Books") is an FNV-1a hash we don't want to
    // hardcode.
    type WithOod = { ood: { observe: (catId: number, cents: number) => void } };
    for (let cat = 0; cat < 30; cat++) {
      for (let i = 0; i < 60; i++) {
        (core as unknown as WithOod).ood.observe(cat, 1000);
      }
    }

    // First snapshot: anchors the baseline MAE.
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(0);
    expect(core.lastAcceptedSnapshotRound()).toBe(0);
    const baselineMAE = core.lastAcceptedSnapshotMAE();
    expect(baselineMAE).not.toBeNull();

    // Inject a regression: poison the priceClassHead so its argmax
    // collapses to the LAST catalog class (~$9999). Golden actuals
    // are $5 / $15 → MAE → ~$9990 per entry, ≫ 2× any baseline.
    // Targeting the highest class is the most robust: regardless of
    // what baseline MAE the fresh model produced, $9990 dominates.
    type Internal = { network: { priceClassHead: { b: Float32Array } } };
    const internal = core as unknown as Internal;
    const origBias = new Float32Array(internal.network.priceClassHead.b);
    const lastIdx = core.priceCatalog.K - 1;
    internal.network.priceClassHead.b.fill(-100);
    internal.network.priceClassHead.b[lastIdx] = 100;

    core.round = 100;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(0); // gate refused
    expect(core.health().goldenRegressionRollbacks).toBe(1);

    // Heal the head, snapshot again — should be accepted.
    internal.network.priceClassHead.b.set(origBias);
    core.round = 200;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(200);
    expect(core.health().goldenRegressionRollbacks).toBe(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("snapshot regression gate: refuses to write when predict() returns NaN", async () => {
    // The golden-MAE NaN-mask hardening means a fully-diverged model
    // produces MAE = Infinity; the gate must reject Infinity outright
    // rather than treating it as a numeric comparison no-op.
    const dir = await tmpDir("nn-regression-nan-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(102),
    });
    await core.init();
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
    );
    core.snapshotNow();
    const baselineRound = core.lastSnapshotRound;

    // Poison: fill priceClassHead with NaN so forwardLinear → NaN logits;
    // predictFromPriceClassHead detects the non-finite and propagates NaN.
    type Internal = { network: { priceClassHead: { W: Float32Array } } };
    (core as unknown as Internal).network.priceClassHead.W.fill(Number.NaN);
    core.round = 50;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(baselineRound); // refused
    expect(core.health().goldenRegressionRollbacks).toBe(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("snapshot regression gate: post-restart load seeds the baseline", async () => {
    // Code-reviewer blocker #1: prior to this fix, acceptedSnapshotMAE
    // was null after init(), so the first snapshot post-restart was
    // ALWAYS accepted regardless of how badly the loaded weights
    // performed. That defeats the load-bearing recovery property.
    // Fix: init() recomputes golden MAE and seeds the baseline.
    const dir = await tmpDir("nn-gate-restart-");
    type WithOod = { ood: { observe: (catId: number, cents: number) => void } };

    // Write a real golden-eval.json so init() picks it up. The test
    // mutates the in-memory set in other tests, but this scenario
    // specifically exercises the load-from-disk path.
    await fs.writeFile(
      path.join(dir, "golden-eval.json"),
      JSON.stringify({
        version: 1,
        computedAt: new Date().toISOString(),
        entries: [
          { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
          { product: { id: 2, title: "G2", category: "Books" }, mode: "classic", actualCents: 1500 },
        ],
      }),
    );

    // Run 1: train, snapshot, shut down.
    {
      const core = new WorkerCore({
        dataDir: dir,
        snapshotInterval: 1_000_000,
        stepsPerRound: 1,
        batchSize: 4,
        replayCapacity: 8,
        rng: lcg(201),
      });
      await core.init();
      expect(core.goldenEval.entries.length).toBe(2);
      for (let cat = 0; cat < 30; cat++) {
        for (let i = 0; i < 60; i++) (core as unknown as WithOod).ood.observe(cat, 1000);
      }
      core.snapshotNow();
      expect(core.lastAcceptedSnapshotMAE()).not.toBeNull();
      await core.shutdown();
    }

    // Run 2: re-init, baseline should be seeded from the loaded
    // weights' golden eval — without the fix, this is null.
    const core2 = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(202),
    });
    await core2.init();
    expect(core2.goldenEval.entries.length).toBe(2);
    expect(core2.lastAcceptedSnapshotMAE()).not.toBeNull();
    const baseline = core2.lastAcceptedSnapshotMAE() as number;

    // Re-seed OOD blender for run 2 (it persists, but be explicit).
    for (let cat = 0; cat < 30; cat++) {
      for (let i = 0; i < 60; i++) (core2 as unknown as WithOod).ood.observe(cat, 1000);
    }

    // Poison + attempt snapshot — must be refused even though this is
    // the first snapshotNow() call of *this* core instance.
    type Internal = { network: { priceClassHead: { b: Float32Array } } };
    const internal2 = core2 as unknown as Internal;
    const lastIdx2 = core2.priceCatalog.K - 1;
    internal2.network.priceClassHead.b.fill(-100);
    internal2.network.priceClassHead.b[lastIdx2] = 100;
    core2.round = 50;
    core2.snapshotNow();
    expect(core2.lastSnapshotRound).toBeLessThan(50); // refused (still at loaded round)
    expect(core2.health().goldenRegressionRollbacks).toBe(1);
    expect(core2.lastAcceptedSnapshotMAE()).toBe(baseline);

    await core2.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("snapshot regression gate: refused snapshot does not busy-loop the eval", async () => {
    // Code-reviewer blocker #2: prior to the fix, a refused snapshot
    // left pendingSnapshot=true so the snapshot scheduler retried the
    // full golden-MAE eval every round. The retry should be rate-
    // limited to once per snapshotInterval. After refusal,
    // pendingSnapshot must be cleared.
    const dir = await tmpDir("nn-gate-busy-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 100,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(203),
    });
    await core.init();
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    type WithOod = { ood: { observe: (catId: number, cents: number) => void } };
    // Three entries spanning the catalog so poisoning toward the
    // highest catalog class produces a uniformly-large MAE delta
    // regardless of where the random fresh-init argmax lands for
    // baseline. With one entry the baseline MAE is too noisy to
    // reliably trigger 2× threshold.
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
      { product: { id: 2, title: "G2", category: "Books" }, mode: "classic", actualCents: 1500 },
      { product: { id: 3, title: "G3", category: "Books" }, mode: "classic", actualCents: 5000 },
    );
    for (let cat = 0; cat < 30; cat++) {
      for (let i = 0; i < 60; i++) (core as unknown as WithOod).ood.observe(cat, 1000);
    }
    // Run a few real updates so the baseline snapshot reflects a model
    // that's at least seen training, not the random-init garbage that
    // makes baseline MAE swing wildly.
    for (let r = 0; r < 5; r++) {
      core.update({
        roundId: `warm-${r}`,
        revealedSamples: [
          { product: { id: 100 + r, title: `P${r}`, category: "Books" }, actualCents: 1000, mode: "classic" },
        ],
        primaryMode: "classic",
        outcome: "correct",
      });
    }
    core.snapshotNow();

    // Poison + attempt — should refuse and clear pendingSnapshot.
    type Internal = { network: { priceClassHead: { b: Float32Array } }; pendingSnapshot: boolean };
    const internal = core as unknown as Internal;
    const lastIdx = core.priceCatalog.K - 1;
    internal.network.priceClassHead.b.fill(-100);
    internal.network.priceClassHead.b[lastIdx] = 100;
    internal.pendingSnapshot = true;
    core.round = 200;
    core.snapshotNow();
    expect(internal.pendingSnapshot).toBe(false);
    expect(core.health().goldenRegressionRollbacks).toBe(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

it("snapshot regression gate: acceptedSnapshotMAE advances on subsequent accepted snapshots", async () => {
    // Code-reviewer should-fix: previously untested. Verifies the
    // baseline rolls forward — without this, every gate decision would
    // forever compare against the very first snapshot's MAE, which
    // means a slow-but-real improvement could be misread as healthy
    // and a slow-but-real degradation could slip past for too long.
    const dir = await tmpDir("nn-gate-advance-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(205),
    });
    await core.init();
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
    );
    type WithOod = { ood: { observe: (catId: number, cents: number) => void } };
    for (let cat = 0; cat < 30; cat++) {
      for (let i = 0; i < 60; i++) (core as unknown as WithOod).ood.observe(cat, 1000);
    }
    core.snapshotNow();
    const m1 = core.lastAcceptedSnapshotMAE() as number;

    // Find the current argmax then nudge a NEIGHBOURING class up by
    // just enough to win — small MAE delta keeps us under the
    // regression gate's 2× threshold. Pre-Phase-3a this test bumped
    // a fixed index that happened to be a neighbour under the old
    // feature space; the engineered-feature change shifted the
    // argmax so we look it up dynamically now.
    type Internal = {
      network: { priceClassHead: { b: Float32Array } };
      priceCatalog: { prices: ReadonlyArray<number> };
      predict: (req: import("../../src/learning/types").PredictReq) => import("../../src/learning/types").PredictRes;
    };
    const internal = core as unknown as Internal;
    const probeRes = internal.predict({
      roundId: "probe",
      mode: "classic",
      product: { id: 1, title: "G1", category: "Books", description: "", imageUrl: "" },
    });
    const argmaxIdx = internal.priceCatalog.prices.indexOf(probeRes.predictedCents);
    const nbrIdx = argmaxIdx + 1 < internal.priceCatalog.prices.length
      ? argmaxIdx + 1
      : argmaxIdx - 1;
    internal.network.priceClassHead.b[nbrIdx] += 1.0;
    core.round = 50;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(50);
    const m2 = core.lastAcceptedSnapshotMAE() as number;
    expect(m2).not.toBe(m1); // baseline rolled forward
  }, 30_000);

  it("snapshot regression gate: median-of-N anchor survives a single bad-but-just-accepted MAE (Phase 3e.0 end-to-end)", async () => {
    // Phase 3e.0 load-bearing test: with the previous "single last MAE"
    // anchor, one bad-but-under-2× snapshot poisoned the baseline
    // forever — the gate would then accept ever-larger MAEs because
    // each new bad snapshot inflated the next threshold. The median-
    // of-5 anchor fixes this: a single noisy outlier shifts the
    // median by at most one slot, so the gate's threshold can't
    // drift unboundedly.
    //
    // We exercise the gate end-to-end (snapshotNow → recomputeGoldenMAE
    // → ring update → accept/reject) by stubbing recomputeGoldenMAE
    // with scripted MAEs. The catastrophic-rejection test above
    // already covers the path that reads MAE from the live network;
    // this one isolates the median-vs-single-anchor distinction
    // without needing to coax an exact MAE out of head perturbations.
    const dir = await tmpDir("nn-gate-median-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(207),
    });
    await core.init();
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    // Seed ONE entry so evaluateMAE returns a number (not null) and
    // the gate is active. The actual value is irrelevant — we override
    // recomputeGoldenMAE below.
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
    );

    // Scripted MAEs: 5 healthy baselines (~1000), then one bad-but-
    // under-1.2x-of-median (1150 ≤ 1.2×1000=1200), then one that's
    // bad-relative-to-the-original-median (1300, > 1.2×1000=1200) but
    // would have been within 1.2× of a single-anchor that just
    // absorbed the 1150. Single-anchor (pre-3e.0) gate would have
    // accepted 1300 because 1300 ≤ 1.2×1150=1380. Median-of-5 gate
    // must reject because median([1000, 1010, 990, 1005, 1150])=1005
    // and 1300 > 1.2×1005=1206.
    const scripted = [1000, 1010, 990, 1005, 1000, 1150, 1300];
    let cursor = 0;
    type WithStub = { recomputeGoldenMAE: () => number | null; goldenMAE: number | null };
    (core as unknown as WithStub).recomputeGoldenMAE = function () {
      const v = scripted[cursor++];
      (this as unknown as WithStub).goldenMAE = v ?? null;
      return v ?? null;
    };

    // Five healthy snapshots fill the ring.
    for (let r = 0; r < 5; r++) {
      core.round = r * 100 + 100;
      core.snapshotNow();
    }
    type Internal = { recentAcceptedMAEs: number[] };
    expect((core as unknown as Internal).recentAcceptedMAEs).toEqual([1000, 1010, 990, 1005, 1000]);
    expect(core.health().goldenRegressionRollbacks).toBe(0);
    expect(core.lastSnapshotRound).toBe(500);

    // Sixth snapshot (MAE=1150). Median([1000,1010,990,1005,1000])=1000;
    // 1.2× = 1200. 1150 ≤ 1200 → accepted.
    core.round = 600;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(600);
    expect(core.health().goldenRegressionRollbacks).toBe(0);
    // Ring rolled forward; oldest (1000) dropped, 1150 appended.
    expect((core as unknown as Internal).recentAcceptedMAEs).toEqual([1010, 990, 1005, 1000, 1150]);

    // Seventh snapshot (MAE=1300). Median([1010,990,1005,1000,1150])=1005;
    // 1.2× = 1206. 1300 > 1206 → REJECTED.
    // Pre-3e.0 single-anchor gate would have accepted 1300 because
    // 1.2× the just-accepted 1150 = 1380, and 1300 ≤ 1380. The
    // median's resistance to single-step inflation is exactly the
    // property under test.
    core.round = 700;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(600); // still at last accepted
    expect(core.health().goldenRegressionRollbacks).toBe(1);
    expect((core as unknown as Internal).recentAcceptedMAEs).toEqual([1010, 990, 1005, 1000, 1150]);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("snapshot regression gate: ring caps at SNAPSHOT_MAE_BASELINE_WINDOW (=5) entries", async () => {
    // Verifies the FIFO discipline — accepting a 6th snapshot drops
    // the oldest. Without this, a long-running streamer would slowly
    // dilute its baseline with stale measurements.
    const dir = await tmpDir("nn-gate-ringcap-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(208),
    });
    await core.init();
    type WithGolden = {
      goldenEval: { entries: Array<{ product: { id: number; title: string; category: string }; mode: GameMode; actualCents: number }> };
    };
    type WithOod = { ood: { observe: (catId: number, cents: number) => void } };
    (core as unknown as WithGolden).goldenEval.entries.push(
      { product: { id: 1, title: "G1", category: "Books" }, mode: "classic", actualCents: 500 },
    );
    for (let cat = 0; cat < 30; cat++) {
      for (let i = 0; i < 60; i++) (core as unknown as WithOod).ood.observe(cat, 1000);
    }
    type Internal = { recentAcceptedMAEs: number[] };
    const internal = core as unknown as Internal;
    for (let r = 0; r < 7; r++) {
      core.round = r * 100;
      core.snapshotNow();
    }
    // Ring should hold the last SNAPSHOT_MAE_BASELINE_WINDOW accepts
    // at most (constant imported so a future bump doesn't silently
    // make this test pass without verifying the new bound).
    expect(internal.recentAcceptedMAEs.length).toBeLessThanOrEqual(SNAPSHOT_MAE_BASELINE_WINDOW);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("head-starvation watchdog: silent during warmup, flags zero-observation heads after warmup", async () => {
    // Phase 3e.0: bidding-mode rounds were unrouted for ~2,260 rounds
    // post-PR-#319 because of an MP placement bug, leaving pinballQ40Head
    // at random init the entire time. The watchdog catches this class
    // of failure: any registered head with zero observations after the
    // warmup window is surfaced via /healthz starvedTasks.
    const dir = await tmpDir("nn-starvation-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(206),
    });
    await core.init();

    // During warmup: even with zero observations, watchdog stays
    // quiet — bidding-style modes may not have rotated in yet.
    expect(core.round).toBe(0);
    expect(core.health().starvedTasks).toEqual([]);
    expect(core.health().perTaskObservations.length).toBeGreaterThan(0);

    // Simulate a bidding-only deficit: feed 305 classic rounds. Past
    // the warmup gate (300 rounds) the watchdog should report
    // pinballQ40 (and any other non-classic head) as starved. The
    // exact set depends on which heads classic exercises — which is
    // the whole point of the watchdog: surface what's NOT being
    // trained.
    for (let r = 0; r < 305; r++) {
      core.update({
        roundId: `r-${r}`,
        revealedSamples: [
          { product: { id: r + 1, title: `P${r}`, category: "Books" }, actualCents: 1000 + r, mode: "classic" },
        ],
        primaryMode: "classic",
        outcome: "correct",
      });
    }
    expect(core.round).toBe(305);
    const starved = core.health().starvedTasks;
    // pinballQ40 is bidding-only, so classic-only training MUST leave
    // it starved.
    expect(starved).toContain("pinballQ40");
    // pairLogit fires only on comparison rounds, so it should also be
    // starved after pure-classic training.
    expect(starved).toContain("pairLogit");

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("head-starvation watchdog: warmup gate is exclusive of HEAD_STARVATION_WARMUP_ROUNDS", async () => {
    // Sanity check on the warmup boundary. With round < 300 the
    // watchdog must stay silent even if heads have 0 observations;
    // the moment round >= 300 the diagnosis surfaces. This test
    // would have caught an off-by-one where the gate fired one
    // round too early or too late.
    const dir = await tmpDir("nn-starvation-boundary-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(209),
    });
    await core.init();
    // No update() calls → all task counts stay at 0.
    core.round = 299;
    expect(core.health().starvedTasks).toEqual([]);
    core.round = 300;
    // At round=300 the gate flips on; pre-3e.0 every head was
    // starved at this point because no update() ever ran.
    expect(core.health().starvedTasks.length).toBeGreaterThan(0);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("snapshot regression gate: empty golden set is a no-op (no gating)", async () => {
    // When goldenEval has no entries, evaluateMAE returns null — the
    // gate must not block, because there's no signal to gate on.
    const dir = await tmpDir("nn-regression-empty-");
    const core = new WorkerCore({
      dataDir: dir,
      snapshotInterval: 1_000_000,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      rng: lcg(103),
    });
    await core.init();
    expect(core.goldenEval.entries.length).toBe(0);
    core.round = 50;
    core.snapshotNow();
    expect(core.lastSnapshotRound).toBe(50);
    expect(core.health().goldenRegressionRollbacks).toBe(0);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("divergence event: large finite grad fires the grad-norm branch", async () => {
    const dir = await tmpDir("nn-divergence-grad-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(11),
      // Phase 3e.3: disable AGC for divergence-rollback tests. AGC
      // would absorb the synthetic 1e7 grad explosion at the buffer
      // level, which is exactly its job — but those tests exist to
      // exercise the GLOBAL grad-norm rollback gate (the LAST safety
      // net). Disabling AGC keeps the test focused on its target.
      agcLambda: 0,
    });
    await core.init();
    // Warmup: get a sample into the replay buffer.
    core.update({
      roundId: "warm",
      revealedSamples: [sample(0)],
      primaryMode: MODE,
      outcome: "correct",
    });

    // Inject a huge value into trunk[0].W. The forward pass produces
    // enormous (but finite) activations; the backward pass yields a
    // grad norm well above DIVERGENCE_GRAD_NORM_THRESHOLD (1e5). The
    // existing param-NaN guard does NOT fire because no value is
    // non-finite — that's exactly the gap Phase 0 instruments.
    // Confirmed empirically: 1e8 produces a pre-clip norm of ~1e7,
    // safely above the threshold and well below the float32 cap.
    type NetInternal = { trunk: Array<{ W: Float32Array }> };
    const net = (core as unknown as { network: NetInternal }).network;
    net.trunk[0].W[0] = 1e8;

    core.update({
      roundId: "spike",
      revealedSamples: [sample(1)],
      primaryMode: MODE,
      outcome: "incorrect",
    });

    await core.shutdown();

    const event = await readDivergenceEvent(dir);
    expect(event).not.toBeNull();
    // Assert which branch fired: grad-norm path, not loss-non-finite.
    expect(event!.maxStepGradNormPreClip).toBeGreaterThan(1e5);
    expect(Number.isFinite(event!.maxStepGradNormPreClip)).toBe(true);
    expect(event!.stepLossNonFinite).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("rollback gate (P1): grad explosion above 1e5 triggers nanRollback", async () => {
    const dir = await tmpDir("nn-p1-grad-rb-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(31),
      // Phase 3e.3: disable AGC; this test exercises the global
      // grad-norm rollback gate, not AGC's per-buffer clipping.
      agcLambda: 0,
    });
    await core.init();
    core.update({ roundId: "warm", revealedSamples: [sample(0)], primaryMode: MODE, outcome: "correct" });
    expect(core.health().nanRollbacks).toBe(0);

    // Inject a finite-but-huge weight so the next backward yields a grad
    // norm well above DIVERGENCE_GRAD_NORM_THRESHOLD (1e5). With Phase 0
    // alone this would only emit a divergence_event; Phase 1 extends
    // the rollback gate to also trip on this signal.
    type NetInternal = { trunk: Array<{ W: Float32Array }> };
    const net = (core as unknown as { network: NetInternal }).network;
    net.trunk[0].W[0] = 1e8;

    const r = core.update({ roundId: "spike", revealedSamples: [sample(1)], primaryMode: MODE, outcome: "incorrect" });
    expect(r.nanRollback).toBe(true);
    expect(core.health().nanRollbacks).toBe(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("decayAnchorRound: resetLearning() resets to 0 so adaptiveEpsilon restarts decay", async () => {
    const dir = await tmpDir("nn-decay-anchor-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(35),
      epsilonFloorStart: 0.1,
      epsilonFloorEnd: 0.03,
      epsilonDecayRounds: 100,
    });
    await core.init();
    type CoreInternal = { round: number; decayAnchorRound: number };
    const internal = core as unknown as CoreInternal;
    internal.round = 100;
    const epsLate = core.adaptiveEpsilon(0.5, 0, "classic");
    // Reset clears round AND anchor — decay restarts from full-floor.
    await core.resetLearning();
    expect(internal.round).toBe(0);
    expect(internal.decayAnchorRound).toBe(0);
    const epsFresh = core.adaptiveEpsilon(0.5, 0, "classic");
    // Floor at round=0 is epsilonFloorStart (0.1); at round≥100 it's
    // epsilonFloorEnd (0.03). Fresh ε should be ≥ late-life ε.
    expect(epsFresh).toBeGreaterThanOrEqual(epsLate);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("divergence event: NaN grad fires the non-finite branch (no silent miss)", async () => {
    const dir = await tmpDir("nn-divergence-nan-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(13),
    });
    await core.init();
    core.update({
      roundId: "warm",
      revealedSamples: [sample(0)],
      primaryMode: MODE,
      outcome: "correct",
    });

    // Poke a single weight to NaN. Forward propagates NaN through the
    // trunk → softmax → CE, so the per-step totalLoss is NaN AND the
    // grad norm is NaN. With `>` comparison alone, the grad path would
    // silently miss; the post-review fix promotes non-finite to
    // worst-case (Infinity).
    type NetInternal = { trunk: Array<{ W: Float32Array }> };
    const net = (core as unknown as { network: NetInternal }).network;
    net.trunk[0].W[0] = Number.NaN;

    core.update({
      roundId: "nan",
      revealedSamples: [sample(2)],
      primaryMode: MODE,
      outcome: "incorrect",
    });

    await core.shutdown();

    const event = await readDivergenceEvent(dir);
    expect(event).not.toBeNull();
    // Both branches should observe non-finite values; assert the
    // recorded grad norm is Infinity (worst-case promotion) and the
    // loss-non-finite flag is set.
    expect(event!.maxStepGradNormPreClip).toBe(null);
    expect(event!.stepLossNonFinite).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("Phase 2 decode mask: predictedCents lies inside priceRangeCents", async () => {
    const dir = await tmpDir("nn-mask-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(41),
    });
    await core.init();
    // Without bounds, predict() can return any catalog price.
    type NetInternal = { priceClassHead: { b: Float32Array } };
    const net = (core as unknown as { network: NetInternal }).network;
    // Bias the head toward a high-price class so the unmasked argmax
    // would land out-of-range.
    net.priceClassHead.b[net.priceClassHead.b.length - 1] += 5;
    const productLite = {
      id: 1,
      title: "Test Product",
      category: "Electronics",
      description: "Description",
      imageUrl: "x.jpg",
    };
    // Phase 4: seed every OOD bucket so the cold-start prior blend
    // doesn't wash out the head signal — the test's invariant is
    // "decoder mask works regardless of OOD blend." Seeding 100
    // observations puts `tanh(n/20)` at ~1.0 (head dominates).
    type WithOod = { ood: { counts: Int32Array; observe: (catId: number, cents: number) => void } };
    const ood = (core as unknown as WithOod).ood;
    for (let c = 0; c < ood.counts.length; c++) {
      for (let i = 0; i < 100; i++) ood.observe(c, 5000);
    }
    // Tight slider: $5–$15 (500–1500 cents).
    const r = core.predict({
      roundId: "r1",
      mode: "classic",
      product: productLite,
      priceRangeCents: { min: 500, max: 1500 },
    });
    expect(r.predictedCents).toBeGreaterThanOrEqual(500);
    expect(r.predictedCents).toBeLessThanOrEqual(1500);
    // Sanity: without the bound the same trunk would predict outside
    // the range — confirm by re-running unmasked.
    const r2 = core.predict({
      roundId: "r2",
      mode: "classic",
      product: productLite,
    });
    expect(r2.predictedCents).toBeGreaterThan(1500);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("Phase 2 decode mask: degenerate (range outside catalog) matches unmasked prediction", async () => {
    // Reviewer (PR #311) caught that the original implementation
    // silently collapsed to class 0 ($0.49) on degenerate bounds —
    // because the masked all-zero probs argmax to 0. The fix
    // restores the unmasked snapshot when pSum=0; this test proves
    // the masked-and-fell-through prediction matches the bare
    // unmasked one bit-for-bit.
    const dir = await tmpDir("nn-mask-deg-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(43),
    });
    await core.init();
    type NetInternal = { priceClassHead: { b: Float32Array } };
    const net = (core as unknown as { network: NetInternal }).network;
    // Bias the head so the argmax is unambiguously the last class
    // (well outside the impossible range below).
    net.priceClassHead.b[net.priceClassHead.b.length - 1] += 5;
    // Phase 4: seed all OOD buckets so the prior blend doesn't
    // wash out the head — same rationale as the test above.
    type WithOod = { ood: { counts: Int32Array; observe: (catId: number, cents: number) => void } };
    const ood = (core as unknown as WithOod).ood;
    for (let c = 0; c < ood.counts.length; c++) {
      for (let i = 0; i < 100; i++) ood.observe(c, 5000);
    }
    const productLite = {
      id: 1,
      title: "Test Product",
      category: "Electronics",
      description: "Description",
      imageUrl: "x.jpg",
    };
    // Phase 3b: this test validates the priceClassHead's mask
    // fall-through. Phase 3b routes classic/closest/riser through
    // the squashed-regression head, which has its own well-defined
    // (and feasibility-by-construction) decode path — so use a
    // mode that still goes through priceClassHead to exercise the
    // mask fall-through that this test was written for.
    const masked = core.predict({
      roundId: "r1",
      mode: "market-basket",
      product: productLite,
      priceRangeCents: { min: 10_000_000, max: 20_000_000 },
    });
    const unmasked = core.predict({
      roundId: "r2",
      mode: "market-basket",
      product: productLite,
    });
    expect(masked.predictedCents).toBe(unmasked.predictedCents);
    // And NOT collapsed to class-0 ($0.49 in the default catalog).
    expect(masked.predictedCents).toBeGreaterThan(100);
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("Phase 4 OOD prior: cold-start prediction tracks the per-category mean, not random head signal", async () => {
    // Reviewer (PR #313) flagged the missing end-to-end test — unit
    // tests cover priorOverCatalog standalone and the seeded tests
    // cover the head-dominance path; nothing proved the prior
    // actually steers predict() on a cold-start category. This test
    // closes the gap: seed the OOD blender for category C with prices
    // around $50, then ask predict to predict for a NEW product whose
    // category hashes to C — without the blend, the random head would
    // produce arbitrary cents; with the blend, the prediction lands
    // near $50.
    const dir = await tmpDir("nn-ood-prior-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(73),
    });
    await core.init();
    // Seed every bucket with $50 (5000 cents) repeatedly so whichever
    // bucket the test product hashes to, the prior peaks at log(5000).
    type WithOod = { ood: { counts: Int32Array; observe: (catId: number, cents: number) => void } };
    const ood = (core as unknown as WithOod).ood;
    for (let c = 0; c < ood.counts.length; c++) {
      // 5 obs → wNN ≈ tanh(5/20) ≈ 0.24, prior dominates 76%.
      for (let i = 0; i < 5; i++) ood.observe(c, 5000);
    }
    const productLite = {
      id: 999,
      title: "Brand New Product Never Seen Before",
      category: "Garden",
      description: "Never seen.",
      imageUrl: "x.jpg",
    };
    const r = core.predict({
      roundId: "cold",
      mode: "classic",
      product: productLite,
    });
    // Predicted price should land within ~50% of the prior peak ($50).
    expect(r.predictedCents).toBeGreaterThan(2500); // $25
    expect(r.predictedCents).toBeLessThan(10000); // $100
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  // Phase 3d.1 — trunk[0].W column-49 (hasPairRole) zero-init migration.
  //
  // Pre-PR-#319 the trunk trained for 1500+ rounds with hasPairRole=0
  // exclusively, so column 49 of trunk[0].W never received gradient
  // (dW[h, 49] = dHidden[h] · 0 = 0). PR #319 began passing
  // hasPairRole=1, injecting a never-trained random projection into
  // every downstream activation → grad-explosion rollbacks. The
  // migration zero-initialises the column on first init after deploy
  // so the contribution `W[:, 49] · 1 = 0` matches the long-standing
  // `W[:, 49] · 0 = 0` and the ReLU boundary doesn't shift.

  it("hasPairRole zero-init migration: applies on fresh init (legacy detection condition holds)", async () => {
    const dir = await tmpDir("nn-hpr-migration-applies-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      snapshotInterval: 1_000_000,
      rng: lcg(31),
    });
    // Detection condition: optimizer.secondMoments[0] is all zero at
    // column 49. A fresh init satisfies this (AdamW.bind allocates
    // zeroed buffers), so init() should run the migration.
    await core.init();
    type NetInternal = { network: { trunk: Array<{ W: Float32Array; inDim: number; outDim: number }> } };
    const inner = core as unknown as NetInternal;
    const trunk0 = inner.network.trunk[0];
    const PAIR_ROLE_COL = 49;
    for (let h = 0; h < trunk0.outDim; h++) {
      expect(trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL]).toBe(0);
    }
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("hasPairRole zero-init migration: skipped when column has training history", async () => {
    const dir = await tmpDir("nn-hpr-migration-skipped-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      snapshotInterval: 1_000_000,
      rng: lcg(33),
    });
    await core.init();
    type NetInternal = {
      network: { trunk: Array<{ W: Float32Array; inDim: number; outDim: number }> };
      optimizer: { getMomentBuffers(i: number): { m: Float32Array; v: Float32Array } };
      maybeApplyHasPairRoleZeroInit(): void;
    };
    const inner = core as unknown as NetInternal;
    const trunk0 = inner.network.trunk[0];
    const PAIR_ROLE_COL = 49;
    // Simulate a snapshot where column 49 has been trained: poke v
    // and W to non-zero values. Re-running the migration must NOT
    // overwrite either.
    const { v } = inner.optimizer.getMomentBuffers(0);
    v[1 * trunk0.inDim + PAIR_ROLE_COL] = 1e-6;
    const sentinel = 0.123;
    for (let h = 0; h < trunk0.outDim; h++) {
      trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL] = sentinel;
    }
    // Snapshot the post-write Float32-rounded values so we can
    // compare exactly post-call. Float32 rounds 0.123 to
    // ~0.12300000339746... — using toBeCloseTo would also work but
    // the byte-equality check is stronger.
    const expected = new Float32Array(trunk0.outDim);
    for (let h = 0; h < trunk0.outDim; h++) {
      expected[h] = trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL];
    }
    inner.maybeApplyHasPairRoleZeroInit();
    for (let h = 0; h < trunk0.outDim; h++) {
      expect(trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL]).toBe(expected[h]);
    }
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("hasPairRole zero-init migration: respects idempotence after a column has been zero-init'd previously", async () => {
    // Direct test of the detection condition with a fully-trained
    // column 49. After first init the column is zeroed (and v stays
    // zero — the column hasn't actually trained yet because no
    // hasPairRole=1 sample has run through). To simulate
    // "post-training" state, set v[h*124+49] non-zero on every row
    // and W[h*124+49] to non-zero values. Re-running the migration
    // must skip — no W mutation.
    const dir = await tmpDir("nn-hpr-migration-trained-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      snapshotInterval: 1_000_000,
      rng: lcg(43),
    });
    await core.init();
    type NetInternal = {
      network: { trunk: Array<{ W: Float32Array; inDim: number; outDim: number }> };
      optimizer: { getMomentBuffers(i: number): { m: Float32Array; v: Float32Array } };
      maybeApplyHasPairRoleZeroInit(): void;
    };
    const inner = core as unknown as NetInternal;
    const trunk0 = inner.network.trunk[0];
    const PAIR_ROLE_COL = 49;
    const { v } = inner.optimizer.getMomentBuffers(0);
    // Make v[col 49] non-zero across every row → simulates a column
    // that has accumulated AdamW second-moment history, i.e., has
    // received gradient updates.
    for (let h = 0; h < trunk0.outDim; h++) {
      v[h * trunk0.inDim + PAIR_ROLE_COL] = 1e-3;
      trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL] = 0.05 + h * 0.01;
    }
    const expected = new Float32Array(trunk0.outDim);
    for (let h = 0; h < trunk0.outDim; h++) {
      expected[h] = trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL];
    }
    inner.maybeApplyHasPairRoleZeroInit();
    for (let h = 0; h < trunk0.outDim; h++) {
      expect(trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL]).toBe(expected[h]);
    }
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("hasPairRole zero-init migration: idempotent across repeat invocations", async () => {
    const dir = await tmpDir("nn-hpr-migration-idempotent-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 8,
      snapshotInterval: 1_000_000,
      rng: lcg(37),
    });
    await core.init();
    type NetInternal = {
      network: { trunk: Array<{ W: Float32Array; inDim: number; outDim: number }> };
      maybeApplyHasPairRoleZeroInit(): void;
    };
    const inner = core as unknown as NetInternal;
    const trunk0 = inner.network.trunk[0];
    const PAIR_ROLE_COL = 49;
    // First run already happened during init(). Calling again should
    // be a benign no-op: column stays at zero, no other column moves.
    const before = new Float32Array(trunk0.W);
    inner.maybeApplyHasPairRoleZeroInit();
    for (let i = 0; i < trunk0.W.length; i++) {
      expect(trunk0.W[i]).toBe(before[i]);
    }
    // And column 49 specifically is still all zeros.
    for (let h = 0; h < trunk0.outDim; h++) {
      expect(trunk0.W[h * trunk0.inDim + PAIR_ROLE_COL]).toBe(0);
    }
    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);
});

/**
 * Read the only divergence_event row from today's ndjson. Returns null
 * when no event was emitted. JSON.parse maps `Infinity` to `null` so
 * callers compare against `null` for the worst-case promotion path.
 */
async function readDivergenceEvent(dir: string): Promise<{
  maxStepGradNormPreClip: number | null;
  stepLossNonFinite: boolean;
} | null> {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dir, "round-logs", `round-${today}.ndjson`);
  const raw = await fs.readFile(logPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events = lines
    .map(
      (l) =>
        JSON.parse(l) as {
          type?: string;
          maxStepGradNormPreClip?: number | null;
          stepLossNonFinite?: boolean;
        },
    )
    .filter((e) => e.type === "divergence_event");
  if (events.length === 0) return null;
  expect(events.length).toBe(1);
  return {
    maxStepGradNormPreClip: events[0].maxStepGradNormPreClip ?? null,
    stepLossNonFinite: events[0].stepLossNonFinite ?? false,
  };
}
