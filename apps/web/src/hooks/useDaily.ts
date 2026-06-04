/**
 * Daily challenge state machine hook.
 *
 * Owns the lifecycle of the player-facing daily flow:
 *   loading → ready / already-played / unavailable / error → playing → completed
 *
 * Anonymous users have a localStorage fallback for the alreadyPlayed state
 * so devices that already played today are caught even when the server
 * response (which has no user context) doesn't tell us. Streaks, however,
 * are server-only: an anonymous device has no account-bound streak history,
 * so the hook returns `null` and the UI prompts the user to log in / start
 * a streak rather than showing a stale localStorage count that can drift
 * from the server (e.g., across devices, after sign-in, on reset).
 */

import { useCallback, useEffect, useState } from "react";
import type { DailyStreak, DailyTodayResponse, GameSession } from "@price-game/shared";
import {
  fetchDailyToday,
  startDaily as startDailyApi,
  DailyAlreadyPlayedError,
  DailyDisabledError,
} from "../api/dailyClient";
import { readAnonLastCompleted } from "../utils/dailyStorage";

export type DailyState =
  | "loading"
  | "ready"
  | "playing"
  | "completed"
  | "already-played"
  | "unavailable"
  | "error";

export interface UseDailyResult {
  state: DailyState;
  today: DailyTodayResponse | null;
  streak: DailyStreak | null;
  error: Error | null;
  /** Begin a new daily session. Throws DailyAlreadyPlayedError if the server says no. */
  start: () => Promise<GameSession>;
  /** Force a fresh fetch of /today. */
  refresh: () => Promise<void>;
}

export function useDaily(): UseDailyResult {
  const [state, setState] = useState<DailyState>("loading");
  const [today, setToday] = useState<DailyTodayResponse | null>(null);
  const [streak, setStreak] = useState<DailyStreak | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const data = await fetchDailyToday();
      setToday(data);

      // Server-side alreadyPlayed (logged-in) wins; otherwise check the
      // anonymous localStorage fallback.
      const serverPlayed = data.alreadyPlayed === true;
      const anonPlayed = data.alreadyPlayed === undefined && readAnonLastCompleted() === data.date;

      // Streak: server-provided only. Anonymous sessions get `null` so the
      // UI shows the "Start a streak" prompt instead of a localStorage value
      // that has no relationship to any account-bound history.
      setStreak(data.streak ?? null);

      if (serverPlayed || anonPlayed) {
        setState("already-played");
      } else {
        setState("ready");
      }
    } catch (err) {
      if (err instanceof DailyDisabledError) {
        setState("unavailable");
      } else {
        setError(err as Error);
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const start = useCallback(async (): Promise<GameSession> => {
    try {
      const session = await startDailyApi();
      setState("playing");
      return session;
    } catch (err) {
      if (err instanceof DailyAlreadyPlayedError) {
        setState("already-played");
      } else if (err instanceof DailyDisabledError) {
        setState("unavailable");
      } else {
        setError(err as Error);
        setState("error");
      }
      throw err;
    }
  }, []);

  return {
    state,
    today,
    streak,
    error,
    start,
    refresh: load,
  };
}
