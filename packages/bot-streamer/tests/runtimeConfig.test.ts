/**
 * Tests for runtimeConfig — env-var parsing for the streamer.
 *
 * These are pure-function tests; no env or process state is touched.
 * The point is to lock in that bad input is rejected (with a warning)
 * rather than silently flowing into the policy as garbage.
 */

import { describe, it, expect, vi } from "vitest";
import { parseRotation, parseModeWhitelist } from "../src/runner/runtimeConfig";

describe("parseRotation", () => {
  it("returns undefined for empty / whitespace / unset input", () => {
    expect(parseRotation(undefined)).toBeUndefined();
    expect(parseRotation("")).toBeUndefined();
    expect(parseRotation("   ")).toBeUndefined();
  });

  it("parses a comma-separated list of valid steps", () => {
    expect(parseRotation("solo,public_join,host_public")).toEqual([
      "solo",
      "public_join",
      "host_public",
    ]);
  });

  it("trims whitespace around tokens", () => {
    expect(parseRotation(" solo , host_public ")).toEqual(["solo", "host_public"]);
  });

  it("drops unknown tokens with a warning", () => {
    const warn = vi.fn();
    const result = parseRotation("solo,invalid,host_public", warn);
    expect(result).toEqual(["solo", "host_public"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/STREAMER_ROTATION/);
    expect(warn.mock.calls[0][0]).toMatch(/invalid/);
  });

  it("returns undefined when every token is invalid", () => {
    const warn = vi.fn();
    expect(parseRotation("garbage,nonsense", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("preserves duplicate steps (rotation may legitimately repeat)", () => {
    expect(parseRotation("solo,solo,solo")).toEqual(["solo", "solo", "solo"]);
  });
});

describe("parseModeWhitelist", () => {
  it("returns undefined for empty / unset input", () => {
    expect(parseModeWhitelist(undefined)).toBeUndefined();
    expect(parseModeWhitelist("")).toBeUndefined();
  });

  it("parses a comma-separated list of valid game modes", () => {
    const result = parseModeWhitelist("classic,higher-lower,budget-builder");
    expect(result).toEqual(["classic", "higher-lower", "budget-builder"]);
  });

  it("drops typos with a warning", () => {
    const warn = vi.fn();
    const result = parseModeWhitelist("classic,higer-lower,budget-builder", warn);
    expect(result).toEqual(["classic", "budget-builder"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/STREAMER_MODES/);
    expect(warn.mock.calls[0][0]).toMatch(/higer-lower/);
  });

  it("returns undefined when every mode is invalid", () => {
    const warn = vi.fn();
    expect(parseModeWhitelist("not-a-mode", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace around tokens", () => {
    expect(parseModeWhitelist(" classic , higher-lower ")).toEqual([
      "classic",
      "higher-lower",
    ]);
  });
});
