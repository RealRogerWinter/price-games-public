/**
 * Watchdog — monitors driver health and fires recovery actions when
 * the bot is stuck. Runs as a parallel `setInterval` independent of
 * the main lifecycle loop, so even if the loop is awaiting a hung
 * promise the watchdog still gets to react.
 *
 * Two escalation tiers:
 *   1. **No progress for ≥ `noProgressPanicMs`**  → `driver.panic()`,
 *      which closes the browser and forces a fresh launch on the
 *      next ensureSession.
 *   2. **≥ `maxPanicsInWindow` panics in `panicWindowMs`** →
 *      `process.exit(70)` so Docker restarts the container. This is
 *      the safety net for "the FSM logic is broken in a way our
 *      recovery can't reach."
 *
 * Healthy uptime decays the panic counter — every
 * `panicDecayWindowMs` of clean operation drops one panic credit.
 * Without this a long-running deployment would accumulate panics
 * over weeks and false-trigger on stale history.
 */

export interface DriverHealth {
  /** ms-since-epoch at last successful round completion. null until first success. */
  lastSuccessfulRoundAt: number | null;
  /**
   * ms-since-epoch at last lifecycle activity (plan start / driver
   * action). Updated more frequently than lastSuccessfulRoundAt;
   * used to detect "alive but stuck" vs "completely hung".
   */
  lastActivityAt: number;
  /** Number of panics fired in the current rolling window. */
  panicCount: number;
  /** ms-since-epoch of the most recent panic. null if none ever. */
  lastPanicAt: number | null;
}

export function createInitialHealth(now: number = Date.now()): DriverHealth {
  return {
    lastSuccessfulRoundAt: null,
    lastActivityAt: now,
    panicCount: 0,
    lastPanicAt: null,
  };
}

export interface WatchdogOptions {
  /** Maximum time without a successful round before firing panic. Default 4 min. */
  noProgressPanicMs?: number;
  /**
   * Maximum panics allowed in `panicWindowMs` before we give up and
   * exit so Docker can restart us. Default 5 / 1h.
   */
  maxPanicsInWindow?: number;
  panicWindowMs?: number;
  /**
   * Healthy-uptime decay: every N ms of clean operation drops one
   * panic credit. Default 30 min.
   */
  panicDecayWindowMs?: number;
  /** Watchdog tick interval. Default 5s. */
  tickMs?: number;
  /**
   * Called when the watchdog decides the driver is stuck. Production
   * wires this to `driver.panic()`. May return a promise; the
   * watchdog awaits it before resuming polling.
   */
  onPanic: (reason: string) => void | Promise<void>;
  /**
   * Called when too many panics fire in the rolling window. Default
   * `process.exit(70)`. Tests inject a recording stub.
   */
  onGiveUp?: (count: number) => void;
  /**
   * Inject a clock for tests. Defaults to Date.now.
   */
  now?: () => number;
}

export interface Watchdog {
  /** Start polling. Idempotent — second call is a no-op. */
  start(): void;
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Read-only view of current health state for /status endpoints. */
  getHealth(): Readonly<DriverHealth>;
  /** Mark a round as successfully completed. Resets the no-progress timer. */
  recordRoundSuccess(): void;
  /** Mark any non-trivial driver activity (plan start, navigation, etc.). */
  recordActivity(): void;
  /**
   * Manually fire a panic. Called by `page.on("crash"/"close")` hooks
   * — they don't need to wait for the no-progress timer.
   */
  triggerPanic(reason: string): Promise<void>;
}

export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? (() => Date.now());
  const noProgressPanicMs = opts.noProgressPanicMs ?? 4 * 60_000;
  const maxPanicsInWindow = opts.maxPanicsInWindow ?? 5;
  const panicWindowMs = opts.panicWindowMs ?? 60 * 60_000;
  const panicDecayWindowMs = opts.panicDecayWindowMs ?? 30 * 60_000;
  const tickMs = opts.tickMs ?? 5_000;
  const onGiveUp = opts.onGiveUp ?? ((count) => {
    // eslint-disable-next-line no-console
    console.error(`[watchdog] ${count} panics in window — exiting for Docker restart`);
    process.exit(70);
  });

  const health: DriverHealth = createInitialHealth(now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let panicking = false;
  // Latches to true once `onGiveUp` has fired so we don't double-
  // call it after the panic counter sits past the threshold across
  // multiple ticks.
  let gaveUp = false;

  async function tick(): Promise<void> {
    const t = now();

    // Healthy-uptime decay: drop a panic credit per clean window.
    if (health.panicCount > 0 && health.lastPanicAt !== null) {
      const sinceLastPanic = t - health.lastPanicAt;
      if (sinceLastPanic > panicDecayWindowMs) {
        health.panicCount = Math.max(0, health.panicCount - 1);
        // Reset the decay anchor so the next decrement requires
        // another clean window.
        health.lastPanicAt = t - panicDecayWindowMs;
      }
    }

    // No-progress check.
    if (panicking) return; // already mid-panic, don't double-fire
    const lastProgress = health.lastSuccessfulRoundAt ?? health.lastActivityAt;
    const stalled = t - lastProgress > noProgressPanicMs;
    if (stalled) {
      await fire("no_progress");
    }
  }

  async function fire(reason: string): Promise<void> {
    if (panicking) return;
    panicking = true;
    health.panicCount++;
    health.lastPanicAt = now();
    health.lastActivityAt = now(); // reset so we don't re-fire immediately
    try {
      await opts.onPanic(reason);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[watchdog] onPanic threw:", err);
    } finally {
      panicking = false;
    }
    if (health.panicCount >= maxPanicsInWindow && !gaveUp) {
      gaveUp = true;
      onGiveUp(health.panicCount);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, tickMs);
      // Don't keep the Node event loop alive on the watchdog alone.
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    getHealth() {
      return health;
    },
    recordRoundSuccess() {
      health.lastSuccessfulRoundAt = now();
      health.lastActivityAt = now();
    },
    recordActivity() {
      health.lastActivityAt = now();
    },
    async triggerPanic(reason: string) {
      await fire(reason);
    },
  };
}
