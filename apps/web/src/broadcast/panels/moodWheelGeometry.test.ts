/**
 * Tests for the MoodWheel pure-geometry helpers — sector ordering,
 * angle math, transition timing, direction-caret derivation, and SVG
 * arc-path construction. Kept separate from the component test so the
 * math can be exhaustively covered without touching the DOM.
 */

import { describe, it, expect } from "vitest";
import { MOOD_LABELS, type Mood } from "@price-game/shared";
import type { MoodSnapshot } from "../state/overlayBus";
import {
  SECTOR_ORDER,
  SECTOR_DEG,
  WHEEL_DIAMETER,
  HUB_DIAMETER,
  RIM_THICKNESS,
  POINTER_RADIUS_PX,
  TRANSITION_MIN_MS,
  TRANSITION_MAX_MS,
  TRANSITION_PER_DEG_MS,
  WHEEL_PALETTE,
  sectorAnchorAngle,
  shortestRotationDelta,
  transitionDurationMs,
  directionCaret,
  arcPath,
  wheelConicGradient,
  intraSectorOffset,
  wheelIndicatorAngle,
  POSITIVE_VIBE_DIRECTION,
  MAX_INTRA_OFFSET_DEG,
} from "./moodWheelGeometry";

const snap = (over: Partial<MoodSnapshot>): MoodSnapshot => ({
  mood: "neutral",
  vibe: 0,
  morale: 0,
  streak: 0,
  ...over,
});

describe("SECTOR_ORDER", () => {
  it("contains exactly the 8 canonical mood labels, no duplicates", () => {
    expect(SECTOR_ORDER).toHaveLength(8);
    expect(new Set(SECTOR_ORDER).size).toBe(8);
    for (const mood of MOOD_LABELS) {
      expect(SECTOR_ORDER).toContain(mood);
    }
  });

  it("places focused at 12 o'clock and neutral at 6 o'clock (rest)", () => {
    expect(SECTOR_ORDER[0]).toBe("focused");
    expect(SECTOR_ORDER[4]).toBe("neutral");
  });

  it("orders the cycle so neutral → despondent → tilted → frustrated → focused → confident → happy → elated → neutral", () => {
    // Pin the user-specified clockwise traversal from neutral.
    const clockwiseFromNeutral: readonly Mood[] = [
      "neutral", "despondent", "tilted", "frustrated", "focused", "confident", "happy", "elated",
    ];
    const startIdx = SECTOR_ORDER.indexOf("neutral");
    for (let i = 0; i < clockwiseFromNeutral.length; i++) {
      const wheelIdx = (startIdx + i) % SECTOR_ORDER.length;
      expect(SECTOR_ORDER[wheelIdx]).toBe(clockwiseFromNeutral[i]);
    }
  });

  it("yields a 45° per sector wheel", () => {
    expect(SECTOR_DEG).toBe(45);
  });
});

describe("sectorAnchorAngle", () => {
  it("returns the sector midline (index * 45) in degrees clockwise from 12 o'clock", () => {
    expect(sectorAnchorAngle("focused")).toBe(0);
    expect(sectorAnchorAngle("confident")).toBe(45);
    expect(sectorAnchorAngle("happy")).toBe(90);
    expect(sectorAnchorAngle("elated")).toBe(135);
    expect(sectorAnchorAngle("neutral")).toBe(180);
    expect(sectorAnchorAngle("despondent")).toBe(225);
    expect(sectorAnchorAngle("tilted")).toBe(270);
    expect(sectorAnchorAngle("frustrated")).toBe(315);
  });

  it("covers every Mood label so a registry add forces an explicit ordering decision", () => {
    for (const mood of MOOD_LABELS as readonly Mood[]) {
      expect(typeof sectorAnchorAngle(mood)).toBe("number");
    }
  });
});

describe("intraSectorOffset + wheelIndicatorAngle (continuous vibe)", () => {
  it("returns 0 at the mood's vibe midpoint (anchor unchanged)", () => {
    // Mid-band moods centre on vibe=0; high/low-band moods on
    // ±2.25 — the indicator sits squarely at the sector centerline
    // when vibe is at the centre of the mood's band.
    // Use toBeCloseTo: a normalized vibe of 0 multiplied by a -1
    // direction sign produces JavaScript's -0, which fails strict
    // equality with +0 even though the geometric value is the same.
    expect(intraSectorOffset("neutral", 0)).toBeCloseTo(0);
    expect(intraSectorOffset("focused", 0)).toBeCloseTo(0);
    expect(intraSectorOffset("happy", 2.25)).toBeCloseTo(0);
    expect(intraSectorOffset("elated", 2.25)).toBeCloseTo(0);
    expect(intraSectorOffset("frustrated", -2.25)).toBeCloseTo(0);
    expect(intraSectorOffset("despondent", -2.25)).toBeCloseTo(0);
  });

  it("clamps to ±MAX_INTRA_OFFSET_DEG so the indicator never crosses into a neighbour sector", () => {
    // A vibe value beyond the mood's band still produces at most the
    // capped deflection — the active sector identity remains visually
    // unambiguous even on out-of-band engine values.
    for (const mood of MOOD_LABELS as readonly Mood[]) {
      const wayHigh = intraSectorOffset(mood, 999);
      const wayLow = intraSectorOffset(mood, -999);
      expect(Math.abs(wayHigh)).toBeLessThanOrEqual(MAX_INTRA_OFFSET_DEG);
      expect(Math.abs(wayLow)).toBeLessThanOrEqual(MAX_INTRA_OFFSET_DEG);
    }
  });

  it("uses the per-mood positive-vibe direction so vibe-rise drifts toward the next-stage sector", () => {
    // happy sits at 90° with positive direction = +1 (clockwise).
    // Rising vibe should drift toward elated (135°) — i.e. positive
    // (clockwise) offset.
    expect(intraSectorOffset("happy", 3)).toBeGreaterThan(0);
    // tilted sits at 270° with positive direction = -1 (CCW). Rising
    // vibe should drift CCW toward neutral (180°) — negative offset.
    expect(intraSectorOffset("tilted", 1.5)).toBeLessThan(0);
    // frustrated → recovery turn toward focused (CW from 315°).
    expect(intraSectorOffset("frustrated", -1.5)).toBeGreaterThan(0);
    // despondent → escape upward toward neutral (CCW from 225°).
    expect(intraSectorOffset("despondent", -1.5)).toBeLessThan(0);
  });

  it("at the mood's vibe edge lands the indicator near the gradient intermediate boundary", () => {
    // happy's range upper edge is vibe=3 (peak); offset = +18°,
    // anchor=90° → indicator at 108°. The gradient intermediate
    // between happy and elated sits at 112.5°, so the indicator is
    // 4.5° away — well within the boundary read-zone but bounded
    // shy of the next sector's anchor.
    const happyPeak = wheelIndicatorAngle("happy", 3);
    expect(happyPeak).toBe(90 + MAX_INTRA_OFFSET_DEG);
    expect(Math.abs(happyPeak - 112.5)).toBeLessThanOrEqual(SECTOR_DEG / 2);
  });

  it("is total over the registry — every Mood label resolves to a finite angle", () => {
    for (const mood of MOOD_LABELS as readonly Mood[]) {
      expect(POSITIVE_VIBE_DIRECTION[mood]).toBeDefined();
      const angle = wheelIndicatorAngle(mood, 0);
      expect(Number.isFinite(angle)).toBe(true);
    }
  });

  it("wheelIndicatorAngle composes anchor + offset", () => {
    // Spot-check: tilted anchor=270, vibe=1.5 (high in mid-band),
    // direction=-1 → offset = +1 * -1 * 18 = -18, expected 252°.
    expect(wheelIndicatorAngle("tilted", 1.5)).toBe(270 - MAX_INTRA_OFFSET_DEG);
  });

  it("elated pins to anchor at-or-past peak vibe (no overshoot past +)", () => {
    // No "more elated" sector exists; deflecting past the peak would
    // read as "less elated when actually peaking". Both peak and
    // midpoint sit at the anchor.
    expect(intraSectorOffset("elated", 3)).toBeCloseTo(0);
    expect(intraSectorOffset("elated", 2.25)).toBeCloseTo(0);
    expect(intraSectorOffset("elated", 999)).toBeCloseTo(0);
  });

  it("elated drifts CCW toward happy on the recovery side (vibe falling toward 1.5)", () => {
    // Vibe at the low edge of the elated band = -18° (toward happy
    // at 90°, i.e. counter-clockwise from elated at 135°).
    expect(intraSectorOffset("elated", 1.5)).toBe(-MAX_INTRA_OFFSET_DEG);
    expect(wheelIndicatorAngle("elated", 1.5)).toBe(135 - MAX_INTRA_OFFSET_DEG);
  });

  it("despondent pins to anchor at-or-past peak vibe (no overshoot past −)", () => {
    expect(intraSectorOffset("despondent", -3)).toBeCloseTo(0);
    expect(intraSectorOffset("despondent", -2.25)).toBeCloseTo(0);
    expect(intraSectorOffset("despondent", -999)).toBeCloseTo(0);
  });

  it("despondent drifts CCW toward neutral on the recovery side (vibe rising toward -1.5)", () => {
    expect(intraSectorOffset("despondent", -1.5)).toBe(-MAX_INTRA_OFFSET_DEG);
    expect(wheelIndicatorAngle("despondent", -1.5)).toBe(225 - MAX_INTRA_OFFSET_DEG);
  });
});

describe("shortestRotationDelta", () => {
  it("picks the direct arc when within 180°", () => {
    expect(shortestRotationDelta(0, 45)).toBe(45);
    expect(shortestRotationDelta(45, 0)).toBe(-45);
    expect(shortestRotationDelta(90, 180)).toBe(90);
  });

  it("wraps via the shorter side for arcs > 180° in raw degrees", () => {
    // 0 → 315 raw is +315; shorter is -45 (counter-clockwise).
    expect(shortestRotationDelta(0, 315)).toBe(-45);
    // 315 → 45 raw is -270; shorter is +90.
    expect(shortestRotationDelta(315, 45)).toBe(90);
  });

  it("treats an exact 180° antipode as +180 (clockwise convention)", () => {
    expect(shortestRotationDelta(0, 180)).toBe(180);
    expect(shortestRotationDelta(180, 0)).toBe(180);
  });

  it("returns 0 for identical angles", () => {
    expect(shortestRotationDelta(45, 45)).toBe(0);
  });
});

describe("transitionDurationMs", () => {
  it("matches MIN at zero distance and grows linearly", () => {
    expect(transitionDurationMs(0)).toBe(TRANSITION_MIN_MS);
    expect(transitionDurationMs(45)).toBe(TRANSITION_MIN_MS + 45 * TRANSITION_PER_DEG_MS);
  });

  it("clamps to MAX for long traversals", () => {
    expect(transitionDurationMs(180)).toBe(TRANSITION_MAX_MS);
    expect(transitionDurationMs(360)).toBe(TRANSITION_MAX_MS);
  });

  it("handles negative inputs by absolute value", () => {
    expect(transitionDurationMs(-90)).toBe(transitionDurationMs(90));
  });
});

describe("directionCaret", () => {
  it("returns flat → for the cold-start (no previous snapshot)", () => {
    const result = directionCaret(null, snap({ mood: "neutral", vibe: 0 }));
    expect(result.caret).toBe("→");
    expect(result.toLabel).toBeUndefined();
  });

  it("returns flat → when vibe slope is below the noise threshold", () => {
    const prev = snap({ mood: "neutral", vibe: 0.05 });
    const next = snap({ mood: "neutral", vibe: 0.1 });
    expect(directionCaret(prev, next).caret).toBe("→");
  });

  it("returns ↗ + the next-more-positive neighbor when vibe is rising (uses VALENCE_RANK, not sector adjacency)", () => {
    const prev = snap({ mood: "neutral", vibe: -0.5 });
    const next = snap({ mood: "neutral", vibe: 1.2 });
    const out = directionCaret(prev, next);
    expect(out.caret).toBe("↗");
    expect(out.toLabel).toBe("focused");
  });

  it("returns ↘ + the next-more-negative neighbor when vibe is falling", () => {
    const prev = snap({ mood: "neutral", vibe: 0.5 });
    const next = snap({ mood: "neutral", vibe: -1.0 });
    const out = directionCaret(prev, next);
    expect(out.caret).toBe("↘");
    expect(out.toLabel).toBe("tilted");
  });

  it("walks the trend by valence rank, not by sector index (frustrated rising → tilted, not focused)", () => {
    // Frustrated and focused are sector-adjacent (315° → 0°) but
    // sit at opposite ends of the valence axis. Trend caret must
    // follow valence rank: frustrated → tilted (rank -2 → -1).
    const prev = snap({ mood: "frustrated", vibe: -1.5 });
    const next = snap({ mood: "frustrated", vibe: 0.0 });
    const out = directionCaret(prev, next);
    expect(out.caret).toBe("↗");
    expect(out.toLabel).toBe("tilted");
  });

  it("does not propose a neighbor past the positive peak (elated rising)", () => {
    const prev = snap({ mood: "elated", vibe: 1.0 });
    const next = snap({ mood: "elated", vibe: 2.5 });
    const out = directionCaret(prev, next);
    expect(out.caret).toBe("↗");
    expect(out.toLabel).toBeUndefined();
  });

  it("does not propose a neighbor past the negative peak (despondent falling)", () => {
    const prev = snap({ mood: "despondent", vibe: -1.0 });
    const next = snap({ mood: "despondent", vibe: -2.5 });
    const out = directionCaret(prev, next);
    expect(out.caret).toBe("↘");
    expect(out.toLabel).toBeUndefined();
  });
});

describe("arcPath", () => {
  it("returns a non-empty SVG path string starting with M and ending with Z", () => {
    const d = arcPath(0, 45, 88, 110);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
  });

  it("places the outer-arc start at the endDeg (path traverses clockwise from end → start on the outer rim, then back)", () => {
    // Sector from 0° to 45°: outer arc goes from (sin45*r, -cos45*r) at 45°
    // back to (0, -r) at 0°. We just sanity-check the M point is the
    // endDeg outer point, not the startDeg outer point.
    const r = 110;
    const d = arcPath(0, 45, 88, r);
    const sin45 = Math.SQRT1_2;
    const expectedX = (r * sin45).toFixed(2);
    const expectedY = (-r * sin45).toFixed(2);
    // d starts with `M x y A …`; we tolerate either fixed precision.
    const m = d.match(/^M\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
    expect(m).not.toBeNull();
    if (m) {
      expect(parseFloat(m[1])).toBeCloseTo(parseFloat(expectedX), 1);
      expect(parseFloat(m[2])).toBeCloseTo(parseFloat(expectedY), 1);
    }
  });
});

describe("WHEEL_PALETTE + wheelConicGradient", () => {
  it("provides a hex colour for every Mood label", () => {
    for (const mood of MOOD_LABELS as readonly Mood[]) {
      const colour = WHEEL_PALETTE[mood];
      expect(colour).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("places warm hues (focused/confident/frustrated) and cool hues (elated/despondent) at distinct points on the colour wheel", () => {
    // The new layout traverses the full visible spectrum. Pin a
    // few invariants rather than every channel: focused is warm
    // (high red), elated is cool (high blue), and the two sit
    // far enough apart in hue that they're trivially distinct.
    const r = (hex: string) => parseInt(hex.slice(1, 3), 16);
    const b = (hex: string) => parseInt(hex.slice(5, 7), 16);
    expect(r(WHEEL_PALETTE.focused)).toBeGreaterThan(r(WHEEL_PALETTE.elated));
    expect(b(WHEEL_PALETTE.elated)).toBeGreaterThan(b(WHEEL_PALETTE.focused));
    // Every mood gets a unique colour — no two anchors share a hex.
    const all = Object.values(WHEEL_PALETTE).map((c) => c.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it("emits a conic-gradient string with one stop per mood plus a wrap close", () => {
    const css = wheelConicGradient();
    expect(css.startsWith("conic-gradient(")).toBe(true);
    for (const mood of SECTOR_ORDER) {
      expect(css).toContain(WHEEL_PALETTE[mood]);
    }
    // Closing stop at 360° is the same colour as the 0° stop so the
    // browser interpolates smoothly across the wrap boundary.
    expect(css).toContain("360deg");
    expect(css).toContain("from 0deg");
  });
});

describe("layout constants", () => {
  it("hub diameter is at least 55% of wheel diameter (UX hierarchy gate)", () => {
    expect(HUB_DIAMETER / WHEEL_DIAMETER).toBeGreaterThanOrEqual(0.55);
  });

  it("rim thickness is in the 12–22% radius band (thin band, not fat donut)", () => {
    const ratio = RIM_THICKNESS / (WHEEL_DIAMETER / 2);
    expect(ratio).toBeGreaterThanOrEqual(0.12);
    expect(ratio).toBeLessThanOrEqual(0.22);
  });

  it("pointer sits on the rim midline", () => {
    expect(POINTER_RADIUS_PX).toBe(WHEEL_DIAMETER / 2 - RIM_THICKNESS / 2);
  });
});
