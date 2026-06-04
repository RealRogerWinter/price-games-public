/**
 * Diurnal shift scheduler primitives for ghost users.
 *
 * Each ghost runs on bursts of online time scattered across the day,
 * weighted toward peak hours and broken up by occasional rest periods.
 * Real DAU curves are heavily diurnal — synthetic activity that's
 * statistically uniform stands out, so this module exists to make the
 * shape of ghost activity match the shape of real activity.
 *
 * Pure functions only — no DB, no clock side-effects beyond Date.now().
 * The integration glue (deciding which ghost should start a shift right
 * now) lives in {@link ./manager.ts}.
 */

const MIN_SHIFT_MS = 5 * 60_000;
const MAX_SHIFT_MS = 90 * 60_000;
const SHIFT_MEDIAN_MIN = 25;
const SHIFT_LOG_SIGMA = 0.55;

const BREAK_PROB = 0.10;
const MIN_BREAK_MS = 1 * 3_600_000;
const BREAK_MEDIAN_HRS = 9;
const BREAK_LOG_SIGMA = 0.55;

/** Local-hour band considered "peak" for diurnal weighting. */
export const PEAK_HOURS = { start: 18, end: 22 } as const;

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sample a shift duration (milliseconds) for one ghost session.
 *
 * Lognormal distribution centered on ~25 minutes, clamped to [5min, 90min].
 */
export function sampleShiftDurationMs(): number {
  const minutes = Math.exp(Math.log(SHIFT_MEDIAN_MIN) + SHIFT_LOG_SIGMA * gauss());
  return Math.max(MIN_SHIFT_MS, Math.min(MAX_SHIFT_MS, Math.round(minutes * 60_000)));
}

/**
 * Returns true with probability {@link BREAK_PROB}. Called at the end of
 * each shift to decide whether the ghost takes a longer rest before the
 * next shift starts.
 */
export function shouldTakeBreak(): boolean {
  return Math.random() < BREAK_PROB;
}

/**
 * Sample a break duration (milliseconds). Median ~9h, lognormal, clamped
 * to ≥1h.
 */
export function sampleBreakDurationMs(): number {
  const hours = Math.exp(Math.log(BREAK_MEDIAN_HRS) + BREAK_LOG_SIGMA * gauss());
  return Math.max(MIN_BREAK_MS, Math.round(hours * 3_600_000));
}

/**
 * Diurnal weight for a given local hour-of-day [0..23]. The values aren't
 * absolute frequencies — they're relative weights consumed by
 * {@link sampleNextShiftStart} when picking which hour the next shift
 * starts in.
 *
 * Curve shape:
 *   - Peak (PEAK_HOURS.start..end inclusive): weight 1.0
 *   - Adjacent shoulder hours: weight 0.5
 *   - Daytime non-peak: weight 0.3
 *   - Night/early-morning trough (0-6): weight 0.05
 *   - Every hour returns a strictly positive weight so sampleNextShiftStart
 *     never gets stuck on a pathological zero-mass distribution.
 */
export function hourWeightForLocalHour(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= PEAK_HOURS.start && h <= PEAK_HOURS.end) return 1.0;
  if (h === PEAK_HOURS.start - 1 || h === PEAK_HOURS.end + 1) return 0.5;
  if (h >= 3 && h <= 5) return 0.05;
  if (h >= 0 && h <= 6) return 0.10;
  return 0.30;
}

/**
 * Convert a UTC epoch ms to a local hour-of-day for the given timezone,
 * using Intl. Defensive: malformed timezone falls back to the raw
 * UTC hour.
 */
function localHourForTimezone(epochMs: number, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) return new Date(epochMs).getUTCHours();
    const n = parseInt(hourPart.value, 10);
    if (Number.isNaN(n)) return new Date(epochMs).getUTCHours();
    return n % 24;
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}

/**
 * Pick a timestamp for the ghost's next shift start.
 *
 * Walks the next 24 hourly buckets, weights them by
 * {@link hourWeightForLocalHour}, samples one bucket, then jitters the
 * start time uniformly within that hour. The cumulative probability over
 * 24 hours is 1 — every ghost gets exactly one next-shift slot per
 * scheduling pass (no "skip a day" outcome here; that's what breaks are for).
 *
 * @param opts.now - Current epoch ms (defaults to Date.now()).
 * @param opts.timezone - IANA tz used for hour bucketing.
 */
export function sampleNextShiftStart(opts: { now?: number; timezone: string }): number {
  const now = opts.now ?? Date.now();
  const buckets: number[] = [];
  let total = 0;
  for (let offset = 1; offset <= 24; offset++) {
    const ts = now + offset * 3_600_000;
    const localHour = localHourForTimezone(ts, opts.timezone);
    const w = hourWeightForLocalHour(localHour);
    buckets.push(w);
    total += w;
  }
  let r = Math.random() * total;
  let chosen = buckets.length - 1;
  for (let i = 0; i < buckets.length; i++) {
    r -= buckets[i];
    if (r <= 0) { chosen = i; break; }
  }
  // Bucket `chosen` represents the hour `now + (chosen+1)h`; jitter inside
  // that hour so two ghosts picking the same bucket don't share a start.
  const bucketStart = now + (chosen + 1) * 3_600_000;
  const jitter = Math.floor(Math.random() * 3_600_000);
  return bucketStart - jitter;
}
