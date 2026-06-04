/**
 * Auto-lobby pre-game countdown — the timer that fires when the first real
 * human walks into an auto-lobby. The DB carries `countdown_started_at` +
 * `countdown_target_at` so the server can survive a restart without losing
 * the timer state, and so the wire payload can derive a clean "seconds
 * remaining" value for the client banner.
 *
 * The countdown is a *signal*, not a self-firing timer — we don't keep an
 * in-process setTimeout alive. The integration layer (a future scheduler
 * tick or socket handler) checks `target_at` against `Date.now()` and
 * triggers the real `startRound()` when the moment arrives. That keeps the
 * countdown durable and easy to reason about without coordinating multiple
 * timer subsystems.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Inclusive seconds bounds for {@link pickCountdownSeconds}. */
export interface CountdownBounds {
  min: number;
  max: number;
}

/**
 * Pick a random integer countdown duration in `[min, max]` seconds.
 *
 * Inverted bounds (`min > max`) are tolerated and swapped — admin UI may
 * submit them transiently while the user is editing.
 */
export function pickCountdownSeconds(b: CountdownBounds): number {
  const lo = Math.max(1, Math.min(b.min, b.max));
  const hi = Math.max(1, Math.max(b.min, b.max));
  if (lo === hi) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Read-side view of a room's countdown columns. */
export interface CountdownState {
  startedAt: string | null;
  targetAt: string | null;
}

/**
 * Read the current countdown state for a room. Missing rooms and rooms
 * with no countdown both return `{ startedAt: null, targetAt: null }`.
 */
export function getCountdownState(db: DatabaseType, code: string): CountdownState {
  const row = db
    .prepare(
      "SELECT countdown_started_at AS startedAt, countdown_target_at AS targetAt FROM mp_rooms WHERE code = ?",
    )
    .get(code) as { startedAt: string | null; targetAt: string | null } | undefined;
  if (!row) return { startedAt: null, targetAt: null };
  return { startedAt: row.startedAt ?? null, targetAt: row.targetAt ?? null };
}

/**
 * Start (or reset) the pre-game countdown on an auto-lobby.
 *
 * Refuses to act on:
 *  - rooms that don't exist
 *  - non-auto-lobby rooms (we never want this timer running on a real
 *    user-created lobby; their flow is host-driven)
 *  - rooms past `lobby` status (game already started — too late)
 *
 * Returns the chosen `targetAt` ISO string on success, `null` otherwise.
 *
 * @param db - Database instance.
 * @param code - The room code.
 * @param bounds - Min/max countdown seconds (admin-configurable).
 */
export function startCountdown(
  db: DatabaseType,
  code: string,
  bounds: CountdownBounds,
): string | null {
  const room = db
    .prepare(
      "SELECT is_auto_lobby, status FROM mp_rooms WHERE code = ?",
    )
    .get(code) as { is_auto_lobby: number; status: string } | undefined;
  if (!room) return null;
  if (room.is_auto_lobby !== 1) return null;
  if (room.status !== "lobby") return null;

  const seconds = pickCountdownSeconds(bounds);
  const startedAt = new Date().toISOString();
  const targetAt = new Date(Date.now() + seconds * 1000).toISOString();
  db.prepare(
    "UPDATE mp_rooms SET countdown_started_at = ?, countdown_target_at = ?, last_activity_at = ? WHERE code = ?",
  ).run(startedAt, targetAt, startedAt, code);
  return targetAt;
}

/**
 * Cancel any active countdown on the given room.
 *
 * Idempotent — safe to call when no countdown exists, or when the room
 * itself doesn't exist.
 */
export function cancelCountdown(db: DatabaseType, code: string): void {
  db.prepare(
    "UPDATE mp_rooms SET countdown_started_at = NULL, countdown_target_at = NULL WHERE code = ?",
  ).run(code);
}

/**
 * Return the room codes whose countdown has elapsed (`target_at <= now`)
 * but haven't started a round yet (status still 'lobby'). The integration
 * scheduler iterates this list each tick and fires `startRound()` for each.
 *
 * Excludes rooms with zero connected humans — if the joining player left
 * before the timer elapsed, we don't want bots to "play" against an empty
 * room. The countdown columns stay populated so the next human to join
 * doesn't have to start the timer from scratch; the spawn manager / stale-
 * room cleanup will eventually reap the room if no one comes back.
 */
export function findElapsedCountdowns(db: DatabaseType, now = new Date()): string[] {
  const iso = now.toISOString();
  // Both flows reuse the countdown_target_at column:
  //   - auto-lobbies: countdown set when first human joins (15-45s)
  //   - host-initiated: countdown set when host clicks Start (10s)
  // The `status = 'lobby'` predicate is the authoritative gate; the
  // earlier `is_auto_lobby = 1` filter has been dropped so host-
  // initiated countdowns also fire startRound here.
  const rows = db
    .prepare(
      `SELECT r.code FROM mp_rooms r
        WHERE r.status = 'lobby'
          AND r.countdown_target_at IS NOT NULL
          AND r.countdown_target_at <= ?
          AND (SELECT COUNT(*) FROM mp_players WHERE room_code = r.code
                AND is_kicked = 0 AND is_bot = 0 AND connected = 1) > 0`,
    )
    .all(iso) as { code: string }[];
  return rows.map((r) => r.code);
}
