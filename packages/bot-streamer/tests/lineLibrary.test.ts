/**
 * Coverage assertions over LINE_LIBRARY. Pricey's "voice" depends on
 * each mood having a substantial pool of distinct lines so the
 * picker's no-repeat buffer doesn't loop the same handful of utterances
 * in a single stream session. These tests pin the contract:
 *
 *   - every mood in MOOD_LABELS gets ≥20 distinct mood-tagged lines
 *     across the library (idle_chatter + reactive events combined)
 *   - no mood-tagged line is duplicated within a mood's pool
 *   - mood-tagged lines never collide with the corresponding event's
 *     default pool (would cause double-weighting at pick time)
 *   - every event has a non-empty default pool (mood-agnostic floor)
 *   - the global vocabulary itself contains no duplicates across
 *     events / pools — a stray copy-paste would silently bias the
 *     picker
 */

import { describe, it, expect } from "vitest";
import { LINE_LIBRARY, modeChangeEventForMode, type LineEvent } from "../src/tts/lines";
import { MOOD_LABELS, type Mood } from "@price-game/shared";

const ALL_EVENTS = Object.keys(LINE_LIBRARY) as LineEvent[];

function moodLinesAcrossLibrary(mood: Mood): string[] {
  const lines: string[] = [];
  for (const event of ALL_EVENTS) {
    const m = LINE_LIBRARY[event].byMood?.[mood];
    if (m) lines.push(...m);
  }
  return lines;
}

describe("LINE_LIBRARY coverage", () => {
  it("every event has a non-empty default pool", () => {
    for (const event of ALL_EVENTS) {
      expect(LINE_LIBRARY[event].default.length).toBeGreaterThan(0);
    }
  });

  it.each(MOOD_LABELS.map((m) => [m]))(
    "mood %s has at least 20 distinct mood-tagged lines across the library",
    (mood) => {
      const lines = moodLinesAcrossLibrary(mood);
      expect(lines.length).toBeGreaterThanOrEqual(20);
      expect(new Set(lines).size).toBe(lines.length);
    },
  );

  it("no mood-tagged line collides with its event's default pool", () => {
    for (const event of ALL_EVENTS) {
      const def = new Set(LINE_LIBRARY[event].default);
      const byMood = LINE_LIBRARY[event].byMood ?? {};
      for (const [mood, lines] of Object.entries(byMood)) {
        for (const line of lines ?? []) {
          expect(
            def.has(line),
            `Line "${line}" appears in both default and byMood.${mood} of event "${event}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("no line text is duplicated anywhere in the library", () => {
    const seen = new Map<string, string>();
    for (const event of ALL_EVENTS) {
      for (const line of LINE_LIBRARY[event].default) {
        const key = `${event}/default`;
        const prev = seen.get(line);
        expect(
          prev,
          `Duplicate line "${line}" in ${key} (also in ${prev})`,
        ).toBeUndefined();
        seen.set(line, key);
      }
      const byMood = LINE_LIBRARY[event].byMood ?? {};
      for (const [mood, lines] of Object.entries(byMood)) {
        for (const line of lines ?? []) {
          const key = `${event}/byMood.${mood}`;
          const prev = seen.get(line);
          expect(
            prev,
            `Duplicate line "${line}" in ${key} (also in ${prev})`,
          ).toBeUndefined();
          seen.set(line, key);
        }
      }
    }
  });

  it("idle_chatter covers all 8 moods (used as the random-interjection bank)", () => {
    const byMood = LINE_LIBRARY.idle_chatter.byMood ?? {};
    for (const mood of MOOD_LABELS) {
      const lines = byMood[mood] ?? [];
      expect(
        lines.length,
        `idle_chatter byMood.${mood} should be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("modeChangeEventForMode", () => {
  // The 12 GameMode slugs from packages/shared/src/types.ts. Pinned
  // here as a fixture so a future mode addition either gets a
  // matching `mode_change_<mode>` event added (test still passes) OR
  // is consciously left to fall back to the generic `mode_change`
  // (test requires updating this list).
  const ALL_MODES = [
    "classic",
    "higher-lower",
    "comparison",
    "closest-without-going-over",
    "price-match",
    "riser",
    "odd-one-out",
    "market-basket",
    "sort-it-out",
    "budget-builder",
    "chain-reaction",
    "bidding",
  ] as const;

  it.each(ALL_MODES.map((m) => [m]))(
    "every game mode resolves to a defined per-mode event (%s)",
    (mode) => {
      const event = modeChangeEventForMode(mode);
      expect(event, `mode "${mode}" should map to a defined LineEvent`).toBeDefined();
      // The resolved event must exist in LINE_LIBRARY with a non-
      // empty default pool — otherwise the picker would draw nothing.
      expect(LINE_LIBRARY[event!].default.length).toBeGreaterThan(0);
    },
  );

  it("returns undefined for an unknown mode (caller falls back to generic mode_change)", () => {
    expect(modeChangeEventForMode("not-a-real-mode")).toBeUndefined();
  });

  it("converts kebab-case slugs to snake_case event names", () => {
    // The slug "higher-lower" must look up "mode_change_higher_lower",
    // not "mode_change_higher-lower" (hyphens aren't legal in TS
    // identifiers, so the LineEvent union uses underscores).
    expect(modeChangeEventForMode("higher-lower")).toBe("mode_change_higher_lower");
    expect(modeChangeEventForMode("closest-without-going-over")).toBe("mode_change_closest_without_going_over");
  });
});
