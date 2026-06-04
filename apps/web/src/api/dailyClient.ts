/**
 * Daily challenge API client.
 *
 * Thin wrapper around fetch() for the public /api/daily/* routes plus
 * typed errors so the hook layer can branch on disabled / already-played
 * states without parsing error strings.
 */

import type {
  DailyTodayResponse,
  DailyHistoryResponse,
  DailyRecapResponse,
  GameSession,
} from "@price-game/shared";

const BASE = "/api";

/** Thrown when the daily challenge feature is currently disabled in admin or no pool mode is available. */
export class DailyDisabledError extends Error {
  constructor(message = "Daily challenge is currently unavailable") {
    super(message);
    this.name = "DailyDisabledError";
  }
}

/** Thrown when the user has already played today's daily. */
export class DailyAlreadyPlayedError extends Error {
  constructor(public readonly date?: string) {
    super("You have already played today's daily challenge");
    this.name = "DailyAlreadyPlayedError";
  }
}

interface RequestOptions extends RequestInit {
  /** Custom error handlers keyed by HTTP status code. */
  on?: Partial<Record<number, (body: { error?: string }) => Error>>;
}

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  const { on, ...init } = options ?? {};
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const handler = on?.[res.status];
    if (handler) throw handler(body);
    throw new Error(`API error ${res.status}: ${body?.error ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch today's daily puzzle metadata. Includes alreadyPlayed/streak for
 * logged-in users; both are absent for anonymous callers.
 *
 * @throws DailyDisabledError when daily is disabled or no pool mode is available
 * @throws Error on other failures
 */
export function fetchDailyToday(): Promise<DailyTodayResponse> {
  return request<DailyTodayResponse>("/daily/today", {
    on: {
      404: () => new DailyDisabledError(),
    },
  });
}

/**
 * Create a new daily session for the current UTC date. The attempt is
 * NOT burned at this point — the player can still back out of the intro
 * screen. Burning happens on the first guess submission.
 *
 * @throws DailyAlreadyPlayedError on 409 (the user already has a daily_plays row for today)
 * @throws DailyDisabledError when daily is disabled
 */
export function startDaily(): Promise<GameSession> {
  return request<GameSession>("/daily/start", {
    method: "POST",
    on: {
      404: () => new DailyDisabledError(),
      409: (body) => new DailyAlreadyPlayedError((body as { date?: string }).date),
    },
  });
}

/**
 * Fetch the authenticated user's daily plays. Anonymous callers
 * receive a 401 from the server.
 *
 * @param limit - Maximum number of plays to return (1–90, default 30).
 */
export function fetchDailyHistory(limit?: number): Promise<DailyHistoryResponse> {
  const query = limit != null ? `?limit=${limit}` : "";
  return request<DailyHistoryResponse>(`/daily/history${query}`);
}

/**
 * Fetch a rich recap for a daily the authenticated user has already
 * completed. Returns per-round scores plus the full product lineup
 * (titles, images, prices, Amazon links) so the client can render a
 * share card with real product data.
 *
 * @param date - YYYY-MM-DD UTC date the user wants to recap.
 * @throws Error with "not_completed" when the user has not finished that
 *   day's daily, or "puzzle_missing" when the underlying puzzle row has
 *   been pruned. Callers can branch on the error message to fall back to
 *   a scores-only view.
 */
export function fetchDailyRecap(date: string): Promise<DailyRecapResponse> {
  return request<DailyRecapResponse>(`/daily/recap/${encodeURIComponent(date)}`);
}
