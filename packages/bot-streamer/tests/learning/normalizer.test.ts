import { describe, expect, it } from "vitest";
import { Normalizer } from "../../src/learning/normalizer";

describe("Normalizer", () => {
  it("returns raw input during warmup", () => {
    const n = new Normalizer({ dim: 3, beta: 0.99, warmupSamples: 32, eps: 1e-8 });
    n.observe(new Float32Array([10, 20, 30]));
    const out = n.normalize(new Float32Array([10, 20, 30]));
    expect(Array.from(out)).toEqual([10, 20, 30]);
  });

  it("converges to ~0 mean after enough samples from a stationary distribution", () => {
    const n = new Normalizer({ dim: 1, beta: 0.97, warmupSamples: 5, eps: 1e-8 });
    let lastNorm = 0;
    let prng = 11;
    for (let s = 0; s < 5000; s++) {
      // Fixed-stddev signal centred at 100.
      prng = (prng * 9301 + 49297) % 233280;
      const u1 = Math.max(prng / 233280, Number.EPSILON);
      prng = (prng * 9301 + 49297) % 233280;
      const u2 = prng / 233280;
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const x = 100 + 5 * z;
      n.observe(new Float32Array([x]));
      lastNorm = n.normalize(new Float32Array([100]))[0];
    }
    // After many samples, normalizing the *mean* should give ~0.
    expect(Math.abs(lastNorm)).toBeLessThan(0.5);
    expect(Math.abs(n.mean[0] - 100)).toBeLessThan(2);
    expect(Math.abs(n.variance[0] - 25)).toBeLessThan(8);
  });

  it("eps prevents division by zero on a constant feature", () => {
    const n = new Normalizer({ dim: 1, beta: 0.99, warmupSamples: 1, eps: 1e-6 });
    for (let i = 0; i < 50; i++) n.observe(new Float32Array([7]));
    const out = n.normalize(new Float32Array([7]));
    expect(Number.isFinite(out[0])).toBe(true);
  });

  it("rejects dim mismatch", () => {
    const n = new Normalizer({ dim: 3, beta: 0.99, warmupSamples: 1, eps: 1e-8 });
    expect(() => n.observe(new Float32Array(2))).toThrow();
    expect(() => n.normalize(new Float32Array(4))).toThrow();
  });

  it("serialise round-trips", () => {
    const n = new Normalizer({ dim: 3, beta: 0.99, warmupSamples: 1, eps: 1e-8 });
    n.observe(new Float32Array([1, 2, 3]));
    n.observe(new Float32Array([2, 4, 6]));
    n.observe(new Float32Array([3, 6, 9]));
    const buf = n.serialize();
    const m = Normalizer.deserialize(buf, n.opts);
    expect(m.count).toBe(n.count);
    expect(Array.from(m.mean)).toEqual(Array.from(n.mean));
    expect(Array.from(m.variance)).toEqual(Array.from(n.variance));
  });
});
