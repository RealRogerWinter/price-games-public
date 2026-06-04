import { describe, it, expect } from "vitest";
import { planMousePath, jitterClickPoint } from "../src/realism/mouse";
import { seeded } from "./_rng";

describe("planMousePath", () => {
  it("returns at least `steps` waypoints, in non-decreasing time", () => {
    const path = planMousePath(
      { x: 0, y: 0 },
      { x: 400, y: 200 },
      { rng: seeded(1), steps: 16, durationMs: 500, forceOvershoot: false },
    );
    expect(path.length).toBeGreaterThanOrEqual(16);
    for (let i = 1; i < path.length; i++) {
      expect(path[i].t).toBeGreaterThanOrEqual(path[i - 1].t);
    }
  });

  it("ends at the target when no overshoot is forced", () => {
    const to = { x: 400, y: 200 };
    const path = planMousePath({ x: 0, y: 0 }, to, {
      rng: seeded(1),
      steps: 16,
      forceOvershoot: false,
    });
    const last = path[path.length - 1];
    expect(Math.abs(last.x - to.x)).toBeLessThan(1);
    expect(Math.abs(last.y - to.y)).toBeLessThan(1);
  });

  it("appends correction waypoints when overshoot is forced", () => {
    const to = { x: 400, y: 200 };
    const path = planMousePath({ x: 0, y: 0 }, to, {
      rng: seeded(2),
      steps: 16,
      forceOvershoot: true,
    });
    // Overshoot adds 4 correction waypoints after the curve completes.
    expect(path.length).toBe(20);
    const last = path[path.length - 1];
    expect(Math.abs(last.x - to.x)).toBeLessThan(1);
    expect(Math.abs(last.y - to.y)).toBeLessThan(1);
  });

  it("clamps duration to the [240, 1100] range (Fitts-aware bounds)", () => {
    // Bounds widened in B2: 240ms floor lets snappier near-target moves
    // through (anything faster crosses the perceptual "this is an
    // animation" threshold and reads as a teleport again); 1100ms
    // ceiling caps the longest deliberate moves to small far targets.
    const tooShort = planMousePath({ x: 0, y: 0 }, { x: 100, y: 100 }, {
      rng: seeded(3),
      steps: 8,
      durationMs: 50,
      forceOvershoot: false,
    });
    expect(tooShort[tooShort.length - 1].t).toBe(240);

    const tooLong = planMousePath({ x: 0, y: 0 }, { x: 100, y: 100 }, {
      rng: seeded(3),
      steps: 8,
      durationMs: 9999,
      forceOvershoot: false,
    });
    expect(tooLong[tooLong.length - 1].t).toBe(1100);
  });

  it("scales duration with target distance/width when targetWidth is provided (Fitts)", () => {
    // Far + small target → longer duration. Near + large target →
    // shorter duration. Both stay in the [240, 1100] envelope.
    const farSmall = planMousePath({ x: 0, y: 0 }, { x: 1500, y: 800 }, {
      rng: seeded(1),
      steps: 8,
      targetWidth: 30,
      forceOvershoot: false,
    });
    const nearLarge = planMousePath({ x: 0, y: 0 }, { x: 200, y: 100 }, {
      rng: seeded(1),
      steps: 8,
      targetWidth: 200,
      forceOvershoot: false,
    });
    expect(farSmall[farSmall.length - 1].t).toBeGreaterThan(nearLarge[nearLarge.length - 1].t);
  });

  it("is deterministic for a seeded RNG", () => {
    const a = planMousePath({ x: 0, y: 0 }, { x: 100, y: 100 }, { rng: seeded(7) });
    const b = planMousePath({ x: 0, y: 0 }, { x: 100, y: 100 }, { rng: seeded(7) });
    expect(a).toEqual(b);
  });
});

describe("jitterClickPoint", () => {
  it("produces a point within a few pixels of the centre", () => {
    const rng = seeded(42);
    for (let i = 0; i < 200; i++) {
      const p = jitterClickPoint({ x: 100, y: 50 }, { rng });
      expect(Math.abs(p.x - 100)).toBeLessThan(20);
      expect(Math.abs(p.y - 50)).toBeLessThan(20);
    }
  });
});
