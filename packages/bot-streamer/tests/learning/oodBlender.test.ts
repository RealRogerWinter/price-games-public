import { describe, expect, it } from "vitest";
import { OODBlender } from "../../src/learning/oodBlender";

describe("OODBlender", () => {
  it("blend weight is 0 with no observations", () => {
    const o = new OODBlender();
    expect(o.blendWeightNN(0)).toBeCloseTo(0, 6);
  });

  it("blend weight monotonic in n_seen", () => {
    const o = new OODBlender();
    let prev = 0;
    for (let n = 1; n <= 100; n++) {
      o.observe(0, 1000);
      const w = o.blendWeightNN(0);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = w;
    }
    expect(prev).toBeGreaterThan(0.99);
  });

  it("running mean+variance match offline calculation", () => {
    const o = new OODBlender();
    const samples = [100, 200, 300, 400, 500, 600];
    for (const x of samples) o.observe(0, x);
    const logs = samples.map((x) => Math.log(x));
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length;
    expect(o.meanLog[0]).toBeCloseTo(mean, 4);
    expect(o.varLog[0]).toBeCloseTo(variance, 4);
  });

  it("blendWeightNN dampens for unfamiliar categories and saturates with observations", () => {
    // Pre-PR-4 the blender exposed a `blendMu` helper that scaled an
    // NN-supplied μ by the per-category blend weight. The classifier
    // architecture doesn't expose μ, so blendMu was removed; the weight
    // itself is still the meaningful quantity (it gates the blender's
    // entropy-based exploration signal in adaptiveEpsilon).
    const o = new OODBlender();
    expect(o.blendWeightNN(5)).toBeCloseTo(0, 6);
    for (let i = 0; i < 100; i++) o.observe(5, 100);
    expect(o.blendWeightNN(5)).toBeGreaterThan(0.99);
  });

  it("entropy is increasing in σ²", () => {
    const o1 = new OODBlender();
    const o2 = new OODBlender();
    for (let i = 0; i < 50; i++) o1.observe(0, 100); // tight
    for (let i = 0; i < 50; i++) o2.observe(0, 1 + i * 200); // wide
    expect(o2.entropyAt(0)).toBeGreaterThan(o1.entropyAt(0));
  });

  it("medianCalibratedSigma defaults sensibly", () => {
    const o = new OODBlender();
    expect(o.medianCalibratedSigma()).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 30; i++) {
      o.observe(0, 100 + i);
      o.observe(1, 200 + i);
    }
    expect(o.medianCalibratedSigma()).toBeGreaterThan(0);
  });

  it("ignores invalid input", () => {
    const o = new OODBlender();
    o.observe(0, 0);
    o.observe(0, -50);
    o.observe(-1, 100);
    o.observe(1000, 100);
    expect(o.counts[0]).toBe(0);
  });

  it("serialise round-trips", () => {
    const o = new OODBlender();
    for (let i = 0; i < 12; i++) o.observe(2, 200 + i * 11);
    for (let i = 0; i < 7; i++) o.observe(5, 50 + i);
    const buf = o.serialize();
    const o2 = OODBlender.deserialize(buf);
    expect(o2.counts[2]).toBe(o.counts[2]);
    expect(o2.counts[5]).toBe(o.counts[5]);
    expect(o2.meanLog[2]).toBeCloseTo(o.meanLog[2], 5);
    expect(o2.varLog[5]).toBeCloseTo(o.varLog[5], 5);
  });

  it("priorOverCatalog is uniform when category has zero observations", () => {
    const o = new OODBlender();
    const logPrices = [Math.log(100), Math.log(500), Math.log(1000), Math.log(5000)];
    const prior = o.priorOverCatalog(7, logPrices);
    expect(prior.length).toBe(4);
    let s = 0;
    for (const p of prior) {
      expect(p).toBeCloseTo(0.25, 5);
      s += p;
    }
    expect(s).toBeCloseTo(1, 5);
  });

  it("priorOverCatalog peaks at the catalog class nearest the category mean", () => {
    const o = new OODBlender();
    // Seed category 3 with prices around $10 (1000 cents) → mean log ≈ log(1000).
    for (let i = 0; i < 30; i++) o.observe(3, 1000);
    const logPrices = [Math.log(100), Math.log(500), Math.log(1000), Math.log(5000)];
    const prior = o.priorOverCatalog(3, logPrices);
    let argmax = 0;
    for (let i = 1; i < prior.length; i++) if (prior[i] > prior[argmax]) argmax = i;
    expect(argmax).toBe(2); // index 2 = log(1000), the seeded mean
    let s = 0;
    for (const p of prior) s += p;
    expect(s).toBeCloseTo(1, 5);
  });

  it("priorOverCatalog returns valid distribution under variance floor", () => {
    const o = new OODBlender();
    // Single observation → varLog stays at default 0.5; with the
    // variance floor in priorOverCatalog (0.25), the prior is broad
    // and finite.
    o.observe(8, 999);
    const logPrices = [Math.log(100), Math.log(1000), Math.log(10000)];
    const prior = o.priorOverCatalog(8, logPrices);
    let s = 0;
    for (const p of prior) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      s += p;
    }
    expect(s).toBeCloseTo(1, 5);
  });
});
