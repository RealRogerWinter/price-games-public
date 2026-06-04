/**
 * MoodWheel — viewer-facing mood indicator. Replaces the static
 * MoodIndicator card with an 8-sector spectrum ring + a dominant
 * central hub readout + a clear slider-style indicator that travels
 * along the rim as Pricey's mood transitions.
 *
 * Visual structure (back to front):
 *   1. CSS conic-gradient ring  — smooth warm→cool spectrum, no
 *      hard sector boundaries. Driven by `wheelConicGradient()` from
 *      `moodWheelGeometry.ts` so the colour identity lives next to
 *      the math.
 *   2. SVG layer — wrap divider, sector hit-regions (transparent;
 *      kept for `data-state` styling hooks and future hover/selection
 *      affordances), rim text labels, and the moving indicator.
 *   3. Hub overlay — emoji (only one in the whole panel) + uppercase
 *      label + directional caret + optional streak pill.
 *
 * The rim no longer carries per-sector emoji glyphs; mood identity
 * around the ring is communicated by the spectrum colour AND by short
 * text labels at each sector centre, with the active label brighter /
 * larger so the eye lands on it before the others.
 *
 * Direction-of-travel encoding (in priority order):
 *   - Hub sub-label text caret ("↗ Confident") — primary, persists.
 *   - Indicator rotation animation along the rim — secondary.
 *
 * The component is keyed off `MoodSnapshot` (the engine's full state:
 * mood + vibe + morale + streak) and falls back to `BotStats` for
 * the legacy `stats.update`-only path.
 */

import { useEffect, useRef, useState } from "react";
import { MOOD_REGISTRY, DEFAULT_MOOD, type Mood } from "@price-game/shared";
import type { BotStats, MoodSnapshot } from "../state/overlayBus";
import {
  SECTOR_ORDER,
  SECTOR_DEG,
  WHEEL_DIAMETER,
  HUB_DIAMETER,
  RIM_THICKNESS,
  POINTER_RADIUS_PX,
  WHEEL_PALETTE,
  arcPath,
  directionCaret,
  polarToCartesian,
  sectorAnchorAngle,
  shortestRotationDelta,
  transitionDurationMs,
  wheelConicGradient,
  wheelIndicatorAngle,
} from "./moodWheelGeometry";

export interface MoodWheelProps {
  /**
   * Authoritative mood snapshot from the bot's `mood.snapshot` event.
   * Carries the engine's hidden axes (vibe, morale) the wheel uses
   * to derive direction-of-travel. May be null until the first
   * snapshot lands (cold start).
   */
  moodSnapshot: MoodSnapshot | null;
  /**
   * Legacy stats payload. Used for `streak` when no snapshot has
   * landed yet, and as a `mood` fallback if the bot publishes only
   * `stats.update` without the rich snapshot.
   */
  stats: BotStats;
}

/**
 * SVG viewBox sized so rim text labels at LABEL_R sit comfortably
 * inside the panel. With WHEEL_DIAMETER=170 and LABEL_R=92, the
 * extreme label edges land around ±112px — VIEWBOX_SIZE=240 gives
 * 8px of horizontal padding so center-anchored labels never clip
 * against the panel edge or the SVG viewBox.
 */
const VIEWBOX_SIZE = 240;
const CENTER = VIEWBOX_SIZE / 2;
const OUTER_R = WHEEL_DIAMETER / 2;
const INNER_R = OUTER_R - RIM_THICKNESS;
/** Radius for the rim text labels — just outside the rim outer edge. */
const LABEL_R = OUTER_R + 7;

/** Inner-rim tick mark inner radius (for sector-boundary hairline). */
const TICK_INNER_R = INNER_R + 1;
/** Outer-rim tick mark outer radius (for sector-boundary hairline). */
const TICK_OUTER_R = OUTER_R - 1;

/** Format the streak chip body. Only called when |streak| ≥ 2. */
function formatStreak(streak: number): string {
  return streak > 0 ? `▲ ${streak}` : `▼ ${Math.abs(streak)}`;
}

/**
 * Resolve the mood the wheel should render. Priority order:
 * snapshot.mood > stats.mood > DEFAULT_MOOD. Returns `coldStart=true`
 * when neither source has produced a mood yet so the renderer can
 * show "Warming up" instead of silently defaulting to neutral.
 */
function resolveMood(snapshot: MoodSnapshot | null, stats: BotStats): { mood: Mood; coldStart: boolean } {
  if (snapshot) return { mood: snapshot.mood, coldStart: false };
  if (stats.mood) return { mood: stats.mood, coldStart: false };
  return { mood: DEFAULT_MOOD, coldStart: true };
}

export default function MoodWheel({ moodSnapshot, stats }: MoodWheelProps) {
  const { mood: activeMood, coldStart } = resolveMood(moodSnapshot, stats);
  const descriptor = MOOD_REGISTRY[activeMood];
  // Continuous indicator angle: sector anchor + a vibe-driven sub-
  // sector deflection. The deflection means even round-to-round vibe
  // drift (without a mood-label flip) produces visible wheel motion,
  // and as vibe approaches the edge of its band the indicator drifts
  // toward the gradient intermediate position between sectors —
  // telegraphing the upcoming label change. Falls back to the bare
  // anchor on the legacy stats-only path (no snapshot ⇒ no vibe
  // signal). `data-angle` exposes the raw sector anchor for tests
  // and operator inspection; the continuous offset is purely visual.
  //
  // Note on direction-of-travel duality: the indicator's drift uses
  // *cycle position* (next sector around the wheel cycle), while the
  // hub caret below uses *valence rank* (next mood on the
  // positive↔negative valence axis). The two can disagree —
  // notably for `frustrated` rising, where the indicator drifts CW
  // toward `focused` (the recovery turn) but the caret points to
  // `tilted` (the next-less-negative valence neighbour). This is
  // intentional: the wheel position visualises the cycle's narrative
  // arc, while the caret describes the engine's valence trajectory.
  const sectorAnchor = sectorAnchorAngle(activeMood);
  const liveVibe = moodSnapshot?.vibe ?? 0;
  const targetAnchor = moodSnapshot
    ? wheelIndicatorAngle(activeMood, liveVibe)
    : sectorAnchor;
  const moodColor = WHEEL_PALETTE[activeMood];

  // Direction caret derives from the *previous* snapshot vs. the
  // current one — i.e. it inspects history. We track both the
  // previous snapshot and the last snapshot we've already shifted in
  // for via the React "derived state in render" idiom (`useState` +
  // a render-time setter conditional on a reference change). This
  // pattern is concurrent-mode safe — discarded renders never commit
  // their setState calls, unlike a render-time `useRef` mutation
  // which would persist across an aborted render. The `tracked` ===
  // `moodSnapshot` guard means re-renders triggered by sibling state
  // (e.g. the `setDisplayAngle` call below, which fires on every
  // snapshot change because the continuous-vibe `targetAnchor`
  // shifts) don't collapse `prev` onto `curr` — without that guard,
  // the post-`setDisplayAngle` re-render would recompute
  // `directionCaret(snap2, snap2)` and replace the just-rendered
  // "↗" with "→ steady" before paint.
  const [prevSnapshot, setPrevSnapshot] = useState<MoodSnapshot | null>(null);
  const [trackedSnapshot, setTrackedSnapshot] = useState<MoodSnapshot | null>(moodSnapshot);
  if (moodSnapshot !== trackedSnapshot) {
    setPrevSnapshot(trackedSnapshot);
    setTrackedSnapshot(moodSnapshot);
  }
  const hint = coldStart
    ? { caret: "→" as const }
    : directionCaret(
        prevSnapshot,
        moodSnapshot
          ?? prevSnapshot
          ?? { mood: activeMood, vibe: 0, morale: 0, streak: stats.streak },
      );

  // Cumulative rotation angle: keeps incrementing by `shortestRotationDelta`
  // so CSS interpolates the shorter arc on every transition (without
  // wrapping back to 0° at the boundary). Stored in a ref so we can
  // compute the next cumulative value purely (no setState updater
  // closure side effects — StrictMode-safe). `displayAngle` mirrors
  // the ref into state so React knows to re-render when it changes.
  const cumulativeAngleRef = useRef<number>(targetAnchor);
  const [displayAngle, setDisplayAngle] = useState<number>(targetAnchor);
  const [transitionMs, setTransitionMs] = useState<number>(0);
  const lastTargetRef = useRef<number>(targetAnchor);
  // True once we've rendered the indicator at least once. Used to
  // suppress the cold-start → first-snapshot rotation flash: the
  // first time `coldStart` flips false, we snap the indicator to its
  // sector anchor without an animation rather than spinning from
  // neutral (180°) up to e.g. happy (90°).
  const hasShownIndicatorRef = useRef<boolean>(!coldStart);

  useEffect(() => {
    if (coldStart) return;
    if (lastTargetRef.current === targetAnchor && hasShownIndicatorRef.current) return;

    if (!hasShownIndicatorRef.current) {
      // First reveal of the indicator. Snap to position; no rotation
      // animation from the synthetic neutral anchor we initialised at.
      hasShownIndicatorRef.current = true;
      cumulativeAngleRef.current = targetAnchor;
      lastTargetRef.current = targetAnchor;
      setDisplayAngle(targetAnchor);
      setTransitionMs(0);
      return;
    }

    const cur = cumulativeAngleRef.current;
    const curMod = ((cur % 360) + 360) % 360;
    const delta = shortestRotationDelta(curMod, targetAnchor);
    const next = cur + delta;
    cumulativeAngleRef.current = next;
    lastTargetRef.current = targetAnchor;
    setDisplayAngle(next);
    setTransitionMs(transitionDurationMs(delta));
  }, [targetAnchor, coldStart]);

  const streak = moodSnapshot?.streak ?? stats.streak;
  const showStreak = Math.abs(streak) >= 2;

  const directionLabel = hint.toLabel ? MOOD_REGISTRY[hint.toLabel].displayLabel : "steady";

  // aria-label includes the trend phrase ("trending toward Confident",
  // "steady") so screen-reader users get the same direction signal the
  // visible hub caret communicates.
  const trendPhrase = hint.caret === "→"
    ? "trend steady"
    : `trending ${hint.caret === "↗" ? "up" : "down"}${hint.toLabel ? ` toward ${MOOD_REGISTRY[hint.toLabel].displayLabel}` : ""}`;
  const ariaLabel = coldStart
    ? "Pricey's mood: warming up."
    : `Pricey's mood: ${descriptor.displayLabel}. ${descriptor.description} ${trendPhrase}. Current streak ${streak}.`;

  const conicCss = wheelConicGradient();

  return (
    <section
      className="broadcast-mood-wheel"
      data-testid="mood-wheel"
      data-mood={activeMood}
      data-cold-start={String(coldStart)}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      style={{ ["--mood-color" as string]: moodColor } as React.CSSProperties}
    >
      {/* Smooth spectrum ring backdrop. CSS conic-gradient on a div
          masked to an annulus — browser-native interpolation gives
          continuous blends between sector midpoints with zero DOM
          cost (vs. an SVG path-per-microsegment approach). */}
      <div
        className="broadcast-mood-wheel-ring"
        data-testid="mood-wheel-ring"
        aria-hidden="true"
        style={{ background: conicCss } as React.CSSProperties}
      />

      <svg
        className="broadcast-mood-wheel-svg"
        viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
        width={VIEWBOX_SIZE}
        height={VIEWBOX_SIZE}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <filter id="mood-wheel-indicator-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g transform={`translate(${CENTER} ${CENTER})`}>
          {/* Sector hit-regions — transparent fills. Kept for the
              `data-state` styling hooks and future selection
              affordances; the visible colour comes from the conic
              ring backdrop. */}
          <g className="broadcast-mood-wheel-sectors">
            {SECTOR_ORDER.map((mood, idx) => {
              const start = idx * SECTOR_DEG;
              const end = start + SECTOR_DEG;
              const activeIdx = SECTOR_ORDER.indexOf(activeMood);
              const distance = Math.min(
                Math.abs(idx - activeIdx),
                SECTOR_ORDER.length - Math.abs(idx - activeIdx),
              );
              const state = distance === 0 ? "active" : distance === 1 ? "adjacent" : "dim";
              return (
                <path
                  key={mood}
                  data-testid={`mood-wheel-sector-${mood}`}
                  data-mood={mood}
                  data-state={state}
                  className="broadcast-mood-wheel-sector"
                  d={arcPath(start, end, INNER_R, OUTER_R)}
                  fill="transparent"
                />
              );
            })}
          </g>

          {/* Sector-boundary tick marks — eight faint radial hairlines
              at every 45° offset, subdividing the rim into eight
              equal mood sectors so the smooth gradient still reads
              as evenly divided. The new wheel layout (cycle-of-mood
              traversing the full colour wheel) has no peak↔peak
              wrap to call out — every adjacent boundary is a
              colour-wheel-adjacent transition, so a single tick
              treatment suffices. */}
          <g className="broadcast-mood-wheel-ticks" aria-hidden="true">
            {SECTOR_ORDER.map((_, idx) => {
              const angle = idx * SECTOR_DEG + SECTOR_DEG / 2;
              const inner = polarToCartesian(TICK_INNER_R, angle);
              const outer = polarToCartesian(TICK_OUTER_R, angle);
              return (
                <line
                  key={idx}
                  className="broadcast-mood-wheel-tick"
                  x1={inner.x}
                  y1={inner.y}
                  x2={outer.x}
                  y2={outer.y}
                />
              );
            })}
          </g>

          {/* Rim text labels — one per sector, horizontal (never
              rotated), placed at sector midline just outside the rim.
              Active label gets the bright treatment; adjacent labels
              dim slightly; distant labels recede further so the eye
              isn't pulled away from the active mood. */}
          <g className="broadcast-mood-wheel-rim-labels">
            {SECTOR_ORDER.map((mood, idx) => {
              const angle = idx * SECTOR_DEG;
              const { x, y } = polarToCartesian(LABEL_R, angle);
              const activeIdx = SECTOR_ORDER.indexOf(activeMood);
              const distance = Math.min(
                Math.abs(idx - activeIdx),
                SECTOR_ORDER.length - Math.abs(idx - activeIdx),
              );
              const state = distance === 0 ? "active" : distance === 1 ? "adjacent" : "dim";
              return (
                <text
                  key={mood}
                  x={x}
                  y={y}
                  data-testid={`mood-wheel-rim-label-${mood}`}
                  data-mood={mood}
                  data-state={state}
                  className="broadcast-mood-wheel-rim-label"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {MOOD_REGISTRY[mood as Mood].displayLabel}
                </text>
              );
            })}
          </g>

          {/* Indicator — rotates around the wheel centre. The pointer
              geometry is drawn at "12 o'clock" (top) relative to the
              rotation, then rotated to the active mood's anchor by
              `transform: rotate()`. Two visual elements:
                - A tall slider-thumb (rounded rectangle) sitting on
                  the rim midline, white with a dark outline.
                - An inward-pointing triangular chevron just outside
                  the rim, in the active mood's hue, calling the eye.
              Together they read as "this is the slider's thumb, and
              that arrow is pointing to the current mood." */}
          {!coldStart && (
            <g
              className="broadcast-mood-wheel-indicator"
              data-testid="mood-wheel-indicator"
              data-angle={String(sectorAnchor)}
              data-target-angle={String(targetAnchor)}
              style={{
                transform: `rotate(${displayAngle}deg)`,
                transition: transitionMs > 0 ? `transform ${transitionMs}ms ease-in-out` : "none",
              }}
            >
              {/* Outer chevron pointing inward toward the rim. The
                  triangle's tip touches the outer edge of the rim
                  (-OUTER_R) and its base is 12px further out. */}
              <polygon
                className="broadcast-mood-wheel-indicator-arrow"
                points={`0,${-OUTER_R - 1} -7,${-OUTER_R - 12} 7,${-OUTER_R - 12}`}
                fill={moodColor}
                stroke="rgba(15, 23, 42, 0.95)"
                strokeWidth={1.25}
                strokeLinejoin="round"
                filter="url(#mood-wheel-indicator-glow)"
              />
              {/* Slider thumb — rounded rectangle straddling the rim.
                  Strong contrast stack so it never disappears against
                  any sector hue. */}
              <rect
                className="broadcast-mood-wheel-indicator-thumb"
                x={-7}
                y={-POINTER_RADIUS_PX - 12}
                width={14}
                height={24}
                rx={4}
                ry={4}
                fill="#f8fafc"
                stroke="rgba(15, 23, 42, 0.95)"
                strokeWidth={1.5}
              />
              {/* Inner mood-tinted dot inside the thumb, so the
                  thumb itself carries the active mood colour. */}
              <rect
                x={-3}
                y={-POINTER_RADIUS_PX - 8}
                width={6}
                height={16}
                rx={2}
                ry={2}
                fill={moodColor}
              />
            </g>
          )}
        </g>
      </svg>

      <div className="broadcast-mood-wheel-hub" aria-hidden="true">
        <div className="broadcast-mood-wheel-emoji" data-testid="mood-wheel-emoji">
          {coldStart ? "💤" : descriptor.emoji}
        </div>
        <div className="broadcast-mood-wheel-label" data-testid="mood-wheel-label">
          {coldStart ? "Warming up" : descriptor.displayLabel}
        </div>
        <div className="broadcast-mood-wheel-direction" data-testid="mood-wheel-direction">
          <span className="broadcast-mood-wheel-direction-caret" data-caret={hint.caret}>{hint.caret}</span>
          <span className="broadcast-mood-wheel-direction-label">{directionLabel}</span>
        </div>
        {showStreak && (
          <div
            className="broadcast-mood-wheel-streak"
            data-testid="mood-wheel-streak"
            data-direction={streak > 0 ? "up" : "down"}
          >
            {formatStreak(streak)}
          </div>
        )}
      </div>
    </section>
  );
}
