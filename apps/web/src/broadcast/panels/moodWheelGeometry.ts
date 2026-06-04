/**
 * Pure geometry + math helpers for the MoodWheel broadcast panel.
 *
 * Kept separate from the React component so the math can be unit-tested
 * without a DOM and the component file can stay focused on rendering.
 *
 * Conventions:
 *   - Angles are in degrees, clockwise from 12 o'clock (0° = up).
 *   - The 8-mood wheel divides 360° into 45° sectors; each mood's
 *     "anchor angle" is the centerline of its sector.
 *   - SVG coordinates have y growing downward; `arcPath` does the
 *     polar→cartesian conversion internally so callers stay in degrees.
 */

import type { Mood } from "@price-game/shared";
import type { MoodSnapshot } from "../state/overlayBus";

/**
 * Clockwise sector ordering, starting at 12 o'clock. Neutral sits
 * at 6 o'clock as the rest baseline; rotating clockwise from neutral
 * descends through the negative arc (despondent → tilted →
 * frustrated), turns the corner at 12 (the "recovery" transition
 * from frustrated → focused), then ascends through the positive arc
 * (focused → confident → happy → elated) and returns to neutral.
 *
 * The wheel is a CYCLE rather than a linear valence axis: both
 * directions of rotation describe meaningful emotional trajectories,
 * and the spectrum colour palette ({@link WHEEL_PALETTE}) is laid
 * out so adjacent sectors carry colour-wheel-adjacent hues. There
 * is no abrupt peak↔peak wrap — every transition blends through
 * neighbouring colours.
 *
 * Adding a mood means inserting it in the right cycle position here
 * AND adding a `MOOD_REGISTRY` row — the panel itself does not
 * carry per-mood logic.
 */
export const SECTOR_ORDER: readonly Mood[] = [
  "focused",    // 12:00 — recovery turning point (top)
  "confident",  // 1:30
  "happy",      // 3:00
  "elated",     // 4:30 — peak positive
  "neutral",    // 6:00 — rest baseline (bottom)
  "despondent", // 7:30 — descent begins
  "tilted",     // 9:00
  "frustrated", // 10:30 — strong negative, rotating up to recovery
] as const;

/** Degrees per sector. Derived from `SECTOR_ORDER.length` so adding a mood doesn't desync. */
export const SECTOR_DEG = 360 / SECTOR_ORDER.length;

/**
 * Mood-anchor colours for the wheel's smooth ring. The 8 hues are
 * distributed around the visible spectrum so adjacent moods are
 * also colour-wheel-adjacent — going clockwise from 12 o'clock:
 * orange → yellow → lime → cyan → slate (rest at 6) → violet →
 * fuchsia → red → orange. Each mood gets a distinct colour
 * identity; the gradient interpolations between them are smooth
 * because the colours sit on the same colour wheel.
 *
 * Distinct from `MOOD_REGISTRY.color`, which other consumers
 * (MoodDebugHud, bot logs) depend on — those want stable mood
 * identity, the wheel wants a coherent spectrum.
 */
export const WHEEL_PALETTE: Readonly<Record<Mood, string>> = {
  focused: "#c2410c",    // orange-700  (12:00, recovery)
  confident: "#a16207",  // yellow-700  (1:30)
  happy: "#4d7c0f",      // lime-700    (3:00)
  elated: "#0e7490",     // cyan-700    (4:30, peak +)
  neutral: "#475569",    // slate-600   (6:00, rest)
  despondent: "#6d28d9", // violet-700  (7:30)
  tilted: "#a21caf",     // fuchsia-700 (9:00)
  frustrated: "#b91c1c", // red-700     (10:30)
};

/**
 * Intermediate gradient stops (NOT mood anchors). Drop a vivid
 * colour at every sector midpoint-boundary so the conic gradient
 * traverses the full visible spectrum with continuous variation.
 * Each intermediate sits exactly between two mood anchors and is
 * chosen so the eye sees genuine hue movement when the indicator
 * is mid-transition between moods. These don't appear in
 * `SECTOR_ORDER` — they have no semantic meaning to the engine,
 * only to the gradient.
 */
const GRADIENT_INTERMEDIATES: ReadonlyArray<{ angle: number; color: string }> = [
  { angle: 22.5,  color: "#ea580c" }, // orange-600 — focused → confident
  { angle: 67.5,  color: "#84cc16" }, // lime-500 — confident → happy
  { angle: 112.5, color: "#0d9488" }, // teal-600 — happy → elated
  { angle: 157.5, color: "#1e3a8a" }, // blue-900 — elated → neutral (cool descent)
  { angle: 202.5, color: "#4338ca" }, // indigo-600 — neutral → despondent
  { angle: 247.5, color: "#9333ea" }, // purple-600 — despondent → tilted
  { angle: 292.5, color: "#e11d48" }, // rose-600 — tilted → frustrated
  { angle: 337.5, color: "#f97316" }, // orange-500 — frustrated → focused (recovery turn)
];

export const WHEEL_DIAMETER = 170;
export const HUB_DIAMETER = 108;
export const RIM_THICKNESS = 18;
export const POINTER_RADIUS_PX = WHEEL_DIAMETER / 2 - RIM_THICKNESS / 2;

export const TRANSITION_MIN_MS = 700;
export const TRANSITION_MAX_MS = 1400;
export const TRANSITION_PER_DEG_MS = 4;

/**
 * Slope (per snapshot) below which the direction caret reads as
 * "steady". Engine round outcomes typically shift vibe by ~1.0, so
 * 0.15 captures snapshot-to-snapshot noise without swallowing real
 * movement.
 */
export const VIBE_SLOPE_FLAT_THRESHOLD = 0.15;

/**
 * Anchor angle (degrees clockwise from 12 o'clock) for a mood's
 * sector centerline. Throws via fallback to 0 if a future mood is
 * added to the registry without being placed in `SECTOR_ORDER` —
 * tests catch this before runtime.
 */
export function sectorAnchorAngle(mood: Mood): number {
  const idx = SECTOR_ORDER.indexOf(mood);
  if (idx < 0) return 0;
  return idx * SECTOR_DEG;
}

/**
 * Per-mood angular sign (+1 = clockwise, -1 = counter-clockwise) the
 * indicator drifts as `vibe` rises within the mood's vibe range.
 * Picked so the indicator always interpolates toward the visually-
 * adjacent sector that represents the next stage of Pricey's
 * emotional arc — letting viewers read "almost transitioning" as the
 * indicator approaches a sector boundary.
 *
 * Derivation, sector-by-sector around the wheel cycle:
 *   - focused (12, recovery turning point): +1 toward confident.
 *   - confident (1:30): +1 toward happy.
 *   - happy (3:00): +1 toward elated (positive peak).
 *   - elated (4:30, peak +): UNUSED — see the elated/despondent
 *     special case in `intraSectorOffset`. There is no "more elated"
 *     sector, so a generic positive-vibe direction would either
 *     overshoot past the peak (CW into neutral, reading as
 *     "less elated") or drift toward happy (reading as "less elated"
 *     too). The peak is a fixed point; only the recovery side
 *     (vibe falling back toward 1.5) deflects, CCW toward happy.
 *     Value retained as `1` so the union type stays {+1,-1} and a
 *     future generalisation can wire it through.
 *   - neutral (6:00, baseline): -1 toward elated (climb out of
 *     baseline on the positive arc).
 *   - despondent (7:30, peak −): UNUSED — same special case as
 *     elated, applied to the negative peak. Recovery direction is
 *     CCW toward neutral.
 *   - tilted (9:00): -1 toward neutral.
 *   - frustrated (10:30): +1 toward focused (the recovery turn).
 *
 * Adding a mood means adding a row here (and to the vibe range table
 * below) so the offset function stays total over `Mood`.
 */
export const POSITIVE_VIBE_DIRECTION: Readonly<Record<Mood, 1 | -1>> = {
  focused: 1,
  confident: 1,
  happy: 1,
  elated: 1,
  neutral: -1,
  despondent: -1,
  tilted: -1,
  frustrated: 1,
};

/**
 * Maximum sub-sector deflection in degrees. Capped well below
 * `SECTOR_DEG/2` (22.5°) so the indicator never reaches the next
 * sector's anchor — the active sector stays unambiguous even at full
 * deflection. The cap also leaves visual room for the gradient
 * intermediate stops (at the exact boundary ±22.5°) to remain
 * adjacent-but-distinct from the indicator's farthest position.
 */
export const MAX_INTRA_OFFSET_DEG = 18;

/**
 * Vibe range associated with each mood label, derived from
 * `resolveMood` in `packages/bot-streamer/src/persona/mood.ts` —
 * specifically the `VIBE_HIGH` / `VIBE_LOW` thresholds (±1.5) and the
 * `VIBE_BOUNDS` clamp (±3). Used to normalise an absolute vibe value
 * into [-1, 1] within the mood's band so the indicator's sub-sector
 * offset reflects "where in this mood's vibe band Pricey currently
 * sits".
 *
 * - mid-band moods (focused / confident / neutral / tilted) cover
 *   the inner vibe interval (-1.5, 1.5), midpoint 0.
 * - high-band moods (happy / elated) cover [1.5, 3], midpoint 2.25.
 * - low-band moods (frustrated / despondent) cover [-3, -1.5],
 *   midpoint -2.25.
 *
 * The geometry layer keeps its own copy (rather than importing from
 * the bot-streamer package) so the web bundle stays decoupled from
 * the engine — same pattern as `MoodSnapshot` itself, which is
 * redeclared in `overlayBus.ts`. There is no compile-time agreement
 * check between the two; tweaking `VIBE_HIGH` / `VIBE_LOW` /
 * `VIBE_BOUNDS` in `mood.ts` requires the corresponding update here
 * (and in the table directly below). The visual is decorative — a
 * stale threshold here only mis-positions the indicator slightly,
 * never produces incorrect mood-label rendering.
 */
const MOOD_VIBE_MIDPOINT: Readonly<Record<Mood, number>> = {
  focused: 0,
  confident: 0,
  neutral: 0,
  tilted: 0,
  happy: 2.25,
  elated: 2.25,
  frustrated: -2.25,
  despondent: -2.25,
};
const MOOD_VIBE_HALF_RANGE: Readonly<Record<Mood, number>> = {
  focused: 1.5,
  confident: 1.5,
  neutral: 1.5,
  tilted: 1.5,
  happy: 0.75,
  elated: 0.75,
  frustrated: 0.75,
  despondent: 0.75,
};

/**
 * Sub-sector deflection for the indicator: where within the mood's
 * sector should the slider sit, given the engine's hidden `vibe`
 * value. Range: `[-MAX_INTRA_OFFSET_DEG, +MAX_INTRA_OFFSET_DEG]`,
 * positive = clockwise.
 *
 * Vibe is normalised into [-1, 1] within the mood's vibe range
 * (`MOOD_VIBE_MIDPOINT` / `HALF_RANGE`) and then multiplied by
 * `POSITIVE_VIBE_DIRECTION[mood]` so a rising vibe always nudges the
 * indicator toward the cycle's next-stage neighbour. Out-of-band
 * vibe values (the engine clamps to [-3, 3] but tests can pass any
 * number) are clamped here too — the indicator never escapes its
 * sector's neighbourhood.
 *
 * Special case for the band peaks (`elated`, `despondent`): there is
 * no "more elated"/"more despondent" sector to drift toward at the
 * top of the band, so applying the generic positive-direction rule
 * would either overshoot past the peak (CW into neutral, reading as
 * "less elated when actually peaking") or drift toward the milder
 * neighbour (also reading wrong). Both peaks instead pin to the
 * sector anchor when vibe is at-or-past the midpoint and only deflect
 * on the recovery side — CCW toward happy for elated, CCW toward
 * neutral for despondent. This means peak vibe = no deflection
 * (correctly reading "deepest into peak"), and the indicator only
 * starts drifting once the engine begins decaying back toward the
 * band edge, telegraphing the upcoming label flip.
 *
 * Pure: callable in the render path with no allocation.
 */
export function intraSectorOffset(mood: Mood, vibe: number): number {
  const normalized = Math.max(
    -1,
    Math.min(1, (vibe - MOOD_VIBE_MIDPOINT[mood]) / MOOD_VIBE_HALF_RANGE[mood]),
  );
  if (mood === "elated") {
    // Elated anchor at 135°. Recovery (toward happy at 90°) is CCW —
    // negative offset. Pin to anchor at-or-past the midpoint
    // (normalized ≥ 0); deflect linearly on the recovery side.
    return Math.min(0, normalized) * MAX_INTRA_OFFSET_DEG;
  }
  if (mood === "despondent") {
    // Despondent anchor at 225°. Recovery (toward neutral at 180°) is
    // CCW — negative offset. Pin at-or-past the (negative) midpoint
    // (normalized ≤ 0); deflect linearly as vibe recovers upward.
    return -Math.max(0, normalized) * MAX_INTRA_OFFSET_DEG;
  }
  return normalized * POSITIVE_VIBE_DIRECTION[mood] * MAX_INTRA_OFFSET_DEG;
}

/**
 * Continuous wheel-indicator angle: the sector anchor for `mood`
 * plus a vibe-driven sub-sector offset. Result is the absolute angle
 * (degrees clockwise from 12 o'clock) the indicator should rotate
 * to. May exceed [0, 360); callers feed this through
 * `shortestRotationDelta` for cumulative-rotation interpolation.
 *
 * The continuous mapping means even round-to-round vibe drift
 * (without a mood-label flip) produces visible indicator motion —
 * the wheel reads as "live" rather than "frozen between transitions".
 * When vibe approaches the edge of its band, the indicator lands
 * near the gradient intermediate position between sectors, telegraphing
 * the upcoming label change.
 */
export function wheelIndicatorAngle(mood: Mood, vibe: number): number {
  return sectorAnchorAngle(mood) + intraSectorOffset(mood, vibe);
}

/**
 * Signed shortest-path delta in degrees between two angles, in
 * `[-180, 180]`. Positive = clockwise. Exact 180° antipodes resolve
 * to +180 (clockwise) by convention so the renderer doesn't flicker
 * when the engine flips between peak↔peak moods.
 */
export function shortestRotationDelta(fromDeg: number, toDeg: number): number {
  const wrapped = ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Distance-aware transition duration in ms. Linear in the angular
 * distance, clamped to `[MIN, MAX]`. Adjacent-sector hops (45°) feel
 * deliberate; antipodal traversals stay under 1.4s so the viewer
 * doesn't disengage waiting for the pointer to arrive.
 */
export function transitionDurationMs(angularDistanceDeg: number): number {
  const abs = Math.abs(angularDistanceDeg);
  const raw = TRANSITION_MIN_MS + abs * TRANSITION_PER_DEG_MS;
  if (raw < TRANSITION_MIN_MS) return TRANSITION_MIN_MS;
  if (raw > TRANSITION_MAX_MS) return TRANSITION_MAX_MS;
  return raw;
}

/**
 * Result of {@link directionCaret}: which way Pricey's vibe is
 * trending and (when applicable) the neighbouring mood it's drifting
 * toward. The component renders this as the hub sub-label
 * ("↗ Confident" / "↘ Tilted" / "→ steady").
 */
export interface DirectionHint {
  caret: "↗" | "↘" | "→";
  toLabel?: Mood;
}

/**
 * Valence ranking — semantic ordering by emotional positivity,
 * independent of where each mood sits on the wheel. The wheel is a
 * cycle (going clockwise traverses negativity then recovery), so
 * sector adjacency does NOT mean valence adjacency. The trend caret
 * uses this rank to pick "more positive" / "more negative"
 * neighbours: the next mood up the rank when vibe rises, the next
 * down when it falls.
 */
export const VALENCE_RANK: Readonly<Record<Mood, number>> = {
  elated: 4,
  happy: 3,
  confident: 2,
  focused: 1,
  neutral: 0,
  tilted: -1,
  frustrated: -2,
  despondent: -3,
};

/**
 * Moods sorted by ascending valence — used by `directionCaret` to
 * walk the trend axis. Cached at module load so the lookup is O(1).
 */
const BY_VALENCE: readonly Mood[] = (Object.keys(VALENCE_RANK) as Mood[]).slice().sort(
  (a, b) => VALENCE_RANK[a] - VALENCE_RANK[b],
);

/**
 * Derive the trend caret + neighbouring-mood label from the slope of
 * the engine's hidden vibe axis between two snapshots. We use vibe
 * (fast-decaying) rather than morale (slow EMA) because viewers
 * need a signal that responds to recent rounds.
 *
 * Rules:
 *   - No prev snapshot, OR |Δvibe| < `VIBE_SLOPE_FLAT_THRESHOLD` → "→ steady".
 *   - Δvibe > 0 → "↗" pointing at the next-more-positive mood in
 *     {@link VALENCE_RANK}. Undefined `toLabel` at the positive
 *     peak (elated).
 *   - Δvibe < 0 → "↘" pointing at the next-more-negative mood.
 *     Undefined `toLabel` at the negative trough (despondent).
 */
export function directionCaret(prev: MoodSnapshot | null, next: MoodSnapshot): DirectionHint {
  if (!prev) return { caret: "→" };
  const slope = next.vibe - prev.vibe;
  if (Math.abs(slope) < VIBE_SLOPE_FLAT_THRESHOLD) return { caret: "→" };
  const idx = BY_VALENCE.indexOf(next.mood);
  if (slope > 0) {
    const neighbor = idx >= 0 && idx < BY_VALENCE.length - 1 ? BY_VALENCE[idx + 1] : undefined;
    return { caret: "↗", toLabel: neighbor };
  }
  const neighbor = idx > 0 ? BY_VALENCE[idx - 1] : undefined;
  return { caret: "↘", toLabel: neighbor };
}

/**
 * Convert a polar angle (degrees clockwise from 12 o'clock) at the
 * given radius into cartesian coords centred on the origin. Used by
 * `arcPath` and by the component to position per-sector emoji
 * markers along the rim.
 */
export function polarToCartesian(radius: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}

/**
 * Compose the CSS `conic-gradient(...)` string that paints the smooth
 * spectrum ring. The 8 `WHEEL_PALETTE` colours anchor at their sector
 * midlines (0°, 45°, 90°, ...) and `GRADIENT_INTERMEDIATES` adds
 * extra steering colours in the cool half — cyan, navy,
 * blue-indigo, deep violet, fuchsia — so the blue-purple region
 * carries genuine variation rather than a single flat indigo wash.
 * The closing stop at 360° matches 0° so the browser interpolates
 * the despondent→elated wrap smoothly through the magenta
 * intermediate at 337.5° instead of taking a muddy direct path.
 */
export function wheelConicGradient(): string {
  const moodStops = SECTOR_ORDER.map((mood, idx) => ({
    angle: idx * SECTOR_DEG,
    color: WHEEL_PALETTE[mood],
  }));
  const allStops = [...moodStops, ...GRADIENT_INTERMEDIATES]
    .sort((a, b) => a.angle - b.angle)
    .map((s) => `${s.color} ${s.angle}deg`);
  allStops.push(`${WHEEL_PALETTE[SECTOR_ORDER[0]]} 360deg`);
  return `conic-gradient(from 0deg, ${allStops.join(", ")})`;
}

/**
 * Build the SVG `d` attribute for an annular wedge (donut sector)
 * spanning [startDeg, endDeg] clockwise, between innerR and outerR,
 * centred on the origin (caller wraps in a `<g transform="translate">`
 * for absolute placement).
 */
export function arcPath(startDeg: number, endDeg: number, innerR: number, outerR: number): string {
  const startOuter = polarToCartesian(outerR, endDeg);
  const endOuter = polarToCartesian(outerR, startDeg);
  const startInner = polarToCartesian(innerR, startDeg);
  const endInner = polarToCartesian(innerR, endDeg);
  const sweep = endDeg - startDeg;
  const largeArc = sweep > 180 ? "1" : "0";
  return [
    `M ${startOuter.x.toFixed(3)} ${startOuter.y.toFixed(3)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 0 ${endOuter.x.toFixed(3)} ${endOuter.y.toFixed(3)}`,
    `L ${startInner.x.toFixed(3)} ${startInner.y.toFixed(3)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 1 ${endInner.x.toFixed(3)} ${endInner.y.toFixed(3)}`,
    "Z",
  ].join(" ");
}
