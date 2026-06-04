/**
 * Telemetry emitter — single JSON-line per event to stdout. Docker's
 * default log driver captures stdout, so this gives us a structured
 * post-incident trail without requiring a centralised log aggregator.
 *
 * Format:
 *   { "ts": 1714867200123, "evt": "round.complete", ...event-specific fields }
 *
 * Consumers can tail via `docker logs streamer | jq 'select(.evt)'`.
 */

export interface TelemetryRecord {
  evt: string;
  /** ms since epoch — added by the emitter, callers don't need to set it. */
  ts?: number;
  /** Anything else. */
  [k: string]: unknown;
}

export interface Telemetry {
  log(record: TelemetryRecord): void;
}

/**
 * Build a stdout-writing telemetry emitter. Tests inject a recording
 * sink via `createMemoryTelemetry()`.
 *
 * @param sink Optional override for output. Defaults to
 *             `console.log`.
 * @param now Optional clock injection. Defaults to `Date.now`.
 */
export function createTelemetry(
  sink: (line: string) => void = (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  },
  now: () => number = () => Date.now(),
): Telemetry {
  return {
    log(record: TelemetryRecord): void {
      try {
        const enriched = { ts: now(), ...record };
        sink(JSON.stringify(enriched));
      } catch {
        // Stringify can throw on circular references — never let
        // telemetry break the runner.
      }
    },
  };
}

/** In-memory recorder for tests. */
export interface MemoryTelemetry extends Telemetry {
  records: TelemetryRecord[];
}

export function createMemoryTelemetry(
  now: () => number = () => Date.now(),
): MemoryTelemetry {
  const records: TelemetryRecord[] = [];
  const sink = (line: string) => {
    try {
      records.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  };
  const t = createTelemetry(sink, now);
  return { ...t, records };
}
