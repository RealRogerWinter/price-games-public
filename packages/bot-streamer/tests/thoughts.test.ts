/**
 * Tests for the thought template library — pin the picker contract
 * (mood bias, default-pool fallback, no-repeat window) and the
 * placeholder-fill helper.
 */

import { describe, it, expect } from "vitest";
import {
  THOUGHT_LIBRARY,
  formatCents,
  fillTemplate,
  createThoughtPicker,
  pickNnPredictionThought,
  NN_CONFIDENCE_SHARP_THRESHOLD,
  NN_CONFIDENCE_WIDE_THRESHOLD,
  type ThoughtEvent,
} from "../src/tts/thoughts";
import { MOOD_LABELS } from "@price-game/shared";
import { seeded } from "./_rng";

describe("formatCents", () => {
  it("renders sub-1000 dollars as '$X.YY' without grouping", () => {
    expect(formatCents(999)).toBe("$9.99");
    expect(formatCents(1000)).toBe("$10.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("renders 1000+ dollars with comma grouping", () => {
    // 100000 cents = $1000.00 — first multi-digit dollar value where
    // toLocaleString starts inserting separators.
    expect(formatCents(100000)).toBe("$1,000.00");
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("preserves a leading minus for negative cents", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });

  it("zero-pads cents under 10", () => {
    expect(formatCents(105)).toBe("$1.05");
    expect(formatCents(100)).toBe("$1.00");
  });

  it("returns '$?' for non-finite inputs", () => {
    expect(formatCents(NaN)).toBe("$?");
    expect(formatCents(Infinity)).toBe("$?");
  });
});

describe("fillTemplate", () => {
  it("substitutes named placeholders from the payload", () => {
    expect(fillTemplate("Hi ${featureName}", { featureName: "brand" })).toBe("Hi brand");
  });

  it("auto-formats *Cents fields via formatCents", () => {
    // The picker contract is: templates write `${predictedCents}` and
    // get back a `$9.99`-style string, not the raw integer.
    expect(fillTemplate("Bid ${bidCents}", { bidCents: 999 })).toBe("Bid $9.99");
  });

  it("renders '?' for unsupplied fields rather than throwing", () => {
    // A stale caller passing a partial payload should produce a
    // slightly-degraded thought, not crash the runtime.
    expect(fillTemplate("predicted ${predictedCents}", {})).toBe("predicted ?");
  });

  it("substitutes multiple placeholders in one template", () => {
    expect(fillTemplate("${predictedCents} ± ${sigmaCents}", {
      predictedCents: 999,
      sigmaCents: 240,
    })).toBe("$9.99 ± $2.40");
  });
});

describe("THOUGHT_LIBRARY contract", () => {
  const ALL_EVENTS = Object.keys(THOUGHT_LIBRARY) as ThoughtEvent[];

  it("every event has a non-empty default pool", () => {
    for (const event of ALL_EVENTS) {
      expect(THOUGHT_LIBRARY[event].default.length).toBeGreaterThan(0);
    }
  });

  it("no mood-tagged template collides with its event's default pool", () => {
    // Same contract as lines.ts — would cause double-weighting at
    // pick time (the same template appears in both pools so the
    // no-repeat buffer can't filter it out cleanly).
    for (const event of ALL_EVENTS) {
      const def = new Set(THOUGHT_LIBRARY[event].default);
      const byMood = THOUGHT_LIBRARY[event].byMood ?? {};
      for (const [mood, lines] of Object.entries(byMood)) {
        for (const line of lines ?? []) {
          expect(
            def.has(line),
            `Template "${line}" appears in both default and byMood.${mood} of event "${event}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("strategy_rationale renders the literal text verbatim, no template fill", () => {
    // The literal pass-through is special — payload.literalText
    // bypasses placeholder substitution entirely so rationale text
    // (which may contain `${...}` literally, dashes, math symbols,
    // anything) reaches the UI unmangled.
    const pick = createThoughtPicker({ rng: seeded(1) });
    const text = pick("strategy_rationale", "neutral", { literalText: "raw ${value} content" });
    expect(text).toBe("raw ${value} content");
  });
});

describe("createThoughtPicker", () => {
  it("returns a filled string for a basic confidence event", () => {
    const pick = createThoughtPicker({ rng: seeded(1) });
    const text = pick("nn_confidence_high", "neutral", {
      predictedCents: 999,
      sigmaCents: 100,
    });
    // Whatever template surfaces, the cents fields should be formatted.
    expect(text).toMatch(/\$\d/);
  });

  it("falls back to the default pool when the supplied mood has no entries for that event", () => {
    // nn_top_feature has byMood entries for some moods but not all
    // (e.g., elated). Per the user-approved "default-pool fallback"
    // decision: fall through to default rather than skipping.
    const pick = createThoughtPicker({ rng: seeded(2), moodBias: 1 });
    const event: ThoughtEvent = "nn_top_feature";
    const defaultPool = THOUGHT_LIBRARY[event].default;
    // Even with moodBias=1, an absent mood pool routes to default.
    const moodsWithoutPool = MOOD_LABELS.filter(
      (m) => !THOUGHT_LIBRARY[event].byMood?.[m]?.length,
    );
    expect(moodsWithoutPool.length).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) {
      const text = pick(event, moodsWithoutPool[0], { featureName: "brand" });
      const filled = defaultPool.find((t) => t.replace(/\$\{\w+\}/g, "brand") === text);
      expect(filled, `Expected "${text}" to come from default pool`).toBeDefined();
    }
  });

  it("biases toward mood pool when supplied (moodBias=1 always uses mood pool)", () => {
    const pick = createThoughtPicker({ rng: seeded(3), moodBias: 1 });
    const event: ThoughtEvent = "nn_confidence_low";
    const moodPool = THOUGHT_LIBRARY[event].byMood?.frustrated ?? [];
    expect(moodPool.length).toBeGreaterThan(0);
    let allMood = true;
    for (let i = 0; i < 30; i++) {
      const text = pick(event, "frustrated", { predictedCents: 100, sigmaCents: 50 });
      // The text was filled, so we need to compare against filled mood templates.
      const matched = moodPool.some((t) => fillTemplate(t, { predictedCents: 100, sigmaCents: 50 }) === text);
      if (!matched) {
        allMood = false;
        break;
      }
    }
    expect(allMood).toBe(true);
  });

  it("moodBias=0 reproduces default-pool-only behavior even when a mood pool exists", () => {
    const pick = createThoughtPicker({ rng: seeded(4), moodBias: 0 });
    const event: ThoughtEvent = "nn_confidence_low";
    const defaultPool = THOUGHT_LIBRARY[event].default;
    for (let i = 0; i < 30; i++) {
      const text = pick(event, "frustrated", { predictedCents: 100, sigmaCents: 50 });
      const matched = defaultPool.some((t) => fillTemplate(t, { predictedCents: 100, sigmaCents: 50 }) === text);
      expect(matched, `Expected "${text}" to come from default pool`).toBe(true);
    }
  });

  it("strategy_rationale bypasses the picker even with no mood/payload", () => {
    const pick = createThoughtPicker({ rng: seeded(5) });
    expect(pick("strategy_rationale", undefined, { literalText: "x" })).toBe("x");
  });
});

describe("pickNnPredictionThought", () => {
  // Pinned reference for the σ/μ band thresholds. The driver passes
  // through these without modification, so a shift here would silently
  // change the runtime distribution of confidence_high vs _low. The
  // explicit assertion catches anyone touching the constants without
  // updating the contract.
  it("threshold constants are stable", () => {
    expect(NN_CONFIDENCE_SHARP_THRESHOLD).toBe(0.15);
    expect(NN_CONFIDENCE_WIDE_THRESHOLD).toBe(0.35);
  });

  it("returns nn_confidence_high when σ/μ is below the sharp threshold", () => {
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 100, // σ/μ = 0.10 → sharp
    });
    expect(r?.event).toBe("nn_confidence_high");
    expect(r?.payload).toEqual({ predictedCents: 1000, sigmaCents: 100 });
  });

  it("returns nn_confidence_low when σ/μ is above the wide threshold", () => {
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 400, // σ/μ = 0.40 → wide
    });
    expect(r?.event).toBe("nn_confidence_low");
    expect(r?.payload).toEqual({ predictedCents: 1000, sigmaCents: 400 });
  });

  it("returns nn_top_feature in the middle band when a top feature is supplied", () => {
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 250, // σ/μ = 0.25 → middle band
      topFeatureName: "brand",
    });
    expect(r?.event).toBe("nn_top_feature");
    expect(r?.payload).toEqual({ featureName: "brand" });
  });

  it("returns null when middle-band AND no top feature is supplied", () => {
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 250,
    });
    expect(r).toBeNull();
  });

  it("guards predictedCents=0 SYMMETRICALLY across both confidence arms", () => {
    // Regression: an earlier draft only guarded the _high arm. With
    // predictedCents=0 the σ/μ ratio is undefined → both arms must
    // skip and fall through to top-feature / null.
    expect(pickNnPredictionThought({ predictedCents: 0, sigmaCents: 0 })).toBeNull();
    expect(pickNnPredictionThought({ predictedCents: 0, sigmaCents: 100 })).toBeNull();
    expect(
      pickNnPredictionThought({ predictedCents: 0, sigmaCents: 100, topFeatureName: "brand" }),
    ).toEqual({ event: "nn_top_feature", payload: { featureName: "brand" } });
  });

  it("exploration_draw outranks every confidence arm when active + drawCents supplied", () => {
    // Even with a sharp posterior, an active exploration round gets
    // the off-script narration — that's the more interesting beat.
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 50, // would otherwise be confidence_high
      exploration: { active: true, drawCents: 1500 },
    });
    expect(r?.event).toBe("exploration_draw");
    expect(r?.payload).toEqual({ drawCents: 1500, predictedCents: 1000 });
  });

  it("exploration.active=false does NOT trigger exploration_draw even with drawCents present", () => {
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 100,
      exploration: { active: false, drawCents: 1500 },
    });
    expect(r?.event).toBe("nn_confidence_high");
  });

  it("exploration.active=true without drawCents falls through to confidence routing", () => {
    // Defensive: a degenerate exploration signal (active flag set
    // but no draw value) shouldn't crash or surface a "$?" line —
    // it falls through to the next priority arm.
    const r = pickNnPredictionThought({
      predictedCents: 1000,
      sigmaCents: 100,
      exploration: { active: true },
    });
    expect(r?.event).toBe("nn_confidence_high");
  });
});
