import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AreaChart from "../components/charts/AreaChart";

describe("AreaChart (SVG)", () => {
  const sampleData = [
    { label: "2026-03-01", value: 10 },
    { label: "2026-03-02", value: 25 },
    { label: "2026-03-03", value: 15 },
    { label: "2026-03-04", value: 30 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when data is empty", () => {
    render(<AreaChart data={[]} />);
    expect(screen.getByTestId("area-chart-empty")).toBeInTheDocument();
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("does not render the SVG chart container when data is empty", () => {
    render(<AreaChart data={[]} />);
    expect(screen.queryByTestId("area-chart")).not.toBeInTheDocument();
  });

  it("renders chart container when data is provided", () => {
    render(<AreaChart data={sampleData} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("does not show empty state when data is provided", () => {
    render(<AreaChart data={sampleData} />);
    expect(screen.queryByTestId("area-chart-empty")).not.toBeInTheDocument();
  });

  it("renders an SVG element with area and line paths", () => {
    const { container } = render(<AreaChart data={sampleData} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Two paths: area fill + line (at minimum)
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });

  it("renders grid lines when showGrid is true (default)", () => {
    const { container } = render(<AreaChart data={sampleData} />);
    const gridLines = container.querySelectorAll("line");
    expect(gridLines.length).toBeGreaterThan(0);
  });

  it("does not render grid lines when showGrid is false", () => {
    const { container } = render(<AreaChart data={sampleData} showGrid={false} />);
    const gridLines = container.querySelectorAll("line");
    expect(gridLines.length).toBe(0);
  });

  it("renders overlay path when overlayData is provided", () => {
    const overlay = [
      { label: "2026-03-01", value: 5 },
      { label: "2026-03-02", value: 12 },
      { label: "2026-03-03", value: 8 },
      { label: "2026-03-04", value: 20 },
    ];
    const { container } = render(<AreaChart data={sampleData} overlayData={overlay} />);
    const paths = container.querySelectorAll("path");
    // Primary area path + primary line + overlay line = 3 paths
    expect(paths.length).toBeGreaterThanOrEqual(3);
    // The overlay path has a strokeDasharray attribute
    const dashedPath = Array.from(paths).find(
      (p) => p.getAttribute("stroke-dasharray") !== null
    );
    expect(dashedPath).toBeTruthy();
  });

  it("does not render a dashed overlay path when overlayData is not provided", () => {
    const { container } = render(<AreaChart data={sampleData} />);
    const paths = container.querySelectorAll("path");
    const dashedPath = Array.from(paths).find(
      (p) => p.getAttribute("stroke-dasharray") !== null
    );
    expect(dashedPath).toBeUndefined();
  });

  it("shows tooltip circle and text on mouseEnter over a hover rect", () => {
    const { container } = render(<AreaChart data={sampleData} />);
    const hoverRects = container.querySelectorAll("rect[fill='transparent']");
    expect(hoverRects.length).toBe(sampleData.length);

    // No circle before hover
    expect(container.querySelector("circle")).not.toBeInTheDocument();

    fireEvent.mouseEnter(hoverRects[0]);

    // Circle appears after hover
    expect(container.querySelector("circle")).toBeInTheDocument();
  });

  it("hides tooltip indicator on mouseLeave", () => {
    const { container } = render(<AreaChart data={sampleData} />);
    const hoverRects = container.querySelectorAll("rect[fill='transparent']");

    fireEvent.mouseEnter(hoverRects[0]);
    expect(container.querySelector("circle")).toBeInTheDocument();

    fireEvent.mouseLeave(hoverRects[0]);
    expect(container.querySelector("circle")).not.toBeInTheDocument();
  });

  it("displays custom formatted value in tooltip on hover", () => {
    const formatValue = (v: number) => `$${v.toFixed(2)}`;
    const { container } = render(
      <AreaChart data={sampleData} formatValue={formatValue} />
    );
    const hoverRects = container.querySelectorAll("rect[fill='transparent']");
    fireEvent.mouseEnter(hoverRects[0]);
    // The formatted value of the first data point (10) should appear
    expect(screen.getByText("$10.00")).toBeInTheDocument();
  });

  it("renders x-axis labels for data points", () => {
    render(<AreaChart data={sampleData} />);
    // The chart truncates labels longer than 5 chars to the last 5 chars
    // "2026-03-01" => "-03-01" is 6 chars, truncated to "03-01"
    // At least the last data point is always labeled
    const lastLabel = sampleData[sampleData.length - 1].label.slice(-5);
    expect(screen.getByText(lastLabel)).toBeInTheDocument();
  });

  it("renders with a single data point without error", () => {
    render(<AreaChart data={[{ label: "Day 1", value: 42 }]} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders overlay circle on hover when overlayData provided and hoverIdx is in range", () => {
    const overlay = [
      { label: "2026-03-01", value: 5 },
      { label: "2026-03-02", value: 12 },
    ];
    const { container } = render(
      <AreaChart
        data={[
          { label: "2026-03-01", value: 10 },
          { label: "2026-03-02", value: 20 },
        ]}
        overlayData={overlay}
      />
    );
    const hoverRects = container.querySelectorAll("rect[fill='transparent']");
    fireEvent.mouseEnter(hoverRects[0]);
    // There should be 2 circles: primary data point + overlay data point
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(2);
  });

  it("applies custom color to the primary line stroke", () => {
    const { container } = render(
      <AreaChart data={sampleData} color="#ff0000" />
    );
    const primaryLine = Array.from(container.querySelectorAll("path")).find(
      (p) => p.getAttribute("stroke") === "#ff0000" && p.getAttribute("fill") === "none"
    );
    expect(primaryLine).toBeTruthy();
  });
});
