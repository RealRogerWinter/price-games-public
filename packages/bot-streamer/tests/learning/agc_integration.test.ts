/**
 * Phase 3e.3 — AGC integration tests (B3 fix from review #343).
 *
 * The unit-level `agc.test.ts` covers the math in isolation. These
 * tests exercise the wired path inside `WorkerCore.runMinibatchStep`:
 *
 *   1. AGC fires (`agcClipsP95 > 0` after warmup) when default lambda is set.
 *   2. AGC is skipped when `agcLambda: 0` is passed.
 *   3. AGC's bias-skip set excludes every odd-indexed buffer.
 *   4. The divergence-rollback gate sees PRE-AGC norms (not post-AGC).
 *
 * A swap of the AGC ↔ global-clip ordering, a buffer-list permutation,
 * a dropped call site, or AGC silently neutering the rollback gate
 * would all be caught here but slip past the unit suite.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GameMode } from "@price-game/shared";
import { WorkerCore } from "../../src/learning/workerCore";

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

describe("AGC integration with WorkerCore.runMinibatchStep", () => {
  it("agcClipsP95 > 0 after warmup at default agcLambda (AGC actually fires)", async () => {
    const dir = await tmpDir("nn-agc-int-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(701),
      // Use a non-trivial lambda so AGC is exercised. The default
      // `withDefaults()` resolves to AGC_LAMBDA from env, which is
      // 0.1 unless overridden — explicit here for test stability.
      agcLambda: 0.1,
    });
    await core.init();

    // 30 rounds of warmup. With AGC at lambda=0.1, the trunk[0] buffer
    // (||W||≈8 He-init, ||g|| dominates the aggregate) clips on every
    // step. agcClipsP95 over the trailing window should be >= 1.
    for (let r = 0; r < 30; r++) {
      core.update({
        roundId: `r-${r}`,
        revealedSamples: [sample(r)],
        primaryMode: MODE,
        outcome: "correct",
      });
    }
    expect(core.health().agcClipsP95).toBeGreaterThan(0);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("agcClipsP95 == 0 when agcLambda: 0 (kill-switch)", async () => {
    const dir = await tmpDir("nn-agc-off-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(702),
      agcLambda: 0,
    });
    await core.init();
    for (let r = 0; r < 10; r++) {
      core.update({
        roundId: `r-${r}`,
        revealedSamples: [sample(r)],
        primaryMode: MODE,
        outcome: "correct",
      });
    }
    expect(core.health().agcClipsP95).toBe(0);
    expect(core.health().agcMinScaleP5).toBe(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("agcMinScaleP5 stays in [0, 1] (never inverted, never NaN)", async () => {
    const dir = await tmpDir("nn-agc-scale-range-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(703),
      agcLambda: 0.1,
    });
    await core.init();
    for (let r = 0; r < 30; r++) {
      core.update({
        roundId: `r-${r}`,
        revealedSamples: [sample(r)],
        primaryMode: MODE,
        outcome: "correct",
      });
    }
    const minScale = core.health().agcMinScaleP5;
    expect(Number.isFinite(minScale)).toBe(true);
    expect(minScale).toBeGreaterThanOrEqual(0);
    expect(minScale).toBeLessThanOrEqual(1);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("B2 wiring: bias buffers (odd indices) are excluded from AGC clip count", async () => {
    // After many rounds, agcClipsP95 should never equal `paramBufs.length`
    // (i.e. every buffer clipped) because biases are skipped. With our
    // network having 14 buffers (7 W + 7 b), AGC's max clip count per
    // step is 7. We use a strict ceiling check.
    const dir = await tmpDir("nn-agc-bias-skip-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(704),
      agcLambda: 0.1,
    });
    await core.init();
    for (let r = 0; r < 30; r++) {
      core.update({
        roundId: `r-${r}`,
        revealedSamples: [sample(r)],
        primaryMode: MODE,
        outcome: "correct",
      });
    }
    // The network has 8 layers × 2 (W + b) = 16 param buffers.
    // The skip set is exactly the 8 bias buffers (odd indices).
    type Internal = { agcSkipIndices: ReadonlySet<number> };
    const skip = (core as unknown as Internal).agcSkipIndices;
    expect(skip.size).toBe(8);
    expect(Array.from(skip).sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);

    // agcClipsP95 should never exceed the W-buffer count (= 8).
    expect(core.health().agcClipsP95).toBeLessThanOrEqual(8);

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("B1 wiring: gradNormP95 reports PRE-AGC norm so the divergence gate stays armed", async () => {
    // With AGC active, the post-AGC aggregate is bounded by ~lambda·||W||.
    // For our network (trunk[0] ||W||≈8) at lambda=0.1, post-AGC aggregate
    // is single-digit. If `gradNormP95` reflected post-AGC, it would
    // never exceed ~10 even on healthy training.
    //
    // Inject a synthetic huge value into trunk[0].W to provoke a large
    // RAW gradient. AGC will clip per-buffer so the optimizer doesn't
    // diverge — but `gradNormP95` (which the rollback gate keys off)
    // must still see the large pre-AGC magnitude. If gradNormP95 stays
    // small even with the spike, the gate is dead.
    const dir = await tmpDir("nn-agc-gate-armed-");
    const core = new WorkerCore({
      dataDir: dir,
      stepsPerRound: 1,
      batchSize: 4,
      replayCapacity: 16,
      snapshotInterval: 1_000_000,
      rng: lcg(705),
      agcLambda: 0.1,
    });
    await core.init();
    // Warmup to populate the replay buffer.
    core.update({ roundId: "warm", revealedSamples: [sample(0)], primaryMode: MODE, outcome: "correct" });
    const baselineP95 = core.health().gradNormP95;
    // Inject the spike.
    type NetInternal = { trunk: Array<{ W: Float32Array }> };
    const net = (core as unknown as { network: NetInternal }).network;
    net.trunk[0].W[0] = 1e8;
    core.update({ roundId: "spike", revealedSamples: [sample(1)], primaryMode: MODE, outcome: "incorrect" });

    // The spike's pre-AGC norm should be enormous (well above the
    // baseline). If gradNormP95 is reporting post-AGC, this assertion
    // fails because AGC absorbs the spike.
    expect(core.health().gradNormP95).toBeGreaterThan(Math.max(baselineP95 * 10, 1e4));

    await core.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }, 30_000);
});
