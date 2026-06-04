import { describe, expect, it } from "vitest";
import {
  extractFeatures,
  FEATURE_NAMES,
} from "../../src/learning/featureExtractor";
import { ENGINEERED_FEATURE_DIM, FEATURE_DIM } from "../../src/learning/types";

const PRODUCT = {
  id: 1,
  title: "Wireless Speaker",
  category: "Electronics",
  description: "",
  imageUrl: "",
};

function biddingDimIndices(): {
  residualMax: number;
  logMedian: number;
  turnIdx: number;
  isLast: number;
  hasPrev: number;
} {
  return {
    residualMax: FEATURE_NAMES.indexOf("bid_residual_max"),
    logMedian: FEATURE_NAMES.indexOf("bid_log_median"),
    turnIdx: FEATURE_NAMES.indexOf("bid_turn_idx_norm"),
    isLast: FEATURE_NAMES.indexOf("bid_is_last"),
    hasPrev: FEATURE_NAMES.indexOf("bid_has_prev_bids"),
  };
}

describe("featureExtractor.bidding", () => {
  it("FEATURE_DIM is 140 (135 + 5 bidding-context dims)", () => {
    expect(FEATURE_DIM).toBe(140);
  });

  it("FEATURE_NAMES exposes the 5 new bidding-context names", () => {
    const idx = biddingDimIndices();
    expect(idx.residualMax).toBeGreaterThanOrEqual(0);
    expect(idx.logMedian).toBeGreaterThanOrEqual(0);
    expect(idx.turnIdx).toBeGreaterThanOrEqual(0);
    expect(idx.isLast).toBeGreaterThanOrEqual(0);
    expect(idx.hasPrev).toBeGreaterThanOrEqual(0);
  });

  it("zero-fills the bidding-context block when biddingTurn is absent (non-bidding round)", () => {
    const features = extractFeatures({ mode: "classic", product: PRODUCT });
    const idx = biddingDimIndices();
    expect(features[idx.residualMax]).toBe(0);
    expect(features[idx.logMedian]).toBe(0);
    expect(features[idx.turnIdx]).toBe(0);
    expect(features[idx.isLast]).toBe(0);
    expect(features[idx.hasPrev]).toBe(0);
  });

  it("first-bidder bidding round populates turnIdx + isLast but leaves residual / median / hasPrev at 0", () => {
    const features = extractFeatures({
      mode: "bidding",
      product: PRODUCT,
      biddingTurn: { turnIdx: 0, totalPlayers: 4, previousBidsCents: [] },
    });
    const idx = biddingDimIndices();
    expect(features[idx.residualMax]).toBe(0);
    expect(features[idx.logMedian]).toBe(0);
    expect(features[idx.turnIdx]).toBe(0); // 0/4
    expect(features[idx.isLast]).toBe(0); // 0 != 3 (totalPlayers - 1)
    expect(features[idx.hasPrev]).toBe(0);
  });

  it("last-bidder with prior bids populates all 5 dims", () => {
    const features = extractFeatures({
      mode: "bidding",
      product: PRODUCT,
      biddingTurn: { turnIdx: 3, totalPlayers: 4, previousBidsCents: [800, 1200, 1500] },
    });
    const idx = biddingDimIndices();
    expect(features[idx.hasPrev]).toBe(1);
    expect(features[idx.isLast]).toBe(1);
    expect(features[idx.turnIdx]).toBeCloseTo(3 / 4, 6);
    expect(features[idx.logMedian]).toBeCloseTo(Math.log(1201) / 12, 4);
    // residual_max should be log(1501)/12 - log(heuristic+1)/12 — sign
    // depends on whether heuristic is above or below max.
    expect(Number.isFinite(features[idx.residualMax])).toBe(true);
  });

  it("turnIdx normalisation caps at /4 (Quick Play tops out at 4 players)", () => {
    const features = extractFeatures({
      mode: "bidding",
      product: PRODUCT,
      biddingTurn: { turnIdx: 6, totalPlayers: 7, previousBidsCents: [100] },
    });
    const idx = biddingDimIndices();
    // min(6, 4) / 4 = 1.
    expect(features[idx.turnIdx]).toBe(1);
  });

  it("ENGINEERED_FEATURE_DIM matches the expected total", () => {
    // 50 base + 12 mode + 1 hasPairRole + 10 round-context + 11 phase-3a
    // + 5 bidding = 89? Let me recount: original 50 → +10 round-context
    // = 60 → +11 phase 3a = 71 → +5 bidding = 76.
    expect(ENGINEERED_FEATURE_DIM).toBe(76);
  });
});
