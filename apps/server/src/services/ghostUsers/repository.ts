/**
 * CRUD primitives for `ghost_users`.
 *
 * These are the only places that mutate the table. Every mutation invalidates
 * the {@link reservedNames} cache so the new/deleted name takes effect for
 * collision checks immediately rather than waiting for the 60s TTL.
 *
 * Higher-level features (the shift scheduler, score-credit, admin REST
 * routes) call into these primitives — none of them touch ghost_users
 * directly.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { DbGhostUser } from "../dbTypes";
import { generateGhostPersona, generateGhostPersonas, type GhostPersona } from "./persona";
import { invalidateReservedNamesCache } from "./reservedNames";

/** Hard cap on bulk-create per call. Defends the admin route against an
 *  accidental "create 99999 ghosts" click that would lock the DB during
 *  insert. Tunable; matches the GhostSettings.targetCount upper bound. */
const BULK_CREATE_MAX = 500;

/** Bounds for the per-ghost daily-play probability draw. The lower bound
 *  is non-trivial (0.30) so even "lapsed" ghosts still occasionally play,
 *  preventing a slug of permanently-zero-streak rows. The upper bound is
 *  capped below 1 so nobody is a guaranteed-every-day player (real users
 *  miss days, ghosts should too). */
const DAILY_PROB_MIN = 0.30;
const DAILY_PROB_MAX = 0.95;

function drawDailyPlayProbability(random: () => number): number {
  return DAILY_PROB_MIN + random() * (DAILY_PROB_MAX - DAILY_PROB_MIN);
}

function insertPersona(
  db: DatabaseType,
  persona: GhostPersona,
  random: () => number = Math.random,
): DbGhostUser {
  const id = uuidv4();
  const now = new Date().toISOString();
  const dailyPlayProbability = drawDailyPlayProbability(random);
  db.prepare(
    `INSERT INTO ghost_users
       (id, username, username_normalized, avatar, lifetime_score,
        account_created_at, on_shift, is_active,
        daily_play_probability, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, 1, ?, ?, ?)`,
  ).run(
    id,
    persona.username,
    persona.username.toLowerCase(),
    persona.avatar,
    persona.accountCreatedAt,
    dailyPlayProbability,
    now,
    now,
  );
  return getGhostById(db, id)!;
}

/**
 * Create a single ghost. Returns null if persona generation fails to find
 * a unique name (effectively impossible given the pool size but the
 * function stays total).
 */
export function createGhost(db: DatabaseType): DbGhostUser | null {
  const persona = generateGhostPersona(db);
  if (!persona) return null;
  const ghost = insertPersona(db, persona);
  invalidateReservedNamesCache();
  return ghost;
}

/**
 * Bulk-create N ghosts in a single transaction. Clamps `count` to
 * [0, {@link BULK_CREATE_MAX}].
 *
 * @param db - Database instance.
 * @param count - Requested ghost count.
 */
export function bulkCreateGhosts(db: DatabaseType, count: number): DbGhostUser[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const n = Math.min(count, BULK_CREATE_MAX);
  const personas = generateGhostPersonas(db, n);

  const created: DbGhostUser[] = [];
  const tx = db.transaction(() => {
    for (const p of personas) {
      created.push(insertPersona(db, p));
    }
  });
  tx();
  invalidateReservedNamesCache();
  return created;
}

/** Look up a ghost by primary key. */
export function getGhostById(db: DatabaseType, id: string): DbGhostUser | null {
  const row = db
    .prepare("SELECT * FROM ghost_users WHERE id = ?")
    .get(id) as DbGhostUser | undefined;
  return row ?? null;
}

/**
 * Look up a ghost by display username (case-insensitive). Used by the
 * public-profile route to resolve `/api/player/:username` to a ghost row
 * when no real-user match exists.
 */
export function getGhostByUsername(db: DatabaseType, username: string): DbGhostUser | null {
  const row = db
    .prepare("SELECT * FROM ghost_users WHERE username_normalized = ?")
    .get(username.trim().toLowerCase()) as DbGhostUser | undefined;
  return row ?? null;
}

/** Pagination + filter options for {@link listGhosts}. */
export interface ListGhostsOpts {
  limit?: number;
  offset?: number;
  /** When set, restricts to active=1 or active=0 ghosts. */
  activeOnly?: boolean;
}

/**
 * Paginated list of ghosts ordered newest-first. Used by the admin roster
 * page.
 */
export function listGhosts(db: DatabaseType, opts: ListGhostsOpts = {}): DbGhostUser[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const where = opts.activeOnly ? "WHERE is_active = 1" : "";
  return db
    .prepare(
      `SELECT * FROM ghost_users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as DbGhostUser[];
}

/** Toggle the `is_active` flag. */
export function setGhostActive(db: DatabaseType, id: string, active: boolean): void {
  db.prepare(
    "UPDATE ghost_users SET is_active = ?, updated_at = ? WHERE id = ?",
  ).run(active ? 1 : 0, new Date().toISOString(), id);
}

/**
 * Hard-delete a ghost. Cascades through `ghost_game_history` via the FK
 * declaration; any `mp_players` / `mp_leaderboard` rows still pointing at
 * the deleted id get nulled out (no FK cascade because those tables hold
 * historical data we want to keep, not discard).
 */
export function deleteGhost(db: DatabaseType, id: string): void {
  db.transaction(() => {
    db.prepare("UPDATE mp_players SET ghost_user_id = NULL WHERE ghost_user_id = ?").run(id);
    db.prepare("UPDATE mp_leaderboard SET ghost_user_id = NULL WHERE ghost_user_id = ?").run(id);
    db.prepare("DELETE FROM ghost_users WHERE id = ?").run(id);
  })();
  invalidateReservedNamesCache();
}

/** Shift-state mutation payload. */
export interface ShiftStatePatch {
  onShift?: boolean;
  startedAt?: string | null;
  endsAt?: string | null;
  breakUntil?: string | null;
}

/**
 * Update shift columns for one ghost. Each field is optional; the helper
 * merges with the existing row.
 */
export function setShiftState(db: DatabaseType, id: string, patch: ShiftStatePatch): void {
  const fields: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.onShift !== undefined) {
    fields.push("on_shift = ?");
    params.push(patch.onShift ? 1 : 0);
  }
  if (patch.startedAt !== undefined) {
    fields.push("shift_started_at = ?");
    params.push(patch.startedAt);
  }
  if (patch.endsAt !== undefined) {
    fields.push("shift_ends_at = ?");
    params.push(patch.endsAt);
  }
  if (patch.breakUntil !== undefined) {
    fields.push("on_break_until = ?");
    params.push(patch.breakUntil);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  db.prepare(`UPDATE ghost_users SET ${fields.join(", ")} WHERE id = ?`).run(...params);
}

/**
 * Force every on-shift ghost off shift. Used by the admin kill-switch
 * path so a single click stops the entire population.
 *
 * @returns Number of ghosts evicted.
 */
export function endAllShifts(db: DatabaseType): number {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      "UPDATE ghost_users SET on_shift = 0, shift_started_at = NULL, shift_ends_at = NULL, updated_at = ? WHERE on_shift = 1",
    )
    .run(now);
  return res.changes;
}
