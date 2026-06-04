/**
 * Anonymous visitor attribution service.
 *
 * Stores a single row per visitor (keyed by the visitor_id cookie) that
 * captures the first-touch UTM source, the first game they played, and a
 * cumulative game counter. This is the pre-signup counterpart to the
 * `users.utm_*` columns populated by `services/attribution.ts`.
 *
 * First-touch semantics are identical to the signed-up user flow: once a
 * row is created for a visitor_id, subsequent writes through
 * {@link recordVisitorAttribution} are ignored. This keeps the original
 * UTM source stable across a visitor's lifetime.
 *
 * On signup, {@link claimVisitorAttribution} links the row to a user_id.
 * Merging the row's UTM into the `users` table is handled by
 * `services/attribution.ts` so the first-touch guard on the users row
 * stays centralised.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { Attribution } from "./attribution";
import type { IsWin } from "@price-game/shared";
import { applyVisitorWinUpdate } from "./winRecordWriter";

/**
 * Shape of a visitor_attribution row as returned from the DB (camelCase).
 * `firstGameAt` and related fields are null until the visitor finishes a
 * game. `claimedUserId` is null until the visitor registers.
 */
export interface VisitorAttribution {
  visitorId: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  landingPage: string | null;
  referrer: string | null;
  firstSeenAt: string;
  firstGameAt: string | null;
  firstGameType: "single" | "multiplayer" | null;
  firstGameMode: string | null;
  gamesPlayed: number;
  claimedUserId: string | null;
  claimedAt: string | null;
  lifetimeWins: number;
  lifetimeLosses: number;
  /** Signed: positive = win streak, negative = loss streak. */
  currentStreak: number;
  bestWinStreak: number;
}

interface VisitorAttributionRow {
  visitor_id: string;
  utm_source: string;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_page: string | null;
  referrer: string | null;
  first_seen_at: string;
  first_game_at: string | null;
  first_game_type: string | null;
  first_game_mode: string | null;
  games_played: number;
  claimed_user_id: string | null;
  claimed_at: string | null;
  lifetime_wins: number;
  lifetime_losses: number;
  current_streak: number;
  best_win_streak: number;
}

function mapRow(row: VisitorAttributionRow): VisitorAttribution {
  return {
    visitorId: row.visitor_id,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    landingPage: row.landing_page,
    referrer: row.referrer,
    firstSeenAt: row.first_seen_at,
    firstGameAt: row.first_game_at,
    firstGameType:
      row.first_game_type === "single" || row.first_game_type === "multiplayer"
        ? row.first_game_type
        : null,
    firstGameMode: row.first_game_mode,
    gamesPlayed: row.games_played,
    claimedUserId: row.claimed_user_id,
    claimedAt: row.claimed_at,
    lifetimeWins: row.lifetime_wins,
    lifetimeLosses: row.lifetime_losses,
    currentStreak: row.current_streak,
    bestWinStreak: row.best_win_streak,
  };
}

/**
 * Insert a visitor_attribution row for this visitor if one does not already
 * exist. Called from the `/api/attribution/track` endpoint when the client
 * captures a UTM-bearing landing URL. First-touch wins: subsequent calls
 * with a different UTM tuple for the same visitor are silently dropped.
 *
 * @param db - Database instance.
 * @param visitorId - Visitor UUID from the visitor_id cookie.
 * @param attribution - Sanitized attribution payload (utm_source is required
 *   by the caller's validator).
 * @returns true if a new row was inserted, false if the visitor already
 *   had attribution or the payload was not attributable.
 */
export function recordVisitorAttribution(
  db: DatabaseType,
  visitorId: string,
  attribution: Attribution | null,
): boolean {
  if (!visitorId) return false;
  if (attribution === null) return false;
  // Defense in depth: utm_source is the first-touch sentinel elsewhere in
  // the attribution system, and NOT NULL in the schema.
  if (!attribution.utm_source) return false;

  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO visitor_attribution (
         visitor_id, utm_source, utm_medium, utm_campaign, utm_content,
         utm_term, landing_page, referrer, first_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      visitorId,
      attribution.utm_source,
      attribution.utm_medium ?? null,
      attribution.utm_campaign ?? null,
      attribution.utm_content ?? null,
      attribution.utm_term ?? null,
      attribution.landing_page ?? null,
      attribution.referrer ?? null,
      now,
    );

  return result.changes > 0;
}

/**
 * Record that a visitor just completed a game. No-op if the visitor has
 * no attribution row (we only care about visitors that arrived via a
 * tracked link). Sets `first_game_at` / `first_game_type` / `first_game_mode`
 * exactly once, and always increments `games_played`.
 *
 * Called from both single-player and multiplayer completion paths, for
 * anonymous AND authenticated users — once the visitor is claimed,
 * the row still gets its counter bumped so per-cohort engagement stays
 * observable in the funnel.
 *
 * UPSERTS: visitors who never hit a UTM-tagged URL still need a W/L
 * cache row, otherwise their counters never move. Missing rows are
 * inserted with `utm_source = 'direct'` (industry-standard sentinel
 * for "no tracked referrer") so existing UTM queries can filter the
 * untracked bucket out as needed.
 *
 * @param db - Database instance.
 * @param visitorId - Visitor UUID.
 * @param gameType - 'single' or 'multiplayer'.
 * @param gameMode - Game mode string (e.g. 'classic', 'higher-lower').
 * @returns true once the row exists and was bumped (always true for a
 *   non-empty visitorId now that the upsert can never miss).
 */
export function recordVisitorGamePlay(
  db: DatabaseType,
  visitorId: string | null | undefined,
  gameType: "single" | "multiplayer",
  gameMode: string,
  /** Optional pre-classified W/L outcome. When supplied, also bumps the
   *  visitor's lifetime W/L cache + signed streak. Skipped when null. */
  outcome: IsWin = null,
): boolean {
  if (!visitorId) return false;

  const now = new Date().toISOString();

  // Wrap the attribution update + W/L cache bump in a single transaction
  // so a partial failure leaves the visitor row in a coherent state.
  return db.transaction(() => {
    // INSERT-OR-UPDATE: create a 'direct' attribution row on first game
    // for visitors who arrived without UTM tags, otherwise bump the
    // existing row's counters (preserving its first-touch UTM). The
    // ON CONFLICT clause keeps both paths race-safe under concurrent
    // completions for the same visitor (unlikely but cheap to guarantee).
    db.prepare(
      `INSERT INTO visitor_attribution
          (visitor_id, utm_source, first_seen_at, first_game_at, first_game_type, first_game_mode, games_played)
        VALUES (?, 'direct', ?, ?, ?, ?, 1)
        ON CONFLICT(visitor_id) DO UPDATE SET
          first_game_at   = COALESCE(first_game_at, excluded.first_game_at),
          first_game_type = COALESCE(first_game_type, excluded.first_game_type),
          first_game_mode = COALESCE(first_game_mode, excluded.first_game_mode),
          games_played    = games_played + 1`,
    ).run(visitorId, now, now, gameType, gameMode);

    applyVisitorWinUpdate(db, visitorId, outcome);

    return true;
  })();
}

/**
 * Fetch a visitor's attribution row, or null if none exists.
 *
 * @param db - Database instance.
 * @param visitorId - Visitor UUID.
 * @returns The row in camelCase, or null.
 */
export function getVisitorAttribution(
  db: DatabaseType,
  visitorId: string,
): VisitorAttribution | null {
  if (!visitorId) return null;
  const row = db
    .prepare("SELECT * FROM visitor_attribution WHERE visitor_id = ?")
    .get(visitorId) as VisitorAttributionRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Link a visitor_attribution row to a user_id. Called during signup to
 * mark the anonymous row as belonging to a registered user. Refuses to
 * reclaim a row that is already claimed by a different user — this
 * prevents a second account created in the same browser from hijacking
 * the first account's anonymous history.
 *
 * @param db - Database instance.
 * @param visitorId - Visitor UUID to claim.
 * @param userId - Freshly created user id.
 * @returns The claimed row, or null if no row exists for this visitor,
 *   or if the row is already claimed by a different user.
 */
export function claimVisitorAttribution(
  db: DatabaseType,
  visitorId: string,
  userId: string,
): VisitorAttribution | null {
  if (!visitorId || !userId) return null;

  const now = new Date().toISOString();

  // Wrap claim + W/L merge in a transaction so we can read the
  // pre-claim row to detect the NULL→not-NULL transition; only on
  // first claim do we fold the visitor's W/L cache into the user
  // record. Re-claims by the same user are idempotent no-ops on
  // the W/L side (the visitor's stats already merged on attempt #1).
  return db.transaction((): VisitorAttribution | null => {
    const before = db
      .prepare(
        "SELECT claimed_user_id, lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM visitor_attribution WHERE visitor_id = ?",
      )
      .get(visitorId) as
      | {
          claimed_user_id: string | null;
          lifetime_wins: number;
          lifetime_losses: number;
          current_streak: number;
          best_win_streak: number;
        }
      | undefined;

    // UPDATE only if unclaimed or already claimed by this user (idempotent).
    const row = db
      .prepare(
        `UPDATE visitor_attribution
            SET claimed_user_id = ?,
                claimed_at = COALESCE(claimed_at, ?)
          WHERE visitor_id = ?
            AND (claimed_user_id IS NULL OR claimed_user_id = ?)
         RETURNING *`,
      )
      .get(userId, now, visitorId, userId) as VisitorAttributionRow | undefined;

    // First-time claim only: fold the visitor's W/L into the user row.
    // `before.claimed_user_id === null` distinguishes the NULL → not-NULL
    // transition from a re-claim by the same user (already merged).
    if (row && before && before.claimed_user_id === null) {
      // Streak adoption is gated on the user row being fresh (no W/L
      // counters yet). Without this guard, a logged-in user with an
      // established +5 streak who later claims a stray guest cookie
      // would have their streak overwritten by the visitor's value.
      // W/L sums and best_win_streak compose correctly either way.
      const userRow = db
        .prepare(
          "SELECT lifetime_wins, lifetime_losses, current_streak FROM users WHERE id = ?",
        )
        .get(userId) as
        | { lifetime_wins: number; lifetime_losses: number; current_streak: number }
        | undefined;
      const userIsFresh =
        !!userRow &&
        userRow.lifetime_wins === 0 &&
        userRow.lifetime_losses === 0 &&
        userRow.current_streak === 0;
      const adoptedStreak = userIsFresh
        ? before.current_streak
        : userRow?.current_streak ?? 0;
      db.prepare(
        `UPDATE users
            SET lifetime_wins   = lifetime_wins   + ?,
                lifetime_losses = lifetime_losses + ?,
                current_streak  = ?,
                best_win_streak = MAX(best_win_streak, ?)
          WHERE id = ?`,
      ).run(
        before.lifetime_wins,
        before.lifetime_losses,
        adoptedStreak,
        before.best_win_streak,
        userId,
      );
    }

    return row ? mapRow(row) : null;
  })();
}
