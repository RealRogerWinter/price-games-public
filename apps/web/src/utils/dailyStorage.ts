/**
 * Anonymous-user persistence for the daily challenge.
 *
 * Logged-in users have their last-completed date tracked server-side.
 * Anonymous users get a best-effort localStorage equivalent for the
 * "already played today" gate so the on-device experience matches as
 * closely as possible without an account. Streak data is intentionally
 * NOT cached locally for anonymous sessions — see `useDaily.ts` for the
 * reasoning.
 *
 * All localStorage access is wrapped in try/catch because Safari private
 * mode and some embedded WebViews throw on writes.
 */

const KEY_LAST_COMPLETED = "priceGames.daily.lastCompleted";

// Legacy keys (prior to anon-streak removal) — still cleared on
// `clearAnonDailyState` so existing browsers don't carry stale values
// forever after an upgrade.
const LEGACY_KEY_STREAK_CURRENT = "priceGames.daily.streak.current";
const LEGACY_KEY_STREAK_BEST = "priceGames.daily.streak.best";
const LEGACY_KEY_STREAK_LAST_DATE = "priceGames.daily.streak.lastDate";

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Read the date of the user's last completed daily, or null if none. */
export function readAnonLastCompleted(): string | null {
  return safeGet(KEY_LAST_COMPLETED);
}

/** Mark today as completed (anonymous "already-played" memory). */
export function markAnonCompleted(date: string): void {
  safeSet(KEY_LAST_COMPLETED, date);
}

/**
 * Reset all anonymous daily state, including the legacy streak keys from
 * pre-removal builds. Used by support flows / tests.
 */
export function clearAnonDailyState(): void {
  safeRemove(KEY_LAST_COMPLETED);
  safeRemove(LEGACY_KEY_STREAK_CURRENT);
  safeRemove(LEGACY_KEY_STREAK_BEST);
  safeRemove(LEGACY_KEY_STREAK_LAST_DATE);
}
