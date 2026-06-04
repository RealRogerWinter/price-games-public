/**
 * Tiny deterministic RNG helper for realism-layer tests. Mulberry32 PRNG
 * — fast, well-distributed, and seedable, so test outputs are stable
 * across runs and platforms.
 */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Repeat `n` runs of `gen`, returning the array of samples. Useful for
 * statistical assertions on a distribution shape.
 */
export function sampleMany<T>(n: number, gen: () => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(gen());
  return out;
}
