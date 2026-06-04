/**
 * NeuralNet panel — the streaming-bot's "Hollywood AI" centerpiece.
 *
 * 560 × 400 canvas split into:
 *   - Network area (NETWORK_HEIGHT px tall): layered MLP diagram.
 *     Three layers shown — input (subsampled to 12 representative
 *     neurons), trunk-hidden (32), embedding (16). Bezier weight
 *     edges drawn between consecutive layers; edge color encodes
 *     weight sign, alpha + thickness encode |weight|. Top-quartile-
 *     magnitude edges render dashed and animate `lineDashOffset` so
 *     positive weights appear to flow forward (input → output) and
 *     negatives backward.
 *   - Bottom SPARKLINE_HEIGHT (24) px: thin loss sparkline of the
 *     last 50 losses.
 *
 * Per-frame motion (added in the polish pass):
 *   - Neuron radii pulse with the layer's activations vector so
 *     viewers see "which neurons fire" beat to beat.
 *   - For each most-active neuron, a small glow dot travels along
 *     every edge it touches — the "energy travelling along the
 *     network" effect that reads as "I'm thinking" on stream.
 *
 * Most-active neuron is rendered with a 12 px halo. Hero-path nodes
 * (delivered in the tick during `phase==='reveal'`) are highlighted
 * at 100% alpha while everything else dims to 8% — produces the
 * "I just learned this!" reveal moment per the plan.
 *
 * If `tick.teachingMoment.triggered` is true we also paint an
 * outward-expanding ring around the output node — the visual
 * counterpart of the Teaching Moments backend mechanic.
 *
 * The render loop is RAF-driven but capped at ~10 fps via a
 * timestamp gate; viewers can't tell the difference and the encoder
 * works less hard.
 */

import { useEffect, useRef } from "react";
import type { NnPanelProps } from "./shared/types";
import { PALETTE } from "./shared/palette";

const CANVAS_WIDTH = 560;
const CANVAS_HEIGHT = 400;
const SPARKLINE_HEIGHT = 24;
const NETWORK_HEIGHT = CANVAS_HEIGHT - SPARKLINE_HEIGHT;
const TARGET_FPS = 10;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

const INPUT_DISPLAY_NEURONS = 12;
const HIDDEN_DISPLAY_NEURONS = 32;
const EMBEDDING_DISPLAY_NEURONS = 16;

interface LayerLayout {
  x: number;
  neurons: number;
  yPositions: number[];
}

interface Point {
  x: number;
  y: number;
}

function buildLayout(): LayerLayout[] {
  const padding = 44;
  const usableWidth = CANVAS_WIDTH - padding * 2;
  const xs = [
    padding,
    padding + usableWidth / 2,
    padding + usableWidth,
  ];
  const counts = [INPUT_DISPLAY_NEURONS, HIDDEN_DISPLAY_NEURONS, EMBEDDING_DISPLAY_NEURONS];
  return xs.map((x, i) => {
    const count = counts[i];
    const verticalPadding = 24;
    const usableHeight = NETWORK_HEIGHT - verticalPadding * 2;
    const step = count > 1 ? usableHeight / (count - 1) : 0;
    const yPositions: number[] = [];
    for (let n = 0; n < count; n++) {
      yPositions.push(verticalPadding + n * step);
    }
    return { x, neurons: count, yPositions };
  });
}

const LAYOUT = buildLayout();

/**
 * Cubic bezier point at parameter t. Used to position travelling
 * activation pulses along edge curves. Exported via internals for
 * test coverage of the curve parametrisation.
 */
function cubicBezierPoint(p0: Point, c1: Point, c2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + ttt * p3.y,
  };
}

/** Resolve a (layer, idx) pair to canvas coordinates, or null if oob. */
function resolveNeuron(l: number, idx: number): Point | null {
  const layer = LAYOUT[l];
  if (!layer) return null;
  const y = layer.yPositions[idx % layer.neurons];
  if (y === undefined) return null;
  return { x: layer.x, y };
}

/**
 * Draw a single frame of the MLP visualisation.
 *
 * @param ctx    2D rendering context, bound to the panel canvas.
 * @param tick   Latest tick (or null — renders idle background only).
 * @param now    Current timestamp (ms) — drives dash flow + pulses.
 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  tick: NnPanelProps["tick"],
  now: number,
): void {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const heroSet = new Set<string>();
  const heroPath = tick?.network.heroPath;
  if (heroPath) {
    for (const h of heroPath) heroSet.add(`${h.layer}:${h.idx}`);
  }
  const heroActive = tick?.phase === "reveal" && heroSet.size > 0;

  // Compute the magnitude threshold for "top-quartile" edges (animated
  // dash flow + travelling pulses are reserved for these so the canvas
  // doesn't churn). Cheap nth_element is overkill at ~40 samples; just
  // sort a copy.
  let topQuartileThreshold = 0;
  if (tick && tick.network.weightSamples.length > 0) {
    const mags = tick.network.weightSamples.map((w) => Math.abs(w.weight)).sort((a, b) => a - b);
    const q3 = mags[Math.floor(mags.length * 0.75)] ?? 0;
    topQuartileThreshold = q3;
  }

  // Edges. Use additive blending so overlapping bright edges glow
  // brighter — reads like an energy graph on stream. We `save()` the
  // canvas state so the composite-op + dash + shadow accumulators
  // don't leak into the subsequent passes (the travelling-pulse pass
  // sets its own shadow; the neuron pass relies on default settings).
  if (tick) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const w of tick.network.weightSamples) {
      const fromCoord = resolveNeuron(w.fromLayer, w.fromIdx);
      const toCoord = resolveNeuron(w.toLayer, w.toIdx);
      if (!fromCoord || !toCoord) continue;
      const onHero = heroActive
        && heroSet.has(`${w.fromLayer}:${w.fromIdx}`)
        && heroSet.has(`${w.toLayer}:${w.toIdx}`);
      const dimmed = heroActive && !onHero ? 0.08 : 1;
      ctx.strokeStyle = w.weight >= 0 ? PALETTE.weightPositive : PALETTE.weightNegative;
      const mag = Math.min(1, Math.abs(w.weight));
      ctx.lineWidth = 0.6 + mag * 2.0;
      // Additive blending stacks alpha on overlapping edges, so we
      // pull the curve back from the non-additive design (which would
      // saturate the dense input→hidden grid into a flat wash). Keep
      // the floor low; lift only proportional to magnitude.
      ctx.globalAlpha = Math.min(1, (0.12 + mag * 0.55) * dimmed);

      const isTopQ = Math.abs(w.weight) >= topQuartileThreshold && topQuartileThreshold > 0;
      if (isTopQ) {
        ctx.setLineDash([6, 8]);
        // Positive weights flow forward (offset decreases over time so
        // dashes appear to march toward the output); negative reverse.
        // Compute the positive modulus first, then apply sign — JS's
        // `%` propagates the sign of the left operand, so the prior
        // `sign * (now * 0.06) % 14` worked only because operator
        // precedence stitched the sign into the modulus result.
        // Explicit form removes the precedence trap.
        const period = 14;
        const sign = w.weight >= 0 ? -1 : 1;
        const phase = (now * 0.06) % period;
        ctx.lineDashOffset = sign * phase;
      } else {
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      const mx = (fromCoord.x + toCoord.x) / 2;
      ctx.moveTo(fromCoord.x, fromCoord.y);
      ctx.bezierCurveTo(mx, fromCoord.y, mx, toCoord.y, toCoord.x, toCoord.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Travelling activation pulses — for each most-active neuron, walk
  // every weight sample that touches it and animate a small glow dot
  // along the bezier. Each edge gets its own phase offset (hashed
  // from its endpoints) so pulses don't all peak at the same `t`;
  // viewers see discrete signals firing across the network instead
  // of one synchronised wave.
  if (tick) {
    const period = 1100;
    const activeKeys = new Set<string>();
    for (let l = 0; l < tick.network.layers.length && l < LAYOUT.length; l++) {
      const layer = LAYOUT[l];
      const idx = tick.network.layers[l].mostActiveIdx % layer.neurons;
      activeKeys.add(`${l}:${idx}`);
    }
    ctx.save();
    ctx.fillStyle = PALETTE.glow;
    ctx.shadowColor = PALETTE.glow;
    ctx.shadowBlur = 8;
    for (const w of tick.network.weightSamples) {
      const touchesActive = activeKeys.has(`${w.fromLayer}:${w.fromIdx}`)
        || activeKeys.has(`${w.toLayer}:${w.toIdx}`);
      if (!touchesActive) continue;
      const from = resolveNeuron(w.fromLayer, w.fromIdx);
      const to = resolveNeuron(w.toLayer, w.toIdx);
      if (!from || !to) continue;
      // Per-edge phase offset in [0, 1). Cheap deterministic hash
      // from the four neuron indices keeps the same edge pulsing on
      // the same beat across frames.
      const hash = (
        (w.fromLayer * 131 + w.fromIdx * 17 + w.toLayer * 31 + w.toIdx * 7) % period
      ) / period;
      const t = (((now % period) / period) + hash) % 1;
      const mx = (from.x + to.x) / 2;
      const c1: Point = { x: mx, y: from.y };
      const c2: Point = { x: mx, y: to.y };
      const p = cubicBezierPoint(from, c1, c2, to, t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Neurons. Radius pulses with activation magnitude so high-firing
  // neurons visibly bulge each tick.
  for (let l = 0; l < LAYOUT.length; l++) {
    const layer = LAYOUT[l];
    const tickLayer = tick?.network.layers[l];
    for (let n = 0; n < layer.neurons; n++) {
      const onHero = heroActive && heroSet.has(`${l}:${n}`);
      const dimmed = heroActive && !onHero ? 0.08 : 1;
      const act = tickLayer ? Math.abs(tickLayer.activations[n] ?? 0) : 0;
      const radius = 2.8 + Math.min(1, act) * 2.4;
      ctx.fillStyle = PALETTE.textSecondary;
      ctx.globalAlpha = (0.5 + Math.min(1, act) * 0.4) * dimmed;
      ctx.beginPath();
      ctx.arc(layer.x, layer.yPositions[n], radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Most-active halo (per layer).
  if (tick) {
    ctx.save();
    ctx.fillStyle = PALETTE.glow;
    ctx.shadowColor = PALETTE.glow;
    ctx.shadowBlur = 16;
    for (let l = 0; l < tick.network.layers.length && l < LAYOUT.length; l++) {
      const layer = LAYOUT[l];
      const tickLayer = tick.network.layers[l];
      const idx = tickLayer.mostActiveIdx % layer.neurons;
      const y = layer.yPositions[idx];
      if (y === undefined) continue;
      ctx.beginPath();
      ctx.arc(layer.x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Aha pulse — concentric rings on the embedding layer's center.
  if (tick?.teachingMoment.triggered) {
    const last = LAYOUT[LAYOUT.length - 1];
    const cy = NETWORK_HEIGHT / 2;
    const baseRadius = 22;
    for (let r = 0; r < 3; r++) {
      ctx.strokeStyle = PALETTE.glow;
      ctx.globalAlpha = 0.6 - r * 0.18;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(last.x, cy, baseRadius + r * 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Sparkline.
  ctx.fillStyle = "#0d1422";
  ctx.fillRect(0, NETWORK_HEIGHT, CANVAS_WIDTH, SPARKLINE_HEIGHT);
  if (tick && tick.recentLosses.length >= 2) {
    const losses = tick.recentLosses;
    const max = Math.max(...losses, 1e-6);
    const min = Math.min(...losses);
    const range = max - min || 1;
    ctx.strokeStyle = PALETTE.weightNegative;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < losses.length; i++) {
      const x = (i / (losses.length - 1)) * CANVAS_WIDTH;
      const yNorm = (losses[i] - min) / range;
      const y = NETWORK_HEIGHT + (SPARKLINE_HEIGHT - 4) - yNorm * (SPARKLINE_HEIGHT - 8) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/**
 * NeuralNet panel component. Renders to a 2D canvas at ~10 fps; the
 * panel mounts/unmounts based on `?panels=` in BroadcastShell.
 */
export function NeuralNet({ tick }: NnPanelProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastDraw = 0;
    let raf = 0;
    function frame(ts: number): void {
      if (ts - lastDraw >= FRAME_INTERVAL) {
        if (ctx) drawFrame(ctx, tickRef.current, ts);
        lastDraw = ts;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      className="nn-panel-neural-net"
      data-testid="nn-panel-neural-net"
      aria-label="Neural network activity visualisation"
    />
  );
}

export const __neuralNetInternals = { drawFrame, LAYOUT, cubicBezierPoint };
