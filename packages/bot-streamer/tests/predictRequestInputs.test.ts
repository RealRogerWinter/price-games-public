/**
 * Phase 3e.0 — regression tests for rank/pair derivation.
 *
 * Pre-3e.0 the driver gated `rankProducts` on `length > 2`, leaving
 * comparison rounds (always length === 2) without per-product rank
 * predictions. The strategy's fallback path then collapsed both
 * products onto a single shared `predictedCents` (or `thompsonDraw`)
 * scalar, producing tied centers and a deterministic tiebreaker that
 * floored comparison accuracy at 50% on the fallback path.
 */
import { describe, expect, it } from "vitest";
import { deriveRankAndPair } from "../src/runner/predictRequestInputs";

const PROD_A = { id: 1, title: "Widget A", category: "Tools" };
const PROD_B = { id: 2, title: "Widget B", category: "Tools" };
const PROD_C = { id: 3, title: "Widget C", category: "Tools" };
const PROD_D = { id: 4, title: "Widget D", category: "Tools" };

describe("deriveRankAndPair", () => {
  it("returns undefined for both when fewer than 2 products", () => {
    expect(deriveRankAndPair(undefined)).toEqual({ pair: undefined, rank: undefined });
    expect(deriveRankAndPair([])).toEqual({ pair: undefined, rank: undefined });
    expect(deriveRankAndPair([PROD_A])).toEqual({ pair: undefined, rank: undefined });
  });

  it("populates BOTH pair and rank for a 2-product round (the comparison-fallback fix)", () => {
    const out = deriveRankAndPair([PROD_A, PROD_B]);
    expect(out.pair).toBeDefined();
    expect(out.pair).toHaveLength(2);
    expect(out.pair?.[0].id).toBe(PROD_A.id);
    expect(out.pair?.[1].id).toBe(PROD_B.id);
    // The bug fix: `rank` MUST be populated for length===2 rounds so
    // the worker emits per-product `rankPredictions`. Without this,
    // comparison's fallback degenerates to identical centers.
    expect(out.rank).toBeDefined();
    expect(out.rank).toHaveLength(2);
    expect(out.rank?.[0].id).toBe(PROD_A.id);
    expect(out.rank?.[1].id).toBe(PROD_B.id);
  });

  it("populates only rank (no pair) when more than 2 products", () => {
    const out = deriveRankAndPair([PROD_A, PROD_B, PROD_C, PROD_D]);
    expect(out.pair).toBeUndefined();
    expect(out.rank).toBeDefined();
    expect(out.rank).toHaveLength(4);
    expect(out.rank?.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  it("preserves product order for both pair and rank", () => {
    const out = deriveRankAndPair([PROD_B, PROD_A]);
    expect(out.pair?.[0].id).toBe(PROD_B.id);
    expect(out.pair?.[1].id).toBe(PROD_A.id);
    expect(out.rank?.[0].id).toBe(PROD_B.id);
    expect(out.rank?.[1].id).toBe(PROD_A.id);
  });

  it("strips server-only fields from rank/pair entries (ProductLite shape)", () => {
    // Server `Product` carries `description`/`imageUrl` etc. that the
    // worker doesn't need; the helper passes them through if present
    // (matching prior toProductLite behaviour) but never invents them.
    const withImage = { id: 9, title: "X", category: "Y", imageUrl: "https://x.png" };
    const out = deriveRankAndPair([withImage, PROD_A]);
    expect(out.pair?.[0]).toMatchObject({ id: 9, title: "X", category: "Y", imageUrl: "https://x.png" });
    expect(out.rank?.[0]).toMatchObject({ id: 9, title: "X", category: "Y", imageUrl: "https://x.png" });
  });
});
