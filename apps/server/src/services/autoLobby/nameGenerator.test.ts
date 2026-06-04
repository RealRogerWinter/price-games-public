import { describe, it, expect } from "vitest";
import {
  generateHumanStyleName,
  generateHumanStyleNames,
  HUMAN_NAME_POOL_SIZE,
} from "./nameGenerator";

describe("generateHumanStyleName", () => {
  it("returns a non-empty string", () => {
    const n = generateHumanStyleName(new Set());
    expect(typeof n).toBe("string");
    expect(n.length).toBeGreaterThan(0);
  });

  it("avoids names already taken", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = generateHumanStyleName(taken);
      expect(taken.has(n)).toBe(false);
      taken.add(n);
    }
  });

  it("never produces the existing 'Adjective Animal' bot-name pattern", () => {
    // Names with a single space + capitalized words are the legacy bot-name
    // pattern. Disguised names must be distinguishable so a player who pattern-
    // matches on capitalized two-word names sees only the labeled bots.
    for (let i = 0; i < 100; i++) {
      const n = generateHumanStyleName(new Set());
      const capitalizedTwoWord = /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(n);
      expect(capitalizedTwoWord).toBe(false);
    }
  });

  it("falls back deterministically when the pool is exhausted", () => {
    // Pre-fill with every possible base name so the generator is forced into
    // its numbered fallback path.
    const taken = new Set<string>();
    for (let i = 0; i < HUMAN_NAME_POOL_SIZE * 5; i++) {
      const n = generateHumanStyleName(taken);
      taken.add(n);
    }
    expect(taken.size).toBeGreaterThan(HUMAN_NAME_POOL_SIZE);
  });
});

describe("generateHumanStyleNames", () => {
  it("returns the requested count, all unique", () => {
    const names = generateHumanStyleNames(8, new Set());
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });

  it("respects the existing-names set", () => {
    const existing = new Set(["mike_42", "sarahxo"]);
    const names = generateHumanStyleNames(4, existing);
    for (const n of names) {
      expect(existing.has(n)).toBe(false);
    }
  });

  it("base pool is at least 400 entries", () => {
    expect(HUMAN_NAME_POOL_SIZE).toBeGreaterThanOrEqual(400);
  });
});
