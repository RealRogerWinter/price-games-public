import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { GoldenEvalSet } from "../../src/learning/goldenEval";
import { BrandTierTable } from "../../src/learning/brandTierTable";

describe("GoldenEvalSet", () => {
  it("returns null MAE when empty", () => {
    const g = new GoldenEvalSet([]);
    expect(g.evaluateMAE(() => 100)).toBeNull();
  });

  it("computes MAE correctly", () => {
    const g = new GoldenEvalSet([
      {
        product: { id: 1, title: "A", category: "x" },
        mode: "classic",
        actualCents: 100,
      },
      {
        product: { id: 2, title: "B", category: "x" },
        mode: "classic",
        actualCents: 200,
      },
    ]);
    // Predict each as 150 → MAE = (50 + 50) / 2 = 50
    expect(g.evaluateMAE(() => 150)).toBe(50);
  });

  it("loads from a tmp file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "golden-"));
    await fs.writeFile(
      path.join(dir, "golden-eval.json"),
      JSON.stringify({
        version: 1,
        computedAt: new Date().toISOString(),
        entries: [
          { product: { id: 1, title: "X", category: "y" }, mode: "classic", actualCents: 500 },
        ],
      }),
    );
    const g = await GoldenEvalSet.load(dir);
    expect(g.entries.length).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty set when file is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "golden-"));
    const g = await GoldenEvalSet.load(dir);
    expect(g.entries.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns Infinity when ANY prediction is non-finite (NaN-mask hardening)", () => {
    // Pre-fix bug: NaN predictions were silently dropped from `total`
    // but still divided by entries.length, so a fully-diverged model
    // returned MAE = 0/N = 0 — the snapshot gate would happily accept
    // it as an improvement and persist the corrupted weights. We treat
    // any non-finite prediction as catastrophic failure.
    const g = new GoldenEvalSet([
      { product: { id: 1, title: "A", category: "x" }, mode: "classic", actualCents: 100 },
      { product: { id: 2, title: "B", category: "x" }, mode: "classic", actualCents: 200 },
    ]);
    const mae = g.evaluateMAE((entry) => (entry.product.id === 1 ? Number.NaN : 200));
    expect(mae).toBe(Infinity);
  });

  it("returns Infinity when ALL predictions are non-finite", () => {
    const g = new GoldenEvalSet([
      { product: { id: 1, title: "A", category: "x" }, mode: "classic", actualCents: 100 },
    ]);
    expect(g.evaluateMAE(() => Number.NaN)).toBe(Infinity);
    expect(g.evaluateMAE(() => Infinity)).toBe(Infinity);
    expect(g.evaluateMAE(() => -Infinity)).toBe(Infinity);
  });
});

describe("BrandTierTable", () => {
  it("returns mid (=1) for unknown keys", () => {
    const t = new BrandTierTable();
    expect(t.lookup("unknown")).toBe(1);
    expect(t.has("unknown")).toBe(false);
    expect(t.size()).toBe(0);
  });

  it("loads from in-memory entries", () => {
    const t = BrandTierTable.fromEntries([
      { key: "Foo", tier: 0 },
      { key: "BAR", tier: 2 },
    ]);
    expect(t.size()).toBe(2);
    expect(t.lookup("foo")).toBe(0);
    expect(t.lookup("bar")).toBe(2);
    expect(t.lookup("baz")).toBe(1);
    expect(t.has("FOO  ")).toBe(true);
  });

  it("loads from a tmp file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tier-"));
    await fs.writeFile(
      path.join(dir, "brand-tiers.json"),
      JSON.stringify({
        version: 1,
        computedAt: new Date().toISOString(),
        entries: [
          { key: "B0XYZ", tier: 2 },
          { key: "Test", tier: 0 },
        ],
      }),
    );
    const t = await BrandTierTable.load(dir);
    expect(t.lookup("b0xyz")).toBe(2);
    expect(t.lookup("test")).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("missing file is non-fatal", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tier-"));
    const t = await BrandTierTable.load(dir);
    expect(t.size()).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
