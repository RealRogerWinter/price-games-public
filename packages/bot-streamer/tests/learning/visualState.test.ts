import { describe, expect, it } from "vitest";
import { chooseBeliefSentence, prettyFeatureName, buildTick, encodeTick } from "../../src/learning/visualState";

// Post-PR-4 the belief sentence is confidence-derived (top
// priceCandidate's probability) with a fall-through to the legacy
// feature-based copy for cold-start. The test covers both paths.

describe("chooseBeliefSentence", () => {
  it("falls back to 'Still finding the pattern…' when no signal at all", () => {
    const s = chooseBeliefSentence([{ name: "tok_pro", contribution: 0.05 }]);
    expect(s).toBe("Still finding the pattern…");
  });

  it("uses 'Looking pricey' for one positive feature above threshold (no priceCandidates)", () => {
    const s = chooseBeliefSentence([{ name: "tok_premium", contribution: 0.4 }]);
    expect(s).toMatch(/Looking pricey/i);
    expect(s).toContain("premium");
  });

  it("uses 'Cheap signal' for one negative feature above threshold", () => {
    const s = chooseBeliefSentence([{ name: "tok_basic", contribution: -0.3 }]);
    expect(s).toMatch(/Cheap signal/i);
  });

  it("uses 'Two signals pulling up' for two features above threshold (no priceCandidates)", () => {
    const s = chooseBeliefSentence([
      { name: "tok_pro", contribution: 0.4 },
      { name: "tok_wireless", contribution: 0.2 },
    ]);
    expect(s).toMatch(/Two signals/i);
    expect(s).toContain("pro");
    expect(s).toContain("wireless");
  });

  it("uses 'Pricey is sure' when top-prob ≥ 0.6", () => {
    const s = chooseBeliefSentence(
      [{ name: "tok_pro", contribution: 0.4 }],
      [{ cents: 999, prob: 0.7 }],
    );
    expect(s).toMatch(/Pricey is sure/i);
    expect(s).toContain("$9.99");
  });

  it("uses 'Leaning' when 0.3 ≤ top-prob < 0.6", () => {
    const s = chooseBeliefSentence(
      [{ name: "tok_pro", contribution: 0.4 }],
      [{ cents: 1299, prob: 0.4 }],
    );
    expect(s).toMatch(/Leaning/i);
    expect(s).toContain("$12.99");
  });

  it("falls through to feature copy when top-prob < 0.3 (cold-start)", () => {
    const s = chooseBeliefSentence(
      [{ name: "tok_premium", contribution: 0.4 }],
      [{ cents: 999, prob: 0.1 }, { cents: 1299, prob: 0.08 }],
    );
    expect(s).toMatch(/Looking pricey/i);
  });
});

describe("prettyFeatureName", () => {
  it("strips tok_ + replaces dashes with spaces", () => {
    expect(prettyFeatureName("tok_stainless-steel")).toBe("stainless steel");
  });
  it("strips mode_", () => {
    expect(prettyFeatureName("mode_classic")).toBe("classic");
  });
  it("replaces underscores in other engineered names", () => {
    expect(prettyFeatureName("log_heuristic")).toBe("log heuristic");
  });
});

function commonInputs() {
  return {
    roundId: "r1",
    phase: "result" as const,
    trunkHidden: new Float32Array(32),
    embedding: new Float32Array(16),
    recentLosses: [0.5, 0.4],
    recentAccuracy: ["within10"] as Array<"within10" | "within25" | "miss">,
    predictionCents: 1500,
    predictionSigmaCents: 200,
    vizCoord: [0.1, 0.2] as [number, number],
    topFeatures: [
      { name: "tok_pro", contribution: 0.4 },
      { name: "tok_wireless", contribution: 0.2 },
    ],
    teachingMomentTriggered: false,
    mostActiveByLayer: [
      { idx: 0, trail: [0, 0] as [number, number] },
      { idx: 0, trail: [0, 0] as [number, number] },
      { idx: 0, trail: [0, 0] as [number, number] },
    ],
    weightSamples: [],
  };
}

describe("buildTick → belief.sentence", () => {
  it("ships a sentence in the tick payload", () => {
    const tick = buildTick(commonInputs());
    expect(typeof tick.belief.sentence).toBe("string");
    // Round-trips through JSON.
    const parsed = JSON.parse(encodeTick(tick).toString("utf8"));
    expect(parsed.belief.sentence).toBe(tick.belief.sentence);
  });

  it("uses confidence copy when priceCandidates is provided with high top-prob", () => {
    const tick = buildTick({
      ...commonInputs(),
      priceCandidates: [{ cents: 1499, prob: 0.8 }],
    });
    expect(tick.belief.sentence).toMatch(/Pricey is sure/i);
    expect(tick.belief.sentence).toContain("$14.99");
  });
});

describe("buildTick → priceCandidates", () => {
  it("threads priceCandidates through to the tick payload", () => {
    const tick = buildTick({
      ...commonInputs(),
      priceCandidates: [
        { cents: 999, prob: 0.7 },
        { cents: 1299, prob: 0.2 },
      ],
    });
    expect(tick.priceCandidates).toHaveLength(2);
    expect(tick.priceCandidates?.[0]).toEqual({ cents: 999, prob: 0.7 });
    const parsed = JSON.parse(encodeTick(tick).toString("utf8"));
    expect(parsed.priceCandidates).toEqual([
      { cents: 999, prob: 0.7 },
      { cents: 1299, prob: 0.2 },
    ]);
  });

  it("omitting priceCandidates leaves the field undefined", () => {
    const tick = buildTick(commonInputs());
    expect(tick.priceCandidates).toBeUndefined();
  });
});
