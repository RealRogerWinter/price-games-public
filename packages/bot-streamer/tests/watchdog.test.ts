/**
 * Tests for the watchdog. The unit tests use an injected clock and
 * tick-by-hand pattern so we can fast-forward time without sleeping.
 *
 * Watchdog contract:
 *  1. Fires `onPanic` when no-progress duration > threshold.
 *  2. Doesn't fire while a panic is in flight (no double-fire).
 *  3. Decays panicCount by 1 per `panicDecayWindowMs` of clean
 *     uptime.
 *  4. Calls `onGiveUp` when panicCount reaches the cap.
 *  5. `recordRoundSuccess` and `recordActivity` reset the
 *     no-progress timer.
 */

import { describe, it, expect, vi } from "vitest";
import { createWatchdog } from "../src/runner/watchdog";

describe("createWatchdog", () => {
  it("does not fire panic immediately on start", () => {
    const onPanic = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 1000,
      tickMs: 100,
      onPanic,
      onGiveUp: () => {},
    });
    wd.start();
    expect(onPanic).not.toHaveBeenCalled();
    wd.stop();
  });

  it("triggerPanic fires onPanic synchronously", async () => {
    const onPanic = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 60_000,
      onPanic,
      onGiveUp: () => {},
    });
    await wd.triggerPanic("crash");
    expect(onPanic).toHaveBeenCalledWith("crash");
    expect(wd.getHealth().panicCount).toBe(1);
  });

  it("calls onGiveUp once panicCount reaches the cap", async () => {
    const onGiveUp = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 60_000,
      maxPanicsInWindow: 3,
      onPanic: () => {},
      onGiveUp,
    });
    await wd.triggerPanic("a");
    await wd.triggerPanic("b");
    expect(onGiveUp).not.toHaveBeenCalled();
    await wd.triggerPanic("c");
    expect(onGiveUp).toHaveBeenCalledWith(3);
  });

  it("recordRoundSuccess prevents the no-progress panic from firing", async () => {
    // Real timers + a small noProgressPanicMs lets us assert the
    // tick actually walks through the no-progress branch. Without
    // recordRoundSuccess this would fire panic; with it, the timer
    // resets each round and panic stays at 0.
    const onPanic = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 100,
      tickMs: 30,
      onPanic,
      onGiveUp: () => {},
    });
    wd.start();
    // Hammer recordRoundSuccess every 20ms for ~250ms — the
    // watchdog ticks every 30ms but never sees a stall longer
    // than the round-success interval.
    const stamp = setInterval(() => wd.recordRoundSuccess(), 20);
    await new Promise((r) => setTimeout(r, 250));
    clearInterval(stamp);
    wd.stop();
    expect(onPanic).not.toHaveBeenCalled();
  });

  it("fires panic when no round success arrives within the budget", async () => {
    const onPanic = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 80,
      tickMs: 30,
      onPanic,
      onGiveUp: () => {},
    });
    wd.start();
    // No recordRoundSuccess calls — let the no-progress timer
    // expire and the tick fire panic.
    await new Promise((r) => setTimeout(r, 300));
    wd.stop();
    expect(onPanic).toHaveBeenCalled();
  });

  it("decays panicCount when a clean window elapses (real ticks)", async () => {
    let t = 1_000_000;
    const wd = createWatchdog({
      noProgressPanicMs: 60_000,
      panicDecayWindowMs: 50,
      tickMs: 20,
      onPanic: () => {},
      onGiveUp: () => {},
      now: () => t,
    });
    await wd.triggerPanic("a");
    await wd.triggerPanic("b");
    expect(wd.getHealth().panicCount).toBe(2);
    // Reset lastSuccessfulRoundAt so the no-progress branch doesn't
    // re-fire panics during this test.
    wd.recordRoundSuccess();
    wd.start();
    // Advance the injected clock past the decay window AND let real
    // ticks fire so they invoke the decay branch.
    t += 70;
    await new Promise((r) => setTimeout(r, 60));
    wd.stop();
    expect(wd.getHealth().panicCount).toBeLessThan(2);
  });

  it("onGiveUp fires only once even after additional panics past threshold", async () => {
    const onGiveUp = vi.fn();
    const wd = createWatchdog({
      noProgressPanicMs: 60_000,
      maxPanicsInWindow: 2,
      onPanic: () => {},
      onGiveUp,
    });
    await wd.triggerPanic("a");
    await wd.triggerPanic("b");
    await wd.triggerPanic("c");
    await wd.triggerPanic("d");
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });
});
