/**
 * Tests for extractSoloRevealedSamples — the helper that pulls
 * RevealedSamples out of a solo `/api/game/:sessionId/guess` response
 * body. Mirrors the multiplayer-side `extractRevealedSamples` shape so
 * the learning bridge gets fed on solo rounds too.
 */

import { describe, it, expect } from "vitest";
import { extractSoloRevealedSamples } from "../src/runner/playwrightDriver";
import type { GameMode } from "@price-game/shared";

const SINGLE_PRODUCT_MODES: GameMode[] = [
  "classic",
  "higher-lower",
  "closest-without-going-over",
  "riser",
  "bidding",
];

const MULTI_PRODUCT_MODES: GameMode[] = [
  "comparison",
  "price-match",
  "odd-one-out",
  "market-basket",
  "sort-it-out",
  "budget-builder",
  "chain-reaction",
];

function singleProductBody(mode: GameMode, priceCents: number = 1234): unknown {
  return {
    result: {
      product: {
        id: 1,
        title: "A",
        category: "Electronics",
        description: "desc",
        imageUrl: "img",
        priceCents,
      },
      score: 75,
    },
    session: { id: "s1", gameMode: mode },
  };
}

function multiProductBody(mode: GameMode, prices: number[] = [1234, 500]): unknown {
  return {
    result: {
      products: prices.map((priceCents, i) => ({
        id: i + 1,
        title: `P${i}`,
        category: i % 2 === 0 ? "Electronics" : "Books",
        description: "desc",
        imageUrl: "img",
        priceCents,
      })),
      score: 50,
    },
    session: { id: "s1", gameMode: mode },
  };
}

describe("extractSoloRevealedSamples", () => {
  describe("single-product modes", () => {
    for (const mode of SINGLE_PRODUCT_MODES) {
      it(`extracts the single product price for ${mode}`, () => {
        const samples = extractSoloRevealedSamples(singleProductBody(mode, 4242));
        expect(samples).toEqual([
          {
            product: {
              id: 1,
              title: "A",
              category: "Electronics",
              description: "desc",
              imageUrl: "img",
            },
            actualCents: 4242,
            mode,
          },
        ]);
      });
    }
  });

  describe("multi-product modes", () => {
    for (const mode of MULTI_PRODUCT_MODES) {
      it(`extracts every priced product for ${mode}`, () => {
        const samples = extractSoloRevealedSamples(multiProductBody(mode, [1000, 2000, 3000]));
        expect(samples).toHaveLength(3);
        expect(samples.map((s) => s.actualCents)).toEqual([1000, 2000, 3000]);
        expect(samples.every((s) => s.mode === mode)).toBe(true);
      });
    }
  });

  describe("malformed bodies", () => {
    it("returns [] on null/undefined", () => {
      expect(extractSoloRevealedSamples(null)).toEqual([]);
      expect(extractSoloRevealedSamples(undefined)).toEqual([]);
    });

    it("returns [] on non-object body", () => {
      expect(extractSoloRevealedSamples(42)).toEqual([]);
      expect(extractSoloRevealedSamples("nope")).toEqual([]);
      expect(extractSoloRevealedSamples([])).toEqual([]);
    });

    it("returns [] when session is missing", () => {
      expect(
        extractSoloRevealedSamples({
          result: { product: { id: 1, title: "A", category: "Electronics", priceCents: 100 } },
        }),
      ).toEqual([]);
    });

    it("returns [] when session.gameMode is unknown", () => {
      expect(
        extractSoloRevealedSamples({
          result: { product: { id: 1, title: "A", category: "Electronics", priceCents: 100 } },
          session: { gameMode: "not-a-real-mode" },
        }),
      ).toEqual([]);
    });

    it("returns [] when result is missing", () => {
      expect(
        extractSoloRevealedSamples({ session: { gameMode: "classic" } }),
      ).toEqual([]);
    });

    it("returns [] when result is non-object", () => {
      expect(
        extractSoloRevealedSamples({ result: 42, session: { gameMode: "classic" } }),
      ).toEqual([]);
    });
  });

  describe("price filtering", () => {
    it("skips products with priceCents <= 0", () => {
      const body = {
        result: {
          products: [
            { id: 1, title: "A", category: "Electronics", description: "", imageUrl: "", priceCents: 0 },
            { id: 2, title: "B", category: "Books", description: "", imageUrl: "", priceCents: -5 },
            { id: 3, title: "C", category: "Toys", description: "", imageUrl: "", priceCents: 100 },
          ],
        },
        session: { gameMode: "comparison" },
      };
      const samples = extractSoloRevealedSamples(body);
      expect(samples).toHaveLength(1);
      expect(samples[0].product.id).toBe(3);
      expect(samples[0].actualCents).toBe(100);
    });

    it("skips products with non-finite priceCents", () => {
      const body = {
        result: {
          product: { id: 1, title: "A", category: "Electronics", description: "", imageUrl: "", priceCents: NaN },
        },
        session: { gameMode: "classic" },
      };
      expect(extractSoloRevealedSamples(body)).toEqual([]);
    });

    it("skips products with non-number priceCents", () => {
      const body = {
        result: {
          product: { id: 1, title: "A", category: "Electronics", description: "", imageUrl: "", priceCents: "100" },
        },
        session: { gameMode: "classic" },
      };
      expect(extractSoloRevealedSamples(body)).toEqual([]);
    });

    it("skips products missing required fields", () => {
      const body = {
        result: {
          products: [
            // missing category
            { id: 1, title: "A", description: "", imageUrl: "", priceCents: 100 },
            // missing id
            { title: "B", category: "Books", description: "", imageUrl: "", priceCents: 200 },
            // missing title
            { id: 3, category: "Toys", description: "", imageUrl: "", priceCents: 300 },
            // good
            { id: 4, title: "D", category: "Toys", description: "", imageUrl: "", priceCents: 400 },
          ],
        },
        session: { gameMode: "comparison" },
      };
      const samples = extractSoloRevealedSamples(body);
      expect(samples).toHaveLength(1);
      expect(samples[0].product.id).toBe(4);
    });
  });

  describe("optional fields", () => {
    it("preserves description and imageUrl when present", () => {
      const body = singleProductBody("classic");
      const [s] = extractSoloRevealedSamples(body);
      expect(s.product.description).toBe("desc");
      expect(s.product.imageUrl).toBe("img");
    });

    it("tolerates missing description and imageUrl", () => {
      const body = {
        result: { product: { id: 1, title: "A", category: "Electronics", priceCents: 100 } },
        session: { gameMode: "classic" },
      };
      const [s] = extractSoloRevealedSamples(body);
      expect(s.product.description).toBeUndefined();
      expect(s.product.imageUrl).toBeUndefined();
    });
  });

  describe("handles both single and multi shapes", () => {
    it("ignores `products` array on single-product modes when only `product` is present", () => {
      const body = {
        result: { product: { id: 1, title: "A", category: "Electronics", priceCents: 100 } },
        session: { gameMode: "classic" },
      };
      expect(extractSoloRevealedSamples(body)).toHaveLength(1);
    });

    it("ignores `product` field on multi-product modes when only `products` is present", () => {
      const body = multiProductBody("comparison", [100, 200]);
      expect(extractSoloRevealedSamples(body)).toHaveLength(2);
    });
  });

  // Phase 3d.2: PM/BB oracle tests removed with the modes themselves.
});
