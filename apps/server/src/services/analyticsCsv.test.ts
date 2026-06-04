import { describe, it, expect } from "vitest";
import { csvEscape, toCsv } from "./analyticsCsv";

describe("csvEscape", () => {
  it("wraps plain strings in double quotes", () => {
    expect(csvEscape("hello")).toBe('"hello"');
  });

  it("doubles embedded quotes", () => {
    expect(csvEscape('hello "world"')).toBe('"hello ""world"""');
  });

  it("handles commas and newlines inside quoted fields", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  it("neutralizes CSV-injection prefixes", () => {
    expect(csvEscape("=SUM(A1)")).toBe("\"'=SUM(A1)\"");
    expect(csvEscape("+1234")).toBe("\"'+1234\"");
    expect(csvEscape("-1234")).toBe("\"'-1234\"");
    expect(csvEscape("@evil")).toBe("\"'@evil\"");
    expect(csvEscape("\tleading-tab")).toBe("\"'\tleading-tab\"");
    expect(csvEscape("\rleading-cr")).toBe("\"'\rleading-cr\"");
    expect(csvEscape("\nleading-lf")).toBe("\"'\nleading-lf\"");
  });

  it("handles a value that is ONLY an injection prefix char", () => {
    expect(csvEscape("=")).toBe("\"'=\"");
  });

  it("coerces non-string values", () => {
    expect(csvEscape(42)).toBe('"42"');
    expect(csvEscape(null)).toBe('""');
    expect(csvEscape(undefined)).toBe('""');
    expect(csvEscape(true)).toBe('"true"');
  });
});

describe("toCsv", () => {
  it("returns empty string for empty input", () => {
    expect(toCsv([])).toBe("");
  });

  it("writes a header row from the first record's keys", () => {
    const csv = toCsv([{ a: 1, b: 2 }]);
    expect(csv.startsWith('"a","b"')).toBe(true);
  });

  it("serializes multiple rows with CRLF line endings", () => {
    const csv = toCsv([
      { name: "foo", count: 1 },
      { name: "bar", count: 2 },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('"name","count"');
    expect(lines[1]).toBe('"foo","1"');
    expect(lines[2]).toBe('"bar","2"');
  });

  it("fills missing keys with empty strings", () => {
    const csv = toCsv([
      { a: 1, b: 2 },
      { a: 3 } as unknown as Record<string, unknown>,
    ]);
    const lines = csv.split("\r\n");
    expect(lines[2]).toBe('"3",""');
  });

  it("unions keys across all rows (extra keys on later rows are NOT dropped)", () => {
    const csv = toCsv([
      { a: 1, b: 2 } as unknown as Record<string, unknown>,
      { a: 3, c: 4 } as unknown as Record<string, unknown>,
    ]);
    const lines = csv.split("\r\n");
    // Header should include a, b, c in first-seen order.
    expect(lines[0]).toBe('"a","b","c"');
    // First row: a=1, b=2, c missing.
    expect(lines[1]).toBe('"1","2",""');
    // Second row: a=3, b missing, c=4.
    expect(lines[2]).toBe('"3","","4"');
  });
});
