import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock recharts for jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <svg data-testid="recharts-bar-chart">{children}</svg>
  ),
  Bar: ({ children }: { children?: React.ReactNode }) => (
    <g data-testid="recharts-bar">{children}</g>
  ),
  Cell: () => <rect data-testid="recharts-cell" />,
  XAxis: () => <g data-testid="recharts-xaxis" />,
  YAxis: () => <g data-testid="recharts-yaxis" />,
  Tooltip: () => <g data-testid="recharts-tooltip" />,
}));

import { HBarChart } from "../components/charts";

describe("HBarChart", () => {
  const sampleData = [
    { label: "classic", value: 800 },
    { label: "higher-lower", value: 400 },
    { label: "comparison", value: 200 },
  ];

  it("renders chart container with data", () => {
    render(<HBarChart data={sampleData} />);
    const chart = screen.getByTestId("hbar-chart");
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId("recharts-bar-chart")).toBeInTheDocument();
  });

  it("renders correct number of cells for bars", () => {
    render(<HBarChart data={sampleData} />);
    const cells = screen.getAllByTestId("recharts-cell");
    expect(cells.length).toBe(sampleData.length);
  });

  it("shows empty state when no data", () => {
    render(<HBarChart data={[]} />);
    expect(screen.getByTestId("hbar-chart-empty")).toBeInTheDocument();
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("renders with custom color", () => {
    render(<HBarChart data={sampleData} color="#9b59b6" />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
  });

  it("renders with custom formatValue", () => {
    render(<HBarChart data={[{ label: "test", value: 1234 }]} formatValue={(v) => `$${v}`} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
  });
});
