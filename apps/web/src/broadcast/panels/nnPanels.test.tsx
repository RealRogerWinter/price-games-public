/**
 * Render tests for the streamer-bot NN broadcast panels.
 *
 * Per-panel coverage:
 *   - Renders without crash given null + null-tick.
 *   - Renders against a fixture tick for each phase.
 *   - Hits each behaviour-defining branch (UNSURE pill, hero path
 *     dimming, etc.) without depending on the bot's actual visual
 *     choreography (RAF-driven, hard to assert deterministically
 *     inside jsdom).
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NeuralNet, __neuralNetInternals } from "./NeuralNet";
import { ConfidenceGauge, gaugeGeometry, formatCents } from "./ConfidenceGauge";
import { RecentAccuracy, computeCorrectnessPct } from "./RecentAccuracy";
import { parsePanelsQuery, ALL_NN_PANELS } from "./shared/types";
import type { NnTick } from "../state/overlayBus";

function fixtureTick(overrides: Partial<NnTick> = {}): NnTick {
  return {
    roundId: "r-1",
    phase: "result",
    network: {
      layers: [
        { name: "input", activations: [0.1, 0.2], mostActiveIdx: 1, mostActiveTrail: [0, 0] },
        { name: "trunk-hidden", activations: [0.3, -0.1], mostActiveIdx: 0, mostActiveTrail: [0, 0] },
        { name: "embedding", activations: [0.4], mostActiveIdx: 0, mostActiveTrail: [0, 0] },
      ],
      weightSamples: [
        { fromLayer: 0, fromIdx: 0, toLayer: 1, toIdx: 0, weight: 0.5 },
        { fromLayer: 1, fromIdx: 1, toLayer: 2, toIdx: 0, weight: -0.3 },
      ],
    },
    prediction: { cents: 1500, sigma: 200 },
    belief: {
      topFeatures: [
        { name: "tok_pro", contribution: 0.4 },
        { name: "tok_wireless", contribution: 0.2 },
      ],
    },
    embedding2d: { x: 0.1, y: -0.2 },
    recentLosses: [0.5, 0.4, 0.3, 0.25, 0.2],
    recentAccuracy: ["miss", "within25", "within10", "within10"],
    teachingMoment: { triggered: false },
    ageMs: 1,
    ...overrides,
  };
}

describe("NeuralNet panel", () => {
  it("renders the canvas", () => {
    render(<NeuralNet tick={fixtureTick()} />);
    expect(screen.getByTestId("nn-panel-neural-net")).toBeInTheDocument();
  });

  it("renders against a null tick (idle background only)", () => {
    render(<NeuralNet tick={null} />);
    expect(screen.getByTestId("nn-panel-neural-net")).toBeInTheDocument();
  });

  it("LAYOUT enumerates 3 layers", () => {
    expect(__neuralNetInternals.LAYOUT.length).toBe(3);
    for (const l of __neuralNetInternals.LAYOUT) {
      expect(l.yPositions.length).toBe(l.neurons);
    }
  });

  it("native canvas is at least 540×360 so the dominant panel reads on stream", () => {
    // The polish PR bumped the network canvas (480×270 → 560×400) so the
    // bezier edges have room for travelling activation pulses + the
    // larger neuron radii. Lock the floor here so a future "shrink for
    // perf" diff has to update this test.
    render(<NeuralNet tick={fixtureTick()} />);
    const canvas = screen.getByTestId("nn-panel-neural-net") as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThanOrEqual(540);
    expect(canvas.height).toBeGreaterThanOrEqual(360);
  });

  it("exposes a cubicBezierPoint helper for travelling pulses", () => {
    // Each travelling pulse on a top-quartile edge interpolates a point
    // along the cubic bezier. The helper is exported so tests can lock
    // the contract; otherwise a refactor that swaps the parametrisation
    // could silently break the pulse path.
    expect(typeof __neuralNetInternals.cubicBezierPoint).toBe("function");
    const p = __neuralNetInternals.cubicBezierPoint(
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }, 0.5,
    );
    expect(p.x).toBeCloseTo(50, 3);
    expect(p.y).toBeCloseTo(50, 3);
  });
});

describe("ConfidenceGauge panel", () => {
  it("formats cents correctly", () => {
    expect(formatCents(0)).toBe("$0");
    expect(formatCents(123_45)).toBe("$123");
    expect(formatCents(NaN)).toBe("--");
    expect(formatCents(-50)).toBe("--");
  });

  it("haloClamped is true for huge sigma", () => {
    const tick = fixtureTick({ prediction: { cents: 1000, sigma: 5000 } });
    const geo = gaugeGeometry(tick);
    expect(geo.haloClamped).toBe(true);
  });

  it("haloClamped is false for modest sigma", () => {
    const tick = fixtureTick({ prediction: { cents: 1000, sigma: 50 } });
    const geo = gaugeGeometry(tick);
    expect(geo.haloClamped).toBe(false);
  });

  it("renders the UNSURE pill when clamped", () => {
    render(<ConfidenceGauge tick={fixtureTick({ prediction: { cents: 1000, sigma: 5000 } })} />);
    expect(screen.getByText("UNSURE")).toBeInTheDocument();
  });

  it("doesn't render UNSURE when within cap", () => {
    render(<ConfidenceGauge tick={fixtureTick({ prediction: { cents: 1000, sigma: 50 } })} />);
    expect(screen.queryByText("UNSURE")).toBeNull();
  });

  it("renders against a null tick", () => {
    render(<ConfidenceGauge tick={null} />);
    expect(screen.getByTestId("nn-panel-gauge")).toBeInTheDocument();
  });

  it("data-phase reflects the tick's phase", () => {
    render(<ConfidenceGauge tick={fixtureTick({ phase: "thinking" })} />);
    expect(screen.getByTestId("nn-panel-gauge").getAttribute("data-phase")).toBe("thinking");
  });
});

describe("RecentAccuracy panel", () => {
  it("renders 10 dots", () => {
    render(<RecentAccuracy tick={fixtureTick()} />);
    for (let i = 0; i < 10; i++) {
      expect(screen.getByTestId(`nn-dot-${i}`)).toBeInTheDocument();
    }
  });

  it("pads empty slots when fewer than 10 buckets", () => {
    render(<RecentAccuracy tick={fixtureTick({ recentAccuracy: ["within10"] })} />);
    const empty = screen.getByTestId("nn-dot-0");
    expect(empty.getAttribute("data-bucket")).toBe("empty");
    const filled = screen.getByTestId("nn-dot-9");
    expect(filled.getAttribute("data-bucket")).toBe("within10");
  });

  it("renders against a null tick", () => {
    render(<RecentAccuracy tick={null} />);
    expect(screen.getByTestId("nn-panel-recent-accuracy")).toBeInTheDocument();
  });

  it("marks the newest filled dot with data-newest=1 for animation hooks", () => {
    // The newest entry sits at the right edge; its data-newest hook is
    // what the entrance + ambient pulse keyframes attach to.
    render(<RecentAccuracy tick={fixtureTick()} />);
    const newest = screen.getByTestId("nn-dot-9");
    expect(newest.getAttribute("data-newest")).toBe("1");
    // Older dots should not have it.
    const older = screen.getByTestId("nn-dot-8");
    expect(older.getAttribute("data-newest")).not.toBe("1");
  });

  it("never marks an empty slot as newest", () => {
    render(<RecentAccuracy tick={fixtureTick({ recentAccuracy: [] })} />);
    for (let i = 0; i < 10; i++) {
      expect(screen.getByTestId(`nn-dot-${i}`).getAttribute("data-newest")).not.toBe("1");
    }
  });

  describe("correctness % display", () => {
    it("computes 100% when every bucket is within10", () => {
      expect(computeCorrectnessPct(["within10", "within10", "within10"])).toBe(100);
    });

    it("scores within25 as half a win and miss as zero", () => {
      // 1 + 0.5 + 0 = 1.5 / 3 = 50%
      expect(computeCorrectnessPct(["within10", "within25", "miss"])).toBe(50);
      // 0.5 + 0.5 = 1 / 2 = 50%
      expect(computeCorrectnessPct(["within25", "within25"])).toBe(50);
      // 0 / 2 = 0%
      expect(computeCorrectnessPct(["miss", "miss"])).toBe(0);
    });

    it("returns null when no buckets are filled (placeholder noise prevention)", () => {
      // The first-mount state shows no % — `0% over 0 rounds` would be
      // a meaningless cold-start figure that flickers as soon as the
      // first round lands.
      expect(computeCorrectnessPct([])).toBeNull();
    });

    it("renders the percentage chip alongside the dots when at least one round is filled", () => {
      render(<RecentAccuracy tick={fixtureTick({ recentAccuracy: ["within10", "within10", "miss"] })} />);
      const pct = screen.getByTestId("nn-panel-recent-accuracy-pct");
      // 1 + 1 + 0 = 2 / 3 ≈ 67%
      expect(pct.textContent).toBe("67%");
    });

    it("hides the percentage chip on a null tick (cold start)", () => {
      render(<RecentAccuracy tick={null} />);
      expect(screen.queryByTestId("nn-panel-recent-accuracy-pct")).toBeNull();
    });
  });
});

describe("parsePanelsQuery", () => {
  it("defaults to all panels when query is empty", () => {
    expect(parsePanelsQuery(null).size).toBe(ALL_NN_PANELS.length);
    expect(parsePanelsQuery("").size).toBe(ALL_NN_PANELS.length);
    expect(parsePanelsQuery(undefined).size).toBe(ALL_NN_PANELS.length);
  });

  it("respects a comma-separated allowlist", () => {
    const set = parsePanelsQuery("mlp,gauge");
    expect(set.has("mlp")).toBe(true);
    expect(set.has("gauge")).toBe(true);
    expect(set.has("dots")).toBe(false);
  });

  it("falls back to all-on when every token is unknown", () => {
    const set = parsePanelsQuery("nope,whatever");
    expect(set.size).toBe(ALL_NN_PANELS.length);
  });
});
