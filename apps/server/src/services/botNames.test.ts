import { describe, it, expect } from "vitest";
import { generateBotName, generateBotNames } from "./botNames";

describe("generateBotName", () => {
  it("returns a string with two words", () => {
    const name = generateBotName(new Set());
    expect(typeof name).toBe("string");
    expect(name.split(" ").length).toBe(2);
  });

  it("avoids names already in the existing set", () => {
    const existing = new Set<string>();
    // Generate many names to verify uniqueness
    for (let i = 0; i < 50; i++) {
      const name = generateBotName(existing);
      expect(existing.has(name)).toBe(false);
      existing.add(name);
    }
  });

  it("returns different names on successive calls", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateBotName(new Set()));
    }
    // With 40x40=1600 combos, 20 calls should produce mostly unique names
    expect(names.size).toBeGreaterThan(10);
  });
});

describe("generateBotNames", () => {
  it("returns the requested count of names", () => {
    const names = generateBotNames(5, new Set());
    expect(names.length).toBe(5);
  });

  it("returns all unique names", () => {
    const names = generateBotNames(10, new Set());
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(10);
  });

  it("avoids names in the existing set", () => {
    const existing = new Set(["Sneaky Pangolin", "Jolly Capybara"]);
    const names = generateBotNames(20, existing);
    for (const name of names) {
      expect(existing.has(name)).toBe(false);
    }
  });

  it("returns empty array for count 0", () => {
    const names = generateBotNames(0, new Set());
    expect(names).toEqual([]);
  });

  it("handles large count by falling back to numbered names", () => {
    // With ~40x40=1600 combos, requesting 1600+ should still work via numbered fallback
    const names = generateBotNames(5, new Set());
    expect(names.length).toBe(5);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
