import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Timer from "../components/Timer";

describe("Timer", () => {
  it("displays seconds remaining", () => {
    render(<Timer secondsLeft={25} isRunning={true} />);
    expect(screen.getByText("25")).toBeInTheDocument();
  });

  it("has correct aria-label", () => {
    const { container } = render(<Timer secondsLeft={15} isRunning={true} />);
    const timerEl = container.querySelector(".timer");
    expect(timerEl).toHaveAttribute("aria-label", "Timer: 15 seconds remaining");
  });

  it("applies urgent class when 10 or fewer seconds", () => {
    const { container } = render(<Timer secondsLeft={10} isRunning={true} />);
    expect(container.querySelector(".timer-urgent")).toBeInTheDocument();
  });

  it("applies critical class when 5 or fewer seconds", () => {
    const { container } = render(<Timer secondsLeft={4} isRunning={true} />);
    expect(container.querySelector(".timer-critical")).toBeInTheDocument();
  });

  it("does not apply urgent/critical when not running", () => {
    const { container } = render(<Timer secondsLeft={3} isRunning={false} />);
    expect(container.querySelector(".timer-urgent")).not.toBeInTheDocument();
    expect(container.querySelector(".timer-critical")).not.toBeInTheDocument();
  });

  it("shows paused state with pause bars instead of seconds", () => {
    const { container } = render(<Timer secondsLeft={20} isRunning={true} paused />);
    expect(container.querySelector(".timer-paused")).toBeInTheDocument();
    // When paused, rects are rendered instead of text
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(2);
    // Should not show the seconds number
    expect(screen.queryByText("20")).not.toBeInTheDocument();
  });

  it("renders SVG circle elements", () => {
    const { container } = render(<Timer secondsLeft={30} isRunning={true} />);
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(2); // bg + progress
  });
});
