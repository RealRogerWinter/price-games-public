import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { useTimer } from "../hooks/useTimer";
import { GamePauseProvider, useGamePause } from "../context/GamePauseContext";

describe("useTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes with full duration and not running", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(30, onExpire));

    expect(result.current.secondsLeft).toBe(30);
    expect(result.current.isRunning).toBe(false);
  });

  it("counts down when started", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(10, onExpire));

    act(() => result.current.start());
    expect(result.current.isRunning).toBe(true);
    expect(result.current.secondsLeft).toBe(10);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.secondsLeft).toBe(7);
  });

  it("calls onExpire when timer reaches zero", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(3, onExpire));

    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(3000); });

    expect(result.current.secondsLeft).toBe(0);
    expect(result.current.isRunning).toBe(false);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("stops counting when stop is called", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(10, onExpire));

    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => result.current.stop());
    expect(result.current.isRunning).toBe(false);

    const frozenValue = result.current.secondsLeft;
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.secondsLeft).toBe(frozenValue);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("resets to full duration and stops running", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(10, onExpire));

    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => result.current.reset());

    expect(result.current.secondsLeft).toBe(10);
    expect(result.current.isRunning).toBe(false);
  });

  it("uses latest onExpire callback (ref pattern)", () => {
    const onExpire1 = vi.fn();
    const onExpire2 = vi.fn();
    const { result, rerender } = renderHook(
      ({ cb }) => useTimer(2, cb),
      { initialProps: { cb: onExpire1 } }
    );

    act(() => result.current.start());
    rerender({ cb: onExpire2 });
    act(() => { vi.advanceTimersByTime(2000); });

    expect(onExpire1).not.toHaveBeenCalled();
    expect(onExpire2).toHaveBeenCalledOnce();
  });

  it("can be started again after stopping", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(5, onExpire));

    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => result.current.stop());
    act(() => result.current.start());

    // Should restart from full duration
    expect(result.current.secondsLeft).toBe(5);
    expect(result.current.isRunning).toBe(true);
  });

  it("does not go below zero", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useTimer(2, onExpire));

    act(() => result.current.start());
    // Advance exactly to expiration
    act(() => { vi.advanceTimersByTime(2000); });

    expect(result.current.secondsLeft).toBe(0);
    expect(onExpire).toHaveBeenCalled();
  });

  describe("with GamePauseProvider", () => {
    function wrapper({ children }: { children: ReactNode }) {
      return <GamePauseProvider>{children}</GamePauseProvider>;
    }

    function renderTimerWithPause(duration: number, onExpire: () => void) {
      return renderHook(
        () => {
          const timer = useTimer(duration, onExpire);
          const pause = useGamePause();
          return { timer, pause };
        },
        { wrapper },
      );
    }

    it("freezes the countdown while paused and resumes from the same second", () => {
      const onExpire = vi.fn();
      const { result } = renderTimerWithPause(10, onExpire);

      act(() => result.current.timer.start());
      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current.timer.secondsLeft).toBe(7);

      act(() => result.current.pause.pause());
      const frozen = result.current.timer.secondsLeft;
      act(() => { vi.advanceTimersByTime(5000); });
      expect(result.current.timer.secondsLeft).toBe(frozen);
      expect(onExpire).not.toHaveBeenCalled();

      act(() => result.current.pause.resume());
      act(() => { vi.advanceTimersByTime(2000); });
      expect(result.current.timer.secondsLeft).toBe(frozen - 2);
    });

    it("does not start the interval when start() runs while already paused", () => {
      // Reproduces the race the code review flagged: a fetch resolves while
      // an auth modal is open and calls timer.start(). The interval must
      // stay parked until the modal closes; secondsLeft must not tick down.
      const onExpire = vi.fn();
      const { result } = renderTimerWithPause(8, onExpire);

      act(() => result.current.pause.pause());
      act(() => result.current.timer.start());
      // Caller's intent is "running", but the global pause must override.
      expect(result.current.timer.isRunning).toBe(true);

      act(() => { vi.advanceTimersByTime(5000); });
      expect(result.current.timer.secondsLeft).toBe(8);
      expect(onExpire).not.toHaveBeenCalled();

      act(() => result.current.pause.resume());
      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current.timer.secondsLeft).toBe(5);
    });

    it("only resumes timers whose isRunning was set", () => {
      const onExpire = vi.fn();
      const { result } = renderTimerWithPause(5, onExpire);

      // Pause/resume without ever calling start — interval must stay idle.
      act(() => result.current.pause.pause());
      act(() => result.current.pause.resume());
      act(() => { vi.advanceTimersByTime(5000); });
      expect(result.current.timer.secondsLeft).toBe(5);
      expect(result.current.timer.isRunning).toBe(false);
    });
  });
});
