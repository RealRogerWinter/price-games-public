/**
 * Phase 3e.0 — validates the shipped golden-eval seed file.
 *
 * The seed at `infra/streamer/golden-eval.json` is baked into the
 * streamer docker image and copied to the runtime data dir on boot.
 * It powers the snapshot regression gate — a malformed seed disables
 * the gate (loadGoldenEval falls back to empty), so a regression
 * test on the file's shape is cheap insurance.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { GoldenEvalSeedSchema } from "../src/learning/goldenEval";

const SEED_PATH = path.resolve(__dirname, "../../../infra/streamer/golden-eval.json");
const ACTIVE_MODES = new Set(["classic", "higher-lower", "comparison", "bidding"]);
// `closest-without-going-over` is in the seed builder's NEEDS_REF
// set but not in ACTIVE_MODES — it's deferred until the mode is
// reactivated. Until then the only entries that should carry a
// referencePrice in the shipped seed are higher-lower entries.
const NEEDS_REF_IN_ACTIVE_SEED = new Set(["higher-lower"]);

describe("infra/streamer/golden-eval.json (shipped seed)", () => {
  const raw = fs.readFileSync(SEED_PATH, "utf8");
  const parsed: GoldenEvalSeedSchema = JSON.parse(raw);

  it("matches the on-disk schema (version, computedAt, entries)", () => {
    expect(parsed.version).toBe(1);
    expect(typeof parsed.computedAt).toBe("string");
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("has 200 entries stratified evenly across the 4 active modes", () => {
    expect(parsed.entries).toHaveLength(200);
    const byMode = new Map<string, number>();
    for (const e of parsed.entries) {
      byMode.set(e.mode, (byMode.get(e.mode) ?? 0) + 1);
    }
    expect(byMode.size).toBe(ACTIVE_MODES.size);
    for (const m of ACTIVE_MODES) {
      expect(byMode.get(m)).toBe(50);
    }
  });

  it("every entry has a sane product + actualCents", () => {
    for (const e of parsed.entries) {
      expect(e.product.id).toBeTypeOf("number");
      expect(e.product.title.length).toBeGreaterThan(0);
      expect(e.product.category.length).toBeGreaterThan(0);
      expect(e.actualCents).toBeGreaterThan(0);
      expect(Number.isFinite(e.actualCents)).toBe(true);
    }
  });

  it("only modes that NEED a reference price carry one", () => {
    for (const e of parsed.entries) {
      if (NEEDS_REF_IN_ACTIVE_SEED.has(e.mode)) {
        expect(e.referencePrice).toBeTypeOf("number");
        expect(e.referencePrice).toBeGreaterThan(0);
      } else {
        expect(e.referencePrice).toBeUndefined();
      }
    }
  });

  it("entries are pinned to the current corpus checkpoint", () => {
    // Snapshot the first + last entry's product id. These ids are
    // tied to the CURRENT scraped corpus + a pinned PRNG seed; any
    // change to apps/server/data/scraped/*.json (add/remove/reorder
    // products) reshuffles Fisher-Yates output and shifts these ids.
    //
    // **If this test fails after a corpus update**:
    //   1. Re-run `node scripts/build-golden-eval-seed.mjs` to regen
    //      `infra/streamer/golden-eval.json`.
    //   2. Update the two ids below to match the new first/last
    //      entry. The point of this test is to catch SILENT seed
    //      drift, not to block legitimate corpus updates.
    expect(parsed.entries[0].product.id).toBe(4034254035);
    expect(parsed.entries[parsed.entries.length - 1].product.id).toBe(2276333690);
  });
});
