import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import ResultReaction from "../components/ResultReaction";

describe("ResultReaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows particles for high scores", () => {
    const { container } = render(<ResultReaction score={600} />);
    expect(container.querySelector(".reaction-container")).not.toBeNull();
  });

  it("shows particles for bad scores", () => {
    const { container } = render(<ResultReaction score={50} />);
    expect(container.querySelector(".reaction-container")).not.toBeNull();
  });

  it("adds negative class for bad scores", () => {
    const { container } = render(<ResultReaction score={50} />);
    expect(container.querySelector(".reaction-negative")).not.toBeNull();
  });

  it("does not show particles for medium scores", () => {
    const { container } = render(<ResultReaction score={300} />);
    expect(container.querySelector(".reaction-container")).toBeNull();
  });

  it("shows more confetti for scores >= 900", () => {
    const { container } = render(<ResultReaction score={950} />);
    const particles = container.querySelectorAll(".reaction-particle");
    // Big score → 30 particles
    expect(particles.length).toBe(30);
  });

  it("shows fewer confetti for scores 500-899", () => {
    const { container } = render(<ResultReaction score={600} />);
    const particles = container.querySelectorAll(".reaction-particle");
    expect(particles.length).toBe(16);
  });

  it("respects custom thresholds", () => {
    const { container } = render(
      <ResultReaction score={300} goodThreshold={200} badThreshold={50} />
    );
    // 300 >= goodThreshold(200), so should show particles
    expect(container.querySelector(".reaction-container")).not.toBeNull();
  });

  it("hides particles after 3 seconds", () => {
    const { container } = render(<ResultReaction score={600} />);
    expect(container.querySelector(".reaction-container")).not.toBeNull();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(container.querySelector(".reaction-container")).toBeNull();
  });
});
