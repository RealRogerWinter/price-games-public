/**
 * Admin-configurable settings for the ghost-user system.
 *
 * Persisted as a single JSON blob under the `ghost_users` key in
 * site_settings. Read paths fall back to {@link GHOST_SETTINGS_DEFAULTS}
 * on any malformed/missing value so the system can never crash because
 * someone hand-edited the row.
 *
 * Defaults are deliberately conservative:
 *   - `enabled` = false (master toggle; system inert until admin opts in)
 *   - `showOnLeaderboard` = false (PR-A invariant; PR-B flips this)
 *   - `killSwitch` = false (one-click emergency disable; takes precedence
 *     over `enabled`)
 *   - `percentileCap` = 70 (no ghost score exceeds the 70th percentile of
 *     real-player lifetime scores)
 *   - `targetCount` = 35 (mid-band of the 30-40 initial roster spec)
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { getSetting, setSetting } from "../siteSettings";
import { invalidateCapCache } from "./cap";

/** Admin-configurable knobs for the ghost-user system. */
export interface GhostSettings {
  /** Master kill switch. When false, scheduler does nothing, manager seats
   *  no ghosts, and the leaderboard UNION drops the ghost branch. */
  enabled: boolean;
  /** Emergency disable. When true, behaves like `enabled=false` and also
   *  triggers immediate eviction of any seated ghosts on the next manager
   *  tick. Distinct from `enabled` so the admin can flip this without
   *  losing their normal toggle state. */
  killSwitch: boolean;
  /** Whether ghosts appear on the public leaderboard (PR B controls this). */
  showOnLeaderboard: boolean;
  /** 0-100. No ghost's `lifetime_score` exceeds this percentile of real
   *  players' lifetime_score. The cap is recomputed periodically and
   *  applied at credit time. */
  percentileCap: number;
  /** Target ghost roster size — the admin panel uses this for the bulk-
   *  create form's default "fill to N" behavior. Doesn't auto-spawn on its
   *  own; admin must explicitly trigger create. */
  targetCount: number;
}

/** Defaults applied when the settings row is missing or partial. */
export const GHOST_SETTINGS_DEFAULTS: GhostSettings = {
  enabled: false,
  killSwitch: false,
  showOnLeaderboard: false,
  percentileCap: 70,
  targetCount: 35,
};

const STORAGE_KEY = "ghost_users";

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function normalize(input: Partial<GhostSettings>, base: GhostSettings): GhostSettings {
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    killSwitch: typeof input.killSwitch === "boolean" ? input.killSwitch : base.killSwitch,
    showOnLeaderboard:
      typeof input.showOnLeaderboard === "boolean"
        ? input.showOnLeaderboard
        : base.showOnLeaderboard,
    percentileCap: clamp(input.percentileCap ?? base.percentileCap, 0, 100, base.percentileCap),
    targetCount: clamp(input.targetCount ?? base.targetCount, 0, 500, base.targetCount),
  };
}

/**
 * Read the current ghost-user settings.
 *
 * Always returns a fully-populated object; malformed/missing storage
 * resolves to {@link GHOST_SETTINGS_DEFAULTS}.
 *
 * @param db - Database instance.
 */
export function getGhostSettings(db: DatabaseType): GhostSettings {
  const stored = getSetting<Partial<GhostSettings>>(db, STORAGE_KEY);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...GHOST_SETTINGS_DEFAULTS };
  }
  return normalize(stored, GHOST_SETTINGS_DEFAULTS);
}

/**
 * Update the ghost-user settings (partial-merge). Clamps + normalizes
 * before persistence.
 *
 * @param db - Database instance.
 * @param patch - Partial subset of settings to overwrite.
 * @returns The full, normalized, persisted settings object.
 */
export function setGhostSettings(
  db: DatabaseType,
  patch: Partial<GhostSettings>,
): GhostSettings {
  const current = getGhostSettings(db);
  const next = normalize({ ...current, ...patch }, current);
  setSetting(db, STORAGE_KEY, next);
  // Force the cap cache to recompute on the next read so a percentile
  // change takes effect immediately rather than waiting up to 6h for
  // the TTL. Idempotent / cheap; safe to call on every settings update.
  if (current.percentileCap !== next.percentileCap) {
    invalidateCapCache();
  }
  return next;
}

/**
 * Convenience: returns true when the ghost system should actively run.
 * Honors both `enabled` and `killSwitch` — the kill switch takes
 * precedence so a single admin click stops everything regardless of
 * whether `enabled` was toggled.
 *
 * @param db - Database instance.
 */
export function isGhostSystemEnabled(db: DatabaseType): boolean {
  const s = getGhostSettings(db);
  return s.enabled && !s.killSwitch;
}
