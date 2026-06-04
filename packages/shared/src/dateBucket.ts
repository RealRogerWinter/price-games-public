/**
 * Timezone-aware date bucketing helpers shared between the server and web.
 *
 * Every chart and analytics aggregator in the codebase needs to group
 * timestamps into calendar days, and every one of them must agree on which
 * timezone "calendar day" means. This module is the single source of truth.
 *
 * Rules of thumb for picking a timezone:
 *   - Admin dashboards and drill-downs → `ADMIN_TIMEZONE`
 *   - Per-user charts (scoreboard, public profile, account settings) →
 *     the viewer's browser IANA timezone
 *     (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
 *
 * The helpers live here so both server (Node 20) and web (Vite + React) can
 * import them via `@price-game/shared`.
 */

/**
 * The timezone the admin operator works in. All admin-facing charts and
 * drill-down queries bucket by this timezone so the operator sees their
 * local calendar days regardless of where the Node process happens to run.
 */
export const ADMIN_TIMEZONE = "America/Los_Angeles";

/**
 * Cache of `Intl.DateTimeFormat` instances keyed by timezone. Constructing
 * a new formatter on every row is measurably slow on large windows.
 *
 * Memory is bounded in practice to the full IANA tzdata set (~420 entries)
 * because every caller-provided string must first pass a
 * `new Intl.DateTimeFormat(..., { timeZone })` validation at the route
 * layer — invalid identifiers are rejected before ever reaching this
 * cache, so an attacker cannot grow it with junk strings.
 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    // en-CA emits YYYY-MM-DD natively, so we don't need to reorder parts.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Convert an ISO-8601 UTC timestamp to a YYYY-MM-DD date string in the
 * given IANA timezone. Handles DST automatically because the underlying
 * `Intl.DateTimeFormat` consults the tzdata for the requested zone.
 *
 * An explicit null/undefined/invalid guard returns an empty string — `new
 * Date(null)` coerces to 1970-01-01 and would silently bucket rows into
 * the epoch otherwise.
 *
 * @param iso - ISO 8601 timestamp string, or null/undefined.
 * @param timeZone - IANA timezone identifier (e.g. "America/Los_Angeles").
 * @returns YYYY-MM-DD string in the given timezone, or "" for invalid input.
 */
export function tzDateString(
  iso: string | null | undefined,
  timeZone: string,
): string {
  if (iso == null || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return getFormatter(timeZone).format(d);
}

/**
 * Parse and validate an incoming `?tz=` query-string value. Returns the
 * validated IANA identifier if `Intl.DateTimeFormat` accepts it,
 * otherwise falls back to `ADMIN_TIMEZONE`. All four analytics route
 * files import this instead of re-declaring the same validation
 * locally — there's exactly one place to tighten validation if needed.
 *
 * @param raw - Query param value (unknown because Express types them as such).
 * @returns A validated IANA timezone string.
 */
export function parseTimeZoneQuery(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return ADMIN_TIMEZONE;
  try {
    // Constructing a formatter with an invalid tz throws RangeError —
    // we don't keep this instance, so it's zero-cost in the happy path
    // because the helper just needs to confirm acceptance.
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    return ADMIN_TIMEZONE;
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Return every YYYY-MM-DD bucket (inclusive) between two instants in the
 * given timezone. DST transitions are handled correctly: the spring-forward
 * and fall-back days still count as exactly one bucket each, because we
 * advance in UTC but compare formatted strings in the target zone.
 *
 * The algorithm walks 12-hour increments and deduplicates. Twelve hours is
 * small enough to safely cross any IANA offset transition (the largest
 * historical transition is Samoa's 24-hour skip, and even that only
 * produces a gap — never a 25-hour offset). A 1-hour step would be
 * unnecessarily chatty; a 24-hour step would skip the DST day when the
 * clocks jump.
 *
 * @param start - First instant (inclusive).
 * @param end - Last instant (inclusive).
 * @param timeZone - IANA timezone identifier.
 * @returns Ordered array of YYYY-MM-DD strings with no duplicates.
 */
export function enumerateDaysInRange(
  start: Date,
  end: Date,
  timeZone: string,
): string[] {
  if (end.getTime() < start.getTime()) return [];
  const result: string[] = [];
  let last = "";
  // Walk from a bit before the start instant to a bit after the end instant,
  // pushing each new formatted day string. The half-day step is safely under
  // any DST offset change.
  const step = MS_PER_DAY / 2;
  let t = start.getTime();
  const endT = end.getTime();
  while (t <= endT) {
    const bucket = tzDateString(new Date(t).toISOString(), timeZone);
    if (bucket && bucket !== last) {
      result.push(bucket);
      last = bucket;
    }
    t += step;
  }
  // Ensure the end instant is included even if the step walked past it.
  const endBucket = tzDateString(end.toISOString(), timeZone);
  if (endBucket && endBucket !== result[result.length - 1]) {
    result.push(endBucket);
  }
  // Result may contain duplicates when the half-day step lands twice in the
  // same bucket, or be out-of-order around DST edges — sort + dedupe.
  result.sort();
  const deduped: string[] = [];
  for (const d of result) {
    if (deduped[deduped.length - 1] !== d) deduped.push(d);
  }
  return deduped;
}

/**
 * Subtract N calendar days from a YYYY-MM-DD string using pure UTC
 * arithmetic. Returns a YYYY-MM-DD string N days earlier on the
 * proleptic Gregorian calendar, independent of any timezone. DST
 * transitions cannot affect this because it operates on calendar
 * fields via `Date.UTC` / `setUTCDate`, never on elapsed milliseconds.
 */
function subtractDaysFromDateString(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return "";
  const [, y, m, d] = match;
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  utc.setUTCDate(utc.getUTCDate() - days);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Zero-fill a sparse time series so it has **exactly** `days` entries
 * ending on `end`'s calendar day in the given timezone. Rows whose date
 * falls outside the resulting window are dropped; rows inside are
 * preserved as-is.
 *
 * The window is computed via calendar-day arithmetic — not raw
 * millisecond subtraction — so the length invariant holds across DST
 * transitions. Raw `MS_PER_DAY * (n-1)` subtraction drifts by ±1 hour
 * around spring-forward / fall-back, which can shift the start bucket
 * by one calendar day and produce `days+1` or `days-1` rows. Downstream
 * `computeDelta`-style comparisons assume `length === days`, so this
 * invariant is load-bearing.
 *
 * @param rows - Sparse rows that carry a YYYY-MM-DD `date` field.
 * @param end - Final instant of the window; its calendar day in `timeZone` becomes the last bucket.
 * @param days - Number of calendar days the window should cover (clamped to ≥1).
 * @param timeZone - IANA timezone for calendar-day resolution.
 * @param factory - Produces a zero-valued row for a missing day.
 * @returns Contiguous array with exactly `max(1, days)` entries, sorted ascending.
 */
export function padDateSeries<T extends { date: string }>(
  rows: readonly T[],
  end: Date,
  days: number,
  timeZone: string,
  factory: (date: string) => T,
): T[] {
  const n = Math.max(1, Math.floor(days));
  const endDay = tzDateString(end.toISOString(), timeZone);
  if (!endDay) return [];
  // Walk backwards from the end day via pure calendar arithmetic so DST
  // transitions cannot change the bucket count.
  const bucketDays: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    bucketDays[n - 1 - i] = i === 0 ? endDay : subtractDaysFromDateString(endDay, i);
  }
  const byDate = new Map<string, T>();
  for (const row of rows) {
    byDate.set(row.date, row);
  }
  return bucketDays.map((d) => byDate.get(d) ?? factory(d));
}
