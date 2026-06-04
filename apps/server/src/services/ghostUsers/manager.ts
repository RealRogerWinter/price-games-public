/**
 * Ghost-user manager — the single tick called by `index.ts` setInterval.
 *
 * Three jobs in order:
 *   1. Honor the kill switch: any on-shift ghost gets evicted now.
 *   2. End shifts whose `shift_ends_at` has passed; on a 10% roll the
 *      ghost goes on a long break before the next shift would otherwise
 *      schedule.
 *   3. Start new shifts for ghosts whose seeded next-shift time has
 *      arrived (relies on shifts.ts diurnal weighting).
 *
 * The cycling-out lifecycle and synthetic streak advancement run on a
 * slower cadence — they're not in the per-tick hot path. The integration
 * caller (index.ts) decides how often to call them; this module just
 * exposes the entry points.
 *
 * Pure DB state machine — no socket events, no broadcast. Auto-lobby
 * seating is handled by the auto-lobby manager via `pickSeatableGhosts`,
 * which queries this module's resulting state.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { DbGhostUser } from "../dbTypes";
import { getGhostSettings, isGhostSystemEnabled } from "./settings";
import {
  endAllShifts,
  setShiftState,
} from "./repository";
import {
  sampleShiftDurationMs,
  shouldTakeBreak,
  sampleBreakDurationMs,
  hourWeightForLocalHour,
} from "./shifts";

/** Per-tick cap on shift starts. With 60s cadence, 3 starts/tick × 60
 *  ticks/hr = 180/hr — comfortably above the steady-state requirement of
 *  ~targetCount × (60/avgShiftMinutes) ≈ 84/hr at targetCount=35. The
 *  hour-weight roll inside the loop gates effective rate to peak hours. */
const MAX_STARTS_PER_TICK = 3;

/** Per-tick outcome counts for telemetry / tests. */
export interface TickResult {
  shiftsStarted: number;
  shiftsEnded: number;
  killSwitchEvictions: number;
}

const DEFAULT_TIMEZONE = "America/Los_Angeles";

/**
 * Run a single manager tick. Cheap (one indexed scan + a few targeted
 * UPDATEs) so it's safe to fire on a 60s cadence.
 *
 * @param db - Database instance.
 * @param now - Current epoch ms (defaults to Date.now()). Tests inject for
 *   deterministic state-machine assertions.
 */
export function runGhostUsersTick(db: DatabaseType, now: number = Date.now()): TickResult {
  const settings = getGhostSettings(db);
  if (settings.killSwitch) {
    return { shiftsStarted: 0, shiftsEnded: 0, killSwitchEvictions: endAllShifts(db) };
  }
  if (!isGhostSystemEnabled(db)) {
    return { shiftsStarted: 0, shiftsEnded: 0, killSwitchEvictions: 0 };
  }

  const nowIso = new Date(now).toISOString();
  let shiftsStarted = 0;
  let shiftsEnded = 0;

  // Step 1: end shifts whose end time has passed.
  const endingNow = db
    .prepare(
      `SELECT id FROM ghost_users
        WHERE is_active = 1 AND on_shift = 1 AND shift_ends_at IS NOT NULL AND shift_ends_at <= ?`,
    )
    .all(nowIso) as { id: string }[];

  for (const { id } of endingNow) {
    if (shouldTakeBreak()) {
      const breakUntil = new Date(now + sampleBreakDurationMs()).toISOString();
      setShiftState(db, id, {
        onShift: false,
        startedAt: null,
        endsAt: null,
        breakUntil,
      });
    } else {
      setShiftState(db, id, {
        onShift: false,
        startedAt: null,
        endsAt: null,
      });
    }
    shiftsEnded++;
  }

  // Step 2: clear expired breaks so those ghosts become eligible again
  // on the next tick.
  db.prepare(
    `UPDATE ghost_users SET on_break_until = NULL, updated_at = ?
      WHERE on_break_until IS NOT NULL AND on_break_until <= ?`,
  ).run(nowIso, nowIso);

  // Step 3: start new shifts. Up to MAX_STARTS_PER_TICK candidates per
  // 60s tick, gated by the current-hour weight from the diurnal
  // distribution so peak hours saturate the roster but troughs don't.
  // With targetCount=35 and median shift duration ~25min, steady state
  // needs ~84 starts/hr; peak weight (1.0) × 3 starts/tick × 60 ticks/hr
  // = 180/hr cap — enough headroom even with the diurnal bias. Off-peak
  // weights (0.05–0.10) drop the effective rate to a trickle, which is
  // the desired diurnal shape.
  const currentLocalHour = localHourFor(now);
  const hourWeight = hourWeightForLocalHour(currentLocalHour);

  const candidates = db
    .prepare(
      `SELECT id FROM ghost_users
        WHERE is_active = 1
          AND on_shift = 0
          AND (on_break_until IS NULL OR on_break_until <= ?)
        ORDER BY RANDOM()
        LIMIT ?`,
    )
    .all(nowIso, MAX_STARTS_PER_TICK) as { id: string }[];

  for (const candidate of candidates) {
    if (Math.random() < hourWeight) {
      const duration = sampleShiftDurationMs();
      const endsAt = new Date(now + duration).toISOString();
      setShiftState(db, candidate.id, {
        onShift: true,
        startedAt: nowIso,
        endsAt,
      });
      shiftsStarted++;
    }
  }

  return { shiftsStarted, shiftsEnded, killSwitchEvictions: 0 };
}

/** Helper: convert epoch ms to a local hour-of-day for DEFAULT_TIMEZONE. */
function localHourFor(epochMs: number): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    const h = parts.find((p) => p.type === "hour");
    if (!h) return new Date(epochMs).getUTCHours();
    const n = parseInt(h.value, 10);
    return Number.isNaN(n) ? new Date(epochMs).getUTCHours() : n % 24;
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}

/**
 * Find ghosts eligible to be seated in a NEW auto-lobby right now.
 *
 * Filters:
 *   - is_active = 1 AND on_shift = 1
 *   - Not already seated in any non-kicked mp_players row
 *
 * Used by the auto-lobby manager when it spawns a fresh room.
 *
 * @param db - Database instance.
 * @param limit - Max ghosts to return.
 */
export function pickSeatableGhosts(db: DatabaseType, limit: number): DbGhostUser[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  return db
    .prepare(
      `SELECT * FROM ghost_users
        WHERE is_active = 1
          AND on_shift = 1
          AND id NOT IN (
            SELECT ghost_user_id FROM mp_players
             WHERE ghost_user_id IS NOT NULL AND is_kicked = 0
          )
        ORDER BY RANDOM()
        LIMIT ?`,
    )
    .all(max) as DbGhostUser[];
}
