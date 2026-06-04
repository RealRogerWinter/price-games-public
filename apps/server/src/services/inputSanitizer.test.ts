import { describe, it, expect } from "vitest";
import { sanitizeName, sanitizePassword, containsProfanity } from "./inputSanitizer";

describe("sanitizeName", () => {
  it("trims whitespace and collapses internal spaces", () => {
    expect(sanitizeName("  hello   world  ")).toBe("hello world");
  });

  it("strips HTML tags", () => {
    expect(sanitizeName("<b>bold</b>")).toBe("bold");
    expect(sanitizeName("<script>alert(1)</script>")).toBe("alert(1)");
  });

  it("strips control characters", () => {
    expect(sanitizeName("test\x00\x01name")).toBe("testname");
  });

  it("enforces max length", () => {
    const long = "a".repeat(50);
    expect(sanitizeName(long, 20).length).toBe(20);
  });

  it("uses default max length of 20", () => {
    const long = "a".repeat(30);
    expect(sanitizeName(long).length).toBe(20);
  });

  it("throws for empty string", () => {
    expect(() => sanitizeName("")).toThrow("Name is required");
  });

  it("throws for whitespace-only string", () => {
    expect(() => sanitizeName("   ")).toThrow("Name is required");
  });

  it("throws for non-string input", () => {
    expect(() => sanitizeName(null as any)).toThrow("Name is required");
    expect(() => sanitizeName(undefined as any)).toThrow("Name is required");
  });

  it("throws for profane names", () => {
    expect(() => sanitizeName("fuckface")).toThrow("not allowed");
  });

  it("allows clean names", () => {
    expect(sanitizeName("Player1")).toBe("Player1");
    expect(sanitizeName("Cool Guy")).toBe("Cool Guy");
  });
});

describe("sanitizePassword", () => {
  it("returns null for empty/falsy input", () => {
    expect(sanitizePassword("")).toBeNull();
    expect(sanitizePassword(null)).toBeNull();
    expect(sanitizePassword(undefined)).toBeNull();
  });

  it("strips HTML tags", () => {
    expect(sanitizePassword("<b>pass</b>")).toBe("pass");
  });

  it("trims whitespace", () => {
    expect(sanitizePassword("  secret  ")).toBe("secret");
  });

  it("enforces max length of 32", () => {
    const long = "a".repeat(50);
    expect(sanitizePassword(long)!.length).toBe(32);
  });

  it("returns null for whitespace-only input", () => {
    expect(sanitizePassword("   ")).toBeNull();
  });

  it("preserves valid passwords", () => {
    expect(sanitizePassword("mypassword123")).toBe("mypassword123");
  });
});

describe("containsProfanity", () => {
  it("detects common profanity", () => {
    expect(containsProfanity("fuck")).toBe(true);
    expect(containsProfanity("shit")).toBe(true);
  });

  it("detects case-insensitive profanity", () => {
    expect(containsProfanity("FUCK")).toBe(true);
    expect(containsProfanity("Shit")).toBe(true);
  });

  it("detects profanity embedded in text", () => {
    expect(containsProfanity("FuckYou")).toBe(true);
    expect(containsProfanity("shithead")).toBe(true);
  });

  it("detects spaced-out profanity", () => {
    expect(containsProfanity("f u c k")).toBe(true);
    expect(containsProfanity("f-u-c-k")).toBe(true);
  });

  it("detects leetspeak", () => {
    expect(containsProfanity("fvck")).toBe(false); // 'v' not in leet map
    expect(containsProfanity("$h1t")).toBe(true); // $ -> s, 1 -> i
  });

  it("returns false for clean text", () => {
    expect(containsProfanity("hello")).toBe(false);
    expect(containsProfanity("Player1")).toBe(false);
    expect(containsProfanity("CoolName")).toBe(false);
  });

  it("returns false for empty/null input", () => {
    expect(containsProfanity("")).toBe(false);
    expect(containsProfanity(null as any)).toBe(false);
  });

  it("detects slurs", () => {
    expect(containsProfanity("nigger")).toBe(true);
    expect(containsProfanity("faggot")).toBe(true);
    expect(containsProfanity("retard")).toBe(true);
  });
});
