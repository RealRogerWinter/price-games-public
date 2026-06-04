/**
 * Rolling metrics for adaptive driver timeouts. The bot runs 24/7;
 * latency drifts slowly as network conditions, server load, and
 * Chromium memory pressure change. Fixed timeouts are wrong in both
 * directions:
 *  - Too short: a healthy slow round triggers a false timeout, the
 *    runner reloads the page, the round dies for no reason.
 *  - Too long: a wedged page burns the full timeout before the
 *    runner can recover, dragging rounds-per-hour down.
 *
 * The adaptive timeout is `clamp(p95 + safetyMs, floor, ceiling)`.
 * Critical: only **successful** observations contribute to the rolling
 * window — adding timeout observations would feedback-loop into ever-
 * growing timeouts. Floors and ceilings are absolute hard limits.
 *
 * Implementation: ring buffer of recent samples plus a memoised
 * sorted view recomputed on read. For the sample sizes we need
 * (~200) the cost is negligible; we lean on simplicity over a more
 * elaborate streaming-percentile estimator.
 */

export interface AdaptiveTimeoutConfig {
  /** Default timeout returned while the sample buffer is bootstrapping. */
  defaultMs: number;
  /** Hard lower bound. */
  floorMs: number;
  /** Hard upper bound. Once hit, the bot escalates to RECOVERING. */
  ceilingMs: number;
  /**
   * Headroom added to the rolling p95 before clamping. Buffers
   * normal jitter; default 2s. Larger = more tolerant, smaller =
   * faster failure detection.
   */
  safetyMs?: number;
  /** Minimum samples before adapting away from `defaultMs`. */
  bootstrapSamples?: number;
}

export interface RollingMetric {
  /** Record a successful observation (in ms). Timeouts must NOT be recorded. */
  observe(durationMs: number): void;
  /** Number of samples currently in the window. */
  sampleCount(): number;
  /** Rolling p95 over the current window. NaN before bootstrap. */
  p95(): number;
  /**
   * Compute the next adaptive timeout. Returns the default while
   * bootstrapping; otherwise `clamp(p95 + safetyMs, floor, ceiling)`.
   */
  timeout(): number;
}

/**
 * Build a rolling metric. `windowSize` is the maximum sample count
 * retained — older samples drop off the back as new ones arrive.
 *
 * @param config Per-metric tuning (defaults, clamps, safety).
 * @param windowSize Sample retention. Default 200 — about an hour
 *                   of round-result-next observations at the bot's
 *                   current ~3-rounds-per-minute throughput.
 */
export function createRollingMetric(
  config: AdaptiveTimeoutConfig,
  windowSize = 200,
): RollingMetric {
  const samples: number[] = [];
  const safetyMs = config.safetyMs ?? 2_000;
  const bootstrapSamples = config.bootstrapSamples ?? 10;

  return {
    observe(durationMs: number): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      samples.push(durationMs);
      if (samples.length > windowSize) {
        samples.shift();
      }
    },
    sampleCount(): number {
      return samples.length;
    },
    p95(): number {
      if (samples.length < bootstrapSamples) return Number.NaN;
      const sorted = [...samples].sort((a, b) => a - b);
      // p95 index — for a 100-sample window, that's index 95.
      // For shorter windows, ceil(0.95 * n) - 1 still lands within bounds.
      const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
      return sorted[idx];
    },
    timeout(): number {
      if (samples.length < bootstrapSamples) return config.defaultMs;
      const p95 = this.p95();
      const candidate = p95 + safetyMs;
      return Math.max(config.floorMs, Math.min(config.ceilingMs, candidate));
    },
  };
}

/**
 * Default tuning for the bot's two key adaptive metrics. Floors are
 * tight (fail fast on consistently-fast environments) and ceilings
 * give 25–30s headroom for slow ones — beyond that the bot escalates
 * to its recovery path rather than waiting longer.
 */
export const DRIVER_METRIC_DEFAULTS = {
  roundStart: {
    defaultMs: 10_000,
    floorMs: 5_000,
    ceilingMs: 30_000,
  } satisfies AdaptiveTimeoutConfig,
  resultModalPrimary: {
    defaultMs: 12_000,
    floorMs: 6_000,
    ceilingMs: 25_000,
  } satisfies AdaptiveTimeoutConfig,
  resultModalExtension: {
    defaultMs: 18_000,
    floorMs: 9_000,
    ceilingMs: 30_000,
  } satisfies AdaptiveTimeoutConfig,
};

export interface DriverMetrics {
  roundStart: RollingMetric;
  resultModalPrimary: RollingMetric;
  resultModalExtension: RollingMetric;
}

/** Build a fresh metric set with default tuning. */
export function createDriverMetrics(): DriverMetrics {
  return {
    roundStart: createRollingMetric(DRIVER_METRIC_DEFAULTS.roundStart),
    resultModalPrimary: createRollingMetric(DRIVER_METRIC_DEFAULTS.resultModalPrimary),
    resultModalExtension: createRollingMetric(DRIVER_METRIC_DEFAULTS.resultModalExtension),
  };
}
