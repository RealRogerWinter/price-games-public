import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock recharts for jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <svg data-testid="recharts-area-chart">{children}</svg>
  ),
  Area: () => <path data-testid="recharts-area" />,
  XAxis: () => <g data-testid="recharts-xaxis" />,
  YAxis: () => <g data-testid="recharts-yaxis" />,
  Tooltip: () => <g data-testid="recharts-tooltip" />,
  CartesianGrid: () => <g data-testid="recharts-grid" />,
}));

import { AreaChart } from "../components/charts";

describe("AreaChart", () => {
  const sampleData = [
    { label: "2026-03-01", value: 10 },
    { label: "2026-03-02", value: 25 },
    { label: "2026-03-03", value: 15 },
    { label: "2026-03-04", value: 30 },
  ];

  it("renders chart container with data", () => {
    render(<AreaChart data={sampleData} />);
    const chart = screen.getByTestId("area-chart");
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId("recharts-area-chart")).toBeInTheDocument();
  });

  it("renders area elements", () => {
    render(<AreaChart data={sampleData} />);
    const chart = screen.getByTestId("area-chart");
    expect(chart).toBeInTheDocument();
    // At least 1 area element for primary data
    const areas = screen.getAllByTestId("recharts-area");
    expect(areas.length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no data", () => {
    render(<AreaChart data={[]} />);
    expect(screen.getByTestId("area-chart-empty")).toBeInTheDocument();
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("renders overlay area when overlayData is provided", () => {
    const overlay = [
      { label: "2026-03-01", value: 5 },
      { label: "2026-03-02", value: 12 },
      { label: "2026-03-03", value: 8 },
      { label: "2026-03-04", value: 20 },
    ];
    render(<AreaChart data={sampleData} overlayData={overlay} />);
    const areas = screen.getAllByTestId("recharts-area");
    // 2 areas: primary + overlay
    expect(areas.length).toBe(2);
  });

  it("renders with single data point", () => {
    render(<AreaChart data={[{ label: "2026-03-01", value: 42 }]} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });
});
