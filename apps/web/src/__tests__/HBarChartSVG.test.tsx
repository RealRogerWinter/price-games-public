import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HBarChart from "../components/charts/HBarChart";

describe("HBarChart (SVG)", () => {
  const sampleData = [
    { label: "classic", value: 800 },
    { label: "higher-lower", value: 400 },
    { label: "comparison", value: 200 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when data is empty", () => {
    render(<HBarChart data={[]} />);
    expect(screen.getByTestId("hbar-chart-empty")).toBeInTheDocument();
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("does not render chart container when data is empty", () => {
    render(<HBarChart data={[]} />);
    expect(screen.queryByTestId("hbar-chart")).not.toBeInTheDocument();
  });

  it("renders chart container when data is provided", () => {
    render(<HBarChart data={sampleData} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
  });

  it("does not show empty state when data is provided", () => {
    render(<HBarChart data={sampleData} />);
    expect(screen.queryByTestId("hbar-chart-empty")).not.toBeInTheDocument();
  });

  it("renders an SVG element", () => {
    const { container } = render(<HBarChart data={sampleData} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renders one bar rect per data point", () => {
    const { container } = render(<HBarChart data={sampleData} />);
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(sampleData.length);
  });

  it("renders label text for each data point", () => {
    render(<HBarChart data={sampleData} />);
    expect(screen.getByText("classic")).toBeInTheDocument();
    expect(screen.getByText("higher-lower")).toBeInTheDocument();
    expect(screen.getByText("comparison")).toBeInTheDocument();
  });

  it("renders value text for each data point using default formatter", () => {
    render(<HBarChart data={[{ label: "alpha", value: 1000 }]} />);
    // Default toLocaleString for 1000 => "1,000"
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("truncates labels longer than 18 characters to 16 chars + '...'", () => {
    const longLabel = "This is a very long label name here";
    render(<HBarChart data={[{ label: longLabel, value: 100 }]} />);
    // The component slices to 16 chars and appends "..."
    const truncated = longLabel.slice(0, 16) + "...";
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it("does not truncate labels of exactly 18 characters", () => {
    const label18 = "ExactlyEighteen!!1"; // 18 chars
    expect(label18.length).toBe(18);
    render(<HBarChart data={[{ label: label18, value: 100 }]} />);
    expect(screen.getByText(label18)).toBeInTheDocument();
  });

  it("does not truncate labels shorter than 18 characters", () => {
    const shortLabel = "Short";
    render(<HBarChart data={[{ label: shortLabel, value: 50 }]} />);
    expect(screen.getByText(shortLabel)).toBeInTheDocument();
    expect(screen.queryByText(shortLabel.slice(0, 16) + "...")).not.toBeInTheDocument();
  });

  it("applies custom color to bar rects", () => {
    const { container } = render(
      <HBarChart data={[{ label: "test", value: 100 }]} color="#9b59b6" />
    );
    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("#9b59b6");
  });

  it("uses custom formatValue for value display", () => {
    render(
      <HBarChart
        data={[{ label: "item", value: 1234 }]}
        formatValue={(v) => `$${v}`}
      />
    );
    expect(screen.getByText("$1234")).toBeInTheDocument();
  });

  it("changes label fill to white on hover (mouseEnter)", () => {
    const { container } = render(<HBarChart data={sampleData} />);
    const groups = container.querySelectorAll("g");
    const firstGroup = groups[0];

    const labelText = firstGroup.querySelector("text");
    const fillBefore = labelText?.getAttribute("fill");

    fireEvent.mouseEnter(firstGroup);

    const fillAfter = labelText?.getAttribute("fill");
    // The fill should change on hover
    expect(fillAfter).not.toBe(fillBefore);
  });

  it("restores label fill on mouseLeave", () => {
    const { container } = render(<HBarChart data={sampleData} />);
    const groups = container.querySelectorAll("g");
    const firstGroup = groups[0];
    const labelText = firstGroup.querySelector("text");

    const fillBefore = labelText?.getAttribute("fill");

    fireEvent.mouseEnter(firstGroup);
    const fillDuring = labelText?.getAttribute("fill");
    // Fill should change on hover
    expect(fillDuring).not.toBe(fillBefore);

    fireEvent.mouseLeave(firstGroup);
    const fillAfter = labelText?.getAttribute("fill");
    // Fill should be restored to original after mouseLeave
    expect(fillAfter).toBe(fillBefore);
  });

  it("changes rect opacity to 1 on hover", () => {
    const { container } = render(<HBarChart data={sampleData} />);
    const groups = container.querySelectorAll("g");
    const firstGroup = groups[0];
    const rect = firstGroup.querySelector("rect");

    const opacityBefore = rect?.getAttribute("opacity");

    fireEvent.mouseEnter(firstGroup);
    const opacityDuring = rect?.getAttribute("opacity");
    // Opacity should change on hover
    expect(opacityDuring).not.toBe(opacityBefore);

    fireEvent.mouseLeave(firstGroup);
    const opacityAfter = rect?.getAttribute("opacity");
    // Opacity should be restored to original after mouseLeave
    expect(opacityAfter).toBe(opacityBefore);
  });

  it("renders with a single data point without error", () => {
    render(<HBarChart data={[{ label: "one", value: 42 }]} />);
    expect(screen.getByTestId("hbar-chart")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
  });
});
