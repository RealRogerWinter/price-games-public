import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { KpiCard } from "../components/charts";

describe("KpiCard", () => {
  it("renders value and label", () => {
    render(<KpiCard value="1,500" label="Total Games" />);
    const card = screen.getByTestId("kpi-card");
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("1,500");
    expect(card).toHaveTextContent("Total Games");
  });

  it("does not render delta when not provided", () => {
    render(<KpiCard value="42" label="Last 24h" />);
    expect(screen.queryByTestId("kpi-delta")).not.toBeInTheDocument();
  });

  it("renders positive delta with up arrow", () => {
    render(<KpiCard value="300" label="Last 7d" delta={12.5} deltaLabel="vs prior" />);
    const delta = screen.getByTestId("kpi-delta");
    expect(delta).toBeInTheDocument();
    expect(delta.className).toContain("kpi-delta-up");
    expect(delta).toHaveTextContent("12.5%");
    expect(delta).toHaveTextContent("vs prior");
    // Up arrow ▲
    expect(delta).toHaveTextContent("\u25B2");
  });

  it("renders negative delta with down arrow", () => {
    render(<KpiCard value="100" label="Score" delta={-8.3} />);
    const delta = screen.getByTestId("kpi-delta");
    expect(delta).toBeInTheDocument();
    expect(delta.className).toContain("kpi-delta-down");
    expect(delta).toHaveTextContent("8.3%");
    // Down arrow ▼
    expect(delta).toHaveTextContent("\u25BC");
  });

  it("renders zero delta without directional class", () => {
    render(<KpiCard value="50" label="Test" delta={0} />);
    const delta = screen.getByTestId("kpi-delta");
    expect(delta.className).not.toContain("kpi-delta-up");
    expect(delta.className).not.toContain("kpi-delta-down");
  });
});
