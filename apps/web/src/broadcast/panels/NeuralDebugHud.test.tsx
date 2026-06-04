/**
 * Tests for NeuralDebugHud — covers the pure helpers (entropy, ago,
 * trend arrow, catalog count) and the view-model builders (belief +
 * training rows). The component-level test confirms the full HUD
 * renders the expected labels for both columns + handles a null tick
 * with placeholder rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import NeuralDebugHud, {
  buildBeliefView,
  buildTrainingView,
  catalogActiveCount,
  entropyBits,
  formatAgo,
  formatCentsPrecise,
  formatLearningRate,
  lossTrendArrow,
  mean,
} from "./NeuralDebugHud";
import type { NnTick } from "../state/overlayBus";

function makeHealth(overrides: Partial<NonNullable<NnTick["health"]>> = {}): NonNullable<NnTick["health"]> {
  return {
    round: 142,
    loss: 0.83,
    gradNormP95: 0.42,
    learningRate: 8.5e-4,
    warmupStep: 142,
    warmupTotal: 200,
    bufferSize: 384,
    bufferCapacity: 512,
    batchSize: 16,
    stepsPerRound: 6,
    goldenMAE: 214,
    snapshotAgeMs: 42_000,
    teachingMomentsCount: 3,
    nanRollbacks: 0,
    frozen: false,
    ...overrides,
  };
}

function makeTick(overrides: Partial<NnTick> = {}): NnTick {
  return {
    roundId: "r-1",
    phase: "result",
    network: { layers: [], weightSamples: [] },
    prediction: { cents: 999, sigma: 340 },
    priceCandidates: [
      { cents: 999, prob: 0.62 },
      { cents: 1299, prob: 0.18 },
      { cents: 799, prob: 0.09 },
    ],
    belief: { topFeatures: [] },
    embedding2d: { x: 0, y: 0 },
    // Mean is exactly 0.91 — used by the "Loss (10-avg)" assertion below.
    recentLosses: [0.95, 0.93, 0.92, 0.91, 0.91, 0.91, 0.9, 0.9, 0.89, 0.88],
    recentAccuracy: [],
    teachingMoment: { triggered: false },
    health: makeHealth(),
    ageMs: Date.now(),
    ...overrides,
  };
}

/* ------------------------ pure helpers ----------------------------- */

describe("entropyBits", () => {
  it("returns 0 for a one-hot distribution", () => {
    expect(entropyBits([1])).toBe(0);
    expect(entropyBits([1, 0, 0, 0])).toBe(0);
  });

  it("returns log2(N) for a uniform distribution over N classes", () => {
    expect(entropyBits([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 5);
    expect(entropyBits([0.5, 0.5])).toBeCloseTo(1, 5);
  });

  it("ignores non-finite and non-positive entries", () => {
    expect(entropyBits([0.5, 0.5, NaN, -0.1, 0])).toBeCloseTo(1, 5);
  });

  it("matches expected entropy on a representative distribution", () => {
    // 0.6 / 0.3 / 0.1 → ≈1.295 bits
    expect(entropyBits([0.6, 0.3, 0.1])).toBeCloseTo(1.295, 2);
  });
});

describe("formatAgo", () => {
  it("renders sub-minute durations as Xs ago", () => {
    expect(formatAgo(0)).toBe("0s ago");
    expect(formatAgo(15_000)).toBe("15s ago");
    expect(formatAgo(59_999)).toBe("59s ago");
  });

  it("renders sub-hour durations as Xm SSs ago", () => {
    expect(formatAgo(60_000)).toBe("1m 00s ago");
    expect(formatAgo(125_500)).toBe("2m 05s ago");
    expect(formatAgo(59 * 60 * 1000 + 30_000)).toBe("59m 30s ago");
  });

  it("renders multi-hour durations as Xh MMm ago", () => {
    expect(formatAgo(60 * 60 * 1000)).toBe("1h 00m ago");
    expect(formatAgo(2 * 60 * 60 * 1000 + 17 * 60 * 1000)).toBe("2h 17m ago");
  });

  it("returns — on bad input", () => {
    expect(formatAgo(-1)).toBe("—");
    expect(formatAgo(NaN)).toBe("—");
  });
});

describe("formatCentsPrecise", () => {
  it("formats positive cents with thousands separators", () => {
    expect(formatCentsPrecise(999)).toBe("$9.99");
    expect(formatCentsPrecise(1234567)).toBe("$12,345.67");
  });

  it("returns — on null/negative/non-finite", () => {
    expect(formatCentsPrecise(null)).toBe("—");
    expect(formatCentsPrecise(undefined)).toBe("—");
    expect(formatCentsPrecise(-1)).toBe("—");
    expect(formatCentsPrecise(NaN)).toBe("—");
  });
});

describe("formatLearningRate", () => {
  it("returns scientific notation with one decimal place", () => {
    expect(formatLearningRate(8.5e-4)).toBe("8.5e-4");
    expect(formatLearningRate(1e-3)).toBe("1.0e-3");
  });

  it("returns — on non-positive or non-finite values", () => {
    expect(formatLearningRate(0)).toBe("—");
    expect(formatLearningRate(NaN)).toBe("—");
  });
});

describe("mean", () => {
  it("returns null on empty input", () => {
    expect(mean([])).toBeNull();
  });

  it("returns null when no values are finite", () => {
    expect(mean([NaN, Infinity, -Infinity])).toBeNull();
  });

  it("ignores non-finite entries when computing the average", () => {
    expect(mean([1, 3, NaN])).toBeCloseTo(2, 5);
  });
});

describe("lossTrendArrow", () => {
  it("returns ↓ when current loss is meaningfully below the rolling average", () => {
    expect(lossTrendArrow(0.5, 1.0)).toBe("↓");
  });

  it("returns ↑ when current loss is meaningfully above the rolling average", () => {
    expect(lossTrendArrow(1.5, 1.0)).toBe("↑");
  });

  it("returns · when the gap is within the noise floor (5%)", () => {
    expect(lossTrendArrow(1.02, 1.0)).toBe("·");
  });

  it("returns · on missing or non-finite inputs", () => {
    expect(lossTrendArrow(null, 1.0)).toBe("·");
    expect(lossTrendArrow(1.0, null)).toBe("·");
    expect(lossTrendArrow(NaN, 1.0)).toBe("·");
  });
});

describe("catalogActiveCount", () => {
  it("counts entries with prob ≥ 0.5%", () => {
    expect(
      catalogActiveCount([
        { prob: 0.6 }, { prob: 0.18 }, { prob: 0.005 }, { prob: 0.004 }, { prob: 0.001 },
      ]),
    ).toBe(3);
  });

  it("returns 0 on undefined or empty input", () => {
    expect(catalogActiveCount(undefined)).toBe(0);
    expect(catalogActiveCount([])).toBe(0);
  });
});

/* ------------------------ view-models ------------------------------ */

describe("buildBeliefView", () => {
  it("renders placeholder rows for a null tick", () => {
    const v = buildBeliefView(null);
    expect(v.candidates).toEqual([]);
    expect(v.rows.find((r) => r.label === "Top guess")?.value).toBe("—");
    expect(v.rows.find((r) => r.label === "Confidence")?.value).toBe("—");
  });

  it("populates rows from a populated tick", () => {
    const v = buildBeliefView(makeTick());
    expect(v.rows.find((r) => r.label === "Top guess")?.value).toBe("$9.99");
    expect(v.rows.find((r) => r.label === "Confidence")?.value).toBe("62%");
    // 0.62/0.18/0.09 has entropy ≈ 1.27 bits.
    expect(v.rows.find((r) => r.label === "Entropy")?.value).toMatch(/^1\.\d{2} bits$/);
    expect(v.rows.find((r) => r.label === "Spread (σ)")?.value).toBe("±$3.40");
    expect(v.rows.find((r) => r.label === "Catalog used")?.value).toBe("3 / 3");
    expect(v.candidates).toEqual([
      { label: "$9.99", value: "62%" },
      { label: "$12.99", value: "18%" },
      { label: "$7.99", value: "9%" },
    ]);
  });

  it("hides the spread row when sigma is zero (cold-start)", () => {
    const tick = makeTick({ prediction: { cents: 0, sigma: 0 } });
    const v = buildBeliefView(tick);
    expect(v.rows.find((r) => r.label === "Spread (σ)")?.value).toBe("—");
  });
});

describe("buildTrainingView", () => {
  const fixedNow = 1_700_000_000_000;

  it("renders placeholder rows when health is missing", () => {
    const tick = makeTick({ health: undefined });
    const v = buildTrainingView(tick, null, fixedNow);
    for (const row of v.rows) {
      expect(row.value).toBe("—");
    }
  });

  it("populates training rows from a healthy tick", () => {
    const tick = makeTick();
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.rows.find((r) => r.label === "Loss (now)")?.value).toBe("0.830");
    expect(v.rows.find((r) => r.label === "Loss (10-avg)")?.value).toBe("0.910");
    expect(v.rows.find((r) => r.label === "Grad p95")?.value).toBe("0.42");
    expect(v.rows.find((r) => r.label === "LR")?.value).toBe("8.5e-4");
    expect(v.rows.find((r) => r.label === "Replay")?.value).toBe("384 / 512");
    expect(v.rows.find((r) => r.label === "Updates/round")?.value).toBe("16 × 6");
    expect(v.rows.find((r) => r.label === "Golden MAE")?.value).toBe("$2.14");
    expect(v.rows.find((r) => r.label === "Snapshot")?.value).toBe("42s ago");
    expect(v.rows.find((r) => r.label === "Teaching")?.value).toBe("3 active");
  });

  it("renders the warmup hint while the optimizer is still ramping LR", () => {
    const tick = makeTick({ health: makeHealth({ warmupStep: 142, warmupTotal: 200 }) });
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.rows.find((r) => r.label === "LR")?.hint).toBe("warmup 142/200");
  });

  it("drops the warmup hint after warmup completes", () => {
    const tick = makeTick({ health: makeHealth({ warmupStep: 9999, warmupTotal: 200 }) });
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.rows.find((r) => r.label === "LR")?.hint).toBeUndefined();
  });

  it("extrapolates snapshot age between ticks via the local clock anchor", () => {
    const tick = makeTick({ health: makeHealth({ snapshotAgeMs: 30_000 }) });
    // The component "received" the tick 12s ago wall-clock — the panel
    // should report ~42s ago, not 30s.
    const anchor = { snapshotAgeMs: 30_000, receivedAt: fixedNow - 12_000 };
    const v = buildTrainingView(tick, anchor, fixedNow);
    expect(v.rows.find((r) => r.label === "Snapshot")?.value).toBe("42s ago");
  });

  it("renders 'never' when no snapshot has been written yet", () => {
    const tick = makeTick({ health: makeHealth({ snapshotAgeMs: 0 }) });
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.rows.find((r) => r.label === "Snapshot")?.value).toBe("never");
  });

  it("flags a frozen network with the count of NaN rollbacks", () => {
    const tick = makeTick({ health: makeHealth({ frozen: true, nanRollbacks: 11 }) });
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.frozenLabel).toBe("⚠ frozen · 11 NaN rollbacks");
  });

  it("notes recovered NaN rollbacks without the freeze warning", () => {
    const tick = makeTick({ health: makeHealth({ frozen: false, nanRollbacks: 2 }) });
    const v = buildTrainingView(tick, null, fixedNow);
    expect(v.frozenLabel).toBe("2 NaN rollbacks (recovered)");
  });
});

/* ------------------------ component -------------------------------- */

describe("<NeuralDebugHud />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders both columns with placeholder rows when tick is null", () => {
    render(<NeuralDebugHud tick={null} />);
    expect(screen.getByTestId("broadcast-debug-hud")).toBeInTheDocument();
    expect(screen.getByTestId("debug-col-belief")).toBeInTheDocument();
    expect(screen.getByTestId("debug-col-training")).toBeInTheDocument();
    // Belief side has the hard-coded labels.
    expect(screen.getByText("Top guess")).toBeInTheDocument();
    // Both columns should show — placeholders since tick is null.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(5);
  });

  it("renders the populated values for a tick with health data", () => {
    render(<NeuralDebugHud tick={makeTick()} />);
    // $9.99 appears twice (Top guess + first candidate); $12.99 only as a
    // candidate, so it's a clean signal that the column populated.
    expect(screen.getAllByText("$9.99").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("$12.99")).toBeInTheDocument();
    // 62% appears twice (Confidence row + first candidate); 18% only on
    // the candidate row — using it confirms the candidate list rendered.
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("16 × 6")).toBeInTheDocument();
    expect(screen.getByText("384 / 512")).toBeInTheDocument();
    expect(screen.getByText("warmup 142/200")).toBeInTheDocument();
  });

  it("re-renders snapshot age via the 500ms internal interval", () => {
    const tick = makeTick({ health: makeHealth({ snapshotAgeMs: 30_000 }) });
    render(<NeuralDebugHud tick={tick} />);
    // First render: snapshot reads 30s ago (no anchor offset yet).
    expect(screen.getByText("30s ago")).toBeInTheDocument();
    // Advance the fake clock by 5s and let the interval fire.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("35s ago")).toBeInTheDocument();
  });
});
