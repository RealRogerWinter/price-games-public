/**
 * Golden eval set — a frozen list of (product, mode, actualCents) tuples
 * the worker re-evaluates at every snapshot to track regression.
 *
 * The set is loaded from `<dataDir>/golden-eval.json` (built once via
 * `scripts/build-golden-eval-seed.mjs`); when the file is absent the
 * eval is a no-op and `goldenMAE` stays null in /healthz.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { GameMode } from "@price-game/shared";
import type { ProductLite } from "./types";

export interface GoldenEvalEntry {
  product: ProductLite;
  mode: GameMode;
  actualCents: number;
  /** Optional reference price for higher-lower / closest. */
  referencePrice?: number;
}

export interface GoldenEvalSeedSchema {
  version: number;
  computedAt: string;
  entries: GoldenEvalEntry[];
}

export class GoldenEvalSet {
  readonly entries: GoldenEvalEntry[];

  constructor(entries: GoldenEvalEntry[] = []) {
    this.entries = entries;
  }

  static async load(dataDir: string): Promise<GoldenEvalSet> {
    const filepath = path.join(dataDir, "golden-eval.json");
    try {
      const raw = await fs.readFile(filepath, "utf8");
      const parsed = JSON.parse(raw) as GoldenEvalSeedSchema;
      return new GoldenEvalSet(parsed.entries);
    } catch {
      return new GoldenEvalSet([]);
    }
  }

  /**
   * Compute MAE between predicted and actual cents.
   *
   * Treats *any* non-finite prediction as catastrophic and returns
   * Infinity. Without this, a fully-diverged model whose predict()
   * returns NaN for every entry used to silently report MAE = 0/N = 0
   * — which the snapshot gate would interpret as a perfect improvement
   * and persist the corrupt weights. The snapshot caller must check
   * `Number.isFinite` on the result before treating it as a winning
   * delta.
   *
   * @param predict A function that returns predictedCents for an entry.
   * @returns MAE in cents, null if the set is empty, or Infinity if
   *          any prediction is non-finite.
   */
  evaluateMAE(predict: (entry: GoldenEvalEntry) => number): number | null {
    if (this.entries.length === 0) return null;
    let total = 0;
    for (const e of this.entries) {
      const pred = predict(e);
      if (!Number.isFinite(pred)) return Infinity;
      total += Math.abs(pred - e.actualCents);
    }
    return total / this.entries.length;
  }
}
