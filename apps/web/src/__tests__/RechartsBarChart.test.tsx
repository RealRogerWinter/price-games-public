import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock recharts - components render as simple divs in jsdom
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="recharts-bar-chart">{children}</div>
  ),
  Bar: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-bar">{children}</div>
  ),
  Cell: () => <div data-testid="recharts-cell" />,
  XAxis: () => <div data-testid="recharts-xaxis" />,
  YAxis: () => <div data-testid="recharts-yaxis" />,
  Tooltip: () => <div data-testid="recharts-tooltip" />,
}));

import RechartsBarChart from "../components/charts/RechartsBarChart";

describe("RechartsBarChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 'No data available' when data is empty", () => {
    render(<RechartsBarChart data={[]} />);
    expect(screen.getByText("No data available")).toBeInTheDocument();
    expect(screen.getByTestId("hbar-chart-empty")).toBeInTheDocument();
  });

  it("renders chart container with data", () => {
    const data = [
      { label: "classic", value: 800 },
      { label: "higher-lower", value: 400 },
    ];
    render(<RechartsBarChart data={data} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
    expect(screen.getByTestId("recharts-bar-chart")).toBeInTheDocument();
  });

  it("renders cells for each data point", () => {
    const data = [
      { label: "classic", value: 800 },
      { label: "higher-lower", value: 400 },
      { label: "comparison", value: 200 },
    ];
    render(<RechartsBarChart data={data} />);
    const cells = screen.getAllByTestId("recharts-cell");
    expect(cells.length).toBe(3);
  });

  it("renders with custom color", () => {
    const data = [{ label: "classic", value: 100 }];
    render(<RechartsBarChart data={data} color="#9b59b6" />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
  });

  it("renders with custom formatValue", () => {
    const data = [{ label: "classic", value: 100 }];
    render(<RechartsBarChart data={data} formatValue={(v) => `${v}%`} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
  });

  it("calculates chart height based on data length", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      label: `mode-${i}`,
      value: (i + 1) * 100,
    }));
    render(<RechartsBarChart data={data} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
    const cells = screen.getAllByTestId("recharts-cell");
    expect(cells.length).toBe(10);
  });

  it("renders stacked bars when completed data is present", () => {
    const data = [
      { label: "classic", value: 800, completed: 700, inProgress: 50, abandoned: 50 },
      { label: "higher-lower", value: 400, completed: 350, inProgress: 30, abandoned: 20 },
    ];
    render(<RechartsBarChart data={data} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
    // Stacked mode renders 2 Bar elements with cells for each data point
    // Each data point gets a cell in both the completed and remaining bars
    const cells = screen.getAllByTestId("recharts-cell");
    expect(cells.length).toBe(4); // 2 data points x 2 stacked bars
  });

  it("renders non-stacked bars when completed is not present", () => {
    const data = [
      { label: "classic", value: 800 },
      { label: "higher-lower", value: 400 },
    ];
    render(<RechartsBarChart data={data} />);
    const cells = screen.getAllByTestId("recharts-cell");
    expect(cells.length).toBe(2);
  });
});
