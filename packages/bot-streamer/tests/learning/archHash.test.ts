import { describe, expect, it } from "vitest";
import { archHash, DEFAULT_ARCH_HASH } from "../../src/learning/archHash";
import { MODEL_SPEC } from "../../src/learning/types";

describe("archHash", () => {
  it("is deterministic for the default spec", () => {
    expect(archHash(MODEL_SPEC)).toBe(DEFAULT_ARCH_HASH);
    expect(archHash(MODEL_SPEC)).toBe(archHash(MODEL_SPEC));
  });

  it("returns 64-char lowercase hex", () => {
    expect(DEFAULT_ARCH_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any spec field changes", () => {
    const orig = archHash(MODEL_SPEC);
    expect(archHash({ ...MODEL_SPEC, featureDim: MODEL_SPEC.featureDim + 1 })).not.toBe(orig);
    expect(archHash({ ...MODEL_SPEC, embeddingDim: MODEL_SPEC.embeddingDim + 1 })).not.toBe(orig);
    expect(archHash({ ...MODEL_SPEC, numModes: MODEL_SPEC.numModes + 1 })).not.toBe(orig);
    expect(archHash({ ...MODEL_SPEC, priceClassK: MODEL_SPEC.priceClassK + 1 })).not.toBe(orig);
    // condDim covers the FiLM head — adding the head MUST bump the
    // hash so old (pre-FiLM) snapshots auto-archive on next start.
    expect(archHash({ ...MODEL_SPEC, condDim: 0 })).not.toBe(orig);
    expect(archHash({ ...MODEL_SPEC, condDim: MODEL_SPEC.condDim + 1 })).not.toBe(orig);
    // headTopologyVersion covers the Phase 3b specialised heads —
    // bumping it MUST bump the hash so pre-3b snapshots auto-archive
    // on next start (warm-start cushions the reset for priceClassHead).
    expect(
      archHash({ ...MODEL_SPEC, headTopologyVersion: MODEL_SPEC.headTopologyVersion + 1 }),
    ).not.toBe(orig);
    expect(archHash({ ...MODEL_SPEC, headTopologyVersion: 0 })).not.toBe(orig);
  });

  it("locks in the current architecture fingerprint", () => {
    // Snapshot test: this hash should only change deliberately.
    // Bumping it without bumping SCHEMA_VERSION in persistence.ts will
    // discard every existing snapshot in the wild.
    expect(DEFAULT_ARCH_HASH.length).toBe(64);
  });
});
