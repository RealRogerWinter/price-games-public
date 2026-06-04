/**
 * NeuralDebugHud — bottom-corner numbers-only telemetry HUD that surfaces
 * the bot's neural-net internals for stream viewers who want the actual
 * model state behind Pricey's guesses.
 *
 * Two columns, side-by-side:
 *   - BELIEF (per-tick): top guess, top-prob confidence, entropy in bits,
 *     prediction spread σ, catalog classes that hold meaningful mass,
 *     and the top-3 softmax candidates with probabilities.
 *   - TRAINING (per-tick + 500ms heartbeat for live counters): current
 *     loss + 10-round average, gradient-norm p95, effective learning
 *     rate with warmup progress, replay-buffer fill, updates per round
 *     (= batchSize × stepsPerRound), golden-eval MAE, time since last
 *     snapshot (extrapolated locally between ticks for a "live" feel),
 *     and the cumulative teaching-moments counter.
 *
 * Mounted only when `?panels=` includes `debug` (the parser defaults to
 * "all on" so the HUD is on by default — same convention as the other
 * NN panels). Anchored bottom-right via inline-styled fixed positioning
 * so it renders OUTSIDE the aria-hidden broadcast shell, which means
 * the glass surface anchors to the viewport rather than the
 * 1920×1080 stage. Same pattern MoodDebugHud uses.
 */

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { NnTick } from "../state/overlayBus";

interface NeuralDebugHudProps {
  /** Latest tick or null when no tick has arrived. */
  tick: NnTick | null;
}

/* ---------- pure helpers (exported for tests) ---------------------- */

/**
 * Shannon entropy of a discrete probability distribution, in bits
 * (log base 2). Probabilities outside [0, 1] or non-finite contributions
 * are silently dropped — caller must already trust the input shape, the
 * sanitize layer enforces this for the wire path.
 */
export function entropyBits(probs: ReadonlyArray<number>): number {
  let h = 0;
  for (const p of probs) {
    if (!Number.isFinite(p) || p <= 0) continue;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Format cents to "$N.NN" with thousands separators. Returns "—" on bad input. */
export function formatCentsPrecise(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents) || cents < 0) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format effective learning rate as a compact mantissa-exponent number,
 * e.g. 8.5e-4. Falls back to "—" on non-finite input.
 */
export function formatLearningRate(lr: number): string {
  if (!Number.isFinite(lr) || lr <= 0) return "—";
  return lr.toExponential(1);
}

/**
 * Format ms-since-snapshot as a viewer-readable "X ago" string. Caller
 * is responsible for adding the local elapsed-since-receive offset to
 * the worker-emitted snapshotAgeMs so the value advances between ticks.
 *
 *   <60s          → "42s ago"
 *   60s..60m      → "12m 03s ago"
 *   ≥60m          → "2h 17m ago"
 */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec - totalMin * 60;
    return `${totalMin}m ${sec.toString().padStart(2, "0")}s ago`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin - hours * 60;
  return `${hours}h ${min.toString().padStart(2, "0")}m ago`;
}

/** Mean of a finite-numbers array; null when array is empty. */
export function mean(xs: ReadonlyArray<number>): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      s += x;
      n += 1;
    }
  }
  return n === 0 ? null : s / n;
}

/** "↓" (improving) / "↑" (worse) / "·" (flat or no signal). */
export function lossTrendArrow(now: number | null, avg: number | null): string {
  if (now === null || avg === null) return "·";
  if (!Number.isFinite(now) || !Number.isFinite(avg)) return "·";
  const d = now - avg;
  // 5% relative threshold so the arrow doesn't flip on noise.
  if (Math.abs(d) / Math.max(Math.abs(avg), 1e-6) < 0.05) return "·";
  return d < 0 ? "↓" : "↑";
}

/**
 * Count of price candidates whose probability mass is "meaningful" — a
 * crude proxy for how many catalog classes the model is actively
 * considering. Threshold of 0.5% means cold-start (uniform 1/103 ≈
 * 0.97%) reads as "model has narrowed to a handful of candidates", and
 * a well-trained run with 90% mass on the winner reads as "1 / 103".
 */
export function catalogActiveCount(
  candidates: ReadonlyArray<{ prob: number }> | undefined,
): number {
  if (!candidates) return 0;
  let n = 0;
  for (const c of candidates) {
    if (Number.isFinite(c.prob) && c.prob >= 0.005) n += 1;
  }
  return n;
}

/* ---------- component --------------------------------------------- */

/**
 * Bottom-right HUD that exposes Pricey's belief + training counters as
 * raw numbers. Renders even with a null tick (in which case both
 * columns show "—" placeholders) so the panel never disappears mid-stream.
 *
 * @param props.tick Latest NnTick or null.
 */
export default function NeuralDebugHud({ tick }: NeuralDebugHudProps): React.JSX.Element {
  // Bump a local clock every 500ms so derived "X s ago" values advance
  // visually between ticks. We capture the wall-clock at tick receive
  // time and add (now - receivedAt) to the worker-emitted snapshotAgeMs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Anchor the snapshot age in wall-clock terms by recording the local
  // arrival time of the latest tick. `tick.ageMs` is the worker's
  // Date.now() at emit, so receivedAt ≈ now when this effect fires.
  const [snapshotAnchor, setSnapshotAnchor] = useState<{
    snapshotAgeMs: number;
    receivedAt: number;
  } | null>(null);
  useEffect(() => {
    if (!tick?.health) return;
    setSnapshotAnchor({
      snapshotAgeMs: tick.health.snapshotAgeMs,
      receivedAt: Date.now(),
    });
  }, [tick?.health?.snapshotAgeMs, tick?.roundId]);

  const belief = useMemo(() => buildBeliefView(tick), [tick]);
  const training = useMemo(() => buildTrainingView(tick, snapshotAnchor, now), [tick, snapshotAnchor, now]);

  return (
    <div
      className="broadcast-debug-hud"
      data-testid="broadcast-debug-hud"
      role="presentation"
    >
      <div className="broadcast-debug-hud-header">NEURAL DEBUG</div>
      <div className="broadcast-debug-hud-cols">
        <DebugColumn
          testId="debug-col-belief"
          title="BELIEF"
          rows={belief.rows}
          footerLabel="Top-3 candidates"
          footerRows={belief.candidates}
        />
        <DebugColumn
          testId="debug-col-training"
          title="TRAINING"
          rows={training.rows}
          footerLabel={training.frozenLabel}
        />
      </div>
    </div>
  );
}

interface DebugRow {
  label: string;
  value: string;
  /** Optional secondary value rendered in a muted color, e.g. trend arrow. */
  hint?: string;
}

function DebugColumn({
  testId,
  title,
  rows,
  footerLabel,
  footerRows,
}: {
  testId: string;
  title: string;
  rows: ReadonlyArray<DebugRow>;
  footerLabel?: string;
  footerRows?: ReadonlyArray<{ label: string; value: string }>;
}): React.JSX.Element {
  return (
    <div className="broadcast-debug-hud-col" data-testid={testId}>
      <div className="broadcast-debug-hud-col-title">{title}</div>
      <dl className="broadcast-debug-hud-rows">
        {rows.map((r) => (
          <div key={r.label} className="broadcast-debug-hud-row">
            <dt>{r.label}</dt>
            <dd>
              <span className="broadcast-debug-hud-value">{r.value}</span>
              {r.hint ? <span className="broadcast-debug-hud-hint">{r.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {footerRows && footerRows.length > 0 ? (
        <>
          {footerLabel ? (
            <div className="broadcast-debug-hud-footer-label">{footerLabel}</div>
          ) : null}
          <dl className="broadcast-debug-hud-rows broadcast-debug-hud-rows-footer">
            {footerRows.map((r, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={`${r.label}-${i}`} className="broadcast-debug-hud-row">
                <dt>{r.label}</dt>
                <dd>
                  <span className="broadcast-debug-hud-value">{r.value}</span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : footerLabel ? (
        <div className="broadcast-debug-hud-footer-label" data-testid={`${testId}-footer-only`}>
          {footerLabel}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- view-model builders ----------------------------------- */

interface BeliefView {
  rows: DebugRow[];
  candidates: Array<{ label: string; value: string }>;
}

export function buildBeliefView(tick: NnTick | null): BeliefView {
  if (!tick) {
    return {
      rows: [
        { label: "Top guess", value: "—" },
        { label: "Confidence", value: "—" },
        { label: "Entropy", value: "—" },
        { label: "Spread (σ)", value: "—" },
        { label: "Catalog used", value: "—" },
      ],
      candidates: [],
    };
  }
  const candidates = tick.priceCandidates ?? [];
  const top = candidates[0];
  const probs = candidates.map((c) => c.prob);
  const ent = entropyBits(probs);
  const sigmaCents = tick.prediction.sigma;
  const rows: DebugRow[] = [
    { label: "Top guess", value: formatCentsPrecise(tick.prediction.cents) },
    {
      label: "Confidence",
      value: top ? `${Math.round(top.prob * 100)}%` : "—",
    },
    {
      label: "Entropy",
      value: probs.length > 0 ? `${ent.toFixed(2)} bits` : "—",
    },
    {
      label: "Spread (σ)",
      value: Number.isFinite(sigmaCents) && sigmaCents > 0
        ? `±${formatCentsPrecise(sigmaCents)}`
        : "—",
    },
    {
      label: "Catalog used",
      value: candidates.length > 0
        ? `${catalogActiveCount(candidates)} / ${candidates.length}`
        : "—",
    },
  ];
  const top3 = candidates.slice(0, 3).map((c) => ({
    label: formatCentsPrecise(c.cents),
    value: `${Math.round(c.prob * 100)}%`,
  }));
  return { rows, candidates: top3 };
}

interface TrainingView {
  rows: DebugRow[];
  frozenLabel?: string;
}

export function buildTrainingView(
  tick: NnTick | null,
  snapshotAnchor: { snapshotAgeMs: number; receivedAt: number } | null,
  now: number,
): TrainingView {
  const h = tick?.health;
  if (!h) {
    return {
      rows: [
        { label: "Loss (now)", value: "—" },
        { label: "Loss (10-avg)", value: "—" },
        { label: "Grad p95", value: "—" },
        { label: "LR", value: "—" },
        { label: "Replay", value: "—" },
        { label: "Updates/round", value: "—" },
        { label: "Golden MAE", value: "—" },
        { label: "Snapshot", value: "—" },
        { label: "Teaching", value: "—" },
      ],
    };
  }
  const recent = tick?.recentLosses ?? [];
  const last10 = recent.slice(-10);
  const lossNow = h.loss;
  const lossAvg = mean(last10);

  // Time since the worker last successfully wrote a snapshot —
  // extrapolate locally so the value ticks up between worker ticks.
  let snapshotMs = h.snapshotAgeMs;
  if (snapshotAnchor) {
    snapshotMs = snapshotAnchor.snapshotAgeMs + Math.max(0, now - snapshotAnchor.receivedAt);
  }
  const snapshotLabel = h.snapshotAgeMs === 0 ? "never" : formatAgo(snapshotMs);

  // Warmup progress — only render when the optimizer is still ramping
  // its LR. Once warmupStep exceeds warmupTotal the value is the
  // configured peak LR, so the warmup hint is misleading.
  const inWarmup = h.warmupTotal > 0 && h.warmupStep < h.warmupTotal;
  const warmupHint = inWarmup
    ? `warmup ${h.warmupStep}/${h.warmupTotal}`
    : undefined;

  const rows: DebugRow[] = [
    {
      label: "Loss (now)",
      value: lossNow === null ? "—" : lossNow.toFixed(3),
    },
    {
      label: "Loss (10-avg)",
      value: lossAvg === null ? "—" : lossAvg.toFixed(3),
      hint: lossTrendArrow(lossNow, lossAvg),
    },
    { label: "Grad p95", value: h.gradNormP95.toFixed(2) },
    {
      label: "LR",
      value: formatLearningRate(h.learningRate),
      hint: warmupHint,
    },
    { label: "Replay", value: `${h.bufferSize} / ${h.bufferCapacity}` },
    {
      label: "Updates/round",
      value: `${h.batchSize} × ${h.stepsPerRound}`,
    },
    {
      label: "Golden MAE",
      value: h.goldenMAE === null ? "—" : formatCentsPrecise(h.goldenMAE),
    },
    { label: "Snapshot", value: snapshotLabel },
    { label: "Teaching", value: `${h.teachingMomentsCount} active` },
  ];
  let frozenLabel: string | undefined;
  if (h.frozen) {
    frozenLabel = `⚠ frozen · ${h.nanRollbacks} NaN rollbacks`;
  } else if (h.nanRollbacks > 0) {
    frozenLabel = `${h.nanRollbacks} NaN rollbacks (recovered)`;
  }
  return { rows, frozenLabel };
}
