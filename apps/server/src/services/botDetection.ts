/**
 * Bot detection heuristics for the analytics ingest path.
 *
 * Two signals combine here:
 *  1. **UA regex** — catches the large majority of crawlers, scrapers, link
 *     unfurlers and LLM fetchers that identify themselves honestly. A bot
 *     flagged this way is effectively free — the regex runs in microseconds.
 *  2. **Velocity heuristic** — a visitor emitting more than
 *     {@link BOT_VELOCITY_THRESHOLD} events in a rolling window is flagged.
 *     This catches headless automation that spoofs a real browser UA.
 *
 * The detector is intentionally conservative: false positives merely exclude
 * a session from the default dashboards (rows are still retained). False
 * negatives bloat dashboards slightly — which is less bad than silently
 * dropping legitimate traffic.
 */

import { BOT_UA_REGEX } from "@price-game/shared";

/** Max events-per-minute from a single visitor before we flag as bot. */
export const BOT_VELOCITY_THRESHOLD = 60;

/** Rolling-window size for velocity heuristic. */
const VELOCITY_WINDOW_MS = 60 * 1000;

/**
 * Upper bound on the velocity map so a flood of distinct visitor_ids cannot
 * OOM the process between prune sweeps. 50k entries is ~several MB of RAM
 * and far exceeds realistic concurrent active visitors. On overflow we drop
 * the oldest insertion — a false-negative for that visitor's next event, but
 * the UA regex still catches honest bots.
 */
const VELOCITY_MAP_MAX = 50_000;

interface VisitorVelocity {
  timestamps: number[];
}

const velocityMap = new Map<string, VisitorVelocity>();

/**
 * Test-only: reset the in-memory velocity map.
 *
 * @internal
 */
export function __resetBotVelocity(): void {
  velocityMap.clear();
}

/**
 * Decide whether an event looks like it came from a bot.
 *
 * @param userAgent - Raw User-Agent string, or null/undefined.
 * @param visitorId - Visitor UUID, used to track event velocity per visitor.
 * @param now - Current epoch ms (exposed for test determinism).
 * @returns True if the event should be flagged as bot traffic.
 */
export function isBot(
  userAgent: string | null | undefined,
  visitorId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (userAgent && BOT_UA_REGEX.test(userAgent)) return true;
  if (!visitorId) return false;

  const rec = velocityMap.get(visitorId);
  const cutoff = now - VELOCITY_WINDOW_MS;

  if (!rec) {
    // Bound the map so a flood of distinct random visitor_ids cannot OOM
    // the process between prune sweeps.
    if (velocityMap.size >= VELOCITY_MAP_MAX) {
      const oldest = velocityMap.keys().next().value;
      if (oldest !== undefined) velocityMap.delete(oldest);
    }
    velocityMap.set(visitorId, { timestamps: [now] });
    return false;
  }

  // Drop timestamps older than the window — in-place to keep the common case cheap.
  while (rec.timestamps.length && rec.timestamps[0] < cutoff) {
    rec.timestamps.shift();
  }
  rec.timestamps.push(now);
  return rec.timestamps.length > BOT_VELOCITY_THRESHOLD;
}

/**
 * Periodic cleanup of the velocity map so visitors that fall silent don't
 * hold memory indefinitely. Called from the session closeout cron.
 *
 * @param now - Current epoch ms.
 */
export function pruneBotVelocity(now: number = Date.now()): void {
  const cutoff = now - VELOCITY_WINDOW_MS;
  for (const [vid, rec] of velocityMap.entries()) {
    while (rec.timestamps.length && rec.timestamps[0] < cutoff) {
      rec.timestamps.shift();
    }
    if (rec.timestamps.length === 0) velocityMap.delete(vid);
  }
}
