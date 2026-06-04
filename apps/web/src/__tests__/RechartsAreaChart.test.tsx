import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock recharts - components render as simple divs in jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children, onClick }: { children: React.ReactNode; onClick?: unknown; style?: unknown }) => (
    <div data-testid="recharts-area-chart" onClick={onClick as React.MouseEventHandler}>{children}</div>
  ),
  Area: () => <div data-testid="recharts-area" />,
  XAxis: () => <div data-testid="recharts-xaxis" />,
  YAxis: () => <div data-testid="recharts-yaxis" />,
  Tooltip: () => <div data-testid="recharts-tooltip" />,
  CartesianGrid: () => <div data-testid="recharts-grid" />,
}));

import RechartsAreaChart from "../components/charts/RechartsAreaChart";

describe("RechartsAreaChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 'No data available' when data is empty", () => {
    render(<RechartsAreaChart data={[]} />);
    expect(screen.getByText("No data available")).toBeInTheDocument();
    expect(screen.getByTestId("area-chart-empty")).toBeInTheDocument();
  });

  it("renders chart container with data", () => {
    const data = [
      { label: "2026-03-01", value: 10 },
      { label: "2026-03-02", value: 20 },
    ];
    render(<RechartsAreaChart data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
    expect(screen.getByTestId("recharts-area-chart")).toBeInTheDocument();
  });

  it("renders grid by default", () => {
    const data = [{ label: "2026-03-01", value: 10 }];
    render(<RechartsAreaChart data={data} />);
    expect(screen.getByTestId("recharts-grid")).toBeInTheDocument();
  });

  it("renders overlay area when overlayData is provided", () => {
    const data = [
      { label: "2026-03-01", value: 10 },
      { label: "2026-03-02", value: 20 },
    ];
    const overlay = [
      { label: "2026-03-01", value: 5 },
      { label: "2026-03-02", value: 15 },
    ];
    render(<RechartsAreaChart data={data} overlayData={overlay} />);
    // Two Area elements: primary + overlay
    const areas = screen.getAllByTestId("recharts-area");
    expect(areas.length).toBe(2);
  });

  it("renders single area without overlay data", () => {
    const data = [{ label: "2026-03-01", value: 10 }];
    render(<RechartsAreaChart data={data} />);
    const areas = screen.getAllByTestId("recharts-area");
    expect(areas.length).toBe(1);
  });

  it("accepts custom height", () => {
    const data = [{ label: "2026-03-01", value: 10 }];
    render(<RechartsAreaChart data={data} height={400} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("accepts custom colors", () => {
    const data = [{ label: "2026-03-01", value: 10 }];
    render(
      <RechartsAreaChart data={data} color="#ff0000" overlayColor="#00ff00" />
    );
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("exposes onDataPointClick callback", () => {
    const handleClick = vi.fn();
    const data = [
      { label: "2026-03-01", value: 10 },
      { label: "2026-03-02", value: 20 },
    ];
    render(<RechartsAreaChart data={data} onDataPointClick={handleClick} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders with formatValue prop", () => {
    const data = [{ label: "2026-03-01", value: 1000 }];
    render(<RechartsAreaChart data={data} formatValue={(v) => `$${v}`} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders multiple areas in multi-series mode", () => {
    const multiData = [
      { label: "2026-03-01", spTotal: 10, spCompleted: 8, mpTotal: 3, mpCompleted: 2 },
      { label: "2026-03-02", spTotal: 15, spCompleted: 12, mpTotal: 5, mpCompleted: 4 },
    ];
    const config = [
      { key: "spTotal", color: "#4a9eff", fillOpacity: 0.08, name: "SP Total" },
      { key: "spCompleted", color: "#4a9eff", fillOpacity: 0.2, name: "SP Completed" },
      { key: "mpTotal", color: "#2ed573", fillOpacity: 0.08, strokeDasharray: "4 2", name: "MP Total" },
      { key: "mpCompleted", color: "#2ed573", fillOpacity: 0.2, strokeDasharray: "4 2", name: "MP Completed" },
    ];
    render(
      <RechartsAreaChart
        data={[]}
        multiSeriesData={multiData}
        seriesConfig={config}
      />
    );
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
    // Should render 4 Area elements (one per series)
    const areas = screen.getAllByTestId("recharts-area");
    expect(areas.length).toBe(4);
  });

  it("falls back to standard mode when multiSeriesData is not provided", () => {
    const data = [
      { label: "2026-03-01", value: 10 },
      { label: "2026-03-02", value: 20 },
    ];
    render(<RechartsAreaChart data={data} />);
    const areas = screen.getAllByTestId("recharts-area");
    expect(areas.length).toBe(1);
  });
});
