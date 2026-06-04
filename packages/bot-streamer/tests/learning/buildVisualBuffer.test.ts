/**
 * Tests for WorkerCore.buildVisualBuffer — confirms the broadcast tick
 * reflects real model state once a predict has run, and a stable
 * idle-shaped tick before the first predict.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { WorkerCore } from "../../src/learning/workerCore";
import type { VisualTick } from "../../src/learning/types";
import { EMBEDDING_DIM, TRUNK_HIDDEN_DIM } from "../../src/learning/types";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function decodeTick(buf: Buffer): VisualTick {
  return JSON.parse(buf.toString("utf8")) as VisualTick;
}

async function freshCore(): Promise<WorkerCore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buildvisual-"));
  const core = new WorkerCore({
    dataDir: dir,
    snapshotInterval: 1_000_000,
    stepsPerRound: 2,
    batchSize: 4,
    replayCapacity: 32,
    rng: lcg(7),
  });
  await core.init();
  return core;
}

const SAMPLE_PRODUCT = {
  id: 1,
  title: "Pro Wireless Mouse",
  category: "Electronics",
  description: "ergonomic gaming mouse",
  imageUrl: "img",
};

describe("buildVisualBuffer", () => {
  it("returns an idle-shaped tick before any predict has run", async () => {
    const core = await freshCore();
    const tick = decodeTick(core.buildVisualBuffer("r-0"));

    expect(tick.roundId).toBe("r-0");
    expect(tick.prediction.cents).toBe(0);
    expect(tick.prediction.sigma).toBe(0);
    // belief.topCategory + brandTier removed in PR #4 with the multi-task
    // heads. Idle tick still ships an empty topFeatures + a sentence.
    expect(tick.belief.topFeatures).toEqual([]);
    expect(tick.network.weightSamples).toEqual([]);
    expect(tick.embedding2d).toEqual({ x: 0, y: 0 });
    expect(tick.teachingMoment.triggered).toBe(false);

    // Activation arrays are zero-length-or-zero-valued.
    const hidden = tick.network.layers[1].activations;
    const emb = tick.network.layers[2].activations;
    expect(hidden).toHaveLength(TRUNK_HIDDEN_DIM);
    expect(emb).toHaveLength(EMBEDDING_DIM);
    expect(hidden.every((x) => x === 0)).toBe(true);
    expect(emb.every((x) => x === 0)).toBe(true);

    await core.shutdown();
  });

  it("reflects the most recent predict outputs", async () => {
    const core = await freshCore();
    const res = core.predict({
      roundId: "p-1",
      mode: "classic",
      product: SAMPLE_PRODUCT,
    });
    expect(res.predictedCents).toBeGreaterThan(0);

    const tick = decodeTick(core.buildVisualBuffer("p-1"));

    // Prediction matches the predict call.
    expect(tick.prediction.cents).toBe(res.predictedCents);
    expect(tick.prediction.sigma).toBe(res.predictedSigmaCents);

    // Embedding 2-d projection (post-PR-4: first 2 dims of the trunk
    // embedding, no separate viz head). Won't be pinned to (0, 0) on a
    // freshly-initialised network with random title features.
    expect(tick.embedding2d.x).toBeCloseTo(res.embedding2d[0], 5);
    expect(tick.embedding2d.y).toBeCloseTo(res.embedding2d[1], 5);

    // At least one trunk-hidden activation is non-zero (post-ReLU on
    // a randomly-initialised He-normal layer practically always fires).
    const hidden = tick.network.layers[1].activations;
    expect(hidden.some((x) => x !== 0)).toBe(true);

    // Embedding output isn't all-zero either.
    const emb = tick.network.layers[2].activations;
    expect(emb.some((x) => x !== 0)).toBe(true);

    // Top features carry forward (length capped at 5 by predict).
    expect(tick.belief.topFeatures.length).toBeGreaterThan(0);
    expect(tick.belief.topFeatures.length).toBeLessThanOrEqual(5);
    expect(tick.belief.topFeatures[0].name).toBe(res.topFeatures[0].name);

    // Weight samples non-empty and well-formed (sign + magnitude).
    expect(tick.network.weightSamples.length).toBeGreaterThan(0);
    for (const w of tick.network.weightSamples) {
      expect([0, 1]).toContain(w.fromLayer);
      expect([1, 2]).toContain(w.toLayer);
      expect(Number.isFinite(w.weight)).toBe(true);
    }

    await core.shutdown();
  });

  it("returns stable weight-edge indices across ticks (only weights change)", async () => {
    const core = await freshCore();
    core.predict({ roundId: "p-1", mode: "classic", product: SAMPLE_PRODUCT });
    const a = decodeTick(core.buildVisualBuffer("a"));

    core.predict({ roundId: "p-2", mode: "classic", product: SAMPLE_PRODUCT });
    const b = decodeTick(core.buildVisualBuffer("b"));

    expect(a.network.weightSamples.length).toBe(b.network.weightSamples.length);
    for (let i = 0; i < a.network.weightSamples.length; i++) {
      const ea = a.network.weightSamples[i];
      const eb = b.network.weightSamples[i];
      expect(eb.fromLayer).toBe(ea.fromLayer);
      expect(eb.fromIdx).toBe(ea.fromIdx);
      expect(eb.toLayer).toBe(ea.toLayer);
      expect(eb.toIdx).toBe(ea.toIdx);
    }

    await core.shutdown();
  });

  it("clears the teaching trigger on the next non-triggering update", async () => {
    const core = await freshCore();
    core.predict({ roundId: "p-1", mode: "classic", product: SAMPLE_PRODUCT });

    // First update: replay is empty so the early-return path fires; it
    // should explicitly clear lastTeachingTriggered to false.
    core.update({
      roundId: "u-0",
      revealedSamples: [],
      primaryMode: "classic",
      outcome: "correct",
    });
    const tick = decodeTick(core.buildVisualBuffer("u-0"));
    expect(tick.teachingMoment.triggered).toBe(false);

    await core.shutdown();
  });

  it("pushes ONE recentAccuracy bucket per round, mapped from the game outcome", async () => {
    // Pre-fix the panel re-derived a bucket per revealed product by
    // re-running predictFromPriceClassHead and comparing its catalog
    // argmax to actualCents. That diverged from the game's mode-
    // specific win condition (e.g., comparison mode is binary by
    // product ID, not by per-product price accuracy), so a round the
    // game scored "correct" could still surface red dots. The panel
    // now tracks the round's actual outcome instead — one dot per
    // round, viewers see what the game scored.
    const core = await freshCore();
    const multiSamples = [
      { product: { ...SAMPLE_PRODUCT, id: 11, title: "Mouse A" }, actualCents: 5000, mode: "comparison" as const },
      { product: { ...SAMPLE_PRODUCT, id: 12, title: "Mouse B" }, actualCents: 4000, mode: "comparison" as const },
      { product: { ...SAMPLE_PRODUCT, id: 13, title: "Mouse C" }, actualCents: 6000, mode: "comparison" as const },
    ];
    core.update({
      roundId: "u-multi",
      revealedSamples: multiSamples,
      primaryMode: "comparison",
      outcome: "correct",
    });
    const tick = decodeTick(core.buildVisualBuffer("u-multi"));
    // One dot per round regardless of how many products were revealed.
    expect(tick.recentAccuracy).toHaveLength(1);
    expect(tick.recentAccuracy[0]).toBe("within10");

    // A subsequent classic round with a "partial" outcome adds an
    // amber bucket; total now 2.
    core.update({
      roundId: "u-classic",
      revealedSamples: [
        { product: { ...SAMPLE_PRODUCT, id: 14, title: "Mouse D" }, actualCents: 5500, mode: "classic" as const },
      ],
      primaryMode: "classic",
      outcome: "partial",
    });
    const tick2 = decodeTick(core.buildVisualBuffer("u-classic"));
    expect(tick2.recentAccuracy).toEqual(["within10", "within25"]);

    // An "incorrect" round produces a "miss" — even if the bot's
    // post-update re-prediction would have been close on the price
    // (the panel ignores re-prediction; it tracks what viewers saw
    // the game score).
    core.update({
      roundId: "u-incorrect",
      revealedSamples: [
        { product: { ...SAMPLE_PRODUCT, id: 15, title: "Mouse E" }, actualCents: 4500, mode: "classic" as const },
      ],
      primaryMode: "classic",
      outcome: "incorrect",
    });
    const tick3 = decodeTick(core.buildVisualBuffer("u-incorrect"));
    expect(tick3.recentAccuracy).toEqual(["within10", "within25", "miss"]);

    await core.shutdown();
  });

  it("does not push a recentAccuracy bucket when no products were revealed", async () => {
    // Disconnects / extraction failures land here — no reveal data,
    // no dot. The dot row should track real round attempts only, not
    // empty bookkeeping calls from the driver.
    const core = await freshCore();
    core.update({
      roundId: "u-empty",
      revealedSamples: [],
      primaryMode: "classic",
      outcome: "correct",
    });
    const tick = decodeTick(core.buildVisualBuffer("u-empty"));
    expect(tick.recentAccuracy).toHaveLength(0);

    await core.shutdown();
  });
});
