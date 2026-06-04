import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import AutoLobbyCountdown from "../components/multiplayer/AutoLobbyCountdown";

// Override the global SoundContext mock for this file so each test can
// assert which sounds were played. The setupTests.ts mock returns a
// shared no-op `play`; here we swap in a vi.fn whose calls we can read.
const playSpy = vi.fn();
vi.mock("../audio/SoundContext", () => ({
  useSound: () => ({
    play: playSpy,
    stop: () => {},
    stopAll: () => {},
    volume: 0.5,
    setVolume: () => {},
    muted: false,
    setMuted: () => {},
    unlocked: true,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SoundProvider: ({ children }: any) => children,
}));

beforeEach(() => {
  playSpy.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AutoLobbyCountdown", () => {
  it("renders nothing when targetAt is absent", () => {
    const { container } = render(<AutoLobbyCountdown humanCount={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows 'Waiting for more players' copy when only one human is seated", () => {
    const target = new Date(Date.now() + 30_000).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={1} nowProvider={() => Date.parse(target) - 30_000} />);
    expect(screen.getByText(/Waiting for more players/i)).toBeInTheDocument();
  });

  it("shows the confident 'Starting in' copy when two or more humans are seated", () => {
    const target = new Date(Date.now() + 30_000).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={3} nowProvider={() => Date.parse(target) - 30_000} />);
    expect(screen.getByText(/^Starting in/i)).toBeInTheDocument();
  });

  it("renders the time as M:SS in its own monospace span", () => {
    const target = new Date(Date.now() + 32_000).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={1} nowProvider={() => Date.parse(target) - 32_000} />);
    expect(screen.getByText("0:32")).toBeInTheDocument();
  });

  it("flips to the urgent 'Get ready!' copy under 5 seconds", () => {
    const target = new Date(Date.now() + 4_000).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => Date.parse(target) - 4_000} />);
    expect(screen.getByText(/Get ready/i)).toBeInTheDocument();
  });

  it("exposes a progressbar with correct aria attributes", () => {
    const target = new Date(Date.now() + 20_000).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => Date.parse(target) - 20_000} />);
    const bar = screen.getByRole("progressbar", { name: /pre-game countdown/i });
    expect(bar).toBeInTheDocument();
    expect(bar.getAttribute("aria-valuemax")).toBeTruthy();
  });

  // === Sound behavior ========================================================
  // Drive the component with a controllable `nowProvider`; tick the 250 ms
  // poll and snapshot which SoundIds were emitted at each whole-second
  // boundary. The contract: critical cue fires once on the first whole-second
  // <= 5, ticks fire once per integer-second, round_start fires once at 0.

  it("does not play any sound while seconds remaining > 5", () => {
    const targetMs = 1_000_000;
    let now = targetMs - 10_000; // 10s out
    const target = new Date(targetMs).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => now} />);
    act(() => {
      now = targetMs - 6_000; // still > 5
      vi.advanceTimersByTime(250);
    });
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("fires timer_critical exactly once when entering the urgent window", () => {
    const targetMs = 2_000_000;
    let now = targetMs - 5_500;
    const target = new Date(targetMs).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => now} />);
    // Tick across the 5s boundary.
    act(() => {
      now = targetMs - 4_500;
      vi.advanceTimersByTime(250);
    });
    act(() => {
      now = targetMs - 3_500;
      vi.advanceTimersByTime(1000);
    });
    const criticalCalls = playSpy.mock.calls.filter(([id]) => id === "timer_critical");
    expect(criticalCalls).toHaveLength(1);
  });

  it("plays timer_critical even when the component mounts mid-urgent-window (late mount)", () => {
    // Late-mount edge case: targetAt arrives in state when only 3s remain.
    // The previous implementation gated the critical cue on `wholeSecond === 5`
    // and silently dropped it. Now the dedup ref fires it on the first
    // whole-second the component sees inside the urgent window.
    const targetMs = 3_000_000;
    const now = targetMs - 3_000;
    const target = new Date(targetMs).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => now} />);
    act(() => { vi.advanceTimersByTime(250); });
    const criticalCalls = playSpy.mock.calls.filter(([id]) => id === "timer_critical");
    expect(criticalCalls).toHaveLength(1);
  });

  it("plays round_start exactly once when secondsLeft hits zero", () => {
    const targetMs = 4_000_000;
    let now = targetMs - 1_000;
    const target = new Date(targetMs).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => now} />);
    // Cross zero.
    act(() => {
      now = targetMs;
      vi.advanceTimersByTime(250);
    });
    act(() => {
      now = targetMs + 500;
      vi.advanceTimersByTime(500);
    });
    const startCalls = playSpy.mock.calls.filter(([id]) => id === "round_start");
    expect(startCalls).toHaveLength(1);
  });

  it("emits one tick per integer-second (no duplicates from 250ms polling)", () => {
    const targetMs = 5_000_000;
    let now = targetMs - 4_500; // 4.5s left → next whole-second is 5
    const target = new Date(targetMs).toISOString();
    render(<AutoLobbyCountdown targetAt={target} humanCount={2} nowProvider={() => now} />);
    // Tick the 250ms poll four times within the same whole-second.
    for (let i = 0; i < 4; i++) {
      act(() => { vi.advanceTimersByTime(250); });
    }
    const tickCalls = playSpy.mock.calls.filter(([id]) => id === "timer_tick");
    // Should NOT be 4 — one whole-second crossed at most.
    expect(tickCalls.length).toBeLessThanOrEqual(2);
  });
});
