/**
 * Ghost persona generator — produces a synthetic identity (username +
 * avatar + synthetic account-creation timestamp) ready to insert into
 * `ghost_users`.
 *
 * Rules:
 *  - Username uses the existing human-handle pool from PR #194's
 *    {@link generateHumanStyleName} so disguised auto-lobby seats and
 *    persistent ghosts share the same naming style (consistency
 *    eliminates a pattern-match tell across the cohort).
 *  - Username never collides with an existing `users.username_normalized`
 *    or `ghost_users.username_normalized` row.
 *  - Avatar drawn uniformly from {@link RANDOMIZABLE_AVATARS}.
 *  - `account_created_at` drawn from a log-normal distribution biased
 *    toward "joined recently" with a long tail to ~18 months. This keeps
 *    the cohort from looking planted (a uniform "joined yesterday"
 *    cluster is statistically detectable).
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { RANDOMIZABLE_AVATARS, type Avatar } from "@price-game/shared";
import { generateHumanStyleName } from "../autoLobby/nameGenerator";

/** Lower bound (days ago) for synthetic account_created_at. */
export const GHOST_AGE_MIN_DAYS = 1;
/** Upper bound (days ago) — ~18 months. */
export const GHOST_AGE_MAX_DAYS = 540;

/** Standard deviation for the log-normal age sample. Bias toward recent. */
const AGE_LOG_SIGMA = 1.1;
/** Median age (days) — mid-band of "joined a couple weeks ago". */
const AGE_MEDIAN_DAYS = 21;

/** Resolved persona ready to write into ghost_users. */
export interface GhostPersona {
  username: string;
  avatar: Avatar;
  /** ISO timestamp. */
  accountCreatedAt: string;
}

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleAccountAgeDays(): number {
  // Log-normal: exp(ln(median) + sigma·N(0,1)) — heavy right tail.
  const days = Math.exp(Math.log(AGE_MEDIAN_DAYS) + AGE_LOG_SIGMA * gauss());
  return Math.max(GHOST_AGE_MIN_DAYS, Math.min(GHOST_AGE_MAX_DAYS, days));
}

function pickAvatar(): Avatar {
  const idx = Math.floor(Math.random() * RANDOMIZABLE_AVATARS.length);
  return RANDOMIZABLE_AVATARS[idx] as Avatar;
}

/**
 * Read every reserved name (lowercased) so the bulk generator can dedupe
 * against the real-user table AND the existing ghost roster in one pass.
 */
function loadReservedNames(db: DatabaseType): Set<string> {
  const userRows = db
    .prepare("SELECT username_normalized FROM users")
    .all() as { username_normalized: string }[];
  const ghostRows = db
    .prepare("SELECT username_normalized FROM ghost_users")
    .all() as { username_normalized: string }[];
  const set = new Set<string>();
  for (const r of userRows) set.add(r.username_normalized);
  for (const r of ghostRows) set.add(r.username_normalized);
  return set;
}

/**
 * Generate a single persona. Collision-checked against current
 * `users.username_normalized` AND `ghost_users.username_normalized`.
 *
 * @param db - Database instance.
 * @returns A persona, or `null` if no unique name could be found in 250
 *   attempts (effectively never given the pool size).
 */
export function generateGhostPersona(db: DatabaseType): GhostPersona | null {
  const reserved = loadReservedNames(db);
  const username = generateHumanStyleName(
    new Set(Array.from(reserved).map((s) => s.toLowerCase())),
  );
  // Defensive: generateHumanStyleName falls back to `anonN` numbered names
  // if the pool is exhausted; if the result still collides (extremely
  // unlikely), bail rather than insert a dup.
  if (reserved.has(username.toLowerCase())) return null;

  const days = sampleAccountAgeDays();
  const accountCreatedAt = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return {
    username,
    avatar: pickAvatar(),
    accountCreatedAt,
  };
}

/**
 * Bulk variant — generates `count` distinct personas in one pass.
 *
 * Maintains its own in-memory dedupe set (seeded with current real-user
 * + ghost names) so two ghosts created in the same call cannot collide
 * with each other.
 */
export function generateGhostPersonas(db: DatabaseType, count: number): GhostPersona[] {
  const reserved = loadReservedNames(db);
  // Lowercased view passed to the generator so the dedupe is
  // case-insensitive by construction.
  const lower = new Set<string>(Array.from(reserved).map((s) => s.toLowerCase()));
  const out: GhostPersona[] = [];

  for (let i = 0; i < count; i++) {
    const username = generateHumanStyleName(lower);
    if (lower.has(username.toLowerCase())) {
      // Pool exhausted (effectively impossible given pool size). Stop
      // rather than insert a dup.
      break;
    }
    lower.add(username.toLowerCase());

    const days = sampleAccountAgeDays();
    out.push({
      username,
      avatar: pickAvatar(),
      accountCreatedAt: new Date(Date.now() - days * 24 * 3600 * 1000).toISOString(),
    });
  }

  return out;
}
