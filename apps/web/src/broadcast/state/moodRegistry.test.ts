/**
 * Tests for the shared mood registry. The registry is the single
 * source of truth for the bot's mood vocabulary — these tests pin
 * the contract so an accidental drift (renamed label, missing
 * descriptor row, broken hex colour) trips CI before reaching the
 * overlay.
 */

import { describe, it, expect } from "vitest";
import { MOOD_LABELS, MOOD_REGISTRY, DEFAULT_MOOD, isMood, type Mood } from "@price-game/shared";

describe("mood registry", () => {
  it("MOOD_LABELS contains the expected canonical set (8 labels after PR 4)", () => {
    // Order is rendering precedence — preserve it. Grouped roughly by
    // valence: neutral, then positive (happy/confident/elated), then
    // focused (a "concentrating" valence between positive and
    // negative), then negative (tilted/frustrated/despondent).
    expect(MOOD_LABELS).toEqual([
      "neutral",
      "happy",
      "confident",
      "elated",
      "focused",
      "tilted",
      "frustrated",
      "despondent",
    ]);
  });

  it("DEFAULT_MOOD is a member of MOOD_LABELS", () => {
    expect(MOOD_LABELS.includes(DEFAULT_MOOD)).toBe(true);
    expect(DEFAULT_MOOD).toBe("neutral");
  });

  it("MOOD_REGISTRY has a descriptor for every label, and no extras", () => {
    const registryKeys = Object.keys(MOOD_REGISTRY).sort();
    const labelKeys = [...MOOD_LABELS].sort();
    expect(registryKeys).toEqual(labelKeys);
  });

  it("each descriptor has a label that round-trips to its key", () => {
    for (const label of MOOD_LABELS) {
      expect(MOOD_REGISTRY[label].label).toBe(label);
    }
  });

  it("each descriptor has a non-empty displayLabel, emoji, and description", () => {
    for (const label of MOOD_LABELS) {
      const d = MOOD_REGISTRY[label];
      expect(d.displayLabel.length).toBeGreaterThan(0);
      expect(d.emoji.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it("each descriptor's color is a 7-char hex value", () => {
    // The indicator panel renders this verbatim into CSS — guard
    // against accidentally introducing a named colour or rgb() form
    // that would skew the layout's colour palette.
    for (const label of MOOD_LABELS) {
      expect(MOOD_REGISTRY[label].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("colors are unique per mood — viewers can't tell two moods apart otherwise", () => {
    const colors = MOOD_LABELS.map((m) => MOOD_REGISTRY[m].color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("every descriptor's spriteFallback is the identity (PR 5 ships dedicated sprites for all 8 moods)", () => {
    // PR 4 added the spriteFallback field as a way to map the new 4
    // moods onto the existing 4 anchor sprite assets. PR 5 generated
    // dedicated body sprites for the new moods so spriteFallback
    // collapses to the identity — every mood's fallback is itself.
    // Field is kept on the descriptor for forward-compat: a future
    // PR that adds a new mood without sprites can fall back to an
    // anchor without touching Avatar.
    for (const label of MOOD_LABELS) {
      expect(MOOD_REGISTRY[label].spriteFallback).toBe(label);
    }
  });

  it("each descriptor carries a prosody.lengthScale in the practical Piper range [0.85, 1.20]", () => {
    // Outside that range Piper either clips syllables (too fast) or
    // sounds drugged (too slow). The bounds bracket every defensible
    // mood; a future tweak that goes beyond them should be a
    // deliberate choice (with a comment) rather than a typo.
    for (const label of MOOD_LABELS) {
      const ls = MOOD_REGISTRY[label].prosody.lengthScale;
      expect(ls, `${label} prosody.lengthScale out of range`).toBeGreaterThanOrEqual(0.85);
      expect(ls, `${label} prosody.lengthScale out of range`).toBeLessThanOrEqual(1.20);
    }
  });

  it("prosody pacing matches mood polarity (positive moods speak faster, negative slower)", () => {
    // Pin the qualitative direction so a future tuning pass can't
    // accidentally invert the mapping (e.g. setting despondent to
    // 0.90 would make Pricey sound chipper while reading a defeat
    // line — exactly the wrong signal).
    expect(MOOD_REGISTRY.neutral.prosody.lengthScale).toBe(1.0);
    expect(MOOD_REGISTRY.elated.prosody.lengthScale).toBeLessThan(MOOD_REGISTRY.happy.prosody.lengthScale);
    expect(MOOD_REGISTRY.happy.prosody.lengthScale).toBeLessThan(1.0);
    expect(MOOD_REGISTRY.frustrated.prosody.lengthScale).toBeGreaterThan(1.0);
    expect(MOOD_REGISTRY.despondent.prosody.lengthScale).toBeGreaterThan(MOOD_REGISTRY.frustrated.prosody.lengthScale);
  });
});

describe("isMood guard", () => {
  it("accepts every canonical label", () => {
    for (const label of MOOD_LABELS) {
      expect(isMood(label)).toBe(true);
    }
  });

  it("rejects unknown strings, non-strings, and nullish values", () => {
    expect(isMood("evil-laugh")).toBe(false);
    expect(isMood("")).toBe(false);
    expect(isMood("HAPPY")).toBe(false); // case-sensitive; allowlist is lowercase
    expect(isMood(null)).toBe(false);
    expect(isMood(undefined)).toBe(false);
    expect(isMood(42)).toBe(false);
    expect(isMood({ label: "happy" })).toBe(false);
  });

  it("narrows to Mood at compile time", () => {
    // Compile-time guarantee that the type guard works as expected —
    // the assignment below would fail typecheck if isMood didn't
    // narrow `s` to Mood.
    const s: unknown = "happy";
    if (isMood(s)) {
      const m: Mood = s;
      expect(m).toBe("happy");
    }
  });
});
