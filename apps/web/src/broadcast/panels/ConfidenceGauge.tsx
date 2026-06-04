/**
 * ConfidenceGauge — horizontal price-axis bar showing the bot's
 * predicted cents (tick mark) with an uncertainty halo around it.
 *
 * Halo width is `predictedCents * (exp(σ) − 1)`, capped at 45% of
 * the bar width. When clamped we render the halo edges as dashed
 * and float a translucent "UNSURE" pill above the tick — visual
 * shorthand for "the model knows it doesn't know."
 *
 * Reveal-phase choreography happens via CSS classes driven by
 * `tick.phase`. Sound effects (G5 hit / C3 thud) are gated by the
 * `?sound=on` query and live in the BroadcastShell wiring; this
 * panel doesn't know about audio.
 */

import { useMemo } from "react";
import type { NnPanelProps } from "./shared/types";
import { PALETTE } from "./shared/palette";

const HALO_CAP_FRACTION = 0.45;

interface GeometryFields {
  /** "$0" → 2× max(actual, predicted) — shown as the bar's right edge. */
  maxCents: number;
  /** Tick-mark x position as a fraction in [0, 1]. */
  tickFraction: number;
  /** Halo half-width as a fraction in [0, 1]. */
  haloFraction: number;
  /** True when σ-derived halo would exceed the cap; the panel marks it dashed. */
  haloClamped: boolean;
}

/** Compute the gauge's tick + halo geometry from a tick. */
export function gaugeGeometry(tick: NnPanelProps["tick"]): GeometryFields {
  if (!tick) {
    return { maxCents: 1000_00, tickFraction: 0, haloFraction: 0, haloClamped: false };
  }
  const predicted = Math.max(0, tick.prediction.cents);
  const sigma = Math.max(0, tick.prediction.sigma);
  // Without a calibration anchor we use 2× predicted as the right edge,
  // floored at $5 so an early-training $0 prediction still renders
  // sensibly. The number on the right edge updates round-by-round so
  // viewers see the gauge auto-zoom to the relevant range.
  const maxCents = Math.max(500, predicted * 2);
  const tickFraction = Math.min(1, predicted / maxCents);
  const rawHaloCents = predicted * Math.max(0, Math.exp(sigma / Math.max(predicted, 1)) - 1);
  const rawHaloFraction = Math.min(1, rawHaloCents / maxCents);
  const haloClamped = rawHaloFraction > HALO_CAP_FRACTION;
  const haloFraction = haloClamped ? HALO_CAP_FRACTION : rawHaloFraction;
  return { maxCents, tickFraction, haloFraction, haloClamped };
}

/**
 * Format cents as `$1,234`. Returns `--` when the input is negative
 * or non-finite, so the gauge's label never shows `$NaN` during a
 * partial-render moment.
 */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return "--";
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString("en-US")}`;
}

export function ConfidenceGauge({ tick }: NnPanelProps): React.JSX.Element {
  const geo = useMemo(() => gaugeGeometry(tick), [tick]);
  const sigmaPct = (geo.haloFraction * 100).toFixed(1);
  const tickPct = (geo.tickFraction * 100).toFixed(1);
  const haloLeftPct = Math.max(0, geo.tickFraction - geo.haloFraction) * 100;
  const haloWidthPct = geo.haloFraction * 2 * 100;

  return (
    <div
      className="nn-panel-gauge"
      data-testid="nn-panel-gauge"
      data-phase={tick?.phase ?? "idle"}
      data-clamped={geo.haloClamped ? "1" : "0"}
      style={{ position: "relative", width: "100%", padding: "20px 12px 8px" }}
    >
      {geo.haloClamped && (
        <span
          className="nn-panel-gauge-unsure"
          style={{
            position: "absolute",
            left: `${tickPct}%`,
            transform: "translate(-50%, -100%)",
            top: 6,
            fontSize: 11,
            fontWeight: 700,
            color: PALETTE.textSecondary,
            opacity: 0.7,
            letterSpacing: 1.5,
          }}
        >
          UNSURE
        </span>
      )}
      <div
        className="nn-panel-gauge-track"
        style={{
          position: "relative",
          height: 12,
          background: "rgba(122, 133, 153, 0.18)",
          borderRadius: 6,
        }}
      >
        <div
          className="nn-panel-gauge-halo"
          style={{
            position: "absolute",
            left: `${haloLeftPct}%`,
            width: `${haloWidthPct}%`,
            top: -2,
            bottom: -2,
            background: "rgba(255, 224, 102, 0.18)",
            border: geo.haloClamped ? `1px dashed ${PALETTE.glow}` : `1px solid rgba(255, 224, 102, 0.4)`,
            borderRadius: 8,
            pointerEvents: "none",
          }}
        />
        <div
          className="nn-panel-gauge-tick"
          style={{
            position: "absolute",
            left: `${tickPct}%`,
            transform: "translateX(-50%)",
            top: -4,
            bottom: -4,
            width: 4,
            background: PALETTE.glow,
            borderRadius: 2,
          }}
        />
      </div>
      <div
        className="nn-panel-gauge-labels"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: PALETTE.textSecondary,
          marginTop: 6,
        }}
      >
        <span>$0</span>
        <span>
          {formatCents(tick?.prediction.cents ?? 0)} ± {sigmaPct}%
        </span>
        <span>{formatCents(geo.maxCents)}</span>
      </div>
    </div>
  );
}
