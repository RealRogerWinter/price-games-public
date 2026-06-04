/**
 * Admin-configurable settings for the auto-lobby system.
 *
 * Persisted as a single JSON blob under the `auto_lobbies` key in
 * site_settings. Read paths fall back to {@link AUTO_LOBBY_DEFAULTS} on any
 * malformed/missing value so the system can never crash because someone
 * hand-edited the row.
 *
 * Default `enabled = false` — the feature ships dark; an admin must
 * explicitly turn it on after verifying behavior in production.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { VALID_GAME_MODES } from "@price-game/shared";
import { getSetting, setSetting } from "../siteSettings";

/** All admin-configurable knobs for the auto-lobby system. */
export interface AutoLobbySettings {
  /** Master kill switch. When false, the manager spawns nothing and tears
   *  down idle auto-lobbies within ~10s. */
  enabled: boolean;
  /** Upper bound for visible (status='lobby', joinable) public lobbies the
   *  manager will spawn up to — counting both real + auto-spawned rooms. */
  targetCount: number;
  /** Lower bound for the same band. Each tick samples an effective target
   *  uniformly from [targetMin, targetCount] so the visible count breathes
   *  rather than pinning at the upper bound. New rows default to 3
   *  (see {@link AUTO_LOBBY_DEFAULTS}); legacy rows that pre-date this
   *  field migrate to floor(targetCount / 2) on first normalize. */
  targetMin: number;
  /** Inclusive lower bound for per-lobby disguise ratio (% of bots presented
   *  to the client as humans). Each spawn picks uniformly in [min, max]. */
  disguiseRatioMin: number;
  /** Inclusive upper bound for per-lobby disguise ratio. */
  disguiseRatioMax: number;
  /** Inclusive lower bound (seconds) for the pre-game countdown that starts
   *  when the first real human joins an auto-lobby. */
  countdownMinSeconds: number;
  /** Inclusive upper bound (seconds) for the pre-game countdown. */
  countdownMaxSeconds: number;
  /** Game modes eligible for auto-spawn. Empty array = all enabled modes. */
  modeAllowlist: string[];
}

/** Defaults — applied when the settings row is missing or partially populated. */
export const AUTO_LOBBY_DEFAULTS: AutoLobbySettings = {
  enabled: false,
  targetCount: 6,
  targetMin: 3,
  disguiseRatioMin: 50,
  disguiseRatioMax: 70,
  countdownMinSeconds: 15,
  countdownMaxSeconds: 45,
  modeAllowlist: [],
};

const STORAGE_KEY = "auto_lobbies";

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function normalize(input: Partial<AutoLobbySettings>, base: AutoLobbySettings): AutoLobbySettings {
  const enabled = typeof input.enabled === "boolean" ? input.enabled : base.enabled;
  const targetCount = clamp(input.targetCount ?? base.targetCount, 0, 20, base.targetCount);
  // targetMin defaults to half of targetCount on first write, allowing
  // existing rows that pre-date this field to migrate cleanly.
  let targetMin = clamp(
    input.targetMin ?? base.targetMin ?? Math.floor(targetCount / 2),
    0,
    20,
    Math.floor(targetCount / 2),
  );
  if (targetMin > targetCount) targetMin = targetCount;
  let dMin = clamp(input.disguiseRatioMin ?? base.disguiseRatioMin, 0, 100, base.disguiseRatioMin);
  let dMax = clamp(input.disguiseRatioMax ?? base.disguiseRatioMax, 0, 100, base.disguiseRatioMax);
  // Swap if inverted — admin UI may submit min > max during typing; tolerate
  // it here so we never persist an unusable range.
  if (dMin > dMax) [dMin, dMax] = [dMax, dMin];

  let cMin = clamp(input.countdownMinSeconds ?? base.countdownMinSeconds, 1, 600, base.countdownMinSeconds);
  let cMax = clamp(input.countdownMaxSeconds ?? base.countdownMaxSeconds, 1, 600, base.countdownMaxSeconds);
  if (cMin > cMax) [cMin, cMax] = [cMax, cMin];

  const rawModes = Array.isArray(input.modeAllowlist) ? input.modeAllowlist : base.modeAllowlist;
  const modeAllowlist = rawModes.filter(
    (m): m is string => typeof m === "string" && VALID_GAME_MODES.has(m),
  );

  return {
    enabled,
    targetCount,
    targetMin,
    disguiseRatioMin: dMin,
    disguiseRatioMax: dMax,
    countdownMinSeconds: cMin,
    countdownMaxSeconds: cMax,
    modeAllowlist,
  };
}

/**
 * Read the current auto-lobby settings.
 *
 * Always returns a fully-populated object; missing/malformed storage
 * resolves to {@link AUTO_LOBBY_DEFAULTS}.
 *
 * @param db - Database instance.
 */
export function getAutoLobbySettings(db: DatabaseType): AutoLobbySettings {
  const stored = getSetting<Partial<AutoLobbySettings>>(db, STORAGE_KEY);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...AUTO_LOBBY_DEFAULTS };
  }
  return normalize(stored, AUTO_LOBBY_DEFAULTS);
}

/**
 * Update the auto-lobby settings (partial-merge).
 *
 * Only fields supplied in `patch` are touched; everything else is preserved
 * from the currently-stored value (or defaults if no row exists yet). The
 * persisted result is always a fully normalized & clamped object.
 *
 * @param db - Database instance.
 * @param patch - Partial subset of settings to overwrite.
 * @returns The full, normalized, persisted settings object.
 */
export function setAutoLobbySettings(
  db: DatabaseType,
  patch: Partial<AutoLobbySettings>,
): AutoLobbySettings {
  const current = getAutoLobbySettings(db);
  const next = normalize({ ...current, ...patch }, current);
  setSetting(db, STORAGE_KEY, next);
  return next;
}

/**
 * Convenience: master toggle check. Equivalent to
 * `getAutoLobbySettings(db).enabled` but cheaper-to-read at call sites.
 *
 * @param db - Database instance.
 */
export function isAutoLobbiesEnabled(db: DatabaseType): boolean {
  return getAutoLobbySettings(db).enabled;
}
