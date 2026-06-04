/**
 * Offline fixture viewer for the streamer-bot NN broadcast panels.
 *
 * Mount this component into a dev-only route to iterate on panel
 * visuals without spinning up the bot. Each row is a hand-built
 * VisualTick representing one of the lifecycle phases (idle,
 * thinking, guessing, reveal, result) plus a "teaching moment"
 * variation that triggers the aha pulse.
 *
 * NOT shipped to production — the dev route is intentionally
 * registered only when `import.meta.env.DEV` is true (see
 * apps/web/src/router or wherever the route is added). Tests don't
 * import this file.
 */

import type { NnTick } from "../../state/overlayBus";
import { NeuralNet } from "../NeuralNet";
import { ConfidenceGauge } from "../ConfidenceGauge";
import { RecentAccuracy } from "../RecentAccuracy";
import { PALETTE } from "../shared/palette";

function baseTick(overrides: Partial<NnTick>): NnTick {
  return {
    roundId: "fix-1",
    phase: "result",
    network: {
      layers: [
        { name: "input", activations: [0.1, 0.2, -0.1], mostActiveIdx: 4, mostActiveTrail: [0, 0] },
        { name: "trunk-hidden", activations: [0.4, -0.2, 0.5, 0.1], mostActiveIdx: 2, mostActiveTrail: [3, 1] },
        { name: "embedding", activations: [0.3, 0.2], mostActiveIdx: 0, mostActiveTrail: [1, 2] },
      ],
      weightSamples: Array.from({ length: 60 }, (_, i) => ({
        fromLayer: i % 2,
        fromIdx: (i * 3) % 12,
        toLayer: (i % 2) + 1,
        toIdx: (i * 5) % 16,
        weight: ((i * 17) % 100 - 50) / 50,
      })),
    },
    prediction: { cents: 1899, sigma: 320 },
    priceCandidates: [
      { cents: 1899, prob: 0.62 },
      { cents: 2199, prob: 0.18 },
      { cents: 1599, prob: 0.09 },
    ],
    belief: {
      topFeatures: [
        { name: "tok_pro", contribution: 0.42 },
        { name: "tok_wireless", contribution: 0.21 },
      ],
      sentence: "Pricey is sure: $18.99.",
    },
    embedding2d: { x: 0.6, y: -0.3 },
    recentLosses: Array.from({ length: 50 }, (_, i) => 0.6 - i * 0.008 + Math.sin(i / 4) * 0.05),
    recentAccuracy: ["miss", "within25", "within10", "miss", "within10", "within10"],
    teachingMoment: { triggered: false },
    ageMs: Date.now(),
    ...overrides,
  };
}

const FIXTURES: Array<{ label: string; tick: NnTick }> = [
  { label: "idle (no recent activity)", tick: baseTick({ phase: "idle" }) },
  { label: "thinking — model deciding", tick: baseTick({ phase: "thinking" }) },
  { label: "guessing — bid committed", tick: baseTick({ phase: "guessing" }) },
  {
    label: "reveal — hero path lit",
    tick: baseTick({
      phase: "reveal",
      network: {
        ...baseTick({}).network,
        heroPath: [
          { layer: 0, idx: 4 },
          { layer: 1, idx: 2 },
          { layer: 2, idx: 0 },
        ],
      },
    }),
  },
  { label: "result — settled", tick: baseTick({ phase: "result" }) },
  {
    label: "result + teaching moment 'aha'",
    tick: baseTick({
      phase: "result",
      teachingMoment: { triggered: true, productTitle: "Pro Wireless Mouse" },
    }),
  },
  {
    label: "low-confidence (UNSURE pill on gauge)",
    tick: baseTick({ phase: "result", prediction: { cents: 800, sigma: 6000 } }),
  },
];

export function PanelFixtures(): React.JSX.Element {
  return (
    <div
      style={{
        background: PALETTE.bg,
        color: PALETTE.textPrimary,
        padding: 16,
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 16 }}>NN panel fixtures</h1>
      {FIXTURES.map((fix, i) => (
        <section
          key={i}
          style={{
            marginBottom: 28,
            padding: 12,
            border: `1px solid ${PALETTE.textSecondary}33`,
            borderRadius: 8,
          }}
        >
          <h2 style={{ fontSize: 14, marginBottom: 12, color: PALETTE.textSecondary }}>{fix.label}</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
            <NeuralNet tick={fix.tick} />
            <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 320 }}>
              <ConfidenceGauge tick={fix.tick} />
              <RecentAccuracy tick={fix.tick} />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
