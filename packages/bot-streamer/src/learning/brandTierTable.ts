/**
 * Frozen brand-tier lookup.
 *
 * The bot's tier_head trains as classification over { budget, mid,
 * premium } — labels come from a percentile partition of category-
 * relative price computed once on the production catalogue and shipped
 * as JSON. The runtime loader is purely a Map<string, BrandTier>.
 *
 * The seed file is built by `scripts/build-brand-tier-seed.mjs` and
 * persisted at `<dataDir>/brand-tiers.json`. If the file is absent
 * (cold install) the loader returns an empty table; tier_head still
 * runs, but every label defaults to mid (=1) so the loss won't be
 * meaningful until the seed lands. The runtime gate `gated` flag in
 * the visual tick reflects this.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrandTier } from "./types";

export interface BrandTierTableSchema {
  /** Stable seed version. Bumped when the underlying partition changes. */
  version: number;
  /** Computed at: ISO timestamp. */
  computedAt: string;
  /** ASIN or product-title key → tier. */
  entries: Array<{ key: string; tier: BrandTier }>;
}

export class BrandTierTable {
  readonly version: number;
  readonly computedAt: string;
  private map: Map<string, BrandTier>;

  constructor(version = 0, computedAt = new Date(0).toISOString()) {
    this.version = version;
    this.computedAt = computedAt;
    this.map = new Map();
  }

  size(): number {
    return this.map.size;
  }

  /** Look up a tier; returns 1 (mid) when key is unknown. */
  lookup(key: string): BrandTier {
    return this.map.get(key.toLowerCase().trim()) ?? 1;
  }

  /** Returns true if the key is in the table (i.e. not a fallback). */
  has(key: string): boolean {
    return this.map.has(key.toLowerCase().trim());
  }

  /**
   * Load from disk. Returns an empty table when the file is absent.
   *
   * @param dataDir Directory containing `brand-tiers.json`.
   */
  static async load(dataDir: string): Promise<BrandTierTable> {
    const filepath = path.join(dataDir, "brand-tiers.json");
    let raw: string;
    try {
      raw = await fs.readFile(filepath, "utf8");
    } catch {
      return new BrandTierTable();
    }
    const parsed = JSON.parse(raw) as BrandTierTableSchema;
    const tbl = new BrandTierTable(parsed.version, parsed.computedAt);
    for (const e of parsed.entries) {
      tbl.map.set(e.key.toLowerCase().trim(), e.tier);
    }
    return tbl;
  }

  /** In-memory load for tests. */
  static fromEntries(entries: Array<{ key: string; tier: BrandTier }>, version = 1): BrandTierTable {
    const tbl = new BrandTierTable(version, new Date().toISOString());
    for (const e of entries) tbl.map.set(e.key.toLowerCase().trim(), e.tier);
    return tbl;
  }
}
