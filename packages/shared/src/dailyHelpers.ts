/**
 * Pure helpers for the daily challenge mode. No DB, no React, no I/O —
 * everything in this file must be deterministic and side-effect free so
 * both the server seed generator and the web countdown widget can rely on
 * identical behavior.
 */

import type { GameMode } from "./types.js";
import { DAILY_POOL, DAILY_LAUNCH_EPOCH } from "./constants.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2020;
const MAX_YEAR = 2098;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format a Date as a UTC YYYY-MM-DD string. Always uses UTC slicing —
 * never local accessors — so the returned string is identical regardless
 * of where the host machine is configured.
 *
 * @param d - The date to format
 * @returns A 10-character YYYY-MM-DD string
 */
export function getUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Validate a daily-date string. Accepts only well-formed YYYY-MM-DD that
 * represents a real calendar date in a sane range (2020..2098).
 *
 * @param date - The candidate string
 * @returns true iff the string is parseable, well-formed, and in range
 */
export function isValidDailyDate(date: string): boolean {
  if (typeof date !== "string") return false;
  const match = DATE_PATTERN.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Round-trip through Date to catch impossible calendar dates like Feb 30.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return false;
  }
  return true;
}

/**
 * Add (or subtract, when n is negative) calendar days to a YYYY-MM-DD
 * string and return the resulting YYYY-MM-DD. Performs the math in UTC
 * to avoid any local-DST surprises.
 *
 * @param date - The starting date in YYYY-MM-DD
 * @param n - The number of days to add (may be negative)
 * @returns The resulting YYYY-MM-DD
 */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return getUtcDateString(d);
}

/**
 * Compute the milliseconds remaining until the next UTC midnight from
 * the given moment. If `now` is exactly at midnight UTC, returns a full
 * 24 hours (86,400,000 ms) — i.e. the *next* midnight, never zero.
 *
 * @param now - The reference time
 * @returns Milliseconds until the next UTC midnight (1..86,400,000)
 */
export function msUntilNextUtcMidnight(now: Date): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  const delta = next.getTime() - now.getTime();
  // Defensive clamp: if `now` is exactly midnight, the math above already
  // gives 86_400_000; if it's a hair past, we get something just under.
  return delta;
}

/**
 * Compute the user-visible "Daily #N" number from a date. Day 1 is the
 * launch epoch (DAILY_LAUNCH_EPOCH by default). Dates before the epoch
 * return zero or negative values, which callers can detect to render
 * a pre-launch state.
 *
 * @param date - The target daily date in YYYY-MM-DD
 * @param epochDate - Optional override for the epoch (defaults to DAILY_LAUNCH_EPOCH)
 * @returns The 1-indexed daily number; <= 0 for pre-epoch dates
 */
export function getDailyNumber(date: string, epochDate: string = DAILY_LAUNCH_EPOCH): number {
  const target = new Date(`${date}T00:00:00Z`).getTime();
  const epoch = new Date(`${epochDate}T00:00:00Z`).getTime();
  const days = Math.round((target - epoch) / MS_PER_DAY);
  return days + 1;
}

/**
 * Resolve the daily mode for a given date, honoring an admin-editable
 * weekly schedule and falling through DAILY_POOL when the scheduled mode
 * has been disabled in site settings. Returns null when every mode in
 * DAILY_POOL is disabled.
 *
 * Resolution rules:
 *   1. Look up the day's preferred mode from `schedule[utcDayOfWeek]`.
 *   2. If that mode is not in `disabledModes`, use it.
 *   3. Otherwise, walk DAILY_POOL in order and return the first mode
 *      that is not disabled.
 *   4. If all DAILY_POOL modes are disabled, return null.
 *
 * @param date - YYYY-MM-DD UTC date
 * @param schedule - 7-element schedule keyed by UTC day-of-week (0 = Sun)
 * @param disabledModes - Optional set of currently-disabled game modes
 * @returns The resolved mode, or null when no pool mode is available
 */
export function getDailyModeForDate(
  date: string,
  schedule: readonly GameMode[],
  disabledModes: ReadonlySet<GameMode> = new Set(),
): GameMode | null {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const preferred = schedule[day];
  if (preferred && !disabledModes.has(preferred)) return preferred;
  for (const mode of DAILY_POOL) {
    if (!disabledModes.has(mode)) return mode;
  }
  return null;
}
